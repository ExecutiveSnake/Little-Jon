import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { analyzeToken } from "./proposals/service.js";
import {
  confirmProposal,
  getPosition,
  listPositions,
  markCancelled,
  type Position,
} from "./positions/store.js";
import { startWatcher } from "./watcher/watcher.js";
import type { TradePlan } from "./analysis/meteringClient.js";

/**
 * Little Jon CLI — the v1 user interface (a web UI can layer on the same modules
 * later). Every trade requires two explicit human steps: `analyze` to get a
 * proposal, `confirm --size` to arm it. Nothing trades without both.
 */

function printPlan(plan: TradePlan, currentPrice: number): void {
  console.log(`\n  confidence   ${plan.confidence}%`);
  console.log(`  direction    ${plan.direction ?? "-"} (spot)`);
  console.log(
    `  entry        ${plan.entryType === "market" ? `market (~${currentPrice})` : `trigger @ ${plan.entryPrice}`}`,
  );
  console.log(`  stop-loss    ${plan.stopLoss}`);
  console.log(`  take-profit  ${plan.takeProfit}`);
  console.log(`  1h           ${plan.timeframeNotes.h1}`);
  console.log(`  4h           ${plan.timeframeNotes.h4}`);
  console.log(`  1d           ${plan.timeframeNotes.d1}`);
  console.log(`\n  ${plan.rationale}`);
  if (plan.keyRisks.length > 0) {
    console.log(`\n  risks:`);
    for (const risk of plan.keyRisks) console.log(`   - ${risk}`);
  }
}

function printPosition(p: Position): void {
  const size = p.sizeUsd !== null ? `$${p.sizeUsd}` : "unsized";
  const pnl =
    p.realizedPnlUsd !== null
      ? ` pnl ${p.realizedPnlUsd >= 0 ? "+" : ""}$${p.realizedPnlUsd.toFixed(2)}`
      : "";
  console.log(
    `  #${p.id} ${p.symbol.padEnd(8)} ${p.status.padEnd(14)} ${size.padEnd(9)} ` +
      `SL ${p.stopLoss} TP ${p.takeProfit} conf ${p.confidence}%${pnl}`,
  );
}

function getFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "analyze": {
      const input = args.filter((a) => !a.startsWith("--"))[0];
      if (!input) throw new Error("usage: analyze <token address or name> [--news '...' ]");
      const news = args.filter((_, i) => args[i - 1] === "--news");

      console.log(`\nanalyzing ${input}…`);
      const result = await analyzeToken(input, news.length > 0 ? news : undefined);

      console.log(
        `\n${result.token.symbol} (${result.token.kind}) @ ${result.currentPrice} — ` +
          `${result.token.address}`,
      );

      if (result.proposal && result.outcome.plan) {
        printPlan(result.outcome.plan, result.currentPrice);
        console.log(
          `\n✅ proposal #${result.proposal.id} saved. To arm it:\n` +
            `   littlejon confirm ${result.proposal.id} --size <USD>\n`,
        );
      } else {
        const best = result.outcome.attempts.reduce(
          (max, plan) => Math.max(max, plan.confidence),
          0,
        );
        console.log(
          `\n❌ no setup ≥ ${result.outcome.threshold}% confidence after ` +
            `${result.outcome.attempts.length} attempt(s) (best: ${best}%). Not trading.`,
        );
        const last = result.outcome.attempts.at(-1);
        if (last) console.log(`   ${last.rationale}\n`);
      }
      break;
    }

    case "confirm": {
      const id = Number(args[0]);
      const size = Number(getFlag(args, "size"));
      if (!Number.isFinite(id) || !Number.isFinite(size) || size <= 0) {
        throw new Error("usage: confirm <proposalId> --size <USD>");
      }
      if (size > config.MAX_POSITION_SIZE_USD) {
        throw new Error(
          `size $${size} exceeds MAX_POSITION_SIZE_USD ($${config.MAX_POSITION_SIZE_USD})`,
        );
      }
      const position = confirmProposal(id, size, config.ENTRY_TRIGGER_TTL_HOURS * 3600);
      console.log(`\n✅ position #${position.id} armed with $${size}.`);
      console.log(
        position.entryType === "market"
          ? `   The watcher will enter at market on its next tick.`
          : `   The watcher will enter when price crosses ${position.entryTriggerPrice} ` +
              `(${position.triggerDirection}).`,
      );
      console.log(`   Make sure the watcher is running: littlejon watch\n`);
      break;
    }

    case "cancel": {
      const id = Number(args[0]);
      const position = getPosition(id);
      if (!position) throw new Error(`position ${id} not found`);
      if (position.status !== "proposed" && position.status !== "awaiting_entry") {
        throw new Error(
          `position ${id} is ${position.status} — open positions exit via SL/TP or 'exit' (not yet implemented for manual)`,
        );
      }
      markCancelled(id);
      console.log(`✅ position #${id} cancelled.`);
      break;
    }

    case "positions": {
      const all = args.includes("--all");
      const positions = all
        ? listPositions()
        : listPositions(["proposed", "awaiting_entry", "open"]);
      if (positions.length === 0) {
        console.log(all ? "no positions." : "no active positions (try --all).");
        break;
      }
      for (const p of positions) printPosition(p);
      break;
    }

    case "watch": {
      await startWatcher(); // runs until killed
      break;
    }

    case "ui": {
      const port = Number(getFlag(args, "port") ?? 8788);
      const { startUiServer } = await import("./ui/server.js");
      startUiServer(port);
      await new Promise(() => {}); // runs until killed
      break;
    }

    case "killswitch": {
      const mode = args[0];
      const killPath = config.KILL_SWITCH_PATH;
      if (mode === "on") {
        fs.mkdirSync(path.dirname(killPath), { recursive: true });
        fs.writeFileSync(killPath, new Date().toISOString());
        console.log(`🛑 kill switch ENGAGED (${killPath}) — all trading halted.`);
      } else if (mode === "off") {
        fs.rmSync(killPath, { force: true });
        console.log(`✅ kill switch disengaged.`);
      } else {
        console.log(`kill switch is ${fs.existsSync(killPath) ? "ON" : "off"}.`);
      }
      break;
    }

    default:
      console.log(`Little Jon — AI trading analysis bot for Robinhood Chain

usage:
  littlejon analyze <token>          find a setup (address or name; costs credits)
      [--news "headline" ...]        optionally pass curated context items
  littlejon confirm <id> --size <$>  arm a proposal with your position size
  littlejon cancel <id>              cancel a proposal / pending entry
  littlejon positions [--all]        list positions
  littlejon watch                    run the price watcher (required for entries/SL/TP)
  littlejon ui [--port 8788]         local web dashboard (localhost only)
  littlejon killswitch [on|off]      halt/resume all trading instantly
`);
  }
}

main().catch((err) => {
  console.error(`\nerror: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
