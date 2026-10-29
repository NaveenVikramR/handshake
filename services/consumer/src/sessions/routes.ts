// POST /passkeys/login/{options,verify} (D20).
import { approvalChallenge, isHandshakeError } from "@handshake/core";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import express, { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { parseAssertionBody } from "../assertion-body.js";
import type { AppContext } from "../context.js";
import { LOGIN_WINDOW_MS, finishLogin, sessionUser, startLogin } from "./service.js";

const UserId = z.string().regex(/^usr_[A-Za-z0-9_-]{22}$/);
const LoginId = z.string().regex(/^lgn_[A-Za-z0-9_-]{22}$/);

function sendError(res: Response, e: unknown): void {
  if (isHandshakeError(e)) return void res.status(e.status).json({ error: e.code });
  throw e;
}

/** Puts the signed-in user in `res.locals.userId`; 401 without a valid session. */
export function requireSession(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    const userId = await sessionUser(ctx, req.get("authorization"));
    if (!userId) return void res.status(401).json({ error: "UNAUTHENTICATED" });
    res.locals.userId = userId;
    next();
  };
}

export function sessionRouter(ctx: AppContext): Router {
  const router = Router();
  router.use("/passkeys/login", express.json({ limit: "32kb" }));

  router.post("/passkeys/login/options", async (req, res) => {
    const userId = UserId.safeParse((req.body as { userId?: unknown } | undefined)?.userId);
    if (!userId.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      const payload = await startLogin(ctx, userId.data);
      const credentials = await ctx.store.listCredentials(userId.data);
      const options = await generateAuthenticationOptions({
        rpID: ctx.webauthn.rpId,
        challenge: approvalChallenge(payload),
        userVerification: "required",
        timeout: LOGIN_WINDOW_MS,
        allowCredentials: credentials.map((c) => ({
          id: c.credentialId,
          transports: c.transports as ("internal" | "hybrid" | "usb" | "nfc" | "ble")[],
        })),
      });
      res.json({ loginId: payload.loginId, options });
    } catch (e) {
      sendError(res, e);
    }
  });

  router.post("/passkeys/login/verify", async (req, res) => {
    const loginId = LoginId.safeParse((req.body as { loginId?: unknown } | undefined)?.loginId);
    const assertion = parseAssertionBody(req.body);
    if (!loginId.success || !assertion) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      res.json(await finishLogin(ctx, loginId.data, assertion));
    } catch (e) {
      sendError(res, e);
    }
  });

  return router;
}
