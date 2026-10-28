---
name: milestone
description: Implement the next unchecked milestone from docs/PLAN.md end to end (plan, build, test, review, tick, commit).
disable-model-invocation: true
argument-hint: "[milestone id, e.g. M3 — optional]"
---

## Open items in the plan
!`grep -n "^## \|^- \[ \]" docs/PLAN.md | head -40 || true`

## Steps
1. Pick the milestone: `$ARGUMENTS` if given, otherwise the first `##` section above with unchecked items. Name it in one line.
2. Read only the SPEC sections that milestone references (find line numbers with `grep -n "^## \|^### " docs/SPEC.md`, then Read with offset/limit). Read `docs/PAYPAL.md` only if the milestone touches PayPal.
3. Write a plan of ≤10 bullets: files to create/change, tests to add. If something in the spec is ambiguous, ask me one question before coding.
4. Implement in small diffs. Tests alongside each module (positive + tamper/negative).
5. Ask the `test-runner` agent to run typecheck + tests. Fix until green.
6. If you touched `services/` or `packages/core`, ask the `security-reviewer` agent to review the diff. Fix CRITICAL/HIGH.
7. Tick only the boxes whose acceptance check actually passed. If the milestone revealed a decision, append it to `docs/DECISIONS.md`.
8. Commit once: `feat(mN): <summary>` (or `fix`/`chore`). Then report in ≤6 lines: what's done, what's left, any risk for the next milestone.
