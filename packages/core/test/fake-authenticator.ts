// Test-only software passkey (P-256 / ES256). Builds WebAuthn responses by hand so tests can
// break exactly one property at a time: UV, UP, signCount, origin, rpId, challenge, signature.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { WebAuthnAssertion } from "../src/schemas.js";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

// Minimal CBOR (RFC 8949): unsigned/negative ints, byte strings, text strings, maps.
type Cbor = number | Uint8Array | string | Map<Cbor, Cbor>;
function cborHead(major: number, n: number): Buffer {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) return Buffer.from([m | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = m | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  const parts = [cborHead(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

export interface AssertOptions {
  /** User verification flag (default true). */
  uv?: boolean;
  /** User presence flag (default true). */
  up?: boolean;
  /** Force the reported sign count (e.g. a rollback). */
  signCount?: number;
  origin?: string;
  rpId?: string;
  type?: string;
  /** Sign over this challenge instead of the one asked for. */
  challenge?: string;
  /** Flip one bit of the signature. */
  tamperSignature?: boolean;
  /** Sign with a different key than the registered one. */
  signWith?: KeyObject;
  crossOrigin?: boolean;
}

export class FakeAuthenticator {
  readonly credentialId = b64url(randomBytes(16));
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private count = 0;

  /**
   * @param counting false models a synced passkey that always reports signCount 0.
   */
  constructor(
    readonly rpId: string,
    readonly origin: string,
    readonly counting = true,
  ) {}

  /** COSE_Key for the public key (EC2, ES256), base64url — what the server stores. */
  get publicKeyCose(): string {
    return b64url(this.coseKey());
  }

  get signCount(): number {
    return this.count;
  }

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }

  private authData(rpId: string, flags: number, signCount: number, attested?: Buffer): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, ...(attested ? [attested] : [])]);
  }

  /** navigator.credentials.create() result for "none" attestation, in the JSON form browsers send. */
  register(challenge: string, opts: { uv?: boolean; origin?: string; rpId?: string } = {}) {
    const credId = Buffer.from(this.credentialId, "base64url");
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(credId.length);
    const attested = Buffer.concat([Buffer.alloc(16) /* aaguid */, idLen, credId, this.coseKey()]);
    const flags = 0x01 | (opts.uv === false ? 0 : 0x04) | 0x40; // UP | UV | AT
    const authData = this.authData(opts.rpId ?? this.rpId, flags, 0, attested);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge, origin: opts.origin ?? this.origin });
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: b64url(Buffer.from(clientDataJSON)),
        attestationObject: b64url(attestationObject),
        transports: ["internal" as const],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() result over `challenge` (base64url), as our WebAuthnAssertion. */
  assert(challenge: string, opts: AssertOptions = {}): WebAuthnAssertion {
    if (opts.signCount === undefined && this.counting) this.count += 1;
    const signCount = opts.signCount ?? (this.counting ? this.count : 0);
    const flags = (opts.up === false ? 0 : 0x01) | (opts.uv === false ? 0 : 0x04);
    const authData = this.authData(opts.rpId ?? this.rpId, flags, signCount);
    const clientData = {
      type: opts.type ?? "webauthn.get",
      challenge: opts.challenge ?? challenge,
      origin: opts.origin ?? this.origin,
      ...(opts.crossOrigin === undefined ? {} : { crossOrigin: opts.crossOrigin }),
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData));
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      opts.signWith ?? this.keys.privateKey,
    );
    if (opts.tamperSignature) signature[signature.length - 1]! ^= 0x01;
    return {
      credentialId: this.credentialId,
      authenticatorData: b64url(authData),
      clientDataJSON: b64url(clientDataJSON),
      signature: b64url(signature),
    };
  }

  /** The assertion in the AuthenticationResponseJSON shape a browser posts. */
  assertJSON(challenge: string, opts: AssertOptions = {}) {
    const a = this.assert(challenge, opts);
    return {
      id: a.credentialId,
      rawId: a.credentialId,
      type: "public-key" as const,
      response: { authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON, signature: a.signature },
      clientExtensionResults: {},
    };
  }
}
