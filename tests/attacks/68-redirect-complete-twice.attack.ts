import request from "supertest";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A68",
  title: "PayPal redirect path: /complete sent twice authorizes once",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "DUPLICATE_REQUEST",
  authorizations: 1,
  options: { noVault: true },
  async run(h) {
    const { request: pr } = await h.happyPathRequest();
    const res = await h.f.pay(pr);
    const token = new URL((res.body as { approveUrl: string }).approveUrl).searchParams.get("token")!;
    h.f.paypal.approve(token);
    const complete = () => request(h.f.app).post(`/payments/${pr.requestId}/complete`).send(pr);
    const first = await complete();
    const again = await complete();
    const same = JSON.stringify(first.body) === JSON.stringify(again.body);
    return { code: again.status === 200 && same ? "DUPLICATE_REQUEST" : `HTTP_${again.status}`, authorized: false };
  },
});
