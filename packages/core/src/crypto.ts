import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { jcsBytes } from "./jcs.js";

const B64URL = /^[A-Za-z0-9_-]*$/;
const ED25519_SIG_BYTES = 64;

export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

// Strict decode: Node silently skips invalid characters, so reject them and
// require the canonical (unpadded, round-tripping) encoding.
export function b64urlDecode(s: string): Buffer {
  if (!B64URL.test(s)) throw new TypeError("invalid base64url");
  const buf = Buffer.from(s, "base64url");
  if (buf.toString("base64url") !== s) throw new TypeError("non-canonical base64url");
  return buf;
}

export function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/** hash(x) = base64url(SHA-256(JCS(x))) — SPEC §3. */
export function hash(value: unknown): string {
  return b64urlEncode(sha256(jcsBytes(value)));
}

/** Constant-time comparison of two base64url strings (hashes, challenges). */
export function b64urlEqual(a: string, b: string): boolean {
  let ab: Buffer, bb: Buffer;
  try {
    ab = b64urlDecode(a);
    bb = b64urlDecode(b);
  } catch {
    return false;
  }
  return ab.length > 0 && ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 16 random bytes, base64url (22 chars). */
export function randomNonce(): string {
  return b64urlEncode(randomBytes(16));
}

export interface Ed25519KeyPair {
  /** PKCS8 DER, base64url. */
  privateKey: string;
  /** SPKI DER, base64url. */
  publicKey: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: b64urlEncode(privateKey.export({ format: "der", type: "pkcs8" })),
    publicKey: b64urlEncode(publicKey.export({ format: "der", type: "spki" })),
  };
}

function loadPrivateKey(pkcs8: string): KeyObject {
  const key = createPrivateKey({ key: b64urlDecode(pkcs8), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("not an Ed25519 private key");
  return key;
}

function loadPublicKey(spki: string): KeyObject {
  const key = createPublicKey({ key: b64urlDecode(spki), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("not an Ed25519 public key");
  return key;
}

/** The SPKI public key (base64url) for a PKCS8 private key, so a registry row can be checked against a configured key. */
export function publicKeyFromPrivate(pkcs8: string): string {
  return b64urlEncode(createPublicKey(loadPrivateKey(pkcs8)).export({ format: "der", type: "spki" }));
}

/** Ed25519 signature over JCS(payload), base64url. */
export function signPayload(payload: unknown, privateKey: string): string {
  return b64urlEncode(nodeSign(null, jcsBytes(payload), loadPrivateKey(privateKey)));
}

/** Fails closed: any malformed key, signature or payload returns false. */
export function verifyPayload(payload: unknown, sig: string, publicKey: string): boolean {
  try {
    const sigBytes = b64urlDecode(sig);
    if (sigBytes.length !== ED25519_SIG_BYTES) return false;
    return nodeVerify(null, jcsBytes(payload), loadPublicKey(publicKey), sigBytes);
  } catch {
    return false;
  }
}

export interface SignedEnvelope<P> {
  payload: P;
  sig: string;
  kid: string;
}

/** Payloads must carry a `type` so verifiers can enforce domain separation. */
export function signEnvelope<P extends { type: string }>(
  payload: P,
  privateKey: string,
  kid: string,
): SignedEnvelope<P> {
  return { payload, sig: signPayload(payload, privateKey), kid };
}

/**
 * Verifies the envelope signature against a registry key. The caller resolves
 * `publicKey` from the registry by `kid` and must pass the kid it looked up as
 * `expectedKid`, so an envelope cannot claim one identity and be checked
 * against another's key. `expectedType` gives domain separation: a valid
 * signature over a payload of any other `type` is rejected.
 */
export function verifyEnvelope(
  envelope: SignedEnvelope<unknown>,
  publicKey: string,
  expectedKid: string,
  expectedType: string,
): boolean {
  if (typeof envelope !== "object" || envelope === null) return false;
  if (typeof envelope.kid !== "string" || envelope.kid !== expectedKid) return false;
  if (typeof envelope.sig !== "string") return false;
  const payload: unknown = envelope.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  if ((payload as { type?: unknown }).type !== expectedType) return false;
  return verifyPayload(payload, envelope.sig, publicKey);
}
