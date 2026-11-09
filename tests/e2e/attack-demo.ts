// `pnpm --filter @handshake/e2e attack-demo`: clicks the dashboard's three attack buttons on the
// deployed demo and prints each blocked row. Reads MERCHANT_ADMIN_TOKEN from .env; never prints it.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const WEB = (process.env.E2E_WEB_URL ?? "https://handshake-web-debi.onrender.com").replace(/\/$/, "");
const ADMIN = process.env.MERCHANT_ADMIN_TOKEN;
if (!ADMIN) throw new Error("set MERCHANT_ADMIN_TOKEN in .env");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(120_000);
  await page.goto(`${WEB}/merchant`);
  await page.locator("#t").fill(ADMIN);
  await page.getByRole("button", { name: "Sign in" }).click();
  const panel = page.locator(".card", { has: page.getByRole("heading", { name: "Attack demo" }) });
  for (const label of ["Amount changed after approval", "Fake merchant agent", "Replayed approval"]) {
    const before = await panel.locator(".banner.bad").count();
    await panel.getByRole("button", { name: label }).click();
    await panel.locator(".banner.bad").nth(before).waitFor();
    console.log((await panel.locator(".banner.bad").first().textContent())?.trim());
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${root}e2e-screenshots/attack-demo.png`, fullPage: true });
} finally {
  await browser.close();
}
