import express from "express";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getOnChainCreditBalance } from "../chain/contract.js";
import { InsufficientCreditsError, processAnalysisRequest } from "./meteringService.js";

const candleSchema = z.object({
  t: z.number().int().nonnegative(),
  o: z.number().positive(),
  h: z.number().positive(),
  l: z.number().positive(),
  c: z.number().positive(),
  v: z.number().nonnegative().default(0),
});

const analyzeRequestSchema = z.object({
  idempotencyKey: z.string().min(8),
  userAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  calls: z.number().int().positive().default(1),
  symbol: z.string().min(1),
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  kind: z.enum(["stock-token", "lp-token", "major"]),
  currentPrice: z.number().positive(),
  asOf: z.string().datetime({ offset: true }),
  candles: z.object({
    h1: z.array(candleSchema),
    h4: z.array(candleSchema),
    d1: z.array(candleSchema),
  }),
  attempt: z.number().int().positive().optional(),
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

    const { idempotencyKey, userAddress, calls, ...analysisPayload } = parsed.data;

    try {
      const result = await processAnalysisRequest(idempotencyKey, userAddress, calls, analysisPayload);
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
