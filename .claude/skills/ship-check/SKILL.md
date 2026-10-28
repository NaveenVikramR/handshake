---
name: ship-check
description: Pre-submission checklist for the PayPal AI Hackathon Devpost entry. Run before recording the video and before submitting.
disable-model-invocation: true
---

## Repo state
!`git status --short | head -20 || true`
!`ls LICENSE README.md 2>/dev/null || true`

Check each item and report a ✅/❌ table with a one-line fix for every ❌. Don't fix anything without asking.

Repository
- [ ] Public GitHub repo; MIT `LICENSE` at root (shows in the About section)
- [ ] README: problem (CEO quote), what it does, architecture diagram, PayPal features used, AI used and how, setup in ≤10 commands, sandbox test accounts + how judges log in, "what was built during the hackathon", known limitations (AP2-inspired, registry tables, sandbox)
- [ ] `.env.example` complete; no secrets committed (`git log -p | grep -i "client_secret\|api_key"` returns nothing)
- [ ] `pnpm test` and `pnpm attack` green; `docs/EVAL.md` current

Demo
- [ ] Render deploy healthy (merchant, consumer, web) on the Neon `main` branch, which must stay up through judging (1–15 Dec); `DEMO_MODE` seed + reset work
- [ ] Passkey approval works on a real phone over HTTPS
- [ ] Happy path ends in a sandbox capture visible in the PayPal sandbox dashboard
- [ ] Three attacks blocked live with readable reasons

Video (< 3 min, public YouTube, no copyrighted music)
- [ ] Follows SPEC §12; shows the phone Face ID moment; shows eval numbers; ends with the one-line pitch

Devpost form
- [ ] Text description, tools/AI used, repo URL, demo URL, video URL, sponsor tools (Render) ticked if used
