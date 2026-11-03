import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A18",
  title: "Mandate cart nonce reused on another offer",
  category: "replay",
  spec: "Replayed approval",
  expect: "APPROVAL_REPLAY",
  authorizations: 1,
  async run(h) {
    const md = h.f.mandate();
    const first = h.f.mandateRequest(await h.f.offer(), md);
    await h.submit(first);
    return h.submit(h.f.mandateRequest(await h.f.offer(), md, { nonce: h.cart(first).nonce }));
  },
});
