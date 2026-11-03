import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A79",
  title: "Partial-refund webhook delivered twice",
  category: "webhook",
  spec: "Duplicate webhook",
  expect: "webhook:duplicate",
  authorizations: 1,
  async run(h) {
    const o = await h.capturedOrder();
    const ev = {
      id: "WH-DUP-2",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "R1",
        amount: { value: "4.00" },
        links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${o.captureId}` }],
      },
    };
    await h.webhook(ev);
    const second = await h.webhook(ev);
    return { code: `webhook:${second.outcome}`, authorized: h.f.gate.orders.get(o.id)!.refundedMinor !== 400 };
  },
});
