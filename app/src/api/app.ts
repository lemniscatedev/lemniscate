import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { ApiDependencies } from "./types";
import { openApiDocument } from "./openapi";
import { registerAccountRoutes } from "./routes/accounts";
import { registerConfigRoutes } from "./routes/config";
import { registerCorporateActionRoutes } from "./routes/corp-actions";
import { registerEarningsRoutes } from "./routes/earnings";
import { registerHealthRoutes } from "./routes/health";
import { registerLeaderboardRoutes } from "./routes/leaderboard";
import { registerMarketRoutes } from "./routes/markets";
import { registerStatsRoutes } from "./routes/stats";
import { registerUpcomingRoutes } from "./routes/upcoming";
import { registerVaultRoutes } from "./routes/vault";
import { safeErrorSummary } from "../log";
import { rateLimit } from "./rate-limit";

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
      path: context.req.path,
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
  app.on(["POST", "PUT", "DELETE"], "/v1/*", writeLimiter);

  registerHealthRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerMarketRoutes(app, deps);
  registerAccountRoutes(app, deps);
  registerVaultRoutes(app, deps);
  registerCorporateActionRoutes(app, deps);
  registerEarningsRoutes(app, deps);
  registerUpcomingRoutes(app, deps);
  registerStatsRoutes(app, deps);
  registerLeaderboardRoutes(app, deps);

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
