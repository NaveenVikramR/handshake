---
name: attack-case
description: Template and rules for adding an adversarial test to tests/attacks. Use when writing attack cases or expanding the eval.
argument-hint: "[attack description]"
---

# Adding an attack case

Each attack is one file `tests/attacks/<nn>-<slug>.attack.ts` exporting a case:

```ts
import { defineAttack } from "./harness";

export default defineAttack({
  id: "A07",
  title: "Amount raised after passkey approval",
  category: "tamper",          // tamper | replay | identity | mandate | injection | idempotency | webhook | webauthn
  expect: "CART_HASH_MISMATCH", // HandshakeError code the gate must return
  async run(h) {
    const { request } = await h.happyPathRequest();   // fully valid signed request
    const cart = request.authorization.cartApproval;
    cart.items[0].unitMinor += 1000;                   // qty is 1, so raise the total by the same amount
    cart.totalMinor += 1000;                           // cart stays consistent → reaches the hash check
    return h.submit(request);                          // returns { code, authorized: boolean }
  },
});
```

Rules
- Start from `h.happyPathRequest()` and change one thing, so each case proves one check.
- Tampering attacks must keep the payload internally consistent (e.g. change `unitMinor` and `totalMinor` together) so they reach the signature/hash check, not just schema validation.
- Assert both the error code and `authorized === false`; for idempotency cases also assert PayPal create-order was called at most once (`h.paypalCalls()`).
- Use the mocked PayPal client and fake authenticator from the harness — no network.
- Never weaken production code to make a case pass; report the missing check instead.
- After adding, run `pnpm -s attack`; the runner prints the table and writes `docs/EVAL.md`.

If `$ARGUMENTS` is given, write that attack now.
