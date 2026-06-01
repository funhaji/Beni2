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
import dns from "node:dns";

// Fix for Node 18+ fetch failing on IPv6-only or broken IPv6 environments
dns.setDefaultResultOrder("ipv4first");

import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import fetch from "node-fetch";
import { sql } from "./lib/db.js";
import { fetchWithProxyFallback, getTelegramApiBases } from "./lib/proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
};

function serveStatic(pathname: string, res: ServerResponse): boolean {
  // Strip leading slash, resolve against public dir, prevent traversal
  const rel = pathname.replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;

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

// ─── Lazy-load handlers so heavy modules (bot.ts) are only parsed once ────────
// Return type is `unknown` so this works with handlers that return void, VercelResponse,
// or anything else — we never use the return value.
type Handler = (req: VercelRequest, res: VercelResponse) => Promise<unknown>;

const ROUTES: Record<string, () => Promise<Handler>> = {
  "/api/telegram":             () => import("./api/telegram.js").then((m) => m.default),
  "/api/payment-callback":     () => import("./api/payment-callback.js").then((m) => m.default),
  "/api/admin":                () => import("./api/admin.js").then((m) => m.default),

  // Legacy paths mapped to admin
  "/api/health":               () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "health" }; return h(req, res); };
  }),
  "/api/logs":                 () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "logs" }; return h(req, res); };
  }),
  "/api/backup":               () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "backup" }; return h(req, res); };
  }),
  "/api/restore":              () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "restore" }; return h(req, res); };
  }),
  "/api/reachability":         () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "reachability" }; return h(req, res); };
  }),
  "/api/find-dead":            () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "find-dead" }; return h(req, res); };
  }),
  "/api/panel-action":         () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "panel-action" }; return h(req, res); };
  }),
  "/api/migrate":              () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "migrate" }; return h(req, res); };
  }),
  "/api/marzban-install":      () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "marzban-install" }; return h(req, res); };
  }),
  "/api/test-approve":         () => import("./api/admin.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, action: "test-approve" }; return h(req, res); };
  }),
  // Legacy paths — rewrite query param so the unified handler can route them
  "/api/plisio-callback":      () => import("./api/payment-callback.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, provider: "plisio" }; return h(req, res); };
  }),
  "/api/tronado-callback":     () => import("./api/payment-callback.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, provider: "tronado" }; return h(req, res); };
  }),
  "/api/swapwallet-callback":  () => import("./api/payment-callback.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, provider: "swapwallet" }; return h(req, res); };
  }),
  "/api/tetrapay-callback":    () => import("./api/payment-callback.js").then((m) => {
    const h = m.default;
    return (req: any, res: any) => { req.query = { ...req.query, provider: "tetrapay" }; return h(req, res); };
  }),
};

// Cache resolved handlers so we don't re-import on each request
const handlerCache = new Map<string, Handler>();

async function resolveHandler(pathname: string): Promise<Handler | null> {
  if (handlerCache.has(pathname)) return handlerCache.get(pathname)!;
  const loader = ROUTES[pathname];
  if (!loader) return null;
  const handler = await loader();
  handlerCache.set(pathname, handler);
  return handler;
}

// ─── Parse raw body (max 100 MB to accommodate large restore payloads) ────────
const MAX_BODY_BYTES = 100 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
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
      if (!raw) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

// ─── Parse query string ───────────────────────────────────────────────────────
function parseQuery(searchParams: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams) {
    const existing = result[key];
    if (existing !== undefined) {
      result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Wrap ServerResponse with Vercel-compatible helpers ───────────────────────
function wrapResponse(res: ServerResponse): VercelResponse {
  const w = res as unknown as VercelResponse & { _statusCode: number };
  w._statusCode = 200;

  (w as any).status = function (code: number) {
    w._statusCode = code;
    res.statusCode = code;
    return w;
  };

  (w as any).json = function (body: unknown) {
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.statusCode = w._statusCode;
    res.end(JSON.stringify(body));
  };

  (w as any).send = function (body: unknown) {
    if (res.writableEnded) return;
    res.statusCode = w._statusCode;
    if (typeof body === "string" || Buffer.isBuffer(body)) {
      res.end(body);
    } else {
      (w as any).json(body);
    }
  };

  (w as any).redirect = function (urlOrCode: string | number, url?: string) {
    const location = typeof urlOrCode === "string" ? urlOrCode : (url ?? "/");
    const code = typeof urlOrCode === "number" ? urlOrCode : 302;
    res.writeHead(code, { Location: location });
    res.end();
  };

  return w;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const urlStr = req.url ?? "/";
    const url = new URL(urlStr, `http://localhost:${PORT}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    const handler = await resolveHandler(pathname);

    if (!handler) {
      // Try to serve from public/ directory before returning 404
      if (req.method === "GET" && serveStatic(pathname, res)) return;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found", path: pathname }));
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (sizeErr) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: (sizeErr as Error).message }));
      return;
    }

    const query = parseQuery(url.searchParams);

    const vReq = Object.assign(req, { body, query, cookies: {} }) as unknown as VercelRequest;
    const vRes = wrapResponse(res);

    await handler(vReq, vRes);
  } catch (err) {
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
function shutdown(signal: string) {
  console.log(`[server] Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    console.log("[server] HTTP server closed");
    // Close postgres TCP connection pool if applicable (neon uses HTTP, no-op there)
    (sql as any).end?.()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
  // Force-exit after 10 s if something is stuck
  setTimeout(() => {
    console.error("[server] Forced exit after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─── Auto-configure Telegram webhook on startup ───────────────────────────────
async function setupWebhook(): Promise<void> {
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
    let body: any;
    let headers: Record<string, string> = {};

    const certPath = path.join(__dirname, "..", "certs", "cert.pem");
    if (fs.existsSync(certPath)) {
      console.log("[server] Self-signed certificate found, uploading to Telegram...");
      const formData = new FormData();
      formData.append("url", webhookUrl);
      formData.append("drop_pending_updates", "false");
      
      const certBuffer = fs.readFileSync(certPath);
      formData.append("certificate", new Blob([certBuffer]), "cert.pem");
      body = formData;
    } else {
      headers = { "Content-Type": "application/json" };
      body = JSON.stringify({ url: webhookUrl, drop_pending_updates: false });
    }

    const bases = getTelegramApiBases();
    let lastDesc = "";
    for (const apiBase of bases) {
      const res = await fetchWithProxyFallback(`${apiBase}/bot${token}/setWebhook`, {
        method: "POST",
        headers,
        body
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (data.ok) {
        console.log(`[server] Telegram webhook → ${webhookUrl} (API: ${apiBase})`);
        return;
      }
      lastDesc = data.description || "unknown_error";
    }
    console.error(`[server] Webhook setup error: ${lastDesc}`);
  } catch (err) {
    console.error("[server] Could not reach Telegram API:", err);
  }
}

