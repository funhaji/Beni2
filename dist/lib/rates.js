let usdtTomanCache = null;
function fetchWithTimeout(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
async function fetchUsdtTomanFromCoinGecko() {
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=irr";
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    const data = JSON.parse(raw);
    const irrPerUsdt = Number(data?.tether?.irr);
    if (!Number.isFinite(irrPerUsdt) || irrPerUsdt <= 0) {
        throw new Error("invalid_rate_payload");
    }
    const tomanPerUsdt = irrPerUsdt / 10;
    if (!Number.isFinite(tomanPerUsdt) || tomanPerUsdt <= 0) {
        throw new Error("invalid_rate_value");
    }
    return tomanPerUsdt;
}
export async function getUsdtRateTomanCached(options) {
    const cacheMs = options?.cacheMs ?? 60_000;
    const allowStaleMs = options?.allowStaleMs ?? 15 * 60_000;
    const now = Date.now();
    if (usdtTomanCache && now - usdtTomanCache.updatedAt < cacheMs) {
        return { rateTomanPerUsdt: usdtTomanCache.value, source: "cache" };
    }
    try {
        const rate = await fetchUsdtTomanFromCoinGecko();
        usdtTomanCache = { value: rate, updatedAt: now };
        return { rateTomanPerUsdt: rate, source: "coingecko" };
    }
    catch (error) {
        if (usdtTomanCache && now - usdtTomanCache.updatedAt < allowStaleMs) {
            return { rateTomanPerUsdt: usdtTomanCache.value, source: "stale_cache" };
        }
        throw error;
    }
}
