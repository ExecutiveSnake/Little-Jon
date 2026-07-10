import "dotenv/config";
import { z } from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const envSchema = z.object({
  CHAIN_RPC_URL: z.string().url(),
  BUNDLER_RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().nonnegative(),

  ENTRYPOINT_ADDRESS: addressSchema,
  SMART_ACCOUNT_ADDRESS: addressSchema,
  SMART_ACCOUNT_FACTORY_ADDRESS: addressSchema,

  SESSION_KEY_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  SESSION_KEY_POLICY_PATH: z.string().default("./config/session-key-policy.json"),

  CHAINLINK_FEED_REGISTRY: addressSchema,

  METERING_SERVICE_URL: z.string().url(),

  MAX_POSITION_SIZE_USD: z.coerce.number().positive().default(1000),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(50),
  DAILY_LOSS_LIMIT_USD: z.coerce.number().positive().default(200),
  KILL_SWITCH_PATH: z.string().default("./config/KILL_SWITCH"),

  LOG_LEVEL: z.string().default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid trading-bot configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
