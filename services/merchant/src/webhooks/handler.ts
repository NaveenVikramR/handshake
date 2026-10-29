import { isHandshakeError } from "@handshake/core";
import { InvalidTransitionError } from "../orders/state.js";
import type { PayPalClient } from "../paypal/client.js";
import { WebhookEvent, orderEventFor, type MappedOrderEvent } from "./events.js";
import type { WebhookEventStore } from "./store.js";

export type Log = (msg: string, fields: Record<string, unknown>) => void;

export interface WebhookDeps<Tx = unknown> {
  paypal: Pick<PayPalClient, "verifyWebhook">;
  store: WebhookEventStore<Tx>;
  webhookId: string;
  /**
   * Applies the event to the order inside the dedupe transaction (wired in M7).
   * `simulated` is true for DEMO_MODE events: they never passed PayPal
   * verification, so M7 must not fulfil or release funds on them.
   */
  onOrderEvent?: (event: MappedOrderEvent, raw: WebhookEvent, tx: Tx, meta: { simulated: boolean }) => Promise<void>;
  log?: Log;
}

export type WebhookOutcome =
  "processed" | "ignored" | "duplicate" | "forged" | "malformed" | "verify_unavailable" | "apply_failed" | "conflict";

export interface WebhookResult {
  httpStatus: number;
  outcome: WebhookOutcome;
}

const defaultLog: Log = (msg, fields) => console.log(msg, JSON.stringify(fields));

/** Verify first, then dedupe + act in one transaction. Never logs headers or the payload. */
export async function handlePayPalWebhook<Tx>(
  deps: WebhookDeps<Tx>,
  req: { headers: Record<string, string | string[] | undefined>; rawBody: string },
): Promise<WebhookResult> {
  const log = deps.log ?? defaultLog;
  let genuine: boolean;
  try {
    genuine = await deps.paypal.verifyWebhook({
      headers: req.headers,
      rawBody: req.rawBody,
      webhookId: deps.webhookId,
    });
  } catch (e) {
    // PayPal unreachable: 5xx so PayPal redelivers later. Nothing was recorded.
    log("webhook verify unavailable", { error: isHandshakeError(e) ? e.message : "unknown" });
    return { httpStatus: 503, outcome: "verify_unavailable" };
  }
  if (!genuine) {
    log("webhook rejected: signature", {});
    return { httpStatus: 400, outcome: "forged" };
  }
  return acceptVerified(deps, req.rawBody, { simulated: false }, log);
}

/** Shared by the real endpoint (after verification) and the DEMO_MODE simulator. */
export async function acceptVerified<Tx>(
  deps: Pick<WebhookDeps<Tx>, "store" | "onOrderEvent">,
  rawBody: string,
  meta: { simulated: boolean },
  log: Log = defaultLog,
): Promise<WebhookResult> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = undefined;
  }
  const parsed = WebhookEvent.safeParse(json);
  if (!parsed.success) {
    log("webhook rejected: malformed", {});
    return { httpStatus: 400, outcome: "malformed" };
  }
  const event = parsed.data;
  const mapped = orderEventFor(event);
  const fields = { eventId: event.id, type: event.event_type, resourceId: event.resource.id };

  let result: "new" | "duplicate";
  try {
    result = await deps.store.record({ eventId: event.id, type: event.event_type, payload: json }, async (tx) => {
      if (mapped && deps.onOrderEvent) await deps.onOrderEvent(mapped, event, tx, meta);
    });
  } catch (e) {
    if (e instanceof InvalidTransitionError) {
      // PayPal reports a state our order can't move to (e.g. a capture landing on a
      // voided order). Retrying won't change that, so record the event, raise an
      // alert for manual reconciliation (table in M7) and stop redelivery. Never
      // fulfil or release funds automatically here.
      try {
        await deps.store.record({ eventId: event.id, type: event.event_type, payload: json }, async () => {});
      } catch {
        log("webhook apply failed", { ...fields, error: "record_conflict" });
        return { httpStatus: 500, outcome: "apply_failed" };
      }
      log("webhook RECONCILE: state conflict", { ...fields, from: e.from, to: e.event.to });
      return { httpStatus: 200, outcome: "conflict" };
    }
    // Rolled back, so PayPal's redelivery is treated as new rather than a duplicate.
    log("webhook apply failed", { ...fields, error: e instanceof Error ? e.name : "unknown" });
    return { httpStatus: 500, outcome: "apply_failed" };
  }
  if (result === "duplicate") {
    log("webhook duplicate", fields);
    return { httpStatus: 200, outcome: "duplicate" };
  }
  log(mapped ? "webhook processed" : "webhook ignored", { ...fields, ...(mapped ? { to: mapped.to } : {}) });
  return { httpStatus: 200, outcome: mapped ? "processed" : "ignored" };
}
