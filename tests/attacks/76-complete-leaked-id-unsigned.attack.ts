import request from "supertest";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A76",
  title: "/complete with only a leaked requestId: no receipt",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "SCHEMA_INVALID",
  authorizations: 1,
  async run(h) {
    const { request: pr } = await h.happyPathRequest();
    await h.submit(pr);
    const res = await request(h.f.app).post(`/payments/${pr.requestId}/complete`).send({});
    const body = res.body as Record<string, unknown>;
    const leaked = Object.keys(body).some((k) => k !== "error");
    return { code: leaked ? "RECEIPT_LEAKED" : String(body.error), authorized: false };
  },
});
