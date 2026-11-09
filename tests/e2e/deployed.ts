// `pnpm e2e:deployed`: the M10 phone flow against the deployed demo, with a Chrome virtual WebAuthn
// authenticator standing in for Face ID. Reset demo → sign up → address → chat → approval page →
// PayPal sandbox buyer → payer confirm → fulfil & capture → Simulate webhook → assistant → refund (and
// its sandbox webhook) → spending permission → a purchase with no approval step → capture.
// Screenshots go to e2e-screenshots/ (gitignored). Prints steps and statuses only: never the admin
// token, buyer credentials or ids beyond what the pages show.
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb } from "@handshake/db";
import { type BrowserContext, type CDPSession, type Page, chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);

const WEB = (process.env.E2E_WEB_URL ?? "https://handshake-web-debi.onrender.com").replace(/\/$/, "");
const MERCHANT = process.env.E2E_MERCHANT_URL ?? "https://handshake-merchant.onrender.com";
const CONSUMER = process.env.E2E_CONSUMER_URL ?? "https://handshake-consumer.onrender.com";
// The demo catalog (packages/db/src/catalog.ts) has rice, not coffee.
const MESSAGE = process.env.E2E_MESSAGE ?? "buy one Basmati rice from Corner Grocery";
const SHOTS = `${root}e2e-screenshots`;
const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`set ${n} in .env`);
  return v;
};
const ADMIN = need("MERCHANT_ADMIN_TOKEN");
const BUYER_EMAIL = need("PAYPAL_SANDBOX_BUYER_EMAIL");
const BUYER_PASSWORD = need("PAYPAL_SANDBOX_BUYER_PASSWORD");

const MIN = 60_000;
let shot = 0;
async function snap(page: Page, name: string): Promise<void> {
  shot++;
  await page.screenshot({ path: `${SHOTS}/${String(shot).padStart(2, "0")}-${name}.png`, fullPage: true });
}
const step = (s: string) => console.log(`• ${s}`);

/**
 * One passkey, moved between tabs: a virtual authenticator belongs to one tab, and the services
 * refuse a sign count that doesn't go up, so each ceremony starts from the latest copy.
 */
type Credential = Record<string, unknown>;
class Passkey {
  private cred: Credential | null = null;
  private sessions = new Map<Page, { s: CDPSession; id: string }>();

  async attach(ctx: BrowserContext, page: Page): Promise<void> {
    const s = await ctx.newCDPSession(page);
    await s.send("WebAuthn.enable");
    const { authenticatorId } = await s.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    this.sessions.set(page, { s, id: authenticatorId });
  }

  /** Runs `f` with the current credential on `page`'s authenticator, then keeps the updated copy. */
  async use<T>(page: Page, f: () => Promise<T>): Promise<T> {
    const a = this.sessions.get(page);
    if (!a) throw new Error("no authenticator on this tab");
    await a.s.send("WebAuthn.clearCredentials", { authenticatorId: a.id });
    if (this.cred) {
      await a.s.send("WebAuthn.addCredential", { authenticatorId: a.id, credential: this.cred as never });
    }
    const out = await f();
    const { credentials } = await a.s.send("WebAuthn.getCredentials", { authenticatorId: a.id });
    if (credentials.length !== 1) throw new Error(`expected one passkey, found ${credentials.length}`);
    this.cred = credentials[0] as unknown as Credential;
    return out;
  }
}

async function wake(): Promise<void> {
  step("waking merchant, consumer and web (free tier sleeps)");
  await Promise.all(
    [`${MERCHANT}/health`, `${CONSUMER}/health`, `${WEB}/`].map(async (u) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(3 * MIN) });
      if (!r.ok) throw new Error(`${u} → ${r.status}`);
    }),
  );
}

async function hrefOf(page: Page, name: string, timeout: number): Promise<string> {
  const link = page.getByRole("link", { name });
  await link.first().waitFor({ timeout });
  const href = await link.first().getAttribute("href");
  if (!href) throw new Error(`${name}: no href`);
  return href;
}

/** PayPal's sandbox pages vary (login first or later, cookie banner, review button names). */
async function paypalBuyer(page: Page): Promise<void> {
  const returned = () => page.url().startsWith(`${WEB}/paypal/return`);
  const buttons = [
    page.locator("#acceptAllButton"),
    page.locator("#btnNext"),
    page.locator("#btnLogin"),
    page.locator("#payment-submit-btn"),
    page.locator('[data-testid="submit-button-initial"]'),
    page.getByRole("button", {
      name: /^(Log In|Next|Continue|Continue to Review Order|Agree & Continue|Complete Purchase|Pay Now|Save and Continue)$/,
    }),
  ];
  // PayPal locks the buyer after a few failed logins: one password attempt, then stop.
  const rejected = page.getByText(/check your entries|tried too many times|couldn't log you in/i);
  const deadline = Date.now() + 4 * MIN;
  let clicks = 0;
  let passwordTries = 0;
  while (!returned()) {
    if (Date.now() > deadline) throw new Error(`PayPal didn't return to the wallet (at ${new URL(page.url()).host})`);
    if (
      await rejected
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await snap(page, "paypal-login-rejected");
      throw new Error("PayPal rejected the sandbox buyer login: check PAYPAL_SANDBOX_BUYER_EMAIL / _PASSWORD");
    }
    const email = page.locator("#email");
    if ((await email.isVisible().catch(() => false)) && !(await email.inputValue().catch(() => "x"))) {
      await email.fill(BUYER_EMAIL);
    }
    const password = page.locator("#password");
    if ((await password.isVisible().catch(() => false)) && !(await password.inputValue().catch(() => "x"))) {
      if (++passwordTries > 1) throw new Error("PayPal asked for the password again: not retrying (lockout)");
      await password.fill(BUYER_PASSWORD);
    }
    for (const b of buttons) {
      const first = b.first();
      if (await first.isVisible().catch(() => false)) {
        await first.click({ timeout: 10_000 }).catch(() => {});
        clicks++;
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        if (!returned() && clicks <= 8) await snap(page, `paypal-${clicks}`);
        break;
      }
    }
    await page.waitForTimeout(2000);
  }
}

/**
 * The sandbox's PAYMENT.CAPTURE.REFUNDED delivery, as the deployed merchant stored it (signature
 * verified, de-duplicated) in Neon dev's paypal_events. Returns its shape only, never the payload.
 */
async function refundWebhook(since: Date): Promise<Record<string, unknown>> {
  const db = createDb();
  try {
    const deadline = Date.now() + 4 * MIN;
    while (Date.now() < deadline) {
      const ev = await db.paypalEvent.findFirst({
        where: { type: "PAYMENT.CAPTURE.REFUNDED", receivedAt: { gte: new Date(since.getTime() - 5000) } },
        orderBy: { receivedAt: "desc" },
      });
      if (ev) {
        const p = ev.payloadJson as {
          resource_type?: string;
          resource?: { id?: string; status?: string; amount?: { value?: string }; links?: { rel?: string; href?: string }[] };
        };
        const up = p.resource?.links?.find((l) => l.rel === "up")?.href ?? "";
        return {
          resource_type: p.resource_type,
          resourceStatus: p.resource?.status,
          amount: p.resource?.amount?.value,
          upLinksToCapture: /\/v2\/payments\/captures\/[A-Z0-9]+$/.test(up),
          resourceKeys: Object.keys(p.resource ?? {}).sort(),
        };
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error("no PAYMENT.CAPTURE.REFUNDED webhook stored within 4 minutes");
  } finally {
    await db.$disconnect();
  }
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await wake();
  const browser = await chromium.launch({ headless: process.env.E2E_HEADED !== "1" });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  ctx.setDefaultTimeout(MIN);
  const pages: Page[] = [];
  try {
    // Merchant first: a clean shop.
    step("merchant: sign in, Reset demo");
    const shop = await ctx.newPage();
    pages.push(shop);
    shop.on("dialog", (d) => void d.accept());
    await shop.setViewportSize({ width: 1280, height: 900 });
    await shop.goto(`${WEB}/merchant`);
    await shop.locator("#t").fill(ADMIN);
    await shop.getByRole("button", { name: "Sign in" }).click();
    await shop.getByRole("heading", { name: /agent payments/ }).waitFor();
    await shop.getByRole("button", { name: "Reset demo" }).click();
    const resetNote = await shop.getByText(/^Demo reset: /).textContent({ timeout: 2 * MIN });
    console.log(`  ${resetNote}`);
    await snap(shop, "merchant-reset");

    // Wallet: a new user, so the first payment goes through PayPal.
    step("wallet: create passkey and sign in");
    const passkey = new Passkey();
    const w = await ctx.newPage();
    pages.push(w);
    await passkey.attach(ctx, w);
    await w.goto(`${WEB}/wallet`);
    await w.locator("#name").fill(`E2E ${new Date().toISOString().slice(5, 16)}`);
    await passkey.use(w, async () => {
      await w.getByRole("button", { name: "Create passkey" }).click();
      await w.getByRole("heading", { name: /'s wallet$/ }).waitFor();
    });
    await snap(w, "wallet-signed-in");

    step("wallet: delivery address");
    const addr = { name: "E2E Buyer", line1: "1 Market St", city: "San Jose", postalCode: "95113", country: "US" };
    for (const [k, v] of Object.entries(addr)) await w.getByPlaceholder(k, { exact: true }).fill(v);
    await snap(w, "wallet-address");

    step(`wallet: chat "${MESSAGE}"`);
    await w.locator("textarea").fill(MESSAGE);
    await w.getByRole("button", { name: "Send" }).click();
    const approveUrl = await hrefOf(w, "Open approval", 3 * MIN);
    await snap(w, "wallet-chat-approval");

    step("approval page: check the cart, approve with passkey");
    const ap = await ctx.newPage();
    pages.push(ap);
    await passkey.attach(ctx, ap);
    await ap.goto(approveUrl);
    await ap.getByText("✓ Verified merchant").waitFor();
    await ap.getByText("Ship to: E2E Buyer, San Jose 95113, US").waitFor();
    await snap(ap, "approval-cart");
    await passkey.use(ap, async () => {
      await ap.locator("button.btn.block").click();
      await ap.getByText("Approved. Payment held until delivery.").waitFor();
    });
    await snap(ap, "approval-done");

    step("PayPal sandbox: buyer login and approve");
    const paypalUrl = await hrefOf(w, "Open PayPal", 3 * MIN);
    if (!new URL(paypalUrl).host.endsWith("sandbox.paypal.com")) throw new Error("PayPal link isn't sandbox");
    const pp = await ctx.newPage();
    pages.push(pp);
    await pp.setViewportSize({ width: 1280, height: 900 });
    await pp.goto(paypalUrl);
    await paypalBuyer(pp);
    await pp.getByText(/^PayPal approved\./).waitFor({ timeout: 2 * MIN });
    await snap(pp, "paypal-returned");

    step("wallet: receipt, then confirm the PayPal payer with passkey");
    await w.getByText(/^Held: /).waitFor({ timeout: 3 * MIN });
    await snap(w, "wallet-receipt-held");
    await w.reload();
    await passkey.use(w, async () => {
      await w.getByRole("button", { name: "Confirm with passkey" }).click();
      await w.locator(".pill.ok", { hasText: "Confirmed" }).waitFor();
    });
    await snap(w, "wallet-payer-confirmed");

    step("merchant: fulfil & capture, then Simulate webhook twice");
    await shop.reload();
    await shop.getByRole("button", { name: "Fulfil & capture" }).click({ timeout: 2 * MIN });
    await shop
      .locator(".pill.ok", { hasText: "Paid" })
      .first()
      .waitFor({ timeout: 2 * MIN });
    await snap(shop, "merchant-captured");
    await shop.getByRole("button", { name: "Simulate webhook" }).first().click();
    await shop.getByText("Simulated webhook recorded; the order is unchanged").waitFor();
    await shop.getByRole("button", { name: "Simulate webhook" }).first().click();
    await shop.getByText("Duplicate webhook ignored (same event id)").waitFor();
    await shop.locator(".pill.ok", { hasText: "Paid" }).first().waitFor();
    await snap(shop, "merchant-simulated");

    step("merchant: ask the shopkeeper assistant (live LLM, read-only)");
    const assistant = shop.locator(".card", { has: shop.getByRole("heading", { name: "Shopkeeper assistant" }) });
    const ask = async (q: string) => {
      await assistant.locator("textarea").fill(q);
      await assistant.getByRole("button", { name: "Ask" }).click();
      const reply = assistant.locator(".md");
      await reply.waitFor({ timeout: 2 * MIN });
      const text = (await reply.textContent()) ?? "";
      if (/unavailable|went wrong/i.test(text)) throw new Error(`assistant: ${text}`);
      return text;
    };
    console.log(`  assistant replied (${(await ask("What is the status of the latest order, and was it captured?")).length} chars)`);
    await shop.locator(".pill.ok", { hasText: "Paid" }).first().waitFor();
    await snap(shop, "merchant-assistant");

    step("merchant: refund via the assistant's proposal, confirmed by the shopkeeper");
    await ask("Refund the latest captured order in full.");
    const proposal = assistant.locator(".banner.warn", { hasText: /^Refund \$/ }).first();
    await proposal.waitFor({ timeout: 2 * MIN });
    const refundClicked = new Date();
    await proposal.getByRole("button", { name: "Confirm" }).click();
    await shop.locator(".pill.grey", { hasText: "Refunded" }).first().waitFor({ timeout: 2 * MIN });
    await snap(shop, "merchant-refunded");

    step("PayPal sandbox: PAYMENT.CAPTURE.REFUNDED webhook received and verified");
    const shape = await refundWebhook(refundClicked);
    console.log(`  REFUNDED webhook: ${JSON.stringify(shape)}`);

    step("wallet: spending permission approved with passkey");
    w.on("dialog", (d) => void d.accept());
    await w.getByText("New permission").click();
    await passkey.use(w, async () => {
      await w.getByRole("button", { name: "Approve with passkey" }).click();
      await w.getByRole("button", { name: "Revoke" }).waitFor();
    });
    await snap(w, "wallet-permission");

    step(`wallet: chat "${MESSAGE}" again, covered by the permission (no approval step)`);
    await w.locator("textarea").fill(MESSAGE);
    await w.getByRole("button", { name: "Send" }).click();
    await w.getByText("Covered by your spending permission").waitFor({ timeout: 3 * MIN });
    await w.getByText(/^Held: /).waitFor({ timeout: 3 * MIN });
    if ((await w.getByRole("link", { name: "Open approval" }).count()) > 0) throw new Error("asked for approval");
    await snap(w, "wallet-mandate-purchase");

    step("merchant: fulfil & capture the permission purchase");
    await shop.reload();
    await shop.getByRole("button", { name: "Fulfil & capture" }).click({ timeout: 2 * MIN });
    await shop.locator(".pill.ok", { hasText: "Paid" }).first().waitFor({ timeout: 2 * MIN });
    await snap(shop, "merchant-mandate-captured");

    step("wallet: Activity shows one Paid and one Refunded");
    await w.reload();
    await w.locator("table .pill.ok", { hasText: "Paid" }).waitFor();
    await w.locator("table .pill.grey", { hasText: "Refunded" }).waitFor();
    await snap(w, "wallet-activity");
    console.log(`passed — ${shot} screenshots in e2e-screenshots/`);
  } catch (e) {
    for (const [i, p] of pages.entries()) {
      await p.screenshot({ path: `${SHOTS}/fail-${i}.png`, fullPage: true }).catch(() => {});
    }
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(`failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  process.exit(1);
});
