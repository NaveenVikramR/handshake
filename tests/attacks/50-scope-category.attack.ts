import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A50",
  title: "Household item on a grocery-only mandate",
  category: "mandate",
  spec: "Out-of-scope merchant/category",
  expect: "MANDATE_SCOPE",
  async run(h) {
    const { request } = await h.mandatePath([{ sku: "DET-1L", qty: 1 }]);
    return h.submit(request);
  },
});
