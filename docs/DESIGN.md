# Design brief (M8)

## Feel
Calm, trustworthy fintech. Light theme, one accent colour, generous spacing, system font stack. No stock illustrations. Status colours only where they carry meaning: green = allowed, amber = step-up, red = blocked. Must look good in a 1080p screen recording and on an iPhone screen.

## Phone approval page — the hero of the demo (mobile-first)
- Merchant name with a "verified merchant" badge (from the trust registry, never the agent card).
- Each item with qty and price; the total in large type; ship-to; a countdown to the approval's expiry.
- One full-width "Approve with Face ID" button. Show only fields from the stored cart (`GET /approvals/:id`): what is shown is exactly what is hashed and signed.
- Clear end states: success (approved, payment held until delivery) and blocked/expired, each with a one-line reason.

## Wallet
- Passkey status (registered, last used).
- Active mandates as limit bars: spent vs the period limit (e.g. $60 of $80 this week), plus scope (merchants, categories) and expiry.
- Recent activity with order state in words: held (authorized), paid (captured), voided, refunded.

## Merchant dashboard
- Live feed (SSE) of incoming agent requests: agent, user, total, path (passkey / mandate), result colour.
- Each row expands to the 9 gate checks with ✓/✗ and the reason, in SPEC §6 order.
- PayPal state per order (approve pending, authorized, captured, voided, refunded), with fulfil/void actions.

## Human reasons, not codes
Every blocked request shows one plain line; the code stays in the expandable detail. For example:
- `CART_HASH_MISMATCH` / `CART_MISMATCH` → "Amount changed after approval"
- `APPROVAL_REPLAY` / `OFFER_USED` → "This approval was already used"
- `APPROVAL_EXPIRED` / `OFFER_EXPIRED` → "Approval timed out"
- `MANDATE_LIMIT` → "Over the weekly limit"; `MANDATE_SCOPE` → "Outside what you allowed"
- `AGENT_UNTRUSTED` / `MERCHANT_UNTRUSTED` → "Unknown agent" / "Merchant not verified"
- `STEP_UP_REQUIRED` → "Needs your approval on your phone"; `RISK_BLOCKED` → "Blocked as unusual"
