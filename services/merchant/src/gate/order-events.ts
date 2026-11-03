// Verified PayPal webhooks → order state (SPEC §7.1, D15). Runs inside the webhook dedupe
// transaction. It only records confirmations through the state machine: it never captures,
// refunds or fulfils, and simulated (DEMO_MODE) events never change an order.
import { InvalidTransitionError, transition } from "../orders/state.js";
import type { MappedOrderEvent, WebhookEvent } from "../webhooks/events.js";
import type { GateStore, OrderRow } from "./store.js";

const toMinor = (v: unknown): number | undefined => {
  if (typeof v !== "string" || !/^\d+(\.\d{1,2})?$/.test(v)) return undefined;
  const [whole, frac = ""] = v.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
};

type Resource = {
  id: string;
  amount?: { value?: unknown };
  links?: { rel?: string; href?: string }[];
  supplementary_data?: { related_ids?: { authorization_id?: string; order_id?: string } };
};

/** The order a PayPal object belongs to: by its own id, else the ids PayPal relates it to. */
async function resolve(store: GateStore, ev: MappedOrderEvent, r: Resource): Promise<OrderRow | undefined> {
  const related = r.supplementary_data?.related_ids;
  if (ev.ref.kind === "authorization") return store.findOrder({ authorizationId: r.id });
  if (ev.ref.kind === "capture") {
    return (
      (await store.findOrder({ captureId: r.id })) ??
      (related?.authorization_id ? await store.findOrder({ authorizationId: related.authorization_id }) : undefined)
    );
  }
  // Refund or reversal: the capture it belongs to is its "up" link (or, defensively, its own id).
  const up = r.links?.find((l) => l.rel === "up")?.href?.match(/\/captures\/([A-Z0-9]+)$/)?.[1];
  return (
    (await store.findOrder({ refundId: r.id })) ??
    (up ? await store.findOrder({ captureId: up }) : undefined) ??
    (await store.findOrder({ captureId: r.id }))
  );
}

export function orderEventHandler<Tx>(store: GateStore<Tx>) {
  return async (ev: MappedOrderEvent, raw: WebhookEvent, tx: Tx, meta: { simulated: boolean }): Promise<void> => {
    const base = { eventId: raw.id, eventType: raw.event_type };
    if (meta.simulated) {
      await store.addReconciliation({ ...base, note: "simulated event recorded, not applied" });
      return;
    }
    const r = raw.resource as unknown as Resource;
    const o = await resolve(store as GateStore, ev, r);
    if (!o) {
      await store.addReconciliation({ ...base, note: `no order for ${ev.ref.kind} ${ev.ref.id}` });
      return;
    }
    if (raw.event_type === "PAYMENT.CAPTURE.REVERSED") {
      await store.addReconciliation({
        ...base,
        orderId: o.id,
        from: o.status,
        to: ev.to,
        note: "capture reversed (dispute or chargeback)",
      });
    }
    const set: Parameters<GateStore["updateOrder"]>[0]["set"] = {};
    if (ev.ref.kind === "capture" && !o.captureId) set.captureId = r.id;
    if (ev.ref.kind === "refund" && o.status === "captured") {
      // Atomic, inside the dedupe transaction: a redelivery after a rollback can't count it twice.
      const amount = toMinor(r.amount?.value) ?? o.totalMinor - o.refundedMinor;
      const refunded = await store.addRefund({ orderId: o.id, refundId: r.id, amountMinor: amount }, tx);
      if (refunded !== undefined && refunded < o.totalMinor) {
        await store.addReconciliation(
          { ...base, orderId: o.id, from: o.status, note: `partial refund ${refunded}/${o.totalMinor}` },
          tx,
        );
        return;
      }
    }
    let t;
    try {
      t = transition(o.status, { to: ev.to, source: "webhook" });
    } catch (e) {
      if (e instanceof InvalidTransitionError) {
        await store.addReconciliation({ ...base, orderId: o.id, from: o.status, to: ev.to, note: "state conflict" });
      }
      throw e;
    }
    if (!t.changed) return;
    // Money never taken (failed capture) or handed back by a void: release ledger + stock once.
    const release = ev.to === "voided" || ev.to === "failed";
    const ok = await store.updateOrder(
      { orderId: o.id, from: o.status, to: ev.to, set, ...(release ? { release } : {}) },
      tx,
    );
    if (!ok) throw new InvalidTransitionError(o.status, { to: ev.to, source: "webhook" });
  };
}
