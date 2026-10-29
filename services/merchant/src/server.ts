import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "@handshake/db";
import { createApp } from "./app.js";
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

const agentId = process.env.MERCHANT_AGENT_ID ?? "";
const agentKey = process.env.MERCHANT_AGENT_PRIVATE_KEY ?? "";
if (!agentId || !agentKey) throw new Error("MERCHANT_AGENT_ID and MERCHANT_AGENT_PRIVATE_KEY must be set");

const db = createDb();
const offerStore = prismaOfferStore(db);
const self = await loadSelf(offerStore, agentId, agentKey);
startHoldExpiry(offerStore, Date.now);

const demoSecret = process.env.DEMO_SECRET;
const app = createApp({
  webhooks: { paypal, store: prismaWebhookStore(db), webhookId },
  offers: { store: offerStore, self, now: Date.now },
  demoMode,
  ...(demoSecret === undefined ? {} : { demoSecret }),
});
const port = Number(process.env.PORT ?? 4001);
app.listen(port, () => console.log(`merchant ${self.merchantId} listening on :${port}${demoMode ? " (DEMO_MODE)" : ""}`));
