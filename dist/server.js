#!/usr/bin/env node
/**
 * VPS / self-hosted entry point.
 *
 * Usage:
 *   npm run build && npm start
 *
 * Environment variables:
 *   PORT              HTTP port to listen on (default: 3000)
 *   DATABASE_URL      Standard PostgreSQL URL  e.g. postgres://user:pass@127.0.0.1:5432/botdb
 *   TELEGRAM_BOT_TOKEN
 *   PUBLIC_BASE_URL   Your public HTTPS URL (e.g. https://bot.example.com) — used for webhook setup
 *   ADMIN_IDS         Comma-separated Telegram admin IDs
 *
 * On startup the server automatically calls Telegram's setWebhook API to point
 * your bot at <PUBLIC_BASE_URL>/api/telegram.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./lib/db.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
};
function serveStatic(pathname, res) {
    // Strip leading slash, resolve against public dir, prevent traversal
    const rel = pathname.replace(/^\/+/, "") || "index.html";
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR))
        return false;
    // If no extension, try adding .html
    const candidates = [filePath, filePath + ".html", path.join(filePath, "index.html")];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const ext = path.extname(candidate);
            const mime = MIME[ext] || "application/octet-stream";
            res.writeHead(200, { "Content-Type": mime });
            fs.createReadStream(candidate).pipe(res);
            return true;
        }
    }
    return false;
}
const ROUTES = {
    "/api/telegram": () => import("./api/telegram.js").then((m) => m.default),
    "/api/health": () => import("./api/health.js").then((m) => m.default),
    "/api/logs": () => import("./api/logs.js").then((m) => m.default),
    "/api/backup": () => import("./api/backup.js").then((m) => m.default),
    "/api/restore": () => import("./api/restore.js").then((m) => m.default),
    "/api/reachability": () => import("./api/reachability.js").then((m) => m.default),
    "/api/find-dead": () => import("./api/find-dead.js").then((m) => m.default),
    "/api/panel-action": () => import("./api/panel-action.js").then((m) => m.default),
    "/api/migrate": () => import("./api/migrate.js").then((m) => m.default),
    "/api/marzban-install": () => import("./api/marzban-install.js").then((m) => m.default),
    "/api/test-approve": () => import("./api/test-approve.js").then((m) => m.default),
    "/api/payment-callback": () => import("./api/payment-callback.js").then((m) => m.default),
    // Legacy paths — rewrite query param so the unified handler can route them
    "/api/plisio-callback": () => import("./api/payment-callback.js").then((m) => {
        const h = m.default;
        return (req, res) => { req.query = { ...req.query, provider: "plisio" }; return h(req, res); };
    }),
    "/api/tronado-callback": () => import("./api/payment-callback.js").then((m) => {
        const h = m.default;
        return (req, res) => { req.query = { ...req.query, provider: "tronado" }; return h(req, res); };
    }),
    "/api/swapwallet-callback": () => import("./api/payment-callback.js").then((m) => {
        const h = m.default;
        return (req, res) => { req.query = { ...req.query, provider: "swapwallet" }; return h(req, res); };
    }),
    "/api/tetrapay-callback": () => import("./api/payment-callback.js").then((m) => {
        const h = m.default;
        return (req, res) => { req.query = { ...req.query, provider: "tetrapay" }; return h(req, res); };
    }),
};
// Cache resolved handlers so we don't re-import on each request
const handlerCache = new Map();
async function resolveHandler(pathname) {
    if (handlerCache.has(pathname))
        return handlerCache.get(pathname);
    const loader = ROUTES[pathname];
    if (!loader)
        return null;
    const handler = await loader();
    handlerCache.set(pathname, handler);
    return handler;
}
// ─── Parse raw body (max 100 MB to accommodate large restore payloads) ────────
const MAX_BODY_BYTES = 100 * 1024 * 1024;
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        req.on("data", (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_BODY_BYTES) {
                req.destroy();
                reject(new Error("Request body too large (> 100 MB)"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            }
            catch {
                resolve({});
            }
        });
        req.on("error", () => resolve({}));
    });
}
// ─── Parse query string ───────────────────────────────────────────────────────
function parseQuery(searchParams) {
    const result = {};
    for (const [key, value] of searchParams) {
        const existing = result[key];
        if (existing !== undefined) {
            result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
// ─── Wrap ServerResponse with Vercel-compatible helpers ───────────────────────
function wrapResponse(res) {
    const w = res;
    w._statusCode = 200;
    w.status = function (code) {
        w._statusCode = code;
        res.statusCode = code;
        return w;
    };
    w.json = function (body) {
        if (!res.headersSent) {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
        }
        res.statusCode = w._statusCode;
        res.end(JSON.stringify(body));
    };
    w.send = function (body) {
        res.statusCode = w._statusCode;
        if (typeof body === "string" || Buffer.isBuffer(body)) {
            res.end(body);
        }
        else {
            w.json(body);
        }
    };
    w.redirect = function (urlOrCode, url) {
        const location = typeof urlOrCode === "string" ? urlOrCode : (url ?? "/");
        const code = typeof urlOrCode === "number" ? urlOrCode : 302;
        res.writeHead(code, { Location: location });
        res.end();
    };
    return w;
}
// ─── HTTP Server ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const server = http.createServer(async (req, res) => {
    try {
        const urlStr = req.url ?? "/";
        const url = new URL(urlStr, `http://localhost:${PORT}`);
        const pathname = url.pathname.replace(/\/+$/, "") || "/";
        const handler = await resolveHandler(pathname);
        if (!handler) {
            // Try to serve from public/ directory before returning 404
            if (req.method === "GET" && serveStatic(pathname, res))
                return;
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Not found", path: pathname }));
            return;
        }
        let body;
        try {
            body = await readBody(req);
        }
        catch (sizeErr) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: sizeErr.message }));
            return;
        }
        const query = parseQuery(url.searchParams);
        const vReq = Object.assign(req, { body, query, cookies: {} });
        const vRes = wrapResponse(res);
        await handler(vReq, vRes);
    }
    catch (err) {
        console.error("[server] Unhandled error:", err);
        if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
        }
    }
});
server.listen(PORT, () => {
    console.log(`[server] Listening on http://0.0.0.0:${PORT}`);
    setupWebhook().catch((err) => {
        console.error("[server] Webhook setup failed:", err);
    });
});
// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
    console.log(`[server] Received ${signal}, shutting down gracefully...`);
    server.close(() => {
        console.log("[server] HTTP server closed");
        // Close postgres TCP connection pool if applicable (neon uses HTTP, no-op there)
        sql.end?.()
            .catch(() => { })
            .finally(() => process.exit(0));
    });
    // Force-exit after 10 s if something is stuck
    setTimeout(() => {
        console.error("[server] Forced exit after timeout");
        process.exit(1);
    }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// ─── Auto-configure Telegram webhook on startup ───────────────────────────────
async function setupWebhook() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    // Fall back to Replit's runtime domain if PUBLIC_BASE_URL is not explicitly set
    const replitDomain = process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : undefined;
    const baseUrl = (process.env.PUBLIC_BASE_URL || replitDomain || "").replace(/\/$/, "");
    if (!token || !baseUrl) {
        console.log("[server] Skipping webhook auto-setup (TELEGRAM_BOT_TOKEN or PUBLIC_BASE_URL not set)");
        return;
    }
    const webhookUrl = `${baseUrl}/api/telegram`;
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: webhookUrl, drop_pending_updates: false }),
        });
        const data = (await res.json());
        if (data.ok) {
            console.log(`[server] Telegram webhook → ${webhookUrl}`);
        }
        else {
            console.error(`[server] Webhook setup error: ${data.description}`);
        }
    }
    catch (err) {
        console.error("[server] Could not reach Telegram API:", err);
    }
}
