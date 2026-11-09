// `pnpm --filter @handshake/e2e return-probe`: does PayPal's sandbox checkout reveal an order's
// return_url (and so D31's `r` secret) to a browser that never approves it? Creates one sandbox order
// whose return_url carries a random sentinel, then scans every page and network response for it:
//   1. a stranger opens the approve link, not logged in;
//   2. the stranger logs in (PAYPAL_SANDBOX_BUYER2_*, else the main buyer) and stops before approving;
//   3. the real buyer approves in another browser (sanity: PayPal returns with the sentinel);
//   4. the stranger revisits the approve link, still logged in;
//   5. a fresh browser revisits the approve link.
// Navigations to the return URL are intercepted and never reach the deployed web. Prints hits only.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { approvalLink, createPayPalClient } from "../../services/merchant/src/paypal/client.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in .env`);
  return v;
};
const WEB = "https://handshake-web-debi.onrender.com";
const BUYER = { email: env("PAYPAL_SANDBOX_BUYER_EMAIL"), password: env("PAYPAL_SANDBOX_BUYER_PASSWORD") };
const STRANGER =
  process.env.PAYPAL_SANDBOX_BUYER2_EMAIL && process.env.PAYPAL_SANDBOX_BUYER2_PASSWORD
    ? { email: process.env.PAYPAL_SANDBOX_BUYER2_EMAIL, password: process.env.PAYPAL_SANDBOX_BUYER2_PASSWORD }
    : undefined;
const SENTINEL = randomBytes(32).toString("base64url");
const RETURN = `${WEB}/paypal/return?r=${SENTINEL}`;

const client = createPayPalClient({
  baseUrl: env("PAYPAL_BASE_URL"),
  clientId: env("PAYPAL_CLIENT_ID"),
  clientSecret: env("PAYPAL_CLIENT_SECRET"),
});
const requestId = randomUUID();
const order = await client.createOrderAuthorize({
  requestId,
  invoiceId: `probe-${requestId}`,
  totalMinor: 100,
  currency: "USD",
  returnUrl: RETURN,
  cancelUrl: `${WEB}/wallet`,
  saveWallet: true,
});
const approve = approvalLink(order);
if (!approve || !new URL(approve).host.endsWith("sandbox.paypal.com")) throw new Error("no sandbox approve link");
console.log(
  `order ${order.id} ${order.status}; stranger = ${STRANGER ? "second buyer" : "main buyer (no BUYER2 set)"}`,
);

type Hit = { phase: string; where: string; what: string };
const hits: Hit[] = [];
let phase = "";
const short = (u: string) => {
  const x = new URL(u);
  return `${x.host}${x.pathname}`;
};

async function watch(ctx: BrowserContext): Promise<void> {
  await ctx.route(`${WEB}/paypal/return**`, (route) => {
    hits.push({ phase, where: short(route.request().url()), what: "navigated to return_url" });
    return route.fulfill({ contentType: "text/html", body: "<p>probe: return intercepted</p>" });
  });
  ctx.on("request", (req) => {
    if (req.url().includes(SENTINEL) && !req.url().startsWith(`${WEB}/paypal/return`))
      hits.push({ phase, where: short(req.url()), what: "sentinel in request URL" });
  });
  ctx.on("response", async (res) => {
    const loc = res.headers().location ?? "";
    if (loc.includes(SENTINEL) || loc.includes("/paypal/return"))
      hits.push({ phase, where: short(res.url()), what: `redirect ${res.status()} to return_url` });
    const type = res.headers()["content-type"] ?? "";
    if (!/html|json|javascript|text/.test(type)) return;
    const body = await res.text().catch(() => "");
    if (body.includes(SENTINEL)) hits.push({ phase, where: short(res.url()), what: "sentinel in response body" });
    else if (body.includes("handshake-web-debi.onrender.com/paypal/return") || body.includes("%2Fpaypal%2Freturn"))
      hits.push({ phase, where: short(res.url()), what: "return path in response body" });
  });
}

async function scanPage(page: Page): Promise<void> {
  const html = await page.content().catch(() => "");
  if (html.includes(SENTINEL)) hits.push({ phase, where: short(page.url()), what: "sentinel in DOM" });
  for (const c of await page.context().cookies())
    if (c.value.includes(SENTINEL)) hits.push({ phase, where: c.domain, what: `sentinel in cookie ${c.name}` });
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })).catch(() => "");
  if (storage.includes(SENTINEL)) hits.push({ phase, where: short(page.url()), what: "sentinel in web storage" });
}

const reviewButton = (page: Page) =>
  page
    .locator('#payment-submit-btn, [data-testid="submit-button-initial"]')
    .or(page.getByRole("button", { name: /^(Continue|Continue to Review Order|Agree & Continue|Save and Continue)$/ }));

/** Logs in (one password attempt) and stops on PayPal's review page; `approve` clicks through. */
async function login(page: Page, who: { email: string; password: string }, approve: boolean): Promise<void> {
  const deadline = Date.now() + 4 * 60_000;
  let passwordTries = 0;
  while (Date.now() < deadline) {
    if (page.url().startsWith(`${WEB}/paypal/return`)) return;
    if (
      await page
        .getByText(/check your entries|tried too many times|couldn't log you in/i)
        .first()
        .isVisible()
        .catch(() => false)
    )
      throw new Error("PayPal rejected the sandbox login");
    await page
      .locator("#acceptAllButton")
      .click({ timeout: 1000 })
      .catch(() => {});
    const email = page.locator("#email");
    if ((await email.isVisible().catch(() => false)) && !(await email.inputValue().catch(() => "x"))) {
      await email.fill(who.email);
      await page
        .locator("#btnNext")
        .click({ timeout: 5000 })
        .catch(() => {});
    }
    const password = page.locator("#password");
    if ((await password.isVisible().catch(() => false)) && !(await password.inputValue().catch(() => "x"))) {
      if (++passwordTries > 1) throw new Error("PayPal asked for the password again: not retrying (lockout)");
      await password.fill(who.password);
      await page
        .locator("#btnLogin")
        .click({ timeout: 5000 })
        .catch(() => {});
    }
    const review = reviewButton(page).first();
    if (await review.isVisible().catch(() => false)) {
      if (!approve) return;
      await review.click({ timeout: 10_000 }).catch(() => {});
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(`PayPal flow timed out at ${short(page.url())}`);
}

const shots = `${root}e2e-screenshots/`;
const browser = await chromium.launch();
try {
  const stranger = await browser.newContext();
  await watch(stranger);
  const sp = await stranger.newPage();
  sp.setDefaultTimeout(60_000);

  phase = "1 stranger, anonymous";
  await sp.goto(approve);
  await sp.waitForLoadState("networkidle").catch(() => {});
  await scanPage(sp);
  await sp.screenshot({ path: `${shots}probe-1-anonymous.png` });

  phase = "2 stranger, logged in, not approving";
  await login(sp, STRANGER ?? BUYER, false);
  await sp.waitForLoadState("networkidle").catch(() => {});
  await scanPage(sp);
  await sp.screenshot({ path: `${shots}probe-2-stranger-review.png` });

  phase = "3 buyer approves (sanity)";
  const buyer = await browser.newContext();
  await watch(buyer);
  const bp = await buyer.newPage();
  bp.setDefaultTimeout(60_000);
  await bp.goto(approve);
  await login(bp, BUYER, true);
  await bp.screenshot({ path: `${shots}probe-3-buyer-returned.png` });

  phase = "4 stranger revisits, logged in";
  await sp.goto(approve);
  await sp.waitForLoadState("networkidle").catch(() => {});
  await sp.waitForTimeout(5000);
  await scanPage(sp);
  console.log(`  stranger revisit landed on ${short(sp.url())}`);
  await sp.screenshot({ path: `${shots}probe-4-stranger-revisit.png` });

  phase = "5 fresh browser revisits";
  const fresh = await browser.newContext();
  await watch(fresh);
  const fp = await fresh.newPage();
  await fp.goto(approve);
  await fp.waitForLoadState("networkidle").catch(() => {});
  await fp.waitForTimeout(5000);
  await scanPage(fp);
  console.log(`  fresh revisit landed on ${short(fp.url())}`);
  await fp.screenshot({ path: `${shots}probe-5-fresh-revisit.png` });

  const final = await client.getOrder(order.id).catch(() => undefined);
  if (final) console.log(`order now ${final.status}`);
} finally {
  await browser.close();
}

const seen = new Set<string>();
for (const h of hits) {
  const line = `[${h.phase}] ${h.what} @ ${h.where}`;
  if (seen.has(line)) continue;
  console.log(line);
  seen.add(line);
}
const sane = hits.some((h) => h.phase.startsWith("3") && h.what === "navigated to return_url");
const leaks = hits.filter((h) => !h.phase.startsWith("3"));
console.log(`sanity (buyer returned with sentinel): ${sane ? "yes" : "NO"}; leaks outside the buyer: ${leaks.length}`);
if (!sane) process.exitCode = 2;
else if (leaks.length) process.exitCode = 1;
