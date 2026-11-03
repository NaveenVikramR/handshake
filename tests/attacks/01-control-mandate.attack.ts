import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A01",
  title: "Control: a valid in-mandate request authorizes",
  category: "control",
  spec: "control",
  expect: "OK",
  expectAuthorized: true,
  async run(h) {
    const { request } = await h.mandatePath([{ sku: "RICE-2KG", qty: 2 }]);
    return h.submit(request);
  },
});
