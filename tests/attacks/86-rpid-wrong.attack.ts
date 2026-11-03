import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A86",
  title: "Assertion scoped to another RP id",
  category: "webauthn",
  spec: "Wrong origin/rpId",
  expect: "APPROVAL_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { rpId: "evil.example" }));
  },
});
