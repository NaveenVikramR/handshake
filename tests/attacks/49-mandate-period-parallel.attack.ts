import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A49",
  title: "Four split orders in parallel against one weekly limit",
  category: "mandate",
  spec: "Mandate over period limit (split orders)",
  expect: "MANDATE_LIMIT",
  authorizations: 2,
  async run(h) {
    const md = h.f.mandate();
    const three = [{ sku: "RICE-2KG", qty: 3 }];
    const bodies = await Promise.all([1, 2, 3, 4].map(async () => h.f.mandateRequest(await h.f.offer(three), md)));
    const outs = await Promise.all(bodies.map((b) => h.submit(b)));
    const ok = outs.filter((o) => o.code === "OK").length;
    const limited = outs.filter((o) => o.code === "MANDATE_LIMIT").length;
    // 2 × 3000 fit in 8000; the rest must be refused.
    return { code: ok === 2 && limited === 2 ? "MANDATE_LIMIT" : `OK_${ok}_LIMIT_${limited}`, authorized: ok > 2 };
  },
});
