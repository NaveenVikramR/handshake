# Handshake

Payment layer for personal AI agents (PayPal AI Hackathon). A consumer agent buys from a merchant agent; the human approves the exact cart with a passkey; both agents prove who they are with signatures checked against a trust registry; money moves only through PayPal sandbox (authorize → capture on fulfilment → void on failure).

Live demo: https://handshake-web-debi.onrender.com (free hosting; the landing page wakes the services, about a minute from cold).

The full README (architecture, setup, sandbox accounts, AI tools used) is being written in M11; design notes live in `docs/` (`SPEC.md`, `DECISIONS.md`, `PAYPAL.md`, `EVAL.md`).

## Known limitations

- **PayPal sandbox shapes not yet observed.** Three PayPal behaviours are handled from the documentation but haven't been seen in the sandbox: the `PAYMENT.CAPTURE.REVERSED` webhook's resource shape (we treat it as refund-shaped and follow its `up` link, like `PAYMENT.CAPTURE.REFUNDED`, which is confirmed), which payer fields the authorize response carries (we read `payment_source.paypal.account_id`, then `payer.payer_id`), and whether PayPal accepts a void after a declined capture (a refused void is logged for a human and the authorization expires on its own). Details and sources: `docs/PAYPAL.md` (lines marked **VERIFY**).
- **Demo deployment.** The judging deploy runs on the Neon `dev` branch with `DEMO_MODE` on (D30), so Reset demo and the attack panel work; Reset wipes payment data. Render's free tier sleeps when idle.
- **Saved PayPal wallet across devices.** A saved wallet becomes confirmable only when the owner approves on PayPal in the same browser where their wallet is signed in (D31); approving on another device still authorizes the order, and the next order asks PayPal again.
