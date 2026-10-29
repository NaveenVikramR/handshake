// Phone approval API (SPEC §10): GET shows the exact cart plus WebAuthn options whose
// challenge is hash(cart); POST verifies the passkey assertion. The approval id is an
// unguessable capability (128 random bits) carried in the phone link.
import { approvalChallenge, isHandshakeError } from "@handshake/core";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import express, { Router, type Response } from "express";
import { z } from "zod";
import { parseAssertionBody } from "../assertion-body.js";
import type { AppContext } from "../context.js";
import { loadPendingApproval, verifyApproval } from "./service.js";

const ApprovalId = z.string().regex(/^apr_[A-Za-z0-9_-]{22}$/);
// Only the code goes back to the client; the reason stays in our logs.
function sendError(res: Response, e: unknown): void {
  if (isHandshakeError(e)) return void res.status(e.status).json({ error: e.code });
  throw e;
}

export function approvalRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(express.json({ limit: "32kb" }));

  router.get("/approvals/:id", async (req, res) => {
    const id = ApprovalId.safeParse(req.params.id);
    if (!id.success) return void res.status(404).json({ error: "APPROVAL_INVALID" });
    try {
      const approval = await loadPendingApproval(ctx, id.data);
      const credentials = await ctx.store.listCredentials(approval.userId);
      const options = await generateAuthenticationOptions({
        rpID: ctx.webauthn.rpId,
        challenge: approvalChallenge(approval.payload),
        userVerification: "required",
        timeout: Math.max(0, Math.min(approval.expiresAt - ctx.now(), 5 * 60_000)),
        allowCredentials: credentials.map((c) => ({
          id: c.credentialId,
          transports: c.transports as ("internal" | "hybrid" | "usb" | "nfc" | "ble")[],
        })),
      });
      if (options.challenge !== approval.hash) throw new Error("challenge does not equal hash(cart)");
      // Everything the human approves is exactly what was hashed.
      res.json({
        id: approval.id,
        status: approval.status,
        expiresAt: approval.expiresAt,
        cart: approval.payload,
        options,
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post("/approvals/:id/verify", async (req, res) => {
    const id = ApprovalId.safeParse(req.params.id);
    if (!id.success) return void res.status(404).json({ error: "APPROVAL_INVALID" });
    const assertion = parseAssertionBody(req.body);
    if (!assertion) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      await verifyApproval(ctx, id.data, assertion);
      res.json({ id: id.data, status: "approved" });
    } catch (e) {
      sendError(res, e);
    }
  });

  return router;
}
