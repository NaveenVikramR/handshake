// Passkey approval verification (SPEC §4.2–4.3, §6 step 6a). Shared by the consumer
// service and the merchant gate, which verify the same assertion independently.
// Our own checks run first so each failure maps to a precise code; the library then
// verifies the signature. Everything fails closed.
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { z } from "zod";
import { b64urlDecode, b64urlEqual, hash, sha256 } from "./crypto.js";
import { HandshakeError } from "./errors.js";
import type { WebAuthnAssertion } from "./schemas.js";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const AUTH_DATA_MIN_BYTES = 37; // rpIdHash(32) ‖ flags(1) ‖ signCount(4)

/** A registered passkey as one verifier last saw it. Each verifier keeps its own signCount (D16). */
export interface PasskeyCredential {
  credentialId: string;
  /** The user the credential is registered to; must equal payload.userId. */
  userId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  signCount: number;
}

export interface WebAuthnContext {
  expectedOrigin: string;
  expectedRpId: string;
}

/** challenge = hash(payload), as bytes: the library UTF-8-encodes string challenges, which would change it. */
export function approvalChallenge(payload: unknown): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b64urlDecode(hash(payload)));
}

const ClientData = z.object({
  type: z.string(),
  challenge: z.string(),
  origin: z.string(),
  crossOrigin: z.boolean().optional(),
});

function fail(code: "APPROVAL_INVALID" | "APPROVAL_UV_MISSING" | "CART_HASH_MISMATCH", reason: string): never {
  throw new HandshakeError(code, reason);
}

/**
 * Sign count rule (D12): an authenticator that has never counted reports 0 forever
 * (synced passkeys); once a count above 0 was seen it must strictly increase.
 */
export function signCountAcceptable(stored: number, reported: number): boolean {
  return stored === 0 ? true : reported > stored;
}

/**
 * Verifies that `assertion` approves exactly `payload` with `credential`, and that the
 * credential belongs to the user the payload names.
 * Returns the sign count the caller must store (compare-and-set against `credential.signCount`).
 *
 * Not replay protection on its own: synced passkeys report signCount 0 forever (D12), so the
 * same assertion verifies again. Callers must make the approval single-use: the wallet marks it
 * used; the merchant gate records the payload nonce atomically before any side effect (§6 step 7).
 */
export async function verifyApprovalAssertion(
  payload: unknown,
  assertion: WebAuthnAssertion,
  credential: PasskeyCredential,
  ctx: WebAuthnContext,
): Promise<{ newSignCount: number }> {
  if (assertion.credentialId !== credential.credentialId)
    fail("APPROVAL_INVALID", "assertion is for another credential");
  const payloadUser = (payload as { userId?: unknown } | null)?.userId;
  if (typeof payloadUser !== "string" || payloadUser !== credential.userId) {
    fail("APPROVAL_INVALID", "passkey is not registered to the user this payload names");
  }

  let clientDataBytes: Buffer, authData: Buffer;
  try {
    clientDataBytes = b64urlDecode(assertion.clientDataJSON);
    authData = b64urlDecode(assertion.authenticatorData);
    b64urlDecode(assertion.signature);
  } catch {
    fail("APPROVAL_INVALID", "assertion is not valid base64url");
  }

  let clientData: z.infer<typeof ClientData>;
  try {
    clientData = ClientData.parse(JSON.parse(clientDataBytes.toString("utf8")));
  } catch {
    fail("APPROVAL_INVALID", "clientDataJSON malformed");
  }
  if (clientData.type !== "webauthn.get") fail("APPROVAL_INVALID", "not an assertion");
  const expectedChallenge = hash(payload);
  if (!b64urlEqual(clientData.challenge, expectedChallenge))
    fail("CART_HASH_MISMATCH", "approval was for a different payload");
  if (clientData.origin !== ctx.expectedOrigin) fail("APPROVAL_INVALID", "wrong origin");
  if (clientData.crossOrigin === true) fail("APPROVAL_INVALID", "cross-origin assertion");

  if (authData.length < AUTH_DATA_MIN_BYTES) fail("APPROVAL_INVALID", "authenticatorData too short");
  if (!authData.subarray(0, 32).equals(sha256(Buffer.from(ctx.expectedRpId, "utf8")))) {
    fail("APPROVAL_INVALID", "wrong rpId");
  }
  const flags = authData[32]!;
  if ((flags & FLAG_UP) === 0) fail("APPROVAL_INVALID", "user not present");
  if ((flags & FLAG_UV) === 0) fail("APPROVAL_UV_MISSING", "user verification missing");
  const reported = authData.readUInt32BE(33);
  if (!signCountAcceptable(credential.signCount, reported)) {
    fail("APPROVAL_INVALID", "sign count did not increase (possible cloned authenticator)");
  }

  let verified: boolean;
  let newCounter: number;
  try {
    const result = await verifyAuthenticationResponse({
      response: {
        id: assertion.credentialId,
        rawId: assertion.credentialId,
        type: "public-key",
        response: {
          authenticatorData: assertion.authenticatorData,
          clientDataJSON: assertion.clientDataJSON,
          signature: assertion.signature,
        },
        clientExtensionResults: {},
      },
      expectedChallenge,
      expectedOrigin: ctx.expectedOrigin,
      expectedRPID: ctx.expectedRpId,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(b64urlDecode(credential.publicKey)),
        counter: credential.signCount,
      },
      requireUserVerification: true,
    });
    verified = result.verified && result.authenticationInfo.userVerified;
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    fail("APPROVAL_INVALID", "signature verification failed");
  }
  if (!verified || newCounter !== reported) fail("APPROVAL_INVALID", "signature verification failed");
  return { newSignCount: reported };
}
