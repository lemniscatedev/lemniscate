import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { ApiDependencies } from "./types";
import { openApiDocument } from "./openapi";
import { registerCorporateActionRoutes } from "./routes/corp-actions";
import { registerAccountRoutes } from "./routes/accounts";
import { registerAccountActivityRoutes } from "./routes/account-activity";
import { registerChainRoutes } from "./routes/chains";
import { registerConfigRoutes } from "./routes/config";
import { registerHealthRoutes } from "./routes/health";
import { registerInviteRoutes } from "./routes/invites";
import { registerIntentUserOp } from "./routes/intent-userop";
import { registerPoolRoutes } from "./routes/pool";
import { registerQuoteRoutes } from "./routes/quote";
import { registerSeriesRoutes } from "./routes/series";
import { registerVolRoutes } from "./routes/vol";
import { registerUpcomingRoutes } from "./routes/upcoming";
import { safeErrorSummary } from "../log";
import { rateLimit } from "./rate-limit";
import { registerX402 } from "../x402";

export function createApiApp(deps: ApiDependencies) {
  const allowedOrigins = new Set(deps.config.CORS_ORIGINS);
  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (!result.success) {
        return context.json({ error: "BAD_REQUEST", message: "Invalid request parameters." }, 400);
      }
    },
  });

  app.use("*", cors({
    origin: (origin) => origin && allowedOrigins.has(origin) ? origin : "",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Cache-Control", "Content-Disposition", "X-Lemniscate-History-Complete", "X-Lemniscate-Truncated"],
    maxAge: 600,
    credentials: false,
  }));
  app.use("*", async (context, next) => {
    const startedAt = Date.now();
    await next();
    deps.logger.info({
      method: context.req.method,
      // The route pattern, never the concrete path: account addresses must not reach the logs.
      path: context.req.routePath,
      status: context.res.status,
      durationMs: Date.now() - startedAt,
    }, "API request");
  });
  app.use("*", rateLimit({
    limit: deps.config.API_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    clientIpHeader: deps.config.API_CLIENT_IP_HEADER,
  }));
  app.use("/v1/upcoming/*", async (context, next) => {
    if (context.req.method === "POST" || context.req.method === "DELETE") context.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/v1/upcoming/*", bodyLimit({ maxSize: 4 * 1024 }));
  const writeLimiter = rateLimit({
    limit: deps.config.API_RATE_LIMIT_PER_MINUTE === 0 ? 0 : 20,
    windowMs: 60_000,
    clientIpHeader: deps.config.API_CLIENT_IP_HEADER,
  });
  app.on(["POST", "PUT", "DELETE"], "/v1/upcoming/*", writeLimiter);
  // Quotes and intents are computed from Postgres and change nothing, so they get a roomier limit than signed writes.
  app.use("/v1/quote", bodyLimit({ maxSize: 4 * 1024 }));
  app.use("/v1/intent/*", bodyLimit({ maxSize: 4 * 1024 }));
  const quoteLimiter = rateLimit({
    limit: deps.config.API_RATE_LIMIT_PER_MINUTE === 0 ? 0 : 120,
    windowMs: 60_000,
    clientIpHeader: deps.config.API_CLIENT_IP_HEADER,
  });
  app.on(["POST"], ["/v1/quote", "/v1/intent/*"], quoteLimiter);

  // Invite redemption: a signed write, with a tight limit so codes cannot be guessed.
  app.use("/v1/invites/*", bodyLimit({ maxSize: 4 * 1024 }));
  app.on(["POST"], "/v1/invites/redeem", rateLimit({
    limit: deps.config.API_RATE_LIMIT_PER_MINUTE === 0 ? 0 : 10,
    windowMs: 60_000,
    clientIpHeader: deps.config.API_CLIENT_IP_HEADER,
  }));

  if (deps.x402) registerX402(app, deps.x402);

  registerHealthRoutes(app, deps);
  registerInviteRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerChainRoutes(app, deps);
  registerSeriesRoutes(app, deps);
  // Before the quote routes: its middleware rewrites /v1/intent/*?format=userop responses.
  registerIntentUserOp(app, deps);
  registerQuoteRoutes(app, deps);
  registerVolRoutes(app, deps);
  registerPoolRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerAccountActivityRoutes(app, deps);
  registerCorporateActionRoutes(app, deps);
  registerUpcomingRoutes(app, deps);

  app.get("/v1/openapi.json", (context) => {
    try {
      return context.json(app.getOpenAPI31Document(openApiDocument));
    } catch (error) {
      deps.logger.error({ err: safeErrorSummary(error) }, "OpenAPI document generation failed");
      return context.json({ error: "INTERNAL_ERROR", message: "OpenAPI document unavailable." }, 500);
    }
  });
  app.notFound((context) => context.json({ error: "NOT_FOUND", message: "Route not found." }, 404));
  app.onError((error, context) => {
    const record = error && typeof error === "object" ? error as { status?: unknown; apiError?: unknown } : undefined;
    const status = typeof record?.status === "number" && record.status >= 400 && record.status < 600 ? record.status : 500;
    const message = status < 500 ? error.message : "Internal server error.";
    deps.logger.error({ err: safeErrorSummary(error), status }, "API request failed");
    return context.json({
      error: typeof record?.apiError === "string" ? record.apiError : status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
      message,
    }, status as 400 | 404 | 422 | 429 | 500);
  });
  return app;
}
