import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A48",
  title: "Split orders: the third crosses the weekly limit",
  category: "mandate",
  spec: "Mandate over period limit (split orders)",
  expect: "MANDATE_LIMIT",
  authorizations: 2,
  async run(h) {
    const md = h.f.mandate();
    const three = [{ sku: "RICE-2KG", qty: 3 }];
    await h.submit(h.f.mandateRequest(await h.f.offer(three), md));
    await h.submit(h.f.mandateRequest(await h.f.offer(three), md));
    return h.submit(h.f.mandateRequest(await h.f.offer(three), md));
  },
});
