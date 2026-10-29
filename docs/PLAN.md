# Build plan

Rule: one milestone per `/milestone` run. Tick boxes only when the acceptance check passes.
Deadline: submit by **Wed 11 Nov evening IST** (hard deadline 13 Nov 01:30 IST). Gnani AI also closes 10 Nov — decide priority.

## M0 Scaffold + spikes — Thu 29 Oct  (SPEC §2, §7.2)
- [x] pnpm workspace, tsconfig base (strict), eslint + prettier, vitest, `.env.example`, root scripts from CLAUDE.md
- [x] Neon project with `main` + `dev` branches; Prisma schema skeleton in `packages/db` using `url = env("DATABASE_URL")` and `directUrl = env("DIRECT_URL")`; first migration runs against `dev`
- [x] `pnpm paypal:smoke`: OAuth token + create/authorize/void one sandbox order
- [x] Vault spike result written to `docs/PAYPAL.md` + `docs/DECISIONS.md`
- [x] Passkey hello-world deployed on Render HTTPS and tested on phone
Accept: smoke script prints order id + VOIDED; passkey login works on phone.

## M1 Core library — Fri 30 Oct  (SPEC §3, §4)
- [x] `jcs.ts` (RFC 8785) with RFC test vectors
- [x] `hash`, Ed25519 `sign/verify`, signed envelope helpers
- [x] zod schemas for Offer, IntentMandate, CartApproval, PaymentRequest, Receipt
- [x] `errors.ts` with every code in SPEC §6 + `HandshakeError`
Accept: ≥25 unit tests pass; tampering any field breaks verification.

## M2 PayPal client — Sat 31 Oct  (SPEC §7, docs/PAYPAL.md)
- [x] token cache, `createOrderAuthorize`, `capture`, `void`, `refund`, `addTracking`
- [x] `PayPal-Request-Id` on every POST; decimal-string conversion at boundary only
- [x] Webhook verify + dedupe + DEMO_MODE simulator: code and tests with recorded/mocked PayPal events
- [x] order state machine with transition tests
Accept: mocked-fetch tests + sandbox smoke pass.

## M3 Passkeys — Sun 1 Nov  (SPEC §4.3, §6 step 6a)
- [x] fake authenticator test helper (P-256) in `packages/core/test`
- [x] tests: UV missing, signCount rollback, wrong origin, wrong challenge
Accept: all negative tests fail closed (real phone approval moved to M8).

## M4 Mandates — Mon 2 Nov  (SPEC §4.2, §6 step 6b)
- [x] create mandate with passkey; store payload, hash, assertion
- [x] scope + per-order + period checks; `mandate_spend` ledger (transactional)
Accept: split-order attack blocked.

## M5 Merchant agent — Tue 3 Nov  (SPEC §4.1, §10)
- [x] seed catalog + registry; agent card; `POST /offers` signs offer, holds stock
- [x] Mandate merchants checked against the registry: `/mandates/options` rejects unknown/inactive merchant ids and returns their display names for the wallet to show
- [x] offer expiry job releases holds
- [ ] Live sandbox webhook delivered to the deployed merchant service (moved from M2)
  1. Deploy the merchant service to Render
  2. Register its `https://<host>/webhooks/paypal` URL in the PayPal sandbox app (Webhooks → Add)
  3. Put the webhook id in Render's env as `PAYPAL_WEBHOOK_ID`
  4. Trigger a sandbox capture (`pnpm paypal:smoke --capture`)
  5. Confirm the `PAYMENT.CAPTURE.COMPLETED` event is stored once in `paypal_events` (verification SUCCESS, no duplicate row)
Accept: offer verifies with core; tampered offer rejected.

## M6 Consumer agent — Wed 4 Nov  (SPEC §5.2, §8)
- [ ] LLM tool loop (discover, get offer, verify offer, decide path, request approval, pay)
- [ ] step-up: approval record + phone page URL + wait
- [ ] M5 follow-ups: sign offer requests (D18) with `CONSUMER_AGENT_PRIVATE_KEY`; trust keys/ids from the registry, never the agent card; product names in offers reach the LLM only as delimited untrusted text
- [ ] policy in code decides mandate vs step-up
Accept: chat request ends in a receipt; LLM cannot change amounts (test).

## M7 Merchant gate + settlement — Thu 5 Nov  (SPEC §6, §7.1)
- [ ] gate steps 1–9 in order, each writing a decision
- [ ] risk inspector (rules + LLM, escalate-only)
- [ ] fulfil → capture → tracking; failure/expiry → void; receipt chain
- [ ] Single `verifyPaymentRequest(req, ctx)` wrapper that runs every gate check in SPEC §6 order; route handlers call only this
- [ ] Payee binding: `offer.merchantAgentId`, `merchantId` and `paypalMerchantId` must equal this merchant's own configured ids, else `OFFER_SIG_INVALID`
- [ ] M2 follow-ups: `onOrderEvent` refuses to fulfil/capture/refund on `meta.simulated` events; reconciliation table for webhook state conflicts (D15); one stored `PayPal-Request-Id` per order + operation; partial refund vs full and `PAYMENT.CAPTURE.REVERSED` tracking; rate-limit `/webhooks/paypal` + cheap pre-checks before verify
- [ ] M3 follow-ups: gate 6a uses core `verifyApprovalAssertion` against `registry_passkeys` and compare-and-sets its `signCount`; step 7 records the payload nonce atomically before any PayPal call (synced passkeys always report 0, so the nonce is the only replay guard); attack test for a replayed passkey approval
- [ ] M5 follow-ups (D18): gate's offer CAS is `open → used` only while `holdUntil > now`; `used_nonces` keyed by (`kid`, `type`, `nonce`) with cleanup by `exp`; re-check this merchant's registry status per request (or short-TTL cache) instead of only at startup
- [ ] M4 follow-ups (D17): ledger flow `checkMandateScope` → `reserve` → nonce → order `pending_authorization` with its `periodStart` → commit → PayPal outside the tx → on failure void + `release` in the order-state CAS tx (once per order); `periodStart` from the gate clock, never `cart.iat`; mandate proof re-checked with `verifyMandateApproval(…, { fresh: false })`; map unknown-mandate FK errors to `MANDATE_INVALID`
Accept: happy path end-to-end in sandbox.

## M8 Web UI — Fri 6 Nov
- [ ] wallet (passkey setup, mandates, activity), phone approval page showing exact cart
- [ ] register/authenticate endpoints; challenge = `hash(payload)` (moved from M3)
- [ ] `GET /mandates/:id` renders the mandate from server state (as approvals do) so the human approves what was stored, not what the client drew; mandate revocation (status `revoked`, checked by the gate)
- [ ] merchant dashboard: live SSE feed of agents, decisions, PayPal states
- [ ] shopkeeper assistant panel via `@paypal/agent-toolkit` (confirm before acting)
Accept: full demo runs from the UI on laptop + phone.

## M9 Attack suite + eval — Sat 7 Nov  (SPEC §11)
- [ ] ≥50 cases covering every SPEC §11 item; `pnpm attack` prints table
- [ ] `docs/EVAL.md` generated with counts and per-attack result
Accept: 0 unauthorized authorizations, 0 duplicate charges.

## M10 Polish — Sun 8 Nov
- [ ] demo seed script, reset button, simulate-webhook button
- [ ] error messages human-readable on dashboard
- [ ] Low findings: `signEnvelope` runtime type check, bound `holdUntil` (≤ 15 min from `iat`), generic error messages in HTTP responses (detail only in decisions log)
- [ ] M3 low findings: rate-limit `/passkeys/register/options` (each call inserts a user row) or create the user only on verify; map an approval that expires mid-verify to `APPROVAL_EXPIRED` instead of `APPROVAL_REPLAY`

## M11 Ship — Mon 9 Nov
- [ ] Render deploy (3 services) pointing at the Neon `main` branch; migrations applied there; health checks
- [ ] README (problem, architecture diagram, setup, sandbox creds, "what changed", AI tools used), MIT LICENSE
- [ ] `/ship-check` passes

## M12 Video + submit — Tue 10 – Wed 11 Nov
- [ ] record per SPEC §12, upload public YouTube, < 3 min
- [ ] Devpost form; submit; screenshot confirmation

## Stretch (only if ahead)
- [ ] merchant exposes MCP server; consumer agent calls it as MCP client
- [ ] disputes API evidence pack
