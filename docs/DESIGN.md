# Handshake — Design brief (M8)

## Feel
Calm, trustworthy fintech. Light theme only. One accent: #2F5BEA (blue). Neutrals: #0F172A text, #475569 muted, #E2E8F0 borders, #F8FAFC page bg, white cards.
Status colours only for status: green #16A34A allowed/paid, amber #D97706 step-up/held, red #DC2626 blocked/voided.
System font stack. Sizes: 14 body, 16 mobile body, 20 headings, 40 totals. 8px spacing grid, 12px card radius, soft 1px borders, no heavy shadows. No stock illustrations or emoji in UI.

## Phone approval page (/approve/:id) — the demo hero, mobile-first
- Top: merchant name + "Verified merchant" badge (check icon, green) or red "Unverified" banner.
- Items: name, qty × unit price, line total. Total in 40px bold. Ship-to (one line). "Expires in 4:52" countdown; at 0 the button disables.
- One full-width 56px button: "Approve with Face ID" (label "Approve with passkey" on non-Apple devices).
- States: loading spinner in button → success screen (big green check, "Approved. Payment held until delivery.") → or blocked screen (red, one-line reason, no retry button).
- Everything readable without zooming on an iPhone; no horizontal scroll.
- Rule: approval page renders only the stored cart from GET /approvals/:id — exactly the payload the passkey signs; never data from the agent or the URL.
- Rule: "Verified merchant" badge comes from the trust registry, never from the merchant's agent card.

## Wallet (/wallet)
- Passkey card: device name, created date, status dot.
- Mandates: each a card with scope (merchants, categories) and two bars: per-order limit, weekly spent vs limit (e.g. "$24.95 of $80.00 this week").
- Activity list: merchant, total, time, state pill: Held (amber), Paid (green), Voided (grey), Refunded (grey), Blocked (red + reason).

## Merchant dashboard (/merchant)
- Live feed (SSE), newest on top, row = time, consumer agent id (short), total, outcome pill.
- Row expands to the 9 gate checks in order, each ✓/✗ with a short reason; failing check highlighted red.
- Right column: PayPal state per order (authorized → captured / voided / refunded) with order and capture ids (copy button).
- Shopkeeper assistant panel below: chat box; any money action shows a confirm card before running.

## Human reasons (never show raw codes in UI; code in a small grey tooltip)
CART_HASH_MISMATCH "Cart changed after you approved it" · OFFER_SIG_INVALID "Offer not signed by this merchant" · MERCHANT_UNTRUSTED "Unknown merchant" · AGENT_UNTRUSTED "Unknown shopping agent" · AGENT_SIG_INVALID "Request not signed by your agent" · APPROVAL_REPLAY "This approval was already used" · APPROVAL_EXPIRED "Approval expired" · APPROVAL_UV_MISSING "Face ID / fingerprint not confirmed" · MANDATE_LIMIT "Over your spending limit" · MANDATE_SCOPE "Shop or category not allowed" · OFFER_EXPIRED "Offer expired" · RISK_BLOCKED "Blocked as suspicious" · STEP_UP_REQUIRED "Needs your approval" · CART_MISMATCH "Cart doesn't match the offer" · OFFER_USED "This offer was already used" · APPROVAL_INVALID "Approval couldn't be verified" · MANDATE_INVALID "Spending permission isn't valid" · PAYPAL_ERROR "PayPal couldn't process this payment" · OUT_OF_STOCK "Item is out of stock" · RATE_LIMITED "Too many attempts, try again shortly" · SCHEMA_INVALID "Request was malformed".
Waiting state: "Waiting for PayPal approval" (amber, with an "Open PayPal" button).
Any code not in the list falls back to "Payment couldn't be completed" with the code in the grey tooltip.

## Recording
Test at 1920×1080 (dashboard) and 390×844 (iPhone). Body text ≥14px on desktop so it survives video compression.
