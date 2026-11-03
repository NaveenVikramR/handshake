import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A85",
  title: "Assertion made on a look-alike subdomain origin",
  category: "webauthn",
  spec: "Wrong origin/rpId",
  expect: "APPROVAL_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { origin: "https://wallet.handshake.test.evil.example" }));
  },
});
