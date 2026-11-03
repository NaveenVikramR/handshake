// The verification gate (SPEC §6): every check in order, each writing a decision, failing closed
// with one HandshakeError code. Read-only: the writes that make a check authoritative (request id,
// offer used, nonce, sign count, ledger) happen together in GateStore.commit afterwards (D17).
import { randomBytes } from "node:crypto";
import {
  HandshakeError,
  PaymentRequest,
  b64urlEncode,
  checkFreshness,
  checkMandateCartBinding,
  checkMandateScope,
  hash,
  isHandshakeError,
  periodStart,
  verifyApprovalAssertion,
  verifyMandateApproval,
  verifyOfferEnvelope,
  verifyPaymentRequestSig,
  type CartApproval,
  type Decision,
  type ErrorCode,
  type Receipt,
} from "@handshake/core";
import type { MerchantSelf } from "../offers/service.js";
import type { OfferStore } from "../offers/store.js";
import type { PayPalClient } from "../paypal/client.js";
import type { RiskInspector } from "./risk.js";
import type { CommitInput, GatePath, GateStore, OrderRow } from "./store.js";

/** Fulfil (capture) within this window after authorization, or the expiry job voids. */
export const FULFIL_WINDOW_MS = 24 * 60 * 60_000;

export interface GateContext {
  store: GateStore<any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- Tx differs per store
  registry: Pick<OfferStore, "getAgent" | "getMerchant">;
  self: MerchantSelf;
  paypal: Pick<
    PayPalClient,
    | "createOrderAuthorize"
    | "getOrder"
    | "authorizeOrder"
    | "captureAuthorization"
    | "voidAuthorization"
    | "addTracking"
  >;
  risk: RiskInspector;
  /** The wallet's WebAuthn origin and RP ID: passkey assertions must come from there. */
  webauthn: { origin: string; rpId: string };
  /** Wallet web app origin, for PayPal's return and cancel pages. */
  webUrl: string;
  /** ms since epoch */
  now: () => number;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** A failed gate step: the code to return and every decision made so far. */
export class GateFailure extends HandshakeError {
  constructor(
    code: ErrorCode,
    message: string,
    readonly decisions: Decision[],
    readonly requestId: string | undefined,
  ) {
    super(code, message);
  }
}

export type Verified =
  | { kind: "duplicate"; requestId: string; receipt: Receipt | null; order: OrderRow | null }
  | { kind: "ok"; commit: CommitInput; decisions: Decision[]; path: GatePath };

const sameItems = (a: CartApproval["items"], b: CartApproval["items"]) => hash(a) === hash(b);

/**
 * SPEC §6 steps 1–8. Route handlers call only this (then commit and pay). Throws GateFailure.
 * Step 2 returns the stored outcome for a request id already seen.
 */
export async function verifyPaymentRequest(body: unknown, ctx: GateContext): Promise<Verified> {
  const decisions: Decision[] = [];
  // Known once step 1 passes; failures before that carry no request id.
  const seenId: { requestId?: string } = {};
  const nowMs = ctx.now();
  const now = Math.floor(nowMs / 1000);

  async function step<T>(id: string, ok: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      const out = await fn();
      decisions.push({ step: id, result: "pass", reason: ok });
      return out;
    } catch (e) {
      if (!isHandshakeError(e)) throw e;
      decisions.push({ step: id, result: "fail", reason: `${e.code}: ${e.message}`.slice(0, 500) });
      throw new GateFailure(e.code, e.message, decisions, seenId.requestId);
    }
  }

  // 1. Shape.
  const req = await step("1", "schema", () => {
    const parsed = PaymentRequest.safeParse(body);
    if (!parsed.success) throw new HandshakeError("SCHEMA_INVALID", "payment request failed schema");
    return parsed.data;
  });
  seenId.requestId = req.requestId;

  // 2. Seen before → the stored outcome (the commit re-checks this atomically).
  const seen = await ctx.store.getPaymentRequest(req.requestId);
  if (seen) return { kind: "duplicate", requestId: req.requestId, ...seen };
  decisions.push({ step: "2", result: "pass", reason: "request id unseen" });

  const a = req.authorization;
  const cart = a.kind === "passkey" ? a.cartApproval : a.cart;

  // 3. Consumer agent: registered, active, signed the request, and is the agent the approval names.
  await step("3", "consumer agent verified", async () => {
    const agent = await ctx.registry.getAgent(req.kid);
    if (!agent || agent.role !== "consumer" || agent.status !== "active") {
      throw new HandshakeError("AGENT_UNTRUSTED", "consumer agent not active in the registry");
    }
    verifyPaymentRequestSig(req, { id: agent.id, publicKey: agent.publicKey });
  });

  // 4. The offer is ours (payee binding), live, unused, and the one we stored for this agent.
  const offerRow = await step("4", "offer is ours and open", async () => {
    // Re-read our own registry status: a suspended merchant takes no payments.
    const [me, merchant] = await Promise.all([
      ctx.registry.getAgent(ctx.self.merchantAgentId),
      ctx.registry.getMerchant(ctx.self.merchantId),
    ]);
    if (me?.status !== "active" || merchant?.status !== "active") {
      throw new HandshakeError("MERCHANT_UNTRUSTED", "this merchant is not active in the registry");
    }
    const p = req.offer.payload;
    if (
      req.offer.kid !== ctx.self.merchantAgentId ||
      p.merchantAgentId !== ctx.self.merchantAgentId ||
      p.merchantId !== ctx.self.merchantId ||
      p.paypalMerchantId !== ctx.self.paypalMerchantId
    ) {
      throw new HandshakeError("OFFER_SIG_INVALID", "offer is not payable to this merchant");
    }
    verifyOfferEnvelope(req.offer, { id: ctx.self.merchantAgentId, publicKey: ctx.self.publicKey }, now);
    const stored = await ctx.store.getOffer(p.offerId);
    if (!stored || stored.hash !== hash(p) || stored.agentId !== req.kid) {
      throw new HandshakeError("OFFER_SIG_INVALID", "offer not issued by us to this agent");
    }
    if (stored.status === "used") throw new HandshakeError("OFFER_USED", "offer already paid for");
    if (stored.status !== "open" || stored.holdUntil <= nowMs)
      throw new HandshakeError("OFFER_EXPIRED", "hold released");
    return stored;
  });

  // 5. The approved cart is exactly the offer.
  await step("5", "cart equals offer", () => {
    const p = req.offer.payload;
    if (
      cart.offerId !== p.offerId ||
      cart.offerHash !== hash(p) ||
      cart.merchantId !== p.merchantId ||
      cart.totalMinor !== p.totalMinor ||
      cart.currency !== p.currency ||
      !sameItems(cart.items, p.items)
    ) {
      throw new HandshakeError("CART_MISMATCH", "cart differs from the offer");
    }
  });

  const webauthn = { expectedOrigin: ctx.webauthn.origin, expectedRpId: ctx.webauthn.rpId };
  let passkeyCas: CommitInput["passkey"];
  let ledger: CommitInput["ledger"];
  let mandateId: string | null = null;
  let bucket: number | null = null;

  if (a.kind === "passkey") {
    // 6a. The human approved hash(cart) with a passkey registered to the cart's user.
    await step("6a", "passkey approval verified", async () => {
      const cred = await ctx.store.getPasskey(a.assertion.credentialId);
      if (!cred) throw new HandshakeError("APPROVAL_INVALID", "unknown passkey");
      const { newSignCount } = await verifyApprovalAssertion(a.cartApproval, a.assertion, cred, webauthn);
      passkeyCas = { credentialId: cred.credentialId, expected: cred.signCount, next: newSignCount };
    });
  } else {
    // 6b. A live mandate the human approved covers this cart; spend is reserved at commit.
    await step("6b", "mandate covers cart", async () => {
      checkMandateCartBinding(a);
      const m = a.mandate;
      const row = await ctx.store.getMandateRow(m.mandateId);
      if (!row || row.status !== "active" || row.hash !== hash(m)) {
        throw new HandshakeError("MANDATE_INVALID", "mandate not active in the wallet registry");
      }
      const cred = await ctx.store.getPasskey(a.assertion.credentialId);
      if (!cred) throw new HandshakeError("MANDATE_INVALID", "unknown passkey");
      // Stored proof, checked on every order: no sign count (D17).
      await verifyMandateApproval(m, a.assertion, cred, webauthn, { fresh: false });
      // Categories from our catalog, never from the request or the consumer.
      const cats = await ctx.store.categories(cart.items.map((i) => i.sku));
      checkMandateScope(m, cart, { categories: cart.items.map((i) => cats.get(i.sku) ?? ""), now });
      mandateId = m.mandateId;
      // The bucket comes from the gate's clock, never cart.iat (D17).
      bucket = periodStart(m.limits.period, now);
      ledger = { mandateId, periodStart: bucket, amountMinor: cart.totalMinor, limitMinor: m.limits.periodMinor };
    });
  }

  // 7. Fresh and unused (authoritative nonce insert at commit).
  await step("7", "cart fresh, nonce unused", async () => {
    if (checkFreshness(cart, now) !== "ok") throw new HandshakeError("APPROVAL_EXPIRED", "cart approval expired");
    if (await ctx.store.nonceSeen(req.kid, "cart_approval", cart.nonce)) {
      throw new HandshakeError("APPROVAL_REPLAY", "cart nonce already used");
    }
  });

  // 8. Risk may only escalate. A human-approved cart already passed the step-up a flag asks for.
  const path: GatePath = a.kind;
  await step("8", "risk inspector", async () => {
    const verdict = await ctx.risk.inspect({
      path,
      userId: cart.userId,
      totalMinor: cart.totalMinor,
      items: cart.items,
      recentOrders: await ctx.store.ordersSince(cart.userId, nowMs - 10 * 60_000),
    });
    if (verdict.action === "block") throw new HandshakeError("RISK_BLOCKED", verdict.reason);
    if (verdict.action === "step_up" && path === "mandate")
      throw new HandshakeError("STEP_UP_REQUIRED", verdict.reason);
  });

  return {
    kind: "ok",
    path,
    decisions,
    commit: {
      requestId: req.requestId,
      agentId: req.kid,
      userId: cart.userId,
      offerId: offerRow.id,
      offerHash: offerRow.hash,
      now: nowMs,
      nonce: { value: cart.nonce, exp: cart.exp },
      ...(passkeyCas ? { passkey: passkeyCas } : {}),
      ...(ledger ? { ledger } : {}),
      order: {
        id: `ord_${b64urlEncode(randomBytes(12))}`,
        requestId: req.requestId,
        userId: cart.userId,
        offerId: offerRow.id,
        path,
        totalMinor: cart.totalMinor,
        currency: cart.currency,
        offerHash: offerRow.hash,
        approvalHash: hash(cart),
        mandateId,
        periodStart: bucket,
        fulfilBy: nowMs + FULFIL_WINDOW_MS,
      },
    },
  };
}
