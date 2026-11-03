import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A14",
  title: "Offer re-signed in EUR with the merchant's own key",
  category: "tamper",
  spec: "Currency swapped",
  expect: "SCHEMA_INVALID",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const forged = h.forgeOffer(request.offer, { currency: "EUR" as "USD" }, h.f.keys.mk.privateKey);
    return h.submit(h.resign({ ...request, offer: forged }));
  },
});
