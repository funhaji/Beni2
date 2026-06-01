import dns from "node:dns";
import https from "node:https";
import { URL } from "node:url";
import fetch, { type RequestInit } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { env } from "./env.js";

try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* ignore */
}

/** Hosts that should use the proxy when PROXY is enabled (Telegram + blocked externals). */
const DEFAULT_PROXIED_SUFFIXES = [
  "telegram.org",
  "t.me",
  "quickchart.io",
  "api.qrserver.com",
  "chart.googleapis.com",
  "api.coingecko.com",
  "api.binance.com",
  "open.er-api.com",
  "api.exchangerate.fun",
  "api.plisio.net",
  "swapwallet.app",
  "tetra98.com",
  "bot.tronado.cloud"
];

/** Iranian / domestic hosts — always direct (panels, national APIs). */
const DIRECT_SUFFIXES = [
  ".ir",
  "navasan.tech",
  "arvancloud.ir",
  "digikala.com",
  "snapp.ir",
  "bale.ai",
  "eitaa.com",
  "rubika.ir"
];

const directAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  keepAliveMsecs: 30_000
});

let cachedSocksAgent: SocksProxyAgent | undefined;
let cachedHttpProxyAgent: HttpsProxyAgent<string> | undefined;

function proxySocksUrl(): string | undefined {
  const url = env.PROXY_SOCKS_URL?.trim();
  if (!env.PROXY_ENABLED || !url) return undefined;
  return url;
}

function buildSocksAgent(): SocksProxyAgent | undefined {
  const url = proxySocksUrl();
  if (!url) return undefined;
  if (!cachedSocksAgent) {
    cachedSocksAgent = new SocksProxyAgent(url, {
      keepAlive: true,
      timeout: 30_000
    });
  }
  return cachedSocksAgent;
}

function buildHttpProxyAgent(): HttpsProxyAgent<string> | undefined {
  const url = env.PROXY_HTTP_URL?.trim();
  if (!env.PROXY_ENABLED || !url) return undefined;
  if (!cachedHttpProxyAgent) {
    cachedHttpProxyAgent = new HttpsProxyAgent(url, {
      keepAlive: true,
      timeout: 30_000
    });
  }
  return cachedHttpProxyAgent;
}

export function isProxyEnabled() {
  return Boolean(env.PROXY_ENABLED && (proxySocksUrl() || env.PROXY_HTTP_URL?.trim()));
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function shouldUseProxyForUrl(url: string): boolean {
  if (!isProxyEnabled()) return false;
  const host = hostnameOf(url);
  if (!host) return false;

  for (const suffix of DIRECT_SUFFIXES) {
    if (host === suffix || host.endsWith(suffix)) return false;
  }

  const extraDirect = (env.PROXY_DIRECT_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const pattern of extraDirect) {
    if (host === pattern || host.endsWith(`.${pattern}`) || host.endsWith(pattern)) {
      return false;
    }
  }

  const extraProxied = (env.PROXY_EXTRA_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const suffix of [...DEFAULT_PROXIED_SUFFIXES, ...extraProxied]) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }

  return false;
}

/** Agent for a URL: proxy only when host is in the proxied list; panels stay direct. */
export function getAgentForUrl(url: string): https.Agent | SocksProxyAgent | HttpsProxyAgent<string> | undefined {
  if (!shouldUseProxyForUrl(url)) {
    return url.startsWith("https:") ? directAgent : undefined;
  }
  const socks = buildSocksAgent();
  if (socks) return socks;
  const httpProxy = buildHttpProxyAgent();
  if (httpProxy) return httpProxy;
  return url.startsWith("https:") ? directAgent : undefined;
}

export function getDirectHttpsAgent() {
  return directAgent;
}

function telegramApiBases(): string[] {
  const bases: string[] = [];
  const primary = env.TELEGRAM_API_BASE?.trim();
  if (primary) bases.push(primary.replace(/\/$/, ""));
  const fallbacks = (env.TELEGRAM_API_FALLBACKS || "")
    .split(",")
    .map((b) => b.trim().replace(/\/$/, ""))
    .filter(Boolean);
  for (const b of fallbacks) {
    if (!bases.includes(b)) bases.push(b);
  }
  if (!bases.includes("https://api.telegram.org")) {
    bases.push("https://api.telegram.org");
  }
  return bases;
}

export function getTelegramApiBases() {
  return telegramApiBases();
}

type FetchAttempt = { label: string; init?: RequestInit };

/**
 * Fetch with selective proxy + fallbacks (proxy → direct → alternate Telegram API bases).
 */
export async function fetchWithProxyFallback(
  url: string,
  init: RequestInit = {},
  options?: { forceProxy?: boolean; forceDirect?: boolean; timeoutMs?: number }
): Promise<Awaited<ReturnType<typeof fetch>>> {
  const timeoutMs = options?.timeoutMs ?? 25_000;
  const attempts: FetchAttempt[] = [];

  if (options?.forceDirect) {
    attempts.push({ label: "direct", init: { ...init, agent: directAgent } });
  } else if (options?.forceProxy && isProxyEnabled()) {
    const agent = buildSocksAgent() || buildHttpProxyAgent();
    if (agent) attempts.push({ label: "proxy", init: { ...init, agent } });
  } else if (shouldUseProxyForUrl(url)) {
    const agent = getAgentForUrl(url);
    if (agent && agent !== directAgent) {
      attempts.push({ label: "proxy", init: { ...init, agent } });
    }
    attempts.push({ label: "direct", init: { ...init, agent: directAgent } });
  } else {
    attempts.push({ label: "direct", init: { ...init, agent: directAgent } });
  }

  let lastError: unknown;
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...attempt.init,
        signal: controller.signal
      });
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`http_${res.status}:${attempt.label}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const QR_PROVIDERS = [
  (text: string) =>
    `https://quickchart.io/qr?size=320&margin=2&text=${encodeURIComponent(text)}`,
  (text: string) =>
    `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(text)}`
];

/** Download QR image (proxied). Used so Telegram does not fetch blocked QR URLs itself. */
export async function fetchQrImageBuffer(text: string): Promise<Buffer | null> {
  const value = String(text || "").trim();
  if (!value) return null;

  for (const buildUrl of QR_PROVIDERS) {
    const url = buildUrl(value);
    try {
      const res = await fetchWithProxyFallback(url, { method: "GET" }, { timeoutMs: 15_000 });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 100) return buf;
    } catch {
      /* try next provider */
    }
  }
  return null;
}

export function qrCodeUrl(value: string) {
  return `https://quickchart.io/qr?size=320&text=${encodeURIComponent(value)}`;
}
