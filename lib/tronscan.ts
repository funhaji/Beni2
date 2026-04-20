type TronScanTransfer = {
  txid: string;
  from: string;
  to: string;
  amount: number;
  timestampMs: number;
};

function fetchWithTimeout(url: string, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function toNumber(v: unknown) {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
}

function normalizeAmount(row: any) {
  const decimals = toNumber(row?.decimals);
  const rawAmount = toNumber(row?.amount ?? row?.quant ?? row?.value ?? row?.transfer_amount);
  if (!Number.isFinite(rawAmount)) return NaN;
  if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 18) {
    return rawAmount / Math.pow(10, decimals);
  }
  if (rawAmount >= 1_000_000) return rawAmount / 1_000_000;
  return rawAmount;
}

export async function getRecentTrxTransfers(address: string, limit = 50): Promise<TronScanTransfer[]> {
  const url = new URL("https://apilist.tronscan.org/api/transfer");
  url.searchParams.set("sort", "-timestamp");
  url.searchParams.set("count", "true");
  url.searchParams.set("limit", String(Math.max(1, Math.min(200, limit))));
  url.searchParams.set("start", "0");
  url.searchParams.set("token", "_");
  url.searchParams.set("address", address);

  const res = await fetchWithTimeout(url.toString(), 7000);
  const raw = await res.text();
  if (!res.ok) throw new Error(`tronscan_http_${res.status}`);
  const data = JSON.parse(raw) as any;
  const rows = Array.isArray(data?.data) ? data.data : [];

  const out: TronScanTransfer[] = [];
  for (const row of rows) {
    const txid = String(row?.transactionHash || row?.hash || row?.txid || "").trim();
    const from = String(row?.transferFromAddress || row?.fromAddress || row?.from || "").trim();
    const to = String(row?.transferToAddress || row?.toAddress || row?.to || "").trim();
    const ts = toNumber(row?.timestamp ?? row?.block_ts ?? row?.time);
    const timestampMs = Number.isFinite(ts) ? (ts < 10_000_000_000 ? ts * 1000 : ts) : 0;
    const amount = normalizeAmount(row);
    if (!txid || !to || !Number.isFinite(amount) || amount <= 0 || timestampMs <= 0) continue;
    out.push({ txid, from, to, amount, timestampMs });
  }
  return out;
}

