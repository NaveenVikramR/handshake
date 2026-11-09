import express, { type ErrorRequestHandler, type Express } from "express";
import { chatRouter } from "./agent/routes.js";
import { approvalRouter } from "./approvals/routes.js";
import type { AppContext } from "./context.js";
import { demoRouter } from "./demo/routes.js";
import { mandateRouter } from "./mandates/routes.js";
import { passkeyRouter } from "./passkeys/routes.js";
import { sessionRouter } from "./sessions/routes.js";
import { walletRouter } from "./wallet/routes.js";

/** `demoSecret`: DEMO_MODE's attack demo (POST /demo/attack/:kind); absent → not mounted. */
export function createApp(ctx: AppContext, opts: { demoSecret?: string } = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(passkeyRouter(ctx));
  app.use(approvalRouter(ctx));
  app.use(mandateRouter(ctx));
  app.use(sessionRouter(ctx));
  app.use(chatRouter(ctx));
  app.use(walletRouter(ctx));
  if (opts.demoSecret) app.use(demoRouter(ctx, opts.demoSecret));

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
