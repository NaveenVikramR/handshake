import request from "supertest";
import { returnSecret } from "../../services/merchant/src/gate/settle.js";
import { ADMIN, USER } from "../../services/merchant/test/gate-fixture.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A95",
  title: "Owner's return on one order attaches a wallet another order saved",
  category: "identity",
  spec: "Saved wallet bound to the approving browser (D31)",
  expect: "vault:unbound",
  authorizations: 2,
  options: { noVault: true },
  async run(h) {
    const first = async () => {
      const { request: pr } = await h.happyPathRequest();
      const res = await h.f.pay(pr);
      const token = new URL((res.body as { approveUrl: string }).approveUrl).searchParams.get("token")!;
      h.f.paypal.approve(token);
      return { token, orderId: [...h.f.gate.orders.values()].at(-1)!.id };
    };
    const o1 = await first();
    const o2 = await first();
    const plainReturn = (token: string) => request(h.f.app).post("/paypal/return").send({ token });
    // O1 authorizes and saves its wallet; then O2 (a different PayPal approval) saves over it.
    await plainReturn(o1.token);
    await plainReturn(o2.token);
    // The owner's genuine return for O1 must not bind the wallet O2 saved.
    await request(h.f.app)
      .post("/paypal/return")
      .set("authorization", `Bearer ${ADMIN}`)
      .send({ token: o1.token, walletUserId: USER, r: returnSecret(h.f.ctx, o1.orderId) });
    return { code: `vault:${h.f.gate.vaults.get(USER)?.status ?? "none"}`, authorized: false };
  },
});
