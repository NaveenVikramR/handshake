import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { acceptVerified, handlePayPalWebhook, type WebhookDeps } from "./handler.js";

// Signature verification needs the body byte-for-byte, so parse it ourselves.
const rawJson = express.raw({ type: "application/json", limit: "256kb" });

const SimulateBody = z.strictObject({
  // Optional so the demo can resend one event to show dedupe; the prefix keeps it apart from real PayPal ids.
  id: z
    .string()
    .regex(/^WH-SIM-[A-Za-z0-9-]{1,64}$/)
    .optional(),
  event_type: z.string().min(1).max(128),
  resource: z.object({ id: z.string().min(1) }).loose(),
});

export const DEMO_SECRET_HEADER = "x-demo-secret";
const MIN_DEMO_SECRET_LENGTH = 16;

function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface WebhookRouterOptions {
  demoMode: boolean;
  /** Required when demoMode is on; callers of the simulator send it in x-demo-secret. */
  demoSecret?: string;
}

export function webhookRouter<Tx>(deps: WebhookDeps<Tx>, opts: WebhookRouterOptions): Router {
  if (opts.demoMode && (opts.demoSecret ?? "").length < MIN_DEMO_SECRET_LENGTH) {
    throw new Error(`DEMO_MODE requires DEMO_SECRET of at least ${MIN_DEMO_SECRET_LENGTH} characters`);
  }
  const router = Router();

  router.post("/webhooks/paypal", rawJson, async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const result = await handlePayPalWebhook(deps, { headers: req.headers, rawBody });
    res.status(result.httpStatus).json({ outcome: result.outcome });
  });

  // DEMO_MODE only: inject an event without a PayPal signature. Not mounted otherwise,
  // and gated by a shared secret so a demo deployment can't be fed fake captures.
  if (opts.demoMode) {
    const demoSecret = opts.demoSecret ?? "";
    router.post("/webhooks/paypal/simulate", express.json({ limit: "64kb" }), async (req, res) => {
      if (!secretMatches(req.headers[DEMO_SECRET_HEADER], demoSecret)) {
        res.status(401).json({ outcome: "unauthorized" });
        return;
      }
      const parsed = SimulateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ outcome: "malformed" });
        return;
      }
      const { id = `WH-SIM-${randomUUID()}`, ...rest } = parsed.data;
      const event = { id, create_time: new Date().toISOString(), ...rest };
      const result = await acceptVerified(deps, JSON.stringify(event), { simulated: true }, deps.log);
      res.status(result.httpStatus).json({ outcome: result.outcome, eventId: event.id });
    });
  }

  return router;
}
