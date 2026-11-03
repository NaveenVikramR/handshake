import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "@handshake/db";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import {
  READ_ONLY_PAYPAL_ACTIONS,
  assertReadOnly,
  openAIAssistantModel,
  type PayPalTools,
} from "./assistant/assistant.js";
import { createApp } from "./app.js";
import { orderEventHandler } from "./gate/order-events.js";
import { openAIRiskModel, riskInspector } from "./gate/risk.js";
import { startOrderExpiry } from "./gate/settle.js";
import { prismaGateStore } from "./gate/store.js";
import type { GateContext } from "./gate/verify.js";
import { startHoldExpiry } from "./offers/expiry.js";
import { loadSelf } from "./offers/service.js";
import { prismaOfferStore } from "./offers/store.js";
import { createPayPalClient } from "./paypal/client.js";
import { prismaWebhookStore } from "./webhooks/store.js";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const demoMode = process.env.DEMO_MODE === "true";
if (demoMode && process.env.NODE_ENV === "production") {
  throw new Error("DEMO_MODE must not be enabled in production");
}
const webhookId = process.env.PAYPAL_WEBHOOK_ID ?? "";
if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not set");

const paypal = createPayPalClient({
  baseUrl: process.env.PAYPAL_BASE_URL ?? "",
  clientId: process.env.PAYPAL_CLIENT_ID ?? "",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
});

/** Refuses to start if the toolkit offers anything that isn't read-only. */
function readOnlyToolkit(t: PayPalAgentToolkit): PayPalTools {
  assertReadOnly(t.getTools() as { type: string; function?: { name: string } }[]);
  return t as unknown as PayPalTools;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const agentId = process.env.MERCHANT_AGENT_ID ?? "";
const agentKey = process.env.MERCHANT_AGENT_PRIVATE_KEY ?? "";
if (!agentId || !agentKey) throw new Error("MERCHANT_AGENT_ID and MERCHANT_AGENT_PRIVATE_KEY must be set");

const db = createDb();
const offerStore = prismaOfferStore(db);
const self = await loadSelf(offerStore, agentId, agentKey);
startHoldExpiry(offerStore, Date.now);

const gateStore = prismaGateStore(db);
const gate: GateContext = {
  store: gateStore,
  registry: offerStore,
  self,
  paypal,
  risk: riskInspector(
    openAIRiskModel({ baseURL: required("LLM_BASE_URL"), apiKey: required("LLM_API_KEY"), model: required("LLM_MODEL") }),
  ),
  webauthn: { origin: required("WEBAUTHN_ORIGIN"), rpId: required("WEBAUTHN_RP_ID") },
  webUrl: required("WEB_URL"),
  now: Date.now,
};
startOrderExpiry(gate);

const demoSecret = process.env.DEMO_SECRET;
const app = createApp({
  webhooks: { paypal, store: prismaWebhookStore(db), webhookId, onOrderEvent: orderEventHandler(gateStore) },
  offers: { store: offerStore, self, now: Date.now },
  gate: {
    ctx: gate,
    adminToken: required("MERCHANT_ADMIN_TOKEN"),
    assistant: {
      store: gateStore,
      model: openAIAssistantModel({ baseURL: required("LLM_BASE_URL"), apiKey: required("LLM_API_KEY"), model: required("LLM_MODEL") }),
      // Read-only actions, sandbox only (rule 1); refunds go through /orders/:id/refund after a confirm.
      paypal: readOnlyToolkit(
        new PayPalAgentToolkit({
        clientId: required("PAYPAL_CLIENT_ID"),
        clientSecret: required("PAYPAL_CLIENT_SECRET"),
          configuration: { actions: READ_ONLY_PAYPAL_ACTIONS as never, context: { sandbox: true } },
        }),
      ),
    },
  },
  demoMode,
  ...(demoSecret === undefined ? {} : { demoSecret }),
});
const port = Number(process.env.PORT ?? 4001);
app.listen(port, () => console.log(`merchant ${self.merchantId} listening on :${port}${demoMode ? " (DEMO_MODE)" : ""}`));
