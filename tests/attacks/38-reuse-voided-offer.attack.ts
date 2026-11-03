import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A38",
  title: "Offer of a voided order used again (released on void)",
  category: "replay",
  spec: "Offer reuse",
  expect: "OFFER_EXPIRED",
  authorizations: 1,
  async run(h) {
    const { offer, request } = await h.happyPathRequest();
    await h.submit(request);
    const order = [...h.f.gate.orders.values()].at(-1)!;
    await h.fulfil(order.id, { fulfilled: false });
    return h.submit(h.f.passkeyRequest(offer));
  },
});
