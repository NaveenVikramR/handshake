import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A84",
  title: "Assertion made on another origin",
  category: "webauthn",
  spec: "Wrong origin/rpId",
  expect: "APPROVAL_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { origin: "https://evil.example" }));
  },
});
