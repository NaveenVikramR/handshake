import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "@handshake/db";
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

const app = createApp({
  store: prismaWalletStore(createDb()),
  webauthn: { rpId, rpName: process.env.WEBAUTHN_RP_NAME ?? "Handshake", origin },
  consumerAgentId: required("CONSUMER_AGENT_ID"),
  now: Date.now,
});
const port = Number(process.env.PORT ?? 4002);
app.listen(port, () => console.log(`consumer listening on :${port} (rpId=${rpId})`));
