// Attack harness (SPEC §11): the real merchant app and gate (memory stores, fake PayPal, fake
// authenticator) from the merchant test fixture. Each case starts from a fully valid request and
// changes one thing; `submit` reports the gate's code and whether anything new was authorized.
import {
  generateEd25519KeyPair,
  paymentRequestSigningInput,
  signEnvelope,
  signPayload,
  type CartApproval,
  type PaymentRequest,
  type SignedOffer,
} from "../../packages/core/src/index.js";
import request from "supertest";
import { riskInspector, type RiskModel } from "../../services/merchant/src/gate/risk.js";
import { ADMIN, USER, gateFixture } from "../../services/merchant/test/gate-fixture.js";

export type Category =
  "control" | "tamper" | "replay" | "identity" | "mandate" | "injection" | "idempotency" | "webhook" | "webauthn";

export interface Outcome {
  /** The gate's HandshakeError code, "OK" for a 2xx, or `webhook:<outcome>` for webhook deliveries. */
  code: string;
  /** Something new was authorized at PayPal (an order got an authorization, or a create was sent). */
  authorized: boolean;
  /** The gate's reason for the failing step (decisions log), when there was one. */
  reason?: string;
}

export type HarnessOptions = Parameters<typeof gateFixture>[0] & {
  /** No saved wallet: the first order goes through PayPal's approval redirect. */
  noVault?: boolean;
};

export interface AttackCase {
  id: string;
  title: string;
  category: Category;
  /** The SPEC §11 item this case covers. */
  spec: string;
  expect: string;
  /** Controls (and attacks whose right outcome is an honest payment) must authorize; every other attack must not. */
  expectAuthorized?: boolean;
  /** The failing step's reason must contain this (for codes several checks share). */
  reason?: string;
  /**
   * Authorizations the whole case leaves at PayPal, setup included (default: 1 if expectAuthorized, else 0).
   * Catches an attack that authorizes in a submit the case doesn't return.
   */
  authorizations?: number;
  /** Harness options for this case (e.g. a synced passkey, no saved wallet). */
  options?: HarnessOptions;
  run(h: Harness): Promise<Outcome>;
}

export const defineAttack = (c: AttackCase) => c;

const auths = (f: Fixture) => [...f.gate.orders.values()].filter((o) => o.authorizationId).length;
type Fixture = Awaited<ReturnType<typeof gateFixture>>;

export async function createHarness(opts: HarnessOptions = {}) {
  const { noVault, ...fixtureOpts } = opts;
  const f = await gateFixture(fixtureOpts);
  // A confirmed saved wallet: a valid request authorizes at once (200), no PayPal redirect.
  if (!noVault) {
    f.gate.vaults.set(USER, {
      vaultId: "VAULT-PRE",
      payerId: "BUYERPAYER1",
      payerEmail: "buyer@example.com",
      status: "confirmed",
    });
  }
  /** First 2xx body per request id, to check that a duplicate gets the same receipt back. */
  const sent = new Map<string, string>();
  const creates = () => f.paypal.calls.filter((c) => c.op === "create").length;

  async function submit(body: unknown): Promise<Outcome> {
    const [a0, c0] = [auths(f), creates()];
    const res = await f.pay(body);
    const rid = (body as { requestId?: unknown } | null)?.requestId;
    const first = typeof rid === "string" ? sent.get(rid) : undefined;
    if (typeof rid === "string" && res.status < 300 && first === undefined) sent.set(rid, JSON.stringify(res.body));
    const authorized = auths(f) > a0 || creates() > c0;
    const err = (res.body as { error?: string } | undefined)?.error;
    // Step 2 answers a seen requestId with the stored receipt (200); name it for the table.
    const dup = first === JSON.stringify(res.body) ? "DUPLICATE_REQUEST" : "DUPLICATE_OTHER_BODY";
    const code = err ?? (res.status < 300 ? (first !== undefined && !authorized ? dup : "OK") : `HTTP_${res.status}`);
    const reason = f.gate.decisions.filter((d) => d.requestId === rid && d.result === "fail").at(-1)?.reason;
    return { code, authorized, ...(reason ? { reason } : {}) };
  }

  /** Every PayPal call the fake saw, optionally one op. */
  const paypalCalls = (op?: string) => f.paypal.calls.filter((c) => !op || c.op === op);

  /** Re-signs a (tampered) request with the consumer agent's own key, as a compromised agent would. */
  function resign(r: PaymentRequest): PaymentRequest {
    const body = { requestId: r.requestId, offer: r.offer, authorization: r.authorization };
    return { ...r, agentSig: signPayload(paymentRequestSigningInput(body), f.keys.ck.privateKey) };
  }

  /** A new cart for `offer`, carrying the passkey assertion the human gave for `approved`'s cart. */
  function reuseApproval(approved: PaymentRequest, offer: SignedOffer, patch: Partial<CartApproval> = {}) {
    if (approved.authorization.kind !== "passkey") throw new Error("passkey request expected");
    return f.sign(offer, {
      kind: "passkey",
      cartApproval: f.cartFor(offer, patch),
      assertion: approved.authorization.assertion,
    });
  }

  /** An offer envelope signed by `key` (default: a key the registry has never seen). */
  function forgeOffer(o: SignedOffer, patch: Partial<SignedOffer["payload"]>, key?: string, kid?: string) {
    return signEnvelope(
      { ...o.payload, ...patch },
      key ?? generateEd25519KeyPair().privateKey,
      kid ?? o.kid,
    ) as SignedOffer;
  }

  /** Swaps the risk inspector for the real one (rules + model) driven by `model`. */
  function useRiskModel(model: RiskModel) {
    f.ctx.risk = riskInspector(model);
  }

  /** The cart the human approved (passkey) or the mandate cart, mutable for tampering. */
  function cart(r: PaymentRequest): CartApproval {
    return r.authorization.kind === "passkey" ? r.authorization.cartApproval : r.authorization.cart;
  }

  const fulfil = (orderId: string, body: object) =>
    request(f.app).post(`/orders/${orderId}/fulfil`).set("authorization", `Bearer ${ADMIN}`).send(body);

  /** Overrides one registry agent row (e.g. suspended, or another role). */
  function patchAgent(id: string, patch: { status?: string; role?: string }) {
    const base = f.ctx.registry;
    f.ctx.registry = {
      ...base,
      getAgent: async (aid: string) => {
        const a = await base.getAgent(aid);
        return a && aid === id ? { ...a, ...patch } : a;
      },
    };
  }

  /** Registers one more agent (e.g. another merchant's) in the registry the gate reads. */
  function addAgent(row: { id: string; role: string; publicKey: string; status: string; merchantId: string | null }) {
    const base = f.ctx.registry;
    f.ctx.registry = { ...base, getAgent: async (aid: string) => (aid === row.id ? { ...row } : base.getAgent(aid)) };
  }

  /** Orders that hold a PayPal authorization, setup included. */
  const totalAuthorizations = () => auths(f);

  /**
   * Charges beyond one per offer: two authorized orders for one offer, two PayPal authorizes for one
   * order, two captures of one authorization. The fake answers a repeated PayPal-Request-Id with the
   * first result, so only distinct request ids count.
   */
  function duplicateCharges(): number {
    const over = (keys: string[]) => {
      const n = new Map<string, number>();
      for (const k of keys) n.set(k, (n.get(k) ?? 0) + 1);
      return [...n.values()].filter((x) => x > 1).length;
    };
    const distinct = (op: string) => [...new Map(paypalCalls(op).map((c) => [c.requestId ?? "", String(c.args)])).values()];
    const authorizedOrders = [...f.gate.orders.values()].filter((o) => o.authorizationId);
    return over(authorizedOrders.map((o) => o.offerId)) + over(distinct("authorize")) + over(distinct("capture"));
  }

  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT",
    "paypal-transmission-id": "t1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": new Date().toISOString(),
  };

  /** Delivers a webhook; `signed: false` makes PayPal's verify answer FAILURE. */
  async function webhook(event: object, o: { signed?: boolean; headers?: Record<string, string> } = {}) {
    f.webhookSig.valid = o.signed ?? true;
    const res = await request(f.app)
      .post("/webhooks/paypal")
      .set("content-type", "application/json")
      .set(o.headers ?? headers)
      .send(JSON.stringify(event));
    f.webhookSig.valid = true;
    return { status: res.status, outcome: String((res.body as { outcome?: string }).outcome) };
  }

  /** A valid passkey order that the gate authorized, then captured on fulfilment. */
  async function capturedOrder() {
    const r = await submit((await happyPathRequest()).request);
    if (!r.authorized) throw new Error("setup: happy path did not authorize");
    const order = [...f.gate.orders.values()].at(-1)!;
    await request(f.app)
      .post(`/orders/${order.id}/fulfil`)
      .set("authorization", `Bearer ${ADMIN}`)
      .send({ fulfilled: true });
    return f.gate.orders.get(order.id)!;
  }

  async function authorizedOrder() {
    const r = await submit((await happyPathRequest()).request);
    if (!r.authorized) throw new Error("setup: happy path did not authorize");
    return [...f.gate.orders.values()].at(-1)!;
  }

  /** A fully valid passkey-path request for a fresh offer. */
  async function happyPathRequest(items?: { sku: string; qty: number }[]) {
    const offer = await f.offer(items);
    return { offer, request: f.passkeyRequest(offer) };
  }

  /** A fully valid mandate-path request for a fresh offer. */
  async function mandatePath(items?: { sku: string; qty: number }[], patch?: Parameters<Fixture["mandate"]>[0]) {
    const md = f.mandate(patch);
    const offer = await f.offer(items);
    return { md, offer, request: f.mandateRequest(offer, md) };
  }

  return {
    f,
    submit,
    paypalCalls,
    cart,
    fulfil,
    resign,
    reuseApproval,
    forgeOffer,
    useRiskModel,
    patchAgent,
    addAgent,
    totalAuthorizations,
    duplicateCharges,
    webhook,
    capturedOrder,
    authorizedOrder,
    happyPathRequest,
    mandatePath,
    advance: (ms: number) => void (f.clock.t += ms),
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
