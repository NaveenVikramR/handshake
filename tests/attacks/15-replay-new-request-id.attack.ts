import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A15",
  title: "Paid request replayed under a new requestId",
  category: "replay",
  spec: "Replayed approval",
  expect: "OFFER_USED",
  authorizations: 1,
  async run(h) {
    const { request } = await h.happyPathRequest();
    await h.submit(request);
    return h.submit(h.f.sign(request.offer, request.authorization));
  },
});
