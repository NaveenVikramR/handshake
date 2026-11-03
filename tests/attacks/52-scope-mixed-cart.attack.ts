import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A52",
  title: "In-scope item bundled with an out-of-scope one",
  category: "mandate",
  spec: "Out-of-scope merchant/category",
  expect: "MANDATE_SCOPE",
  async run(h) {
    const { request } = await h.mandatePath([
      { sku: "RICE-2KG", qty: 1 },
      { sku: "DET-1L", qty: 1 },
    ]);
    return h.submit(request);
  },
});
