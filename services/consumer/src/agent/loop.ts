// The planner loop (SPEC §5.2 steps 1–5): the LLM chooses tools, code does everything that matters.
import { readFileSync } from "node:fs";
import type { AgentConfig, AppContext } from "../context.js";
import type { PlannerMessage } from "./planner.js";
import { TOOL_SPECS, runTool, type AgentEvent, type ChatSession } from "./tools.js";

export const MAX_TOOL_ROUNDS = 6;
const MAX_CALLS_PER_ROUND = 4;

const SYSTEM_PROMPT = readFileSync(new URL("./prompts/system.md", import.meta.url), "utf8");

export interface ChatInput {
  userId: string;
  message: string;
  /** hash(ShipTo) from the signed-in wallet request; absent → the mandate's. */
  shipToHash?: string;
}

/** Log line per tool call: name and ids only, never payloads (rules/llm.md). */
function idsOf(raw: string): Record<string, string> {
  try {
    const a = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      ["merchantId", "offerId"].flatMap((k) => (typeof a[k] === "string" ? [[k, (a[k] as string).slice(0, 80)]] : [])),
    );
  } catch {
    return {};
  }
}

export async function runChat(
  ctx: AppContext,
  agent: AgentConfig,
  input: ChatInput,
  emit: (e: AgentEvent) => void,
  opts: { signal?: AbortSignal; log?: (msg: string, fields: object) => void } = {},
): Promise<void> {
  const log = opts.log ?? ((msg, fields) => console.log(msg, JSON.stringify(fields)));
  const session: ChatSession = {
    userId: input.userId,
    shipToHash: input.shipToHash,
    merchants: new Map(),
    offers: new Map(),
    paid: new Set(),
    mandateCheckouts: 0,
    emit,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const messages: PlannerMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: input.message },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (opts.signal?.aborted) return;
    const { content, toolCalls } = await agent.planner.next(messages, TOOL_SPECS);
    messages.push({ role: "assistant", content, toolCalls });
    if (toolCalls.length === 0) {
      emit({ type: "message", text: content ?? "" });
      return;
    }
    for (const [i, call] of toolCalls.entries()) {
      const result =
        i < MAX_CALLS_PER_ROUND
          ? await (async () => {
              const ids = idsOf(call.arguments);
              emit({ type: "tool", name: call.name, ids });
              log("agent tool", { user: input.userId, tool: call.name, ...ids });
              return runTool(ctx, agent, session, call.name, call.arguments);
            })()
          : { error: "TOO_MANY_CALLS" };
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
    }
  }
  emit({ type: "error", error: "TOOL_ROUND_LIMIT" });
}
