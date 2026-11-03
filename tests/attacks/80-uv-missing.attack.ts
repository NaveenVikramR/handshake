import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A80",
  title: "Assertion without user verification",
  category: "webauthn",
  spec: "UV flag missing",
  expect: "APPROVAL_UV_MISSING",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { uv: false }));
  },
});
