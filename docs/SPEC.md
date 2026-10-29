# Handshake — Specification

Status: v1 (2026-10-28). Change by appending to `docs/DECISIONS.md` first, then editing here.

## 1. Goal and pitch
Personal AI agents will buy from merchant agents. Two things are missing today: proof that the human approved this exact payment, and proof that each agent is who it claims to be. Handshake provides both, and settles through PayPal authorize/capture so money is held until trust and fulfillment are confirmed.

Demo line: "Agents can shop for you, but only you can approve the payment — and every agent proves who it is."

Non-goals: real AP2 compliance (we are "AP2-inspired"), live money, real third-party agents, multi-merchant budgets across PSPs, mobile native apps.

## 2. Actors and components
| Actor | Lives in | Holds |
|---|---|---|
| User | browser / phone | passkey (platform authenticator) |
| Consumer agent | services/consumer | Ed25519 agent key, mandates, LLM planner |
| Merchant agent | services/merchant | Ed25519 agent key, catalog, offers, PayPal credentials |
| Trust registry | `registry_*` tables (pitched as "PayPal-operated in production") | agent public keys, merchant↔PayPal merchant id, user passkey public keys |
| PayPal | sandbox | orders, authorizations, captures, webhooks |

## 3. Canonical encoding, hashing, keys
- Canonical JSON: RFC 8785 (JCS). Implement in `packages/core/src/jcs.ts`; unit-test against the RFC examples.
- Hash: `hash(x) = base64url(SHA-256(JCS(x)))`.
- Agent signatures: Ed25519 over `JCS(payload)` bytes, base64url. Signed envelope = `{ payload, sig, kid }` where `kid` = agent id.
- Domain separation: every signed value carries a `type`. Verifiers name the type they expect and reject any other, so a signature over one payload type never verifies as another.
- Schemas check shape only (fields, types, ranges, totals that add up). Identity binding (who signed vs. who the payload names) is checked during signature verification and fails with the `*_SIG_INVALID` code for that signature.
- Every payload carries `v: 1`, `type`, `nonce` (16 random bytes b64url), `iat`, `exp` (unix seconds).
- Clock skew tolerance: 60 s.

## 4. Data formats
All amounts are integer minor units. Currency `USD` (sandbox).

### 4.1 Offer (signed by merchant agent)
```json
{ "v":1, "type":"offer", "offerId":"off_…", "merchantId":"mer_…", "merchantAgentId":"agt_m_…",
  "paypalMerchantId":"…", "items":[{"sku":"RICE-2KG","name":"Rice 2 kg","qty":1,"unitMinor":499}],
  "totalMinor":499, "currency":"USD", "holdUntil":1762000000, "iat":…, "exp":…, "nonce":"…" }
```
Merchant stores `offerHash`; stock is held until `holdUntil` (10 min). `totalMinor` > 0 and every `qty` > 0. An offer is rejected with `OFFER_EXPIRED` once `now` passes `exp` (+ skew) or `holdUntil`. The envelope `kid` must equal `merchantAgentId`, else `OFFER_SIG_INVALID`.

**Offer request** (`POST /offers`, signed by a consumer agent, D18): envelope `{payload, sig, kid}` over
`{ "v":1, "type":"offer_request", "consumerAgentId":"agt_c_…", "merchantId":"mer_…", "items":[{"sku":"RICE-2KG","qty":1}], "iat":…, "exp":…, "nonce":"…" }`
with `exp − iat` ≤ 120 s and unique skus. The request carries no prices: names and `unitMinor` come from `products`. Checks in order: shape → `SCHEMA_INVALID`; `kid` an active consumer agent in the registry → `AGENT_UNTRUSTED`; signature, `kid` = `consumerAgentId`, `merchantId` = this merchant, fresh → `AGENT_SIG_INVALID`; nonce unused → `APPROVAL_REPLAY`; `qty` ≤ 10 per line → `SCHEMA_INVALID`; per agent fewer than 20 open offers and at most 40 units held → `RATE_LIMITED`; known skus → `SCHEMA_INVALID`; stock for every line → `OUT_OF_STOCK`. Stock, nonce and offer are written in one transaction. The expiry job flips `open → expired` and returns stock once `now > holdUntil`; the gate (M7) flips `open → used`; both by compare-and-set, so a hold is released or consumed exactly once.

### 4.2 Intent mandate (standing permission, approved by passkey)
```json
{ "v":1, "type":"intent_mandate", "mandateId":"man_…", "userId":"usr_…", "consumerAgentId":"agt_c_…",
  "scope":{"merchants":["mer_…"],"categories":["grocery"]},
  "limits":{"perOrderMinor":3000,"periodMinor":8000,"period":"week"},
  "shipToHash":"…", "iat":…, "exp":…, "nonce":"…" }
```
Approval proof = WebAuthn assertion whose challenge = `hash(mandate)`.

### 4.3 Cart approval (per-purchase, human present)
```json
{ "v":1, "type":"cart_approval", "offerId":"off_…", "offerHash":"…", "merchantId":"mer_…",
  "items":[…same as offer…], "totalMinor":499, "currency":"USD", "shipToHash":"…",
  "consumerAgentId":"agt_c_…", "userId":"usr_…", "iat":…, "exp":…, "nonce":"…" }
```
Approval proof = WebAuthn assertion whose challenge = `hash(cartApproval)`. `exp` ≤ 5 min.

### 4.4 Payment request (consumer agent → merchant)
```json
{ "requestId":"req_…",
  "offer": { "payload":{…4.1…}, "sig":"…", "kid":"agt_m_…" },
  "authorization": { "kind":"passkey", "cartApproval":{…4.3…},
                     "assertion":{"credentialId":"…","authenticatorData":"…","clientDataJSON":"…","signature":"…"} }
               | { "kind":"mandate", "mandate":{…4.2…}, "assertion":{…}, "cart":{…4.3 without user approval…} },
  "agentSig": "…", "kid":"agt_c_…" }
```
`agentSig` = consumer agent Ed25519 over `JCS({type:"payment_request", v:1, requestId, offer, authorization})`. `kid` must equal every `consumerAgentId` the approval names (cartApproval, or mandate and cart), else `AGENT_SIG_INVALID`. On the mandate path `mandate.userId` must equal `cart.userId`, else `MANDATE_INVALID`.

### 4.5 Receipt (stored by merchant, returned to consumer)
`{ requestId, offerHash, approvalHash, paypalOrderId, authorizationId, captureId?, status, decisions[], trackingNumber? }`

## 5. Flows
### 5.1 Setup
1. User registers passkey (userVerification: `required`, residentKey: `preferred`). Public key → `registry_passkeys`.
2. User links PayPal (vault spike, §7.2). Fallback: per-order PayPal approval.
3. User creates a mandate in the wallet; passkey signs it.

### 5.2 Purchase
1. User: "2 kg rice and detergent, deliver Friday."
2. Consumer agent (LLM + tools) discovers merchant via `GET /.well-known/agent.json`, requests offer.
3. Consumer verifies offer signature against registry and `merchantId ↔ merchantAgentId ↔ paypalMerchantId`. Fails → `OFFER_SIG_INVALID` / `MERCHANT_UNTRUSTED`.
4. Policy (code): within mandate scope and limits → mandate path. Otherwise (over limit, new merchant, unusual category, risk flag) → step-up: create cart approval, notify phone page, wait for passkey.
5. Consumer sends payment request.
6. Merchant gate (§6) verifies, then PayPal authorize.
7. Fulfillment check passes → capture → add tracking → receipt. Fails or hold expires → void.

## 6. Merchant verification gate (order matters, fail closed)
| # | Check | Error |
|---|---|---|
| 1 | zod schema | `SCHEMA_INVALID` |
| 2 | `requestId` unseen (else return stored receipt) | `DUPLICATE_REQUEST` (200 with prior receipt) |
| 3 | consumer agent in registry, active; `agentSig` valid; `kid` = approved `consumerAgentId` | `AGENT_UNTRUSTED` / `AGENT_SIG_INVALID` |
| 4 | offer sig is ours (`kid` = `merchantAgentId`, type `offer`), unexpired and before `holdUntil`, unused, matches stored `offerHash` | `OFFER_SIG_INVALID` / `OFFER_EXPIRED` / `OFFER_USED` |
| 5 | cart items/total/currency exactly equal offer | `CART_MISMATCH` |
| 6a | passkey: recompute challenge from cartApproval; verify assertion vs registry key; UV flag set; signCount increases; origin/rpId match | `APPROVAL_INVALID` / `APPROVAL_UV_MISSING` / `CART_HASH_MISMATCH` |
| 6b | mandate: verify mandate assertion; merchant + category in scope; total ≤ perOrder; period spend + total ≤ periodMinor | `MANDATE_INVALID` / `MANDATE_SCOPE` / `MANDATE_LIMIT` |
| 7 | nonces unused; `exp` valid | `APPROVAL_REPLAY` / `APPROVAL_EXPIRED` |
| 8 | risk inspector (rules + LLM on free-text fields). May return `STEP_UP_REQUIRED` or `RISK_BLOCKED`, never "approve" | `STEP_UP_REQUIRED` / `RISK_BLOCKED` |
| 9 | PayPal create order (AUTHORIZE), `PayPal-Request-Id = requestId` | `PAYPAL_ERROR` |

Every decision is appended to `decisions[]` with check id, result and reason, and streamed to the dashboard.

Outside the gate, offer creation (§4.1) also returns `OUT_OF_STOCK` (409) and `RATE_LIMITED` (429).

## 7. PayPal
### 7.1 Order state machine (merchant)
`offered → authorized → captured → (refunded)`; `authorized → voided`; any → `failed`. Transitions only via webhook-confirmed or API-confirmed events. Store raw PayPal ids.
### 7.2 Vault spike (Day 1)
Goal: agent can pay without a PayPal approval redirect per order. Try Orders v2 PayPal-wallet vaulting in sandbox. Record result in `docs/PAYPAL.md` and `docs/DECISIONS.md`. Fallback: buyer approves each order on PayPal; passkey approval still bound to cart.
### 7.3 Webhooks
Verify via PayPal verify-webhook-signature; dedupe on event id (`paypal_events` table, unique). Provide a dev-only "simulate webhook" endpoint guarded by `DEMO_MODE=true`.

## 8. LLM roles
| Role | Can do | Cannot do |
|---|---|---|
| Consumer planner | parse request, pick items, compare offers, call tools | set amounts, skip approval, edit signed payloads |
| Merchant agent | answer catalog questions, explain offers | price items (prices come from DB) |
| Risk inspector | flag injection / anomalies → escalate | approve or lower risk |
| Shopkeeper assistant (Agent Toolkit) | list orders, explain decisions, propose refunds | execute refund without merchant confirm |

## 9. Database (Prisma, one Postgres)
`registry_agents(id, role, publicKey, status, merchantId?)`, `registry_merchants(id, name, paypalMerchantId, status)`, `registry_passkeys(credentialId, userId, publicKey, signCount, transports)`, `users`, `mandates(id, payloadJson, hash, assertionJson, status)`, `mandate_spend(mandateId, periodStart, spentMinor)`, `products(sku, name, category, priceMinor, stock)`, `offers(id, payloadJson, hash, status, holdUntil)`, `stock_holds(offerId, sku, qty)`, `payment_requests(requestId unique, receiptJson, status)`, `orders(id, paypalOrderId, authorizationId, captureId, status, totalMinor)`, `used_nonces(nonce unique, exp)`, `paypal_events(eventId unique, type, payloadJson)`, `decisions(requestId, step, result, reason, at)`.

## 10. HTTP API
Merchant :4001 — `GET /.well-known/agent.json`, `GET /catalog`, `POST /offers`, `POST /payments`, `POST /orders/:id/fulfil`, `POST /webhooks/paypal`, `GET /dashboard/stream` (SSE), `POST /assistant` (shopkeeper).
`GET /.well-known/agent.json` is an unsigned discovery hint (ids, name, endpoints; no public key). Consumers verify keys and ids against the registry, never the card.
Consumer :4002 — `POST /passkeys/register/{options,verify}`, `POST /mandates/{options,verify}` (every scoped merchant must be active in the registry, else `MERCHANT_UNTRUSTED`; the response names them), `POST /chat` (SSE agent loop), `GET /approvals/:id`, `POST /approvals/:id/verify`, `GET /activity`.

## 11. Attack model (each must be a test in `tests/attacks`)
Amount changed after approval · address changed after approval · item swapped · currency swapped · replayed approval · expired approval · approval for another merchant · fake merchant agent (unknown key) · look-alike merchant id · merchant price change after offer · offer reuse · unknown consumer agent · forged agent sig · mandate over per-order limit · mandate over period limit (split orders) · out-of-scope merchant/category · prompt injection in item note / address line / merchant reply · duplicate requestId · duplicate webhook · forged webhook · UV flag missing · signCount rollback · wrong origin/rpId. Target: 0 unauthorized authorizations, 0 duplicate charges.

## 12. Demo script (≤3 min)
0:00 CEO quote hook → 0:20 happy path with Face ID → 1:10 three live attacks blocked with reasons → 2:10 receipt chain + eval table → 2:45 closing line.
