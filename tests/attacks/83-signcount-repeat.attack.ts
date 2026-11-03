import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A83",
  title: "Sign count repeated (cloned authenticator)",
  category: "webauthn",
  spec: "signCount rollback",
  expect: "APPROVAL_INVALID",
  authorizations: 1,
  async run(h) {
    const first = await h.happyPathRequest();
    await h.submit(first.request);
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, {}, { signCount: 1 }));
  },
});
