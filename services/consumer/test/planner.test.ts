import { describe, expect, it } from "vitest";
import { openAIPlanner } from "../src/agent/planner.js";
import { TOOL_SPECS } from "../src/agent/tools.js";

describe("openAIPlanner", () => {
  it("sends tools and tool results in chat-completions form and maps tool calls back", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "t1", type: "function", function: { name: "checkout", arguments: '{"offerId":"off_1"}' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    const planner = openAIPlanner({ baseURL: "https://llm.example/v1", apiKey: "k", model: "m", fetch });
    const out = await planner.next(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, toolCalls: [{ id: "t0", name: "discover_merchants", arguments: "{}" }] },
        { role: "tool", toolCallId: "t0", content: '{"merchants":[]}' },
      ],
      TOOL_SPECS,
    );
    expect(out).toEqual({ content: null, toolCalls: [{ id: "t1", name: "checkout", arguments: '{"offerId":"off_1"}' }] });
    expect(sent[0]?.url).toBe("https://llm.example/v1/chat/completions");
    const body = sent[0]!.body as { model: string; messages: { role: string; tool_call_id?: string }[]; tools: unknown[] };
    expect(body.model).toBe("m");
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[3]?.tool_call_id).toBe("t0");
    expect(body.tools).toHaveLength(TOOL_SPECS.length);
  });

  it("retries a Groq tool_use_failed (400) up to twice, then gives up; other 400s are not retried", async () => {
    const ok = {
      id: "c1",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
    };
    const failed = { error: { message: "Failed to call a function", type: "invalid_request_error", code: "tool_use_failed" } };
    const scripted = (bodies: [number, object][]) => {
      let n = 0;
      const f = (async () => {
        const [status, body] = bodies[Math.min(n++, bodies.length - 1)]!;
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      return { f, calls: () => n };
    };
    const once = scripted([[400, failed], [200, ok]]);
    const p1 = openAIPlanner({ baseURL: "https://llm.example/v1", apiKey: "k", model: "m", fetch: once.f });
    expect((await p1.next([{ role: "user", content: "hi" }], TOOL_SPECS)).content).toBe("done");
    expect(once.calls()).toBe(2);

    const always = scripted([[400, failed]]);
    const p2 = openAIPlanner({ baseURL: "https://llm.example/v1", apiKey: "k", model: "m", fetch: always.f });
    await expect(p2.next([{ role: "user", content: "hi" }], TOOL_SPECS)).rejects.toMatchObject({ status: 400 });
    expect(always.calls()).toBe(3);

    const other = scripted([[400, { error: { message: "bad", code: "invalid_value" } }]]);
    const p3 = openAIPlanner({ baseURL: "https://llm.example/v1", apiKey: "k", model: "m", fetch: other.f });
    await expect(p3.next([{ role: "user", content: "hi" }], TOOL_SPECS)).rejects.toMatchObject({ status: 400 });
    expect(other.calls()).toBe(1);
  });
});
