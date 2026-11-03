import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A05",
  title: "Signed offer's prices raised after the merchant signed",
  category: "tamper",
  spec: "Amount changed after approval",
  expect: "OFFER_SIG_INVALID",
  async run(h) {
    const { request } = await h.happyPathRequest();
    const p = request.offer.payload;
    const payload = { ...p, items: p.items.map((i) => ({ ...i, unitMinor: i.unitMinor + 1000 })), totalMinor: p.totalMinor + 1000 };
    return h.submit(h.resign({ ...request, offer: { ...request.offer, payload } }));
  },
});
