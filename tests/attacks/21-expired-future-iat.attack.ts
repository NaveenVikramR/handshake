import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A21",
  title: "Approval issued an hour in the future",
  category: "replay",
  spec: "Expired approval",
  expect: "APPROVAL_EXPIRED",
  async run(h) {
    const offer = await h.f.offer();
    const now = Math.floor(h.f.clock.t / 1000);
    return h.submit(h.f.passkeyRequest(offer, { iat: now + 3600, exp: now + 3900 }));
  },
});
