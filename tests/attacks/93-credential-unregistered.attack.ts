import { hash } from "../../packages/core/src/index.js";
import { FakeAuthenticator } from "../../packages/core/test/fake-authenticator.js";
import { WEBAUTHN } from "../../services/merchant/test/gate-fixture.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A93",
  title: "Assertion from a passkey the registry doesn't know",
  category: "webauthn",
  spec: "Wrong origin/rpId",
  expect: "APPROVAL_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    const rogue = new FakeAuthenticator(WEBAUTHN.rpId, WEBAUTHN.origin);
    const cart = h.f.cartFor(offer);
    return h.submit(h.f.sign(offer, { kind: "passkey", cartApproval: cart, assertion: rogue.assert(hash(cart)) }));
  },
});
