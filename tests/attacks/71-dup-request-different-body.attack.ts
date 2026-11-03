import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A71",
  title: "Same requestId reused for a different offer",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "DUPLICATE_REQUEST",
  authorizations: 1,
  async run(h) {
    const a = await h.happyPathRequest();
    await h.submit(a.request);
    const b = await h.happyPathRequest();
    return h.submit(h.f.sign(b.offer, b.request.authorization, { requestId: a.request.requestId }));
  },
});
