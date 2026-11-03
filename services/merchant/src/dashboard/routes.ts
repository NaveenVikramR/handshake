// Merchant dashboard API (M8): recent gate runs and a live feed, refunds, and the shopkeeper
// assistant. Everything but /paypal/return needs the admin bearer token, which only the web app's
// server holds (an httpOnly cookie session, never page JS).
import { createHash, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { askAssistant, type AssistantDeps } from "../assistant/assistant.js";
import { requireAdmin } from "../gate/routes.js";
import { OrderStateError, completeByPayPalOrder, refundOrder } from "../gate/settle.js";
import type { RecentRequest } from "../gate/store.js";
import type { GateContext } from "../gate/verify.js";
import { PayPalApiError } from "../paypal/client.js";
import { rateLimiter } from "../webhooks/router.js";

const OrderId = z.string().regex(/^ord_[A-Za-z0-9_-]{1,64}$/);
const PayPalToken = z.string().regex(/^[A-Z0-9]{1,36}$/);
const FEED_POLL_MS = 2000;

/** What the dashboard row shows: the gate run, and the order with its PayPal ids if one exists. */
export function feedRow(r: RecentRequest) {
  const failed = r.decisions.find((d) => d.result === "fail");
  const o = r.order;
  return {
    requestId: r.requestId,
    at: r.at,
    outcome: failed
      ? failed.reason.startsWith("STEP_UP_REQUIRED")
        ? "step_up"
        : "blocked"
      : o
        ? "allowed"
        : "pending",
    failedCode: failed ? failed.reason.split(":")[0] : null,
    decisions: r.decisions,
    order: o && {
      orderId: o.id,
      userId: o.userId,
      status: o.status,
      path: o.path,
      totalMinor: o.totalMinor,
      currency: o.currency,
      paypalOrderId: o.paypalOrderId,
      authorizationId: o.authorizationId,
      captureId: o.captureId,
      trackingNumber: o.trackingNumber,
      awaitingPayPal: o.status === "offered" && Boolean(o.payerActionUrl),
    },
  };
}

export function dashboardRouter(ctx: GateContext, opts: { adminToken: string; assistant?: AssistantDeps }): Router {
  const router = Router();
  const admin = requireAdmin(opts.adminToken);
  const expected = Buffer.from(`Bearer ${opts.adminToken}`);
  const isAdmin = (req: express.Request) => {
    const given = Buffer.from(req.get("authorization") ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const returns = rateLimiter(30, 60_000);

  router.get("/dashboard/recent", admin, async (_req, res) => {
    res.json({ requests: (await ctx.store.listRecent(50)).map(feedRow) });
  });

  // SSE: a fresh snapshot whenever anything changed (polling the store keeps it right across instances).
  router.get("/dashboard/stream", admin, async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let last = "";
    let open = true;
    req.on("close", () => {
      open = false;
    });
    while (open) {
      try {
        const rows = (await ctx.store.listRecent(50)).map(feedRow);
        const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
        if (digest !== last) {
          last = digest;
          res.write(`event: snapshot\ndata: ${JSON.stringify({ requests: rows })}\n\n`);
        } else {
          res.write(": keep-alive\n\n");
        }
      } catch {
        res.write(`event: error\ndata: {"error":"FEED_UNAVAILABLE"}\n\n`);
      }
      await new Promise((r) => setTimeout(r, FEED_POLL_MS));
    }
    res.end();
  });

  // The shopkeeper pressed Confirm on a refund card.
  router.post("/orders/:id/refund", admin, async (req, res) => {
    const id = OrderId.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      res.json(await refundOrder(ctx, id.data));
    } catch (e) {
      if (e instanceof OrderStateError) return void res.status(409).json({ error: "INVALID_ORDER_STATE" });
      if (e instanceof PayPalApiError) return void res.status(502).json({ error: "PAYPAL_ERROR" });
      throw e;
    }
  });

  router.post("/assistant", admin, express.json({ limit: "8kb" }), async (req, res) => {
    const message = z.strictObject({ message: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!message.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    if (!opts.assistant) return void res.status(503).json({ error: "ASSISTANT_UNAVAILABLE" });
    try {
      res.json(await askAssistant(opts.assistant, message.data.message, ctx.log));
    } catch {
      res.status(502).json({ error: "ASSISTANT_UNAVAILABLE" });
    }
  });

  // The buyer is back from PayPal (?token=<PayPal order id>): finish, returning only the status.
  router.post("/paypal/return", express.json({ limit: "1kb" }), async (req, res) => {
    // The web server (admin bearer) rate-limits per browser itself; direct callers are limited here.
    if (!isAdmin(req) && !returns(req.ip ?? "unknown")) return void res.status(429).json({ error: "RATE_LIMITED" });
    const body = req.body as { token?: unknown; walletUserId?: unknown } | undefined;
    const token = PayPalToken.safeParse(body?.token);
    if (!token.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    // Only the web server (admin bearer) may say whose browser this is.
    const vouched = isAdmin(req) && typeof body?.walletUserId === "string" ? body.walletUserId : undefined;
    try {
      res.json(await completeByPayPalOrder(ctx, token.data, vouched));
    } catch (e) {
      if (e instanceof PayPalApiError) return void res.json({ status: "failed" });
      throw e;
    }
  });

  return router;
}
