import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A72",
  title: "Same request sent five times at once",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "DUPLICATE_REQUEST",
  authorizations: 1,
  async run(h) {
    const { request } = await h.happyPathRequest();
    await Promise.all(Array.from({ length: 5 }, () => h.f.pay(request)));
    const creates = h.paypalCalls("create").filter((c) => c.requestId === request.requestId).length;
    const orders = [...h.f.gate.orders.values()].filter((o) => o.requestId === request.requestId).length;
    return { code: creates === 1 && orders === 1 ? "DUPLICATE_REQUEST" : `CREATES_${creates}_ORDERS_${orders}`, authorized: creates > 1 };
  },
});
