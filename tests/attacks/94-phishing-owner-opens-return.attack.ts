import request from "supertest";
import { ADMIN, USER } from "../../services/merchant/test/gate-fixture.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A94",
  title: "Phishing order owner opens the PayPal return in their own signed-in browser (no return secret)",
  category: "identity",
  spec: "Saved wallet bound to the approving browser (D31)",
  expect: "vault:unbound",
  authorizations: 1,
  options: { noVault: true },
  async run(h) {
    // The attacker owns the order and sent its approve link to a victim, who approved on PayPal.
    const { request: pr } = await h.happyPathRequest();
    const res = await h.f.pay(pr);
    const token = new URL((res.body as { approveUrl: string }).approveUrl).searchParams.get("token")!;
    h.f.paypal.approve(token);
    // The attacker's browser: their session (the web server vouches for them), PayPal's token, but not
    // the return URL's secret, which PayPal sent only to the victim's browser.
    const back = (r?: string) =>
      request(h.f.app)
        .post("/paypal/return")
        .set("authorization", `Bearer ${ADMIN}`)
        .send({ token, walletUserId: USER, ...(r ? { r } : {}) });
    await back();
    await back("A".repeat(43));
    return { code: `vault:${h.f.gate.vaults.get(USER)?.status ?? "none"}`, authorized: false };
  },
});
