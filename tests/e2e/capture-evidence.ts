// `pnpm --filter @handshake/e2e capture-evidence`: the latest captured order in Neon dev (as the
// deployed merchant stored it), re-read from the PayPal sandbox with GET /v2/payments/captures/:id.
// Prints PayPal ids and statuses only.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "@handshake/db";
import { createPayPalClient } from "../../services/merchant/src/paypal/client.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in .env`);
  return v;
};

const db = createDb();
try {
  const order = await db.order.findFirst({
    where: { status: "captured", captureId: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  if (!order?.captureId) throw new Error("no captured order in the database");
  const paypal = createPayPalClient({
    baseUrl: env("PAYPAL_BASE_URL"),
    clientId: env("PAYPAL_CLIENT_ID"),
    clientSecret: env("PAYPAL_CLIENT_SECRET"),
  });
  const capture = await paypal.getCapture(order.captureId);
  console.log(
    JSON.stringify({
      orderStatus: order.status,
      paypalOrderId: order.paypalOrderId,
      totalMinor: order.totalMinor,
      updatedAt: order.updatedAt.toISOString(),
      captureId: capture.id,
      captureStatus: capture.status,
    }),
  );
} finally {
  await db.$disconnect();
}
