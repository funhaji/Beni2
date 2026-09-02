import dns from "node:dns";
try {
    dns.setDefaultResultOrder("ipv4first");
}
catch {
    /* ignore */
}
import { env } from "./env.js";
import { fetchQrImageBuffer, fetchWithProxyFallback, getAgentForUrl, getDirectHttpsAgent, getTelegramApiBases } from "./proxy.js";
function getApiBaseFromRoot(root) {
    if (!env.TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    }
    return `${root}/bot${env.TELEGRAM_BOT_TOKEN}`;
}
function telegramMethodUrl(method, apiRoot) {
    const root = apiRoot || getTelegramApiBases()[0];
    return `${getApiBaseFromRoot(root)}/${method}`;
}
async function tgRequest(method, body, headers) {
    const bases = getTelegramApiBases();
    let lastError;
    for (const root of bases) {
        const url = telegramMethodUrl(method, root);
        const isForm = body instanceof FormData;
        try {
            const res = await fetchWithProxyFallback(url, {
                method: "POST",
                headers: isForm ? headers : { "Content-Type": "application/json", ...headers },
                body: isForm ? body : JSON.stringify(body || {})
            });
            const data = (await res.json());
            if (data.ok)
                return data.result;
            lastError = new Error(data.description || "Telegram API error");
        }
        catch (error) {
            lastError = error;
            /* try next API base / fallback path inside fetchWithProxyFallback already ran */
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
export async function tg(method, body) {
    return tgRequest(method, body);
}
export function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
/**
 * Send a file document to a Telegram chat using multipart/form-data.
 */
export async function tgSendDocument(opts) {
    const { chat_id, filename, content, mime_type = "application/octet-stream", caption } = opts;
    const formData = new FormData();
    formData.append("chat_id", String(chat_id));
    formData.append("document", new Blob([content], { type: mime_type }), filename);
    if (caption)
        formData.append("caption", caption);
    await tgRequest("sendDocument", formData);
}
/**
 * Send photo from URL, downloaded bytes (via proxy), or Telegram file_id.
 */
export async function tgSendPhoto(opts) {
    const { chat_id, photo, parse_mode, caption, reply_markup } = opts;
    const trimmed = String(photo || "").trim();
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const res = await fetchWithProxyFallback(trimmed, { method: "GET" }, { timeoutMs: 15_000 });
            if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > 100) {
                    const formData = new FormData();
                    formData.append("chat_id", String(chat_id));
                    formData.append("photo", new Blob([new Uint8Array(buf)], { type: "image/png" }), "photo.png");
                    if (parse_mode)
                        formData.append("parse_mode", parse_mode);
                    if (caption)
                        formData.append("caption", caption);
                    if (reply_markup)
                        formData.append("reply_markup", JSON.stringify(reply_markup));
                    await tgRequest("sendPhoto", formData);
                    return;
                }
            }
        }
        catch {
            /* fall through to Telegram URL fetch */
        }
    }
    await tg("sendPhoto", {
        chat_id,
        photo: trimmed,
        ...(parse_mode ? { parse_mode } : {}),
        ...(caption ? { caption } : {}),
        ...(reply_markup ? { reply_markup } : {})
    });
}
/**
 * Send QR code for config text — downloads image through proxy when needed.
 */
export async function tgSendConfigQr(opts) {
    const text = String(opts.qrText || "").trim();
    const buf = await fetchQrImageBuffer(text);
    if (buf) {
        const formData = new FormData();
        formData.append("chat_id", String(opts.chat_id));
        formData.append("photo", new Blob([new Uint8Array(buf)], { type: "image/png" }), "config-qr.png");
        if (opts.parse_mode)
            formData.append("parse_mode", opts.parse_mode);
        if (opts.caption)
            formData.append("caption", opts.caption);
        if (opts.reply_markup)
            formData.append("reply_markup", JSON.stringify(opts.reply_markup));
        await tgRequest("sendPhoto", formData);
        return;
    }
    const { qrCodeUrl } = await import("./proxy.js");
    await tg("sendPhoto", {
        chat_id: opts.chat_id,
        photo: qrCodeUrl(text),
        ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}),
        ...(opts.caption ? { caption: opts.caption } : {}),
        ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {})
    });
}
/**
 * Download a file from Telegram's servers using a file_id.
 */
export async function tgDownloadFile(fileId) {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token)
        throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    const info = await tg("getFile", { file_id: fileId });
    if (!info?.file_path)
        throw new Error("getFile failed");
    const bases = getTelegramApiBases();
    let lastError;
    for (const root of bases) {
        const fileUrl = `${root}/file/bot${token}/${info.file_path}`;
        try {
            const fileRes = await fetchWithProxyFallback(fileUrl, { method: "GET" });
            if (fileRes.ok)
                return fileRes.text();
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Failed to download Telegram file");
}
export { getDirectHttpsAgent, getAgentForUrl };
