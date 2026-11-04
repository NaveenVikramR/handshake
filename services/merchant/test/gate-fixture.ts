// A merchant with the gate wired to in-memory stores, a fake PayPal and a scripted risk inspector,
// plus helpers that build genuine payment requests (passkey and mandate paths) the way M6 does.
import {
  CartApproval,
  IntentMandate,
  PaymentRequest,
  generateEd25519KeyPair,
  hash,
  paymentRequestSigningInput,
  randomNonce,
  signEnvelope,
  signPayload,
  type Authorization,
  type SignedOffer,
} from "@handshake/core";
import request from "supertest";
import { FakeAuthenticator } from "../../../packages/core/test/fake-authenticator.js";
import { createApp } from "../src/app.js";
import { orderEventHandler } from "../src/gate/order-events.js";
import { afterOrderEvent } from "../src/gate/settle.js";
import type { RiskInspector, RiskVerdict } from "../src/gate/risk.js";
import { memoryGateStore } from "../src/gate/store.js";
import type { GateContext } from "../src/gate/verify.js";
import { loadSelf } from "../src/offers/service.js";
import { memoryOfferStore, type ProductRow } from "../src/offers/store.js";
import { memoryWebhookStore } from "../src/webhooks/store.js";
import { fakePayPal } from "./fake-paypal.js";

export const ADMIN = "admin-token-0123456789abcdef";
export const WEBAUTHN = { origin: "https://wallet.handshake.test", rpId: "wallet.handshake.test" };
export const USER = "usr_alice";

export const PRODUCTS: ProductRow[] = [
  { sku: "RICE-2KG", name: "Rice 2 kg", category: "grocery", priceMinor: 1000, stock: 100 },
  { sku: "DET-1L", name: "Detergent 1 L", category: "household", priceMinor: 650, stock: 100 },
];

export async function gateFixture(
  opts: { risk?: RiskVerdict; paypal?: { autoApprove?: boolean }; syncedPasskey?: boolean } = {},
) {
  const mk = generateEd25519KeyPair();
  const ck = generateEd25519KeyPair();
  // A synced passkey (iCloud, Google) always reports sign count 0 (D12).
  const auth = new FakeAuthenticator(WEBAUTHN.rpId, WEBAUTHN.origin, !opts.syncedPasskey);
  const merchants = [{ id: "mer_corner", name: "Corner", paypalMerchantId: "PPCORNER1", status: "active" }];
  const agents = [
    { id: "agt_m_corner", role: "merchant", publicKey: mk.publicKey, status: "active", merchantId: "mer_corner" },
    { id: "agt_c_wallet", role: "consumer", publicKey: ck.publicKey, status: "active", merchantId: null },
  ];
  const offerStore = memoryOfferStore({ agents, merchants, products: PRODUCTS.map((p) => ({ ...p })) });
  const self = await loadSelf(offerStore, "agt_m_corner", mk.privateKey);
  const mandates = new Map<string, { status: string; hash: string }>();

  const gate = memoryGateStore({
    passkeys: [{ credentialId: auth.credentialId, userId: USER, publicKey: auth.publicKeyCose, signCount: 0 }],
    links: {
      offer: (id) => {
        const o = offerStore.offers.get(id);
        return o && { id, agentId: o.agentId, hash: hash(o.offer.payload), status: o.status, holdUntil: o.holdUntil };
      },
      setOfferStatus: (id, status) => {
        const o = offerStore.offers.get(id);
        if (o) o.status = status as typeof o.status;
      },
      mandate: async (id) => mandates.get(id),
      categories: (skus) =>
        new Map(skus.flatMap((s) => (offerStore.products.has(s) ? [[s, offerStore.products.get(s)!.category]] : []))),
    },
    restock: (offerId) => {
      for (const l of offerStore.offers.get(offerId)?.lines ?? []) offerStore.products.get(l.sku)!.stock += l.qty;
    },
  });

  const paypal = fakePayPal(opts.paypal);
  const riskCalls: unknown[] = [];
  const risk: RiskInspector & { verdict: RiskVerdict } = {
    verdict: opts.risk ?? { action: "none", reason: "ok" },
    async inspect(input) {
      riskCalls.push(input);
      return this.verdict;
    },
  };
  const clock = { t: Date.now() };
  const webhookSig = { valid: true };
  const logs: string[] = [];
  const ctx: GateContext = {
    store: gate.store,
    registry: offerStore,
    self,
    paypal: paypal.client,
    risk,
    webauthn: WEBAUTHN,
    webUrl: "https://wallet.handshake.test",
    now: () => clock.t,
    log: (m) => logs.push(m),
  };
  const app = createApp({
    webhooks: {
      // Attack cases flip this to model a forged delivery (PayPal answers FAILURE).
      paypal: { verifyWebhook: async () => webhookSig.valid },
      store: memoryWebhookStore(),
      webhookId: "WH",
      onOrderEvent: orderEventHandler(gate.store),
      afterOrderEvent: afterOrderEvent(ctx),
      log: () => {},
    },
    offers: { store: offerStore, self, now: () => clock.t },
    gate: { ctx, adminToken: ADMIN },
    demoMode: true,
    demoReset: true,
    demoSecret: "demo-secret-0123456789",
  });

  const nowS = () => Math.floor(clock.t / 1000);

  async function offer(items: { sku: string; qty: number }[] = [{ sku: "RICE-2KG", qty: 1 }]): Promise<SignedOffer> {
    const iat = nowS();
    const req = signEnvelope(
      {
        v: 1,
        type: "offer_request",
        consumerAgentId: "agt_c_wallet",
        merchantId: "mer_corner",
        items,
        iat,
        exp: iat + 60,
        nonce: randomNonce(),
      },
      ck.privateKey,
      "agt_c_wallet",
    );
    const res = await request(app).post("/offers").send(req);
    if (res.status !== 201) throw new Error(`offer failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.offer as SignedOffer;
  }

  const shipToHash = hash({ line1: "1 Main St" });
  function cartFor(o: SignedOffer, patch: Partial<CartApproval> = {}): CartApproval {
    const p = o.payload;
    return CartApproval.parse({
      v: 1,
      type: "cart_approval",
      offerId: p.offerId,
      offerHash: hash(p),
      merchantId: p.merchantId,
      items: p.items,
      totalMinor: p.totalMinor,
      currency: p.currency,
      shipToHash,
      consumerAgentId: "agt_c_wallet",
      userId: USER,
      iat: nowS(),
      exp: nowS() + 300,
      nonce: randomNonce(),
      ...patch,
    });
  }

  function sign(
    o: SignedOffer,
    authorization: Authorization,
    opts2: { key?: string; kid?: string; requestId?: string } = {},
  ) {
    const body = { requestId: opts2.requestId ?? `req_${randomNonce()}`, offer: o, authorization };
    return PaymentRequest.parse({
      ...body,
      agentSig: signPayload(paymentRequestSigningInput(body), opts2.key ?? ck.privateKey),
      kid: opts2.kid ?? "agt_c_wallet",
    });
  }

  /** Passkey path: the human approved hash(cart) on the phone. */
  function passkeyRequest(
    o: SignedOffer,
    patch: Partial<CartApproval> = {},
    assertOpts: Parameters<FakeAuthenticator["assert"]>[1] = {},
  ) {
    const cart = cartFor(o, patch);
    return sign(o, { kind: "passkey", cartApproval: cart, assertion: auth.assert(hash(cart), assertOpts) });
  }

  /** An active mandate (approved once) the way the wallet stores it. */
  function mandate(patch: Partial<IntentMandate> = {}) {
    const m = IntentMandate.parse({
      v: 1,
      type: "intent_mandate",
      mandateId: `man_${randomNonce()}`,
      userId: USER,
      consumerAgentId: "agt_c_wallet",
      scope: { merchants: ["mer_corner"], categories: ["grocery"] },
      limits: { perOrderMinor: 3000, periodMinor: 8000, period: "week" },
      shipToHash,
      iat: nowS() - 10,
      exp: nowS() + 7 * 86400,
      nonce: randomNonce(),
      ...patch,
    });
    mandates.set(m.mandateId, { status: "active", hash: hash(m) });
    return { mandate: m, assertion: auth.assert(hash(m)) };
  }

  function mandateRequest(o: SignedOffer, md: ReturnType<typeof mandate>, patch: Partial<CartApproval> = {}) {
    return sign(o, { kind: "mandate", mandate: md.mandate, assertion: md.assertion, cart: cartFor(o, patch) });
  }

  const pay = (body: unknown) =>
    request(app)
      .post("/payments")
      .send(body as object);

  return {
    app,
    ctx,
    gate,
    offerStore,
    paypal,
    risk,
    riskCalls,
    clock,
    webhookSig,
    logs,
    auth,
    mandates,
    keys: { mk, ck },
    offer,
    cartFor,
    sign,
    passkeyRequest,
    mandate,
    mandateRequest,
    pay,
  };
}
export type GateFixture = Awaited<ReturnType<typeof gateFixture>>;
