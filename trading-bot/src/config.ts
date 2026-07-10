import "dotenv/config";
import { z } from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const optionalAddress = addressSchema.optional();

/**
 * Little Jon trading-bot configuration.
 *
 * Known-good defaults are baked in for Robinhood Chain (chain ID 4663 mainnet /
 * 46630 testnet, per docs.robinhood.com/chain). Values that Robinhood/partners have
 * not published yet (Uniswap V2 router/factory, 0x RFQ endpoint, Chainlink feed
 * registry) are optional env vars — the features that depend on them disable
 * themselves with a clear error instead of guessing.
 */
const envSchema = z.object({
  // --- chain ---
  CHAIN_ID: z.coerce.number().int().positive().default(46630),
  CHAIN_RPC_URL: z.string().url().default("https://rpc.testnet.chain.robinhood.com"),
  BLOCKSCOUT_API_URL: z
    .string()
    .url()
    .default("https://explorer.testnet.chain.robinhood.com/api/v2"),

  // --- core token addresses (mainnet values; override for testnet) ---
  RHETH_ADDRESS: addressSchema.default("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  USDG_ADDRESS: addressSchema.default("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  MULTICALL3_ADDRESS: addressSchema.default("0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1"),
  PERMIT2_ADDRESS: addressSchema.default("0x000000000022D473030F116dDEE9F6B43aC78BA3"),

  // --- venue config (not yet published for Robinhood Chain; features gate on presence) ---
  UNIV2_FACTORY_ADDRESS: optionalAddress,
  UNIV2_ROUTER_ADDRESS: optionalAddress,
  ZEROX_RFQ_API_URL: z.string().url().optional(),
  ZEROX_API_KEY: z.string().optional(),

  // --- oracles ---
  /** Chainlink L2 sequencer uptime feed; strongly recommended on an Arbitrum chain. */
  SEQUENCER_UPTIME_FEED: optionalAddress,
  /** Chainlink ETH/USD feed — used to size and value rhETH-quoted positions in USD. */
  ETH_USD_FEED: optionalAddress,
  /** Max seconds since a Chainlink round update before the price is considered stale. */
  CHAINLINK_MAX_STALENESS_SEC: z.coerce.number().int().positive().default(3600),

  // --- metering / analysis ---
  METERING_SERVICE_URL: z.string().url().default("http://localhost:8787"),
  /** Confidence gate for proposing a trade. Hard floor of 65 is enforced below. */
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(100).default(65),
  /** Max Claude analysis passes per user request before giving up (each costs credits). */
  MAX_ANALYSIS_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),

  // --- execution (ZeroDev Kernel smart account) ---
  ZERODEV_RPC_URL: z.string().url().optional(),
  SESSION_KEY_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional(),
  SESSION_KEY_POLICY_PATH: z.string().default("./config/session-key-policy.json"),
  SMART_ACCOUNT_ADDRESS: optionalAddress,

  // --- watcher ---
  WATCHER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Pending trigger entries expire after this many hours if never hit. */
  ENTRY_TRIGGER_TTL_HOURS: z.coerce.number().positive().default(168),

  // --- risk guardrails ---
  MAX_POSITION_SIZE_USD: z.coerce.number().positive().default(1000),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(100),
  DAILY_LOSS_LIMIT_USD: z.coerce.number().positive().default(200),
  KILL_SWITCH_PATH: z.string().default("./config/KILL_SWITCH"),

  // --- storage / notify ---
  DB_PATH: z.string().default("./data/littlejon.db"),
  /** Optional webhook (Discord/Slack-compatible JSON POST) for trade notifications. */
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),

  LOG_LEVEL: z.string().default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid Little Jon configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  // The 65% floor is a product decision, not just a default — a lower env value is
  // clamped up rather than honored.
  CONFIDENCE_THRESHOLD: Math.max(65, parsed.data.CONFIDENCE_THRESHOLD),
};

export type Config = typeof config;
