import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A70",
  title: "Same request sent twice",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "DUPLICATE_REQUEST",
  authorizations: 1,
  async run(h) {
    const { request } = await h.happyPathRequest();
    await h.submit(request);
    return h.submit(request);
  },
});
