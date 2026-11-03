import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A17",
  title: "Counting passkey approval replayed on a reopened offer (sign count stops it first)",
  category: "replay",
  spec: "Replayed approval",
  expect: "APPROVAL_INVALID",
  authorizations: 1,
  async run(h) {
    const { offer, request } = await h.happyPathRequest();
    await h.submit(request);
    h.f.offerStore.offers.get(offer.payload.offerId)!.status = "open";
    return h.submit(h.f.sign(offer, request.authorization));
  },
});
