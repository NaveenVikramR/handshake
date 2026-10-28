---
paths:
  - "packages/core/**"
  - "services/consumer/src/passkeys/**"
---

# Crypto and passkey rules
- Hash and sign only `jcs(payload)` bytes. Use `hash()` / `signEnvelope()` / `verifyEnvelope()` from packages/core; never re-implement.
- Randomness: `crypto.randomBytes`. Never `Math.random`.
- Compare secrets with `crypto.timingSafeEqual` (equal-length buffers).
- base64url everywhere (no padding). Ed25519 keys: PKCS8 private, SPKI public.
- WebAuthn: `userVerification: "required"`, check UV flag, monotonic signCount, expected origin and rpId from env, challenge = `hash(payload)`.
- packages/core has no I/O, no env access, no logging. Pure functions + zod schemas only.
- Every new function gets a positive test and a tamper test.
