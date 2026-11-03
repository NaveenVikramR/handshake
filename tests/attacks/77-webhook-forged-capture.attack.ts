import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A77",
  title: "Forged capture-completed webhook (paid without a capture)",
  category: "webhook",
  spec: "Forged webhook",
  expect: "webhook:forged",
  authorizations: 1,
  async run(h) {
    const o = await h.authorizedOrder();
    const r = await h.webhook(
      { id: "WH-F2", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPFAKE1", status: "COMPLETED" } },
      { signed: false },
    );
    return { code: `webhook:${r.outcome}`, authorized: h.f.gate.orders.get(o.id)!.status !== "authorized" };
  },
});
