// `pnpm paypal:verify-shapes`: settles the three open VERIFY notes in docs/PAYPAL.md against the
// sandbox. Prints PayPal ids, statuses, field names and booleans only: never emails, payer ids,
// vault ids or tokens.
//   1. PAYMENT.CAPTURE.REVERSED: the webhooks simulator's mock event (resource_type, resource keys).
//      Posted to example.com, not to our listener (mock events can't pass signature verification).
//   2. Payer on an authorized order: which of payer.payer_id / payer.email_address /
//      payment_source.paypal.account_id / email_address PayPal returns, read from the latest
//      authorized or captured order in Neon dev, and whether stored vaults got a payer id at authorize.
//   3. Void after a declined capture: pays a $0.01 order from a confirmed saved wallet (no buyer
//      redirect), captures with negative-testing codes, reads the authorization, then voids it.
//      Skipped unless --void is passed, since it creates a sandbox order.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "@handshake/db";
import { PayPalApiError, createPayPalClient, firstAuthorization, payerOf } from "../src/paypal/client.js";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const paypal = createPayPalClient({
  baseUrl: process.env.PAYPAL_BASE_URL ?? "",
  clientId: process.env.PAYPAL_CLIENT_ID ?? "",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
});
const out = (label: string, v: unknown) => console.log(`• ${label}`, JSON.stringify(v));
const failure = (e: unknown) =>
  e instanceof PayPalApiError ? { status: e.status, issue: e.message, debugId: e.debugId } : String(e);

async function reversed() {
  for (const [type, version] of [
    ["PAYMENT.CAPTURE.REVERSED", "1.0"],
    ["PAYMENT.CAPTURE.REVERSED", "2.0"],
    ["PAYMENT.CAPTURE.REFUNDED", "2.0"],
  ] as const) {
    try {
      const ev = await paypal.simulateWebhookEvent(type, "https://example.com/handshake/simulate", `sim-${randomUUID()}`, version);
      const r = ev.resource ?? {};
      const links = Array.isArray(r.links) ? (r.links as { rel?: string; href?: string }[]) : [];
      out(`simulate ${type} v${version}`, {
        resource_type: ev.resource_type,
        resource_version: ev.resource_version,
        resourceKeys: Object.keys(r).sort(),
        status: r.status,
        upLink: links.find((l) => l.rel === "up")?.href?.replace(/[A-Z0-9]{10,}/g, "{id}"),
      });
    } catch (e) {
      out(`simulate ${type} v${version} FAILED`, failure(e));
    }
  }
}

async function payer(db: ReturnType<typeof createDb>) {
  const order = await db.order.findFirst({
    where: { paypalOrderId: { not: null }, status: { in: ["authorized", "captured", "fulfilled", "refunded"] } },
    orderBy: { createdAt: "desc" },
  });
  if (order?.paypalOrderId) {
    try {
      const o = await paypal.getOrder(order.paypalOrderId);
      out("order payer fields (GET order after authorize)", {
        orderStatus: o.status,
        payer_payer_id: Boolean(o.payer?.payer_id),
        payer_email_address: Boolean(o.payer?.email_address),
        payment_source_paypal_account_id: Boolean(o.payment_source?.paypal?.account_id),
        payment_source_paypal_email_address: Boolean(o.payment_source?.paypal?.email_address),
        payerOfResolves: Boolean(payerOf(o).payerId),
      });
    } catch (e) {
      out("GET order FAILED", failure(e));
    }
  } else out("no authorized order with a PayPal id in the database", {});
  // A vault row's payer id was read from the authorize response itself (payerOf on authorize).
  const vaults = await db.paypalVault.findMany({ select: { payerId: true, payerEmail: true, status: true } });
  out("vault rows: payer read at authorize", {
    rows: vaults.length,
    withPayerId: vaults.filter((v) => v.payerId).length,
    withPayerEmail: vaults.filter((v) => v.payerEmail).length,
  });
}

async function voidAfterDecline(db: ReturnType<typeof createDb>) {
  const vault = await db.paypalVault.findFirst({ where: { status: "confirmed" }, orderBy: { createdAt: "desc" } });
  if (!vault) return out("void-after-decline SKIPPED: no confirmed saved wallet in the database", {});
  const id = `verify-${randomUUID()}`;
  const created = await paypal.createOrderAuthorize({
    requestId: `${id}-create`,
    invoiceId: id,
    totalMinor: 1,
    currency: "USD",
    returnUrl: "https://example.com/handshake/return",
    cancelUrl: "https://example.com/handshake/cancel",
    vaultId: vault.vaultId,
  });
  const order =
    created.status === "COMPLETED" || firstAuthorization(created)
      ? created
      : await paypal.authorizeOrder(created.id, `${id}-authorize`);
  const auth = firstAuthorization(order);
  out("vault order", { orderId: order.id, status: order.status, authorizationStatus: auth?.status });
  if (!auth) return out("void-after-decline SKIPPED: no authorization on the order", {});

  let declined = false;
  for (const code of ["INSTRUMENT_DECLINED", "TRANSACTION_REFUSED", "DECLINED"]) {
    try {
      const c = await paypal.captureAuthorization(auth.id, `${id}-capture-${code}`, { mockApplicationCode: code });
      out(`mock capture ${code}`, { captureStatus: c.status, note: "mock code not applied; a real capture happened" });
      // A real capture went through: refund it so the sandbox balance is untouched, and stop.
      await paypal.refundCapture(c.id, `${id}-refund`);
      return out("refunded the accidental capture", { captureId: c.id });
    } catch (e) {
      out(`mock capture ${code}`, failure(e));
      // The wrapped status is ours; PayPal's HTTP status is in the message.
      if (e instanceof PayPalApiError && /\b422\b/.test(e.message)) {
        declined = true;
        break;
      }
    }
  }
  out("authorization after the declined capture", await paypal.getAuthorization(auth.id).catch(failure));
  try {
    const v = await paypal.voidAuthorization(auth.id, `${id}-void`);
    out("void", { declinedFirst: declined, status: v.status });
  } catch (e) {
    out("void FAILED", { declinedFirst: declined, ...((typeof failure(e) === "object" ? failure(e) : {}) as object) });
  }
}

const db = createDb();
try {
  await reversed();
  await payer(db);
  if (process.argv.includes("--void")) await voidAfterDecline(db);
  else out("void-after-decline: pass --void to run it (creates and voids a $0.01 sandbox order)", {});
} finally {
  await db.$disconnect();
}
