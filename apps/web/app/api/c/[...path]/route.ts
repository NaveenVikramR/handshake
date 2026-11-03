// Wallet → consumer service. Allow-listed paths only; the session token lives in an httpOnly cookie
// set here on login and is added as the bearer server-side.
import { SESSION_COOKIE, cookieHeader, env, forward, readCookie } from "../../../../lib/server";

export const dynamic = "force-dynamic";

const ALLOWED: [string, RegExp][] = [
  ["POST", /^passkeys\/register\/(options|verify)$/],
  ["POST", /^passkeys\/login\/(options|verify)$/],
  ["GET", /^me$/],
  ["POST", /^logout$/],
  ["GET", /^mandates$/],
  ["POST", /^mandates\/(options|verify)$/],
  ["GET", /^mandates\/man_[A-Za-z0-9_-]{22}$/],
  ["POST", /^mandates\/man_[A-Za-z0-9_-]{22}\/revoke$/],
  ["GET", /^activity$/],
  ["GET", /^wallet\/paypal$/],
  ["POST", /^wallet\/paypal\/confirm$/],
  ["POST", /^chat$/],
  ["GET", /^approvals\/apr_[A-Za-z0-9_-]{22}$/],
  ["POST", /^approvals\/apr_[A-Za-z0-9_-]{22}\/verify$/],
];

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const path = (await ctx.params).path.join("/");
  if (!ALLOWED.some(([m, re]) => m === req.method && re.test(path))) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const token = readCookie(req, SESSION_COOKIE);
  const up = await forward(
    `${env("CONSUMER_URL").replace(/\/$/, "")}/${path}`,
    req,
    token ? { authorization: `Bearer ${token}` } : {},
  );

  if (path === "passkeys/login/verify" && up.status === 200) {
    // Keep the token out of page JS: cookie it, and return the rest.
    const body = (await new Response(up.body).json()) as { token: string; userId: string; expiresAt: number };
    const maxAge = Math.max(0, Math.floor((body.expiresAt - Date.now()) / 1000));
    return Response.json(
      { userId: body.userId, expiresAt: body.expiresAt },
      { headers: { "set-cookie": cookieHeader(SESSION_COOKIE, body.token, maxAge) } },
    );
  }
  const headers: Record<string, string> = { "content-type": up.contentType, "cache-control": "no-store" };
  if (path === "logout" || up.status === 401) headers["set-cookie"] = cookieHeader(SESSION_COOKIE, "", 0);
  return new Response(up.body, { status: up.status, headers });
}

export { handle as GET, handle as POST };
