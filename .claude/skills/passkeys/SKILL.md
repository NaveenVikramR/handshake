---
name: passkeys
description: How passkey (WebAuthn) registration and cart-bound approvals work in Handshake, including the fake authenticator for tests. Use when touching passkeys, approvals or mandates.
paths:
  - "services/consumer/**"
  - "apps/web/**"
  - "packages/core/**"
---

# Passkeys in Handshake

Libraries: `@simplewebauthn/server` (services), `@simplewebauthn/browser` (web).

## Binding approval to the payload
- Challenge for an approval = `hash(payload)` from packages/core (base64url SHA-256 of JCS). Pass it as the `challenge` option to `generateAuthenticationOptions`.
- Store the payload server-side keyed by approval id. On verify, recompute `hash(payload)` and pass it as `expectedChallenge`. Never trust a challenge sent back by the client.
- The merchant re-verifies the same assertion independently using the public key from `registry_passkeys` — it does not trust the consumer service.

## Required checks
`userVerification: "required"` · UV flag set · `expectedOrigin` = `WEBAUTHN_ORIGIN` · `expectedRPID` = `WEBAUTHN_RP_ID` · new signCount > stored (or both 0 for platform authenticators that don't count — record which) · approval `exp` ≤ 5 min · nonce unused.

## Phone UX
The approval page shows merchant name, every item with qty and price, total, ship-to and expiry — the exact fields in the hashed payload — then a single "Approve with Face ID" button.

## Tests: fake authenticator
`packages/core/test/fake-authenticator.ts` generates a P-256 key pair and builds an assertion by hand:
- `clientDataJSON = {"type":"webauthn.get","challenge":<b64url>,"origin":<origin>}`
- `authenticatorData = SHA-256(rpId) ‖ flags(UP|UV = 0x05) ‖ signCount(4 bytes BE)`
- `signature = ECDSA-P256-SHA256(authenticatorData ‖ SHA-256(clientDataJSON))`, DER-encoded
Options let a test drop UV, roll back signCount, change origin or challenge — one negative test per option.

## Local dev
WebAuthn works on `http://localhost`; phones need HTTPS — test on the Render deploy (M0). Chrome DevTools → WebAuthn tab offers a virtual authenticator for desktop testing.
