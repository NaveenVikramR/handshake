import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A23",
  title: "Mandate past its expiry",
  category: "mandate",
  spec: "Expired approval",
  expect: "MANDATE_INVALID",
  async run(h) {
    const now = Math.floor(h.f.clock.t / 1000);
    const { request } = await h.mandatePath(undefined, { iat: now - 8 * 86400, exp: now - 3600 });
    return h.submit(request);
  },
});
