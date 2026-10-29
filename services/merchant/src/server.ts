import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "@handshake/db";
import { createApp } from "./app.js";
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

const demoSecret = process.env.DEMO_SECRET;
const app = createApp({
  webhooks: { paypal, store: prismaWebhookStore(createDb()), webhookId },
  demoMode,
  ...(demoSecret === undefined ? {} : { demoSecret }),
});
const port = Number(process.env.PORT ?? 4001);
app.listen(port, () => console.log(`merchant listening on :${port}${demoMode ? " (DEMO_MODE)" : ""}`));
