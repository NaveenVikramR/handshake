// POST /chat (SPEC §10): the agent loop for the signed-in user, streamed as server-sent events.
import { ShipTo, shipToHash } from "@handshake/core";
import express, { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requireSession } from "../sessions/routes.js";
import { runChat } from "./loop.js";

// The address comes from the wallet UI, not the model; the user is the session's, not the body's.
const ChatBody = z.strictObject({ message: z.string().trim().min(1).max(2000), shipTo: ShipTo.optional() });

export function chatRouter(ctx: AppContext): Router {
  const router = Router();
  const agent = ctx.agent;
  if (!agent) return router;

  router.post("/chat", express.json({ limit: "16kb" }), requireSession(ctx), async (req, res) => {
    const body = ChatBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "SCHEMA_INVALID" });
    const userId = res.locals.userId as string;

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const send = (e: { type: string }) => {
      if (!res.writableEnded) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    try {
      await runChat(
        ctx,
        agent,
        {
          userId,
          message: body.data.message,
          ...(body.data.shipTo ? { shipToHash: shipToHash(body.data.shipTo) } : {}),
        },
        send,
        { signal: abort.signal },
      );
    } catch (e) {
      console.error("chat failed", e instanceof Error ? e.name : "unknown");
      send({ type: "error", error: "INTERNAL" } as { type: string });
    }
    send({ type: "done" });
    res.end();
  });

  return router;
}
