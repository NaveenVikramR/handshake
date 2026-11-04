// `pnpm demo:seed` (after `pnpm db:seed`): a clean demo shop. Voids held sandbox authorizations, clears
// payments, offers, nonces, spend, approvals and webhook rows, and restocks the catalog (D26). Users,
// passkeys, saved wallets and mandates stay. Refuses unless DEMO_MODE=true. Prints counts only.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_PRODUCTS, createDb } from "@handshake/db";
import { demoDatabaseMatches } from "../src/demo.js";
import { resetDemo } from "../src/gate/settle.js";
import { prismaGateStore } from "../src/gate/store.js";
import type { GateContext } from "../src/gate/verify.js";
import { createPayPalClient } from "../src/paypal/client.js";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

if (process.env.DEMO_MODE !== "true") {
  console.error("demo reset refused: set DEMO_MODE=true (demo database only)");
  process.exit(1);
}
if (!demoDatabaseMatches(process.env.DATABASE_URL, process.env.DEMO_DATABASE_HOST)) {
  console.error("demo reset refused: DEMO_DATABASE_HOST must be the host of DATABASE_URL (D26)");
  process.exit(1);
}

const db = createDb();
try {
  const paypal = createPayPalClient({
    baseUrl: process.env.PAYPAL_BASE_URL ?? "",
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
  });
  // Only the store, PayPal and the logger are used by the reset.
  const ctx = { store: prismaGateStore(db), paypal, now: Date.now, log: () => {} } as unknown as GateContext;
  const r = await resetDemo(ctx, DEMO_PRODUCTS);
  console.log(`demo reset — ${r.orders} orders cleared, ${r.voided} held authorizations voided, catalog restocked`);
} finally {
  await db.$disconnect();
}
