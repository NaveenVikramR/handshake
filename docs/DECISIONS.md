# Decisions (append-only)

Format: `## D<n> — title (date)` then Context / Decision / Consequence, ≤6 lines.

## D1 — Passkeys, not custom face recognition (2026-10-28)
Context: need human-in-the-loop biometric approval. Decision: WebAuthn platform authenticator (Face ID / fingerprint / Windows Hello), userVerification required. Consequence: no biometric data leaves the device; phishing-resistant; needs HTTPS + real device for demo.

## D2 — Approval bound to cart hash (2026-10-28)
Decision: WebAuthn challenge = base64url(SHA-256(JCS(cartApproval))). Consequence: any change to amount/items/address/merchant after approval invalidates the signature; merchant verifies independently against the registry public key.

## D3 — JCS + Ed25519 for agent payloads (2026-10-28)
Decision: RFC 8785 canonical JSON, Ed25519 via node:crypto. Consequence: deterministic hashes across services; small, fast signatures.

## D4 — Authorize then capture (2026-10-28)
Decision: PayPal intent AUTHORIZE; capture only after fulfillment checks; void on failure. Consequence: money held, not taken, until trust + fulfillment confirmed.

## D5 — Trust registry as shared tables (2026-10-28)
Decision: registry tables in the shared Postgres, seeded by script; pitched as PayPal-operated in production. Consequence: simple for the hackathon; documented limitation.

## D6 — LLM is escalate-only (2026-10-28)
Decision: LLM output never sets amounts or grants approval; risk inspector can only return step-up or block. Consequence: prompt injection cannot cause an unauthorized payment.

## D8 — No Docker; Neon Postgres (2026-10-28)
Context: no Docker on the dev machine. Decision: hosted Neon Postgres, `dev` branch for local work and tests, `main` for the Render deploy; Prisma `directUrl` for migrations. Consequence: needs internet to run locally; keep the production branch alive through judging (1–15 Dec).

## D7 — Vault vs per-order approval (2026-10-29)
Result: vault spike **SUCCESS** in sandbox. The user approves on PayPal once (save-with-purchase: `attributes.vault { store_in_vault: ON_SUCCESS, usage_type: MERCHANT, customer_type: CONSUMER }`); the `/authorize` response returns the vault id with status VAULTED. Later `intent: AUTHORIZE` orders with `payment_source.paypal.vault_id` come back COMPLETED with the authorization already created — no redirect, no `stored_credential` needed. Decision: agent payments use the saved PayPal wallet (vault id stored per user, server-side only); the passkey approval of the cart hash is the per-order consent. Per-order PayPal approval stays as the fallback if a vault id is missing or revoked. Consequence: needs US sandbox accounts (an India-country Business account rejected USD); the vault id is a reusable payment credential — never log or expose it in full.

## D9 — Toolchain versions (2026-10-29)
Decision: Node 24 (current LTS; Node 22 is in maintenance), pnpm 10.34.9 pinned via `packageManager`, TypeScript 6.0.x (typescript-eslint 8 supports <6.1, so not TS 7), Prisma 7.10.1 (npm `latest` points at an 8.0 RC). Consequence: Render pins `NODE_VERSION=24`; revisit TS 7 when typescript-eslint supports it.

## D10 — Prisma 7 connection config (2026-10-29)
Context: Prisma 7 dropped `url`/`directUrl` from `schema.prisma`. Decision: `packages/db/prisma.config.ts` points the CLI (migrate) at `DIRECT_URL`; the runtime client uses the pooled `DATABASE_URL` through `@prisma/adapter-pg` (`createDb()`). Same intent as D8. Consequence: generated client lives in `packages/db/src/generated` (gitignored, regenerated on install).

## D11 — Passkey spike is a standalone app (2026-10-29)
Decision: `apps/passkey-hello` (Express, in-memory, runs `.ts` with Node's type stripping, no build) deployed via `render.yaml`; rpID/origin default to Render's `RENDER_EXTERNAL_URL`. Throwaway — the real approval flow goes in services/consumer (M3).

## D12 — Passkey sign counts from synced authenticators (2026-10-29)
Context: M0 passkey spike on Render HTTPS passed on desktop Chrome (Google Password Manager passkey) and on iPhone Safari (iCloud Keychain passkey): register + login verified with `userVerified: true`, and both reported `signCount: 0` on every login. Synced passkeys don't keep a counter. Decision: the M3 sign-count check accepts 0 → 0 (stored 0, new 0); if the stored count is above 0, the new count must be strictly greater — equal or lower is rejected as a possible cloned authenticator. Record per credential whether it has ever reported a non-zero count. Consequence: clone detection only works for authenticators that count (e.g. hardware keys); synced passkeys rely on UV + origin/rpId + one-time challenge instead.

## D13 — Identity binding and fail-closed canonicalization in core schemas (2026-10-29)
Decision: `SignedOffer` requires `kid === payload.merchantAgentId`; `PaymentRequest` requires `kid` to equal every approved `consumerAgentId` (cartApproval, or mandate + cart) and `mandate.userId === cart.userId`. Violations surface as `SCHEMA_INVALID` at gate step 1. JCS throws on anything that is not plain JSON (undefined values, NaN, lone surrogates, class instances) instead of dropping it; `Hash` accepts only the canonical base64url spelling. Consequence: a registered agent can't sign under another agent's identity or re-wrap someone else's approval; builders must omit optional keys rather than set them to `undefined`.
