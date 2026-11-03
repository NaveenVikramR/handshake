import request from "supertest";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A69",
  title: "PayPal redirect path: /complete before the buyer approved",
  category: "idempotency",
  spec: "Replayed approval",
  expect: "HTTP_202",
  authorizations: 0,
  options: { noVault: true },
  async run(h) {
    const { request: pr } = await h.happyPathRequest();
    await h.f.pay(pr);
    const res = await request(h.f.app).post(`/payments/${pr.requestId}/complete`).send(pr);
    return { code: `HTTP_${res.status}`, authorized: h.totalAuthorizations() > 0 };
  },
});
