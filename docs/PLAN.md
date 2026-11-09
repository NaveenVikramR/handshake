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
- [x] Live sandbox webhook delivered to the deployed merchant service (moved from M2)
  1. Deploy the merchant service to Render
  2. Register its `https://<host>/webhooks/paypal` URL in the PayPal sandbox app (Webhooks → Add)
  3. Put the webhook id in Render's env as `PAYPAL_WEBHOOK_ID`
  4. Trigger a sandbox capture (`pnpm paypal:smoke --capture`)
  5. Confirm the `PAYMENT.CAPTURE.COMPLETED` event is stored once in `paypal_events` (verification SUCCESS, no duplicate row)
Accept: offer verifies with core; tampered offer rejected.

## M6 Consumer agent — Wed 4 Nov  (SPEC §5.2, §8)
- [x] LLM tool loop (discover, get offer, verify offer, decide path, request approval, pay)
- [x] step-up: approval record + phone page URL + wait
- [x] M5 follow-ups: sign offer requests (D18) with `CONSUMER_AGENT_PRIVATE_KEY`; trust keys/ids from the registry, never the agent card; product names in offers reach the LLM only as delimited untrusted text
- [x] policy in code decides mandate vs step-up
Accept: chat request ends in a receipt; LLM cannot change amounts (test).

## M7 Merchant gate + settlement — Thu 5 Nov  (SPEC §6, §7.1)
- [x] gate steps 1–9 in order, each writing a decision
- [x] risk inspector (rules + LLM, escalate-only)
- [x] fulfil → capture → tracking; failure/expiry → void; receipt chain
- [x] Single `verifyPaymentRequest(req, ctx)` wrapper that runs every gate check in SPEC §6 order; route handlers call only this
- [x] Payee binding: `offer.merchantAgentId`, `merchantId` and `paypalMerchantId` must equal this merchant's own configured ids, else `OFFER_SIG_INVALID`
- [x] M2 follow-ups: `onOrderEvent` refuses to fulfil/capture/refund on `meta.simulated` events; reconciliation table for webhook state conflicts (D15); one stored `PayPal-Request-Id` per order + operation; partial refund vs full and `PAYMENT.CAPTURE.REVERSED` tracking; rate-limit `/webhooks/paypal` + cheap pre-checks before verify
- [x] M3 follow-ups: gate 6a uses core `verifyApprovalAssertion` against `registry_passkeys` and compare-and-sets its `signCount`; step 7 records the payload nonce atomically before any PayPal call (synced passkeys always report 0, so the nonce is the only replay guard); attack test for a replayed passkey approval
- [x] M5 follow-ups (D18): gate's offer CAS is `open → used` only while `holdUntil > now`; `used_nonces` keyed by (`kid`, `type`, `nonce`) with cleanup by `exp`; re-check this merchant's registry status per request (or short-TTL cache) instead of only at startup
- [x] Agent final message reflects the real order state (authorized = 'payment approved, held until delivery'; captured = 'paid'); never say 'complete' before capture.
- [x] M6 follow-ups (D21): `POST /payments` accepts the M6 payment request, and a real chat ends in a gate-issued receipt (M6 proved it against a stub); categories for 6b from `products`, never the request; spend reserved atomically in the tx that marks the offer used; attack test: parallel chats splitting an order across the period limit
- [x] M4 follow-ups (D17): ledger flow `checkMandateScope` → `reserve` → nonce → order `pending_authorization` with its `periodStart` → commit → PayPal outside the tx → on failure void + `release` in the order-state CAS tx (once per order); `periodStart` from the gate clock, never `cart.iat`; mandate proof re-checked with `verifyMandateApproval(…, { fresh: false })`; map unknown-mandate FK errors to `MANDATE_INVALID`
- [x] Live sandbox end-to-end: chat → gate → PayPal approve (first time) → vault → fulfil → capture → tracking, with a real buyer approval (`pnpm sandbox:e2e`; order 0N199875LW8772338, capture 89U51688LY8647725 COMPLETED, 2026-11-03)
Accept: happy path end-to-end in sandbox.

## M8 Web UI — Fri 6 Nov
- [x] `GET /mandates/:id` renders the mandate from server state (as approvals do) so the human approves what was stored, not what the client drew; mandate revocation (status `revoked`, checked by the gate)
- [x] Saved-wallet payer check: before a vault id is used for agent payments, the wallet shows the PayPal payer (email) and the user confirms with a passkey; a later payer that differs is refused, so a phished approve link can't attach someone else's wallet (D22)
Accept: full demo runs from the UI on laptop + phone.

## M9 Attack suite + eval — Sat 7 Nov  (SPEC §11)
- [x] ≥50 cases covering every SPEC §11 item; `pnpm attack` prints table
- [x] `docs/EVAL.md` generated with counts and per-attack result
Accept: 0 unauthorized authorizations, 0 duplicate charges.

## M10 Polish — Sun 8 Nov
- [x] Render web service named `handshake-web` in render.yaml (serves apps/web at https://handshake-web-debi.onrender.com, Render's URL for it since the bare name was taken); the merchant's and consumer's `WEB_URL`/`WEBAUTHN_ORIGIN`/`WEBAUTHN_RP_ID` point there (moved from M8) (4 Nov: live at https://handshake-web-debi.onrender.com, D27; `/`, `/wallet`, `/merchant` 200, `/api/m/dashboard/recent` 401)
- [x] Render: all three services (`handshake-merchant`, `handshake-consumer`, `handshake-web`) deployed from render.yaml against Neon `dev`, health checks green, env set per the dashboard checklist (M11 switches them to `main`) (4 Nov: Blueprint synced with the origin values pinned in render.yaml; all three `/health` 200; full flow passed end to end)
- [x] register/authenticate endpoints; challenge = `hash(payload)` (moved from M3) (moved from M8) (4 Nov, `pnpm e2e:deployed` on Render, virtual passkey: sign-up, sign-in, cart approval and payer confirm accepted by both services)
- [x] wallet (passkey setup, mandates, activity), phone approval page showing exact cart (built in apps/web, API-tested and `next build` clean; tick after a browser + phone run on Render) (moved from M8) (4 Nov, `pnpm e2e:deployed` on Render, virtual passkey: approval page showed the verified merchant, exact cart and ship-to; Activity shows Paid; mandate creation not exercised by the run, API-tested)
- [x] merchant dashboard: live SSE feed of agents, decisions, PayPal states (built + API-tested; tick after a browser run) (moved from M8) (4 Nov, `pnpm e2e:deployed` on Render, virtual passkey: request Allowed, PayPal order Held → Paid with order and capture ids)
- [x] shopkeeper assistant panel via `@paypal/agent-toolkit` (confirm before acting) (built: read-only toolkit, refund proposals + confirm card, tested with a scripted model; tick after a live LLM run) (moved from M8) (4 Nov, `pnpm e2e:deployed` on Render, virtual passkey: live LLM answered a read-only status question correctly; no refund confirmed. Cosmetic: reply shows raw `**` markdown)
- [x] error messages human-readable on dashboard (gate and dashboard-action codes; test: every code has a line, none shows a code)
- [x] demo seed script, reset button, simulate-webhook button (built, D26: `pnpm demo:seed`, Reset demo + Simulate webhook on the dashboard, gated by DEMO_MODE + DEMO_DATABASE_HOST; unit-tested; tick after a run on Neon dev, which wipes its demo data) (4 Nov, `pnpm e2e:deployed` on Render, virtual passkey: Reset demo cleared the shop, Simulate webhook recorded then ignored the duplicate, order stayed Paid; `pnpm db:seed` ran on Neon dev; the local reset needs `DEMO_DATABASE_HOST` equal to the `DATABASE_URL` host)
- [x] M6 follow-ups: `deleteSession` (logout) and session revocation; mark a pending approval cancelled when its chat closes; pin each `MERCHANT_URL` to its `merchantId` and refuse duplicates (done in M8: logout, cancel on chat close; left: URL→merchantId pin) (moved from M8) (URL→merchantId pin and duplicate-claim refusal done in M10)
- [ ] M7 follow-ups (D22): opaque per-order token in PayPal return URLs instead of the request id, and rate-limit `/payments/:id/complete`; tracking-only retry for a captured order whose tracking call failed; void the authorization when a webhook reports a declined capture; `pnpm paypal:webhook` can't add `PAYMENT.CAPTURE.REVERSED` to the existing webhook (PATCH it, or re-create); confirm the REVERSED resource shape in `docs/PAYPAL.md` (done in M8: no request id in return URLs, `/complete` rate limit, tracking-only retry, webhook PATCH in `pnpm paypal:webhook` (run 4 Nov: all 8 event types subscribed), PAYPAL.md notes; left: void on webhook-declined capture, confirm REVERSED/REFUNDED and authorize-payer shapes in sandbox) (moved from M8) (M10: void on webhook-declined capture done; REFUNDED shape confirmed 9 Nov; left: confirm REVERSED, authorize-payer and void-after-decline shapes in sandbox)
- [x] M9 low finding (POST duplicate fixed in fix(m9), D25): `GET /payments/:requestId` still returns the receipt to anyone holding the request id; nothing calls it, so return status only or remove it (M10: status only)
- [x] Low findings: `signEnvelope` runtime type check, bound `holdUntil` (≤ 15 min from `iat`), generic error messages in HTTP responses (detail only in decisions log) (M10; HTTP errors were already code-only)
- [x] M6 low findings: `/passkeys/login/options` rate-limited per IP and user, pending challenges capped and expired rows swept, same response for unknown users; step-up requires an explicit `shipTo` (M10: per-user sliding window + web-edge per-client limit, decoy options for unknown users, expired challenges swept, step-up needs shipTo)
- [x] M3 low findings: rate-limit `/passkeys/register/options` (each call inserts a user row) or create the user only on verify; map an approval that expires mid-verify to `APPROVAL_EXPIRED` instead of `APPROVAL_REPLAY` (M10: web-edge rate limit + abandoned sign-ups swept instead of a migration; mid-verify expiry → APPROVAL_EXPIRED)
- [x] M8 low findings: throttle `GET /wallet/paypal` challenge rows (reuse a live one); consumer is publicly reachable on Render, so keep every route self-authenticating (moved from M8) (M10: /wallet/paypal shares the login challenge sweep; routes stay self-authenticating)
- [x] dashboard Attack demo panel (DEMO_MODE, D28): "Amount changed after approval", "Fake merchant agent", "Replayed approval" send real tampered requests through the live gate (consumer-signed, builders shared with tests/attacks); unit + DB tests, security review HIGH fixed
- [x] landing page at `/` wakes merchant + consumer via `/api/wake/:service` (their `/health`) with a progress bar, then links to Wallet and Merchant
- [x] shopkeeper assistant replies render markdown (bold, italic, code, lists) as React elements, no HTML from the model
- [x] `pnpm e2e:deployed` extended (9 Nov, passes on Render): spending permission approved with the passkey, a purchase it covers with no approval step, then captured; dashboard refund through the assistant's confirm card, with the sandbox's PAYMENT.CAPTURE.REFUNDED webhook verified and its shape recorded in PAYPAL.md; `pnpm --filter @handshake/e2e attack-demo` clicks the three attack buttons on Render
- [x] D29 review follow-ups (D31, 9 Nov): wallet binding needs the return URL's secret from the approving browser plus the owner's session; `bindVault` binds only the vault saved for that order; attack cases A94/A95; deployed, `pnpm attack` 96/96 and `e2e:deployed` pass. Open: confirm in sandbox that PayPal never shows the `return_url` to a non-approving browser (PAYPAL.md VERIFY; README known limitations)
- [ ] real-phone Face ID / fingerprint on https://handshake-web-debi.onrender.com: sign up, approve a cart, sign in again (the user; everything else in this flow is covered by `pnpm e2e:deployed`)

## M11 Ship — Mon 9 Nov
- [x] Judging deploy stays on Neon `dev` with `DEMO_MODE` on (D30: judges need Reset demo and the attack panel; no late database move)
- [ ] README (problem, architecture diagram, setup, sandbox creds, "what changed", AI tools used), MIT LICENSE
- [ ] `/ship-check` passes

## M12 Video + submit — Tue 10 – Wed 11 Nov
- [ ] record per SPEC §12, upload public YouTube, < 3 min
- [ ] Devpost form; submit; screenshot confirmation

## Stretch (only if ahead)
- [ ] merchant exposes MCP server; consumer agent calls it as MCP client
- [ ] disputes API evidence pack
