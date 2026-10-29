// SPEC §10: POST /mandates/options builds the mandate and returns WebAuthn options whose
// challenge is hash(mandate); POST /mandates/verify activates it with the passkey assertion.
import { approvalChallenge, isHandshakeError } from "@handshake/core";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import express, { Router, type Response } from "express";
import { z } from "zod";
import { parseAssertionBody } from "../assertion-body.js";
import type { AppContext } from "../context.js";
import { MANDATE_SIGN_WINDOW_MS, MandateRequest, activateMandate, createMandate } from "./service.js";

const MandateId = z.string().regex(/^man_[A-Za-z0-9_-]{22}$/);

function sendError(res: Response, e: unknown): void {
  if (isHandshakeError(e)) return void res.status(e.status).json({ error: e.code });
  throw e;
}

export function mandateRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(express.json({ limit: "32kb" }));

  router.post("/mandates/options", async (req, res) => {
    const body = MandateRequest.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      const { mandateId, mandate, hash } = await createMandate(ctx, body.data);
      const credentials = await ctx.store.listCredentials(mandate.userId);
      const options = await generateAuthenticationOptions({
        rpID: ctx.webauthn.rpId,
        challenge: approvalChallenge(mandate),
        userVerification: "required",
        timeout: MANDATE_SIGN_WINDOW_MS,
        allowCredentials: credentials.map((c) => ({
          id: c.credentialId,
          transports: c.transports as ("internal" | "hybrid" | "usb" | "nfc" | "ble")[],
        })),
      });
      if (options.challenge !== hash) throw new Error("challenge does not equal hash(mandate)");
      // The wallet shows exactly these fields before the human approves.
      res.json({ mandateId, mandate, options });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post("/mandates/verify", async (req, res) => {
    const id = MandateId.safeParse((req.body as { mandateId?: unknown } | undefined)?.mandateId);
    const assertion = parseAssertionBody(req.body);
    if (!id.success || !assertion) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      await activateMandate(ctx, id.data, assertion);
      res.json({ mandateId: id.data, status: "active" });
    } catch (e) {
      sendError(res, e);
    }
  });

  return router;
}
