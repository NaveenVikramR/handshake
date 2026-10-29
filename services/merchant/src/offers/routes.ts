// SPEC §10: GET /.well-known/agent.json, GET /catalog, POST /offers.
import { isHandshakeError } from "@handshake/core";
import express, { Router } from "express";
import { agentCard, catalog, createOffer, type OfferContext } from "./service.js";

export function offerRouter(ctx: OfferContext): Router {
  const router = Router();

  router.get("/.well-known/agent.json", (_req, res) => {
    res.json(agentCard(ctx.self));
  });

  router.get("/catalog", async (_req, res) => {
    res.json({ merchantId: ctx.self.merchantId, products: catalog(await ctx.store.listProducts()) });
  });

  // JSON parsing on this route only: the webhook route needs the raw body.
  router.post("/offers", express.json({ limit: "32kb" }), async (req, res) => {
    try {
      const { offer, hash } = await createOffer(ctx, req.body);
      res.status(201).json({ offer, offerHash: hash });
    } catch (e) {
      if (isHandshakeError(e)) return void res.status(e.status).json({ error: e.code });
      throw e;
    }
  });

  return router;
}
