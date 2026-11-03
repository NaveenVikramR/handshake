// Server-only helpers for the route handlers: upstream URLs, cookies, the admin session.
// The browser never sees the wallet session token or the merchant admin token.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "hs_session";
export const ADMIN_COOKIE = "hs_admin";
export const ADMIN_SESSION_S = 8 * 60 * 60;

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const secure = () => process.env.NODE_ENV === "production";

export function cookieHeader(name: string, value: string, maxAgeS: number): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeS}`,
    ...(secure() ? ["Secure"] : []),
  ].join("; ");
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const mac = (secret: string, exp: number) => createHmac("sha256", secret).update(`hs_admin:${exp}`).digest("base64url");

/** `${exp}.${hmac}`, keyed by the admin token itself: rotating the token signs everyone out. */
export function adminSessionValue(token: string, nowS: number): string {
  const exp = nowS + ADMIN_SESSION_S;
  return `${exp}.${mac(token, exp)}`;
}

export function adminSessionValid(value: string | undefined, token: string, nowS: number): boolean {
  if (!value) return false;
  const [expS, sig] = value.split(".");
  const exp = Number(expS);
  if (!Number.isSafeInteger(exp) || exp <= nowS || !sig) return false;
  const want = Buffer.from(mac(token, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Forwards to an upstream service, streaming the body back (SSE included). */
export async function forward(
  url: string,
  req: Request,
  headers: Record<string, string>,
): Promise<{ status: number; contentType: string; body: ReadableStream<Uint8Array> | null; text?: string }> {
  const method = req.method;
  // The browser closing the request (e.g. a chat) closes the upstream one too.
  const init: RequestInit = { method, headers: { ...headers }, redirect: "error", signal: req.signal };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await req.text();
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(url, init);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body: res.body };
}

/** The caller's IP as Render's proxy appended it: the last X-Forwarded-For hop (earlier ones are client-supplied). */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
}

/** Fixed window per key, in memory (one web instance). */
export function limiter(limit: number, windowMs: number) {
  const hits = new Map<string, { start: number; n: number }>();
  return (key: string): boolean => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { start: t, n: 1 });
      return true;
    }
    return ++h.n <= limit;
  };
}

