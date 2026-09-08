import { sql } from "./db.js";
import { fetchWithProxyFallback } from "./proxy.js";
import { getNumberSetting } from "./settings.js";
const coingeckoIdCache = new Map();
function fetchWithTimeout(url, timeoutMs = 6000) {
    return fetchWithProxyFallback(url, { method: "GET" }, { timeoutMs });
}
function snippet(raw, limit = 180) {
    const s = raw.trim().slice(0, limit);
    return s || "empty_response";
}
async function fetchBinanceUsdtPerUnit(symbol) {
    const pair = `${symbol.toUpperCase()}USDT`;
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`;
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
function pickNavasanApiKey() {
    const a = (process.env.NAVASAN_KEY_1 || "").trim();
    const b = (process.env.NAVASAN_KEY_2 || "").trim();
    if (a && b)
        return Date.now() % 2 === 0 ? a : b;
    return a || b || "";
}
async function fetchNavasanUsdToman() {
    const apiKey = pickNavasanApiKey();
    if (!apiKey) {
        throw new Error("navasan_api_key_missing");
    }
    const url = `https://api.navasan.tech/latest/?api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(`navasan_http_${res.status}:${snippet(raw)}`);
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        throw new Error(`navasan_parse_failed:${snippet(raw)}`);
    }
    const candidates = ["usd_sell", "usd", "usd_buy", "dollar_sell", "dollar", "usd_irr", "usd_market"];
    for (const key of candidates) {
        const v = data?.[key]?.value ?? data?.[key];
        const n = parseInt(String(v ?? ""), 10);
        if (Number.isFinite(n) && n > 0) {
            return n;
        }
    }
    for (const [k, obj] of Object.entries(data || {})) {
        if (!String(k).toLowerCase().includes("usd"))
            continue;
        const v = obj?.value ?? obj;
        const n = parseInt(String(v ?? ""), 10);
        if (Number.isFinite(n) && n > 0) {
            return n;
        }
    }
    throw new Error(`navasan_invalid_payload:${snippet(raw)}`);
}
async function fetchTetherlandUsdToman() {
    const url = "https://api.tetherland.com/currencies";
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(`tetherland_http_${res.status}:${snippet(raw)}`);
    const data = JSON.parse(raw);
    const p = Number(data?.data?.currencies?.USDT?.price);
    if (!Number.isFinite(p) || p <= 0)
        throw new Error(`tetherland_invalid_payload:${snippet(raw)}`);
    return p;
}
async function fetchOpenErUsdToman() {
    const url = "https://open.er-api.com/v6/latest/USD";
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(`open_er_http_${res.status}:${snippet(raw)}`);
    const data = JSON.parse(raw);
    const irr = Number(data?.rates?.IRR);
    if (!Number.isFinite(irr) || irr <= 0)
        throw new Error(`open_er_invalid_payload:${snippet(raw)}`);
    return Math.round(irr / 10);
}
async function fetchExchangeRateFunUsdToman() {
    const url = "https://api.exchangerate.fun/latest?base=USD";
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(`exchangerate_fun_http_${res.status}:${snippet(raw)}`);
    const data = JSON.parse(raw);
    const irr = Number(data?.rates?.IRR);
    if (!Number.isFinite(irr) || irr <= 0)
        throw new Error(`exchangerate_fun_invalid_payload:${snippet(raw)}`);
    return Math.round(irr / 10);
}
export async function getUsdTomanRate() {
    // 1. Check admin manual setting
    const manual = (await getNumberSetting("usdt_toman_rate")) || 0;
    if (manual > 0)
        return manual;
    // 2. Check cached rate in database (within 3 hours)
    const cached = await sql `
    SELECT toman_per_unit
    FROM crypto_rate_cache
    WHERE symbol = 'USD_TOMAN'
      AND updated_at > NOW() - INTERVAL '3 hours'
    LIMIT 1;
  `;
    if (cached.length) {
        const n = Number(cached[0].toman_per_unit);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    // 3. Try live rate providers
    const providers = [
        { name: "tetherland", fn: fetchTetherlandUsdToman },
        { name: "navasan", fn: fetchNavasanUsdToman },
        { name: "open_er", fn: fetchOpenErUsdToman },
        { name: "exchangerate_fun", fn: fetchExchangeRateFunUsdToman }
    ];
    for (const p of providers) {
        try {
            const rate = await p.fn();
            if (Number.isFinite(rate) && rate > 0) {
                await sql `
          INSERT INTO crypto_rate_cache (symbol, toman_per_unit, updated_at)
          VALUES ('USD_TOMAN', ${rate}, NOW())
          ON CONFLICT (symbol) DO UPDATE
            SET toman_per_unit = EXCLUDED.toman_per_unit, updated_at = NOW();
        `.catch(() => { });
                return rate;
            }
        }
        catch {
            // try next provider
        }
    }
    // 4. Stale cache fallback (any age)
    const stale = await sql `
    SELECT toman_per_unit
    FROM crypto_rate_cache
    WHERE symbol = 'USD_TOMAN' OR symbol = 'USDT'
    ORDER BY updated_at DESC
    LIMIT 1;
  `;
    if (stale.length) {
        const n = Number(stale[0].toman_per_unit);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    // 5. Ultimate safe fallback
    return 100000;
}
async function resolveCoinGeckoId(symbol) {
    const cached = coingeckoIdCache.get(symbol.toUpperCase());
    if (cached)
        return cached;
    const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`;
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(`coingecko_search_http_${res.status}:${snippet(raw)}`);
    const data = JSON.parse(raw);
    const coins = Array.isArray(data?.coins) ? data.coins : [];
    const sym = symbol.toUpperCase();
    const best = coins.find((c) => String(c?.symbol || "").toUpperCase() === sym) ||
        coins.find((c) => String(c?.name || "").toUpperCase() === sym) ||
        coins[0];
    const id = String(best?.id || "").trim();
    if (!id)
        throw new Error(`coingecko_search_no_match:${snippet(raw)}`);
    coingeckoIdCache.set(sym, id);
    return id;
}
async function fetchCoinGeckoUsdPerUnitById(id) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
    const res = await fetchWithTimeout(url, 6000);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(`coingecko_price_http_${res.status}:${snippet(raw)}`);
    const data = JSON.parse(raw);
    const usd = Number(data?.[id]?.usd);
    if (!Number.isFinite(usd) || usd <= 0)
        throw new Error(`coingecko_price_invalid:${snippet(raw)}`);
    return usd;
}
function isUsdPeg(symbol) {
    const s = symbol.toUpperCase();
    return s === "USDT" || s === "USDC" || s === "DAI" || s === "TUSD" || s === "BUSD";
}
function coingeckoIdOverride(symbol) {
    const s = symbol.toUpperCase();
    if (s === "USDT")
        return "tether";
    if (s === "TRX")
        return "tron";
    if (s === "TON")
        return "the-open-network";
    if (s === "BTC")
        return "bitcoin";
    if (s === "ETH")
        return "ethereum";
    if (s === "SOL")
        return "solana";
    if (s === "BNB")
        return "binancecoin";
    if (s === "DOGE")
        return "dogecoin";
    if (s === "LTC")
        return "litecoin";
    return "";
}
async function fetchCryptoUsdPerUnit(key) {
    if (isUsdPeg(key))
        return 1.0;
    // 1. Try Binance
    try {
        const p = await fetchBinanceUsdtPerUnit(key);
        if (Number.isFinite(p) && p > 0)
            return p;
    }
    catch {
        // try next
    }
    // 2. Try CoinGecko USD
    try {
        const id = coingeckoIdOverride(key) || (await resolveCoinGeckoId(key));
        const usd = await fetchCoinGeckoUsdPerUnitById(id);
        if (Number.isFinite(usd) && usd > 0)
            return usd;
    }
    catch {
        // try next
    }
    // 3. Try KuCoin
    try {
        const url = `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${encodeURIComponent(key)}-USDT`;
        const res = await fetchWithTimeout(url, 6000);
        const raw = await res.text();
        if (res.ok) {
            const data = JSON.parse(raw);
            const price = Number(data?.data?.price);
            if (Number.isFinite(price) && price > 0)
                return price;
        }
    }
    catch {
        // try next
    }
    throw new Error(`crypto_usd_price_unavailable_for_${key}`);
}
export async function getCryptoTomanPerUnitCached(symbol, options) {
    const cacheMs = options?.cacheMs ?? 5 * 60_000;
    const key = symbol.toUpperCase();
    const cacheSeconds = Math.max(1, Math.floor(cacheMs / 1000));
    const fresh = await sql `
    SELECT toman_per_unit
    FROM crypto_rate_cache
    WHERE symbol = ${key}
      AND updated_at > NOW() - (${cacheSeconds} || ' seconds')::interval
    LIMIT 1;
  `;
    if (fresh.length) {
        const n = Number(fresh[0].toman_per_unit);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    // 1. Get USD price of the crypto
    const usdPrice = await fetchCryptoUsdPerUnit(key);
    // 2. Get USD/USDT to Toman exchange rate
    const usdTomanRate = await getUsdTomanRate();
    // 3. Compute Toman price per unit
    const tomanPerUnit = Math.round(usdPrice * usdTomanRate);
    if (!Number.isFinite(tomanPerUnit) || tomanPerUnit <= 0) {
        throw new Error(`crypto_rate_calc_invalid:${key}`);
    }
    // Cache in database
    await sql `
    INSERT INTO crypto_rate_cache (symbol, toman_per_unit, updated_at)
    VALUES (${key}, ${tomanPerUnit}, NOW())
    ON CONFLICT (symbol) DO UPDATE
      SET toman_per_unit = EXCLUDED.toman_per_unit, updated_at = NOW();
  `.catch(() => { });
    return tomanPerUnit;
}
