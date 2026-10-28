# Handshake

Payment layer for personal AI agents, built for the PayPal AI Hackathon (deadline 12 Nov 2026, 12:00 PST = 13 Nov 01:30 IST).
A consumer agent buys from a merchant agent. The human approves with a passkey (Face ID / fingerprint) that signs a hash of the exact cart. Both agents prove identity via signatures checked against a trust registry. Money moves only through PayPal (sandbox): authorize → capture on fulfillment → void on failure.

## Where truth lives
- `docs/SPEC.md` — formats, flows, error codes, DB, API. Read only the section you need (`grep -n "^## " docs/SPEC.md`, then Read with offset/limit).
- `docs/PLAN.md` — milestones with checkboxes. The first unchecked item is the current work.
- `docs/PAYPAL.md` — verified PayPal API notes. Lines marked `VERIFY` are unconfirmed.
- `docs/DECISIONS.md` — why things are the way they are. Append, never rewrite.

## Stack
pnpm workspaces · TypeScript strict · Node 24 · Express 5 services · Next.js 16 (App Router) web · Postgres on Neon (hosted, no Docker) + Prisma · zod · vitest · @simplewebauthn/server + /browser · Ed25519 via node:crypto · LLM via OpenAI-compatible SDK (`LLM_BASE_URL`, `LLM_MODEL`) · PayPal REST (sandbox) + `@paypal/agent-toolkit` for the shopkeeper assistant.

## Layout
```
packages/core      schemas, canonical JSON (JCS), hashing, Ed25519, error codes — no I/O
packages/db        Prisma schema + client (shared by both services)
services/merchant  merchant agent, signed offers, verification gate, PayPal, webhooks  :4001
services/consumer  consumer agent, mandates, passkeys, approval requests              :4002
apps/web           wallet, phone approval page, merchant dashboard                     :3000
tests/attacks      adversarial suite (`pnpm attack`)
```

## Commands
`pnpm dev` · `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm attack` · `pnpm db:migrate` · `pnpm db:seed` · `pnpm paypal:smoke`

## Non-negotiable rules (details in `.claude/rules/`)
1. Never call live PayPal. Base URL must be `https://api-m.sandbox.paypal.com`.
2. An LLM never decides an amount, payee, currency or approval. Amounts come from the DB / signed offer. LLM risk checks may only escalate (step-up or block), never approve.
3. Every verification fails closed and returns a `HandshakeError` code from `packages/core/src/errors.ts`.
4. Every PayPal POST sends `PayPal-Request-Id`. Every webhook is signature-verified and de-duplicated by event id.
5. Money is integer minor units (`totalMinor`) everywhere except the PayPal boundary, where it becomes a decimal string.
6. Never read or write `.env`. Use `.env.example` for new variables.
7. No Docker. The database is Neon Postgres (`dev` branch locally, `main` branch in production).

## How to work (keeps tokens low)
- Start a milestone with `/milestone`. Implement only what that milestone lists.
- Plan in ≤10 bullets, then make small diffs. No rewrites of working files.
- Don't re-read a file you just edited. Don't paste long logs; summarise.
- Delegate: PayPal API questions → `paypal-docs` agent. Running tests → `test-runner` agent. Payment/crypto diffs → `security-reviewer` agent before commit. New attacks → `red-team` agent.
- When you confirm a PayPal fact, record it once in `docs/PAYPAL.md` so nobody looks it up again.
- Done = typecheck + tests pass, PLAN checkbox ticked, one commit with a conventional message.
