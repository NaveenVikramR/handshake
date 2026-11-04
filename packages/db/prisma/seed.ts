// Demo trust registry + catalog (M5). Idempotent: re-running updates names and prices, never stock
// (open holds would drift), status (a suspension stays) or an agent's key (unless SEED_ROTATE_KEYS=1).
// Agent public keys are derived from the configured private keys, so the registry matches what the
// services sign with.
import { publicKeyFromPrivate } from "@handshake/core";
import { DEMO_MERCHANT, DEMO_PRODUCTS, createDb } from "../src/index.js";

const PRODUCTS = DEMO_PRODUCTS;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see the example env file; agent keys come from \`pnpm keys:gen\`)`);
  return v;
}

const merchantAgent = {
  id: env("MERCHANT_AGENT_ID"),
  publicKey: publicKeyFromPrivate(env("MERCHANT_AGENT_PRIVATE_KEY")),
};
const consumerAgent = {
  id: env("CONSUMER_AGENT_ID"),
  publicKey: publicKeyFromPrivate(env("CONSUMER_AGENT_PRIVATE_KEY")),
};
const paypalMerchantId = env("PAYPAL_MERCHANT_ID");

// Re-running must not undo a suspension or silently swap a key the registry already trusts.
const rotate = process.env.SEED_ROTATE_KEYS === "1";

const db = createDb();
try {
  await db.$transaction(
    async (tx) => {
      const merchant = { name: DEMO_MERCHANT.name, paypalMerchantId };
      await tx.registryMerchant.upsert({
        where: { id: DEMO_MERCHANT.id },
        create: { id: DEMO_MERCHANT.id, ...merchant, status: "active" },
        update: merchant,
      });
      for (const a of [merchantAgent, consumerAgent]) {
        const existing = await tx.registryAgent.findUnique({ where: { id: a.id } });
        if (existing && existing.publicKey !== a.publicKey && !rotate) {
          throw new Error(`${a.id} is registered with a different key; set SEED_ROTATE_KEYS=1 to replace it`);
        }
      }
      const m = {
        role: "merchant",
        publicKey: merchantAgent.publicKey,
        merchantId: DEMO_MERCHANT.id,
      };
      await tx.registryAgent.upsert({
        where: { id: merchantAgent.id },
        create: { id: merchantAgent.id, ...m, status: "active" },
        update: m,
      });
      const c = { role: "consumer", publicKey: consumerAgent.publicKey, merchantId: null };
      await tx.registryAgent.upsert({
        where: { id: consumerAgent.id },
        create: { id: consumerAgent.id, ...c, status: "active" },
        update: c,
      });
      for (const { stock, ...p } of PRODUCTS) {
        await tx.product.upsert({ where: { sku: p.sku }, create: { ...p, stock }, update: p });
      }
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
  console.log(
    `db:seed — ${DEMO_MERCHANT.id}, agents ${merchantAgent.id} + ${consumerAgent.id}, ${PRODUCTS.length} products`,
  );
} finally {
  await db.$disconnect();
}
