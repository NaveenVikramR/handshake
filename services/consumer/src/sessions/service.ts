// Wallet login (D20): a UV passkey assertion over hash(login payload) opens a 1-hour session.
// The same core verifier as cart approvals checks it (origin, rpId, UV, user binding, sign count).
import { randomBytes } from "node:crypto";
import {
  HandshakeError,
  b64urlEncode,
  randomNonce,
  sha256,
  verifyApprovalAssertion,
  type WebAuthnAssertion,
} from "@handshake/core";
import type { AppContext } from "../context.js";

export const LOGIN_WINDOW_MS = 2 * 60_000;
export const SESSION_TTL_MS = 60 * 60_000;

export interface LoginPayload {
  v: 1;
  type: "wallet_login";
  loginId: string;
  userId: string;
  iat: number;
  exp: number;
  nonce: string;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Sessions are looked up by this, never by the token itself. */
export const tokenHash = (token: string) => b64urlEncode(sha256(Buffer.from(token, "utf8")));

/** Starts a login for a user that has a passkey; the payload's hash is the WebAuthn challenge. */
export async function startLogin(ctx: AppContext, userId: string): Promise<LoginPayload> {
  if (!(await ctx.store.hasCredentials(userId))) throw new HandshakeError("APPROVAL_INVALID", "no passkey for user");
  const now = ctx.now();
  const iat = Math.floor(now / 1000);
  const payload: LoginPayload = {
    v: 1,
    type: "wallet_login",
    loginId: `lgn_${b64urlEncode(randomBytes(16))}`,
    userId,
    iat,
    exp: iat + LOGIN_WINDOW_MS / 1000,
    nonce: randomNonce(),
  };
  await ctx.store.putLoginChallenge({ id: payload.loginId, userId, payload, expiresAt: now + LOGIN_WINDOW_MS });
  return payload;
}

/** Verifies the login assertion once and issues a bearer token (returned once, stored only as a hash). */
export async function finishLogin(
  ctx: AppContext,
  loginId: string,
  assertion: WebAuthnAssertion,
): Promise<{ token: string; userId: string; expiresAt: number }> {
  // Taken (and deleted) first, so each login challenge can be tried once.
  const login = await ctx.store.takeLoginChallenge(loginId, ctx.now());
  if (!login) throw new HandshakeError("APPROVAL_EXPIRED", "login expired or already used");
  const credential = await ctx.store.getCredential(assertion.credentialId);
  if (!credential || credential.userId !== login.userId) {
    throw new HandshakeError("APPROVAL_INVALID", "credential not registered to this user");
  }
  const { newSignCount } = await verifyApprovalAssertion(login.payload, assertion, credential, {
    expectedOrigin: ctx.webauthn.origin,
    expectedRpId: ctx.webauthn.rpId,
  });
  if (!(await ctx.store.advanceWalletSignCount(credential.credentialId, credential.signCount, newSignCount))) {
    throw new HandshakeError("APPROVAL_REPLAY", "passkey used concurrently");
  }
  const token = b64urlEncode(randomBytes(32));
  const expiresAt = ctx.now() + SESSION_TTL_MS;
  await ctx.store.createSession({ tokenHash: tokenHash(token), userId: login.userId, expiresAt });
  return { token, userId: login.userId, expiresAt };
}

/** The signed-in user for an `Authorization: Bearer <token>` header, or undefined. */
export async function sessionUser(ctx: AppContext, authorization: string | undefined): Promise<string | undefined> {
  const m = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  if (!m?.[1] || !TOKEN.test(m[1])) return undefined;
  return ctx.store.getSessionUser(tokenHash(m[1]), ctx.now());
}
