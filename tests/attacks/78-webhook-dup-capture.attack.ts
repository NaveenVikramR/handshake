import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A78",
  title: "Capture-completed webhook delivered twice",
  category: "webhook",
  spec: "Duplicate webhook",
  expect: "webhook:duplicate",
  authorizations: 1,
  async run(h) {
    const o = await h.capturedOrder();
    const ev = { id: "WH-DUP-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: o.captureId, status: "COMPLETED" } };
    await h.webhook(ev);
    const second = await h.webhook(ev);
    const after = h.f.gate.orders.get(o.id)!;
    return { code: `webhook:${second.outcome}`, authorized: after.status !== "captured" || h.paypalCalls("capture").length !== 1 };
  },
});
