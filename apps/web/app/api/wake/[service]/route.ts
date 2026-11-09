// Landing page: wakes a free-tier service (Render sleeps them when idle) by asking for its /health.
// Only the two known services; the answer is up or not, nothing else from upstream.
import { clientIp, env, limiter } from "../../../../lib/server";

export const dynamic = "force-dynamic";

const wakes = limiter(30, 60_000);
const SERVICES: Record<string, string> = { merchant: "MERCHANT_URL", consumer: "CONSUMER_URL" };

export async function GET(req: Request, ctx: { params: Promise<{ service: string }> }): Promise<Response> {
  const name = SERVICES[(await ctx.params).service];
  if (!name) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!wakes(clientIp(req))) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });
  const up = await fetch(`${env(name).replace(/\/$/, "")}/health`, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(100_000),
  }).catch(() => undefined);
  return Response.json({ up: up?.ok === true }, { headers: { "cache-control": "no-store" } });
}
