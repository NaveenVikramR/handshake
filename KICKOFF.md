# Start here

## 1. Put the kit in your repo
Unzip into an empty folder (e.g. `handshake/`), then:
```
git init && git add -A && git commit -m "chore: project kit"
```
Requires Node 22+, pnpm, and Git Bash on Windows (hooks run with `node`). No Docker: create a free Neon Postgres project (neon.tech) with a `dev` branch and paste its two connection strings into `.env`.

## 2. Fill your own secrets
Copy `.env.example` → `.env` yourself and add PayPal sandbox + LLM keys. Claude is blocked from reading `.env` on purpose.

## 3. Open in VS Code → Claude Code panel, then paste this first prompt
```
Read CLAUDE.md. Then run /milestone M0.
Before writing code, use the paypal-docs agent to confirm every VERIFY line in docs/PAYPAL.md that M0 needs (OAuth, create order with AUTHORIZE, void, vault). Then scaffold.
```

## 4. Daily loop
- `/milestone` — does the next milestone end to end and commits.
- `/attack-case <idea>` — adds one adversarial test.
- `/ship-check` — before recording and before submitting.
- Run `/context` occasionally; if it's heavy, `/compact` (the SessionStart hook re-injects the current milestone).
- Start a fresh session per milestone (`/clear`) — CLAUDE.md + the hook give it everything it needs.

## What's in the kit
| File | Purpose |
|---|---|
| `CLAUDE.md` | Always-loaded project memory, kept short |
| `docs/SPEC.md` | Formats, flows, gate order, error codes, DB, API, attacks |
| `docs/PLAN.md` | Dated milestones with acceptance checks |
| `docs/PAYPAL.md` | PayPal facts; `VERIFY` = not yet confirmed |
| `docs/DECISIONS.md` | Append-only design decisions |
| `.claude/settings.json` | Permissions + hooks |
| `.claude/hooks/` | protect secrets, block live PayPal / destructive commands, auto-format, session orientation, typecheck on stop |
| `.claude/rules/` | Rules that load only when Claude touches payments, crypto or LLM code |
| `.claude/agents/` | paypal-docs, security-reviewer, test-runner (Haiku), red-team |
| `.claude/skills/` | /milestone, /attack-case, /ship-check, plus auto-loaded paypal-integration and passkeys guides |
