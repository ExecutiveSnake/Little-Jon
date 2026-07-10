import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Trade notifications: always logged to the console; additionally POSTed to
 * NOTIFY_WEBHOOK_URL when set ({"content": "..."} — Discord-compatible, and most
 * webhook receivers accept the same shape). Notification failures never block or
 * fail the underlying trade action; they are logged and dropped.
 */
export async function notify(title: string, body: string): Promise<void> {
  const message = `🏹 Little Jon — ${title}\n${body}`;
  logger.info({ notification: title }, message);

  if (!config.NOTIFY_WEBHOOK_URL) return;
  try {
    await fetch(config.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    logger.error({ err }, "notification webhook failed (ignored)");
  }
}
