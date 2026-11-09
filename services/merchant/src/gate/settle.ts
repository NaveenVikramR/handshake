// Settlement (SPEC §6 step 9, §7.1): PayPal after commit, never inside a transaction (D17).
// Every PayPal POST uses a request id fixed per order and operation, so a retry or a concurrent
// caller gets PayPal's original result. Order status moves only via `transition` + compare-and-set.
import {
  CLOCK_SKEW_S,
  PaymentRequest,
  isHandshakeError,
  type Decision,
  type OrderStatus,
  type Receipt,
} from "@handshake/core";
import { transition } from "../orders/state.js";
import {
  PayPalApiError,
  approvalLink,
  firstAuthorization,
  payerOf,
  savedWallet,
  type PayPalAuthorization,
  type PayPalOrder,
} from "../paypal/client.js";
import { GateFailure, verifyConsumerAgent, verifyPaymentRequest, type GateContext } from "./verify.js";
import type { OrderRow } from "./store.js";

/** A buyer who hasn't approved a first PayPal order within this long gets the order failed. */
export const PAYER_ACTION_WINDOW_MS = 15 * 60_000;

export type PaymentResponse =
  | { httpStatus: 200; body: Receipt }
  | { httpStatus: 202; body: { requestId: string; status: "payer_action_required"; approveUrl: string } }
  | { httpStatus: number; body: { error: string } };

/** Fixed per order + operation (M2 follow-up): retries never move money twice. */
export const paypalRequestId = (
  o: Pick<OrderRow, "requestId">,
  op: "authorize" | "capture" | "track" | "void" | "refund",
) =>
  `${o.requestId}-${op}`;

const log = (ctx: GateContext, msg: string, fields: Record<string, unknown>) =>
  (ctx.log ?? ((m, f) => console.log(m, JSON.stringify(f))))(msg, fields);

export class OrderStateError extends Error {
  override readonly name = "OrderStateError";
}

async function receiptOf(ctx: GateContext, o: OrderRow, decisions?: Decision[]): Promise<Receipt> {
  if (!o.paypalOrderId || !o.authorizationId) throw new Error("receipt before authorization");
  return {
    requestId: o.requestId,
    offerHash: o.offerHash,
    approvalHash: o.approvalHash,
    paypalOrderId: o.paypalOrderId,
    authorizationId: o.authorizationId,
    ...(o.captureId ? { captureId: o.captureId } : {}),
    status: o.status,
    decisions: decisions ?? (await ctx.store.listDecisions(o.requestId)),
    ...(o.trackingNumber ? { trackingNumber: o.trackingNumber } : {}),
  };
}

/** Saves and returns the receipt for the order's current state (the receipt chain). */
async function refreshReceipt(ctx: GateContext, orderId: string): Promise<Receipt | undefined> {
  const o = await ctx.store.getOrder(orderId);
  if (!o?.authorizationId) return undefined;
  const r = await receiptOf(ctx, o);
  await ctx.store.saveReceipt(o.requestId, r);
  return r;
}

/** Applies a PayPal-confirmed status via the state machine; false if the order had moved on. */
async function move(
  ctx: GateContext,
  o: OrderRow,
  to: OrderStatus,
  set: Parameters<GateContext["store"]["updateOrder"]>[0]["set"] = {},
  opts: { release?: boolean } = {},
): Promise<boolean> {
  const t = transition(o.status, { to, source: "api" });
  if (!t.changed) return false;
  return ctx.store.updateOrder({ orderId: o.id, from: o.status, to, set, ...(opts.release ? { release: true } : {}) });
}

async function authorized(
  ctx: GateContext,
  o: OrderRow,
  pp: PayPalOrder,
  auth: PayPalAuthorization,
): Promise<PaymentResponse> {
  const authorizationId = auth.id;
  if (auth.status !== "CREATED") {
    // PENDING: PayPal is still deciding; /complete asks again. Anything else: no funds are held.
    if (auth.status === "PENDING") {
      await ctx.store.patchOrder({ orderId: o.id, status: "offered", set: { paypalOrderId: pp.id } });
      return { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
    }
    await failBeforeMoney(ctx, o, `authorization ${auth.status}`);
    return { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
  }
  const moved = await move(ctx, o, "authorized", { paypalOrderId: pp.id, authorizationId, payerActionUrl: null });
  if (!moved) {
    const now = await ctx.store.getOrder(o.id);
    if (now?.authorizationId !== authorizationId) {
      // The order moved on first (expired, failed): don't leave the buyer's funds held for it.
      await ctx.paypal.voidAuthorization(authorizationId, paypalRequestId(o, "void")).catch(() => undefined);
      await ctx.store.addReconciliation({
        eventId: `api:${o.requestId}`,
        eventType: "AUTHORIZATION_AFTER_ORDER_CLOSED",
        orderId: o.id,
        ...(now ? { from: now.status } : {}),
        to: "authorized",
        note: "authorization arrived after the order closed; voided",
      });
      log(ctx, "late authorization voided", { orderId: o.id, authorizationId });
      return now ? current(ctx, now) : { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
    }
  }
  // Only a fully vaulted wallet is kept for agent payments without a redirect (D7).
  const vault = savedWallet(pp);
  if (vault?.id && vault.status === "VAULTED") {
    const payer = payerOf(pp);
    const saved = await ctx.store.saveVault({
      userId: o.userId,
      orderId: o.id,
      vaultId: vault.id,
      customerId: vault.customer?.id,
      payerId: payer.payerId,
      payerEmail: payer.email,
    });
    if (saved === "refused") {
      await ctx.store.addReconciliation({
        eventId: `api:${o.requestId}`,
        eventType: "VAULT_PAYER_MISMATCH",
        orderId: o.id,
        note: "a different PayPal payer tried to replace this user's confirmed wallet; kept the confirmed one",
      });
    }
  }
  const r = await refreshReceipt(ctx, o.id);
  if (!r) return { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
  log(ctx, "order authorized", { orderId: o.id, paypalOrderId: pp.id, authorizationId });
  return { httpStatus: 200, body: r };
}

async function failBeforeMoney(ctx: GateContext, o: OrderRow, why: string): Promise<void> {
  if (await move(ctx, o, "failed", {}, { release: true })) log(ctx, "order failed", { orderId: o.id, why });
}

function paypalError(e: unknown): PaymentResponse {
  if (e instanceof PayPalApiError) return { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
  throw e;
}

/** Step 9: a saved wallet pays at once; otherwise PayPal's approve link, saving the wallet (D7). */
async function pay(ctx: GateContext, o: OrderRow): Promise<PaymentResponse> {
  const vaultId = await ctx.store.getVault(o.userId);
  const urls = {
    // No request id in the URLs (it would sit in browser history): PayPal appends ?token=<order id>.
    returnUrl: `${new URL(ctx.webUrl).origin}/paypal/return`,
    cancelUrl: `${new URL(ctx.webUrl).origin}/paypal/cancel`,
  };
  let pp: PayPalOrder;
  try {
    pp = await ctx.paypal.createOrderAuthorize({
      requestId: o.requestId,
      invoiceId: o.id,
      totalMinor: o.totalMinor,
      currency: "USD",
      ...urls,
      ...(vaultId ? { vaultId } : { saveWallet: true }),
    });
  } catch (e) {
    // Not applied → nothing to wait for: fail and give back. Maybe applied → stay offered; /complete retries.
    if (e instanceof PayPalApiError && !e.maybeApplied)
      await failBeforeMoney(ctx, o, `create: ${e.issue ?? e.httpStatus}`);
    return paypalError(e);
  }
  const auth = firstAuthorization(pp);
  if (pp.status === "COMPLETED" && auth) return authorized(ctx, o, pp, auth);
  const link = approvalLink(pp);
  if (!link) {
    await failBeforeMoney(ctx, o, `unexpected order status ${pp.status}`);
    return { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
  }
  await ctx.store.patchOrder({ orderId: o.id, status: "offered", set: { paypalOrderId: pp.id, payerActionUrl: link } });
  return { httpStatus: 202, body: { requestId: o.requestId, status: "payer_action_required", approveUrl: link } };
}

async function current(ctx: GateContext, o: OrderRow): Promise<PaymentResponse> {
  if (o.status === "offered") {
    return o.payerActionUrl
      ? {
          httpStatus: 202,
          body: { requestId: o.requestId, status: "payer_action_required", approveUrl: o.payerActionUrl },
        }
      : { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
  }
  if (o.status === "failed") return { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
  const r = (await ctx.store.getPaymentRequest(o.requestId))?.receipt ?? (await refreshReceipt(ctx, o.id));
  return r ? { httpStatus: 200, body: r } : { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
}

/** POST /payments: gate (steps 1–8), atomic commit, then PayPal (step 9). */
export async function handlePayment(ctx: GateContext, body: unknown): Promise<PaymentResponse> {
  let v;
  try {
    v = await verifyPaymentRequest(body, ctx);
  } catch (e) {
    if (e instanceof GateFailure) {
      // A refused duplicate (step 2) names someone else's request id: log it, but keep it out of that
      // request's decisions, which only its own agent writes (D25).
      const refusedDuplicate = e.decisions.at(-1)?.step === "2";
      if (e.requestId && !refusedDuplicate) await ctx.store.addDecisions(e.requestId, e.decisions).catch(() => {});
      log(ctx, "payment rejected", { requestId: e.requestId, code: e.code, step: e.decisions.at(-1)?.step });
      return { httpStatus: e.status, body: { error: e.code } };
    }
    throw e;
  }
  if (v.kind === "duplicate") {
    // DUPLICATE_REQUEST: the stored outcome, never a second payment.
    return v.order ? current(ctx, v.order) : { httpStatus: 409, body: { error: "DUPLICATE_REQUEST" } };
  }
  try {
    await ctx.store.commit(v.commit);
  } catch (e) {
    if (!isHandshakeError(e)) throw e;
    const step =
      {
        DUPLICATE_REQUEST: "2",
        OFFER_USED: "4",
        OFFER_EXPIRED: "4",
        APPROVAL_REPLAY: "7",
        APPROVAL_INVALID: "6a",
        MANDATE_LIMIT: "6b",
        MANDATE_INVALID: "6b",
      }[e.code as string] ?? "9";
    if (e.code === "DUPLICATE_REQUEST") {
      // Lost a race on the request id: the stored outcome, only if this agent sent the original.
      const seen = await ctx.store.getPaymentRequest(v.commit.requestId);
      if (seen && seen.agentId !== v.commit.agentId) {
        log(ctx, "payment rejected", { requestId: v.commit.requestId, code: "AGENT_UNTRUSTED", step: "2" });
        return { httpStatus: 401, body: { error: "AGENT_UNTRUSTED" } };
      }
      await ctx.store.addDecisions(v.commit.requestId, [...v.decisions, { step, result: "fail", reason: `${e.code}: ${e.message}` }]).catch(() => {});
      if (seen?.order) return current(ctx, seen.order);
      return { httpStatus: e.status, body: { error: e.code } };
    }
    const decisions = [...v.decisions, { step, result: "fail" as const, reason: `${e.code}: ${e.message}` }];
    await ctx.store.addDecisions(v.commit.requestId, decisions).catch(() => {});
    return { httpStatus: e.status, body: { error: e.code } };
  }
  await ctx.store.addDecisions(v.commit.requestId, [
    ...v.decisions,
    { step: "9", result: "pass", reason: "committed; calling PayPal" },
  ]);
  const order = await ctx.store.getOrder(v.commit.order.id);
  if (!order) throw new Error("order vanished after commit");
  return pay(ctx, order);
}

/**
 * POST /payments/:requestId/complete — after the buyer approved on PayPal (or to retry step 9). The
 * body is the original signed request: only the agent that sent it gets the outcome (D25).
 */
export async function completePayment(ctx: GateContext, requestId: string, body: unknown): Promise<PaymentResponse> {
  const req = PaymentRequest.safeParse(body);
  if (!req.success || req.data.requestId !== requestId) return { httpStatus: 400, body: { error: "SCHEMA_INVALID" } };
  try {
    await verifyConsumerAgent(ctx, req.data);
  } catch (e) {
    if (isHandshakeError(e)) return { httpStatus: e.status, body: { error: e.code } };
    throw e;
  }
  const seen = await ctx.store.getPaymentRequest(requestId);
  // Unknown and someone else's look the same: nothing about the request leaks.
  if (!seen || seen.agentId !== req.data.kid) return { httpStatus: 404, body: { error: "UNKNOWN_REQUEST" } };
  return settleRequest(ctx, requestId);
}

/** Finishes step 9 for a stored request (trusted callers: /complete after its check, PayPal return, expiry). */
async function settleRequest(ctx: GateContext, requestId: string): Promise<PaymentResponse> {
  const o = (await ctx.store.getPaymentRequest(requestId))?.order;
  if (!o) return { httpStatus: 404, body: { error: "UNKNOWN_REQUEST" } };
  if (o.status !== "offered") return current(ctx, o);
  if (!o.paypalOrderId) return pay(ctx, o); // create may have reached PayPal: same request id, same order
  let pp: PayPalOrder;
  try {
    pp = await ctx.paypal.getOrder(o.paypalOrderId);
    const auth = firstAuthorization(pp);
    if (pp.status === "COMPLETED" && auth) return authorized(ctx, o, pp, auth);
    if (pp.status === "APPROVED") {
      const done = await ctx.paypal.authorizeOrder(o.paypalOrderId, paypalRequestId(o, "authorize"));
      const a2 = firstAuthorization(done);
      if (a2) return authorized(ctx, o, done, a2);
    }
  } catch (e) {
    return paypalError(e);
  }
  if (pp.status === "PAYER_ACTION_REQUIRED" || pp.status === "CREATED" || pp.status === "APPROVED")
    return current(ctx, o);
  await failBeforeMoney(ctx, o, `PayPal order ${pp.status}`);
  return { httpStatus: 502, body: { error: "PAYPAL_ERROR" } };
}

/** The buyer came back from PayPal: finish by PayPal's order id; only the status goes back. */
export async function completeByPayPalOrder(
  ctx: GateContext,
  paypalOrderId: string,
  /** The signed-in wallet user whose browser came back from PayPal (vouched for by the web server). */
  walletUserId?: string,
): Promise<{ status: string }> {
  const o = await ctx.store.findOrder({ paypalOrderId });
  if (!o) return { status: "unknown" };
  // The order's owner approved on PayPal in their own session: the saved wallet becomes confirmable.
  // Marked first, so a vault the agent's /complete saves meanwhile is stored bound (D29); the bind
  // after settling covers a vault saved before the mark.
  const owner = walletUserId !== undefined && walletUserId === o.userId;
  if (owner) await ctx.store.markOwnerReturned(o.id);
  const r = await settleRequest(ctx, o.requestId);
  if (owner) await ctx.store.bindVault(o.userId, undefined);
  if (r.httpStatus === 200) return { status: (r.body as Receipt).status };
  return { status: r.httpStatus === 202 ? "payer_action_required" : "failed" };
}

/** Full refund of a captured order (shopkeeper, after an explicit confirm). */
export async function refundOrder(ctx: GateContext, orderId: string): Promise<Receipt> {
  const o = await ctx.store.getOrder(orderId);
  if (!o) throw new OrderStateError("unknown order");
  if (o.status !== "captured" || !o.captureId) throw new OrderStateError(`order is ${o.status}, not captured`);
  const r = await ctx.paypal.refundCapture(o.captureId, paypalRequestId(o, "refund"));
  if (r.status === "COMPLETED") {
    await move(ctx, o, "refunded", { refundId: r.id, refundedMinor: o.totalMinor });
    log(ctx, "order refunded", { orderId: o.id, refundId: r.id });
  } else {
    // PENDING: PayPal confirms by webhook.
    await ctx.store.patchOrder({ orderId: o.id, status: "captured", set: { refundId: r.id } });
  }
  const receipt = await refreshReceipt(ctx, o.id);
  if (!receipt) throw new OrderStateError("no receipt");
  return receipt;
}

/** POST /payments/:requestId (GET): the stored outcome. */
/** GET /payments/:requestId: the order's status only. Receipts go to the signing agent alone (D25). */
export async function paymentStatus(
  ctx: GateContext,
  requestId: string,
): Promise<{ httpStatus: number; body: { status: string } | { error: string } }> {
  const o = (await ctx.store.getPaymentRequest(requestId))?.order;
  return o ? { httpStatus: 200, body: { status: o.status } } : { httpStatus: 404, body: { error: "UNKNOWN_REQUEST" } };
}

/**
 * Webhook follow-up (M10): a declined capture fails the order, but PayPal may still hold the
 * authorization. Void it with the order's void request id, so a retry is the same void.
 */
export function afterOrderEvent(ctx: GateContext) {
  return async (
    ev: { to: string; ref: { kind: string; id: string } },
    raw: { id: string; event_type: string },
  ): Promise<void> => {
    if (ev.to !== "failed" || ev.ref.kind !== "capture") return;
    const o = await ctx.store.findOrder({ captureId: ev.ref.id });
    if (!o || o.status !== "failed" || !o.authorizationId) return;
    try {
      await ctx.paypal.voidAuthorization(o.authorizationId, paypalRequestId(o, "void"));
      log(ctx, "authorization voided after declined capture", { orderId: o.id });
    } catch (e) {
      // A redelivery is a duplicate, so nothing retries this: leave it for a human.
      await ctx.store.addReconciliation({
        eventId: raw.id,
        eventType: raw.event_type,
        orderId: o.id,
        from: o.status,
        note: "void after declined capture failed; authorization may still be held",
      });
      throw e;
    }
  };
}

/**
 * DEMO_MODE reset (M10): void every held authorization at PayPal (sandbox), then clear the payment
 * data and restock. A void that fails is logged and the reset goes on: sandbox authorizations expire.
 */
export async function resetDemo(
  ctx: GateContext,
  stock: { sku: string; stock: number }[],
): Promise<{ orders: number; voided: number }> {
  let voided = 0;
  const stuck: string[] = [];
  for (const o of await ctx.store.heldOrders()) {
    try {
      await voidOrder(ctx, o, "demo reset");
      voided++;
    } catch {
      stuck.push(o.id);
      log(ctx, "demo reset: void failed", { orderId: o.id });
    }
  }
  // The store aborts if any other order became authorized meanwhile (its hold would be lost).
  const { orders } = await ctx.store.resetDemo(stock, stuck);
  log(ctx, "demo reset", { orders, voided });
  return { orders, voided };
}

async function voidOrder(ctx: GateContext, o: OrderRow, why: string): Promise<void> {
  if (!o.authorizationId) throw new OrderStateError("order has no authorization");
  await ctx.paypal.voidAuthorization(o.authorizationId, paypalRequestId(o, "void"));
  if (await move(ctx, o, "voided", {}, { release: true })) log(ctx, "order voided", { orderId: o.id, why });
  await refreshReceipt(ctx, o.id);
}

/**
 * POST /orders/:id/fulfil. Fulfilled → capture the full authorization, then add tracking; not
 * fulfilled → void and give back the mandate spend and stock. Capture happens only here.
 */
export async function fulfilOrder(
  ctx: GateContext,
  orderId: string,
  input: { fulfilled: boolean; trackingNumber?: string },
): Promise<Receipt> {
  const o = await ctx.store.getOrder(orderId);
  if (!o) throw new OrderStateError("unknown order");
  // Tracking-only retry: captured, but the tracking call failed last time.
  if (o.status === "captured" && input.fulfilled && input.trackingNumber && !o.trackingNumber && o.captureId && o.paypalOrderId) {
    await ctx.paypal.addTracking(o.paypalOrderId, paypalRequestId(o, "track"), {
      captureId: o.captureId,
      trackingNumber: input.trackingNumber,
      carrier: "OTHER",
      carrierNameOther: "Handshake Courier",
    });
    await ctx.store.patchOrder({ orderId: o.id, status: "captured", set: { trackingNumber: input.trackingNumber } });
    const r = await refreshReceipt(ctx, o.id);
    if (!r) throw new OrderStateError("no receipt");
    return r;
  }
  if (o.status !== "authorized" || !o.authorizationId || !o.paypalOrderId) {
    throw new OrderStateError(`order is ${o.status}, not authorized`);
  }
  if (!input.fulfilled) {
    await voidOrder(ctx, o, "fulfilment failed");
  } else {
    const cap = await ctx.paypal.captureAuthorization(o.authorizationId, paypalRequestId(o, "capture"), {
      invoiceId: o.id,
    });
    if (cap.status === "COMPLETED") {
      await move(ctx, o, "captured", { captureId: cap.id });
      log(ctx, "order captured", { orderId: o.id, captureId: cap.id });
      if (input.trackingNumber) {
        await ctx.paypal.addTracking(o.paypalOrderId, paypalRequestId(o, "track"), {
          captureId: cap.id,
          trackingNumber: input.trackingNumber,
          carrier: "OTHER",
          carrierNameOther: "Handshake Courier",
        });
        await ctx.store.patchOrder({
          orderId: o.id,
          status: "captured",
          set: { trackingNumber: input.trackingNumber },
        });
      }
    } else if (cap.status === "DECLINED" || cap.status === "FAILED") {
      await move(ctx, o, "failed", { captureId: cap.id }, { release: true });
      await ctx.paypal.voidAuthorization(o.authorizationId, paypalRequestId(o, "void")).catch(() => undefined);
    } else {
      // PENDING: PayPal confirms by webhook (PAYMENT.CAPTURE.COMPLETED / DECLINED).
      await ctx.store.patchOrder({ orderId: o.id, status: "authorized", set: { captureId: cap.id } });
    }
  }
  const r = await refreshReceipt(ctx, o.id);
  if (!r) throw new OrderStateError("no receipt");
  return r;
}

/** Expiry job: void authorized orders past fulfilBy; fail orders whose buyer never approved on PayPal. */
export async function expireOrders(ctx: GateContext): Promise<number> {
  const now = ctx.now();
  let n = 0;
  for (const o of await ctx.store.dueOrders(now, now - PAYER_ACTION_WINDOW_MS)) {
    try {
      if (o.status === "authorized") await voidOrder(ctx, o, "fulfilment deadline passed");
      else {
        // A create that timed out may have authorized (vault path), or the buyer approved late:
        // settle that first with the same request ids, then fail only what is still pending.
        await settleRequest(ctx, o.requestId).catch(() => undefined);
        const now2 = await ctx.store.getOrder(o.id);
        if (now2?.status === "offered") await failBeforeMoney(ctx, now2, "buyer did not approve on PayPal in time");
      }
      n++;
    } catch (e) {
      log(ctx, "order expiry failed", { orderId: o.id, error: e instanceof Error ? e.name : "unknown" });
    }
  }
  return n;
}

/**
 * A nonce row can go once its payload is past `exp` + skew, since freshness then rejects a replay
 * anyway. Ten minutes of margin keeps clock drift from reopening a window.
 */
export const NONCE_RETENTION_S = 10 * 60;

export function startOrderExpiry(ctx: GateContext, intervalMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    expireOrders(ctx)
      .then(() => ctx.store.purgeNonces(Math.floor(ctx.now() / 1000) - CLOCK_SKEW_S - NONCE_RETENTION_S))
      .catch((e: unknown) => log(ctx, "order expiry failed", { error: e instanceof Error ? e.name : "unknown" }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

