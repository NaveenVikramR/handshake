import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publicKeyFromPrivate } from "@handshake/core";
import { createDb, prismaMandateLedger } from "@handshake/db";
import { openAIPlanner } from "./agent/planner.js";
import { createApp } from "./app.js";
import { prismaWalletStore } from "./store.js";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const origin = required("WEBAUTHN_ORIGIN");
const rpId = required("WEBAUTHN_RP_ID");
// The RP ID must be the origin's host or a registrable suffix of it, or every ceremony fails.
const host = new URL(origin).hostname;
if (host !== rpId && !host.endsWith(`.${rpId}`)) throw new Error("WEBAUTHN_RP_ID does not match WEBAUTHN_ORIGIN");

const db = createDb();
const store = prismaWalletStore(db);
const consumerAgentId = required("CONSUMER_AGENT_ID");
const privateKey = required("CONSUMER_AGENT_PRIVATE_KEY");

// Every offer and payment request is checked against the registry key, so refuse to start with
// a key the registry doesn't hold for this agent (re-run db:seed after rotating keys).
const self = await store.getRegistryAgent(consumerAgentId);
if (!self || self.role !== "consumer" || self.status !== "active") {
  throw new Error(`consumer agent ${consumerAgentId} is not an active consumer agent in the registry`);
}
if (publicKeyFromPrivate(privateKey) !== self.publicKey) {
  throw new Error("CONSUMER_AGENT_PRIVATE_KEY does not match the registry public key (re-run db:seed)");
}

const ledger = prismaMandateLedger(db);
const app = createApp({
  store,
  webauthn: { rpId, rpName: process.env.WEBAUTHN_RP_NAME ?? "Handshake", origin },
  consumerAgentId,
  now: Date.now,
  agent: {
    privateKey,
    merchantUrls: required("MERCHANT_URL")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    webUrl: required("WEB_URL"),
    spent: (key) => ledger.spent(key),
    planner: openAIPlanner({
      baseURL: required("LLM_BASE_URL"),
      apiKey: required("LLM_API_KEY"),
      model: required("LLM_MODEL"),
    }),
  },
});
const port = Number(process.env.PORT ?? 4002);
app.listen(port, () => console.log(`consumer listening on :${port} (rpId=${rpId})`));
