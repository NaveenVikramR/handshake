import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A46",
  title: "Mandate order over the per-order limit",
  category: "mandate",
  spec: "Mandate over per-order limit",
  expect: "MANDATE_LIMIT",
  async run(h) {
    const { request } = await h.mandatePath([{ sku: "RICE-2KG", qty: 4 }]);
    return h.submit(request);
  },
});
