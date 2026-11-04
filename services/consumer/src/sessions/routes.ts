// POST /passkeys/login/{options,verify} (D20).
import { createHmac, randomBytes } from "node:crypto";
import { approvalChallenge, b64urlEncode, isHandshakeError } from "@handshake/core";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import express, { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { parseAssertionBody } from "../assertion-body.js";
import type { AppContext } from "../context.js";
import { LOGIN_WINDOW_MS, MAX_PENDING_LOGINS, finishLogin, sessionUser, startLogin } from "./service.js";

/**
 * A user without a passkey gets the same decoy credential id on every call, across restarts: it's
 * keyed by the consumer's configured agent key when there is one (M10).
 */
function decoyCredentials(ctx: AppContext) {
  const key = ctx.agent?.privateKey ? `login-decoy|${ctx.agent.privateKey}` : randomBytes(32);
  return (userId: string) => ({
    credentialId: b64urlEncode(createHmac("sha256", key).update(userId).digest()),
    transports: ["internal", "hybrid"] as ("internal" | "hybrid")[],
  });
}

/**
 * Sliding window per key, in memory: at most `limit` calls in any `windowMs`. With login challenges
 * living `windowMs`, no user (known or not) ever has more than `limit` live. The web edge limits per
 * client; this limits per user id.
 */
function perKeyLimit(limit: number, windowMs: number, now: () => number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    // Bound memory by dropping only stale keys: a flood of new ids can't reset anyone's window.
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((at) => t - at < windowMs)) hits.delete(k);
    hits.set(key, [...recent, t]);
    return true;
  };
}

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
  // Same limit for every user id, known or not, so the limit itself says nothing about who exists.
  const loginsPerUser = perKeyLimit(MAX_PENDING_LOGINS, LOGIN_WINDOW_MS, ctx.now);
  const decoyCredential = decoyCredentials(ctx);

  router.post("/passkeys/login/options", async (req, res) => {
    const userId = UserId.safeParse((req.body as { userId?: unknown } | undefined)?.userId);
    if (!userId.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    if (!loginsPerUser(userId.data)) return void res.status(429).json({ error: "RATE_LIMITED" });
    try {
      const { payload, known } = await startLogin(ctx, userId.data);
      const listed = await ctx.store.listCredentials(userId.data); // read for every id, like startLogin's
      const credentials = known ? listed : [decoyCredential(userId.data)];
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
