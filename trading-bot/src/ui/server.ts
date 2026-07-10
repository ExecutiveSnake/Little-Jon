import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { analyzeToken } from "../proposals/service.js";
import {
  confirmProposal,
  getPosition,
  listPositions,
  markCancelled,
} from "../positions/store.js";

/**
 * Little Jon local dashboard — a thin HTTP adapter over the exact same modules
 * the CLI uses (nothing here has its own trading logic). Runs on localhost and is
 * completely unauthenticated: NEVER expose this port to the internet; put it
 * behind your own auth/reverse-proxy if it must leave your machine.
 *
 * Endpoints:
 *   GET  /                      dashboard page
 *   GET  /api/positions?all=1   positions (active by default)
 *   POST /api/analyze           { token, chain?: 'robinhood'|'ethereum'|'solana', news?: string[] }
 *   POST /api/confirm           { id, sizeUsd }
 *   POST /api/cancel            { id }
 *   GET/POST /api/killswitch    { on }
 *
 * Cross-origin access (e.g. the LittleJohn wallet app) is opt-in via
 * UI_ALLOWED_ORIGINS, a comma-separated origin allowlist:
 *   UI_ALLOWED_ORIGINS="http://localhost:5173,capacitor://localhost" npm run ui
 * Any browser request carrying an Origin that is neither this server itself
 * nor allowlisted is rejected outright — this also blocks CSRF from random
 * websites driving the bot through the victim's browser (previously possible
 * via forced "simple" POSTs, since bodies were parsed regardless of
 * content-type). Requests without an Origin header (curl, scripts) are
 * unaffected.
 */

const allowedOrigins = new Set(
  (process.env.UI_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

/**
 * Returns false (request already answered with 403) when the Origin is
 * present and untrusted; otherwise sets CORS response headers as needed.
 */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const selfOrigin = `http://${req.headers.host}`;
  if (origin !== selfOrigin && !allowedOrigins.has(origin)) {
    json(res, 403, {
      error: `origin ${origin} not allowed; add it to UI_ALLOWED_ORIGINS to permit it`,
    });
    return false;
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  return true;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const uiDir = path.dirname(fileURLToPath(import.meta.url));

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!applyCors(req, res)) return;

  if (req.method === "OPTIONS") {
    // Preflight for allowlisted cross-origin callers. Chrome's Private
    // Network Access requires the extra header when an HTTPS page talks
    // to a localhost service.
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-max-age", "600");
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("access-control-allow-private-network", "true");
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(uiDir, "dashboard.html"), "utf8"));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/positions") {
    const positions =
      url.searchParams.get("all") === "1"
        ? listPositions()
        : listPositions(["proposed", "awaiting_entry", "open"]);
    json(res, 200, { positions, confidenceThreshold: config.CONFIDENCE_THRESHOLD });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/killswitch") {
    json(res, 200, { on: fs.existsSync(config.KILL_SWITCH_PATH) });
    return;
  }

  if (req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;

    if (url.pathname === "/api/analyze") {
      const token = String(body.token ?? "").trim();
      if (!token) return json(res, 400, { error: "token is required" });
      const news = Array.isArray(body.news)
        ? (body.news as string[]).filter((n) => typeof n === "string" && n.trim())
        : undefined;
      const chain = typeof body.chain === "string" && body.chain ? body.chain : "robinhood";
      const result = await analyzeToken(token, news, chain);
      return json(res, 200, {
        token: result.token,
        currentPrice: result.currentPrice,
        threshold: result.outcome.threshold,
        attempts: result.outcome.attempts,
        plan: result.outcome.plan,
        proposalId: result.proposal?.id ?? null,
      });
    }

    if (url.pathname === "/api/confirm") {
      const id = Number(body.id);
      const sizeUsd = Number(body.sizeUsd);
      if (!Number.isFinite(id) || !Number.isFinite(sizeUsd) || sizeUsd <= 0) {
        return json(res, 400, { error: "id and positive sizeUsd required" });
      }
      if (sizeUsd > config.MAX_POSITION_SIZE_USD) {
        return json(res, 400, {
          error: `size exceeds MAX_POSITION_SIZE_USD ($${config.MAX_POSITION_SIZE_USD})`,
        });
      }
      const position = confirmProposal(id, sizeUsd, config.ENTRY_TRIGGER_TTL_HOURS * 3600);
      return json(res, 200, { position });
    }

    if (url.pathname === "/api/cancel") {
      const id = Number(body.id);
      const position = getPosition(id);
      if (!position) return json(res, 404, { error: `position ${id} not found` });
      if (position.status !== "proposed" && position.status !== "awaiting_entry") {
        return json(res, 400, { error: `position is ${position.status}; cannot cancel` });
      }
      markCancelled(id);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/killswitch") {
      if (body.on) {
        fs.mkdirSync(path.dirname(config.KILL_SWITCH_PATH), { recursive: true });
        fs.writeFileSync(config.KILL_SWITCH_PATH, new Date().toISOString());
      } else {
        fs.rmSync(config.KILL_SWITCH_PATH, { force: true });
      }
      return json(res, 200, { on: fs.existsSync(config.KILL_SWITCH_PATH) });
    }
  }

  json(res, 404, { error: "not found" });
}

export function startUiServer(port = 8788): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err, url: req.url }, "ui request failed");
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  server.listen(port, "127.0.0.1", () => {
    logger.info({ port }, `Little Jon dashboard: http://127.0.0.1:${port}`);
  });
  return server;
}
