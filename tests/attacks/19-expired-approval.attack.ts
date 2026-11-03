import { CLOCK_SKEW_S } from "../../packages/core/src/index.js";
import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A19",
  title: "Approval already expired",
  category: "replay",
  spec: "Expired approval",
  expect: "APPROVAL_EXPIRED",
  async run(h) {
    const offer = await h.f.offer();
    const now = Math.floor(h.f.clock.t / 1000);
    // Past the clock-skew allowance, not just past exp.
    const exp = now - CLOCK_SKEW_S - 5;
    return h.submit(h.f.passkeyRequest(offer, { iat: exp - 240, exp }));
  },
});
