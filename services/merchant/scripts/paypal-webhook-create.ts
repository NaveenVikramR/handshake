// `MERCHANT_URL=https://<merchant-host> pnpm paypal:webhook`: finds or creates the sandbox webhook
// for <MERCHANT_URL>/webhooks/paypal and prints its id and url. Prints no tokens or secrets.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PayPalApiError, createPayPalClient } from "../src/paypal/client.js";
import { ensureWebhook, webhookUrlFor } from "../src/paypal/webhook-setup.js";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

try {
  const url = webhookUrlFor(process.env.MERCHANT_URL ?? "");
  const paypal = createPayPalClient({
    baseUrl: process.env.PAYPAL_BASE_URL ?? "",
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
  });
  const { webhook, created, missing } = await ensureWebhook(paypal, url);
  console.log(`${created ? "created" : "already exists"}: webhook id ${webhook.id}`);
  console.log(`url: ${webhook.url}`);
  if (missing.length) console.log(`note: existing webhook is not subscribed to ${missing.join(", ")}`);
} catch (e) {
  // Name, status and PayPal issue only; never the request or token.
  if (e instanceof PayPalApiError)
    console.error(`PayPal error ${e.httpStatus} ${e.issue ?? ""} debug ${e.debugId ?? "-"}`);
  else console.error(e instanceof Error ? e.message : "failed");
  process.exitCode = 1;
}
