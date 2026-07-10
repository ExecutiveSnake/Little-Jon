import express from "express";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getOnChainCreditBalance } from "../chain/contract.js";
import { InsufficientCreditsError, processAnalysisRequest } from "./meteringService.js";

const priceContextSchema = z.object({
  currentPrice: z.number().positive(),
  asOf: z.string().datetime({ offset: true }),
  recentHistory: z
    .array(z.object({ price: z.number().positive(), timestamp: z.string().datetime({ offset: true }) }))
    .optional(),
});

const analyzeRequestSchema = z.object({
  idempotencyKey: z.string().min(8),
  userAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  calls: z.number().int().positive().default(1),
  symbol: z.string().min(1),
  kind: z.enum(["token", "stock-token"]),
  priceContext: priceContextSchema,
  // Manually curated by the caller/operator — this service never fetches news/social
  // data itself. See analysisClient.ts for why.
  newsContext: z.array(z.string()).optional(),
});

export function createServer() {
  const app = express();
  app.use(express.json());

  // This API is internal — it is expected to sit behind an auth/gateway layer (mTLS,
  // VPC-only, or a service-to-service token) that authenticates the trading bot /
  // frontend caller. It is not meant to be exposed directly to end users.

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/v1/credits/:address", async (req, res) => {
    const address = req.params.address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: "invalid address" });
    }
    try {
      const balance = await getOnChainCreditBalance(address);
      res.json({ address, credits: balance.toString() });
    } catch (err) {
      logger.error({ err, address }, "failed to read credit balance");
      res.status(502).json({ error: "failed to read credit balance" });
    }
  });

  app.post("/v1/analyze", async (req, res) => {
    const parsed = analyzeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { idempotencyKey, userAddress, calls, symbol, kind, priceContext, newsContext } =
      parsed.data;

    try {
      const result = await processAnalysisRequest(idempotencyKey, userAddress, calls, {
        symbol,
        kind,
        priceContext,
        newsContext,
      });
      res.json({ idempotencyKey, result });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(402).json({
          error: "insufficient_credits",
          available: err.available.toString(),
          required: err.required.toString(),
        });
      }
      logger.error({ err, idempotencyKey, userAddress }, "analyze request failed");
      res.status(502).json({ error: "analysis_failed", idempotencyKey });
    }
  });

  return app;
}

export function startServer() {
  const app = createServer();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "metering service listening");
  });
  return server;
}
