import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A00",
  title: "Control: a valid passkey-approved request authorizes",
  category: "control",
  spec: "control",
  expect: "OK",
  expectAuthorized: true,
  async run(h) {
    const { request } = await h.happyPathRequest();
    return h.submit(request);
  },
});
