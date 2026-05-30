/**
 * Unified payment callback handler.
 *
 * Vercel rewrites map legacy paths to this function via a `provider` query param:
 *   /api/plisio-callback    → /api/payment-callback?provider=plisio
 *   /api/tronado-callback   → /api/payment-callback?provider=tronado
 *   /api/swapwallet-callback→ /api/payment-callback?provider=swapwallet
 *   /api/tetrapay-callback  → /api/payment-callback?provider=tetrapay
 *
 * The VPS server.ts routes each legacy path directly to this file as well.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { fulfillOrderByPaymentId } from "../lib/bot.js";
import { logError, logInfo } from "../lib/log.js";
import { ensureSchema, sql } from "../lib/db.js";
import { getSetting, getAdminIds } from "../lib/settings.js";
import { tg } from "../lib/telegram.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function notifyAdmins(text: string, replyMarkup?: Record<string, unknown>) {
  for (const adminId of await getAdminIds()) {
    await tg("sendMessage", { chat_id: adminId, text, reply_markup: replyMarkup }).catch(() => {});
  }
}

function pickString(body: unknown, keys: string[]): string {
  if (!body || typeof body !== "object") return "";
  const obj = body as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    const s = typeof v === "string" ? v.trim() : "";
    if (s) return s;
  }
  return "";
}

// ─── Plisio ───────────────────────────────────────────────────────────────────

function normalizePlisioPaymentId(data: Record<string, unknown>): string {
  const orderName = String(data.order_name || "").trim();
  if (orderName) return orderName;
  const orderNumber = String(data.order_number || "").trim();
  if (orderNumber) return `P${orderNumber}`;
  return "";
}

function isPlisioPaid(status: string): boolean {
  const s = status.toLowerCase().trim();
  return s === "completed" || s === "mismatch";
}

function isPlisioFailure(status: string): boolean {
  const s = status.toLowerCase().trim();
  return s === "expired" || s === "cancelled" || s === "error" || s === "cancelled duplicate";
}

async function handlePlisio(req: VercelRequest, res: VercelResponse) {
  const { getPlisioOperation, verifyPlisioCallbackHash } = await import("../lib/plisio.js");

  const apiKey = (await getSetting("plisio_api_key")) || "";
  if (!apiKey.trim()) {
    res.status(500).json({ ok: false, error: "Plisio api key not configured" });
    return;
  }

  const body: Record<string, unknown> =
    req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};

  const txnId = String(body.txn_id || "").trim();
  const status = String(body.status || "").trim();
  const paymentId = normalizePlisioPaymentId(body);

  if (!txnId || !status || !paymentId) {
    res.status(400).json({ ok: false, error: "Missing required fields" });
    return;
  }

  const hashOk = verifyPlisioCallbackHash(body, apiKey);
  if (!hashOk) {
    logError("plisio_callback_invalid_hash", new Error("verify_hash mismatch"), { txnId, paymentId, status });
    await notifyAdmins(`❌ Plisio callback verify_hash نامعتبر\nid: ${paymentId}\ntxn: ${txnId}\nstatus: ${status}`);
    res.status(422).json({ ok: false, error: "Invalid verify_hash" });
    return;
  }

  try {
    await ensureSchema();
    await sql`UPDATE orders SET plisio_status = ${status} WHERE purchase_id = ${paymentId};`;
  } catch (e) {
    logError("plisio_callback_update_order_failed", e, { txnId, paymentId, status });
  }

  let operation: Record<string, unknown> | null = null;
  try {
    const op = await getPlisioOperation({ apiKey, operationId: txnId });
    operation = op as unknown as Record<string, unknown>;
    const opStatus = String(op.status || "").trim().toLowerCase();
    if (!isPlisioPaid(opStatus) && isPlisioPaid(status)) {
      logError("plisio_callback_status_mismatch", new Error("callback paid but operation not paid"), {
        txnId, paymentId, callbackStatus: status, operationStatus: op.status
      });
    }
  } catch (e) {
    logError("plisio_callback_operation_lookup_failed", e, { txnId, paymentId, status });
  }

  if (!isPlisioPaid(status)) {
    logInfo("plisio_callback_not_paid", { txnId, paymentId, status, operation });
    if (isPlisioFailure(status)) {
      const button = paymentId.startsWith("P")
        ? { inline_keyboard: [[{ text: "🔎 باز کردن سفارش", callback_data: `admin_open_purchase_${paymentId}` }]] }
        : undefined;
      await notifyAdmins(`⚠️ پرداخت Plisio ناموفق/منقضی شد\nid: ${paymentId}\ntxn: ${txnId}\nstatus: ${status}`, button);
    }
    res.status(200).json({ ok: true, received: true, paid: false });
    return;
  }

  const result = await fulfillOrderByPaymentId(paymentId);
  logInfo("plisio_callback_processed", { txnId, paymentId, ok: result.ok, reason: result.reason, operation });
  res.status(200).json({ ok: result.ok, reason: result.reason });
}

// ─── Tronado ──────────────────────────────────────────────────────────────────

async function handleTronado(req: VercelRequest, res: VercelResponse) {
  const { getStatusByPaymentId } = await import("../lib/tronado.js");

  const paymentId =
    req.body?.PaymentID || req.body?.paymentId || req.body?.paymentID ||
    req.query?.PaymentID || req.query?.paymentId;
  if (!paymentId || typeof paymentId !== "string") {
    res.status(400).json({ ok: false, error: "PaymentID is required" });
    return;
  }

  try {
    const apiKey = (await getSetting("tronado_api_key")) || "";
    const statusRes = await getStatusByPaymentId(paymentId, apiKey) as any;
    const orderStatusTitle = statusRes?.OrderStatusTitle || statusRes?.Data?.OrderStatusTitle ||
      statusRes?.orderStatusTitle || statusRes?.Data?.orderStatusTitle;
    const isPaid = statusRes?.IsPaid === true || statusRes?.Data?.IsPaid === true ||
      statusRes?.isPaid === true || statusRes?.Data?.isPaid === true;
    const isAccepted = orderStatusTitle === "PaymentAccepted" || isPaid;
    if (!isAccepted) {
      logError("tronado_callback_spoofed", new Error("Payment status not accepted"), { paymentId, statusRes });
      res.status(400).json({ ok: false, error: "Payment not completed or spoofed" });
      return;
    }
  } catch (statusErr) {
    logError("tronado_callback_verify_failed", statusErr, { paymentId });
    await notifyAdmins(
      `⚠️ خطا در تایید پرداخت Tronado\nسفارش: ${paymentId}\nعلت: ${(statusErr as Error).message || String(statusErr)}`
    );
    res.status(500).json({ ok: false, error: "Could not verify payment status with Tronado" });
    return;
  }

  const result = await fulfillOrderByPaymentId(paymentId);
  logInfo("tronado_callback_processed", { paymentId, ok: result.ok, reason: result.reason });
  res.status(200).json({ ok: result.ok, reason: result.reason });
}

// ─── SwapWallet ───────────────────────────────────────────────────────────────

async function handleSwapwallet(req: VercelRequest, res: VercelResponse) {
  const { getSwapwalletInvoiceById, getSwapwalletInvoiceByOrderId, isSwapwalletInvoicePaid } =
    await import("../lib/swapwallet.js");

  const apiKey = ((await getSetting("swapwallet_api_key")) || "").trim();
  const shopUsername = ((await getSetting("swapwallet_shop_username")) || "").trim();
  if (!apiKey || !shopUsername) {
    res.status(500).json({ ok: false, error: "SwapWallet settings not configured" });
    return;
  }

  const body: Record<string, unknown> =
    req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};

  const orderId =
    pickString(body, ["orderId", "order_id", "externalOrderId"]) ||
    pickString(body.invoice, ["orderId", "order_id"]) ||
    pickString(body.result, ["orderId", "order_id"]);
  const invoiceId =
    pickString(body, ["invoiceId", "invoice_id", "id"]) ||
    pickString(body.invoice, ["id", "invoiceId", "invoice_id"]) ||
    pickString(body.result, ["id", "invoiceId", "invoice_id"]);

  let invoice: any = null;
  try {
    if (orderId) {
      invoice = await getSwapwalletInvoiceByOrderId({ apiKey, shopUsername, orderId });
    } else if (invoiceId) {
      invoice = await getSwapwalletInvoiceById({ apiKey, shopUsername, invoiceId });
    }
  } catch (e) {
    logError("swapwallet_callback_invoice_lookup_failed", e, { orderId, invoiceId });
    await notifyAdmins(
      `⚠️ خطا در بررسی پرداخت SwapWallet\norderId: ${orderId || "-"}\ninvoiceId: ${invoiceId || "-"}\nعلت: ${(e as Error).message || String(e)}`
    );
    res.status(500).json({ ok: false, error: "Could not verify invoice with SwapWallet" });
    return;
  }

  const resolvedOrderId = String(orderId || invoice?.orderId || "").trim();
  const status = String(invoice?.status || "").trim();
  const paid = invoice ? isSwapwalletInvoicePaid(invoice) : false;

  if (resolvedOrderId) {
    try {
      await ensureSchema();
      await sql`UPDATE orders SET swapwallet_status = ${status} WHERE purchase_id = ${resolvedOrderId};`;
    } catch (e) {
      logError("swapwallet_callback_update_order_failed", e, { resolvedOrderId, status });
    }
  }

  if (!paid) {
    logInfo("swapwallet_callback_not_paid", { orderId: resolvedOrderId, status });
    res.status(200).json({ ok: true, received: true, paid: false });
    return;
  }

  if (!resolvedOrderId) {
    res.status(400).json({ ok: false, error: "Missing orderId" });
    return;
  }

  const result = await fulfillOrderByPaymentId(resolvedOrderId);
  logInfo("swapwallet_callback_processed", { orderId: resolvedOrderId, ok: result.ok, reason: result.reason, status });
  res.status(200).json({ ok: result.ok, reason: result.reason });
}

// ─── Tetrapay ─────────────────────────────────────────────────────────────────

async function handleTetrapay(req: VercelRequest, res: VercelResponse) {
  const { verifyTetrapayOrder } = await import("../lib/tetrapay.js");

  const authority = req.body?.authority || req.query?.authority;
  const status = req.body?.status || req.query?.status;
  const hashId = req.body?.hash_id || req.query?.hash_id;

  if (!authority || typeof authority !== "string") {
    res.status(400).json({ ok: false, error: "authority is required" });
    return;
  }
  if (status != 100 && status != "100") {
    res.status(400).json({ ok: false, error: "Payment not completed" });
    return;
  }

  try {
    const apiKey = (await getSetting("tetrapay_api_key")) || "";
    const verifyRes = await verifyTetrapayOrder(authority, apiKey);
    if (!verifyRes.ok) {
      logError("tetrapay_callback_spoofed", new Error("Payment status not verified"), { authority, verifyRes });
      res.status(400).json({ ok: false, error: "Payment not completed or spoofed" });
      return;
    }
  } catch (statusErr) {
    logError("tetrapay_callback_verify_failed", statusErr, { authority });
    await notifyAdmins(
      `⚠️ خطا در تایید پرداخت TetraPay\nauthority: ${authority}\nعلت: ${(statusErr as Error).message || String(statusErr)}`
    );
    res.status(500).json({ ok: false, error: "Could not verify payment status with TetraPay" });
    return;
  }

  const paymentId = String(hashId);
  if (!paymentId) {
    res.status(400).json({ ok: false, error: "hash_id is missing" });
    return;
  }

  const result = await fulfillOrderByPaymentId(paymentId);
  logInfo("tetrapay_callback_processed", { paymentId, authority, ok: result.ok, reason: result.reason });

  if (req.method === "GET") {
    res.status(200).send(`
      <html dir="rtl" lang="fa">
        <head>
          <meta charset="utf-8">
          <title>نتیجه پرداخت</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: Tahoma, sans-serif; text-align: center; padding: 50px; background: #f9f9f9; }
            .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; }
            h2 { color: ${result.ok ? "#4caf50" : "#e53935"}; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>${result.ok ? "پرداخت موفق" : "خطا یا پرداخت تکراری"}</h2>
            <p>وضعیت پرداخت شما ثبت شد. می‌توانید به ربات تلگرام برگردید.</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  res.status(200).json({ ok: result.ok, reason: result.reason });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const provider = String(req.query?.provider || "").toLowerCase().trim();

  try {
    if (provider === "plisio") {
      if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }
      await handlePlisio(req, res);
    } else if (provider === "tronado") {
      if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }
      await handleTronado(req, res);
    } else if (provider === "swapwallet") {
      if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }
      await handleSwapwallet(req, res);
    } else if (provider === "tetrapay") {
      await handleTetrapay(req, res);
    } else {
      res.status(400).json({ ok: false, error: "Unknown payment provider" });
    }
  } catch (error) {
    logError("payment_callback_failed", error, { provider, method: req.method, hasBody: Boolean(req.body) });
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
}
