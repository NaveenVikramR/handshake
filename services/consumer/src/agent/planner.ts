// The LLM seen by the agent loop. It picks tools and writes prose; it never sees signed payloads
// and has no tool that takes an amount, payee or approval (rule 2, SPEC §8).
import OpenAI from "openai";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it; parsed and validated by the tool. */
  arguments: string;
}

export type PlannerMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface Planner {
  next(messages: PlannerMessage[], tools: ToolSpec[]): Promise<{ content: string | null; toolCalls: ToolCall[] }>;
}

/** OpenAI-compatible chat completions (LLM_BASE_URL / LLM_MODEL, e.g. Groq). */
export function openAIPlanner(opts: { baseURL: string; apiKey: string; model: string; fetch?: typeof fetch }): Planner {
  const client = new OpenAI({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    timeout: 30_000,
    maxRetries: 1,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return {
    async next(messages, tools) {
      const res = await client.chat.completions.create({
        model: opts.model,
        temperature: 0,
        messages: messages.map((m) => {
          if (m.role === "tool") return { role: "tool" as const, tool_call_id: m.toolCallId, content: m.content };
          if (m.role === "assistant") {
            return {
              role: "assistant" as const,
              content: m.content,
              ...(m.toolCalls?.length
                ? {
                    tool_calls: m.toolCalls.map((c) => ({
                      id: c.id,
                      type: "function" as const,
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  }
                : {}),
            };
          }
          return { role: m.role, content: m.content };
        }),
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      });
      const msg = res.choices[0]?.message;
      return {
        content: msg?.content ?? null,
        toolCalls: (msg?.tool_calls ?? []).flatMap((c) =>
          c.type === "function" ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [],
        ),
      };
    },
  };
}
