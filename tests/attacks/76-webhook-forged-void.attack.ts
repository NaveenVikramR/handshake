import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A76",
  title: "Forged void webhook for a held order",
  category: "webhook",
  spec: "Forged webhook",
  expect: "webhook:forged",
  authorizations: 1,
  async run(h) {
    const o = await h.authorizedOrder();
    const r = await h.webhook(
      { id: "WH-F1", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: o.authorizationId } },
      { signed: false },
    );
    return { code: `webhook:${r.outcome}`, authorized: h.f.gate.orders.get(o.id)!.status !== "authorized" };
  },
});
