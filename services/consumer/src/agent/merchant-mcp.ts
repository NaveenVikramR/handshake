// Stretch (D35): the same MerchantClient, spoken over MCP to the merchant's POST /mcp instead of
// its REST routes. Tool results carry `{status, body}`; `body` goes through exactly the parsers the
// HTTP client uses, so nothing from an MCP merchant is trusted any more than from a REST one:
// offers are still checked against the registry and its keys, names are still wrapped untrusted.
import { HandshakeError, isHandshakeError } from "@handshake/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { AgentCard, Catalog, OfferResponse, Outcome, merchantError, type MerchantClient } from "./merchant.js";

const TIMEOUT_MS = 15_000;
const ToolEnvelope = z.object({ status: z.int().min(100).max(599), body: z.unknown() });
const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
});

/** `baseUrl` is the merchant origin; the MCP endpoint is `${origin}/mcp`. */
export function mcpMerchantClient(baseUrl: string, doFetch: typeof fetch = fetch): MerchantClient {
  const origin = new URL(baseUrl).origin;
  // Same transport rules as the REST client: no redirects, bounded time per HTTP call.
  const guardedFetch: typeof fetch = (input, init) =>
    doFetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });

  async function tool<T>(schema: z.ZodType<T>, name: string, args: Record<string, unknown> = {}): Promise<T> {
    let envelope: z.infer<typeof ToolEnvelope>;
    const client = new Client({ name: "handshake-consumer", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), { fetch: guardedFetch }));
      const raw = ToolResult.parse(
        await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT_MS }),
      );
      const text = raw.content.find((c) => c.type === "text")?.text;
      envelope = ToolEnvelope.parse(JSON.parse(text ?? ""));
    } catch (e) {
      if (isHandshakeError(e)) throw e;
      throw new HandshakeError("MERCHANT_UNTRUSTED", "merchant MCP unreachable or sent an invalid result");
    } finally {
      await client.close().catch(() => undefined);
    }
    if (envelope.status >= 400) throw merchantError(envelope.status, envelope.body);
    const ok = schema.safeParse(envelope.body);
    if (!ok.success) throw new HandshakeError("MERCHANT_UNTRUSTED", `unexpected result from ${name}`);
    return ok.data;
  }

  return {
    baseUrl: origin,
    card: () => tool(AgentCard, "get_agent_card"),
    catalog: () => tool(Catalog, "get_catalog"),
    requestOffer: async (req) => (await tool(OfferResponse, "request_offer", { request: req })).offer,
    pay: (req) => tool(Outcome, "submit_payment", { request: req }),
    complete: (req) => tool(Outcome, "complete_payment", { requestId: req.requestId, request: req }),
  };
}
