import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A26",
  title: "Cart names another user than the passkey's owner",
  category: "identity",
  spec: "Approval for another merchant",
  expect: "APPROVAL_INVALID",
  async run(h) {
    const offer = await h.f.offer();
    return h.submit(h.f.passkeyRequest(offer, { userId: "usr_bob" }));
  },
});
