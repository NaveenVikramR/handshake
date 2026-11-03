import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A73",
  title: "Fulfil sent twice: one capture",
  category: "idempotency",
  spec: "Duplicate requestId",
  expect: "HTTP_409",
  authorizations: 1,
  async run(h) {
    const order = await h.authorizedOrder();
    await h.fulfil(order.id, { fulfilled: true });
    const again = await h.fulfil(order.id, { fulfilled: true });
    return { code: `HTTP_${again.status}`, authorized: h.paypalCalls("capture").length !== 1 };
  },
});
