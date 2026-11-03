import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A37",
  title: "Paid offer used again with a fresh approval",
  category: "replay",
  spec: "Offer reuse",
  expect: "OFFER_USED",
  authorizations: 1,
  async run(h) {
    const { offer, request } = await h.happyPathRequest();
    await h.submit(request);
    return h.submit(h.f.passkeyRequest(offer));
  },
});
