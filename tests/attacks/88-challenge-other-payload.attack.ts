import { hash } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A88",
  title: "Assertion over a different payload's hash",
  category: "webauthn",
  spec: "Wrong origin/rpId",
  expect: "CART_HASH_MISMATCH",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { challenge: hash({ other: "cart" }) }));
  },
});
