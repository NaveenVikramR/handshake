import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A87",
  title: "Registration ceremony data passed off as an assertion",
  category: "webauthn",
  spec: "Wrong origin/rpId",
  expect: "APPROVAL_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { type: "webauthn.create" }));
  },
});
