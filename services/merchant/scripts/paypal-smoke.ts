// Live sandbox smoke test: OAuth → create AUTHORIZE order → buyer approves → authorize → void.
//   pnpm paypal:smoke             basic flow
//   pnpm paypal:smoke --capture   authorize → capture → tracking (sent twice, same id) → refund
//   pnpm paypal:smoke --vault     also the M0 vault spike: save the wallet, then pay a 2nd order with no redirect
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PayPalApiError,
  approvalLink,
  createPayPalClient,
  firstAuthorization,
  savedWallet,
  type PayPalClient,
  type PayPalOrder,
} from "../src/paypal/client.js";

const rootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const RETURN_URL = "https://example.com/handshake/return";
const CANCEL_URL = "https://example.com/handshake/cancel";
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

const spikeVault = process.argv.includes("--vault");
const captureFlow = process.argv.includes("--capture");

const paypal = createPayPalClient({
  baseUrl: process.env.PAYPAL_BASE_URL ?? "",
  clientId: process.env.PAYPAL_CLIENT_ID ?? "",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
});

function log(step: string, detail: Record<string, unknown> = {}): void {
  console.log(`• ${step}`, Object.keys(detail).length ? JSON.stringify(detail) : "");
}

async function waitForApproval(client: PayPalClient, orderId: string): Promise<void> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const order = await client.getOrder(orderId);
    if (order.status === "APPROVED") return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`order ${orderId} not approved within ${APPROVAL_TIMEOUT_MS / 60_000} min`);
}

async function authorizeAndVoid(order: PayPalOrder): Promise<PayPalOrder> {
  // A vault_id order may come back already authorized; otherwise authorize explicitly.
  const authorized = firstAuthorization(order) ? order : await paypal.authorizeOrder(order.id, randomUUID());
  const auth = firstAuthorization(authorized);
  if (!auth) throw new Error(`no authorization on order ${order.id}`);
  log("authorized", { orderId: order.id, authorizationId: auth.id, status: auth.status });

  const voided = await paypal.voidAuthorization(auth.id, randomUUID());
  log("voided", { orderId: order.id, authorizationId: auth.id, status: voided.status });
  console.log(`order ${order.id} … ${voided.status}`);
  return authorized;
}

async function captureTrackRefund(order: PayPalOrder): Promise<void> {
  const authorized = await paypal.authorizeOrder(order.id, randomUUID());
  const auth = firstAuthorization(authorized);
  if (!auth) throw new Error(`no authorization on order ${order.id}`);
  log("authorized", { orderId: order.id, authorizationId: auth.id, status: auth.status });

  const captureRequestId = randomUUID();
  const capture = await paypal.captureAuthorization(auth.id, captureRequestId);
  log("captured", { captureId: capture.id, status: capture.status });
  const again = await paypal.captureAuthorization(auth.id, captureRequestId);
  log("capture replay (same PayPal-Request-Id)", { captureId: again.id, sameCapture: again.id === capture.id });

  const trackRequestId = randomUUID();
  const tracking = {
    captureId: capture.id,
    trackingNumber: `SMOKE${Date.now()}`,
    carrier: "OTHER",
    carrierNameOther: "Handshake Demo",
  };
  const tracked = await paypal.addTracking(order.id, trackRequestId, tracking);
  log("tracking added", { id: tracked.id, status: tracked.status });
  const trackedAgain = await paypal.addTracking(order.id, trackRequestId, tracking);
  log("tracking replay (same PayPal-Request-Id)", { id: trackedAgain.id, status: trackedAgain.status });

  const refund = await paypal.refundCapture(capture.id, randomUUID());
  log("refunded", { refundId: refund.id, status: refund.status });
  console.log(`order ${order.id} … captured ${capture.status}, refund ${refund.status}`);
}

async function buyerApprovedOrder(saveWallet: boolean): Promise<PayPalOrder> {
  const requestId = randomUUID();
  const order = await paypal.createOrderAuthorize({
    requestId,
    invoiceId: `smoke-${requestId}`,
    totalMinor: 100,
    currency: "USD",
    returnUrl: RETURN_URL,
    cancelUrl: CANCEL_URL,
    saveWallet,
  });
  log("order created", { orderId: order.id, status: order.status, saveWallet });
  const link = approvalLink(order);
  if (!link) throw new Error("no approve / payer-action link on order");
  console.log(`\nOpen this link and approve with the sandbox PERSONAL (buyer) account:\n  ${link}\n`);
  console.log("Waiting for approval (the return page may 404 — that's fine)…");
  await waitForApproval(paypal, order.id);
  log("approved", { orderId: order.id });
  return order;
}

async function vaultSpike(vaultId: string): Promise<void> {
  for (const merchantInitiated of [false, true]) {
    const requestId = randomUUID();
    try {
      const order = await paypal.createOrderAuthorize({
        requestId,
        invoiceId: `smoke-${requestId}`,
        totalMinor: 100,
        currency: "USD",
        returnUrl: RETURN_URL,
        cancelUrl: CANCEL_URL,
        vaultId,
        merchantInitiated,
      });
      log("vault order created", { orderId: order.id, status: order.status, merchantInitiated });
      if (order.status === "PAYER_ACTION_REQUIRED") {
        log("vault order needs buyer approval — redirect still required", { merchantInitiated });
        continue;
      }
      await authorizeAndVoid(order);
      console.log(`\nVAULT SPIKE: SUCCESS — no redirect needed (stored_credential sent: ${merchantInitiated})`);
      return;
    } catch (err) {
      log("vault order failed", { merchantInitiated, ...describe(err) });
    }
  }
  console.log("\nVAULT SPIKE: FAILED — fall back to per-order buyer approval (SPEC §7.2)");
}

function describe(err: unknown): Record<string, unknown> {
  if (err instanceof PayPalApiError) return { httpStatus: err.httpStatus, issue: err.issue, debugId: err.debugId };
  return { error: err instanceof Error ? err.message : String(err) };
}

async function main(): Promise<void> {
  await paypal.getToken();
  log("oauth token ok");

  if (captureFlow) {
    await captureTrackRefund(await buyerApprovedOrder(false));
    return;
  }

  const order = await buyerApprovedOrder(spikeVault);
  const authorized = await authorizeAndVoid(order);
  if (!spikeVault) return;

  const vault = savedWallet(authorized);
  // A vault id can pay again without the buyer, so treat it like a token: log only its tail.
  log("vault result", { vaultId: vault?.id ? `…${vault.id.slice(-4)}` : undefined, status: vault?.status });
  if (!vault?.id) {
    console.log(
      vault?.status === "APPROVED"
        ? "\nVault APPROVED but no id yet — it arrives via VAULT.PAYMENT-TOKEN.CREATED webhook. Re-run spike later."
        : "\nVAULT SPIKE: FAILED — no vault id returned (is Vault enabled on the sandbox app?)",
    );
    return;
  }
  await vaultSpike(vault.id);
}

main().catch((err: unknown) => {
  console.error("smoke failed", describe(err));
  process.exit(1);
});
