# PayPal integration notes

Sandbox only. Lines marked **VERIFY** are from memory and must be confirmed (ask the `paypal-docs` agent) before relying on them. When confirmed, remove the marker and add the doc URL.

## Base and auth
- Base URL: `https://api-m.sandbox.paypal.com`
- Token: `POST /v1/oauth2/token`, Basic auth `client_id:secret`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type=client_credentials`. Response: `access_token`, `token_type: Bearer`, `expires_in` (seconds), `scope`, `app_id`, `nonce`. Cache until `expires_in - 60s`. https://developer.paypal.com/api/rest/authentication/
- Headers on every POST: `Authorization: Bearer …`, `Content-Type: application/json`, `PayPal-Request-Id: <our requestId>` (idempotency; optional per API, server stores the ID for a period; same ID resent returns the original result, 200 instead of 201; no global window or max length published, refund example says up to 45 days; UNCONFIRMED window for orders -> **VERIFY** in sandbox). https://developer.paypal.com/api/rest/requests/

## Orders v2 (authorize flow)
- Create: `POST /v2/checkout/orders` with `intent: "AUTHORIZE"`, `purchase_units[0].amount { currency_code, value: "4.99" }`, `custom_id = requestId`, `invoice_id = orderId`. `custom_id` max 255 chars, `invoice_id` max 127 chars (min 1 each); invoice_id must be unique per merchant account by default. https://developer.paypal.com/api/orders/v2/definitions/purchase_unit_request  Minimal required in examples: `intent` + `purchase_units[].amount`. Response is minimal unless `Prefer: return=representation`.
- With buyer approval (fallback): redirect to `links[rel=approve]` (GET). `rel=payer-action` appears with status `PAYER_ACTION_REQUIRED` (when payment_source/experience_context is used); handle both: `links.find(rel in [payer-action, approve])`. https://developer.paypal.com/api/orders/v2/schema.yaml  Then `POST /v2/checkout/orders/{id}/authorize`. Auth id location in response: `purchase_units[0].payments.authorizations[0].id` (confirmed in sandbox 2026-10-29; new authorization status `CREATED`). Authorization statuses: CREATED, CAPTURED, DENIED, EXPIRED, PARTIALLY_CAPTURED, VOIDED, PENDING. https://developer.paypal.com/docs/api/orders/v2/
- Capture: `POST /v2/payments/authorizations/{authorization_id}/capture`
- Void: `POST /v2/payments/authorizations/{authorization_id}/void`. Default (`Prefer: return=minimal`) returns 204 No Content; `Prefer: return=representation` returns 200 with authorization (status VOIDED). 422 `PREVIOUSLY_CAPTURED` if already fully captured; 409 `PREVIOUS_REQUEST_IN_PROGRESS`. https://developer.paypal.com/api/payments/v2/schema.yaml
- Refund: `POST /v2/payments/captures/{capture_id}/refund`
- Tracking: `POST /v2/checkout/orders/{id}/track` (**VERIFY** body fields)

## Vault (no-redirect agent payments) — spike M0
- Prereq: Dashboard > app > Sandbox App Settings > App Feature Options: check Accept payments, Advanced options: Vault. Sandbox needed nothing beyond the Vault tick (no reference-transaction approval) on a US Business sandbox account. An India-country Business account rejected the USD order at approval ("seller doesn't accept payments in your currency") — use US sandbox accounts. https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/orders-api/paypal/
- Save-with-purchase: first order body `payment_source.paypal { attributes.vault { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" }, experience_context { return_url, cancel_url } }`. First order STILL needs buyer redirect (status `PAYER_ACTION_REQUIRED`, link `approve`/`payer-action`). `AUTHORIZE` intent supported (call Authorize after approval). Vault id returned in the Authorize/Capture response (not create) at `payment_source.paypal.attributes.vault` { id, customer.id, status: VAULTED | APPROVED, links }; if APPROVED, wait for webhook `VAULT.PAYMENT-TOKEN.CREATED` (resource.id = vault id). Docs sample for capture shows key `attribute` (singular) once: parse defensively. Same URL as above.
- Setup-token alternative: `POST /v3/vault/setup-tokens` body `payment_source.paypal { usage_type: "MERCHANT", customer_type: "CONSUMER", usage_pattern: "IMMEDIATE", permit_multiple_payment_tokens: false, experience_context { return_url, cancel_url, ... } }` -> `PAYER_ACTION_REQUIRED`, `id`, links approve/confirm/self (payer must approve, redirect required, token expires 3 days). Then `POST /v3/vault/payment-tokens` body `{ payment_source: { token: { id: <setup_token_id>, type: "SETUP_TOKEN" } } }` -> `id` (the vault_id), `customer.id`. https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/
- Later order: `POST /v2/checkout/orders` with `intent: "AUTHORIZE"` and `payment_source.paypal.vault_id = <payment token id>` (no experience_context, no `stored_credential`) returns status `COMPLETED` with the authorization already in `purchase_units[0].payments.authorizations[0]` (status `CREATED`) — no redirect, no separate `/authorize` call. Void works as usual. (Confirmed in sandbox 2026-10-29.)
- Result: **SUCCESS** (2026-10-29, sandbox). First order with vault attrs → buyer approved once → `/authorize` response carried `payment_source.paypal.attributes.vault { id, status: "VAULTED" }` (id available immediately, no webhook wait). Second AUTHORIZE order with that `vault_id` → `COMPLETED` + authorization, no buyer interaction; voided. See DECISIONS D7.

## Webhooks
- Verify: `POST /v1/notifications/verify-webhook-signature` with transmission headers + `webhook_id` + raw event. Expect `verification_status: "SUCCESS"`.
- Events we use (**VERIFY** names): `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`.
- Dedupe on `event.id`.

## Agent Toolkit
- Package: `@paypal/agent-toolkit` (**VERIFY** name/version, TS API, which tools exist: orders, invoices, refunds, tracking, reporting).
- Use only for the shopkeeper assistant; core payment path uses our own client (deterministic, testable).

## Money
- Internal: integer minor units. Boundary: `(minor / 100).toFixed(2)` for USD. Never floats elsewhere.

## Confirmed facts log
2026-10-28 — OAuth: POST /v1/oauth2/token, Basic auth, form grant_type=client_credentials, returns access_token/token_type/expires_in — https://developer.paypal.com/api/rest/authentication/
2026-10-28 — PayPal-Request-Id enforces POST idempotency; optional, per-API support; no global window published — https://developer.paypal.com/api/rest/requests/
2026-10-28 — purchase_unit custom_id max 255, invoice_id max 127 — https://developer.paypal.com/api/orders/v2/definitions/purchase_unit_request
2026-10-28 — link rel approve (GET) and payer-action (status PAYER_ACTION_REQUIRED) both exist — https://developer.paypal.com/api/orders/v2/schema.yaml
2026-10-28 — Void returns 204 default, 200 with Prefer return=representation; 422 PREVIOUSLY_CAPTURED — https://developer.paypal.com/api/payments/v2/schema.yaml
2026-10-28 — Save-with-purchase vault attrs, vault id in authorize/capture response, AUTHORIZE supported, first order needs buyer approval — https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/orders-api/paypal/
2026-10-28 — Setup-token/payment-token flow and vault_id order (CAPTURE sample); Vault toggle prerequisite — https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/
2026-10-29 — Sandbox: AUTHORIZE order → approve → /authorize → authorizations[0].id status CREATED → void → VOIDED (`pnpm paypal:smoke`) — sandbox run
2026-10-29 — Sandbox: save-with-purchase returns vault status VAULTED + id in /authorize response; later AUTHORIZE order with vault_id returns COMPLETED with authorization, no redirect, no stored_credential (`pnpm paypal:smoke --vault`) — sandbox run
2026-10-29 — Sandbox: India-country Business account rejects USD orders at approval; US Business account works — sandbox run
