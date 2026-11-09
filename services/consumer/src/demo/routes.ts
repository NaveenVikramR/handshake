// POST /demo/attack/:kind (DEMO_MODE only): the dashboard's attack demo. Reached only through the web
// server's admin route, which adds the demo secret; mounted only when DEMO_MODE and DEMO_SECRET are set.
import { timingSafeEqual } from "node:crypto";
import { isHandshakeError } from "@handshake/core";
import { Router, type Response } from "express";
import type { AppContext } from "../context.js";
import { ATTACKS, runAttack, type AttackKind } from "./attacks.js";

/** Each attack holds one unit for the offer's hold; this keeps the agent well under its open-offer cap. */
const PER_WINDOW = 6;
const WINDOW_MS = 10 * 60_000;

function sendError(res: Response, e: unknown): void {
  if (isHandshakeError(e)) return void res.status(e.status).json({ error: e.code });
  throw e;
}

function secretMatches(given: unknown, secret: string): boolean {
  if (typeof given !== "string") return false;
  const [a, b] = [Buffer.from(given), Buffer.from(secret)];
  return a.length === b.length && timingSafeEqual(a, b);
}

export function demoRouter(ctx: AppContext, secret: string): Router {
  const router = Router();
  let hits: number[] = [];
  router.post("/demo/attack/:kind", async (req, res) => {
    if (!secretMatches(req.get("x-demo-secret"), secret)) return void res.status(401).json({ error: "UNAUTHENTICATED" });
    const kind = req.params.kind as AttackKind;
    if (!ATTACKS.includes(kind)) return void res.status(404).json({ error: "NOT_FOUND" });
    const now = ctx.now();
    hits = hits.filter((t) => now - t < WINDOW_MS);
    if (hits.length >= PER_WINDOW) return void res.status(429).json({ error: "RATE_LIMITED" });
    hits.push(now);
    try {
      res.json(await runAttack(ctx, kind));
    } catch (e) {
      sendError(res, e);
    }
  });
  return router;
}
