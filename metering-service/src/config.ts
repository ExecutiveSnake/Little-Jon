import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  ALCHEMY_WSS_URL: z.string().url(),
  ALCHEMY_HTTPS_URL: z.string().url(),
  ANALYSIS_CREDITS_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  MODEL_API_URL: z.string().url(),
  MODEL_API_KEY: z.string().min(1),
  IDEMPOTENCY_DB_PATH: z.string().default("./data/metering.db"),
  PORT: z.coerce.number().int().positive().default(8787),
  DEPOSIT_BACKFILL_BLOCKS: z.coerce.number().int().nonnegative().default(5000),
  LOG_LEVEL: z.string().default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid metering-service configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
