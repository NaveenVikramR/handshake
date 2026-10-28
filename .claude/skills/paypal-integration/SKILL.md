---
name: paypal-integration
description: Conventions for calling PayPal (orders authorize/capture/void, refunds, tracking, webhooks, Agent Toolkit) in this repo. Use when writing or changing anything that talks to PayPal.
paths:
  - "services/merchant/**"
---

# PayPal in Handshake

- Facts: `docs/PAYPAL.md`. A line marked VERIFY is unconfirmed — ask the `paypal-docs` agent before relying on it. Never guess field names.
- Client: `services/merchant/src/paypal/client.ts` exposes `getToken`, `createOrderAuthorize`, `captureAuthorization`, `voidAuthorization`, `refundCapture`, `addTracking`, `verifyWebhook`. Each takes `requestId` and sends it as `PayPal-Request-Id`.
- Base URL from `PAYPAL_BASE_URL`; the client throws at startup unless it contains `sandbox`.
- Responses: parse with zod, keep only the fields we use; store raw ids (order, authorization, capture) on the `orders` row.
- Errors: map PayPal `name`/`details[].issue` into `HandshakeError("PAYPAL_ERROR", { issue })`. Retry only on 5xx/429 with the same `PayPal-Request-Id` (max 2).
- Webhooks: read the raw body, verify signature first, insert `paypal_events.eventId` (unique) before acting, then call the state machine. Return 200 for duplicates.
- Tests: mock `fetch`; assert headers (idempotency key present), amounts as decimal strings, and state transitions. Live sandbox calls only in `scripts/paypal-smoke.ts`.
- Agent Toolkit (`@paypal/agent-toolkit`): only inside the shopkeeper assistant; any money-moving tool call requires an explicit merchant confirmation step.
