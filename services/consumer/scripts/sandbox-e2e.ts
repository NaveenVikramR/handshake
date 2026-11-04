// `pnpm sandbox:e2e`: the M7 happy path against the real PayPal sandbox and the real LLM.
// chat "buy 1 rice" → consumer agent → merchant gate (in-process, memory stores) → PayPal create
// (save-wallet) → you approve on PayPal as the sandbox buyer → authorize → fulfil → capture →
// tracking → receipt. The passkey approval is simulated with the test authenticator (no phone UI
// until M8). Prints ids, statuses and the approve link only: no tokens, keys or vault ids.
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { generateEd25519KeyPair, hash, shipToHash } from "@handshake/core";
import express from "express";
import { FakeAuthenticator } from "../../../packages/core/test/fake-authenticator.js";
import { createApp as createMerchantApp } from "../../merchant/src/app.js";
import { openAIRiskModel, riskInspector } from "../../merchant/src/gate/risk.js";
import { fulfilOrder } from "../../merchant/src/gate/settle.js";
import { memoryGateStore } from "../../merchant/src/gate/store.js";
import type { GateContext } from "../../merchant/src/gate/verify.js";
import { loadSelf } from "../../merchant/src/offers/service.js";
import { memoryOfferStore } from "../../merchant/src/offers/store.js";
import { createPayPalClient } from "../../merchant/src/paypal/client.js";
import { memoryWebhookStore } from "../../merchant/src/webhooks/store.js";
import { runChat } from "../src/agent/loop.js";
import { openAIPlanner } from "../src/agent/planner.js";
import { verifyApproval } from "../src/approvals/service.js";
import type { AppContext } from "../src/context.js";
import { memoryWalletStore } from "../src/store.js";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};
const t0 = Date.now();
const say = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

// Throwaway agent keys and an in-memory registry: the run touches no database.
const mk = generateEd25519KeyPair();
const ck = generateEd25519KeyPair();
const paypalMerchantId = need("PAYPAL_MERCHANT_ID");
const merchants = [{ id: "mer_corner", name: "Corner Grocery", paypalMerchantId, status: "active" }];
const agents = [
  { id: "agt_m_corner", role: "merchant", publicKey: mk.publicKey, status: "active", merchantId: "mer_corner" },
  { id: "agt_c_wallet", role: "consumer", publicKey: ck.publicKey, status: "active", merchantId: null },
];
const offerStore = memoryOfferStore({
  agents,
  merchants,
  products: [
    { sku: "RICE-2KG", name: "Basmati rice 2 kg", category: "grocery", priceMinor: 499, stock: 50 },
    { sku: "ATTA-5KG", name: "Whole wheat atta 5 kg", category: "grocery", priceMinor: 899, stock: 30 },
    { sku: "DET-1L", name: "Liquid detergent 1 L", category: "household", priceMinor: 650, stock: 25 },
  ],
});
const self = await loadSelf(offerStore, "agt_m_corner", mk.privateKey);

const webauthn = { rpId: "wallet.handshake.test", rpName: "Handshake", origin: "https://wallet.handshake.test" };
const store = memoryWalletStore({ merchants, agents });
const gate = memoryGateStore({
  links: {
    offer: (id) => {
      const o = offerStore.offers.get(id);
      return o && { id, agentId: o.agentId, hash: hash(o.offer.payload), status: o.status, holdUntil: o.holdUntil };
    },
    setOfferStatus: (id, status) => {
      const o = offerStore.offers.get(id);
      if (o) o.status = status as typeof o.status;
    },
    passkey: async (id) => {
      const c = await store.getCredential(id);
      return c && { credentialId: c.credentialId, userId: c.userId, publicKey: c.publicKey };
    },
    mandate: async (id) => {
      const m = await store.getMandate(id);
      return m && { status: m.status, hash: m.hash };
    },
    categories: (skus) =>
      new Map(skus.flatMap((s) => (offerStore.products.has(s) ? [[s, offerStore.products.get(s)!.category]] : []))),
  },
});
const llm = { baseURL: need("LLM_BASE_URL"), apiKey: need("LLM_API_KEY"), model: need("LLM_MODEL") };
const paypal = createPayPalClient({
  baseUrl: need("PAYPAL_BASE_URL"),
  clientId: need("PAYPAL_CLIENT_ID"),
  clientSecret: need("PAYPAL_CLIENT_SECRET"),
});
const gateCtx: GateContext = {
  store: gate.store,
  registry: offerStore,
  self,
  paypal,
  risk: riskInspector(openAIRiskModel(llm)),
  webauthn: { origin: webauthn.origin, rpId: webauthn.rpId },
  webUrl: process.env.WEB_URL ?? "https://handshake-web-debi.onrender.com",
  now: Date.now,
  log: (msg, f) => say("merchant:", msg, JSON.stringify(f)),
};
const merchantApp = createMerchantApp({
  webhooks: {
    paypal: { verifyWebhook: async () => false },
    store: memoryWebhookStore(),
    webhookId: "unused",
    log: () => {},
  },
  offers: { store: offerStore, self, now: Date.now },
  gate: { ctx: gateCtx, adminToken: need("MERCHANT_ADMIN_TOKEN") },
  demoMode: false,
});
const server = express().use(merchantApp).listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const merchantUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const ctx: AppContext = {
  store,
  webauthn,
  consumerAgentId: "agt_c_wallet",
  now: Date.now,
  agent: {
    privateKey: ck.privateKey,
    merchantUrls: [merchantUrl],
    webUrl: gateCtx.webUrl,
    spent: (k) => gate.ledger.spent(k),
    planner: openAIPlanner(llm),
    approvalPollMs: 200,
    paypalPollMs: 4000,
  },
};

// The wallet user and their passkey (the test authenticator stands in for the phone).
const auth = new FakeAuthenticator(webauthn.rpId, webauthn.origin);
const userId = "usr_sandboxe2e000000000000";
await store.createUser({ id: userId, displayName: "Sandbox e2e" });
await store.addCredential({
  credentialId: auth.credentialId,
  userId,
  publicKey: auth.publicKeyCose,
  transports: ["internal"],
});
const shipTo = { name: "Alice", line1: "1 Main St", city: "Springfield", postalCode: "12345", country: "US" };

let receiptRequestId: string | undefined;
let exitCode = 1;
try {
  await runChat(
    ctx,
    ctx.agent!,
    { userId, message: "buy 1 rice", shipToHash: shipToHash(shipTo) },
    (e) => {
      if (e.type === "tool") say("tool", e.name, JSON.stringify(e.ids));
      else if (e.type === "tool_result") say("result", e.name, e.ok ? "ok" : e.error);
      else if (e.type === "path") say("path", e.path, e.path === "step_up" ? e.reasons.join("; ") : e.mandateId);
      else if (e.type === "approval_required") {
        say("passkey approval required →", e.url, "(simulating the phone)");
        void (async () => {
          const a = await store.getApproval(e.approvalId);
          await verifyApproval(ctx, e.approvalId, auth.assert(a!.hash));
          say("passkey approval simulated");
        })();
      } else if (e.type === "paypal_approval_required") {
        console.log(
          `\nPAYPAL_APPROVE_URL ${e.url}\nOpen it, log in as the sandbox PERSONAL buyer and approve. Waiting…\n`,
        );
      } else if (e.type === "receipt") {
        receiptRequestId = e.receipt.requestId;
        say(
          "receipt",
          e.receipt.status,
          "paypalOrderId",
          e.receipt.paypalOrderId,
          "authorizationId",
          e.receipt.authorizationId,
        );
      } else if (e.type === "message") say("agent:", e.text.replace(/\s+/g, " ").slice(0, 300));
      else say(e.type, JSON.stringify(e));
    },
    { log: () => {} },
  );
  const order = [...gate.orders.values()].find((o) => o.requestId === receiptRequestId);
  if (!order || order.status !== "authorized")
    throw new Error(`no authorized order (status ${order?.status ?? "none"})`);
  say("fulfilling order", order.id);
  const final = await fulfilOrder(gateCtx, order.id, { fulfilled: true, trackingNumber: `HS${Date.now()}` });
  say(
    "FINAL receipt",
    JSON.stringify({
      status: final.status,
      paypalOrderId: final.paypalOrderId,
      captureId: final.captureId,
      trackingNumber: final.trackingNumber,
    }),
  );
  const steps = final.decisions.map((d) => `${d.step}:${d.result}`).join(" ");
  say("decisions", steps);
  console.log(`RESULT status=${final.status} paypalOrderId=${final.paypalOrderId} captureId=${final.captureId ?? "-"}`);
  exitCode = final.status === "captured" ? 0 : 1;
} catch (e) {
  console.log("FAILED:", e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : "unknown");
} finally {
  server.close();
  process.exitCode = exitCode;
}
