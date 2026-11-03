// POST {token} signs the shopkeeper in (signed httpOnly cookie, 8 h); DELETE signs out.
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_S,
  adminSessionValue,
  clientIp,
  cookieHeader,
  env,
  limiter,
  sameSecret,
} from "../../../lib/server";

const attempts = limiter(10, 15 * 60_000);

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!attempts(clientIp(req))) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { token?: unknown };
  const token = env("MERCHANT_ADMIN_TOKEN");
  if (typeof body.token !== "string" || !sameSecret(body.token, token)) {
    return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  return Response.json(
    { ok: true },
    {
      headers: {
        "set-cookie": cookieHeader(
          ADMIN_COOKIE,
          adminSessionValue(token, Math.floor(Date.now() / 1000)),
          ADMIN_SESSION_S,
        ),
      },
    },
  );
}

export async function DELETE(): Promise<Response> {
  return Response.json({ ok: true }, { headers: { "set-cookie": cookieHeader(ADMIN_COOKIE, "", 0) } });
}
