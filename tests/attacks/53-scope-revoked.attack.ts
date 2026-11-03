import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A53",
  title: "Mandate revoked in the wallet",
  category: "mandate",
  spec: "Out-of-scope merchant/category",
  expect: "MANDATE_INVALID",
  async run(h) {
    const { md, request } = await h.mandatePath();
    h.f.mandates.get(md.mandate.mandateId)!.status = "revoked";
    return h.submit(request);
  },
});
