type CacheEntry = { value: number; updatedAt: number };

let usdtTomanCache: CacheEntry | null = null;

function fetchWithTimeout(url: string, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function snippet(raw: string, limit = 180) {
  const s = raw.trim().slice(0, limit);
  return s || "empty_response";
}

async function fetchUsdtTomanFromCoinGecko() {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=irr";
  const res = await fetchWithTimeout(url, 6000);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`coingecko_http_${res.status}:${snippet(raw)}`);
  }
  let data: any;
  try {
    data = JSON.parse(raw) as any;
  } catch {
    throw new Error(`coingecko_parse_failed:${snippet(raw)}`);
  }
  const irrPerUsdt = Number(data?.tether?.irr);
  if (!Number.isFinite(irrPerUsdt) || irrPerUsdt <= 0) {
    throw new Error(`coingecko_invalid_payload:${snippet(raw)}`);
  }
  const tomanPerUsdt = irrPerUsdt / 10;
  if (!Number.isFinite(tomanPerUsdt) || tomanPerUsdt <= 0) {
    throw new Error(`coingecko_invalid_value:${String(tomanPerUsdt)}`);
  }
  return tomanPerUsdt;
}

async function fetchUsdtTomanFromCryptoCompare() {
  const url = "https://min-api.cryptocompare.com/data/price?fsym=USDT&tsyms=IRR";
  const res = await fetchWithTimeout(url, 6000);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`cryptocompare_http_${res.status}:${snippet(raw)}`);
  }
  let data: any;
  try {
    data = JSON.parse(raw) as any;
  } catch {
    throw new Error(`cryptocompare_parse_failed:${snippet(raw)}`);
  }
  const irrPerUsdt = Number(data?.IRR);
  if (!Number.isFinite(irrPerUsdt) || irrPerUsdt <= 0) {
    throw new Error(`cryptocompare_invalid_payload:${snippet(raw)}`);
  }
  const tomanPerUsdt = irrPerUsdt / 10;
  if (!Number.isFinite(tomanPerUsdt) || tomanPerUsdt <= 0) {
    throw new Error(`cryptocompare_invalid_value:${String(tomanPerUsdt)}`);
  }
  return tomanPerUsdt;
}

export async function getUsdtRateTomanCached(options?: { cacheMs?: number; allowStaleMs?: number }) {
  const cacheMs = options?.cacheMs ?? 60_000;
  const allowStaleMs = options?.allowStaleMs ?? 15 * 60_000;
  const now = Date.now();

  if (usdtTomanCache && now - usdtTomanCache.updatedAt < cacheMs) {
    return { rateTomanPerUsdt: usdtTomanCache.value, source: "cache" as const };
  }

  const errors: string[] = [];
  try {
    const rate = await fetchUsdtTomanFromCoinGecko();
    usdtTomanCache = { value: rate, updatedAt: now };
    return { rateTomanPerUsdt: rate, source: "coingecko" as const };
  } catch (error) {
    errors.push(String((error as Error)?.message || error));
  }
  try {
    const rate = await fetchUsdtTomanFromCryptoCompare();
    usdtTomanCache = { value: rate, updatedAt: now };
    return { rateTomanPerUsdt: rate, source: "cryptocompare" as const };
  } catch (error) {
    errors.push(String((error as Error)?.message || error));
    if (usdtTomanCache && now - usdtTomanCache.updatedAt < allowStaleMs) {
      return { rateTomanPerUsdt: usdtTomanCache.value, source: "stale_cache" as const };
    }
    throw new Error(`rate_fetch_failed:${errors.join(" | ")}`);
  }
}
