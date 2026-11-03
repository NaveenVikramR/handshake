import request from "supertest";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A79",
  title: "Simulated webhook without the demo secret",
  category: "webhook",
  spec: "Forged webhook",
  expect: "webhook:unauthorized",
  authorizations: 1,
  async run(h) {
    const o = await h.capturedOrder();
    const res = await request(h.f.app)
      .post("/webhooks/paypal/simulate")
      .send({ event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "R9" } });
    const outcome = (res.body as { outcome?: string }).outcome;
    return { code: `webhook:${outcome}`, authorized: h.f.gate.orders.get(o.id)!.status !== "captured" };
  },
});
