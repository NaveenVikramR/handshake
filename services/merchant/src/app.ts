import express, { type Express } from "express";
import type { WebhookDeps } from "./webhooks/handler.js";
import { webhookRouter } from "./webhooks/router.js";

export interface AppDeps<Tx> {
  webhooks: WebhookDeps<Tx>;
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
  return app;
}
