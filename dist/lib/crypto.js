import { getUsdtRateTomanCached } from "./rates.js";
let trxTomanCache = null;
function fetchWithTimeout(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
function snippet(raw, limit = 180) {
    const s = raw.trim().slice(0, limit);
    return s || "empty_response";
}
async function fetchTrxUsdtFromBinance() {
    const url = "https://api.binance.com/api/v3/ticker/price?symbol=TRXUSDT";
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(`binance_http_${res.status}:${snippet(raw)}`);
    const data = JSON.parse(raw);
    const price = Number(data?.price);
    if (!Number.isFinite(price) || price <= 0)
        throw new Error(`binance_invalid_payload:${snippet(raw)}`);
    return price;
}
async function fetchTrxUsdFromCoinGecko() {
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=tron&vs_currencies=usd";
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(`coingecko_http_${res.status}:${snippet(raw)}`);
    const data = JSON.parse(raw);
    const price = Number(data?.tron?.usd);
    if (!Number.isFinite(price) || price <= 0)
        throw new Error(`coingecko_invalid_payload:${snippet(raw)}`);
    return price;
}
export async function getTrxRateTomanCached(options) {
    const cacheMs = options?.cacheMs ?? 60_000;
    const now = Date.now();
    if (trxTomanCache && now - trxTomanCache.updatedAt < cacheMs) {
        return { trxToman: trxTomanCache.value, source: "cache" };
    }
    const { rateTomanPerUsdt } = await getUsdtRateTomanCached({ cacheMs: 60_000 });
    const errors = [];
    try {
        const trxUsdt = await fetchTrxUsdtFromBinance();
        const trxToman = trxUsdt * rateTomanPerUsdt;
        trxTomanCache = { value: trxToman, updatedAt: now };
        return { trxToman, source: "binance" };
    }
    catch (e) {
        errors.push(String(e?.message || e));
    }
    try {
        const trxUsd = await fetchTrxUsdFromCoinGecko();
        const trxToman = trxUsd * rateTomanPerUsdt;
        trxTomanCache = { value: trxToman, updatedAt: now };
        return { trxToman, source: "coingecko" };
    }
    catch (e) {
        errors.push(String(e?.message || e));
    }
    throw new Error(`trx_rate_fetch_failed:${errors.join(" | ")}`);
}
