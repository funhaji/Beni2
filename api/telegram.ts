import type { VercelRequest, VercelResponse } from "@vercel/node";
import dns from "node:dns";
// Fix for Node 18+ fetch failing on IPv6-only or broken IPv6 environments
try { dns.setDefaultResultOrder("ipv4first"); } catch (e) {}

import { handleTelegramUpdate } from "../lib/bot.js";
import { ensureSchema } from "../lib/db.js";
import { tg } from "../lib/telegram.js";
import { logError } from "../lib/log.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  // On a VPS (long-running process), we should acknowledge the Telegram webhook immediately.
  // This prevents Telegram from thinking the bot is slow and throttling updates.
  // On Vercel, we cannot do this because the serverless function freezes as soon as we respond.
  if (!process.env.VERCEL) {
    res.status(200).json({ ok: true });
  }

  try {
    await ensureSchema();
    await handleTelegramUpdate(req.body);
    
    if (process.env.VERCEL) {
      res.status(200).json({ ok: true });
    }
  } catch (error) {
    logError("telegram_webhook_failed", error, {
      method: req.method,
      hasBody: Boolean(req.body),
      updateId: req.body?.update_id
    });
    
    // Attempt to notify the user that an internal error occurred so they don't face silent failure
    try {
      const chatId = req.body?.message?.chat?.id || req.body?.callback_query?.message?.chat?.id;
      if (chatId) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "❌ متاسفانه خطایی در سرور رخ داد. لطفا مجدداً تلاش کنید."
        });
      }
    } catch (e) {
      // Ignore errors here (e.g. if user blocked bot)
    }

    if (process.env.VERCEL) {
      res.status(200).json({ ok: false, error: String((error as Error).message || error) });
    }
  }
}
