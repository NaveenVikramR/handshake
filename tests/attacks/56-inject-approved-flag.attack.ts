import { defineAttack } from "./harness.js";

export default defineAttack({
  id: "A56",
  title: "\"approved: true\" added to the authorization",
  category: "injection",
  spec: "Prompt injection in item note",
  expect: "SCHEMA_INVALID",
  async run(h) {
    const { request } = await h.happyPathRequest();
    (request.authorization as unknown as Record<string, unknown>).approved = true;
    return h.submit(h.resign(request));
  },
});
