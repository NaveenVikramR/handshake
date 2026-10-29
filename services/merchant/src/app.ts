import express, { type ErrorRequestHandler, type Express } from "express";
import { offerRouter } from "./offers/routes.js";
import type { OfferContext } from "./offers/service.js";
import type { WebhookDeps } from "./webhooks/handler.js";
import { webhookRouter } from "./webhooks/router.js";

export interface AppDeps<Tx> {
  webhooks: WebhookDeps<Tx>;
  /** Agent card, catalog and offers; omitted by webhook-only tests. */
  offers?: OfferContext;
  demoMode: boolean;
  demoSecret?: string;
}

// No global body parser: the webhook route needs the raw bytes.
export function createApp<Tx>(deps: AppDeps<Tx>): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(
    webhookRouter(deps.webhooks, {
      demoMode: deps.demoMode,
      ...(deps.demoSecret === undefined ? {} : { demoSecret: deps.demoSecret }),
    }),
  );
  if (deps.offers) app.use(offerRouter(deps.offers));

  // Never return stacks: bad JSON is a schema error, anything else a bare 500.
  const onError: ErrorRequestHandler = (err: { type?: string }, _req, res, _next) => {
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
      return void res.status(400).json({ error: "SCHEMA_INVALID" });
    }
    console.error("unhandled error", err instanceof Error ? err.name : "unknown");
    res.status(500).json({ error: "INTERNAL" });
  };
  app.use(onError);
  return app;
}
