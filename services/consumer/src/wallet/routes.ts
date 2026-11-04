// Wallet API for the web app (M8), all for the signed-in user only: who am I, mandates with spend,
// a mandate rendered from server state, revocation, activity, logout, and confirming the PayPal
// account a saved wallet belongs to (D22) with a passkey.
import { randomBytes } from "node:crypto";
import {
  HandshakeError,
  approvalChallenge,
  b64urlEncode,
  isHandshakeError,
  periodStart,
  randomNonce,
  verifyApprovalAssertion,
} from "@handshake/core";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import express, { Router, type Response } from "express";
import { z } from "zod";
import { parseAssertionBody } from "../assertion-body.js";
import type { AppContext } from "../context.js";
import { requireSession } from "../sessions/routes.js";
import { MAX_PENDING_LOGINS, tokenHash } from "../sessions/service.js";

const MandateId = z.string().regex(/^man_[A-Za-z0-9_-]{22}$/);
const LinkId = z.string().regex(/^plk_[A-Za-z0-9_-]{22}$/);
const LINK_WINDOW_MS = 2 * 60_000;

function sendError(res: Response, e: unknown): void {
  if (isHandshakeError(e)) return void res.status(e.status).json({ error: e.code });
  throw e;
}

async function authOptions(ctx: AppContext, userId: string, payload: unknown, timeout: number) {
  const credentials = await ctx.store.listCredentials(userId);
  return generateAuthenticationOptions({
    rpID: ctx.webauthn.rpId,
    challenge: approvalChallenge(payload),
    userVerification: "required",
    timeout,
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as ("internal" | "hybrid" | "usb" | "nfc" | "ble")[],
    })),
  });
}

async function merchantNames(ctx: AppContext, ids: string[]) {
  const rows = await ctx.store.getMerchants([...new Set(ids)]);
  return new Map(rows.map((m) => [m.id, { name: m.name, verified: m.status === "active" }]));
}

export function walletRouter(ctx: AppContext): Router {
  const router = Router();
  const session = requireSession(ctx);
  const json = express.json({ limit: "32kb" });
  const user = (res: Response) => res.locals.userId as string;

  router.get("/me", session, async (_req, res) => {
    const u = await ctx.store.getUser(user(res));
    if (!u) return void res.status(401).json({ error: "UNAUTHENTICATED" });
    const [creds, vault] = await Promise.all([ctx.store.listCredentials(u.id), ctx.store.getVault(u.id)]);
    res.json({
      userId: u.id,
      displayName: u.displayName,
      passkeys: creds.map((c) => ({ id: c.credentialId.slice(0, 10), transports: c.transports })),
      paypal: vault ? { status: vault.status, payerEmail: vault.payerEmail } : null,
    });
  });

  router.post("/logout", session, async (req, res) => {
    const token = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "")?.[1];
    if (token) await ctx.store.deleteSession(tokenHash(token));
    res.json({ ok: true });
  });

  router.get("/mandates", session, async (_req, res) => {
    const nowS = Math.floor(ctx.now() / 1000);
    const mandates = await ctx.store.listMandates(user(res));
    const names = await merchantNames(
      ctx,
      mandates.flatMap((m) => m.payload.scope.merchants),
    );
    const spentOf = ctx.agent?.spent;
    res.json({
      mandates: await Promise.all(
        mandates.map(async (m) => {
          const p = m.payload;
          const bucket = periodStart(p.limits.period, nowS);
          return {
            mandateId: m.id,
            status: m.status,
            scope: {
              merchants: p.scope.merchants.map((id) => ({ id, name: names.get(id)?.name ?? null })),
              categories: p.scope.categories,
            },
            limits: p.limits,
            spentMinor: spentOf && m.status === "active" ? await spentOf({ mandateId: m.id, periodStart: bucket }) : 0,
            periodStart: bucket,
            exp: p.exp,
          };
        }),
      ),
    });
  });

  // The mandate exactly as stored (and hashed), with WebAuthn options while it still awaits approval.
  router.get("/mandates/:id", session, async (req, res) => {
    const id = MandateId.safeParse(req.params.id);
    const m = id.success ? await ctx.store.getMandate(id.data) : undefined;
    if (!m || m.userId !== user(res)) return void res.status(404).json({ error: "MANDATE_INVALID" });
    const names = await merchantNames(ctx, m.payload.scope.merchants);
    const pending = m.status === "pending" && m.pendingUntil > ctx.now();
    res.json({
      mandateId: m.id,
      status: m.status,
      mandate: m.payload,
      merchants: m.payload.scope.merchants.map((mid) => ({
        id: mid,
        ...(names.get(mid) ?? { name: null, verified: false }),
      })),
      ...(pending
        ? {
            pendingUntil: m.pendingUntil,
            options: await authOptions(ctx, m.userId, m.payload, m.pendingUntil - ctx.now()),
          }
        : {}),
    });
  });

  // Revoking only ever removes permission, so the session is enough; the gate refuses non-active mandates.
  router.post("/mandates/:id/revoke", session, async (req, res) => {
    const id = MandateId.safeParse(req.params.id);
    if (!id.success || !(await ctx.store.revokeMandate(id.data, user(res)))) {
      return void res.status(404).json({ error: "MANDATE_INVALID" });
    }
    res.json({ mandateId: id.data, status: "revoked" });
  });

  router.get("/activity", session, async (_req, res) => {
    const rows = await ctx.store.listActivity(user(res));
    const names = await merchantNames(
      ctx,
      rows.flatMap((r) => (r.merchantId ? [r.merchantId] : [])),
    );
    res.json({
      activity: rows.map((r) => ({
        ...r,
        merchantName: r.merchantId ? (names.get(r.merchantId)?.name ?? null) : null,
      })),
    });
  });

  // Saved-wallet payer check: show which PayPal account was saved; the user confirms it with a passkey.
  router.get("/wallet/paypal", session, async (_req, res) => {
    const v = await ctx.store.getVault(user(res));
    if (!v) return void res.json({ status: "none" });
    if (v.status === "confirmed" || !v.payerId) return void res.json({ status: v.status, payerEmail: v.payerEmail });
    // Each view stores a challenge row: sweep expired ones and cap the live ones per user (M10).
    if ((await ctx.store.pruneLoginChallenges(user(res), ctx.now())) >= MAX_PENDING_LOGINS) {
      return void res.status(429).json({ error: "RATE_LIMITED" });
    }
    const iat = Math.floor(ctx.now() / 1000);
    const payload = {
      v: 1,
      type: "paypal_link",
      linkId: `plk_${b64urlEncode(randomBytes(16))}`,
      userId: user(res),
      payerId: v.payerId,
      payerEmail: v.payerEmail,
      vaultRef: v.vaultRef,
      iat,
      exp: iat + LINK_WINDOW_MS / 1000,
      nonce: randomNonce(),
    };
    await ctx.store.putLoginChallenge({
      id: payload.linkId,
      userId: payload.userId,
      payload,
      expiresAt: ctx.now() + LINK_WINDOW_MS,
    });
    res.json({
      status: "pending",
      payerEmail: v.payerEmail,
      linkId: payload.linkId,
      options: await authOptions(ctx, payload.userId, payload, LINK_WINDOW_MS),
    });
  });

  router.post("/wallet/paypal/confirm", session, json, async (req, res) => {
    const linkId = LinkId.safeParse((req.body as { linkId?: unknown } | undefined)?.linkId);
    const assertion = parseAssertionBody(req.body);
    if (!linkId.success || !assertion) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    try {
      const link = await ctx.store.takeLoginChallenge(linkId.data, ctx.now());
      const p = link?.payload as { type?: string; userId?: string; payerId?: string; vaultRef?: string } | undefined;
      if (!link || p?.type !== "paypal_link" || link.userId !== user(res) || !p.payerId || !p.vaultRef) {
        throw new HandshakeError("APPROVAL_EXPIRED", "confirmation expired or already used");
      }
      const cred = await ctx.store.getCredential(assertion.credentialId);
      if (!cred || cred.userId !== link.userId)
        throw new HandshakeError("APPROVAL_INVALID", "credential not registered to this user");
      const { newSignCount } = await verifyApprovalAssertion(link.payload, assertion, cred, {
        expectedOrigin: ctx.webauthn.origin,
        expectedRpId: ctx.webauthn.rpId,
      });
      if (!(await ctx.store.advanceWalletSignCount(cred.credentialId, cred.signCount, newSignCount))) {
        throw new HandshakeError("APPROVAL_REPLAY", "passkey used concurrently");
      }
      // Bound to the payer and vault the user was shown: a swap in between fails the CAS.
      if (!(await ctx.store.confirmVault(link.userId, p.payerId, p.vaultRef))) {
        throw new HandshakeError("APPROVAL_INVALID", "saved wallet changed; reload and confirm again");
      }
      res.json({ status: "confirmed" });
    } catch (e) {
      sendError(res, e);
    }
  });

  return router;
}
