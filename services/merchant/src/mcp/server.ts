// Stretch (D35): the merchant agent's SPEC §10 buyer endpoints, also exposed as an MCP server at
// POST /mcp (Streamable HTTP, stateless, JSON responses). Every tool calls the same functions as
// the HTTP routes, so the verification gate, rate limit and error codes are identical; MCP is only
// a second transport. A tool's text is JSON `{status, body}` where `body` is exactly what the
// HTTP route would have returned and `status` its HTTP status.
import { isHandshakeError } from "@handshake/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Router } from "express";
import { z } from "zod";
import { completePayment, handlePayment } from "../gate/settle.js";
import type { GateContext } from "../gate/verify.js";
import { agentCard, catalog, createOffer, type OfferContext } from "../offers/service.js";

const RequestId = z.string().regex(/^req_[A-Za-z0-9_-]{1,64}$/);
/** Any JSON: its real schema is enforced by createOffer / the gate, so a bad shape is SCHEMA_INVALID as on REST. */
const SignedBody = z.unknown();

export const MCP_TOOLS = [
  "get_agent_card",
  "get_catalog",
  "request_offer",
  "submit_payment",
  "complete_payment",
] as const;

export interface McpDeps {
  offers: OfferContext;
  gate: GateContext;
  /** Shared with POST /payments/:id/complete so MCP is not a way around its limit. */
  completes: (key: string) => boolean;
}

function result(status: number, body: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ status, body }) }],
    ...(status >= 400 ? { isError: true } : {}),
  };
}

/** Like the app's error handler: a non-HandshakeError never reaches the caller as text. */
async function guarded(run: () => Promise<ReturnType<typeof result>>) {
  try {
    return await run();
  } catch (e) {
    if (isHandshakeError(e)) return result(e.status, { error: e.code });
    console.error("mcp tool error", e instanceof Error ? e.name : "unknown");
    return result(500, { error: "INTERNAL" });
  }
}

function buildServer(deps: McpDeps, clientKey: string): McpServer {
  const server = new McpServer({ name: "handshake-merchant", version: "1.0.0" });
  const { offers, gate } = deps;

  server.registerTool(
    "get_agent_card",
    { description: "Unsigned discovery hint: merchant ids and name. Verify against the trust registry." },
    async () => guarded(async () => result(200, agentCard(offers.self))),
  );

  server.registerTool("get_catalog", { description: "Products with prices in minor units (USD)." }, async () =>
    guarded(async () =>
      result(200, { merchantId: offers.self.merchantId, products: catalog(await offers.store.listProducts()) }),
    ),
  );

  server.registerTool(
    "request_offer",
    {
      description: "Send a signed offer_request; returns a merchant-signed offer.",
      inputSchema: { request: SignedBody },
    },
    async ({ request }) =>
      guarded(async () => {
        const { offer, hash } = await createOffer(offers, request);
        return result(201, { offer, offerHash: hash });
      }),
  );

  server.registerTool(
    "submit_payment",
    {
      description: "Send a signed payment_request (offer + passkey approval or mandate) to the verification gate.",
      inputSchema: { request: SignedBody },
    },
    async ({ request }) =>
      guarded(async () => {
        const r = await handlePayment(gate, request);
        return result(r.httpStatus, r.body);
      }),
  );

  server.registerTool(
    "complete_payment",
    {
      description: "Re-send the original signed payment_request after the buyer approved on PayPal.",
      inputSchema: { requestId: z.unknown(), request: SignedBody },
    },
    async ({ requestId, request }) =>
      guarded(async () => {
        if (!deps.completes(clientKey)) return result(429, { error: "RATE_LIMITED" });
        const id = RequestId.safeParse(requestId);
        if (!id.success) return result(400, { error: "SCHEMA_INVALID" });
        const r = await completePayment(gate, id.data, request);
        return result(r.httpStatus, r.body);
      }),
  );

  return server;
}

export function mcpRouter(deps: McpDeps): Router {
  const router = Router();
  router.post("/mcp", express.json({ limit: "64kb" }), async (req, res) => {
    // Stateless: a fresh server and transport per request, nothing kept between calls.
    const server = buildServer(deps, req.ip ?? "unknown");
    // No sessionIdGenerator: stateless mode, no Mcp-Session-Id issued.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  // Stateless server: no SSE stream to open and no session to end.
  router.all("/mcp", (_req, res) => {
    res.status(405).set("allow", "POST").json({ error: "METHOD_NOT_ALLOWED" });
  });
  return router;
}
