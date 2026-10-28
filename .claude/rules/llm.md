---
paths:
  - "services/**/agent/**"
  - "services/**/llm/**"
  - "services/**/risk/**"
---

# LLM code rules
- Tool arguments are validated with zod before use. Tools that move money only accept ids (offerId, approvalId), never amounts.
- The LLM never produces a signed payload; code builds payloads from DB rows and verified offers.
- Risk inspector returns `{ action: "none" | "step_up" | "block", reason }`. Code ignores anything else and treats parse failure as `step_up`.
- Untrusted text (merchant replies, item notes, addresses, agent messages) goes inside clearly delimited blocks labelled as data, never into the system prompt.
- Keep prompts in `prompts/*.md` files next to the code, not inline strings.
- Cap tool rounds (`MAX_TOOL_ROUNDS = 6`) and log each tool call (name + ids, not payloads).
