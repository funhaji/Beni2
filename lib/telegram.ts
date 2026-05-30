import { env } from "./env.js";

function getApiBase() {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
}

export async function tg<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${getApiBase()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) {
    throw new Error(data.description || "Telegram API error");
  }
  return data.result as T;
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Send a file document to a Telegram chat using multipart/form-data.
 * Works for text/JSON files up to 50 MB.
 */
export async function tgSendDocument(opts: {
  chat_id: number;
  filename: string;
  content: string;
  mime_type?: string;
  caption?: string;
}): Promise<void> {
  const { chat_id, filename, content, mime_type = "application/octet-stream", caption } = opts;
  const formData = new FormData();
  formData.append("chat_id", String(chat_id));
  formData.append(
    "document",
    new Blob([content], { type: mime_type }),
    filename
  );
  if (caption) {
    formData.append("caption", caption);
  }
  const res = await fetch(`${getApiBase()}/sendDocument`, {
    method: "POST",
    body: formData
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(data.description || "Telegram sendDocument error");
  }
}

/**
 * Download a file from Telegram's servers using a file_id.
 * Returns the raw text content.
 */
export async function tgDownloadFile(fileId: string): Promise<string> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");

  const infoRes = await fetch(`${getApiBase()}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const info = (await infoRes.json()) as { ok: boolean; result?: { file_path?: string }; description?: string };
  if (!info.ok || !info.result?.file_path) {
    throw new Error(info.description || "getFile failed");
  }
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${info.result.file_path}`
  );
  if (!fileRes.ok) {
    throw new Error(`Failed to download file: ${fileRes.status} ${fileRes.statusText}`);
  }
  return fileRes.text();
}
