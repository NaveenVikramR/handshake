// Dashboard → merchant service. Admin paths need the signed admin cookie; the bearer token is added
// here and never reaches the browser. /paypal/return is public (PayPal sends the buyer back).
import {
  ADMIN_COOKIE,
  SESSION_COOKIE,
  adminSessionValid,
  clientIp,
  env,
  forward,
  limiter,
  readCookie,
} from "../../../../lib/server";

const returns = limiter(20, 60_000);

export const dynamic = "force-dynamic";

const PUBLIC: [string, RegExp][] = [["POST", /^paypal\/return$/]];
const ADMIN: [string, RegExp][] = [
  ["GET", /^dashboard\/(recent|stream)$/],
  ["POST", /^orders\/ord_[A-Za-z0-9_-]{1,64}\/(fulfil|refund)$/],
  ["POST", /^assistant$/],
];

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const path = (await ctx.params).path.join("/");
  const match = (list: [string, RegExp][]) => list.some(([m, re]) => m === req.method && re.test(path));
  const headers: Record<string, string> = {};
  if (match(ADMIN)) {
    const token = env("MERCHANT_ADMIN_TOKEN");
    if (!adminSessionValid(readCookie(req, ADMIN_COOKIE), token, Math.floor(Date.now() / 1000))) {
      return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    headers.authorization = `Bearer ${token}`;
  } else if (!match(PUBLIC)) {
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  } else if (path === "paypal/return") {
    if (!returns(clientIp(req))) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
    // Vouch for whose browser came back from PayPal (binds a saved wallet to its owner, D23).
    const token = (await req.clone().json().catch(() => ({}))) as { token?: unknown };
    const session = readCookie(req, SESSION_COOKIE);
    let walletUserId: string | undefined;
    if (session) {
      const me = await fetch(`${env("CONSUMER_URL").replace(/\/$/, "")}/me`, {
        headers: { authorization: `Bearer ${session}` },
        redirect: "error",
      }).catch(() => undefined);
      if (me?.ok) walletUserId = ((await me.json()) as { userId?: string }).userId;
    }
    const up = await fetch(`${env("MERCHANT_URL").replace(/\/$/, "")}/paypal/return`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env("MERCHANT_ADMIN_TOKEN")}` },
      body: JSON.stringify({ token: token.token, ...(walletUserId ? { walletUserId } : {}) }),
      redirect: "error",
    });
    return new Response(up.body, { status: up.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  const up = await forward(`${env("MERCHANT_URL").replace(/\/$/, "")}/${path}`, req, headers);
  return new Response(up.body, {
    status: up.status,
    headers: { "content-type": up.contentType, "cache-control": "no-store" },
  });
}

export { handle as GET, handle as POST };
