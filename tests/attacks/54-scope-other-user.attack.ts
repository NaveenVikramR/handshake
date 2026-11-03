import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A54",
  title: "Mandate of another user",
  category: "mandate",
  spec: "Out-of-scope merchant/category",
  expect: "MANDATE_INVALID",
  async run(h) {
    const { request } = await h.mandatePath(undefined, { userId: "usr_bob" });
    return h.submit(request);
  },
});
