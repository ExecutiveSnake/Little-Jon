import { logger } from "./logger.js";
import { startServer } from "./api/server.js";
import { initDepositIndexer } from "./chain/listener.js";

async function main() {
  await initDepositIndexer();
  startServer();
}

main().catch((err) => {
  logger.error({ err }, "fatal error during startup");
  process.exit(1);
});
