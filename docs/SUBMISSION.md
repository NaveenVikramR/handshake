# Devpost submission: Handshake

Copy each section into the matching Devpost field. The last section goes in the private testing-instructions field; fill in the three placeholders there yourself and never commit the real values.

## Title

Handshake

## Tagline

Agents can shop for you, but only you can approve the payment, and every agent proves who it is.

## Inspiration

> "If you think about consumer agents buying from merchant agents, both will have to validate that this is a real consumer" … and "a real merchant that has the product."
> — Enrique Lores, CEO, PayPal, Q3 2026 earnings call (27 Oct 2026), as reported by [PYMNTS](https://pymnts.com/news/artificial-intelligence/2026/paypal-advances-ai-plans-bnpl-payment-volume-rises-25percent)

Personal AI agents are starting to buy things for us, but agent payments are missing two proofs:

- **Human consent.** A chat transcript where someone typed "yes" is not consent to a specific amount, payee and set of items.
- **Agent identity.** Nothing stops a fake merchant agent from impersonating a real shop, or a consumer agent's request from being changed on the way.

An LLM in the loop makes both worse, because a prompt injection hidden in a product description can steer what the agent buys. We wanted to show that both proofs can work today, on PayPal, without trusting the LLM with money.

## What it does

Handshake is a payment layer between a consumer agent and a merchant agent:

1. **You ask your agent** to "buy 1 Basmati rice from Corner Grocery". The agent finds the merchant, asks for an offer, and checks the offer's signature against a trust registry. Prices come only from the merchant's signed offer, never from the LLM.
2. **You approve the exact cart.** Your phone shows the merchant, every item, the total and the ship-to address. Face ID or your fingerprint signs a hash of exactly that cart, so changing one cent breaks the signature.
3. **Or a spending permission covers it.** You can sign a spending permission once with your passkey: per-order and per-period limits, chosen merchants and categories. Small purchases inside it go through with no approval step.
4. **The merchant verifies everything itself,** in a fixed order: schema, replay, consumer agent signature, offer signature, cart equals offer, passkey or permission, nonce and expiry, then an escalate-only risk inspector. Any failure stops the payment with a named error code.
5. **PayPal moves the money.** It authorizes and holds the payment; the merchant captures only after fulfilment, and a failed delivery or expired hold voids it. The first purchase saves the buyer's PayPal wallet, so later agent purchases need no PayPal redirect.
6. **The merchant sees it all live.** The dashboard streams every check as it happens, and a shopkeeper assistant built on PayPal Agent Toolkit explains orders and proposes refunds that the merchant must confirm.

An attack suite of 96 cases (3 valid controls and 93 attacks) changes one thing at a time in a valid request. All 96 pass, with 0 unauthorized payments and 0 duplicate charges. Three of the attacks run against the live demo from a dashboard button: amount changed after approval, fake merchant agent, and replayed approval.

## How we built it

- **Monorepo:** pnpm workspaces in TypeScript (strict), Node 24.
- **`packages/core`:** canonical JSON (RFC 8785), SHA-256 hashing, Ed25519 signatures with domain separation, zod schemas and error codes, with no I/O.
- **Two Express services:** the consumer agent (passkeys, cart approvals, spending permissions, LLM planner) and the merchant agent (signed offers, the verification gate, PayPal settlement, webhooks, dashboard stream, assistant).
- **Next.js web app:** the wallet, the phone approval page and the merchant dashboard. The browser only talks to its own origin, and the web server forwards to the services.
- **Passkeys:** SimpleWebAuthn. The challenge for a cart approval is the hash of the cart itself, and the merchant re-verifies the assertion independently against the registry's public key, without trusting the consumer service.
- **PayPal (sandbox):**
  - Orders v2 with `intent: AUTHORIZE`; capture, void and refund;
  - saving the PayPal wallet with the first purchase;
  - shipment tracking;
  - webhooks verified with `verify-webhook-signature` and de-duplicated by event id;
  - `PayPal-Request-Id` on every POST;
  - PayPal Agent Toolkit for the assistant.
- **Data:** Postgres on Neon with Prisma. Nonces, offers and spend limits are reserved in the same transaction as the state change, before PayPal is called.
- **LLM:** an OpenAI-compatible endpoint (Groq, `openai/gpt-oss-120b`) for the planner, the risk inspector and the assistant.
- **Hosting:** three Render services.
- **Testing:**
  - vitest unit and database tests;
  - the attack suite;
  - a Playwright run against the deployed demo, with a virtual WebAuthn authenticator and a real PayPal sandbox buyer.

## Challenges we ran into

- **Synced passkeys don't count.** iCloud Keychain and Google Password Manager passkeys report a sign count of 0 on every use, so clone detection by counter can't be relied on. We accept 0 → 0 and rely on user verification, origin, RP id and a one-time, cart-bound challenge, while still rejecting a counter that goes backwards.
- **Linking the saved PayPal wallet to the right person.** A race between PayPal's return page and the payment completion could leave the wallet unlinked, and a phishing variant could link a victim's PayPal to an attacker's wallet. We added a per-order return secret and a database lock. A sandbox probe then showed that PayPal's checkout page reveals the return URL to anyone who logs in on the approve link, so we documented the remaining gap honestly instead of claiming it fixed.
- **Keeping the LLM away from money.** Every tool the planner can call takes ids, never amounts. The risk inspector can only escalate, and anything it says that isn't well-formed counts as step-up. The assistant's toolkit is read-only, and the code refuses to start otherwise.
- **LLM tool-call hiccups.** The hosted model sometimes returned malformed tool calls; the planner retries them a bounded number of times.
- **Sandbox behaviours the docs don't pin down.** We recorded every PayPal fact we confirmed in the sandbox (`docs/PAYPAL.md`) and marked the ones we couldn't observe.

## Accomplishments that we're proud of

- **Attack suite:** 96 of 96 cases pass, with 0 unauthorized authorizations and 0 duplicate charges.
- **Live attacks:** three of them can be fired at the deployed demo with one click, and each is blocked with a readable reason.
- **Full deployed flow** runs end to end against the real PayPal sandbox:
  - passkey sign-up and cart approval;
  - PayPal approval and payer confirmation;
  - capture, a refund with its webhook, and a spending-permission purchase with no approval step.
- **Every security-relevant decision is written down,** with its reason, in `docs/DECISIONS.md`.

## What we learned

- **Approve the bytes, not the transcript.** The hash of the exact cart, signed by a passkey, makes consent checkable by the merchant.
- **Put identity checks at the receiver.** The merchant verifies everything itself; the consumer service is never trusted.
- **Authorize-then-capture fits agent commerce.** Money is held while trust and fulfilment are confirmed, and released or voided automatically.
- **Probe the platform.** The return-URL leak only showed up when we tested PayPal's real checkout page instead of assuming.

## What's next for Handshake

- A payer-side check at the passkey confirm step, to close the remaining wallet-linking gap.
- Moving the trust registry from database tables to a PayPal-operated registry of agent keys and merchant bindings.
- Aligning the approval and mandate formats with Google's Agent Payments Protocol (AP2); today Handshake is only AP2-inspired.
- Exposing the merchant agent as an MCP server, so any MCP-capable consumer agent can buy through the same gate.
- A disputes evidence pack built from the signed approval, offer and decision log.

## Built with

TypeScript, Node.js, Express, Next.js, React, PostgreSQL, Neon, Prisma, zod, WebAuthn (SimpleWebAuthn), Ed25519, PayPal Orders v2 / Payments / Webhooks / Vault APIs, PayPal Agent Toolkit, Groq (`openai/gpt-oss-120b` via the OpenAI SDK), vitest, Playwright, Render, Claude Code

## AI tools used, and how

**In the product (Groq, `openai/gpt-oss-120b`):**
- **Consumer planner:** reads the request, picks items and calls tools. It cannot set amounts, skip approval or edit signed data.
- **Risk inspector:** flags prompt injection and anomalies. It can only escalate to step-up or block, never approve.
- **Shopkeeper assistant:** explains orders using read-only PayPal Agent Toolkit tools and proposes refunds. The merchant must confirm every refund.

**To build it (Claude Code, by Anthropic):** the project was built with Claude Code. The repo's `.claude/` folder holds:
- project rules;
- milestone skills;
- subagents for PayPal documentation lookups, test runs, security review of every payment or crypto change before commit, and writing red-team attack cases.

## Links

- Repository: https://github.com/NaveenVikramR/handshake
- Live demo: https://handshake-web-debi.onrender.com
- Video: <YOUTUBE_URL>

## Testing instructions (private field)

Everything runs on the PayPal sandbox; no real money moves. Hosting is free, so open the demo first and wait about a minute while the landing page wakes the services.

1. Open https://handshake-web-debi.onrender.com and wait until the Wallet and Merchant buttons are enabled.
2. **Wallet** (best on a phone, any browser with passkeys):
   1. Enter a name and tap **Create passkey** (Face ID, fingerprint or your device PIN).
   2. Fill in a delivery address.
   3. Type `buy 1 Basmati rice from Corner Grocery` and send.
   4. Tap **Open approval**, check the cart and approve with your passkey.
   5. **First purchase only:** tap **Open PayPal** in the same browser and log in with the sandbox buyer below, then approve:
      - email: `<SANDBOX_BUYER_EMAIL>`
      - password: `<SANDBOX_BUYER_PASSWORD>`
   6. Back in the wallet, tap **Confirm with passkey** to save the PayPal payer.
   7. Optional: create a spending permission with **New permission** and buy again. The second purchase completes with no approval step.
3. **Merchant dashboard:**
   1. Open `/merchant` and sign in with the admin token `<MERCHANT_ADMIN_TOKEN>`.
   2. Click **Fulfil & capture** on the held order, and watch **Incoming requests** show every check.
   3. In **Attack demo**, click the three buttons. Each tampered request is blocked with its reason.
   4. Ask the **Shopkeeper assistant** a question, for example "Summarise today's orders and their PayPal status".
4. **Reset demo** on the dashboard clears all payment data, if you want to start over.
