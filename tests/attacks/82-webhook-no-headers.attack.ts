import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A82",
  title: "Webhook without PayPal's transmission headers",
  category: "webhook",
  spec: "Forged webhook",
  expect: "webhook:forged",
  authorizations: 1,
  async run(h) {
    const o = await h.authorizedOrder();
    const r = await h.webhook(
      { id: "WH-F3", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: o.authorizationId } },
      { headers: {} },
    );
    return { code: `webhook:${r.outcome}`, authorized: h.f.gate.orders.get(o.id)!.status !== "authorized" };
  },
});
