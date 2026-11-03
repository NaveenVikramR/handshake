import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A47",
  title: "Mandate's per-order limit raised after the human approved it",
  category: "mandate",
  spec: "Mandate over per-order limit",
  expect: "MANDATE_INVALID",
  async run(h) {
    const md = h.f.mandate();
    // 5000 is over the approved 3000; the edited mandate would allow it.
    md.mandate.limits.perOrderMinor = 8000;
    return h.submit(h.f.mandateRequest(await h.f.offer([{ sku: "RICE-2KG", qty: 5 }]), md));
  },
});
