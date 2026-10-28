---
paths:
  - "services/merchant/**"
  - "services/consumer/src/pay/**"
  - "packages/db/**"
---

# Payment code rules
- Verification gate order and error codes: docs/SPEC.md §6. Fail closed; write a `decisions` row for every step.
- Insert `requestId` / nonces with a unique constraint inside the same transaction as the state change, before calling PayPal.
- PayPal client lives in `services/merchant/src/paypal/`. Nothing else calls PayPal directly.
- Every PayPal POST: `PayPal-Request-Id`. Money stays integer minor units until the client converts to a decimal string.
- Order status changes only through `transition(order, event)` in the state machine; invalid transitions throw.
- Capture only after the fulfilment check; void on failure or hold expiry.
- Log PayPal ids and statuses, never tokens, secrets or full webhook headers.
