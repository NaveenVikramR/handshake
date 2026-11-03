// SPEC §10: POST /payments, payment status/completion, and POST /orders/:id/fulfil (merchant admin).
import { timingSafeEqual } from "node:crypto";
import express, { Router, type RequestHandler } from "express";
import { z } from "zod";
import { PayPalApiError } from "../paypal/client.js";
import { OrderStateError, completePayment, fulfilOrder, handlePayment, paymentStatus } from "./settle.js";
import type { GateContext } from "./verify.js";

const RequestId = z.string().regex(/^req_[A-Za-z0-9_-]{1,64}$/);
const OrderId = z.string().regex(/^ord_[A-Za-z0-9_-]{1,64}$/);
const FulfilBody = z.strictObject({
  fulfilled: z.boolean(),
  trackingNumber: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
});

/** Bearer MERCHANT_ADMIN_TOKEN, compared in constant time. */
function requireAdmin(token: string): RequestHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req, res, next) => {
    const given = Buffer.from(req.get("authorization") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return void res.status(401).json({ error: "UNAUTHENTICATED" });
    }
    next();
  };
}

export function gateRouter(ctx: GateContext, opts: { adminToken: string }): Router {
  if (opts.adminToken.length < 24) throw new Error("MERCHANT_ADMIN_TOKEN must be at least 24 characters");
  const router = Router();

  router.post("/payments", express.json({ limit: "64kb" }), async (req, res) => {
    const r = await handlePayment(ctx, req.body);
    res.status(r.httpStatus).json(r.body);
  });

  router.get("/payments/:requestId", async (req, res) => {
    const id = RequestId.safeParse(req.params.requestId);
    if (!id.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    const r = await paymentStatus(ctx, id.data);
    res.status(r.httpStatus).json(r.body);
  });

  router.post("/payments/:requestId/complete", async (req, res) => {
    const id = RequestId.safeParse(req.params.requestId);
    if (!id.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    const r = await completePayment(ctx, id.data);
    res.status(r.httpStatus).json(r.body);
  });

  router.post("/orders/:id/fulfil", requireAdmin(opts.adminToken), express.json({ limit: "4kb" }), async (req, res) => {
    const id = OrderId.safeParse(req.params.id);
    const body = FulfilBody.safeParse(req.body);
    if (!id.success || !body.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      res.json(
        await fulfilOrder(ctx, id.data, {
          fulfilled: body.data.fulfilled,
          ...(body.data.trackingNumber ? { trackingNumber: body.data.trackingNumber } : {}),
        }),
      );
    } catch (e) {
      if (e instanceof OrderStateError) return void res.status(409).json({ error: "INVALID_ORDER_STATE" });
      if (e instanceof PayPalApiError) return void res.status(502).json({ error: "PAYPAL_ERROR" });
      throw e;
    }
  });

  return router;
}
