import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A51",
  title: "Mandate scoped to another merchant",
  category: "mandate",
  spec: "Out-of-scope merchant/category",
  expect: "MANDATE_SCOPE",
  async run(h) {
    const { request } = await h.mandatePath(undefined, { scope: { merchants: ["mer_other"], categories: ["grocery"] } });
    return h.submit(request);
  },
});
