import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A86",
  title: "Sign count rolled back to 0 after use",
  category: "webauthn",
  spec: "signCount rollback",
  expect: "APPROVAL_INVALID",
  authorizations: 1,
  async run(h) {
    await h.submit((await h.happyPathRequest()).request);
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { signCount: 0 }));
  },
});
