# Handoff: work done while you were away (9 Nov 2026)

Deadline: **Thu 12 Nov 2026, 12:00 PST = Fri 13 Nov, 01:30 IST.**

## Done

| Item | Result |
|---|---|
| 0. Permission allowlist in `.claude/settings.local.json` | **Not done.** The session's permission check refused the edit, so I left it alone. Nothing else depended on it. |
| 1. CEO quote in README, ship-check Render line | Done and pushed earlier (`0700fce`, `0a605ac`). |
| 2. Phone box | Ticked with an honest note: real iPhone Safari and desktop Chrome passkeys verified in M0 (D12), plus the full deployed flow with a virtual authenticator (`pnpm e2e:deployed`). It says no Face ID run of the deployed flow has happened (D32). |
| 3. PayPal proof | `docs/EVAL.md` has a "Live sandbox evidence" section: order `6XC09098M9729124A`, capture `1YH00840RY292512F`, status `COMPLETED`, read back with `GET /v2/payments/captures/:id`. `pnpm attack` now keeps that section when it regenerates the file. Rerun with `pnpm --filter @handshake/e2e capture-evidence`. |
| 4. Demo video draft | `demo/handshake-demo.mp4`: 2:04, 1920×1080, 30 fps, no audio track, captions burned in. Shot list in `demo/SHOTLIST.md`, optional script in `demo/VOICEOVER.md`, one frame every 10 s in `demo/frames/` (checked: all captions readable). The mp4 and frames are gitignored. Rebuild with `pnpm --filter @handshake/e2e demo-video record` then `... demo-video build`. Choices: D34. |
| 5. Devpost text | `docs/SUBMISSION.md`, with every section, built-with, AI use and links. The private testing field uses `<SANDBOX_BUYER_EMAIL>`, `<SANDBOX_BUYER_PASSWORD>` and `<MERCHANT_ADMIN_TOKEN>`, and `<YOUTUBE_URL>` is a placeholder too. No real secrets are written anywhere. |
| 6. Ship-check rerun | See below. Everything that doesn't need you passes. |

**Bug found and fixed on the way (D33):** during recording, the dashboard said "PayPal couldn't process this payment" right after a successful capture. The tracking call after capture had failed, and the endpoint reported that as a payment failure. Now the captured receipt is returned and the tracking failure is logged. It passed security review, was deployed to the merchant (`170670b`), and has tests. It hasn't happened again since, so the sandbox's reason for rejecting that tracking call is still unknown.

**Commits pushed today:**

| Commit | What |
|---|---|
| `06c1297` | Return-URL probe |
| `0700fce`, `0a605ac` | README, LICENSE, quote |
| `e30b924` | Capture evidence, phone box |
| `170670b` | Tracking fix |
| `31c69cb` | Video tooling, shot list, voiceover, submission text |

The final commit adds this file and the PLAN updates. Render: merchant on `170670b`, web on `bae9208`, consumer on `37c8d04`, all live.

## Ship-check (9 Nov evening)

| Item | Status | What's left |
|---|---|---|
| Public repo, MIT `LICENSE` (GitHub shows MIT) | ✅ | |
| README sections | ✅ | |
| `.env.example` complete; no secrets in git history | ✅ | The only grep match is the checklist line itself |
| `pnpm test` (605) and `pnpm attack` (96/96) green; EVAL current | ✅ | |
| Render healthy on Neon dev (D30); seed and reset work | ✅ | Reset ran on every recording run today |
| Passkey on a real phone over HTTPS | ✅ (D32 note) | Optional real Face ID clip, step 2 below |
| Capture visible in the PayPal sandbox dashboard | ⚠️ | Proven by API; you take the dashboard screenshot, step 4 |
| Three attacks blocked live with reasons | ✅ | In the video at 1:25–1:42 |
| Video follows SPEC §12, < 3 min, public YouTube | ⚠️ | Draft done; watch and upload, steps 1 and 5 |
| Devpost form | ❌ | Step 6 |

## Your list for Wednesday (in order, about 1.5–2 h)

1. **Watch the draft video (10 min).** Open `demo/handshake-demo.mp4`. If a caption is wrong, edit it in `tests/e2e/demo-video.ts` and run `... demo-video build` (about 2 min, no re-recording needed).
2. **Optional: real Face ID footage (20 min).** The video uses a virtual authenticator, and its captions say so. SPEC §12 wants "the phone Face ID moment".
   - Screen-record your phone approving one cart on https://handshake-web-debi.onrender.com.
   - Either replace the 0:24–0:34 scene with it, or upload it as a second short clip.
   - This would also let the phone box say "Face ID on the deployed flow".
3. **Optional: voiceover (20 min).** Read `demo/VOICEOVER.md` over the video. The ffmpeg command to merge it is at the top of that file.
4. **PayPal sandbox screenshot (5 min).**
   - Log in at https://www.sandbox.paypal.com as the sandbox business (merchant) account.
   - Open Activity, find a $4.99 capture from 9 Nov (for example `1YH00840RY292512F`), and save a screenshot for the submission.
5. **Upload to YouTube (10 min):** public, title "Handshake: passkey-approved payments for AI agents, on PayPal", description = the tagline + repo + demo links.
6. **Devpost form (30 min).**
   - Copy each section from `docs/SUBMISSION.md`, and replace `<YOUTUBE_URL>`.
   - In the private testing-instructions field, fill in `<SANDBOX_BUYER_EMAIL>`, `<SANDBOX_BUYER_PASSWORD>` and `<MERCHANT_ADMIN_TOKEN>` from your `.env`.
   - Tick Render as a sponsor tool if the form lists it.
7. **Before submitting (10 min).**
   - Open the demo once so the services are awake, and click Reset demo so judges start clean.
   - Run `/ship-check`, submit, and screenshot the confirmation.

## What went wrong, and notes

- **Permissions:** the `.claude/settings.local.json` allowlist edit was refused (item 0). Every other step ran under the existing permissions.
- **First recordings had layout problems, all fixed:**
  - unstyled cards (a quoting bug);
  - grey phone video (Playwright records CSS pixels);
  - a PayPal tab in the wrong browser, which left the payer unconfirmable, as D31 intends;
  - the false PayPal error banner (the D33 bug);
  - the assistant's reply hidden under the caption bar;
  - the sandbox buyer's email visible in the wallet. It's now blurred, and the PayPal segment is blurred too.
- **Live LLM:** the assistant failed once during a take ("unavailable right now"). The recorder now asks again.
- **The results card says "96/96 attacks blocked",** as you dictated. Strictly, 96 cases pass, 93 of which are attacks and 3 valid controls. The voiceover and README say it precisely; change the card in `demo-video.ts` if you prefer.
- **Demo data:** every recording run resets the demo. The evidence order `6XC09098M9729124A` was wiped from Neon dev, but its capture still exists in PayPal; the `COMPLETED` status was read before the reset.
- **Known limitations in the README,** unchanged:
  - return-secret privacy depends on PayPal (the sandbox probe showed the return URL leaks to logged-in viewers);
  - REVERSED, authorize-payer and void-after-decline shapes are unobserved.
