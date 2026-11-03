import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A81",
  title: "Assertion without user presence",
  category: "webauthn",
  spec: "UV flag missing",
  expect: "APPROVAL_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { up: false }));
  },
});
