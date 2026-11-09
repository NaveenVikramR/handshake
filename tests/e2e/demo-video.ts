// `pnpm --filter @handshake/e2e demo-video record|build`: the submission video draft.
//   record  drives the deployed demo with Playwright (recordVideo, a virtual authenticator standing in
//           for Face ID, the real PayPal sandbox buyer) and writes demo/raw/*.webm + segments.json,
//           marking only the moments worth showing.
//   build   renders the cards and captions with Chromium, cuts and speeds up the marked segments with
//           ffmpeg-static, and writes demo/handshake-demo.mp4 (1920×1080, no audio), demo/SHOTLIST.md
//           and a frame every 10 s in demo/frames/.
// The PayPal login segment is blurred so the sandbox buyer's email never appears. Never prints secrets.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { type BrowserContext, type CDPSession, type Page, chromium } from "playwright";

// ffmpeg-static is CommonJS (module.exports = path); require keeps its type a plain string.
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;
const root = fileURLToPath(new URL("../../", import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const WEB = "https://handshake-web-debi.onrender.com";
const MERCHANT = "https://handshake-merchant.onrender.com";
const CONSUMER = "https://handshake-consumer.onrender.com";
const DEMO = `${root}demo`;
const RAW = `${DEMO}/raw`;
const BUILD = `${DEMO}/build`;
const MIN = 60_000;
const MESSAGE = "buy 1 Basmati rice from Corner Grocery";
const QUOTE =
  "“If you think about consumer agents buying from merchant agents, both will have to validate that this is a real consumer” … and “a real merchant that has the product.”";
const QUOTE_BY = "Enrique Lores, CEO, PayPal · Q3 2026 earnings call (27 Oct 2026), as reported by PYMNTS";
const PITCH = "Agents can shop for you, but only you can approve the payment, and every agent proves who it is.";

type Layout = "phone" | "desk";
interface Segment {
  video: string;
  start: number;
  end: number;
  maxSec: number;
  layout: Layout;
  title: string;
  caption: string;
  blur?: boolean;
}

// ---------------------------------------------------------------- record

class Passkey {
  private cred: Record<string, unknown> | null = null;
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
  async use<T>(page: Page, f: () => Promise<T>): Promise<T> {
    const a = this.sessions.get(page);
    if (!a) throw new Error("no authenticator on this tab");
    await a.s.send("WebAuthn.clearCredentials", { authenticatorId: a.id });
    if (this.cred) await a.s.send("WebAuthn.addCredential", { authenticatorId: a.id, credential: this.cred as never });
    const out = await f();
    const { credentials } = await a.s.send("WebAuthn.getCredentials", { authenticatorId: a.id });
    if (credentials.length !== 1) throw new Error(`expected one passkey, found ${credentials.length}`);
    this.cred = credentials[0] as unknown as Record<string, unknown>;
    return out;
  }
}

async function paypalBuyer(page: Page, email: string, password: string): Promise<void> {
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
  const deadline = Date.now() + 4 * MIN;
  let passwordTries = 0;
  while (!returned()) {
    if (Date.now() > deadline) throw new Error("PayPal didn't return to the wallet");
    if (
      await page
        .getByText(/check your entries|tried too many times|couldn't log you in/i)
        .first()
        .isVisible()
        .catch(() => false)
    )
      throw new Error("PayPal rejected the sandbox buyer login");
    const e = page.locator("#email");
    if ((await e.isVisible().catch(() => false)) && !(await e.inputValue().catch(() => "x"))) await e.fill(email);
    const p = page.locator("#password");
    if ((await p.isVisible().catch(() => false)) && !(await p.inputValue().catch(() => "x"))) {
      if (++passwordTries > 1) throw new Error("PayPal asked for the password again: not retrying (lockout)");
      await p.fill(password);
    }
    for (const b of buttons) {
      if (
        await b
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        await b
          .first()
          .click({ timeout: 10_000 })
          .catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(1500);
  }
}

async function record(): Promise<void> {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`set ${k} in .env`);
    return v;
  };
  const ADMIN = need("MERCHANT_ADMIN_TOKEN");
  const BUYER_EMAIL = need("PAYPAL_SANDBOX_BUYER_EMAIL");
  const BUYER_PASSWORD = need("PAYPAL_SANDBOX_BUYER_PASSWORD");
  rmSync(RAW, { recursive: true, force: true });
  mkdirSync(RAW, { recursive: true });

  console.log("• waking merchant, consumer and web");
  await Promise.all(
    [`${MERCHANT}/health`, `${CONSUMER}/health`, `${WEB}/`].map(async (u) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(3 * MIN) });
      if (!r.ok) throw new Error(`${u} → ${r.status}`);
    }),
  );

  const segments: Segment[] = [];
  const born = new Map<Page, { name: string; t0: number }>();
  const track = (page: Page, name: string) => born.set(page, { name, t0: Date.now() });
  const now = (page: Page) => (Date.now() - born.get(page)!.t0) / 1000;
  async function clip<T>(
    page: Page,
    s: { layout: Layout; maxSec: number; title: string; caption: string; hold?: number; blur?: boolean },
    f: () => Promise<T>,
  ): Promise<T> {
    const start = now(page);
    const out = await f();
    await page.waitForTimeout(s.hold ?? 1500);
    const { hold: _h, ...rest } = s;
    segments.push({ video: born.get(page)!.name, start, end: now(page), ...rest });
    console.log(`  ✓ ${s.title}`);
    return out;
  }

  const browser = await chromium.launch();
  // Playwright records CSS pixels, not device pixels, so a sharp phone video is a 780×1688 window with
  // our pages zoomed 2× (a 390-px-wide layout). PayPal's pages render unzoomed.
  const phone = await browser.newContext({
    viewport: { width: 780, height: 1688 },
    recordVideo: { dir: RAW, size: { width: 780, height: 1688 } },
  });
  // The wallet's PayPal card shows the sandbox buyer's email (a judge credential): blur it on screen.
  const hidePayer = [
    "p:has(+ button.btn.block) strong, p:has(> .pill.ok) { color: transparent !important; text-shadow: 0 0 9px rgba(0,0,0,.55) !important; }",
    "p:has(> .pill.ok) > .pill.ok { color: var(--ok) !important; text-shadow: none !important; }",
  ].join(" ");
  await phone.addInitScript(
    `if (location.host.startsWith("handshake-web")) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.zoom = "2"; const st = document.createElement("style"); st.textContent = ${JSON.stringify(hidePayer)}; document.head.appendChild(st); });`,
  );
  const desk = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } },
  });
  // The dashboard's text is small at 1080p; zoom it 1.5× for the video.
  await desk.addInitScript(
    `if (location.host.startsWith("handshake-web")) document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.zoom = "1.5"; document.body.style.paddingBottom = "400px"; });`,
  );
  phone.setDefaultTimeout(MIN);
  desk.setDefaultTimeout(MIN);
  const pages: Page[] = [];
  try {
    // Merchant: sign in and reset before anything is shown.
    console.log("• merchant: sign in, Reset demo");
    const shop = await desk.newPage();
    pages.push(shop);
    track(shop, "shop");
    shop.on("dialog", (d) => void d.accept());
    await shop.goto(`${WEB}/merchant`);
    await shop.locator("#t").fill(ADMIN);
    await shop.getByRole("button", { name: "Sign in" }).click();
    await shop.getByRole("heading", { name: /agent payments/ }).waitFor();
    await shop.getByRole("button", { name: "Reset demo" }).click();
    await shop.getByText(/^Demo reset: /).waitFor({ timeout: 2 * MIN });
    await shop.reload();
    await shop.getByRole("heading", { name: /agent payments/ }).waitFor();

    const passkey = new Passkey();
    const w = await phone.newPage();
    pages.push(w);
    track(w, "wallet");
    await passkey.attach(phone, w);

    await clip(
      w,
      {
        layout: "phone",
        maxSec: 5,
        title: "Handshake",
        caption: "Your AI agent shops. You approve with your passkey. PayPal moves the money.",
        hold: 2000,
      },
      async () => {
        await w.goto(`${WEB}/`);
        await w.locator("a.btn.block:not(.disabled)", { hasText: /wallet/i }).waitFor({ timeout: 3 * MIN });
      },
    );

    await clip(
      w,
      {
        layout: "phone",
        maxSec: 9,
        title: "Sign up with a passkey",
        caption: "Face ID or fingerprint on your phone (a virtual authenticator here). There is no password to steal.",
      },
      async () => {
        await w.locator("a.btn.block", { hasText: /wallet/i }).click();
        await w.locator("#name").fill("Maya");
        await passkey.use(w, async () => {
          await w.getByRole("button", { name: "Create passkey" }).click();
          await w.getByRole("heading", { name: /'s wallet$/ }).waitFor();
        });
        const addr = { name: "Maya Chen", line1: "1 Market St", city: "San Jose", postalCode: "95113", country: "US" };
        for (const [k, v] of Object.entries(addr)) await w.getByPlaceholder(k, { exact: true }).fill(v);
      },
    );

    const approveUrl = await clip(
      w,
      {
        layout: "phone",
        maxSec: 11,
        title: "Ask your agent",
        caption:
          "The agent finds the merchant and checks its signed offer against the trust registry. Prices come from the signed offer, never from the LLM.",
        hold: 2500,
      },
      async () => {
        await w.locator("textarea").fill(MESSAGE);
        await w.getByRole("button", { name: "Send" }).click();
        const link = w.getByRole("link", { name: "Open approval" });
        await link.first().waitFor({ timeout: 3 * MIN });
        await link.first().scrollIntoViewIfNeeded();
        return (await link.first().getAttribute("href")) ?? "";
      },
    );

    const ap = await phone.newPage();
    pages.push(ap);
    track(ap, "approval");
    await passkey.attach(phone, ap);
    await clip(
      ap,
      {
        layout: "phone",
        maxSec: 12,
        title: "Approve the exact cart",
        caption:
          "Your phone shows the merchant, every item, the total and the ship-to. Face ID signs a hash of exactly this cart: change one cent and the signature fails.",
        hold: 2500,
      },
      async () => {
        await ap.goto(approveUrl);
        await ap.getByText("✓ Verified merchant").waitFor();
        await ap.waitForTimeout(3500);
        await passkey.use(ap, async () => {
          await ap.locator("button.btn.block").click();
          await ap.getByText("Approved. Payment held until delivery.").waitFor();
        });
      },
    );

    const ppLink = w.getByRole("link", { name: "Open PayPal" });
    await ppLink.first().waitFor({ timeout: 3 * MIN });
    const paypalUrl = (await ppLink.first().getAttribute("href")) ?? "";
    if (!new URL(paypalUrl).host.endsWith("sandbox.paypal.com")) throw new Error("PayPal link isn't sandbox");
    // Same browser as the wallet: D31 binds the saved wallet only for the browser that approved.
    const pp = await phone.newPage();
    pages.push(pp);
    track(pp, "paypal");
    await clip(
      pp,
      {
        layout: "phone",
        maxSec: 10,
        blur: true,
        title: "First purchase: PayPal (sandbox)",
        caption:
          "PayPal authorizes and holds the money. Nothing is taken until the order is fulfilled. (Login blurred.)",
        hold: 1000,
      },
      async () => {
        await pp.goto(paypalUrl);
        await paypalBuyer(pp, BUYER_EMAIL, BUYER_PASSWORD);
        await pp.getByText(/^PayPal approved\./).waitFor({ timeout: 2 * MIN });
      },
    );

    await w.bringToFront();
    await w.getByText(/^Held: /).waitFor({ timeout: 3 * MIN });
    await w.reload();
    await clip(
      w,
      {
        layout: "phone",
        maxSec: 7,
        title: "Money held, payer confirmed",
        caption:
          "Confirm the PayPal payer with your passkey once. Later purchases use the saved PayPal wallet, with no redirect.",
        hold: 2000,
      },
      async () => {
        const b = w.getByRole("button", { name: "Confirm with passkey" });
        await b.scrollIntoViewIfNeeded();
        await passkey.use(w, async () => {
          await b.click();
          await w.locator(".pill.ok", { hasText: "Confirmed" }).waitFor();
        });
      },
    );

    await shop.bringToFront();
    await shop.reload();
    await shop.getByRole("heading", { name: /agent payments/ }).waitFor();
    await clip(
      shop,
      {
        layout: "desk",
        maxSec: 9,
        title: "Merchant: fulfil, then capture",
        caption:
          "The merchant captures only after fulfilment. A failed delivery or an expired hold voids the authorization.",
        hold: 2500,
      },
      async () => {
        await shop.getByRole("button", { name: "Fulfil & capture" }).click({ timeout: 2 * MIN });
        await shop
          .locator(".pill.ok", { hasText: "Paid" })
          .first()
          .waitFor({ timeout: 2 * MIN });
      },
    );

    await clip(
      shop,
      {
        layout: "desk",
        maxSec: 8,
        title: "Every check, logged live",
        caption:
          "Every request lands here live with the gate's decision. Signatures, cart = offer, passkey, nonce and risk are checked in order; a failure names its check.",
        hold: 6500,
      },
      async () => {
        await shop.getByRole("heading", { name: "Incoming requests" }).scrollIntoViewIfNeeded();
      },
    );

    await w.bringToFront();
    w.on("dialog", (d) => void d.accept());
    await clip(
      w,
      {
        layout: "phone",
        maxSec: 8,
        title: "Spending permission",
        caption: "Set limits once, signed with your passkey: per order, per month, chosen merchant and categories.",
        hold: 2000,
      },
      async () => {
        await w.getByText("New permission").scrollIntoViewIfNeeded();
        await w.getByText("New permission").click();
        await passkey.use(w, async () => {
          await w.getByRole("button", { name: "Approve with passkey" }).click();
          await w.getByRole("button", { name: "Revoke" }).waitFor();
        });
      },
    );

    await clip(
      w,
      {
        layout: "phone",
        maxSec: 10,
        title: "No approval step needed",
        caption:
          "A small purchase inside the permission goes straight through. The merchant re-checks every limit itself.",
        hold: 2500,
      },
      async () => {
        await w.locator("textarea").scrollIntoViewIfNeeded();
        await w.locator("textarea").fill(MESSAGE);
        await w.getByRole("button", { name: "Send" }).click();
        await w.getByText("Covered by your spending permission").waitFor({ timeout: 3 * MIN });
        await w
          .getByText(/^Held: /)
          .last()
          .waitFor({ timeout: 3 * MIN });
        await w
          .getByText(/^Held: /)
          .last()
          .scrollIntoViewIfNeeded();
        if ((await w.getByRole("link", { name: "Open approval" }).count()) > 1) throw new Error("asked for approval");
      },
    );

    await shop.bringToFront();
    await shop.reload();
    await shop.getByRole("heading", { name: /agent payments/ }).waitFor();
    await clip(
      shop,
      {
        layout: "desk",
        maxSec: 6,
        title: "Captured through PayPal",
        caption: "Money moves only through PayPal: authorize, capture on fulfilment, void on failure.",
        hold: 2000,
      },
      async () => {
        await shop.getByRole("button", { name: "Fulfil & capture" }).click({ timeout: 2 * MIN });
        await shop
          .locator(".pill.ok", { hasText: "Paid" })
          .first()
          .waitFor({ timeout: 2 * MIN });
      },
    );

    const panel = shop.locator(".card", { has: shop.getByRole("heading", { name: "Attack demo" }) });
    await panel.scrollIntoViewIfNeeded();
    const attacks = [
      {
        label: "Amount changed after approval",
        title: "Attack 1: amount changed after approval",
        caption: "The cart no longer matches the hash you signed with Face ID. Blocked before PayPal is called.",
      },
      {
        label: "Fake merchant agent",
        title: "Attack 2: fake merchant agent",
        caption:
          "An impostor signs its own offer. Its key isn't the registered merchant's, so the signature check fails.",
      },
      {
        label: "Replayed approval",
        title: "Attack 3: replayed approval",
        caption: "Re-sending an approval that was already used. Every offer and nonce works exactly once.",
      },
    ];
    for (const a of attacks) {
      await clip(shop, { layout: "desk", maxSec: 8, title: a.title, caption: a.caption, hold: 3500 }, async () => {
        const before = await panel.locator(".banner.bad").count();
        await panel.getByRole("button", { name: a.label }).click();
        await panel
          .locator(".banner.bad")
          .nth(before)
          .waitFor({ timeout: 2 * MIN });
      });
    }

    const assistant = shop.locator(".card", { has: shop.getByRole("heading", { name: "Shopkeeper assistant" }) });
    await assistant.scrollIntoViewIfNeeded();
    await clip(
      shop,
      {
        layout: "desk",
        maxSec: 13,
        title: "Shopkeeper assistant",
        caption:
          "Built on PayPal Agent Toolkit, read-only. It explains orders and can propose a refund, but only the merchant can confirm it.",
        hold: 6000,
      },
      async () => {
        // The live LLM occasionally fails; ask again (up to twice) rather than film the error.
        for (let attempt = 0; ; attempt++) {
          await assistant.locator("textarea").fill("In two short sentences, no table: what happened with today's orders at PayPal?");
          await assistant.getByRole("button", { name: "Ask" }).click();
          // Errors render in the same .md box; wait until the request is done, then read it.
          await assistant.locator(".md").first().waitFor({ timeout: 2 * MIN });
          await assistant.getByRole("button", { name: "Ask" }).and(shop.locator(":enabled")).waitFor({ timeout: 2 * MIN });
          const text = (await assistant.locator(".md").first().textContent()) ?? "";
          if (!/unavailable right now|went wrong/i.test(text)) break;
          if (attempt >= 2) throw new Error("assistant unavailable three times");
          await shop.waitForTimeout(5000);
        }
        await assistant.evaluate((el) => el.scrollIntoView({ block: "start" }));
      },
    );
  } catch (e) {
    for (const [i, p] of pages.entries()) await p.screenshot({ path: `${RAW}/fail-${i}.png` }).catch(() => {});
    throw e;
  } finally {
    const videos = pages.map((p) => ({ name: born.get(p)?.name, v: p.video() }));
    await phone.close();
    await desk.close();
    for (const { name, v } of videos) if (name && v) await v.saveAs(`${RAW}/${name}.webm`);
    await browser.close();
    writeFileSync(`${RAW}/segments.json`, JSON.stringify(segments, null, 2));
  }
  console.log(`recorded ${segments.length} segments`);
}

// ---------------------------------------------------------------- build

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONT = `font-family:'Segoe UI',system-ui,sans-serif;`;
const CARD = (body: string) => `<html><body style="margin:0;width:1920px;height:1080px;${FONT}
  background:linear-gradient(135deg,#0b1f3a,#123a6b);color:#fff;display:flex;align-items:center;justify-content:center">
  <div style="max-width:1500px;text-align:center">${body}</div></body></html>`;

function overlayHtml(s: Segment): string {
  if (s.layout === "phone") {
    return `<html><body style="margin:0;width:1920px;height:1080px;${FONT}background:linear-gradient(135deg,#0b1f3a,#123a6b);color:#fff">
      <div style="position:absolute;left:820px;top:0;width:980px;height:1080px;display:flex;flex-direction:column;justify-content:center">
        <div style="font-size:30px;letter-spacing:4px;color:#7fb3ff;text-transform:uppercase">On your phone</div>
        <div style="font-size:64px;font-weight:700;margin:16px 0 28px">${esc(s.title)}</div>
        <div style="font-size:42px;line-height:1.35;color:#e6eefc">${esc(s.caption)}</div>
      </div></body></html>`;
  }
  return `<html><body style="margin:0;width:1920px;height:1080px;background:transparent;${FONT}">
    <div style="position:absolute;left:0;right:0;bottom:0;padding:26px 60px 30px;background:rgba(8,20,40,.88);color:#fff">
      <div style="font-size:42px;font-weight:700">${esc(s.title)}</div>
      <div style="font-size:34px;line-height:1.3;margin-top:6px;color:#e6eefc">${esc(s.caption)}</div>
    </div></body></html>`;
}

const ff = (args: string[]) => {
  if (!ffmpegPath) throw new Error("ffmpeg-static has no binary for this platform");
  execFileSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
};
const X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-an"];

async function build(): Promise<void> {
  const segments = JSON.parse(readFileSync(`${RAW}/segments.json`, "utf8")) as Segment[];
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const png = async (html: string, file: string, transparent = false) => {
    await page.setContent(html);
    await page.screenshot({ path: file, omitBackground: transparent });
  };

  const parts: { file: string; sec: number; title: string; caption: string }[] = [];
  const card = async (name: string, html: string, sec: number, title: string, caption: string) => {
    await png(html, `${BUILD}/${name}.png`);
    ff(["-loop", "1", "-t", String(sec), "-i", `${BUILD}/${name}.png`, ...X264, `${BUILD}/${name}.mp4`]);
    parts.push({ file: `${name}.mp4`, sec, title, caption });
  };

  await card(
    "00-title",
    CARD(`<div style="font-size:54px;line-height:1.35;font-style:italic">${esc(QUOTE)}</div>
      <div style="font-size:30px;margin-top:36px;color:#a9c7f5">— ${esc(QUOTE_BY)}</div>
      <div style="font-size:46px;font-weight:700;margin-top:70px">Handshake is that validation, working today on PayPal.</div>`),
    6,
    "Title card",
    `${QUOTE} — ${QUOTE_BY}. Handshake is that validation, working today on PayPal.`,
  );

  for (const [i, s] of segments.entries()) {
    const name = `${String(i + 1).padStart(2, "0")}-seg`;
    await png(overlayHtml(s), `${BUILD}/${name}.png`, s.layout === "desk");
    const raw = s.end - s.start;
    const speed = Math.max(1, raw / s.maxSec);
    const sec = raw / speed + 1.2;
    const cut = `trim=start=${s.start.toFixed(2)}:end=${s.end.toFixed(2)},setpts=(PTS-STARTPTS)/${speed.toFixed(3)},fps=30,tpad=stop_mode=clone:stop_duration=1.2`;
    const filter =
      s.layout === "phone"
        ? `[0:v]${cut},scale=-2:1000${s.blur ? ",gblur=sigma=5" : ""}[p];[1:v][p]overlay=x=300:y=40:shortest=1,format=yuv420p`
        : `[0:v]${cut},scale=1920:1080${s.blur ? ",gblur=sigma=7" : ""}[v];[v][1:v]overlay=0:0:shortest=1,format=yuv420p`;
    ff([
      "-i",
      `${RAW}/${s.video}.webm`,
      "-loop",
      "1",
      "-i",
      `${BUILD}/${name}.png`,
      "-filter_complex",
      filter,
      ...X264,
      `${BUILD}/${name}.mp4`,
    ]);
    parts.push({ file: `${name}.mp4`, sec, title: s.title, caption: s.caption });
  }

  await card(
    "90-results",
    CARD(`<div style="font-size:34px;letter-spacing:4px;color:#7fb3ff;text-transform:uppercase">Adversarial eval · pnpm attack</div>
      <div style="font-size:84px;font-weight:700;margin-top:28px">96/96 attacks blocked</div>
      <div style="font-size:56px;margin-top:20px">0 unauthorized payments · 0 duplicate charges</div>
      <div style="font-size:32px;margin-top:40px;color:#a9c7f5">Each case starts from a valid signed request and changes one thing: amount, payee, signature, replay, limits, prompt injection…</div>`),
    6,
    "Results card",
    "96/96 attacks blocked · 0 unauthorized payments · 0 duplicate charges",
  );
  await card(
    "99-closing",
    CARD(`<div style="font-size:120px;font-weight:800">Handshake</div>
      <div style="font-size:52px;line-height:1.35;margin-top:24px">${esc(PITCH)}</div>
      <div style="font-size:40px;margin-top:56px;color:#a9c7f5">handshake-web-debi.onrender.com · PayPal sandbox</div>`),
    6,
    "Closing card",
    `${PITCH} handshake-web-debi.onrender.com`,
  );
  await browser.close();

  writeFileSync(`${BUILD}/list.txt`, parts.map((p) => `file '${p.file}'`).join("\n"));
  const out = `${DEMO}/handshake-demo.mp4`;
  ff(["-f", "concat", "-safe", "0", "-i", `${BUILD}/list.txt`, "-c", "copy", "-movflags", "+faststart", out]);

  const total = parts.reduce((t, p) => t + p.sec, 0);
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  let t = 0;
  const rows = parts.map((p) => {
    const row = `| ${mmss(t)} | ${mmss(t + p.sec)} | ${p.title} | ${p.caption.replace(/\|/g, "\\|")} |`;
    t += p.sec;
    return row;
  });
  writeFileSync(
    `${DEMO}/SHOTLIST.md`,
    [
      "# Demo video shot list",
      "",
      "Generated by `pnpm --filter @handshake/e2e demo-video build` from the recorded run; timestamps are",
      `for \`demo/handshake-demo.mp4\` (1920×1080, 30 fps, no audio, ${mmss(total)} total). Captions are burned in.`,
      "",
      "| Start | End | Scene | Caption |",
      "|---|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
  );

  const frames = `${DEMO}/frames`;
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  ff(["-i", out, "-vf", "fps=1/10,scale=960:-2", `${frames}/f%03d.png`]);
  console.log(
    `built ${out}: ${parts.length} parts, ${total.toFixed(1)} s; ${readdirSync(frames).length} frames in demo/frames/`,
  );
}

const mode = process.argv[2];
if (mode === "record") await record();
else if (mode === "build") await build();
else throw new Error("usage: demo-video record|build");
