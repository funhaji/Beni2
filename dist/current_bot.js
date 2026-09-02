import dns from "node:dns";
try {
    dns.setDefaultResultOrder("ipv4first");
}
catch (e) { }
import fetch from "node-fetch";
import { ensureSchema, resetBusinessDataPreserveCaches, sql } from "./db.js";
import { env } from "./env.js";
import { logError, logInfo } from "./log.js";
import { getOrderToken, getStatusByPaymentId, getTronPriceToman } from "./tronado.js";
import { getAdminIds, getBoolSetting, getNumberSetting, getPublicBaseUrl, getSetting, setSetting, invalidateSettingsCache } from "./settings.js";
import { getUsdtRateTomanCached } from "./rates.js";
import { getCryptoTomanPerUnitCached } from "./crypto-rates.js";
import { escapeHtml, tg, tgDownloadFile, tgSendConfigQr } from "./telegram.js";
import { getAgentForUrl } from "./proxy.js";
import { restoreFromBackup } from "./backup.js";
import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
let botUsernameCache;
async function isAdmin(userId) {
    const ids = await getAdminIds();
    return ids.includes(userId);
}
function randomCode(length = 8) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
function startMediaTitle(kind, value) {
    const v = String(value || "").trim();
    if (kind === "none" || !v)
        return "╪«╪º┘à┘ê╪┤";
    if (kind === "text")
        return `┘à╪¬┘å: ${v.slice(0, 40)}${v.length > 40 ? "ΓÇª" : ""}`;
    if (kind === "sticker")
        return "╪º╪│╪¬█î┌⌐╪▒";
    if (kind === "animation")
        return "┌»█î┘ü";
    if (kind === "photo")
        return "╪╣┌⌐╪│";
    return "╪«╪º┘à┘ê╪┤";
}
async function sendStartMedia(chatId) {
    const kindRaw = (await getSetting("start_media_kind")) || "none";
    const value = (await getSetting("start_media_value")) || "";
    const kind = ["none", "text", "sticker", "animation", "photo"].includes(kindRaw)
        ? kindRaw
        : "none";
    const v = String(value || "").trim();
    if (kind === "none" || !v)
        return null;
    try {
        if (kind === "text") {
            await tg("sendMessage", { chat_id: chatId, text: v });
            return null;
        }
        if (kind === "sticker") {
            await tg("sendSticker", { chat_id: chatId, sticker: v });
            return null;
        }
        if (kind === "animation") {
            await tg("sendAnimation", { chat_id: chatId, animation: v });
            return null;
        }
        if (kind === "photo") {
            await tg("sendPhoto", { chat_id: chatId, photo: v });
            return null;
        }
    }
    catch (e) {
        logError("send_start_media_failed", e, { kind, chatId });
    }
}
function truncateText(value, max) {
    const v = String(value || "");
    if (v.length <= max)
        return v;
    return v.slice(0, Math.max(0, max - 1)) + "ΓÇª";
}
function formatPriceToman(value) {
    const amount = Math.round(Number(value) || 0);
    return amount.toLocaleString("en-US");
}
function formatPaymentMethodTitle(methodRaw) {
    const method = String(methodRaw || "").trim().toLowerCase();
    if (method === "wallet")
        return "┌⌐█î┘ü ┘╛┘ê┘ä";
    if (method === "card2card")
        return "┌⌐╪º╪▒╪¬ΓÇî╪¿┘çΓÇî┌⌐╪º╪▒╪¬";
    if (method === "tronado")
        return "TRON (Tronado)";
    if (method === "tetrapay")
        return "╪¬╪¬╪▒╪º┘╛█î";
    if (method === "plisio")
        return "Plisio";
    if (method === "swapwallet")
        return "SwapWallet";
    if (method === "crypto")
        return "┌⌐╪▒█î┘╛╪¬┘ê";
    if (method === "referral_reward")
        return "╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬";
    return methodRaw ? String(methodRaw) : "-";
}
function formatOrderStatusTitle(statusRaw) {
    const status = String(statusRaw || "").trim().toLowerCase();
    if (status === "pending")
        return "ΓÅ│ ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ┘╛╪▒╪»╪º╪«╪¬";
    if (status === "awaiting_receipt")
        return "≡ƒô╖ ┘à┘å╪¬╪╕╪▒ ╪º╪▒╪│╪º┘ä ╪▒╪│█î╪»";
    if (status === "receipt_submitted")
        return "≡ƒò╡∩╕Å ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪¿╪▒╪▒╪│█î";
    if (status === "fulfilling")
        return "ΓÜÖ∩╕Å ╪»╪▒ ╪¡╪º┘ä ╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î";
    if (status === "paid")
        return "Γ£à ╪¬╪¡┘ê█î┘ä ╪┤╪»┘ç";
    if (status === "denied")
        return "Γ¥î ╪▒╪» ╪┤╪»┘ç";
    if (status === "cancelled")
        return "≡ƒùæ ┘ä╪║┘ê ╪┤╪»┘ç";
    if (status === "awaiting_config")
        return "≡ƒº⌐ ┘å█î╪º╪▓┘à┘å╪» ┌⌐╪º┘å┘ü█î┌» ╪»╪│╪¬█î";
    return statusRaw ? String(statusRaw) : "-";
}
function formatWalletTransactionType(typeRaw) {
    const type = String(typeRaw || "").trim().toLowerCase();
    if (type === "charge")
        return "╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä";
    if (type === "purchase")
        return "╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä";
    if (type === "refund")
        return "╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç";
    if (type === "admin_add")
        return "╪º┘ü╪▓╪º█î╪┤ ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å";
    if (type === "admin_sub")
        return "┌⌐╪│╪▒ ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å";
    if (type === "referral_reward")
        return "╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬";
    return typeRaw ? String(typeRaw) : "-";
}
function parseStartCommand(text) {
    const match = text.trim().match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
    if (!match)
        return null;
    return { payload: String(match[1] || "").trim() || null };
}
function normalizeReferralRewardType(raw) {
    return String(raw || "").trim().toLowerCase() === "config" ? "config" : "wallet";
}
function normalizeReferralConfigDeliveryMode(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "panel")
        return "panel";
    if (value === "storage" || value === "admin")
        return "admin";
    return "admin";
}
function referralConfigDeliveryModeLabel(mode) {
    if (mode === "panel")
        return "╪¬╪¡┘ê█î┘ä ╪º╪▓ ┘╛┘å┘ä";
    return "╪¬╪¡┘ê█î┘ä ╪»╪│╪¬█î ╪º╪»┘à█î┘å (╪º┘ê┘ä┘ê█î╪¬ ╪¿╪º ╪º┘å╪¿╪º╪▒)";
}
function referralRewardStatusLabel(status) {
    if (status === "granted")
        return "╪¬╪¡┘ê█î┘ä ╪┤╪»";
    if (status === "awaiting_admin")
        return "╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪¬╪¡┘ê█î┘ä ╪º╪»┘à█î┘å";
    if (status === "blocked")
        return "┘à╪¬┘ê┘é┘ü ╪¿┘ç ╪»┘ä█î┘ä ┌⌐┘à╪¿┘ê╪»/╪¬┘å╪╕█î┘à╪º╪¬";
    return "╪»╪▒ ╪¡╪º┘ä ┘╛╪▒╪»╪º╪▓╪┤";
}
function getReferralRemainingCount(qualifiedCount, threshold) {
    if (threshold <= 0)
        return 0;
    const safeQualified = Math.max(0, Math.floor(qualifiedCount));
    const remainder = safeQualified % threshold;
    return remainder === 0 ? 0 : threshold - remainder;
}
function describeReferralReward(settings, productName) {
    if (settings.rewardType === "config") {
        return productName ? `█î┌⌐ ┌⌐╪º┘å┘ü█î┌» ╪º╪▓ ┘à╪¡╪╡┘ê┘ä ┬½${productName}┬╗ (╪▒┘ê╪┤ ╪¬╪¡┘ê█î┘ä ╪«┘ê╪»┌⌐╪º╪▒ ╪¿╪▒ ╪º╪│╪º╪│ ┘╛┘å┘ä ┘à╪¡╪╡┘ê┘ä)` : `█î┌⌐ ┌⌐╪º┘å┘ü█î┌» ╪▒╪º█î┌»╪º┘å (╪▒┘ê╪┤ ╪¬╪¡┘ê█î┘ä ╪«┘ê╪»┌⌐╪º╪▒)`;
    }
    return `${formatPriceToman(settings.walletAmount)} ╪¬┘ê┘à╪º┘å ╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä`;
}
async function getBotUsername() {
    if (botUsernameCache !== undefined)
        return botUsernameCache;
    try {
        const me = await tg("getMe", {});
        botUsernameCache = me.username ? String(me.username).replace(/^@/, "").trim() : null;
    }
    catch (error) {
        logError("telegram_get_me_failed", error, {});
        return null;
    }
    return botUsernameCache;
}
async function buildReferralInviteLink(userId) {
    const username = await getBotUsername();
    if (!username)
        return null;
    return `https://t.me/${username}?start=ref_${userId}`;
}
function buildReferralShareUrl(inviteLink) {
    const message = `╪¿╪º ┘ä█î┘å┌⌐ ┘à┘å ┘ê╪º╪▒╪» ╪▒╪¿╪º╪¬ ╪┤┘ê ┘ê ╪º╪▓ ╪│╪▒┘ê█î╪│ ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å:\n${inviteLink}`;
    return `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(message)}`;
}
async function getReferralSettingsSnapshot() {
    const rewardType = normalizeReferralRewardType(await getSetting("referral_reward_type"));
    const configDeliveryMode = normalizeReferralConfigDeliveryMode(await getSetting("referral_config_delivery_mode"));
    const thresholdRaw = await getNumberSetting("referral_invite_threshold");
    const walletAmountRaw = await getNumberSetting("referral_wallet_amount_toman");
    const productIdRaw = await getNumberSetting("referral_reward_product_id");
    const threshold = Math.max(1, Math.round(Number(thresholdRaw || 5)));
    const walletAmount = Math.max(0, Math.round(Number(walletAmountRaw || 0)));
    const productId = Number.isFinite(Number(productIdRaw)) && Number(productIdRaw) > 0 ? Math.round(Number(productIdRaw)) : null;
    return {
        enabled: await getBoolSetting("referral_enabled", false),
        threshold,
        rewardType,
        walletAmount,
        productId,
        configDeliveryMode
    };
}
async function countUserReferralLeads(userId) {
    const rows = await sql `SELECT COUNT(*)::int AS count FROM users WHERE referred_by_telegram_id = ${userId};`;
    return Number(rows[0]?.count || 0);
}
async function countUserQualifiedReferrals(userId) {
    const rows = await sql `
    SELECT COUNT(*)::int AS count
    FROM users
    WHERE referred_by_telegram_id = ${userId}
      AND referral_qualified_at IS NOT NULL;
  `;
    return Number(rows[0]?.count || 0);
}
async function countUserReferralRewards(userId) {
    const rows = await sql `
    SELECT COUNT(*)::int AS count
    FROM referral_rewards
    WHERE inviter_telegram_id = ${userId}
      AND COALESCE(status, 'granted') IN ('granted', 'awaiting_admin');
  `;
    return Number(rows[0]?.count || 0);
}
async function getUserReferralRewardStatusSummary(userId) {
    const rows = await sql `
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(status, 'granted') = 'granted')::int AS granted_count,
      COUNT(*) FILTER (WHERE COALESCE(status, 'granted') = 'awaiting_admin')::int AS awaiting_admin_count,
      COUNT(*) FILTER (WHERE COALESCE(status, 'granted') = 'blocked')::int AS blocked_count
    FROM referral_rewards
    WHERE inviter_telegram_id = ${userId};
  `;
    return {
        granted: Number(rows[0]?.granted_count || 0),
        awaitingAdmin: Number(rows[0]?.awaiting_admin_count || 0),
        blocked: Number(rows[0]?.blocked_count || 0)
    };
}
async function captureReferralAttribution(userId, payload) {
    const normalized = String(payload || "").trim().toLowerCase();
    if (!normalized.startsWith("ref_"))
        return false;
    const inviterId = Number(normalized.slice(4));
    if (!Number.isFinite(inviterId) || inviterId <= 0 || inviterId === userId)
        return false;
    const inviterRows = await sql `SELECT telegram_id FROM users WHERE telegram_id = ${inviterId} LIMIT 1;`;
    if (!inviterRows.length)
        return false;
    const updated = await sql `
    UPDATE users
    SET referred_by_telegram_id = ${inviterId},
        referral_joined_at = COALESCE(referral_joined_at, NOW())
    WHERE telegram_id = ${userId}
      AND referred_by_telegram_id IS NULL
    RETURNING telegram_id;
  `;
    return updated.length > 0;
}
async function createReferralRewardOrder(inviterId, productId, batch) {
    const globalInfinite = await getBoolSetting("global_infinite_mode", false);
    const rows = await sql `
    SELECT
      p.id,
      p.name,
      p.is_infinite,
      p.sell_mode,
      p.panel_id,
      p.panel_sell_limit,
      p.panel_delivery_mode,
      p.panel_config,
      pnl.active AS panel_active,
      pnl.allow_new_sales AS panel_allow_new_sales,
      (
        SELECT COUNT(*)::int
        FROM inventory i
        WHERE i.product_id = p.id AND i.status = 'available'
      ) AS stock,
      (
        SELECT COUNT(*)::int
        FROM orders o
        WHERE o.product_id = p.id
          AND o.sell_mode = 'panel'
          AND o.status NOT IN ('denied')
      ) AS panel_sales_count
    FROM products p
    LEFT JOIN panels pnl ON pnl.id = p.panel_id
    WHERE p.id = ${productId}
    LIMIT 1;
  `;
    if (!rows.length) {
        return { ok: false, reason: "product_not_found" };
    }
    const product = rows[0];
    const purchaseId = `R${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
    const originalSellMode = parseSellMode(String(product.sell_mode || ""));
    const panelRemaining = Number(product.panel_sell_limit || 0) > 0 ? Math.max(0, Number(product.panel_sell_limit) - Number(product.panel_sales_count || 0)) : Infinity;
    let sellMode = originalSellMode;
    let sourcePanelId = product.panel_id ? Number(product.panel_id) : null;
    let panelConfigSnapshot = sanitizePanelConfig(product.panel_config);
    if (sellMode === "panel" && (!product.panel_id || !product.panel_active || !product.panel_allow_new_sales || panelRemaining <= 0)) {
        sellMode = "manual";
        sourcePanelId = null;
        panelConfigSnapshot = { ...panelConfigSnapshot, force_awaiting_config: true };
    }
    if (sellMode !== "panel" && !globalInfinite && !Boolean(product.is_infinite) && Number(product.stock || 0) <= 0) {
        panelConfigSnapshot = { ...panelConfigSnapshot, force_awaiting_config: true };
    }
    const orderId = await insertOrderRecord({
        purchaseId,
        telegramId: inviterId,
        productId: Number(product.id),
        productNameSnapshot: `${String(product.name || "").trim()} | ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ (${batch})`,
        sellMode,
        sourcePanelId,
        panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
        panelConfigSnapshot,
        paymentMethod: "referral_reward",
        discountCode: null,
        discountAmount: 0,
        finalPrice: 0,
        tronAmount: 0,
        status: "pending",
        walletUsed: 0,
        walletTransactionDescription: `╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å (${purchaseId})`
    });
    const result = await finalizeOrder(orderId, null);
    if (!result.ok) {
        await sql `DELETE FROM orders WHERE id = ${orderId} AND payment_method = 'referral_reward' AND status IN ('pending', 'receipt_submitted');`;
        return { ok: false, reason: result.reason };
    }
    return { ok: true, orderId, purchaseId, reason: result.reason };
}
async function maybeGrantReferralRewards(inviterId) {
    const settings = await getReferralSettingsSnapshot();
    if (!settings.enabled || settings.threshold <= 0)
        return null;
    if (settings.rewardType === "wallet" && settings.walletAmount <= 0)
        return null;
    if (settings.rewardType === "config" && !settings.productId)
        return null;
    const qualifiedCount = await countUserQualifiedReferrals(inviterId);
    const totalBatches = Math.floor(qualifiedCount / settings.threshold);
    if (totalBatches <= 0)
        return null;
    let productName = null;
    if (settings.rewardType === "config" && settings.productId) {
        const productRows = await sql `SELECT name FROM products WHERE id = ${settings.productId} LIMIT 1;`;
        productName = productRows.length ? String(productRows[0].name || "") : null;
        if (!productName) {
            await notifyAdmins(`ΓÜá∩╕Å ╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬ ╪¬┘å╪╕█î┘à ╪┤╪»┘ç ╪º┘à╪º ┘à╪¡╪╡┘ê┘ä ╪¼╪º█î╪▓┘ç ┘╛█î╪»╪º ┘å╪┤╪».\nproduct_id: ${settings.productId}`);
            return null;
        }
    }
    for (let batch = 1; batch <= totalBatches; batch += 1) {
        const reserved = await sql `
      INSERT INTO referral_rewards (
        inviter_telegram_id,
        reward_batch,
        referred_count_snapshot,
        threshold_snapshot,
        reward_type,
        wallet_amount,
        product_id,
        description
      )
      VALUES (
        ${inviterId},
        ${batch},
        ${qualifiedCount},
        ${settings.threshold},
        ${settings.rewardType},
        ${settings.rewardType === "wallet" ? settings.walletAmount : 0},
        ${settings.rewardType === "config" ? settings.productId : null},
        ${`Reward batch ${batch}`}
      )
      ON CONFLICT (inviter_telegram_id, reward_batch) DO NOTHING
      RETURNING id;
    `;
        if (!reserved.length)
            continue;
        const rewardId = Number(reserved[0].id);
        try {
            if (settings.rewardType === "wallet") {
                await sql `
          UPDATE users
          SET wallet_balance = wallet_balance + ${settings.walletAmount}
          WHERE telegram_id = ${inviterId};
        `;
                await sql `
          INSERT INTO wallet_transactions (telegram_id, amount, type, description)
          VALUES (
            ${inviterId},
            ${settings.walletAmount},
            'referral_reward',
            ${`╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å - ┘à╪▒╪¡┘ä┘ç ${batch}`}
          );
        `;
                await sql `
          UPDATE referral_rewards
          SET description = ${`╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å - ${formatPriceToman(settings.walletAmount)} ╪¬┘ê┘à╪º┘å ╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä`}
          WHERE id = ${rewardId};
        `;
                await tg("sendMessage", {
                    chat_id: inviterId,
                    text: `≡ƒÄü ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪┤┘à╪º ╪ó┘à╪º╪»┘ç ╪┤╪»!\n` +
                        `┘à╪▒╪¡┘ä┘ç: ${batch}\n` +
                        `┘╛╪º╪»╪º╪┤: ${formatPriceToman(settings.walletAmount)} ╪¬┘ê┘à╪º┘å ╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä\n` +
                        `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪¬╪º█î█î╪»╪┤╪»┘ç: ${qualifiedCount}`
                }).catch(() => { });
                await notifyAdmins(`≡ƒÄü ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪┤╪»\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n┘╛╪º╪»╪º╪┤: ${formatPriceToman(settings.walletAmount)} ╪¬┘ê┘à╪º┘å ╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä\n╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪¬╪º█î█î╪»╪┤╪»┘ç: ${qualifiedCount}`);
                continue;
            }
            const granted = await createReferralRewardOrder(inviterId, Number(settings.productId), batch);
            if (!granted.ok) {
                await sql `DELETE FROM referral_rewards WHERE id = ${rewardId};`;
                await notifyAdmins(`ΓÜá∩╕Å ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┌⌐╪º┘å┘ü█î┌» ┘╛╪▒╪»╪º╪«╪¬ ┘å╪┤╪»\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n┘à╪¡╪╡┘ê┘ä: ${productName || settings.productId}\n╪╣┘ä╪¬: ${granted.reason}`);
                continue;
            }
            await sql `
        UPDATE referral_rewards
        SET order_id = ${granted.orderId},
            description = ${`╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å - ${productName || "┌⌐╪º┘å┘ü█î┌» ╪▒╪º█î┌»╪º┘å"}`}
        WHERE id = ${rewardId};
      `;
            await tg("sendMessage", {
                chat_id: inviterId,
                text: `≡ƒÄü ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪┤┘à╪º ╪½╪¿╪¬ ╪┤╪»!\n` +
                    `┘à╪▒╪¡┘ä┘ç: ${batch}\n` +
                    `┘╛╪º╪»╪º╪┤: ${productName ? `┌⌐╪º┘å┘ü█î┌» ${productName}` : "┌⌐╪º┘å┘ü█î┌» ╪▒╪º█î┌»╪º┘å"}\n` +
                    `╪┤┘å╪º╪│┘ç ╪│┘ü╪º╪▒╪┤: ${granted.purchaseId}`
            }).catch(() => { });
            await notifyAdmins(`≡ƒÄü ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┌⌐╪º┘å┘ü█î┌» ╪½╪¿╪¬ ╪┤╪»\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n┘à╪¡╪╡┘ê┘ä: ${productName || settings.productId}\n╪│┘ü╪º╪▒╪┤: ${granted.purchaseId}`);
        }
        catch (error) {
            await sql `DELETE FROM referral_rewards WHERE id = ${rewardId};`;
            logError("grant_referral_reward_failed", error, { inviterId, batch });
        }
    }
}
async function createReferralRewardOrderV2(inviterId, productId, batch) {
    const rows = await sql `
    SELECT
      p.id,
      p.name,
      p.is_infinite,
      p.sell_mode,
      p.panel_id,
      p.panel_sell_limit,
      p.panel_delivery_mode,
      p.panel_config,
      pnl.active AS panel_active,
      pnl.allow_new_sales AS panel_allow_new_sales,
      pnl.panel_type AS panel_type,
      (
        SELECT COUNT(*)::int
        FROM inventory i
        WHERE i.product_id = p.id AND i.status = 'available'
      ) AS stock,
      (
        SELECT COUNT(*)::int
        FROM orders o
        WHERE o.product_id = p.id
          AND o.sell_mode = 'panel'
          AND o.status NOT IN ('denied')
      ) AS panel_sales_count
    FROM products p
    LEFT JOIN panels pnl ON pnl.id = p.panel_id
    WHERE p.id = ${productId}
    LIMIT 1;
  `;
    if (!rows.length) {
        return { ok: false, reason: "product_not_found", status: "blocked", deliveryMode: "admin" };
    }
    const product = rows[0];
    const purchaseId = `R${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
    const basePanelConfig = sanitizePanelConfig(product.panel_config);
    const panelRemaining = Number(product.panel_sell_limit || 0) > 0 ? Math.max(0, Number(product.panel_sell_limit) - Number(product.panel_sales_count || 0)) : Infinity;
    let sellMode = "manual";
    let sourcePanelId = null;
    let panelConfigSnapshot = basePanelConfig;
    // Auto-detect delivery mode: if the product has a v2ray panel linked ΓåÆ panel mode (auto-create config).
    // Otherwise ΓåÆ admin mode (ask admin to deliver config manually).
    const hasPanel = !!(product.panel_id);
    const deliveryMode = hasPanel ? "panel" : "admin";
    if (deliveryMode === "panel") {
        if (Number(product.panel_sell_limit || 0) > 0 && panelRemaining <= 0) {
            // Panel sell limit exhausted ΓÇö fall back to admin delivery instead of blocking.
            sellMode = "manual";
            sourcePanelId = null;
            panelConfigSnapshot = { ...basePanelConfig, force_awaiting_config: true };
        }
        else {
            sellMode = "panel";
            sourcePanelId = Number(product.panel_id);
        }
    }
    else {
        // No panel linked ΓÇö admin must deliver manually. Try inventory first, then manual.
        if (Number(product.stock || 0) > 0) {
            sellMode = "manual";
            sourcePanelId = null;
            panelConfigSnapshot = { ...basePanelConfig, force_require_inventory: true, force_awaiting_config: false };
        }
        else {
            sellMode = "manual";
            sourcePanelId = null;
            panelConfigSnapshot = { ...basePanelConfig, force_awaiting_config: true };
        }
    }
    const orderId = await insertOrderRecord({
        purchaseId,
        telegramId: inviterId,
        productId: Number(product.id),
        productNameSnapshot: `${String(product.name || "").trim()} | ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ (${batch})`,
        sellMode,
        sourcePanelId,
        panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
        panelConfigSnapshot,
        paymentMethod: "referral_reward",
        discountCode: null,
        discountAmount: 0,
        finalPrice: 0,
        tronAmount: 0,
        status: "pending",
        walletUsed: 0,
        walletTransactionDescription: `╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å (${purchaseId})`
    });
    const result = await finalizeOrder(orderId, null);
    if (result.ok) {
        return {
            ok: true,
            orderId,
            purchaseId,
            reason: result.reason,
            deliveryMode,
            status: (result.reason === "awaiting_config" ? "awaiting_admin" : "granted")
        };
    }
    const statusRows = await sql `SELECT status FROM orders WHERE id = ${orderId} LIMIT 1;`;
    const finalStatus = String(statusRows[0]?.status || "").toLowerCase();
    if (finalStatus === "awaiting_config") {
        return {
            ok: true,
            orderId,
            purchaseId,
            reason: result.reason,
            deliveryMode,
            status: "awaiting_admin"
        };
    }
    await sql `
    DELETE FROM orders
    WHERE id = ${orderId}
      AND payment_method = 'referral_reward'
      AND status IN ('pending', 'receipt_submitted', 'awaiting_receipt', 'fulfilling', 'cancelled');
  `;
    return { ok: false, reason: result.reason, deliveryMode, status: "blocked" };
}
async function maybeGrantReferralRewardsV2(inviterId) {
    const settings = await getReferralSettingsSnapshot();
    if (!settings.enabled) {
        logInfo("referral_reward_skipped_disabled", { inviterId });
        return null;
    }
    if (settings.threshold <= 0) {
        logInfo("referral_reward_skipped_invalid_threshold", { inviterId, threshold: settings.threshold });
        return null;
    }
    if (settings.rewardType === "wallet" && settings.walletAmount <= 0) {
        logInfo("referral_reward_skipped_wallet_amount_missing", { inviterId, walletAmount: settings.walletAmount });
        return null;
    }
    if (settings.rewardType === "config" && !settings.productId) {
        logError("referral_reward_config_missing_product", new Error("referral_reward_product_id_missing"), { inviterId });
        await notifyAdmins(`ΓÜá∩╕Å ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┌⌐╪º┘å┘ü█î┌» ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n╪╣┘ä╪¬: ┘à╪¡╪╡┘ê┘ä ╪¼╪º█î╪▓┘ç ╪º┘å╪¬╪«╪º╪¿ ┘å╪┤╪»┘ç ╪º╪│╪¬.`);
        await tg("sendMessage", {
            chat_id: inviterId,
            text: "ΓÜá∩╕Å ┘à╪¡╪╡┘ê┘ä ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┘ç┘å┘ê╪▓ ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç.\n" +
                "╪¿╪╣╪» ╪º╪▓ ╪¬┘å╪╕█î┘à ┘à╪¡╪╡┘ê┘ä╪î ╪¼╪º█î╪▓┘ç ╪┤┘à╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪½╪¿╪¬ ┘à█îΓÇî╪┤┘ê╪»."
        }).catch(() => { });
        return null;
    }
    const qualifiedCount = await countUserQualifiedReferrals(inviterId);
    const totalBatches = Math.floor(qualifiedCount / settings.threshold);
    if (totalBatches <= 0) {
        logInfo("referral_reward_skipped_no_batch", { inviterId, qualifiedCount, threshold: settings.threshold });
        return null;
    }
    for (let batch = 1; batch <= totalBatches; batch += 1) {
        let rewardRows = await sql `
      SELECT id, status, failure_reason, order_id, updated_at
      FROM referral_rewards
      WHERE inviter_telegram_id = ${inviterId}
        AND reward_batch = ${batch}
      LIMIT 1;
    `;
        if (!rewardRows.length) {
            rewardRows = await sql `
        INSERT INTO referral_rewards (
          inviter_telegram_id,
          reward_batch,
          referred_count_snapshot,
          threshold_snapshot,
          reward_type,
          reward_delivery_mode,
          status,
          wallet_amount,
          product_id,
          description,
          updated_at
        )
        VALUES (
          ${inviterId},
          ${batch},
          ${qualifiedCount},
          ${settings.threshold},
          ${settings.rewardType},
          ${null},
          'pending',
          ${settings.rewardType === "wallet" ? settings.walletAmount : 0},
          ${settings.rewardType === "config" ? settings.productId : null},
          ${`Reward batch ${batch}`},
          NOW()
        )
        RETURNING id, status, failure_reason, order_id, updated_at;
      `;
        }
        const rewardId = Number(rewardRows[0].id);
        const previousStatus = String(rewardRows[0].status || "granted").toLowerCase();
        const previousFailureReason = String(rewardRows[0].failure_reason || "");
        if (previousStatus === "granted")
            continue;
        if (previousStatus === "awaiting_admin") {
            const rewardOrderId = Number(rewardRows[0].order_id || 0);
            const updatedAtMs = Date.parse(String(rewardRows[0].updated_at || ""));
            const shouldRemind = !Number.isFinite(updatedAtMs) ||
                Date.now() - updatedAtMs >= 5 * 60 * 1000;
            if (rewardOrderId > 0 && shouldRemind) {
                const orderRows = await sql `
          SELECT purchase_id, status
          FROM orders
          WHERE id = ${rewardOrderId}
          LIMIT 1;
        `;
                if (orderRows.length && String(orderRows[0].status || "").toLowerCase() === "awaiting_config") {
                    await notifyAdmins(`≡ƒ¢á ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪º┘é╪»╪º┘à ╪º╪»┘à█î┘å ╪º╪│╪¬\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n╪│┘ü╪º╪▒╪┤: ${String(orderRows[0].purchase_id || "-")}`, { inline_keyboard: [[{ text: "╪º╪▒╪│╪º┘ä ┌⌐╪º┘å┘ü█î┌» ╪¼╪º█î╪▓┘ç", callback_data: `admin_provide_config_${rewardOrderId}` }]] });
                    if ((await getAdminIds()).length === 0) {
                        await tg("sendMessage", {
                            chat_id: inviterId,
                            text: "ΓÜá∩╕Å ╪¼╪º█î╪▓┘ç ╪┤┘à╪º ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î ╪º╪»┘à█î┘å ╪º╪│╪¬ ╪º┘à╪º ┘ç█î┌å ╪º╪»┘à█î┘å█î ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬.\n" +
                                "┘ä╪╖┘ü╪º┘ï ADMIN_IDS ╪▒╪º ╪¬┘å╪╕█î┘à ┌⌐┘å█î╪» █î╪º ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»."
                        }).catch(() => { });
                    }
                    await sql `UPDATE referral_rewards SET updated_at = NOW() WHERE id = ${rewardId};`;
                }
            }
            continue;
        }
        await sql `
      UPDATE referral_rewards
      SET referred_count_snapshot = ${qualifiedCount},
          threshold_snapshot = ${settings.threshold},
          reward_type = ${settings.rewardType},
          reward_delivery_mode = NULL,
          wallet_amount = ${settings.rewardType === "wallet" ? settings.walletAmount : 0},
          product_id = ${settings.rewardType === "config" ? settings.productId : null},
          status = 'pending',
          updated_at = NOW()
      WHERE id = ${rewardId};
    `;
        try {
            if (settings.rewardType === "wallet") {
                await sql `
          UPDATE users
          SET wallet_balance = wallet_balance + ${settings.walletAmount}
          WHERE telegram_id = ${inviterId};
        `;
                await sql `
          INSERT INTO wallet_transactions (telegram_id, amount, type, description)
          VALUES (
            ${inviterId},
            ${settings.walletAmount},
            'referral_reward',
            ${`╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å - ┘à╪▒╪¡┘ä┘ç ${batch}`}
          );
        `;
                await sql `
          UPDATE referral_rewards
          SET status = 'granted',
              failure_reason = NULL,
              description = ${`╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å - ${formatPriceToman(settings.walletAmount)} ╪¬┘ê┘à╪º┘å ╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä`},
              updated_at = NOW()
          WHERE id = ${rewardId};
        `;
                await tg("sendMessage", {
                    chat_id: inviterId,
                    text: `≡ƒÄü ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪┤┘à╪º ╪ó┘à╪º╪»┘ç ╪┤╪»!\n` +
                        `┘à╪▒╪¡┘ä┘ç: ${batch}\n` +
                        `┘╛╪º╪»╪º╪┤: ${formatPriceToman(settings.walletAmount)} ╪¬┘ê┘à╪º┘å ╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä\n` +
                        `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪¬╪º█î█î╪»╪┤╪»┘ç: ${qualifiedCount}`
                }).catch(() => { });
                await notifyAdmins(`≡ƒÄü ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪┤╪»\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n┘╛╪º╪»╪º╪┤: ${formatPriceToman(settings.walletAmount)} ╪¬┘ê┘à╪º┘å ╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä\n╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪¬╪º█î█î╪»╪┤╪»┘ç: ${qualifiedCount}`);
                continue;
            }
            const productId = Number(settings.productId || 0);
            const productRows = await sql `SELECT name FROM products WHERE id = ${productId} LIMIT 1;`;
            const productName = productRows.length ? String(productRows[0].name || "") : "";
            const granted = await createReferralRewardOrderV2(inviterId, productId, batch);
            const detectedDeliveryMode = granted.deliveryMode;
            if (!granted.ok) {
                await sql `
          UPDATE referral_rewards
          SET status = 'blocked',
              failure_reason = ${granted.reason},
              description = ${`╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ - ${productName || productId} - ${granted.reason}`},
              updated_at = NOW()
          WHERE id = ${rewardId};
        `;
                await tg("sendMessage", {
                    chat_id: inviterId,
                    text: "ΓÜá∩╕Å ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪┤┘à╪º ┘ü╪╣┘ä╪º┘ï ┘é╪º╪¿┘ä ╪½╪¿╪¬ ┘å█î╪│╪¬.\n" +
                        "╪¿╪▒╪º█î ┘╛█î┌»█î╪▒█î╪î ╪º╪▓ ┘╛╪┤╪¬█î╪¿╪º┘å█î ┌⌐┘à┌⌐ ╪¿┌»█î╪▒█î╪»."
                }).catch(() => { });
                if (previousStatus !== "blocked" || previousFailureReason !== granted.reason) {
                    await notifyAdmins(`ΓÜá∩╕Å ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┌⌐╪º┘å┘ü█î┌» ┘╛╪▒╪»╪º╪«╪¬ ┘å╪┤╪»\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n┘à╪¡╪╡┘ê┘ä: ${productName || productId}\n╪╣┘ä╪¬: ${granted.reason}`);
                }
                continue;
            }
            const deliveryModeLabel = detectedDeliveryMode === "panel" ? "╪¬╪¡┘ê█î┘ä ╪«┘ê╪»┌⌐╪º╪▒ ╪º╪▓ ┘╛┘å┘ä" : "╪¬╪¡┘ê█î┘ä ╪»╪│╪¬█î ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å";
            await sql `
        UPDATE referral_rewards
        SET order_id = ${granted.orderId},
            reward_delivery_mode = ${detectedDeliveryMode},
            status = ${granted.status},
            failure_reason = NULL,
            description = ${`╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å - ${productName || "┌⌐╪º┘å┘ü█î┌» ╪▒╪º█î┌»╪º┘å"} (${deliveryModeLabel})`},
            updated_at = NOW()
        WHERE id = ${rewardId};
      `;
            await tg("sendMessage", {
                chat_id: inviterId,
                text: `≡ƒÄü ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪┤┘à╪º ╪½╪¿╪¬ ╪┤╪»!\n` +
                    `┘à╪▒╪¡┘ä┘ç: ${batch}\n` +
                    `┘╛╪º╪»╪º╪┤: ${productName ? `┌⌐╪º┘å┘ü█î┌» ${productName}` : "┌⌐╪º┘å┘ü█î┌» ╪▒╪º█î┌»╪º┘å"}\n` +
                    `╪▒┘ê╪┤ ╪¬╪¡┘ê█î┘ä: ${deliveryModeLabel}\n` +
                    `╪┤┘å╪º╪│┘ç ╪│┘ü╪º╪▒╪┤: ${granted.purchaseId}` +
                    (granted.status === "awaiting_admin" ? `\n┘ê╪╢╪╣█î╪¬: ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å` : "")
            }).catch(() => { });
            if (granted.status === "awaiting_admin") {
                await notifyAdmins(`≡ƒ¢á ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┘å█î╪º╪▓┘à┘å╪» ╪º┘é╪»╪º┘à ╪º╪»┘à█î┘å ╪º╪│╪¬\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n┘à╪¡╪╡┘ê┘ä: ${productName || productId}\n╪▒┘ê╪┤: ${deliveryModeLabel}\n╪│┘ü╪º╪▒╪┤: ${granted.purchaseId}`, {
                    inline_keyboard: [[{ text: "╪º╪▒╪│╪º┘ä ┌⌐╪º┘å┘ü█î┌» ╪¼╪º█î╪▓┘ç", callback_data: `admin_provide_config_${granted.orderId}` }]]
                });
                if ((await getAdminIds()).length === 0) {
                    await tg("sendMessage", {
                        chat_id: inviterId,
                        text: "ΓÜá∩╕Å ╪¼╪º█î╪▓┘ç ╪┤┘à╪º ╪½╪¿╪¬ ╪┤╪» ╪º┘à╪º ┘ç█î┌å ╪º╪»┘à█î┘å█î ╪¿╪▒╪º█î ╪¬╪¡┘ê█î┘ä ┌⌐╪º┘å┘ü█î┌» ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬.\n" +
                            "┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»."
                    }).catch(() => { });
                }
            }
            else if (granted.status === "granted") {
                await notifyAdmins(`≡ƒÄü ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┌⌐╪º┘å┘ü█î┌» ╪½╪¿╪¬ ╪┤╪»\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n┘à╪¡╪╡┘ê┘ä: ${productName || productId}\n╪▒┘ê╪┤: ${deliveryModeLabel}\n╪│┘ü╪º╪▒╪┤: ${granted.purchaseId}`);
            }
        }
        catch (error) {
            await sql `
        UPDATE referral_rewards
        SET status = 'blocked',
            failure_reason = 'unexpected_error',
            description = '╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ - unexpected_error',
            updated_at = NOW()
        WHERE id = ${rewardId};
      `;
            await notifyAdmins(`Γ¥î ╪«╪╖╪º ╪»╪▒ ╪½╪¿╪¬ ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬\n┌⌐╪º╪▒╪¿╪▒: ${inviterId}\n┘à╪▒╪¡┘ä┘ç: ${batch}\n╪╣┘ä╪¬: ${String(error?.message || error || "unknown")}`);
            await tg("sendMessage", {
                chat_id: inviterId,
                text: "Γ¥î ╪»╪▒ ╪½╪¿╪¬ ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪«╪╖╪º█î ╪»╪º╪«┘ä█î ╪▒╪« ╪»╪º╪».\n" +
                    "┘à┘ê╪╢┘ê╪╣ ╪¿╪▒╪º█î ╪º╪»┘à█î┘å ╪º╪▒╪│╪º┘ä ╪┤╪». ┘ä╪╖┘ü╪º┘ï ┌⌐┘à█î ╪¿╪╣╪» ╪»┘ê╪¿╪º╪▒┘ç ╪¿╪▒╪▒╪│█î ┌⌐┘å█î╪»."
            }).catch(() => { });
            logError("grant_referral_reward_v2_failed", error, { inviterId, batch });
        }
    }
}
async function maybeQualifyReferralUser(userId) {
    const qualified = await sql `
    UPDATE users
    SET referral_qualified_at = NOW()
    WHERE telegram_id = ${userId}
      AND referred_by_telegram_id IS NOT NULL
      AND referral_qualified_at IS NULL
    RETURNING referred_by_telegram_id;
  `;
    if (!qualified.length)
        return null;
    const inviterId = Number(qualified[0].referred_by_telegram_id || 0);
    if (!Number.isFinite(inviterId) || inviterId <= 0)
        return null;
    const settings = await getReferralSettingsSnapshot();
    const qualifiedCount = await countUserQualifiedReferrals(inviterId);
    const referredRows = await sql `
    SELECT username, first_name, last_name
    FROM users
    WHERE telegram_id = ${userId}
    LIMIT 1;
  `;
    const referred = referredRows[0];
    const referredName = [String(referred?.first_name || "").trim(), String(referred?.last_name || "").trim()].filter(Boolean).join(" ").trim() ||
        (referred?.username ? `@${String(referred.username).replace(/^@/, "").trim()}` : "█î┌⌐ ┌⌐╪º╪▒╪¿╪▒");
    const trailingLines = [];
    if (settings.enabled && settings.threshold > 0) {
        const remaining = getReferralRemainingCount(qualifiedCount, settings.threshold);
        trailingLines.push(remaining > 0 ? `┘ü┘é╪╖ ${remaining} ┘å┘ü╪▒ ╪¬╪º ┘╛╪º╪»╪º╪┤ ╪¿╪╣╪»█î ╪¿╪º┘é█î ┘à╪º┘å╪»┘ç ╪º╪│╪¬.` : "Γ£à ╪ó╪│╪¬╪º┘å┘ç ┘╛╪º╪»╪º╪┤ ╪¬┌⌐┘à█î┘ä ╪┤╪». ┘ê╪╢╪╣█î╪¬ ╪½╪¿╪¬ ╪¼╪º█î╪▓┘ç ╪¬╪º ┘ä╪¡╪╕╪º╪¬█î ╪»█î┌»╪▒ ╪º╪╣┘ä╪º┘à ┘à█îΓÇî╪┤┘ê╪».");
    }
    await tg("sendMessage", {
        chat_id: inviterId,
        text: `≡ƒæÑ ╪»╪╣┘ê╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪»!\n` +
            `┌⌐╪º╪▒╪¿╪▒: ${referredName}\n` +
            `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪¬╪º█î█î╪»╪┤╪»┘ç: ${qualifiedCount}` +
            (trailingLines.length ? `\n${trailingLines.join("\n")}` : "")
    }).catch(() => { });
    await maybeGrantReferralRewardsV2(inviterId);
}
function normalizePricePerGb(raw, fallback = 500000) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0)
        return fallback;
    return Math.round(n);
}
function parseDataAmountToMb(raw) {
    const value = raw.trim().replaceAll(" ", "").toLowerCase();
    const gbMatch = value.match(/^(\d+(?:\.\d+)?)(gb|g)$/i);
    if (gbMatch) {
        const n = Number(gbMatch[1]);
        return (Number.isFinite(n) && n > 0) ? Math.round(n * 1024) : null;
    }
    const mbMatch = value.match(/^(\d+(?:\.\d+)?)(mb|m)$/i);
    if (mbMatch) {
        const n = Number(mbMatch[1]);
        return (Number.isFinite(n) && n > 0) ? Math.round(n) : null;
    }
    const tbMatch = value.match(/^(\d+(?:\.\d+)?)(tb|t)$/i);
    if (tbMatch) {
        const n = Number(tbMatch[1]);
        return (Number.isFinite(n) && n > 0) ? Math.round(n * 1024 * 1024) : null;
    }
    const plain = Number(value);
    return (Number.isFinite(plain) && plain > 0) ? Math.round(plain) : null;
}
function parseInfiniteDataFlag(raw) {
    const normalized = raw.trim().toLowerCase();
    return ["infinite", "unlimited", "Γê₧", "inf", "┘å╪º┘à╪¡╪»┘ê╪»", "╪¿█î┘å┘ç╪º█î╪¬", "╪¿█îΓÇî┘å┘ç╪º█î╪¬", "╪¿┘ëΓÇî┘å┘ç╪º┘è╪¬"].includes(normalized);
}
function formatBytesShort(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0)
        return "0";
    const mb = bytes / (1024 * 1024);
    if (mb < 1024)
        return `${mb.toFixed(0)}MB`;
    return `${(mb / 1024).toFixed(2)}GB`;
}
function formatExpiryLabelFromSeconds(unixSeconds) {
    const n = Number(unixSeconds);
    if (!Number.isFinite(n) || n <= 0)
        return "╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º";
    const ts = n * 1000;
    return `${new Date(ts).toLocaleString("en-US")} (${Math.max(0, Math.ceil((ts - Date.now()) / (24 * 60 * 60 * 1000)))} ╪▒┘ê╪▓ ┘à╪º┘å╪»┘ç)`;
}
function formatExpiryLabelFromMilliseconds(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0)
        return "╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º";
    return `${new Date(n).toLocaleString("en-US")} (${Math.max(0, Math.ceil((n - Date.now()) / (24 * 60 * 60 * 1000)))} ╪▒┘ê╪▓ ┘à╪º┘å╪»┘ç)`;
}
function parsePanelType(raw) {
    const value = raw.trim().toLowerCase();
    if (value === "marzban" || value === "sanaei" || value === "pasarguard")
        return value;
    return null;
}
export function isMarzbanLike(panelType) {
    return panelType === "marzban" || panelType === "pasarguard";
}
export function normalizeBaseUrl(raw) {
    return raw.trim().replace(/\/+$/, "");
}
/**
 * Resolve a Marzban/PasarGuard subscription_url that may be relative (e.g. "/sub/token")
 * into a full absolute URL using the panel's base URL.
 */
export function resolveMarzbanSubUrl(panelBaseUrl, rawSubUrl) {
    const sub = rawSubUrl.trim();
    if (!sub)
        return "";
    if (sub.startsWith("http://") || sub.startsWith("https://"))
        return sub;
    if (sub.startsWith("/"))
        return normalizeBaseUrl(panelBaseUrl) + sub;
    return sub;
}
function normalizeFieldKey(raw) {
    return raw.trim().toLowerCase().replace(/[ \-]+/g, "_");
}
function parseSellMode(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "panel" || value === "auto_panel" || value === "panel_sale")
        return "panel";
    if (value === "pingchi")
        return "pingchi";
    return "manual";
}
function parseDeliveryMode(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "sub" || value === "subscription" || value === "sub_only")
        return "sub";
    if (value === "configs" || value === "config" || value === "configs_only")
        return "configs";
    return "both";
}
function formatDeliveryModeLabel(mode) {
    if (mode === "both")
        return "╪│╪º╪¿ + ┌⌐╪º┘å┘ü█î┌»";
    if (mode === "sub")
        return "┘ü┘é╪╖ ╪│╪º╪¿";
    return "┘ü┘é╪╖ ┌⌐╪º┘å┘ü█î┌»";
}
function parseProductKind(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "account" || value === "acc")
        return "account";
    return "v2ray";
}
function toJsonObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return null;
}
function parseJsonValue(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function parseFlexibleFields(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return {};
    if (trimmed.startsWith("{")) {
        const parsed = toJsonObject(parseJsonValue(trimmed));
        return parsed || {};
    }
    if (!trimmed.includes(":") && !trimmed.includes("="))
        return {};
    const fields = {};
    const lines = trimmed.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line)
            continue;
        const match = line.match(/^([^:=]+)\s*[:=]\s*(.*)$/);
        if (!match)
            return {};
        const key = normalizeFieldKey(match[1]);
        let value = match[2].trim();
        if (!value && i + 1 < lines.length && lines[i + 1].trim().startsWith("{")) {
            const block = [];
            let balance = 0;
            for (let j = i + 1; j < lines.length; j += 1) {
                const blockLine = lines[j];
                block.push(blockLine);
                const opens = (blockLine.match(/\{/g) || []).length;
                const closes = (blockLine.match(/\}/g) || []).length;
                balance += opens - closes;
                i = j;
                if (balance <= 0 && block.length)
                    break;
            }
            value = block.join("\n").trim();
        }
        fields[key] = value;
    }
    return fields;
}
function getFieldValue(fields, ...keys) {
    for (const key of keys) {
        const direct = fields[key];
        if (direct !== undefined && direct !== null && String(direct).trim() !== "") {
            return direct;
        }
    }
    return null;
}
function parseMaybeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function parseMaybeBoolean(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!normalized)
        return null;
    if (["true", "1", "yes", "on", "┘ü╪╣╪º┘ä", "╪▒┘ê╪┤┘å"].includes(normalized))
        return true;
    if (["false", "0", "no", "off", "╪║█î╪▒┘ü╪╣╪º┘ä", "╪«╪º┘à┘ê╪┤"].includes(normalized))
        return false;
    return null;
}
function mergeDeep(base, override) {
    const baseObj = toJsonObject(base);
    const overrideObj = toJsonObject(override);
    if (!baseObj || !overrideObj) {
        return override === undefined ? base : override;
    }
    const merged = { ...baseObj };
    for (const [key, value] of Object.entries(overrideObj)) {
        merged[key] = key in merged ? mergeDeep(merged[key], value) : value;
    }
    return merged;
}
function applyTemplate(value, context) {
    if (typeof value === "string") {
        return value.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key) => context[key] ?? "");
    }
    if (Array.isArray(value)) {
        return value.map((item) => applyTemplate(item, context));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, applyTemplate(child, context)]));
    }
    return value;
}
function sanitizePanelConfig(raw) {
    if (typeof raw === "string") {
        const parsed = parseJsonValue(raw.trim());
        return toJsonObject(parsed) || {};
    }
    return toJsonObject(raw) || {};
}
function getOrderBulkQuantity(order, panelConfig) {
    const cfg = panelConfig ?? sanitizePanelConfig(order.panel_config_snapshot);
    const fromSnapshot = Math.round(Number(cfg.bulk_quantity || 0));
    const fromColumn = Math.round(Number(order.quantity || 0));
    return Math.max(1, fromSnapshot, fromColumn);
}
function serializeDeliveryPayload(payload) {
    return JSON.stringify({
        subscriptionUrl: payload.subscriptionUrl || null,
        configLinks: payload.configLinks || [],
        previousConfigs: payload.previousConfigs || [],
        primaryQr: payload.primaryQr || null,
        primaryText: payload.primaryText || null,
        metadata: payload.metadata || {}
    });
}
export function parseDeliveryPayload(raw) {
    const payload = toJsonObject(raw) || {};
    const configLinks = Array.isArray(payload.configLinks)
        ? payload.configLinks.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
    const previousConfigs = Array.isArray(payload.previousConfigs)
        ? payload.previousConfigs.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
    return {
        subscriptionUrl: payload.subscriptionUrl ? String(payload.subscriptionUrl) : null,
        configLinks,
        previousConfigs,
        primaryQr: payload.primaryQr ? String(payload.primaryQr) : null,
        primaryText: payload.primaryText ? String(payload.primaryText) : null,
        metadata: toJsonObject(payload.metadata) || {}
    };
}
function configSummaryLine(payload, outboundHostHint) {
    const configCount = payload.configLinks?.length || 0;
    let base = payload.subscriptionUrl && configCount
        ? `╪│╪º╪¿ + ${configCount} ┌⌐╪º┘å┘ü█î┌»`
        : payload.subscriptionUrl
            ? "┘ü┘é╪╖ ╪│╪º╪¿"
            : configCount
                ? `${configCount} ┌⌐╪º┘å┘ü█î┌»`
                : "┘å╪º┘à╪┤╪«╪╡";
    const h = (outboundHostHint || "").trim();
    if (h) {
        const short = h.length > 24 ? `${h.slice(0, 22)}ΓÇª` : h;
        base = `${base} ┬╖ @${short}`;
    }
    return base;
}
function getV2rayProductKindFromRow(row) {
    const panelConfig = sanitizePanelConfig(row.panel_config);
    return parseProductKind(panelConfig.product_kind);
}
function parseDelimitedOrFields(raw, orderedKeys) {
    if (raw.includes("|")) {
        const parts = raw.split("|").map((item) => item.trim());
        return Object.fromEntries(orderedKeys.map((key, index) => [key, parts[index] ?? ""]));
    }
    return parseFlexibleFields(raw);
}
function parseProductInput(raw, current) {
    const fields = parseDelimitedOrFields(raw, ["name", "size_mb", "price_toman"]);
    const currentPanelConfig = sanitizePanelConfig(current?.panel_config);
    const nameRaw = getFieldValue(fields, "name", "title");
    const sizeRaw = getFieldValue(fields, "size_mb", "size", "volume_mb", "mb");
    const priceRaw = getFieldValue(fields, "price_toman", "price", "price_tmn");
    const productKind = parseProductKind(getFieldValue(fields, "product_kind", "kind", "type") ?? currentPanelConfig.product_kind);
    const sellMode = parseSellMode(String(getFieldValue(fields, "sell_mode", "mode") ?? current?.sell_mode ?? "manual"));
    const isInfiniteRaw = getFieldValue(fields, "is_infinite", "infinite");
    const panelIdRaw = getFieldValue(fields, "panel_id", "panel");
    const panelLimitRaw = getFieldValue(fields, "panel_sell_limit", "sell_limit", "limit");
    const deliveryMode = parseDeliveryMode(String(getFieldValue(fields, "panel_delivery_mode", "delivery_mode", "delivery") ?? current?.panel_delivery_mode ?? "both"));
    const panelConfigValue = getFieldValue(fields, "panel_config", "config_json", "config", "panel_json") ?? current?.panel_config ?? {};
    const parsedPanelConfig = typeof panelConfigValue === "string" ? sanitizePanelConfig(parseJsonValue(panelConfigValue) || {}) : sanitizePanelConfig(panelConfigValue);
    const convenienceConfig = sanitizePanelConfig({
        inbound_id: parseMaybeNumber(getFieldValue(fields, "inbound_id", "inbound")),
        protocol: getFieldValue(fields, "protocol"),
        flow: getFieldValue(fields, "flow"),
        expire_days: parseMaybeNumber(getFieldValue(fields, "expire_days", "days")),
        data_limit_mb: parseMaybeNumber(getFieldValue(fields, "data_limit_mb", "traffic_mb")),
        subscription_path: getFieldValue(fields, "subscription_path", "sub_path"),
        server_host: getFieldValue(fields, "server_host", "host"),
        sni: getFieldValue(fields, "sni"),
        fingerprint: getFieldValue(fields, "fingerprint", "fp"),
        path: getFieldValue(fields, "path"),
        service_name: getFieldValue(fields, "service_name"),
        method: getFieldValue(fields, "method")
    });
    return {
        name: nameRaw ? String(nameRaw).trim() : String(current?.name || "").trim(),
        productKind,
        sizeMb: productKind === "account" ? 0 : (sizeRaw !== null ? Number(sizeRaw) : Number(current?.size_mb || 0)),
        priceRaw: priceRaw !== null ? String(priceRaw).trim() : "",
        sellMode,
        isInfinite: parseMaybeBoolean(isInfiniteRaw) ?? Boolean(current?.is_infinite),
        panelId: panelIdRaw === null || String(panelIdRaw).trim() === "" ? Number(current?.panel_id || 0) || null : Number(panelIdRaw),
        panelSellLimit: panelLimitRaw === null || String(panelLimitRaw).trim() === ""
            ? (current?.panel_sell_limit === null || current?.panel_sell_limit === undefined ? null : Number(current.panel_sell_limit))
            : Number(panelLimitRaw),
        panelDeliveryMode: deliveryMode,
        panelConfig: sanitizePanelConfig(mergeDeep(currentPanelConfig, mergeDeep(parsedPanelConfig, mergeDeep(convenienceConfig, { product_kind: productKind }))))
    };
}
function parseCardInput(raw) {
    const fields = parseDelimitedOrFields(raw, ["label", "card_number", "holder_name", "bank_name"]);
    return {
        label: String(getFieldValue(fields, "label", "title") || "").trim(),
        cardNumber: String(getFieldValue(fields, "card_number", "number") || "").trim(),
        holderName: String(getFieldValue(fields, "holder_name", "owner", "name") || "").trim(),
        bankName: String(getFieldValue(fields, "bank_name", "bank") || "").trim()
    };
}
function parseDiscountInput(raw, currentCode) {
    const fields = parseDelimitedOrFields(raw, currentCode ? ["type", "amount", "usage_limit"] : ["code", "type", "amount", "usage_limit"]);
    const codeSource = currentCode ? currentCode : String(getFieldValue(fields, "code") || "");
    const code = codeSource.toUpperCase() === "RANDOM" ? randomCode(10) : codeSource.toUpperCase();
    return {
        code,
        type: String(getFieldValue(fields, "type") || "").trim().toLowerCase(),
        amount: Number(getFieldValue(fields, "amount", "value")),
        usageLimit: getFieldValue(fields, "usage_limit", "limit") === null || String(getFieldValue(fields, "usage_limit", "limit")).trim() === ""
            ? null
            : Number(getFieldValue(fields, "usage_limit", "limit"))
    };
}
function parseAdminMessageInput(raw) {
    if (raw.includes("|")) {
        const parts = raw.split("|");
        return {
            targetRaw: String(parts[0] || "").trim(),
            messageText: parts.slice(1).join("|").trim()
        };
    }
    const fields = parseFlexibleFields(raw);
    return {
        targetRaw: String(getFieldValue(fields, "telegram_id", "target", "user", "username") || "").trim(),
        messageText: String(getFieldValue(fields, "text", "message", "body") || "").trim()
    };
}
function parseDirectMigrateInput(raw) {
    const fields = parseDelimitedOrFields(raw, ["source_inventory_id", "target_panel_id", "user_telegram_id", "config"]);
    return {
        sourceInventoryId: Number(getFieldValue(fields, "source_inventory_id", "inventory_id", "inventory")),
        targetPanelId: Number(getFieldValue(fields, "target_panel_id", "panel_id", "panel")),
        requestedFor: Number(getFieldValue(fields, "user_telegram_id", "telegram_id", "user_id", "user")),
        config: String(getFieldValue(fields, "config", "config_value") || "").trim()
    };
}
function panelTypeTitle(panelType) {
    if (panelType === "marzban")
        return "Marzban";
    if (panelType === "sanaei")
        return "Sanaei / 3x-ui";
    if (panelType === "pasarguard")
        return "PasarGuard";
    return panelType.toUpperCase();
}
function panelResultLabel(ok) {
    if (ok === null || ok === undefined)
        return "┘å╪»╪º╪▒╪»";
    return ok ? "┘à┘ê┘ü┘é" : "┘å╪º┘à┘ê┘ü┘é";
}
function maskSecret(value) {
    if (!value)
        return "-";
    return "ΓÇó".repeat(Math.min(Math.max(value.length, 4), 12));
}
function isValidHttpUrl(raw) {
    try {
        const url = new URL(raw);
        return url.protocol === "http:" || url.protocol === "https:";
    }
    catch {
        return false;
    }
}
function shortAddr(addr) {
    const v = (addr || "").trim();
    if (!v)
        return "-";
    return v.length <= 16 ? v : `${v.slice(0, 8)}...${v.slice(-6)}`;
}
function cryptoWalletTitle(w) {
    return `${w.currency} (${w.network})`;
}
function cryptoWalletReady(w) {
    const hasAddress = Boolean((w.address || "").trim());
    const hasRate = w.rate_mode === "auto" ? true : Number(w.rate_toman_per_unit || 0) > 0;
    return w.active && hasAddress && hasRate;
}
async function getActiveCryptoWallets() {
    const rows = await sql `
    SELECT id, currency, network, address, rate_mode, rate_toman_per_unit, extra_toman_per_unit, active
    FROM crypto_wallets
    WHERE active = TRUE
    ORDER BY currency ASC, network ASC, id ASC;
  `;
    return rows.map((w) => w);
}
async function createCryptoWalletTopup(chatId, userId, amount, w) {
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
    let tomanPerUnit = 0;
    if (w.rate_mode === "auto") {
        const base = await getCryptoTomanPerUnitCached(String(w.currency || ""));
        tomanPerUnit = base + Number(w.extra_toman_per_unit || 0);
    }
    else {
        tomanPerUnit = Number(w.rate_toman_per_unit || 0) + Number(w.extra_toman_per_unit || 0);
    }
    if (!Number.isFinite(tomanPerUnit) || tomanPerUnit <= 0) {
        await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
        return null;
    }
    const decimals = String(w.currency).toUpperCase() === "USDT" ? 2 : 6;
    const factor = 10 ** decimals;
    const cryptoAmount = Math.ceil((amount / tomanPerUnit) * factor) / factor;
    if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┌⌐╪▒█î┘╛╪¬┘ê ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
        return null;
    }
    const rows = await sql `
    INSERT INTO wallet_topups (telegram_id, amount, payment_method, crypto_network, crypto_address, crypto_amount, crypto_expires_at)
    VALUES (${userId}, ${amount}, 'crypto', ${w.network}, ${String(w.address || "")}, ${cryptoAmount}, ${expiresAt.toISOString()})
    RETURNING id;
  `;
    const topupId = Number(rows[0].id);
    await setState(userId, "await_wallet_receipt", { topupId });
    await tg("sendMessage", {
        chat_id: chatId,
        text: `╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
            `┘à╪¿┘ä╪║: ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å\n\n` +
            `ΓÅ░ ┘à┘ç┘ä╪¬ ┘╛╪▒╪»╪º╪«╪¬: 20 ╪»┘é█î┘é┘ç\n` +
            `≡ƒ¬Ö ╪º╪▒╪▓: ${String(w.currency)}\n` +
            `≡ƒîÉ ╪┤╪¿┌⌐┘ç: ${String(w.network)}\n` +
            `Γÿæ∩╕Å ┘à╪¿┘ä╪║ ┘╛╪▒╪»╪º╪«╪¬█î: ${cryptoAmount}\n\n` +
            `≡ƒô▒ ╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä:\n\n${String(w.address || "-")}\n\n` +
            `╪¿╪╣╪» ╪º╪▓ ┘╛╪▒╪»╪º╪«╪¬╪î ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬/╪▒╪│█î╪» ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ┘ç┘à█î┘å╪¼╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».`,
        reply_markup: { inline_keyboard: [[backButton("wallet_menu", "≡ƒöÖ ╪¿╪º╪▓┌»╪┤╪¬")]] }
    });
}
function cb(text, callback_data, style) {
    return style ? { text, callback_data, style } : { text, callback_data };
}
function homeButton() {
    return cb("≡ƒÅá ┘à┘å┘ê█î ╪º╪╡┘ä█î", "home", "primary");
}
function backButton(callback_data, text = "≡ƒöÖ ╪¿╪º╪▓┌»╪┤╪¬") {
    return cb(text, callback_data, "primary");
}
function cancelButton(callback_data = "home", text = "Γ¥î ┘ä╪║┘ê") {
    return cb(text, callback_data, "danger");
}
function confirmButton(callback_data, text = "Γ£à ╪¬╪º█î█î╪»") {
    return cb(text, callback_data, "success");
}
async function getPlisioTomanPerUsdt() {
    const auto = await getBoolSetting("plisio_auto_rate", true);
    const extra = (await getNumberSetting("plisio_usdt_extra_toman")) || 0;
    const manual = (await getNumberSetting("plisio_usdt_rate_fallback_toman")) ||
        (await getNumberSetting("plisio_usd_rate_toman")) ||
        0;
    if (!auto) {
        if (manual <= 0) {
            throw new Error("plisio_manual_rate_not_set");
        }
        return Math.max(1, manual + extra);
    }
    try {
        const { rateTomanPerUsdt, source } = await getUsdtRateTomanCached();
        logInfo("plisio_rate_auto_ok", { source, rateTomanPerUsdt });
        return Math.max(1, rateTomanPerUsdt + extra);
    }
    catch (error) {
        if (manual > 0) {
            logError("plisio_rate_auto_failed_using_fallback", error, { fallbackTomanPerUsdt: manual });
            return Math.max(1, manual + extra);
        }
        throw error;
    }
}
export async function fetchWithTimeout(url, init, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const agent = getAgentForUrl(url);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
            ...(agent ? { agent } : {})
        });
    }
    finally {
        clearTimeout(timer);
    }
}
export function parseJsonObject(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function responseSnippet(raw, limit = 220) {
    const value = raw.trim().slice(0, limit);
    return value || "empty_response";
}
function extractUuidFromText(raw) {
    if (!raw)
        return null;
    const match = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
}
function parsePanelUserTelegramId(candidate) {
    const direct = Number(candidate);
    if (Number.isFinite(direct) && direct > 0)
        return Math.round(direct);
    const match = String(candidate || "").match(/telegram[:=\s]+(\d{5,})/i);
    if (match?.[1]) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed) && parsed > 0)
            return Math.round(parsed);
    }
    return null;
}
function collectLookupCandidates(raw) {
    const candidates = new Set();
    const push = (value) => {
        const item = String(value || "").trim();
        if (!item)
            return null;
        candidates.add(item);
        const lower = item.toLowerCase();
        if (lower !== item)
            candidates.add(lower);
    };
    const source = raw.trim();
    push(source);
    try {
        push(decodeURIComponent(source));
    }
    catch {
    }
    const uuid = extractUuidFromText(source);
    if (uuid)
        push(uuid);
    const emailMatches = source.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+/gi) || [];
    for (const item of emailMatches)
        push(item);
    const tokenMatches = source.match(/[a-z0-9_\-]{8,}/gi) || [];
    for (const token of tokenMatches)
        push(token);
    if (source.toLowerCase().startsWith("vmess://")) {
        const encoded = source.slice("vmess://".length).split("#")[0].trim();
        if (encoded) {
            try {
                const decoded = Buffer.from(encoded, "base64").toString("utf8");
                const vmess = parseJsonObject(decoded);
                if (vmess) {
                    push(vmess.id);
                    push(vmess.ps);
                    push(vmess.add);
                    push(vmess.host);
                    push(vmess.path);
                    push(vmess.sni);
                }
                push(decoded);
            }
            catch {
            }
        }
    }
    const urlLike = source.match(/^[a-z][a-z0-9+\-.]*:\/\//i) ? source : source.startsWith("/") ? `https://x${source}` : "";
    if (urlLike) {
        try {
            const url = new URL(urlLike);
            push(url.hostname);
            const parts = url.pathname.split("/").map((part) => part.trim()).filter(Boolean);
            for (const part of parts)
                push(part);
            for (const value of url.searchParams.values())
                push(value);
        }
        catch {
        }
    }
    return Array.from(candidates).filter((item) => item.length >= 3);
}
function extractSessionCookie(setCookieHeader) {
    if (!setCookieHeader)
        return "";
    const sessionMatch = setCookieHeader.match(/(?:^|,\s*)(session=[^;]+)/i);
    if (sessionMatch?.[1])
        return sessionMatch[1];
    return setCookieHeader.split(";")[0]?.trim() || "";
}
async function updatePanelCheckState(panelId, ok, message, meta, accessToken) {
    if (accessToken === undefined) {
        await sql `
      UPDATE panels
      SET last_check_at = NOW(),
          last_check_ok = ${ok},
          last_check_message = ${message},
          cached_meta = ${JSON.stringify(meta)}::jsonb
      WHERE id = ${panelId};
    `;
        return null;
    }
    await sql `
    UPDATE panels
    SET access_token = ${accessToken},
        last_check_at = NOW(),
        last_check_ok = ${ok},
        last_check_message = ${message},
        cached_meta = ${JSON.stringify(meta)}::jsonb
    WHERE id = ${panelId};
  `;
}
export function jsonSuccess(data) {
    return data?.success === true;
}
function jsonArrayLength(data, key) {
    const value = data?.[key];
    return Array.isArray(value) ? value.length : null;
}
async function getPanelById(panelId) {
    const rows = await sql `
    SELECT
      id,
      name,
      panel_type,
      base_url,
      username,
      password,
      subscription_public_port,
      subscription_public_host,
      subscription_link_protocol,
      config_public_host,
      active,
      allow_customer_migration,
      allow_new_sales,
      last_check_at,
      last_check_ok,
      last_check_message,
      cached_meta,
      priority,
      created_at
    FROM panels
    WHERE id = ${panelId}
    LIMIT 1;
  `;
    return rows[0] || null;
}
function panelWizardPayload(mode, step, panelType, panelId, current) {
    const subPortRaw = current?.subscription_public_port;
    const subscriptionPublicPort = subPortRaw !== undefined && subPortRaw !== null && String(subPortRaw).trim() !== ""
        ? parseMaybeNumber(subPortRaw)
        : null;
    return {
        mode,
        step,
        panelId: panelId || null,
        panelType,
        name: String(current?.name || ""),
        baseUrl: String(current?.base_url || ""),
        username: String(current?.username || ""),
        password: String(current?.password || ""),
        subscriptionPublicPort: subscriptionPublicPort !== null && subscriptionPublicPort > 0 ? subscriptionPublicPort : null
    };
}
async function promptPanelTypePicker(chatId, mode, panelId) {
    const prefix = mode === "add" ? "admin_panel_pick_type_add_" : `admin_panel_pick_type_edit_${panelId}_`;
    await tg("sendMessage", {
        chat_id: chatId,
        text: mode === "add" ? "┘å┘ê╪╣ ┘╛┘å┘ä ╪¼╪»█î╪» ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:" : "┘å┘ê╪╣ ┘╛┘å┘ä ╪▒╪º ╪¿╪▒╪º█î ┘ê█î╪▒╪º█î╪┤ ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
        reply_markup: {
            inline_keyboard: [
                [
                    cb("Marzban", `${prefix}marzban`, "primary"),
                    cb("Sanaei / 3x-ui", `${prefix}sanaei`, "primary"),
                    cb("PasarGuard", `${prefix}pasarguard`, "primary")
                ],
                [backButton(panelId ? `admin_panel_open_${panelId}` : "admin_panels")]
            ]
        }
    });
}
async function promptPanelWizardStep(chatId, payload) {
    const mode = String(payload.mode || "add");
    const step = String(payload.step || "name");
    const panelId = Number(payload.panelId || 0);
    const panelType = String(payload.panelType || "");
    const totalSteps = panelType === "sanaei" ? 5 : 4; // marzban=4, pasarguard=4, sanaei=5
    const keepHint = mode === "edit" ? "\n╪¿╪▒╪º█î ┘å┌»┘ç ╪»╪º╪┤╪¬┘å ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î╪î ┘ü┘é╪╖ - ╪¿┘ü╪▒╪│╪¬█î╪»." : "";
    let text = "";
    if (step === "name") {
        text =
            `┘à╪▒╪¡┘ä┘ç 1 ╪º╪▓ ${totalSteps} - ┘å╪º┘à ┘╛┘å┘ä\n` +
                `┘å┘ê╪╣: ${panelTypeTitle(panelType)}` +
                (mode === "edit" ? `\n┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${String(payload.name || "-")}` : "") +
                `${keepHint}\n\n┘å╪º┘à ┘╛┘å┘ä ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».`;
    }
    if (step === "base_url") {
        text =
            `┘à╪▒╪¡┘ä┘ç 2 ╪º╪▓ ${totalSteps} - ╪ó╪»╪▒╪│ ┘╛┘å┘ä\n` +
                `┘å┘ê╪╣: ${panelTypeTitle(panelType)}` +
                (mode === "edit" ? `\n┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${String(payload.baseUrl || "-")}` : "") +
                `${keepHint}\n\n╪ó╪»╪▒╪│ ┌⌐╪º┘à┘ä ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n┘å┘à┘ê┘å┘ç:\nhttps://panel.example.com`;
    }
    if (step === "username") {
        text =
            `┘à╪▒╪¡┘ä┘ç 3 ╪º╪▓ ${totalSteps} - ┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î\n` +
                (mode === "edit" ? `┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${String(payload.username || "-")}` : "") +
                `${keepHint}\n\n┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┘╛┘å┘ä ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».`;
    }
    if (step === "password") {
        text =
            `┘à╪▒╪¡┘ä┘ç 4 ╪º╪▓ ${totalSteps} - ╪▒┘à╪▓ ╪╣╪¿┘ê╪▒\n` +
                (mode === "edit" ? `┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${maskSecret(String(payload.password || ""))}` : "") +
                `${keepHint}\n\n╪▒┘à╪▓ ╪╣╪¿┘ê╪▒ ┘╛┘å┘ä ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».`;
    }
    if (step === "sub_port") {
        const cur = payload.subscriptionPublicPort !== undefined && payload.subscriptionPublicPort !== null
            ? String(payload.subscriptionPublicPort)
            : "╪«┘ê╪»┌⌐╪º╪▒ (┘╛┘ê╪▒╪¬ ╪ó╪»╪▒╪│ ┘╛┘å┘ä)";
        text =
            `┘à╪▒╪¡┘ä┘ç 5 ╪º╪▓ 5 - ┘╛┘ê╪▒╪¬ ╪╣┘à┘ê┘à█î ┘ä█î┘å┌⌐ ╪│╪º╪¿╪│┌⌐╪▒█î┘╛╪┤┘å (┘ü┘é╪╖ Sanaei / 3x-ui)\n` +
                `╪º┌»╪▒ ╪│╪º╪¿ ╪▒┘ê█î ┘╛┘ê╪▒╪¬ ╪»█î┌»╪▒█î ╪│╪▒┘ê ┘à█îΓÇî╪┤┘ê╪» (┘à╪½┘ä╪º┘ï 8080)╪î ┘ç┘à╪º┘å ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n` +
                `0 █î╪º auto = ┘ç┘à╪º┘å ┘╛┘ê╪▒╪¬█î ┌⌐┘ç ╪»╪▒ ╪ó╪»╪▒╪│ ┘╛┘å┘ä ╪º╪│╪¬\n` +
                (mode === "edit" ? `┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${cur}\n╪¿╪▒╪º█î ┘å┌»┘ç ╪»╪º╪┤╪¬┘å ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î╪î - ╪¿┘ü╪▒╪│╪¬█î╪».\n` : "") +
                `\n┘╛┘ê╪▒╪¬ ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪» (█▒ΓÇô█╢█╡█╡█│█╡).`;
    }
    await tg("sendMessage", {
        chat_id: chatId,
        text,
        reply_markup: {
            inline_keyboard: [[cancelButton(panelId ? `admin_panel_wizard_cancel_${panelId}` : "admin_panel_wizard_cancel")]]
        }
    });
}
async function startPanelWizard(chatId, userId, mode, panelType, panelId) {
    let current;
    if (mode === "edit") {
        const panel = await getPanelById(Number(panelId));
        if (!panel) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        current = panel;
    }
    const payload = panelWizardPayload(mode, "name", panelType, panelId, current);
    await setState(userId, "admin_panel_wizard", payload);
    await promptPanelWizardStep(chatId, payload);
}
async function getProductForPanelWizard(productId) {
    const rows = await sql `
    SELECT id, name, size_mb, sell_mode, panel_id, panel_sell_limit, panel_delivery_mode, panel_config
    FROM products
    WHERE id = ${productId}
    LIMIT 1;
  `;
    return rows[0] || null;
}
function productPanelWizardPayload(product) {
    const panelConfig = sanitizePanelConfig(product.panel_config);
    const protocol = String(panelConfig.protocol || "").trim() || "vless";
    return {
        step: "panel",
        productId: Number(product.id),
        productName: String(product.name || ""),
        sizeMb: Number(product.size_mb || 0),
        panelId: Number(product.panel_id || 0) || null,
        panelSellLimit: product.panel_sell_limit === null || product.panel_sell_limit === undefined ? null : Number(product.panel_sell_limit),
        panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "both")),
        inboundId: parseMaybeNumber(panelConfig.inbound_id) ?? 1,
        protocol,
        expireDays: parseMaybeNumber(panelConfig.expire_days) ?? 30,
        dataLimitMb: parseMaybeNumber(panelConfig.data_limit_mb) ?? (Number(product.size_mb || 0) || 1024)
    };
}
async function promptProductPanelWizardStep(chatId, payload) {
    const step = String(payload.step || "panel");
    const productId = Number(payload.productId || 0);
    const productName = String(payload.productName || "-");
    if (step === "panel") {
        const panels = await sql `
      SELECT id, name, active, allow_new_sales
      FROM panels
      ORDER BY active DESC, allow_new_sales DESC, priority DESC, id ASC;
    `;
        if (!panels.length) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ç█î┌å ┘╛┘å┘ä█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬. ╪º┘ê┘ä ╪º╪▓ ╪¿╪«╪┤ ┘╛┘å┘äΓÇî┘ç╪º █î┌⌐ ┘╛┘å┘ä ╪º╪╢╪º┘ü┘ç ┌⌐┘å█î╪».",
                reply_markup: { inline_keyboard: [[backButton("admin_products")]] }
            });
            return null;
        }
        const keyboard = panels.map((panel) => [
            cb(`${panel.name}${panel.active && panel.allow_new_sales ? "" : " Γ¢ö"}`, `admin_product_panel_pick_${panel.id}`, "primary")
        ]);
        keyboard.push([cancelButton(`admin_product_panel_wizard_cancel_${productId}`)]);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à ┘ü╪▒┘ê╪┤ ┘╛┘å┘ä ╪¿╪▒╪º█î ┬½${productName}┬╗\n┘à╪▒╪¡┘ä┘ç 1 ╪º╪▓ 2: ┘╛┘å┘ä ┘à┘é╪╡╪» ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
            reply_markup: { inline_keyboard: keyboard }
        });
        return null;
    }
    if (step === "mode") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪▒╪¡┘ä┘ç 2 ╪º╪▓ 2: ┘å┘ê╪╣ ╪¬┘å╪╕█î┘à ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»\n` +
                `╪│╪▒█î╪╣: ╪¿┘é█î┘ç ┘à┘ê╪º╪▒╪» ╪«┘ê╪»┌⌐╪º╪▒ ╪¬┘å╪╕█î┘à ┘à█îΓÇî╪┤┘ê╪».\n` +
                `┘à╪▒╪¡┘ä┘çΓÇî╪º█î: ┘à┘é╪º╪»█î╪▒ ╪»┘ä╪«┘ê╪º┘ç ╪▒╪º ┘à█îΓÇî┘╛╪▒╪│╪».`,
            reply_markup: {
                inline_keyboard: [
                    [cb("ΓÜí ╪¬┘å╪╕█î┘à ╪│╪▒█î╪╣ (┘╛█î╪┤┘å┘ç╪º╪»█î)", "admin_product_panel_quick", "success")],
                    [cb("ΓÜÖ∩╕Å ╪¬┘å╪╕█î┘à ┘à╪▒╪¡┘ä┘çΓÇî╪º█î", "admin_product_panel_custom", "primary")],
                    [cancelButton(`admin_product_panel_wizard_cancel_${productId}`)]
                ]
            }
        });
        return null;
    }
    if (step === "sell_limit") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à ┘à╪▒╪¡┘ä┘çΓÇî╪º█î - 1 ╪º╪▓ 5\n` +
                `╪│┘é┘ü ┘ü╪▒┘ê╪┤ ┘╛┘å┘ä ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n` +
                `0 = ╪¿╪»┘ê┘å ╪│┘é┘ü\n` +
                `- = ┘å┌»┘ç ╪»╪º╪┤╪¬┘å ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î\n` +
                `┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${payload.panelSellLimit === null || payload.panelSellLimit === undefined ? "╪¿╪»┘ê┘å ╪│┘é┘ü" : payload.panelSellLimit}`,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_product_panel_wizard_cancel_${productId}`)]] }
        });
        return null;
    }
    if (step === "delivery") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪¬┘å╪╕█î┘à ┘à╪▒╪¡┘ä┘çΓÇî╪º█î - 2 ╪º╪▓ 5\n╪¡╪º┘ä╪¬ ╪¬╪¡┘ê█î┘ä ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("╪│╪º╪¿ + ┌⌐╪º┘å┘ü█î┌»", "admin_product_panel_delivery_both", "primary"),
                        cb("┘ü┘é╪╖ ╪│╪º╪¿", "admin_product_panel_delivery_sub", "primary"),
                        cb("┘ü┘é╪╖ ┌⌐╪º┘å┘ü█î┌»", "admin_product_panel_delivery_configs", "primary")
                    ],
                    [cancelButton(`admin_product_panel_wizard_cancel_${productId}`)]
                ]
            }
        });
        return null;
    }
    if (step === "inbound_id") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à ┘à╪▒╪¡┘ä┘çΓÇî╪º█î - 3 ╪º╪▓ 5\ninbound_id ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n- = ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î (${payload.inboundId || 1})`,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_product_panel_wizard_cancel_${productId}`)]] }
        });
        return null;
    }
    if (step === "protocol") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à ┘à╪▒╪¡┘ä┘çΓÇî╪º█î - 4 ╪º╪▓ 5\n┘╛╪▒┘ê╪¬┌⌐┘ä ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪» █î╪º ╪»╪│╪¬█î ╪¿┘ü╪▒╪│╪¬█î╪».\n┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${String(payload.protocol || "vless")}`,
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("vless", "admin_product_panel_protocol_vless", "primary"),
                        cb("vmess", "admin_product_panel_protocol_vmess", "primary"),
                        cb("trojan", "admin_product_panel_protocol_trojan", "primary")
                    ],
                    [cancelButton(`admin_product_panel_wizard_cancel_${productId}`)]
                ]
            }
        });
        return null;
    }
    if (step === "expire_days") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à ┘à╪▒╪¡┘ä┘çΓÇî╪º█î - 5 ╪º╪▓ 5\nexpire_days ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n- = ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î (${payload.expireDays || 30})`,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_product_panel_wizard_cancel_${productId}`)]] }
        });
        return null;
    }
    if (step === "data_limit_mb") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪ó╪«╪▒█î┘å ┘à╪▒╪¡┘ä┘ç\ndata_limit_mb ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n- = ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î (${payload.dataLimitMb || 1024})`,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_product_panel_wizard_cancel_${productId}`)]] }
        });
    }
}
async function saveProductPanelWizard(payload, quickMode) {
    const productId = Number(payload.productId || 0);
    const panelId = Number(payload.panelId || 0);
    if (!Number.isFinite(productId) || productId <= 0) {
        return { ok: false, message: "┘à╪¡╪╡┘ê┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." };
    }
    if (!Number.isFinite(panelId) || panelId <= 0) {
        return { ok: false, message: "┘ä╪╖┘ü╪º┘ï █î┌⌐ ┘╛┘å┘ä ┘à╪╣╪¬╪¿╪▒ ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»." };
    }
    const product = await getProductForPanelWizard(productId);
    if (!product) {
        return { ok: false, message: "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»." };
    }
    const panelRows = await sql `SELECT name FROM panels WHERE id = ${panelId} LIMIT 1;`;
    if (!panelRows.length) {
        return { ok: false, message: "┘╛┘å┘ä ╪º┘å╪¬╪«╪º╪¿ΓÇî╪┤╪»┘ç ┘╛█î╪»╪º ┘å╪┤╪»." };
    }
    const currentConfig = sanitizePanelConfig(product.panel_config);
    const inboundId = parseMaybeNumber(payload.inboundId) ?? parseMaybeNumber(currentConfig.inbound_id) ?? 1;
    const protocol = String(payload.protocol || currentConfig.protocol || "vless").trim() || "vless";
    const expireDays = parseMaybeNumber(payload.expireDays) ?? parseMaybeNumber(currentConfig.expire_days) ?? 30;
    const dataLimitMb = parseMaybeNumber(payload.dataLimitMb) ?? parseMaybeNumber(currentConfig.data_limit_mb) ?? (Number(product.size_mb || 0) || 1024);
    const panelSellLimit = quickMode || payload.panelSellLimit === null || payload.panelSellLimit === undefined
        ? null
        : Number(payload.panelSellLimit);
    const panelDeliveryMode = quickMode ? "both" : parseDeliveryMode(String(payload.panelDeliveryMode || "both"));
    const mergedConfig = sanitizePanelConfig(mergeDeep(currentConfig, {
        inbound_id: inboundId,
        protocol,
        expire_days: expireDays,
        data_limit_mb: dataLimitMb
    }));
    await sql `
    UPDATE products
    SET
      sell_mode = 'panel',
      is_infinite = TRUE,
      panel_id = ${panelId},
      panel_sell_limit = ${panelSellLimit},
      panel_delivery_mode = ${panelDeliveryMode},
      panel_config = ${JSON.stringify(mergedConfig)}::jsonb
    WHERE id = ${productId};
  `;
    return {
        ok: true,
        message: `╪¬┘å╪╕█î┘à ┘ü╪▒┘ê╪┤ ┘╛┘å┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n` +
            `┘à╪¡╪╡┘ê┘ä: ${product.name}\n` +
            `┘╛┘å┘ä: ${panelRows[0].name}\n` +
            `╪¡╪º┘ä╪¬ ╪¬╪¡┘ê█î┘ä: ${formatDeliveryModeLabel(panelDeliveryMode)}\n` +
            `╪│┘é┘ü ┘ü╪▒┘ê╪┤: ${panelSellLimit === null ? "╪¿╪»┘ê┘å ╪│┘é┘ü" : panelSellLimit}\n` +
            `protocol: ${protocol} | inbound_id: ${inboundId} | expire_days: ${expireDays} | data_limit_mb: ${dataLimitMb}`
    };
}
async function startProductWizard(chatId, userId, mode, productId) {
    let current = {};
    if (mode === "edit") {
        const id = Number(productId || 0);
        const rows = await sql `
      SELECT id, name, size_mb, price_toman, is_infinite, sell_mode, panel_id, panel_sell_limit, panel_delivery_mode, panel_config
      FROM products
      WHERE id = ${id}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        current = rows[0];
    }
    const panelConfig = sanitizePanelConfig(current.panel_config);
    const productKind = parseProductKind(panelConfig.product_kind);
    const currentSizeMb = Number(current.size_mb);
    const payload = {
        mode,
        step: "name",
        productId: mode === "edit" ? Number(current.id || productId || 0) : null,
        name: String(current.name || ""),
        productKind,
        sizeMb: Number.isFinite(currentSizeMb) ? currentSizeMb : 1024,
        priceMode: "auto",
        priceToman: Number(current.price_toman || 0) || null,
        sellMode: parseSellMode(String(current.sell_mode || "manual")),
        isInfinite: Boolean(current.is_infinite),
        panelId: Number(current.panel_id || 0) || null,
        panelSellLimit: current.panel_sell_limit === null || current.panel_sell_limit === undefined ? null : Number(current.panel_sell_limit),
        panelDeliveryMode: parseDeliveryMode(String(current.panel_delivery_mode || "both")),
        inboundId: parseMaybeNumber(panelConfig.inbound_id) ?? 1,
        protocol: String(panelConfig.protocol || "vless"),
        expireDays: parseMaybeNumber(panelConfig.expire_days) ?? 30,
        dataLimitMb: parseMaybeNumber(panelConfig.data_limit_mb) ?? (Number(current.size_mb || 0) || 1024)
    };
    await setState(userId, "admin_product_wizard", payload);
    await promptProductWizardStep(chatId, payload);
}
async function promptProductWizardStep(chatId, payload) {
    const mode = String(payload.mode || "add");
    const step = String(payload.step || "name");
    const productId = Number(payload.productId || 0);
    const productKind = parseProductKind(payload.productKind);
    const keepHint = mode === "edit" ? "\n╪¿╪▒╪º█î ┘å┌»┘ç ╪»╪º╪┤╪¬┘å ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î╪î - ╪¿┘ü╪▒╪│╪¬█î╪»." : "";
    if (step === "name") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 1 ╪º╪▓ 9\n` +
                `┘å╪º┘à ┘à╪¡╪╡┘ê┘ä ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».` +
                (mode === "edit" ? `\n┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${String(payload.name || "-")}` : "") +
                keepHint,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]] }
        });
        return null;
    }
    if (step === "product_kind") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 2 ╪º╪▓ 9\n` +
                `┘å┘ê╪╣ ┘à╪¡╪╡┘ê┘ä ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:` +
                (mode === "edit" ? `\n┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${productKind === "account" ? "╪º┌⌐╪º┘å╪¬" : "┌⌐╪º┘å┘ü█î┌» V2Ray"}` : ""),
            reply_markup: {
                inline_keyboard: [
                    [cb("??? ?????? V2Ray", "admin_product_wizard_kind_v2ray", "primary")],
                    [cb("??? ????? (VPN/??????)", "admin_product_wizard_kind_account", "primary")],
                    [cb("??? ???????? (Wireguard)", "admin_product_wizard_kind_wireguard", "primary")],
                    [cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]
                ]
            }
        });
        return null;
    }
    if (step === "size_mb") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 3 ╪º╪▓ 9\n` +
                `╪¡╪¼┘à ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪» (MB █î╪º GB). ┘å┘à┘ê┘å┘ç: 2048 █î╪º 2GB` +
                (mode === "edit" ? `\n┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${String(payload.sizeMb || "-")}` : "") +
                keepHint,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]] }
        });
        return null;
    }
    if (step === "price_mode") {
        if (productKind === "account") {
            await tg("sendMessage", {
                chat_id: chatId,
                text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 4 ╪º╪▓ 9\n╪¿╪▒╪º█î ┘à╪¡╪╡┘ê┘ä ╪º┌⌐╪º┘å╪¬█î╪î ┘é█î┘à╪¬ ╪¿╪º█î╪» ╪»╪│╪¬█î ╪½╪¿╪¬ ╪┤┘ê╪».`,
                reply_markup: {
                    inline_keyboard: [
                        [cb("Γ£ì∩╕Å ╪½╪¿╪¬ ┘é█î┘à╪¬ ╪»╪│╪¬█î", "admin_product_wizard_price_manual", "primary")],
                        [cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]
                    ]
                }
            });
            return null;
        }
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 4 ╪º╪▓ 9\n╪▒┘ê╪┤ ┘é█î┘à╪¬ΓÇî┌»╪░╪º╪▒█î ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
            reply_markup: {
                inline_keyboard: [
                    [cb("≡ƒñû ╪«┘ê╪»┌⌐╪º╪▒", "admin_product_wizard_price_auto", "primary")],
                    [cb("Γ£ì∩╕Å ╪»╪│╪¬█î", "admin_product_wizard_price_manual", "primary")],
                    [cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]
                ]
            }
        });
        return null;
    }
    if (step === "price_toman") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 5 ╪º╪▓ 9\n` +
                `┘é█î┘à╪¬ ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪¿┘ü╪▒╪│╪¬█î╪».` +
                (mode === "edit" ? `\n┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${String(payload.priceToman || "-")}` : "") +
                keepHint,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]] }
        });
        return null;
    }
    if (step === "sell_mode") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 6 ╪º╪▓ 9\n╪¡╪º┘ä╪¬ ┘ü╪▒┘ê╪┤ ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
            reply_markup: {
                inline_keyboard: [
                    [cb("┘ü╪▒┘ê╪┤ ╪»╪│╪¬█î", "admin_product_wizard_sell_manual", "primary")],
                    [cb("┘ü╪▒┘ê╪┤ ╪º╪▓ ┘╛┘å┘ä", "admin_product_wizard_sell_panel", "primary")],
                    [cb("┘ü╪▒┘ê╪┤ ╪º╪▓ ┘╛█î┘å┌»┌å█î (Wireguard)", "admin_product_wizard_sell_pingchi", "primary")],
                    [cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]
                ]
            }
        });
        return null;
    }
    if (step === "pingchi_plan_id") {
        const plansReq = await pingchiApi("plans.list");
        if (!plansReq.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪«╪╖╪º ╪»╪▒ ╪»╪▒█î╪º┘ü╪¬ ┘╛┘ä┘åΓÇî┘ç╪º█î ┘╛█î┘å┌»┌å█î: ${plansReq.message}` });
            return null;
        }
        const plans = plansReq.data?.rows || [];
        const kb = [];
        for (const plan of plans) {
            kb.push([cb(`${plan.name} - ${plan.payable} ╪¬┘ê┘à╪º┘å`, `admin_product_wizard_pingchi_plan_${plan.id}`, "primary")]);
        }
        kb.push([cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]);
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘╛┘ä┘å ┘╛█î┘å┌»┌å█î ┘à╪▒╪¿┘ê╪╖┘ç ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
            reply_markup: { inline_keyboard: kb }
        });
        return null;
    }
    if (step === "is_infinite") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 7 ╪º╪▓ 9\n┘à╪¡╪╡┘ê┘ä ╪¿█îΓÇî┘å┘ç╪º█î╪¬ ╪¿╪º╪┤╪»╪ƒ`,
            reply_markup: {
                inline_keyboard: [
                    [
                        confirmButton("admin_product_wizard_infinite_yes", "Γ£à ╪¿┘ä┘ç"),
                        cb("Γ¥î ╪«█î╪▒", "admin_product_wizard_infinite_no", "danger")
                    ],
                    [cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]
                ]
            }
        });
        return null;
    }
    if (step === "panel_id") {
        const panels = await sql `
      SELECT id, name, active, allow_new_sales
      FROM panels
      ORDER BY active DESC, allow_new_sales DESC, priority DESC, id ASC;
    `;
        if (!panels.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┘╛┘å┘ä█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬. ╪º┘ê┘ä █î┌⌐ ┘╛┘å┘ä ╪º╪╢╪º┘ü┘ç ┌⌐┘å█î╪»." });
            return null;
        }
        const keyboard = panels.map((panel) => [
            cb(`${panel.name}${panel.active && panel.allow_new_sales ? "" : " Γ¢ö"}`, `admin_product_wizard_panel_${panel.id}`, "primary")
        ]);
        keyboard.push([cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 7 ╪º╪▓ 9\n┘╛┘å┘ä ┘à┘é╪╡╪» ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
            reply_markup: { inline_keyboard: keyboard }
        });
        return null;
    }
    if (step === "panel_sell_limit") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 8 ╪º╪▓ 9\n` +
                `╪│┘é┘ü ┘ü╪▒┘ê╪┤ ┘╛┘å┘ä ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n0 = ╪¿╪»┘ê┘å ╪│┘é┘ü` +
                (mode === "edit" ? `\n┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î: ${payload.panelSellLimit ?? "╪¿╪»┘ê┘å ╪│┘é┘ü"}` : "") +
                keepHint,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]] }
        });
        return null;
    }
    if (step === "panel_delivery_mode") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 9 ╪º╪▓ 9\n` +
                `╪¡╪º┘ä╪¬ ╪¬╪¡┘ê█î┘ä ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪».\n` +
                `╪¿╪╣╪» ╪º╪▓ ╪º█î┘å ┘à╪▒╪¡┘ä┘ç╪î ╪¿╪º┘é█î ╪¬┘å╪╕█î┘à╪º╪¬ ┘╛┘å┘ä ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ┘à╪½┘ä ╪¡╪º┘ä╪¬ ╪│╪▒█î╪╣ ╪½╪¿╪¬ ┘à█îΓÇî╪┤┘ê╪».`,
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("╪│╪º╪¿ + ┌⌐╪º┘å┘ü█î┌»", "admin_product_wizard_delivery_both", "primary"),
                        cb("┘ü┘é╪╖ ╪│╪º╪¿", "admin_product_wizard_delivery_sub", "primary"),
                        cb("┘ü┘é╪╖ ┌⌐╪º┘å┘ü█î┌»", "admin_product_wizard_delivery_configs", "primary")
                    ],
                    [cancelButton(`admin_product_wizard_cancel_${productId || 0}`)]
                ]
            }
        });
        return null;
    }
    if (step === "inbound_id" || step === "protocol" || step === "expire_days" || step === "data_limit_mb") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪º█î┘å ┘à╪▒╪¡┘ä┘ç ╪»█î┌»╪▒ ┘ä╪º╪▓┘à ┘å█î╪│╪¬. ╪¬┘å╪╕█î┘à╪º╪¬ ┘╛┘å┘ä ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪º╪╣┘à╪º┘ä ┘à█îΓÇî╪┤┘ê╪»."
        });
    }
}
async function saveProductWizard(payload) {
    const mode = String(payload.mode || "add");
    const productKind = parseProductKind(payload.productKind);
    const sellMode = parseSellMode(String(payload.sellMode || "manual"));
    const sizeMb = Number(payload.sizeMb);
    if (productKind === "v2ray" && (!Number.isFinite(sizeMb) || sizeMb <= 0))
        return { ok: false, message: "╪¡╪¼┘à ┘à╪¡╪╡┘ê┘ä ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." };
    if (productKind === "account" && sellMode === "panel")
        return { ok: false, message: "┘à╪¡╪╡┘ê┘ä ╪º┌⌐╪º┘å╪¬█î ┘ü┘é╪╖ ╪¿╪º ┘ü╪▒┘ê╪┤ ╪»╪│╪¬█î ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ╪º╪│╪¬." };
    const name = String(payload.name || "").trim();
    if (!name)
        return { ok: false, message: "┘å╪º┘à ┘à╪¡╪╡┘ê┘ä ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." };
    const useAutoPrice = String(payload.priceMode || "auto") === "auto";
    const manualPrice = Number(payload.priceToman || 0);
    const price = useAutoPrice && productKind !== "account" ? await getProductPriceFromSizeMb(sizeMb) : manualPrice;
    if (!Number.isFinite(price) || price <= 0)
        return { ok: false, message: "┘é█î┘à╪¬ ┘à╪¡╪╡┘ê┘ä ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." };
    const panelId = sellMode === "panel" ? Number(payload.panelId || 0) : null;
    if (sellMode === "panel" && (!Number.isFinite(panelId) || Number(panelId) <= 0)) {
        return { ok: false, message: "╪¿╪▒╪º█î ┘ü╪▒┘ê╪┤ ┘╛┘å┘ä ╪¿╪º█î╪» █î┌⌐ ┘╛┘å┘ä ╪º┘å╪¬╪«╪º╪¿ ╪┤┘ê╪»." };
    }
    const panelSellLimitRaw = payload.panelSellLimit;
    const panelSellLimit = sellMode !== "panel" || panelSellLimitRaw === null || panelSellLimitRaw === undefined || Number(panelSellLimitRaw) <= 0
        ? null
        : Math.round(Number(panelSellLimitRaw));
    const panelDeliveryMode = sellMode === "panel" ? parseDeliveryMode(String(payload.panelDeliveryMode || "both")) : "both";
    let currentConfig = {};
    if (mode === "edit" && Number(payload.productId || 0) > 0) {
        const rows = await sql `SELECT panel_config FROM products WHERE id = ${Number(payload.productId)} LIMIT 1;`;
        currentConfig = rows.length ? sanitizePanelConfig(rows[0].panel_config) : {};
    }
    const panelConfig = sellMode === "panel"
        ? sanitizePanelConfig(mergeDeep(currentConfig, {
            product_kind: productKind,
            inbound_id: parseMaybeNumber(payload.inboundId) ?? 1,
            protocol: String(payload.protocol || "vless").trim() || "vless",
            expire_days: parseMaybeNumber(payload.expireDays) ?? 30,
            data_limit_mb: sizeMb
        }))
        : sanitizePanelConfig(mergeDeep(currentConfig, { product_kind: productKind }));
    if (mode === "add") {
        await sql `
      INSERT INTO products (name, size_mb, price_toman, is_infinite, sell_mode, panel_id, panel_sell_limit, panel_delivery_mode, panel_config)
      VALUES (
        ${name},
        ${productKind === "account" ? 0 : sizeMb},
        ${price},
        ${sellMode === "panel" ? true : Boolean(payload.isInfinite)},
        ${sellMode},
        ${panelId},
        ${panelSellLimit},
        ${panelDeliveryMode},
        ${JSON.stringify(panelConfig)}::jsonb
      )
      ON CONFLICT (name) DO UPDATE SET
        size_mb = EXCLUDED.size_mb,
        price_toman = EXCLUDED.price_toman,
        is_active = TRUE,
        is_infinite = EXCLUDED.is_infinite,
        sell_mode = EXCLUDED.sell_mode,
        panel_id = EXCLUDED.panel_id,
        panel_sell_limit = EXCLUDED.panel_sell_limit,
        panel_delivery_mode = EXCLUDED.panel_delivery_mode,
        panel_config = EXCLUDED.panel_config;
    `;
        return {
            ok: true,
            message: `┘à╪¡╪╡┘ê┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n` +
                `┘é█î┘à╪¬: ${formatPriceToman(price)} ╪¬┘ê┘à╪º┘å (${useAutoPrice ? "╪«┘ê╪»┌⌐╪º╪▒" : "╪»┘ä╪«┘ê╪º┘ç"})\n` +
                `╪¡╪º┘ä╪¬ ┘ü╪▒┘ê╪┤: ${sellMode === "panel" ? "╪º╪▓ ┘╛┘å┘ä" : "╪»╪│╪¬█î"}\n` +
                `╪¬╪¡┘ê█î┘ä: ${panelDeliveryMode}`
        };
    }
    const id = Number(payload.productId || 0);
    if (!Number.isFinite(id) || id <= 0)
        return { ok: false, message: "╪┤┘å╪º╪│┘ç ┘à╪¡╪╡┘ê┘ä ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." };
    await sql `
    UPDATE products
    SET
      name = ${name},
      size_mb = ${productKind === "account" ? 0 : sizeMb},
      price_toman = ${price},
      is_infinite = ${sellMode === "panel" ? true : Boolean(payload.isInfinite)},
      sell_mode = ${sellMode},
      panel_id = ${panelId},
      panel_sell_limit = ${panelSellLimit},
      panel_delivery_mode = ${panelDeliveryMode},
      panel_config = ${JSON.stringify(panelConfig)}::jsonb
    WHERE id = ${id};
  `;
    return {
        ok: true,
        message: `┘à╪¡╪╡┘ê┘ä ┘ê█î╪▒╪º█î╪┤ ╪┤╪» Γ£à\n` +
            `┘é█î┘à╪¬: ${formatPriceToman(price)} ╪¬┘ê┘à╪º┘å (${useAutoPrice ? "╪«┘ê╪»┌⌐╪º╪▒" : "╪»┘ä╪«┘ê╪º┘ç"})\n` +
            `╪¡╪º┘ä╪¬ ┘ü╪▒┘ê╪┤: ${sellMode === "panel" ? "╪º╪▓ ┘╛┘å┘ä" : "╪»╪│╪¬█î"}\n` +
            `╪¬╪¡┘ê█î┘ä: ${panelDeliveryMode}`
    };
}
async function startCardWizard(chatId, userId, mode, cardId) {
    let current = {};
    if (mode === "edit") {
        const rows = await sql `SELECT id, label, card_number, holder_name, bank_name FROM cards WHERE id = ${Number(cardId || 0)} LIMIT 1;`;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¬ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        current = rows[0];
    }
    const payload = {
        mode,
        step: "label",
        cardId: mode === "edit" ? Number(current.id || cardId || 0) : null,
        label: String(current.label || ""),
        cardNumber: String(current.card_number || ""),
        holderName: String(current.holder_name || ""),
        bankName: String(current.bank_name || "")
    };
    await setState(userId, "admin_card_wizard", payload);
    await promptCardWizardStep(chatId, payload);
}
async function promptCardWizardStep(chatId, payload) {
    const mode = String(payload.mode || "add");
    const step = String(payload.step || "label");
    const cardId = Number(payload.cardId || 0);
    const keepHint = mode === "edit" ? "\n╪¿╪▒╪º█î ┘å┌»┘ç ╪»╪º╪┤╪¬┘å ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î╪î - ╪¿┘ü╪▒╪│╪¬█î╪»." : "";
    const cancel = { inline_keyboard: [[cancelButton(`admin_card_wizard_cancel_${cardId || 0}`)]] };
    if (step === "label") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┌⌐╪º╪▒╪¬ ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 1 ╪º╪▓ 4\n╪╣┘å┘ê╪º┘å ┌⌐╪º╪▒╪¬ ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».` + (mode === "edit" ? `\n┘ü╪╣┘ä█î: ${payload.label || "-"}` : "") + keepHint,
            reply_markup: cancel
        });
        return null;
    }
    if (step === "card_number") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┌⌐╪º╪▒╪¬ ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 2 ╪º╪▓ 4\n╪┤┘à╪º╪▒┘ç ┌⌐╪º╪▒╪¬ ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».` + (mode === "edit" ? `\n┘ü╪╣┘ä█î: ${payload.cardNumber || "-"}` : "") + keepHint,
            reply_markup: cancel
        });
        return null;
    }
    if (step === "holder_name") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┌⌐╪º╪▒╪¬ ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 3 ╪º╪▓ 4\n┘å╪º┘à ╪╡╪º╪¡╪¿ ┌⌐╪º╪▒╪¬ ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n╪¿╪▒╪º█î ╪«╪º┘ä█î: -` + (mode === "edit" ? `\n┘ü╪╣┘ä█î: ${payload.holderName || "-"}` : ""),
            reply_markup: cancel
        });
        return null;
    }
    await tg("sendMessage", {
        chat_id: chatId,
        text: `┌⌐╪º╪▒╪¬ ${mode === "add" ? "╪¼╪»█î╪»" : "┘ê█î╪▒╪º█î╪┤"} - 4 ╪º╪▓ 4\n┘å╪º┘à ╪¿╪º┘å┌⌐ ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n╪¿╪▒╪º█î ╪«╪º┘ä█î: -` + (mode === "edit" ? `\n┘ü╪╣┘ä█î: ${payload.bankName || "-"}` : ""),
        reply_markup: cancel
    });
}
async function startDiscountWizard(chatId, userId, mode, discountId) {
    let current = {};
    if (mode === "edit") {
        const rows = await sql `SELECT id, code, type, amount, usage_limit FROM discounts WHERE id = ${Number(discountId || 0)} LIMIT 1;`;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¬╪«┘ü█î┘ü ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        current = rows[0];
    }
    const payload = {
        mode,
        step: (mode === "add" ? "code_mode" : "type"),
        discountId: mode === "edit" ? Number(current.id || discountId || 0) : null,
        code: mode === "edit" ? String(current.code || "") : "",
        type: String(current.type || "percent"),
        amount: Number(current.amount || 0) || null,
        usageLimit: current.usage_limit === null || current.usage_limit === undefined ? null : Number(current.usage_limit)
    };
    await setState(userId, "admin_discount_wizard", payload);
    await promptDiscountWizardStep(chatId, payload);
}
async function promptDiscountWizardStep(chatId, payload) {
    const mode = String(payload.mode || "add");
    const step = String(payload.step || "code_mode");
    const discountId = Number(payload.discountId || 0);
    const keepHint = mode === "edit" ? "\n╪¿╪▒╪º█î ┘å┌»┘ç ╪»╪º╪┤╪¬┘å ┘à┘é╪»╪º╪▒ ┘ü╪╣┘ä█î╪î - ╪¿┘ü╪▒╪│╪¬█î╪»." : "";
    if (step === "code_mode") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪¬╪«┘ü█î┘ü ╪¼╪»█î╪» - ┘à╪▒╪¡┘ä┘ç 1 ╪º╪▓ 4\n╪▒┘ê╪┤ ┌⌐╪» ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
            reply_markup: {
                inline_keyboard: [
                    [cb("≡ƒÄ▓ ┌⌐╪» ╪¬╪╡╪º╪»┘ü█î", "admin_discount_wizard_code_random", "primary")],
                    [cb("Γ£ì∩╕Å ┌⌐╪» ╪»╪│╪¬█î", "admin_discount_wizard_code_manual", "primary")],
                    [cancelButton(`admin_discount_wizard_cancel_${discountId || 0}`)]
                ]
            }
        });
        return null;
    }
    if (step === "code") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪¬╪«┘ü█î┘ü ╪¼╪»█î╪» - ┘à╪▒╪¡┘ä┘ç 1 ╪º╪▓ 4\n┌⌐╪» ╪¬╪«┘ü█î┘ü ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½┘ä╪º: NOW10",
            reply_markup: { inline_keyboard: [[cancelButton(`admin_discount_wizard_cancel_${discountId || 0}`)]] }
        });
        return null;
    }
    if (step === "type") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪▒╪¡┘ä┘ç ${mode === "add" ? "2" : "1"} ╪º╪▓ ${mode === "add" ? "4" : "3"}\n┘å┘ê╪╣ ╪¬╪«┘ü█î┘ü ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("percent", "admin_discount_wizard_type_percent", "primary"),
                        cb("fixed", "admin_discount_wizard_type_fixed", "primary")
                    ],
                    [cancelButton(`admin_discount_wizard_cancel_${discountId || 0}`)]
                ]
            }
        });
        return null;
    }
    if (step === "amount") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪▒╪¡┘ä┘ç ${mode === "add" ? "3" : "2"} ╪º╪▓ ${mode === "add" ? "4" : "3"}\n` +
                `┘à┘é╪»╪º╪▒ ╪¬╪«┘ü█î┘ü ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».` +
                (mode === "edit" ? `\n┘ü╪╣┘ä█î: ${payload.amount || "-"}` : "") +
                keepHint,
            reply_markup: { inline_keyboard: [[cancelButton(`admin_discount_wizard_cancel_${discountId || 0}`)]] }
        });
        return null;
    }
    await tg("sendMessage", {
        chat_id: chatId,
        text: `┘à╪▒╪¡┘ä┘ç ${mode === "add" ? "4" : "3"} ╪º╪▓ ${mode === "add" ? "4" : "3"}\n` +
            `╪│┘é┘ü ╪º╪│╪¬┘ü╪º╪»┘ç ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪». 0 = ╪¿╪»┘ê┘å ╪│┘é┘ü` +
            (mode === "edit" ? `\n┘ü╪╣┘ä█î: ${payload.usageLimit ?? "╪¿╪»┘ê┘å ╪│┘é┘ü"}` : "") +
            keepHint,
        reply_markup: { inline_keyboard: [[cancelButton(`admin_discount_wizard_cancel_${discountId || 0}`)]] }
    });
}
async function startMessageUserWizard(chatId, userId) {
    const payload = { step: "target", targetRaw: "", messageText: "" };
    await setState(userId, "admin_message_user_wizard", payload);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "╪º╪▒╪│╪º┘ä ┘╛█î╪º┘à - ┘à╪▒╪¡┘ä┘ç 1 ╪º╪▓ 2\n╪ó█î╪»█î ╪╣╪»╪»█î █î╪º █î┘ê╪▓╪▒┘å█î┘à (╪¿╪º █î╪º ╪¿╪»┘ê┘å @) ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».",
        reply_markup: { inline_keyboard: [[cancelButton("admin_message_user_wizard_cancel")]] }
    });
}
async function startDirectMigrateWizard(chatId, userId) {
    const payload = {
        step: "source_inventory_id",
        sourceInventoryId: null,
        targetPanelId: null,
        requestedFor: null,
        config: ""
    };
    await setState(userId, "admin_direct_migrate_wizard", payload);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "╪º┘å╪¬┘é╪º┘ä ┘à╪│╪¬┘é█î┘à - ┘à╪▒╪¡┘ä┘ç 1 ╪º╪▓ 4\n╪┤┘å╪º╪│┘ç inventory ┘à╪¿╪»╪º ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».",
        reply_markup: { inline_keyboard: [[cancelButton("admin_direct_migrate_wizard_cancel")]] }
    });
}
async function startAdminConfigBuilderWizard(chatId, userId) {
    const payload = {
        step: "target_user",
        targetUserId: null,
        targetUsername: "",
        panelId: null,
        name: "",
        dataMb: null,
        isInfinite: false,
        expiryDays: 30
    };
    await setState(userId, "admin_config_builder_wizard", payload);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î - ┘à╪▒╪¡┘ä┘ç 1 ╪º╪▓ 5\n╪ó█î╪»█î ╪╣╪»╪»█î ┌⌐╪º╪▒╪¿╪▒ █î╪º █î┘ê╪▓╪▒┘å█î┘à (╪¿╪º █î╪º ╪¿╪»┘ê┘å @) ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».",
        reply_markup: { inline_keyboard: [[cancelButton("admin_config_builder_cancel")]] }
    });
}
async function promptAdminConfigBuilderPanel(chatId) {
    const rows = await sql `SELECT id, name, panel_type, active, allow_new_sales FROM panels ORDER BY active DESC, allow_new_sales DESC, priority DESC, id ASC;`;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┘╛┘å┘ä█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬." });
        return null;
    }
    const keyboard = rows.map((row) => [
        cb(`${row.name} (${panelTypeTitle(String(row.panel_type || ""))})${row.active && row.allow_new_sales ? "" : " Γ¢ö"}`, `admin_config_builder_panel_${row.id}`, "primary")
    ]);
    keyboard.push([cancelButton("admin_config_builder_cancel")]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î - ┘à╪▒╪¡┘ä┘ç 2 ╪º╪▓ 5\n┘╛┘å┘ä ┘à┘é╪╡╪» ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function promptDirectMigrateTargetPanel(chatId) {
    const rows = await sql `SELECT id, name, active, allow_new_sales FROM panels ORDER BY active DESC, allow_new_sales DESC, priority DESC, id ASC;`;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┘╛┘å┘ä█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬." });
        return null;
    }
    const keyboard = rows.map((row) => [cb(`${row.name}${row.active && row.allow_new_sales ? "" : " Γ¢ö"}`, `admin_direct_migrate_panel_${row.id}`, "primary")]);
    keyboard.push([cancelButton("admin_direct_migrate_wizard_cancel")]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "╪º┘å╪¬┘é╪º┘ä ┘à╪│╪¬┘é█î┘à - ┘à╪▒╪¡┘ä┘ç 2 ╪º╪▓ 4\n┘╛┘å┘ä ┘à┘é╪╡╪» ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function showPanelDetails(chatId, panelId, notice) {
    const panel = await getPanelById(panelId);
    if (!panel) {
        await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
        return null;
    }
    await tg("sendMessage", {
        chat_id: chatId,
        text: `${notice ? `${notice}\n\n` : ""}` +
            `┘╛┘å┘ä #${panel.id}\n` +
            `┘å╪º┘à: ${panel.name}\n` +
            `┘å┘ê╪╣: ${panelTypeTitle(String(panel.panel_type))}\n` +
            `╪ó╪»╪▒╪│: ${panel.base_url}\n` +
            (String(panel.panel_type) === "sanaei"
                ? `┘╛┘ê╪▒╪¬ ┘ä█î┘å┌⌐ ╪│╪º╪¿ (╪╣┘à┘ê┘à█î): ${panel.subscription_public_port != null && Number(panel.subscription_public_port) > 0
                    ? Number(panel.subscription_public_port)
                    : "┘ç┘à╪º┘å ┘╛┘ê╪▒╪¬ ╪ó╪»╪▒╪│ ┘╛┘å┘ä"}\n` +
                    `╪»╪º┘à┘å┘ç ┘ä█î┘å┌⌐ ╪│╪º╪¿: ${String(panel.subscription_public_host || "").trim() || "┘ç┘à╪º┘å ┘å╪º┘à ┘à█î╪▓╪¿╪º┘å ╪ó╪»╪▒╪│ ┘╛┘å┘ä"}\n` +
                    `┘╛╪▒┘ê╪¬┌⌐┘ä ┘ä█î┘å┌⌐ ╪│╪º╪¿: ${(() => {
                        const p = String(panel.subscription_link_protocol || "").trim().toLowerCase();
                        return p === "http" || p === "https" ? p : "┘ç┘à╪º┘å ┘╛╪▒┘ê╪¬┌⌐┘ä ╪ó╪»╪▒╪│ ┘╛┘å┘ä";
                    })()}\n` +
                    `╪»╪º┘à┘å┘ç ┘å┘à╪º█î╪┤ ╪»╪▒ ┌⌐╪º┘å┘ü█î┌»: ${String(panel.config_public_host || "").trim() || "┘ç┘à╪º┘å ╪¬╪┤╪«█î╪╡ ╪«┘ê╪»┌⌐╪º╪▒ (┘à╪¡╪╡┘ê┘ä/┘╛┘å┘ä)"}\n`
                : "") +
            `█î┘ê╪▓╪▒┘å█î┘à: ${panel.username || "-"}\n` +
            `┘ê╪╢╪╣█î╪¬: ${panel.active ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"}\n` +
            `┘ü╪▒┘ê╪┤ ╪¼╪»█î╪»: ${panel.allow_new_sales ? "╪▒┘ê╪┤┘å" : "╪«╪º┘à┘ê╪┤"}\n` +
            `┘à┘ç╪º╪¼╪▒╪¬ ┌⌐╪º╪▒╪¿╪▒: ${panel.allow_customer_migration ? "╪▒┘ê╪┤┘å" : "╪«╪º┘à┘ê╪┤"}\n` +
            `╪º┘ê┘ä┘ê█î╪¬: ${panel.priority}\n` +
            `╪ó╪«╪▒█î┘å ╪¬╪│╪¬: ${panel.last_check_at || "-"}\n` +
            `┘å╪¬█î╪¼┘ç: ${panelResultLabel(panel.last_check_ok)}\n` +
            `┘╛█î╪º┘à: ${panel.last_check_message || "-"}\n` +
            `meta: ${JSON.stringify(panel.cached_meta || {}, null, 2)}`,
        reply_markup: {
            inline_keyboard: [
                [
                    cb("Γ£Å∩╕Å ┘ê█î╪▒╪º█î╪┤", `admin_panel_edit_${panel.id}`, "primary"),
                    cb("≡ƒº¬ ╪¬╪│╪¬", `admin_panel_test_${panel.id}`, "primary")
                ],
                ...(String(panel.panel_type) === "sanaei"
                    ? [
                        [
                            cb("≡ƒöó ┘╛┘ê╪▒╪¬ ╪│╪º╪¿", `admin_panel_set_subport_${panel.id}`, "primary"),
                            cb("≡ƒöù ╪»╪º┘à┘å┘ç/┘╛╪▒┘ê╪¬┌⌐┘ä ╪│╪º╪¿", `admin_panel_set_suburl_${panel.id}`, "primary")
                        ],
                        [cb("≡ƒîÉ ╪»╪º┘à┘å┘ç ┌⌐╪º┘å┘ü█î┌»", `admin_panel_set_confighost_${panel.id}`, "primary")],
                        [cb("≡ƒôÑ ┘ê╪º╪▒╪» ┌⌐╪▒╪»┘å ╪¿┌⌐╪º┘╛ inbound", `admin_panel_import_sanaei_backup_${panel.id}`, "primary")]
                    ]
                    : []),
                [
                    cb(panel.active ? "Γ¢ö ╪║█î╪▒┘ü╪╣╪º┘ä" : "Γ£à ┘ü╪╣╪º┘ä", `admin_panel_toggle_${panel.id}`, panel.active ? "danger" : "success"),
                    cb(panel.allow_new_sales ? "≡ƒ¢æ ╪¿╪│╪¬┘å ┘ü╪▒┘ê╪┤" : "≡ƒƒó ╪¿╪º╪▓┌⌐╪▒╪»┘å ┘ü╪▒┘ê╪┤", `admin_panel_toggle_sales_${panel.id}`, panel.allow_new_sales ? "danger" : "success")
                ],
                [
                    cb(panel.allow_customer_migration ? "≡ƒöÆ ┘é┘ü┘ä ┘à┘ç╪º╪¼╪▒╪¬" : "≡ƒöô ╪ó╪▓╪º╪» ┘à┘ç╪º╪¼╪▒╪¬", `admin_panel_toggle_move_${panel.id}`, "primary"),
                    cb("≡ƒùæ ╪¡╪░┘ü", `admin_panel_remove_${panel.id}`, "danger")
                ],
                [
                    cb("≡ƒôï ┌⌐╪┤", `admin_panel_cache_${panel.id}`, "primary"),
                    backButton("admin_panels", "≡ƒöÖ ┘ä█î╪│╪¬ ┘╛┘å┘äΓÇî┘ç╪º")
                ]
            ]
        }
    });
}
async function mainMenuMarkup(userId) {
    const [testEnabled, adminCheck, kindsRow] = await Promise.all([
        getBoolSetting("test_config_enabled", false),
        isAdmin(userId),
        sql `
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(panel_config->>'product_kind', 'v2ray') = 'v2ray') AS v2ray_count,
        COUNT(*) FILTER (WHERE COALESCE(panel_config->>'product_kind', 'v2ray') = 'account') AS account_count,
        COUNT(*) FILTER (WHERE COALESCE(panel_config->>'product_kind', 'v2ray') = 'wireguard') AS wireguard_count
      FROM products
      WHERE is_active = TRUE
    `
    ]);
    const v2rayCount = Number(kindsRow[0].v2ray_count);
    const accountCount = Number(kindsRow[0].account_count);
    const wireguardCount = Number(kindsRow[0].wireguard_count);
    let buyBtnText = "?? ???? ?????";
    if ((v2rayCount > 0 ? 1 : 0) + (accountCount > 0 ? 1 : 0) + (wireguardCount > 0 ? 1 : 0) > 1) {
        buyBtnText = "?? ????";
    }
    else if (accountCount > 0 && v2rayCount === 0 && wireguardCount === 0) {
        buyBtnText = "?? ???? ?????";
    }
    else if (wireguardCount > 0 && accountCount === 0 && v2rayCount === 0) {
        buyBtnText = "?? ???? ????????";
    }
    const rows = [
        [cb(buyBtnText, "buy_menu", "primary"), cb("≡ƒôª ╪│┘ü╪º╪▒╪┤ΓÇî┘ç╪º ┘ê ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º", "my_configs", "primary")],
        [cb("≡ƒæ¢ ┌⌐█î┘ü ┘╛┘ê┘ä", "wallet_menu", "success"), cb("≡ƒÄü ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å", "referral_menu", "success")],
        [cb("≡ƒåÿ ┘╛╪┤╪¬█î╪¿╪º┘å█î", "support", "primary")]
    ];
    if (testEnabled) {
        rows.splice(2, 0, [cb("≡ƒåô ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪▒╪º█î┌»╪º┘å", "test_config_claim", "success")]);
    }
    if (adminCheck) {
        rows.push([cb("≡ƒ¢á ┘╛┘å┘ä ╪º╪»┘à█î┘å", "admin_panel", "primary")]);
    }
    return { inline_keyboard: rows };
}
async function upsertUser(user) {
    const rows = await sql `
    INSERT INTO users (telegram_id, username, first_name, last_name)
    VALUES (${user.id}, ${user.username || null}, ${user.first_name || null}, ${user.last_name || null})
    ON CONFLICT (telegram_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      last_seen_at = NOW()
    RETURNING (xmax = 0) AS inserted;
  `;
    return { created: Boolean(rows[0]?.inserted) };
}
async function sendMainMenu(chatId, userId, text) {
    await tg("sendMessage", {
        chat_id: chatId,
        text: text ||
            "≡ƒÅá ┘à┘å┘ê█î ╪º╪╡┘ä█î\n\n" +
                "╪º╪▓ ┌»╪▓█î┘å┘çΓÇî┘ç╪º█î ╪▓█î╪▒ ┘à█îΓÇî╪¬┘ê╪º┘å█î╪» ╪«╪▒█î╪»╪î ┘╛█î┌»█î╪▒█î ╪│┘ü╪º╪▒╪┤╪î ┘à╪»█î╪▒█î╪¬ ┌⌐█î┘ü ┘╛┘ê┘ä ┘ê ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å ╪▒╪º ╪º┘å╪¼╪º┘à ╪»┘ç█î╪».",
        reply_markup: await mainMenuMarkup(userId)
    });
}
async function sendWalletMenu(chatId, userId) {
    const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
    const balance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
    await tg("sendMessage", {
        chat_id: chatId,
        text: `≡ƒæ¢ ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º\n\n` +
            `┘à┘ê╪¼┘ê╪»█î ┘ü╪╣┘ä█î: ${formatPriceToman(balance)} ╪¬┘ê┘à╪º┘å\n\n` +
            `╪º╪▓ ╪º█î┘å ╪¿╪«╪┤ ┘à█îΓÇî╪¬┘ê╪º┘å█î╪» ┌⌐█î┘ü ┘╛┘ê┘ä ╪▒╪º ╪┤╪º╪▒┌ÿ ┌⌐┘å█î╪» █î╪º ┌»╪▒╪»╪┤ ╪º╪«█î╪▒ ╪▒╪º ╪¿╪¿█î┘å█î╪».`,
        reply_markup: {
            inline_keyboard: [
                [cb("Γ₧ò ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä", "wallet_charge", "success"), cb("≡ƒº╛ ┌»╪▒╪»╪┤ ┌⌐█î┘ü ┘╛┘ê┘ä", "wallet_transactions", "primary")],
                [cb("≡ƒÄü ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å", "referral_menu", "primary")],
                [homeButton()]
            ]
        }
    });
}
async function showWalletTransactions(chatId, userId) {
    const rows = await sql `
    SELECT amount, type, description, created_at
    FROM wallet_transactions
    WHERE telegram_id = ${userId}
    ORDER BY id DESC
    LIMIT 12;
  `;
    if (!rows.length) {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "≡ƒº╛ ┘ç┘å┘ê╪▓ ╪¬╪▒╪º┌⌐┘å╪┤█î ╪¿╪▒╪º█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬.",
            reply_markup: { inline_keyboard: [[backButton("wallet_menu")], [homeButton()]] }
        });
        return null;
    }
    const lines = rows.map((row, idx) => {
        const amount = Number(row.amount || 0);
        const amountText = `${amount >= 0 ? "+" : ""}${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å`;
        const title = formatWalletTransactionType(row.type);
        const description = String(row.description || "").trim();
        return `${idx + 1}. ${title}\n${amountText}\n${description || "-"}\n${String(row.created_at)}`;
    });
    await tg("sendMessage", {
        chat_id: chatId,
        text: `≡ƒº╛ ┌»╪▒╪»╪┤ ╪º╪«█î╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä\n\n${lines.join("\n\n")}`,
        reply_markup: { inline_keyboard: [[backButton("wallet_menu")], [homeButton()]] }
    });
}
async function showReferralInvitees(chatId, userId) {
    const rows = await sql `
    SELECT username, first_name, last_name, referral_joined_at, referral_qualified_at
    FROM users
    WHERE referred_by_telegram_id = ${userId}
    ORDER BY COALESCE(referral_qualified_at, referral_joined_at, created_at) DESC
    LIMIT 20;
  `;
    if (!rows.length) {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "≡ƒæÑ ┘ç┘å┘ê╪▓ ┌⌐╪│█î ╪¿╪º ┘ä█î┘å┌⌐ ╪┤┘à╪º ┘ê╪º╪▒╪» ╪▒╪¿╪º╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬.",
            reply_markup: { inline_keyboard: [[backButton("referral_menu")], [homeButton()]] }
        });
        return null;
    }
    const lines = rows.map((row, idx) => {
        const username = row.username ? `@${String(row.username)}` : "-";
        const fullName = [row.first_name ? String(row.first_name) : "", row.last_name ? String(row.last_name) : ""].filter(Boolean).join(" ").trim() || "-";
        const status = row.referral_qualified_at ? "Γ£à ╪¬╪º█î█î╪»╪┤╪»┘ç" : "ΓÅ│ ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪¬╪º█î█î╪»";
        return `${idx + 1}. ${username} | ${fullName}\n┘ê╪╢╪╣█î╪¬: ${status}`;
    });
    await tg("sendMessage", {
        chat_id: chatId,
        text: `≡ƒæÑ ┘ü┘ç╪▒╪│╪¬ ╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪┤┘à╪º\n\n${lines.join("\n\n")}`,
        reply_markup: { inline_keyboard: [[backButton("referral_menu")], [homeButton()]] }
    });
}
async function showReferralRewardHistory(chatId, userId) {
    const rows = await sql `
    SELECT
      rr.reward_batch,
      rr.reward_type,
      rr.reward_delivery_mode,
      rr.status,
      rr.failure_reason,
      rr.wallet_amount,
      rr.created_at,
      rr.order_id,
      p.name AS product_name
    FROM referral_rewards rr
    LEFT JOIN products p ON p.id = rr.product_id
    WHERE rr.inviter_telegram_id = ${userId}
    ORDER BY rr.id DESC
    LIMIT 15;
  `;
    if (!rows.length) {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "≡ƒÄü ┘ç┘å┘ê╪▓ ╪¼╪º█î╪▓┘çΓÇî╪º█î ╪º╪▓ ╪¿╪«╪┤ ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å ╪¿╪▒╪º█î ╪┤┘à╪º ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬.",
            reply_markup: { inline_keyboard: [[backButton("referral_menu")], [homeButton()]] }
        });
        return null;
    }
    const lines = rows.map((row, idx) => {
        const rewardType = normalizeReferralRewardType(row.reward_type);
        const status = String(row.status || "granted").toLowerCase();
        const deliveryMode = normalizeReferralConfigDeliveryMode(row.reward_delivery_mode);
        const rewardText = rewardType === "config"
            ? row.product_name
                ? `┌⌐╪º┘å┘ü█î┌» ${String(row.product_name)}${row.order_id ? ` (#${row.order_id})` : ""}`
                : row.order_id
                    ? `┌⌐╪º┘å┘ü█î┌» ╪▒╪º█î┌»╪º┘å (#${row.order_id})`
                    : "┌⌐╪º┘å┘ü█î┌» ╪▒╪º█î┌»╪º┘å"
            : `${formatPriceToman(Number(row.wallet_amount || 0))} ╪¬┘ê┘à╪º┘å ╪º╪╣╪¬╪¿╪º╪▒`;
        const extra = rewardType === "config"
            ? `\n╪▒┘ê╪┤ ╪¬╪¡┘ê█î┘ä: ${referralConfigDeliveryModeLabel(deliveryMode)}`
            : "";
        const failureReason = row.failure_reason ? `\n╪╣┘ä╪¬ ╪¬┘ê┘é┘ü: ${String(row.failure_reason)}` : "";
        return `${idx + 1}. ┘à╪▒╪¡┘ä┘ç ${Number(row.reward_batch || 0)}\n┘╛╪º╪»╪º╪┤: ${rewardText}${extra}\n┘ê╪╢╪╣█î╪¬: ${referralRewardStatusLabel(status)}${failureReason}\n╪▓┘à╪º┘å: ${String(row.created_at)}`;
    });
    await tg("sendMessage", {
        chat_id: chatId,
        text: `≡ƒÄü ╪¬╪º╪▒█î╪«┌å┘ç ╪¼┘ê╪º█î╪▓ ╪»╪╣┘ê╪¬\n\n${lines.join("\n\n")}`,
        reply_markup: { inline_keyboard: [[backButton("referral_menu")], [homeButton()]] }
    });
}
async function sendReferralMenu(chatId, userId) {
    await maybeGrantReferralRewardsV2(userId);
    const settings = await getReferralSettingsSnapshot();
    const productName = settings.rewardType === "config" && settings.productId
        ? String((await sql `SELECT name FROM products WHERE id = ${settings.productId} LIMIT 1;`)[0]?.name || "")
        : "";
    if (!settings.enabled) {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "≡ƒÄü ╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å\n\n" +
                "╪»╪▒ ╪¡╪º┘ä ╪¡╪º╪╢╪▒ ╪º█î┘å ╪¿╪«╪┤ ╪║█î╪▒┘ü╪╣╪º┘ä ╪º╪│╪¬.\n" +
                "╪¿╪╣╪» ╪º╪▓ ┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å╪î ┘ä█î┘å┌⌐ ╪º╪«╪¬╪╡╪º╪╡█î ┘ê ╪¼╪▓╪ª█î╪º╪¬ ┘╛╪º╪»╪º╪┤ ╪┤┘à╪º ╪º█î┘å╪¼╪º ┘å┘à╪º█î╪┤ ╪»╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪».",
            reply_markup: { inline_keyboard: [[homeButton()]] }
        });
        return null;
    }
    const inviteLink = await buildReferralInviteLink(userId);
    const totalInvites = await countUserReferralLeads(userId);
    const qualifiedInvites = await countUserQualifiedReferrals(userId);
    const rewardCount = await countUserReferralRewards(userId);
    const rewardStatusSummary = await getUserReferralRewardStatusSummary(userId);
    const pendingInvites = Math.max(0, totalInvites - qualifiedInvites);
    const remaining = getReferralRemainingCount(qualifiedInvites, settings.threshold);
    const rewardSummary = describeReferralReward(settings, productName || null);
    const lines = [
        "≡ƒÄü ╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬ ╪»┘ê╪│╪¬╪º┘å",
        "",
        `┘╛╪º╪»╪º╪┤ ┘ç╪▒ ${settings.threshold} ╪»╪╣┘ê╪¬ ╪¬╪º█î█î╪»╪┤╪»┘ç: ${rewardSummary}`,
        `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪½╪¿╪¬ΓÇî╪┤╪»┘ç: ${totalInvites}`,
        `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪¬╪º█î█î╪»╪┤╪»┘ç: ${qualifiedInvites}`,
        `╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪¬╪º█î█î╪»: ${pendingInvites}`,
        `╪¼┘ê╪º█î╪▓ ╪»╪▒█î╪º┘ü╪¬ΓÇî╪┤╪»┘ç: ${rewardCount}`,
        `╪¬╪º ┘╛╪º╪»╪º╪┤ ╪¿╪╣╪»█î: ${remaining === 0 ? "╪ó╪│╪¬╪º┘å┘ç ╪¬┌⌐┘à█î┘ä ╪┤╪»┘ç" : `${remaining} ┘å┘ü╪▒`}`,
        ""
    ];
    lines.splice(3, 0, `╪º█î┘å ┘╛╪º╪»╪º╪┤ ╪¿╪▒╪º█î ┘ç╪▒ ┘à╪╢╪▒╪¿ ┌⌐╪º┘à┘ä ╪º╪▓ ${settings.threshold} ╪»╪╣┘ê╪¬╪î ╪»┘ê╪¿╪º╪▒┘ç ╪¬┌⌐╪▒╪º╪▒ ┘à█îΓÇî╪┤┘ê╪».`);
    lines.splice(4, 0, "┘å╪¡┘ê┘ç ╪»╪▒█î╪º┘ü╪¬ ╪¼╪º█î╪▓┘ç: ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪º┘å╪¼╪º┘à ┘à█îΓÇî╪┤┘ê╪» ┘ê ┘å█î╪º╪▓█î ╪¿┘ç Claim ╪»╪│╪¬█î ┘å█î╪│╪¬.");
    lines.splice(8, 0, `╪¼┘ê╪º█î╪▓ ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪º╪»┘à█î┘å: ${rewardStatusSummary.awaitingAdmin}`);
    lines.splice(9, 0, `╪¼┘ê╪º█î╪▓ ┘à╪│╪»┘ê╪»╪┤╪»┘ç: ${rewardStatusSummary.blocked}`);
    if (inviteLink) {
        lines.push("┘ä█î┘å┌⌐ ╪º╪«╪¬╪╡╪º╪╡█î ╪┤┘à╪º:");
        lines.push(`<code>${escapeHtml(inviteLink)}</code>`);
    }
    else {
        lines.push("┘ä█î┘å┌⌐ ╪º╪«╪¬╪╡╪º╪╡█î ╪┤┘à╪º ┘ü╪╣┘ä╪º┘ï ┘é╪º╪¿┘ä ╪¬┘ê┘ä█î╪» ┘å█î╪│╪¬. ┌⌐┘à█î ╪¿╪╣╪» ╪»┘ê╪¿╪º╪▒┘ç ╪º┘à╪¬╪¡╪º┘å ┌⌐┘å█î╪».");
    }
    const keyboard = [];
    if (inviteLink) {
        keyboard.push([{ text: "≡ƒô¿ ╪º╪┤╪¬╪▒╪º┌⌐ΓÇî┌»╪░╪º╪▒█î ┘ä█î┘å┌⌐", url: buildReferralShareUrl(inviteLink) }]);
    }
    keyboard.push([cb("≡ƒº¡ ╪▒╪º┘ç┘å┘à╪º█î ╪»╪▒█î╪º┘ü╪¬ ╪¼╪º█î╪▓┘ç", "referral_claim_help", "primary")]);
    keyboard.push([cb("≡ƒæÑ ┘ü┘ç╪▒╪│╪¬ ╪»╪╣┘ê╪¬ΓÇî┘ç╪º", "referral_invitees", "primary"), cb("≡ƒº╛ ╪¬╪º╪▒█î╪«┌å┘ç ╪¼┘ê╪º█î╪▓", "referral_rewards_history", "primary")]);
    keyboard.push([homeButton()]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function sendReferralClaimHelp(chatId) {
    const settings = await getReferralSettingsSnapshot();
    const rewardMode = settings.rewardType === "wallet" ? "╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä" : "╪│┘ü╪º╪▒╪┤ ╪▒╪º█î┌»╪º┘å";
    await tg("sendMessage", {
        chat_id: chatId,
        text: "≡ƒº¡ ╪▒╪º┘ç┘å┘à╪º█î ╪»╪▒█î╪º┘ü╪¬ ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬\n\n" +
            "1) ┘ä█î┘å┌⌐ ╪º╪«╪¬╪╡╪º╪╡█î ╪«┘ê╪»╪¬ ╪▒┘ê ╪º╪▒╪│╪º┘ä ┌⌐┘å.\n" +
            "2) ┘ê┘é╪¬█î ┌⌐╪º╪▒╪¿╪▒ ╪¿╪º ┘ä█î┘å┌⌐ ╪¬┘ê ┘ê╪º╪▒╪» ╪▒╪¿╪º╪¬ ╪¿╪┤┘ç╪î ┘ä█î┘å┌⌐ ╪¿┘ç ╪º╪│┘à ╪¬┘ê ┘é┘ü┘ä ┘à█î╪┤┘ç ┘ê ╪¬╪║█î█î╪▒ ┘å┘à█îΓÇî┌⌐┘å┘ç.\n" +
            "3) ┌⌐╪º╪▒╪¿╪▒ ╪¿╪º█î╪» ╪╣╪╢┘ê█î╪¬ ┌⌐╪º┘å╪º┘äΓÇî┘ç╪º ╪▒┘ê ┌⌐╪º┘à┘ä ┌⌐┘å┘ç.\n" +
            "4) ╪¿╪╣╪» ╪º╪▓ ╪¬╪º█î█î╪» ╪╣╪╢┘ê█î╪¬╪î ╪»╪╣┘ê╪¬ ╪¿┘ç ╪¡╪º┘ä╪¬ ╪¬╪º█î█î╪»╪┤╪»┘ç ┘à█î╪▒┘ç ┘ê ╪¿┘ç╪¬ ╪º╪╣┘ä╪º┘å ┘à█î╪º╪».\n" +
            `5) ┘ç╪▒ ${settings.threshold} ╪»╪╣┘ê╪¬ ╪¬╪º█î█î╪»╪┤╪»┘ç╪î ╪¼╪º█î╪▓┘ç ${rewardMode} ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪½╪¿╪¬ ┘à█î╪┤┘ç.\n\n` +
            "Γ¥î ┘å█î╪º╪▓█î ╪¿┘ç Claim ╪»╪│╪¬█î ┘å█î╪│╪¬.\n" +
            "╪¿╪▒╪º█î ┘╛█î┌»█î╪▒█î ┘ê╪╢╪╣█î╪¬╪î ╪º╪▓ ┬½┘ü┘ç╪▒╪│╪¬ ╪»╪╣┘ê╪¬ΓÇî┘ç╪º┬╗ ┘ê ┬½╪¬╪º╪▒█î╪«┌å┘ç ╪¼┘ê╪º█î╪▓┬╗ ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å.",
        reply_markup: { inline_keyboard: [[backButton("referral_menu")], [homeButton()]] }
    });
}
async function showAdminReferralProductPicker(chatId) {
    const rows = await sql `
    SELECT id, name, is_active, sell_mode, panel_id
    FROM products
    ORDER BY is_active DESC, id ASC
    LIMIT 50;
  `;
    const keyboard = rows.map((row) => {
        const activeBadge = row.is_active ? "Γ£à" : "Γ¢ö";
        const hasPanel = !!(row.panel_id);
        const sellModeBadge = hasPanel ? "ΓÜÖ∩╕Å┘╛┘å┘ä" : "≡ƒôª╪»╪│╪¬█î";
        return [cb(`${activeBadge} ${sellModeBadge} ${String(row.name)} (#${Number(row.id)})`, `admin_referral_product_${Number(row.id)}`, "primary")];
    });
    keyboard.push([cb("≡ƒÜ½ ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å ┘à╪¡╪╡┘ê┘ä ╪º┘å╪¬╪«╪º╪¿ΓÇî╪┤╪»┘ç", "admin_referral_clear_product", "danger")]);
    keyboard.push([backButton("admin_referral_settings")]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "≡ƒÄü ╪º┘å╪¬╪«╪º╪¿ ┘à╪¡╪╡┘ê┘ä ╪¼╪º█î╪▓┘ç\n\n" +
            "┘à╪¡╪╡┘ê┘ä█î ╪▒╪º ┌⌐┘ç ╪¿╪º█î╪» ╪¿┘ç ╪╣┘å┘ê╪º┘å ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪½╪¿╪¬ ╪┤┘ê╪» ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪».\n\n" +
            "ΓÜÖ∩╕Å┘╛┘å┘ä = ╪»╪º╪▒╪º█î ┘╛┘å┘ä v2ray (┌⌐╪º┘å┘ü█î┌» ╪«┘ê╪»┌⌐╪º╪▒ ╪│╪º╪«╪¬┘ç ┘à█îΓÇî╪┤┘ê╪»)\n" +
            "≡ƒôª╪»╪│╪¬█î = ╪¿╪»┘ê┘å ┘╛┘å┘ä (╪º╪»┘à█î┘å ╪¿╪º█î╪» ┌⌐╪º┘å┘ü█î┌» ╪▒╪º ╪»╪│╪¬█î ╪¬╪¡┘ê█î┘ä ╪»┘ç╪»)\n" +
            "Γ¢ö = ┘à╪¡╪╡┘ê┘ä ╪║█î╪▒┘ü╪╣╪º┘ä (┘à█îΓÇî╪¬┘ê╪º┘å ╪¿┘ç ╪╣┘å┘ê╪º┘å ╪¼╪º█î╪▓┘ç ╪º┘å╪¬╪«╪º╪¿ ┌⌐╪▒╪»)",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function showAdminReferralSettings(chatId) {
    const settings = await getReferralSettingsSnapshot();
    const productName = settings.productId
        ? String((await sql `SELECT name FROM products WHERE id = ${settings.productId} LIMIT 1;`)[0]?.name || "")
        : "";
    const leadRows = await sql `
    SELECT
      COUNT(*)::int AS total_leads,
      COUNT(*) FILTER (WHERE referral_qualified_at IS NOT NULL)::int AS qualified_leads,
      COUNT(DISTINCT referred_by_telegram_id)::int AS inviters
    FROM users
    WHERE referred_by_telegram_id IS NOT NULL;
  `;
    const rewardRows = await sql `SELECT COUNT(*)::int AS reward_count FROM referral_rewards;`;
    const rewardSummary = describeReferralReward(settings, productName || null);
    const rewardModeText = settings.rewardType === "config" ? "┌⌐╪º┘å┘ü█î┌»" : "╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä";
    const configDeliveryLine = settings.rewardType === "config"
        ? `╪▒┘ê╪┤ ╪¬╪¡┘ê█î┘ä ┌⌐╪º┘å┘ü█î┌»: ╪«┘ê╪»┌⌐╪º╪▒ (╪º┌»╪▒ ┘à╪¡╪╡┘ê┘ä ┘╛┘å┘ä ╪»╪º╪┤╪¬┘ç ╪¿╪º╪┤╪» ΓåÆ ╪º╪▓ ┘╛┘å┘ä╪î ╪»╪▒ ╪║█î╪▒ ╪º█î┘å ╪╡┘ê╪▒╪¬ ΓåÆ ╪¬╪¡┘ê█î┘ä ╪»╪│╪¬█î ╪º╪»┘à█î┘å)\n`
        : "";
    const qualifiedLeads = Number(leadRows[0]?.qualified_leads || 0);
    const totalLeads = Number(leadRows[0]?.total_leads || 0);
    const inviters = Number(leadRows[0]?.inviters || 0);
    const rewardCount = Number(rewardRows[0]?.reward_count || 0);
    const configurationWarning = settings.rewardType === "wallet"
        ? settings.walletAmount <= 0
            ? "\n┘ç╪┤╪»╪º╪▒: ┘à╪¿┘ä╪║ ╪¼╪º█î╪▓┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ┘ç┘å┘ê╪▓ ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬."
            : ""
        : !settings.productId
            ? "\n┘ç╪┤╪»╪º╪▒: ┘à╪¡╪╡┘ê┘ä ╪¼╪º█î╪▓┘ç ┌⌐╪º┘å┘ü█î┌» ┘ç┘å┘ê╪▓ ╪º┘å╪¬╪«╪º╪¿ ┘å╪┤╪»┘ç ╪º╪│╪¬."
            : "";
    const keyboard = [
        [cb(settings.enabled ? "Γ¢ö ╪║█î╪▒┘ü╪╣╪º┘äΓÇî┌⌐╪▒╪»┘å ╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬" : "Γ£à ┘ü╪╣╪º┘äΓÇî┌⌐╪▒╪»┘å ╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬", "admin_toggle_referral_enabled", settings.enabled ? "danger" : "success")],
        [cb("≡ƒÄ» ╪¬┘å╪╕█î┘à ╪ó╪│╪¬╪º┘å┘ç ╪»╪╣┘ê╪¬", "admin_set_referral_threshold", "primary")],
        [cb(settings.rewardType === "wallet" ? "Γ£à ┘╛╪º╪»╪º╪┤: ┌⌐█î┘ü ┘╛┘ê┘ä" : "┌⌐█î┘ü ┘╛┘ê┘ä", "admin_referral_reward_wallet", settings.rewardType === "wallet" ? "success" : "primary"), cb(settings.rewardType === "config" ? "Γ£à ┘╛╪º╪»╪º╪┤: ┌⌐╪º┘å┘ü█î┌»" : "┌⌐╪º┘å┘ü█î┌»", "admin_referral_reward_config", settings.rewardType === "config" ? "success" : "primary")],
        [cb("≡ƒÆ░ ┘à╪¿┘ä╪║ ╪¼╪º█î╪▓┘ç ┌⌐█î┘ü ┘╛┘ê┘ä", "admin_set_referral_wallet_amount", "primary")],
        [cb("≡ƒôª ╪º┘å╪¬╪«╪º╪¿ ┘à╪¡╪╡┘ê┘ä ╪¼╪º█î╪▓┘ç", "admin_referral_pick_product", "primary")]
    ];
    keyboard.push([backButton("admin_settings")]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: `≡ƒÄü ╪¬┘å╪╕█î┘à╪º╪¬ ╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬\n\n` +
            `┘ê╪╢╪╣█î╪¬: ${settings.enabled ? "┘ü╪╣╪º┘ä Γ£à" : "╪║█î╪▒┘ü╪╣╪º┘ä Γ¢ö"}\n` +
            `╪ó╪│╪¬╪º┘å┘ç ┘╛╪º╪»╪º╪┤: ┘ç╪▒ ${settings.threshold} ╪»╪╣┘ê╪¬ ╪¬╪º█î█î╪»╪┤╪»┘ç\n` +
            `┘å┘ê╪╣ ┘╛╪º╪»╪º╪┤: ${rewardModeText}\n` +
            configDeliveryLine +
            `┘╛╪º╪»╪º╪┤ ┘ü╪╣┘ä█î: ${rewardSummary}\n\n` +
            `╪ó┘à╪º╪▒ ╪│╪▒█î╪╣:\n` +
            `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪½╪¿╪¬ΓÇî╪┤╪»┘ç: ${totalLeads}\n` +
            `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪¬╪º█î█î╪»╪┤╪»┘ç: ${qualifiedLeads}\n` +
            `╪¬╪╣╪»╪º╪» ┘à╪╣╪▒┘üΓÇî┘ç╪º: ${inviters}\n` +
            `╪¼┘ê╪º█î╪▓ ┘╛╪▒╪»╪º╪«╪¬ΓÇî╪┤╪»┘ç: ${rewardCount}` +
            configurationWarning,
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function setState(telegramId, state, payload = {}) {
    await sql `
    INSERT INTO user_states (telegram_id, state, payload)
    VALUES (${telegramId}, ${state}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (telegram_id)
    DO UPDATE SET state = EXCLUDED.state, payload = EXCLUDED.payload, updated_at = NOW();
  `;
}
async function clearState(telegramId) {
    await sql `DELETE FROM user_states WHERE telegram_id = ${telegramId};`;
}
async function getState(telegramId) {
    const rows = await sql `SELECT state, payload FROM user_states WHERE telegram_id = ${telegramId} LIMIT 1;`;
    if (!rows.length)
        return null;
    let payload = rows[0].payload;
    if (typeof payload === "string") {
        try {
            payload = JSON.parse(payload);
        }
        catch {
            payload = {};
        }
    }
    return {
        state: String(rows[0].state),
        payload: payload || {}
    };
}
async function isBanned(userId) {
    const rows = await sql `SELECT telegram_id FROM banned_users WHERE telegram_id = ${userId} LIMIT 1;`;
    return rows.length > 0;
}
async function adminHelp(chatId) {
    await tg("sendMessage", {
        chat_id: chatId,
        text: "╪▒╪º┘ç┘å┘à╪º█î ╪º╪»┘à█î┘å:\n" +
            "/help - ┘å┘à╪º█î╪┤ ┘ç┘à█î┘å ╪▒╪º┘ç┘å┘à╪º\n" +
            "/start - ┘à┘å┘ê█î ╪º╪╡┘ä█î\n" +
            "/admin - ┘ê╪▒┘ê╪» ╪│╪▒█î╪╣ ╪¿┘ç ┘╛┘å┘ä ╪º╪»┘à█î┘å\n" +
            "/cancel - ┘ä╪║┘ê ╪╣┘à┘ä█î╪º╪¬ ╪»╪▒ ╪¡╪º┘ä ╪º┘å╪¼╪º┘à\n\n" +
            "┘à╪»█î╪▒█î╪¬ ┌⌐╪º┘à┘ä ┘à╪¡╪╡┘ê┘ä╪º╪¬╪î ┘à┘ê╪¼┘ê╪»█î╪î ╪¬╪«┘ü█î┘üΓÇî┘ç╪º╪î ╪ó┘à╪º╪▒ ┘ê ╪¬┘å╪╕█î┘à╪º╪¬ ╪º╪▓ ┘╛┘å┘ä ╪º╪»┘à█î┘å ╪º┘å╪¼╪º┘à ┘à█îΓÇî╪┤┘ê╪»."
    });
}
async function sendAdminPanel(chatId) {
    await tg("sendMessage", {
        chat_id: chatId,
        text: "┘╛┘å┘ä ╪º╪»┘à█î┘å ≡ƒæç",
        reply_markup: {
            inline_keyboard: [
                [cb("≡ƒôª ┘à╪»█î╪▒█î╪¬ ┘à╪¡╪╡┘ê┘ä╪º╪¬", "admin_products", "primary")],
                [cb("≡ƒùé ┘à╪»█î╪▒█î╪¬ ┘à┘ê╪¼┘ê╪»█î", "admin_inventory", "primary")],
                [cb("≡ƒÆ│ ╪▒┘ê╪┤ΓÇî┘ç╪º█î ┘╛╪▒╪»╪º╪«╪¬", "admin_payment_methods", "primary")],
                [cb("≡ƒÆ│ ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º", "admin_cards", "primary")],
                [cb("≡ƒÄƒ ┌⌐╪» ╪¬╪«┘ü█î┘ü", "admin_discounts", "primary")],
                [cb("≡ƒîÉ ┘╛┘å┘äΓÇî┘ç╪º█î V2Ray", "admin_panels", "primary")],
                [cb("≡ƒæÑ ┘à╪»█î╪▒█î╪¬ ┌⌐╪º╪▒╪¿╪▒╪º┘å", "admin_manage_users", "primary")],
                [cb("≡ƒôè ╪ó┘à╪º╪▒", "admin_stats", "primary")],
                [cb("≡ƒº░ ╪º╪¿╪▓╪º╪▒ ╪º╪»┘à█î┘å", "admin_tools", "primary")],
                [cb("ΓÜÖ∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬", "admin_settings", "primary")],
                [homeButton()]
            ]
        }
    });
}
export function generateAdminToken(telegramId) {
    const SECRET = process.env.TELEGRAM_BOT_TOKEN || "default_secret";
    const expiresAt = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
    const payload = `${telegramId}|${expiresAt}`;
    const hmac = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
    return Buffer.from(`${payload}|${hmac}`).toString("base64url");
}
export function verifyAdminToken(token) {
    const SECRET = process.env.TELEGRAM_BOT_TOKEN || "default_secret";
    try {
        const decoded = Buffer.from(token, "base64url").toString("utf-8");
        const [tgIdStr, expiresStr, signature] = decoded.split("|");
        const payload = `${tgIdStr}|${expiresStr}`;
        const expectedHmac = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
        if (signature !== expectedHmac)
            return null;
        if (Date.now() > Number(expiresStr))
            return null;
        return Number(tgIdStr);
    }
    catch {
        return null;
    }
}
async function showPanelAdminMenu(chatId, notice) {
    const rows = await sql `
    SELECT id, name, panel_type, active, allow_customer_migration, allow_new_sales, last_check_ok, last_check_message
    FROM panels
    ORDER BY priority DESC, id ASC;
  `;
    if (!rows.length) {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘ç┘å┘ê╪▓ ┘ç█î┌å ┘╛┘å┘ä█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬.",
            reply_markup: {
                inline_keyboard: [
                    [cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ┘╛┘å┘ä", "admin_panel_add", "success")],
                    [cb("≡ƒôÑ ╪╡┘ü ╪º┘å╪¬┘é╪º┘äΓÇî┘ç╪º", "admin_migrations", "primary")],
                    [backButton("admin_panel")]
                ]
            }
        });
        return null;
    }
    const keyboard = rows.flatMap((p) => [
        [
            {
                text: `${p.name} | ${String(p.panel_type).toUpperCase()} | ${p.active ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"}\n` +
                    `┘à┘ç╪º╪¼╪▒╪¬ ┌⌐╪º╪▒╪¿╪▒: ${p.allow_customer_migration ? "╪▒┘ê╪┤┘å" : "╪«╪º┘à┘ê╪┤"} | ┘ü╪▒┘ê╪┤ ╪¼╪»█î╪»: ${p.allow_new_sales ? "╪▒┘ê╪┤┘å" : "╪«╪º┘à┘ê╪┤"}\n` +
                    `╪ó╪«╪▒█î┘å ╪¬╪│╪¬: ${panelResultLabel(p.last_check_ok)}${p.last_check_message ? ` | ${String(p.last_check_message).slice(0, 40)}` : ""}`,
                callback_data: `admin_panel_open_${p.id}`
            }
        ],
        [
            cb("┘ê█î╪▒╪º█î╪┤", `admin_panel_edit_${p.id}`, "primary"),
            cb(p.active ? "╪║█î╪▒┘ü╪╣╪º┘ä" : "┘ü╪╣╪º┘ä", `admin_panel_toggle_${p.id}`, p.active ? "danger" : "success"),
            cb(p.allow_customer_migration ? "┘é┘ü┘ä ┘à┘ç╪º╪¼╪▒╪¬" : "╪ó╪▓╪º╪» ┘à┘ç╪º╪¼╪▒╪¬", `admin_panel_toggle_move_${p.id}`, "primary")
        ],
        [
            cb(p.allow_new_sales ? "╪¿╪│╪¬┘å ┘ü╪▒┘ê╪┤ ╪¼╪»█î╪»" : "╪¿╪º╪▓┌⌐╪▒╪»┘å ┘ü╪▒┘ê╪┤ ╪¼╪»█î╪»", `admin_panel_toggle_sales_${p.id}`, p.allow_new_sales ? "danger" : "success"),
            cb("╪¬╪│╪¬ ╪º╪¬╪╡╪º┘ä", `admin_panel_test_${p.id}`, "primary")
        ],
        [
            cb("┘ê╪╢╪╣█î╪¬ ┌⌐╪┤", `admin_panel_cache_${p.id}`, "primary"),
            cb("≡ƒùæ ╪¡╪░┘ü", `admin_panel_remove_${p.id}`, "danger")
        ]
    ]);
    keyboard.push([cb("≡ƒº¬ ╪¬╪│╪¬ ┘ç┘à┘ç ┘╛┘å┘äΓÇî┘ç╪º", "admin_panel_test_all", "primary")]);
    keyboard.push([cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ┘╛┘å┘ä", "admin_panel_add", "success")]);
    keyboard.push([cb("≡ƒôÑ ╪╡┘ü ╪º┘å╪¬┘é╪º┘äΓÇî┘ç╪º", "admin_migrations", "primary")]);
    keyboard.push([backButton("admin_panel")]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: `${notice ? `${notice}\n\n` : ""}┘à╪»█î╪▒█î╪¬ ┘╛┘å┘äΓÇî┘ç╪º█î V2Ray:\n╪¿╪▒╪º█î ╪»█î╪»┘å ╪¼╪▓╪ª█î╪º╪¬ ┘ç╪▒ ┘╛┘å┘ä╪î ╪▒┘ê█î ╪▒╪»█î┘ü ╪¿╪º┘ä╪º█î█î ╪ó┘å ╪¿╪▓┘å█î╪».`,
        reply_markup: { inline_keyboard: keyboard }
    });
}
export async function loginMarzbanPanel(panel) {
    const body = new URLSearchParams();
    body.set("grant_type", "password");
    body.set("username", String(panel.username || ""));
    body.set("password", String(panel.password || ""));
    const res = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url || ""))}/api/admin/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
    const raw = await res.text();
    const data = parseJsonObject(raw);
    const token = String(data?.access_token || "");
    return { res, raw, token };
}
/**
 * Fetch available inbounds from a Marzban/PasarGuard panel.
 * Returns a map of protocol ΓåÆ array of inbound tag names.
 * e.g. { "vless": ["Iran", "Germany"], "trojan": ["Iran-Trojan"] }
 */
export async function getMarzbanInbounds(baseUrl, token) {
    try {
        const res = await fetchWithTimeout(`${normalizeBaseUrl(baseUrl)}/api/inbounds`, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
        });
        const raw = await res.text();
        if (!res.ok)
            return {};
        const data = parseJsonObject(raw);
        if (!data || typeof data !== "object")
            return {};
        const result = {};
        for (const [protocol, items] of Object.entries(data)) {
            if (!Array.isArray(items))
                continue;
            const tags = [];
            for (const item of items) {
                const tag = String(item.tag || item.remark || "").trim();
                if (tag)
                    tags.push(tag);
            }
            if (tags.length > 0)
                result[protocol.toLowerCase()] = tags;
        }
        return result;
    }
    catch {
        return {};
    }
}
/**
 * Fetch available groups from a PasarGuard panel.
 * PasarGuard uses groups (not inbounds) to assign proxy access to users.
 * Returns an array of { id, name } for all non-disabled groups.
 * Endpoint: GET /api/groups  ΓåÆ  { groups: [{id, name, inbound_tags, is_disabled}], total }
 */
export async function getPasarguardGroups(baseUrl, token) {
    try {
        const url = `${normalizeBaseUrl(baseUrl)}/api/groups`;
        const res = await fetchWithTimeout(url, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
        });
        const raw = await res.text();
        // Log the raw response for debugging
        if (!res.ok) {
            logError("pasarguard_groups_api_error", new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`), { url, status: res.status });
            return [];
        }
        const data = parseJsonObject(raw);
        if (!data) {
            logError("pasarguard_groups_parse_error", new Error(`Failed to parse JSON: ${raw.slice(0, 200)}`), { url });
            return [];
        }
        if (!data.groups || !Array.isArray(data.groups)) {
            logError("pasarguard_groups_missing_array", new Error(`Groups not array or missing. Keys: ${Object.keys(data).join(", ")}`), { url, data });
            return [];
        }
        // Return ALL groups (including disabled ones) - let caller decide if filtering is needed
        const groups = data.groups.map((g) => ({
            id: Number(g.id),
            name: String(g.name || ""),
            inbound_tags: Array.isArray(g.inbound_tags) ? g.inbound_tags.map(String) : []
        }));
        logInfo("pasarguard_groups_fetched", { url, count: groups.length, groups: groups.map(g => ({ id: g.id, name: g.name })) });
        return groups;
    }
    catch (error) {
        logError("pasarguard_groups_exception", error, { baseUrl });
        return [];
    }
}
export async function loginSanaeiPanel(panel) {
    const body = new URLSearchParams();
    body.set("username", String(panel.username || ""));
    body.set("password", String(panel.password || ""));
    const res = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url || ""))}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body
    });
    const raw = await res.text();
    const data = parseJsonObject(raw);
    const cookie = extractSessionCookie(res.headers.get("set-cookie"));
    return { res, raw, data, cookie };
}
export async function getSanaeiInbounds(baseUrl, cookie) {
    const res = await fetchWithTimeout(`${normalizeBaseUrl(baseUrl)}/panel/api/inbounds/list`, {
        method: "GET",
        headers: { Accept: "application/json", Cookie: cookie }
    });
    const raw = await res.text();
    const data = parseJsonObject(raw);
    const items = Array.isArray(data?.obj) ? data?.obj : [];
    return { res, raw, data, items };
}
async function findSanaeiClientByIdentifier(panel, identifier) {
    const candidateSet = new Set(collectLookupCandidates(identifier).map((item) => item.toLowerCase()));
    function searchInboundList(items, cookie) {
        for (const inbound of items) {
            const settings = toJsonObject(parseSanaeiNested(inbound.settings)) || {};
            const clients = Array.isArray(settings.clients) ? settings.clients : [];
            for (const client of clients) {
                const id = String(client.id || "");
                const email = String(client.email || "");
                const subId = String(client.subId || "");
                const asText = JSON.stringify(client).toLowerCase();
                const matched = Array.from(candidateSet).some((candidate) => {
                    if (id.toLowerCase() === candidate)
                        return true;
                    if (email.toLowerCase() === candidate)
                        return true;
                    if (subId.toLowerCase() === candidate)
                        return true;
                    if (candidate.length >= 6 && asText.includes(candidate))
                        return true;
                    return false;
                });
                if (!matched)
                    continue;
                const clientStats = Array.isArray(inbound.clientStats)
                    ? inbound.clientStats.find((s) => (email && String(s.email || "").toLowerCase() === email.toLowerCase()) ||
                        (id && String(s.email || "").toLowerCase() === id.toLowerCase()) ||
                        (subId && String(s.email || "").toLowerCase() === subId.toLowerCase()))
                    : undefined;
                // Prefer clientStats up/down; fall back to traffic fields embedded directly on
                // the client object (new Pasarguard/3x-ui backup format).
                const upBytes = clientStats
                    ? Number(clientStats.up || 0)
                    : Number(client.traffic_up_bytes ?? client.up ?? 0);
                const downBytes = clientStats
                    ? Number(clientStats.down || 0)
                    : Number(client.traffic_down_bytes ?? client.down ?? 0);
                const mergedClient = { ...client, up: upBytes, down: downBytes };
                return {
                    ok: true,
                    loginCookie: cookie,
                    inboundId: Number(inbound.id || 0),
                    inbound,
                    client: mergedClient,
                    clientKey: id || email || subId,
                    message: "ok",
                    fromBackup: !cookie
                };
            }
        }
        return null;
    }
    const panelId = Number(panel.id || 0);
    try {
        const login = await loginSanaeiPanel(panel);
        if (login.res.ok && jsonSuccess(login.data) && login.cookie) {
            const inbounds = await getSanaeiInbounds(String(panel.base_url), login.cookie);
            if (inbounds.res.ok && jsonSuccess(inbounds.data)) {
                const found = searchInboundList(inbounds.items, login.cookie);
                if (found)
                    return found;
                return { ok: false, message: "client_not_found" };
            }
        }
    }
    catch {
        // Panel unreachable (network error, timeout, DNS failure) ΓÇö fall through to backup
    }
    // Panel unreachable or auth failed ΓÇö try stored inbound backup
    if (panelId > 0) {
        const backupJson = await getSetting(`sanaei_inbound_backup_${panelId}`);
        if (backupJson) {
            let backupInbounds = [];
            try {
                const parsed = JSON.parse(backupJson);
                backupInbounds = Array.isArray(parsed) ? parsed : [];
            }
            catch { /* ignore */ }
            if (backupInbounds.length > 0) {
                const found = searchInboundList(backupInbounds, undefined);
                if (found)
                    return found;
                return { ok: false, message: "client_not_found_in_backup" };
            }
        }
    }
    return { ok: false, message: "sanaei_panel_unreachable" };
}
export async function revokeSanaeiClient(panel, identifier) {
    const found = await findSanaeiClientByIdentifier(panel, identifier);
    if (!found.ok || !found.loginCookie || !found.inboundId || !found.clientKey)
        return found;
    const delRes = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/panel/api/inbounds/${found.inboundId}/delClient/${encodeURIComponent(String(found.clientKey))}`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            Cookie: found.loginCookie,
            "Content-Type": "application/json"
        }
    });
    const delRaw = await delRes.text();
    const delData = parseJsonObject(delRaw);
    const ok = delRes.ok && (!delRaw.trim() || jsonSuccess(delData));
    if (!ok) {
        return { ok: false, message: `Sanaei revoke failed: ${delRes.status} ${responseSnippet(delRaw)}` };
    }
    return { ok: true, message: "revoked", client: found.client, inboundId: found.inboundId };
}
async function lookupMarzbanUser(panel, identifier) {
    const login = await loginMarzbanPanel(panel);
    if (!login.res.ok || !login.token) {
        return { ok: false, message: `Marzban auth failed: ${login.res.status}` };
    }
    const candidates = collectLookupCandidates(identifier).map((item) => item.toLowerCase());
    const base = normalizeBaseUrl(String(panel.base_url));
    for (const candidate of candidates) {
        const directRes = await fetchWithTimeout(`${base}/api/user/${encodeURIComponent(candidate)}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json" }
        });
        const directRaw = await directRes.text();
        const directData = parseJsonObject(directRaw);
        if (directRes.ok && directData) {
            return { ok: true, message: "ok", token: login.token, user: directData };
        }
    }
    const limit = 200;
    for (let page = 0; page < 12; page += 1) {
        const offset = page * limit;
        const listRes = await fetchWithTimeout(`${base}/api/users?offset=${offset}&limit=${limit}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json" }
        });
        const listRaw = await listRes.text();
        const listData = parseJsonObject(listRaw);
        if (!listRes.ok || !listData)
            break;
        const users = Array.isArray(listData.users)
            ? listData.users
            : Array.isArray(listData.items)
                ? listData.items
                : [];
        if (!users.length)
            break;
        for (const user of users) {
            const username = String(user.username || "").toLowerCase();
            const note = String(user.note || "").toLowerCase();
            const userJson = JSON.stringify(user).toLowerCase();
            const matched = candidates.some((candidate) => {
                if (username === candidate)
                    return true;
                if (note === candidate)
                    return true;
                if (candidate.length >= 6 && (username.includes(candidate) || note.includes(candidate) || userJson.includes(candidate)))
                    return true;
                return false;
            });
            if (matched)
                return { ok: true, message: "ok", token: login.token, user };
        }
        if (users.length < limit)
            break;
    }
    return { ok: false, message: "user_not_found" };
}
async function toggleMarzbanUser(panel, identifier, enable) {
    const found = await lookupMarzbanUser(panel, identifier);
    if (!found.ok || !found.token || !found.user)
        return found;
    const username = String(found.user.username || identifier).trim();
    const putRes = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/api/user/${encodeURIComponent(username)}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${found.token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify({ ...found.user, status: enable ? "active" : "disabled" })
    });
    const putRaw = await putRes.text();
    if (!putRes.ok)
        return { ok: false, message: `Marzban toggle failed: ${putRes.status} ${responseSnippet(putRaw)}` };
    return { ok: true, message: enable ? "enabled" : "disabled", user: found.user };
}
async function toggleSanaeiClient(panel, identifier, enable) {
    const found = await findSanaeiClientByIdentifier(panel, identifier);
    if (!found.ok || !found.loginCookie || !found.inboundId || !found.clientKey)
        return found;
    const updateRes = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/panel/api/inbounds/updateClient/${encodeURIComponent(String(found.clientKey))}`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            Cookie: found.loginCookie,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            id: found.inboundId,
            settings: JSON.stringify({ clients: [{ ...found.client, enable }] })
        })
    });
    const updateRaw = await updateRes.text();
    const updateData = parseJsonObject(updateRaw);
    const ok = updateRes.ok && (!updateRaw.trim() || jsonSuccess(updateData));
    if (!ok) {
        return { ok: false, message: `Sanaei toggle failed: ${updateRes.status} ${responseSnippet(updateRaw)}` };
    }
    return { ok: true, message: enable ? "enabled" : "disabled", client: found.client, inboundId: found.inboundId };
}
export async function regenerateMarzbanUserLink(panel, identifier) {
    const found = await lookupMarzbanUser(panel, identifier);
    if (!found.ok || !found.token || !found.user)
        return found;
    const username = String(found.user.username || identifier).trim();
    const postRes = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/api/user/${encodeURIComponent(username)}/revoke_sub`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${found.token}`,
            Accept: "application/json"
        }
    });
    const postRaw = await postRes.text();
    const postData = parseJsonObject(postRaw);
    if (!postRes.ok)
        return { ok: false, message: `Marzban link regen failed: ${postRes.status} ${responseSnippet(postRaw)}` };
    return { ok: true, message: "link_regenerated", user: postData };
}
export async function regenerateSanaeiClientLink(panel, identifier) {
    const found = await findSanaeiClientByIdentifier(panel, identifier);
    if (!found.ok || !found.loginCookie || !found.inboundId || !found.clientKey)
        return found;
    // Create a new UUID and new subId to revoke both config links and subscription URL
    const newUuid = crypto.randomUUID();
    const newSubId = randomCode(16).toLowerCase();
    const updateRes = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/panel/api/inbounds/updateClient/${encodeURIComponent(String(found.clientKey))}`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            Cookie: found.loginCookie,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            id: found.inboundId,
            settings: JSON.stringify({ clients: [{ ...found.client, id: newUuid, subId: newSubId }] })
        })
    });
    const updateRaw = await updateRes.text();
    const updateData = parseJsonObject(updateRaw);
    const ok = updateRes.ok && (!updateRaw.trim() || jsonSuccess(updateData));
    if (!ok) {
        return { ok: false, message: `Sanaei link regen failed: ${updateRes.status} ${responseSnippet(updateRaw)}` };
    }
    return { ok: true, message: "link_regenerated", client: { ...found.client, id: newUuid, subId: newSubId }, inboundId: found.inboundId, inbound: found.inbound };
}
export async function deleteMarzbanUser(panel, identifier) {
    const found = await lookupMarzbanUser(panel, identifier);
    if (!found.ok || !found.token || !found.user)
        return found;
    const username = String(found.user.username || identifier).trim();
    const delRes = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/api/user/${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${found.token}`, Accept: "application/json" }
    });
    const delRaw = await delRes.text();
    if (!delRes.ok)
        return { ok: false, message: `Marzban delete failed: ${delRes.status} ${responseSnippet(delRaw)}` };
    return { ok: true, message: "deleted", user: found.user };
}
async function performRegenLink(inventoryId, actorUserId, isAdminReq, chatId) {
    const rows = isAdminReq
        ? await sql `
        SELECT i.id, i.panel_id, i.delivery_payload, i.owner_telegram_id, i.config_value, p.panel_config
        FROM inventory i
        LEFT JOIN products p ON p.id = i.product_id
        WHERE i.id = ${inventoryId}
        LIMIT 1;
      `
        : await sql `
        SELECT i.id, i.panel_id, i.delivery_payload, i.owner_telegram_id, i.config_value,
               i.status, i.migrated_to_inventory_id, p.panel_config
        FROM inventory i
        LEFT JOIN products p ON p.id = i.product_id
        WHERE i.id = ${inventoryId}
          AND i.owner_telegram_id = ${actorUserId}
          AND i.status IN ('sold', 'migrated')
        LIMIT 1;
      `;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪» █î╪º ┘à╪¬╪╣┘ä┘é ╪¿┘ç ╪┤┘à╪º ┘å█î╪│╪¬." });
        return null;
    }
    // Redirect regen to the new config if this one was already migrated
    if (!isAdminReq && String(rows[0].status) === "migrated" && rows[0].migrated_to_inventory_id) {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜí ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¿┘ç ┘╛┘å┘ä ╪¼╪»█î╪» ┘à┘å╪¬┘é┘ä ╪┤╪»┘ç. ┘ä█î┘å┌⌐ ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪º╪▓ ┘ä█î╪│╪¬ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î╪¬╪º┘å ┘é╪º╪¿┘ä ╪»╪│╪¬╪▒╪│ ╪º╪│╪¬." });
        return null;
    }
    const row = rows[0];
    const delivery = parseDeliveryPayload(row.delivery_payload);
    const panelType = String(delivery.metadata?.panelType || "");
    const panelId = Number(row.panel_id || 0);
    const key = String(delivery.metadata?.username || delivery.metadata?.uuid || delivery.metadata?.email || delivery.metadata?.subId || "").trim();
    if (!panelId || !panelType || !key) {
        await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘╛┘å┘ä█î ┘å█î╪│╪¬ █î╪º ╪┤┘å╪º╪│┘ç ┘à╪╣╪¬╪¿╪▒ ┘å╪»╪º╪▒╪»." });
        return null;
    }
    const panelRows = await sql `
    SELECT id, panel_type, base_url, username, password, subscription_public_port, subscription_public_host, subscription_link_protocol, config_public_host
    FROM panels
    WHERE id = ${panelId}
    LIMIT 1;
  `;
    if (!panelRows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
        return null;
    }
    let regenMessage = "╪╣┘à┘ä█î╪º╪¬ ╪º┘å╪¼╪º┘à ┘å╪┤╪».";
    let newUuid;
    let newSubIdForMeta;
    let newConfigLinks = [];
    let newSubscriptionUrl;
    if (isMarzbanLike(panelType)) {
        const result = await regenerateMarzbanUserLink(panelRows[0], key);
        if (result.ok && result.user) {
            regenMessage = "╪¬╪║█î█î╪▒ ┘ä█î┘å┌⌐ ╪¿╪º ┘à┘ê┘ü┘é█î╪¬ ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à";
            const u = result.user;
            newConfigLinks = Array.isArray(u.links) ? u.links.map((x) => String(x || "").trim()).filter(Boolean) : [];
            newSubscriptionUrl = u.subscription_url ? resolveMarzbanSubUrl(String(panelRows[0].base_url), String(u.subscription_url)) : undefined;
        }
        else {
            regenMessage = `╪«╪╖╪º ╪»╪▒ ╪¬╪║█î█î╪▒ ┘ä█î┘å┌⌐: ${result.message}`;
            await tg("sendMessage", { chat_id: chatId, text: regenMessage });
            return null;
        }
    }
    else {
        const result = await regenerateSanaeiClientLink(panelRows[0], key);
        if (result.ok && result.client && result.inbound) {
            regenMessage = "╪¬╪║█î█î╪▒ ┘ä█î┘å┌⌐ ╪¿╪º ┘à┘ê┘ü┘é█î╪¬ ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à";
            newUuid = String(result.client.id || "");
            newSubIdForMeta = String(result.client.subId || "") || undefined;
            const panelConfig = (typeof row.panel_config === "string" ? parseJsonObject(row.panel_config) : row.panel_config) || {};
            const mergedCfg = mergeSanaeiPanelRowIntoClientConfig(panelConfig, panelRows[0]);
            newConfigLinks = buildSanaeiConfigLinks(String(panelRows[0].base_url), result.inbound, result.client, mergedCfg);
            const subId = String(result.client.subId || "");
            newSubscriptionUrl = subId
                ? buildSanaeiSubscriptionUrl(String(panelRows[0].base_url), panelConfig, subId, panelRows[0])
                : undefined;
        }
        else {
            regenMessage = `╪«╪╖╪º ╪»╪▒ ╪¬╪║█î█î╪▒ ┘ä█î┘å┌⌐: ${result.message}`;
            await tg("sendMessage", { chat_id: chatId, text: regenMessage });
            return null;
        }
    }
    await recordInventoryForensicEvent(inventoryId, isAdminReq ? "admin_regen_link" : "customer_regen_link", { actor: actorUserId, panelResult: regenMessage });
    const previousConfigs = Array.isArray(delivery.previousConfigs) ? delivery.previousConfigs : [];
    if (row.config_value && !previousConfigs.includes(String(row.config_value))) {
        previousConfigs.push(String(row.config_value));
    }
    if (delivery.subscriptionUrl && !previousConfigs.includes(delivery.subscriptionUrl)) {
        previousConfigs.push(delivery.subscriptionUrl);
    }
    const updatedDelivery = { ...delivery, previousConfigs };
    if (newConfigLinks.length > 0)
        updatedDelivery.configLinks = newConfigLinks;
    if (newSubscriptionUrl)
        updatedDelivery.subscriptionUrl = newSubscriptionUrl;
    if (newUuid && updatedDelivery.metadata)
        updatedDelivery.metadata.uuid = newUuid;
    // Save the new subId so future lookups use the updated identifier (sanaei only)
    if (newSubIdForMeta && updatedDelivery.metadata)
        updatedDelivery.metadata.subId = newSubIdForMeta;
    const newConfigValue = newSubscriptionUrl || newConfigLinks[0] || String(row.config_value);
    await sql `
    UPDATE inventory
    SET 
      config_value = ${newConfigValue},
      delivery_payload = ${JSON.stringify(updatedDelivery)}::jsonb
    WHERE id = ${inventoryId};
  `;
    let msgText = `┘ä█î┘å┌⌐ ╪┤┘à╪º ╪¿╪º ┘à┘ê┘ü┘é█î╪¬ ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à\n\n┘ä█î┘å┌⌐ ╪¼╪»█î╪»:\n${newConfigValue}`;
    if (newSubscriptionUrl && newConfigLinks.length > 0) {
        msgText = `┘ä█î┘å┌⌐ ╪┤┘à╪º ╪¿╪º ┘à┘ê┘ü┘é█î╪¬ ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à\n\n≡ƒöù ╪│╪º╪¿ (┘╛█î╪┤┘å┘ç╪º╪»█î):\n${newSubscriptionUrl}\n\n┌⌐╪º┘å┘ü█î┌» ┘à╪│╪¬┘é█î┘à:\n${newConfigLinks[0]}`;
    }
    await tg("sendMessage", {
        chat_id: chatId,
        text: msgText
    });
}
function extractPanelLookupIdentifier(raw) {
    const trimmed = raw.trim();
    const uuid = extractUuidFromText(trimmed);
    if (uuid)
        return uuid;
    const candidates = collectLookupCandidates(trimmed);
    return candidates[0] || trimmed;
}
export async function lookupIdentifierInPanels(raw, opts = {}) {
    const identifier = raw.trim();
    if (!identifier)
        return { ok: false, message: "empty_identifier" };
    // When includeInactive=true (e.g. admin migration tool), search ALL panels ΓÇö
    // the source panel is often deactivated before migration starts.
    const panels = opts.includeInactive
        ? await sql `
        SELECT id, name, panel_type, base_url, username, password, active, subscription_public_port, subscription_public_host, subscription_link_protocol, config_public_host
        FROM panels
        ORDER BY active DESC, priority DESC, id ASC;
      `
        : await sql `
        SELECT id, name, panel_type, base_url, username, password, active, subscription_public_port, subscription_public_host, subscription_link_protocol, config_public_host
        FROM panels
        WHERE active = TRUE
        ORDER BY priority DESC, id ASC;
      `;
    const results = await Promise.allSettled(panels.map(async (panel) => {
        const panelType = String(panel.panel_type);
        if (isMarzbanLike(panelType)) {
            const found = await lookupMarzbanUser(panel, identifier);
            if (!found.ok || !found.user)
                return null;
            const ownerTg = parsePanelUserTelegramId(found.user.note);
            return {
                ok: true,
                source: "panel",
                panelId: Number(panel.id),
                panelName: String(panel.name),
                panelBaseUrl: String(panel.base_url || ""),
                panelType: panelType,
                subscriptionPublicPort: null,
                subscriptionPublicHost: null,
                subscriptionLinkProtocol: null,
                ownerTelegramId: ownerTg,
                panelUserKey: String(found.user.username || identifier),
                panelUser: found.user
            };
        }
        if (panelType === "sanaei") {
            const found = await findSanaeiClientByIdentifier(panel, identifier);
            if (!found.ok || !found.client)
                return null;
            const client = found.client;
            const ownerTg = parsePanelUserTelegramId(client.tgId || client.email || "");
            const panelUserKey = String(client.id || client.subId || client.email || identifier);
            const subPort = parseMaybeNumber(panel.subscription_public_port);
            const subHost = sanitizeSubscriptionPublicHostInput(String(panel.subscription_public_host || ""));
            const subProtoRaw = String(panel.subscription_link_protocol || "").trim().toLowerCase();
            const subProto = subProtoRaw === "http" || subProtoRaw === "https" ? subProtoRaw : null;
            return {
                ok: true,
                source: "panel",
                panelId: Number(panel.id),
                panelName: String(panel.name),
                panelBaseUrl: String(panel.base_url || ""),
                panelType: "sanaei",
                subscriptionPublicPort: subPort !== null && subPort > 0 ? subPort : null,
                subscriptionPublicHost: subHost || null,
                subscriptionLinkProtocol: subProto,
                ownerTelegramId: ownerTg,
                panelUserKey,
                panelUser: client,
                inboundId: found.inboundId || null
            };
        }
        return null;
    }));
    for (const res of results) {
        if (res.status === "fulfilled" && res.value)
            return res.value;
    }
    return { ok: false, message: "not_found_in_panels" };
}
async function buildInventoryPanelRuntimeDetails(inventoryId, panelIdRaw, deliveryPayloadRaw, panelCache) {
    const panelId = Number(panelIdRaw || 0);
    const delivery = parseDeliveryPayload(deliveryPayloadRaw);
    const panelType = String(delivery.metadata?.panelType || "");
    const panelKey = String(delivery.metadata?.username || delivery.metadata?.email || delivery.metadata?.uuid || delivery.metadata?.subId || "").trim();
    if (!panelId || !panelType || !panelKey)
        return null;
    let panel = panelCache.get(panelId);
    if (!panel) {
        const rows = await sql `
      SELECT id, name, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!rows.length)
            return null;
        const fetched = rows[0];
        if (!fetched)
            return null;
        panel = fetched;
        panelCache.set(panelId, panel);
    }
    if (isMarzbanLike(panelType)) {
        const found = await lookupMarzbanUser(panel, panelKey);
        const label = panelTypeTitle(panelType);
        if (!found.ok || !found.user) {
            return `≡ƒûÑ ┘╛┘å┘ä: ${String(panel.name || "-")} (${label})\n≡ƒôí ╪¼╪▓╪ª█î╪º╪¬ ┘ä╪¡╪╕┘çΓÇî╪º█î: ┘å╪º┘à┘ê┘ü┘é`;
        }
        const user = found.user;
        const totalBytes = Number(user.data_limit || 0);
        const usedBytes = Number(user.used_traffic || user.usedTraffic || user.used_bytes || 0);
        const remainBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) : 0;
        return (`≡ƒûÑ ┘╛┘å┘ä: ${String(panel.name || "-")} (${label})\n` +
            `≡ƒöæ user: ${String(user.username || panelKey)}\n` +
            `≡ƒô╢ ┘ê╪╢╪╣█î╪¬: ${String(user.status || "-")}\n` +
            `≡ƒôè ┘à╪╡╪▒┘ü: ${totalBytes > 0 ? `${formatBytesShort(usedBytes)} / ${formatBytesShort(totalBytes)} (╪¿╪º┘é█îΓÇî┘à╪º┘å╪»┘ç: ${formatBytesShort(remainBytes)})` : "┘å╪º┘à╪¡╪»┘ê╪»"}\n` +
            `≡ƒôà ╪º┘å┘é╪╢╪º: ${formatExpiryLabelFromSeconds(user.expire)}\n` +
            `≡ƒåö inventory: #${inventoryId}`);
    }
    if (panelType === "sanaei") {
        const found = await findSanaeiClientByIdentifier(panel, panelKey);
        if (!found.ok || !found.client) {
            return `≡ƒûÑ ┘╛┘å┘ä: ${String(panel.name || "-")} (3x-ui)\n≡ƒôí ╪¼╪▓╪ª█î╪º╪¬ ┘ä╪¡╪╕┘çΓÇî╪º█î: ┘å╪º┘à┘ê┘ü┘é`;
        }
        const client = found.client;
        const totalBytes = Number(client.totalGB || 0); // stored in bytes despite the field name
        const usedBytes = Math.max(0, Number(client.up || 0) + Number(client.down || 0));
        const remainBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) : 0;
        return (`≡ƒûÑ ┘╛┘å┘ä: ${String(panel.name || "-")} (3x-ui)\n` +
            `≡ƒöæ email: ${String(client.email || panelKey)}\n` +
            `≡ƒô╢ ┘ê╪╢╪╣█î╪¬: ${parseMaybeBoolean(client.enable) === false ? "╪║█î╪▒┘ü╪╣╪º┘ä" : "┘ü╪╣╪º┘ä"}\n` +
            `≡ƒôè ┘à╪╡╪▒┘ü: ${totalBytes > 0 ? `${formatBytesShort(usedBytes)} / ${formatBytesShort(totalBytes)} (╪¿╪º┘é█îΓÇî┘à╪º┘å╪»┘ç: ${formatBytesShort(remainBytes)})` : "┘å╪º┘à╪¡╪»┘ê╪»"}\n` +
            `≡ƒôà ╪º┘å┘é╪╢╪º: ${formatExpiryLabelFromMilliseconds(client.expiryTime)}\n` +
            `≡ƒº⌐ inbound: ${Number(found.inboundId || 0) || "-"}\n` +
            `≡ƒåö inventory: #${inventoryId}`);
    }
    return null;
}
async function recordForensicEvent(params) {
    await sql `
    INSERT INTO config_forensics (
      inventory_id,
      owner_telegram_id,
      product_id,
      panel_id,
      panel_type,
      panel_user_key,
      uuid,
      source,
      event_type,
      config_value,
      metadata
    )
    VALUES (
      ${params.inventoryId || null},
      ${params.ownerTelegramId || null},
      ${params.productId || null},
      ${params.panelId || null},
      ${params.panelType || null},
      ${params.panelUserKey || null},
      ${params.uuid || null},
      ${params.source || "inventory"},
      ${params.eventType},
      ${params.configValue || null},
      ${JSON.stringify(params.metadata || {})}::jsonb
    );
  `;
}
async function recordInventoryForensicEvent(inventoryId, eventType, metadata) {
    const rows = await sql `
    SELECT id, product_id, panel_id, owner_telegram_id, config_value, delivery_payload
    FROM inventory
    WHERE id = ${inventoryId}
    LIMIT 1;
  `;
    if (!rows.length)
        return null;
    const row = rows[0];
    const delivery = parseDeliveryPayload(row.delivery_payload);
    const panelType = delivery.metadata?.panelType ? String(delivery.metadata.panelType) : null;
    const panelUserKey = String(delivery.metadata?.username || delivery.metadata?.email || delivery.metadata?.subId || "").trim() || null;
    const uuid = String(delivery.metadata?.uuid || "").trim() ||
        extractUuidFromText(String(row.config_value || "")) ||
        extractUuidFromText((delivery.configLinks || []).join("\n")) ||
        null;
    await recordForensicEvent({
        inventoryId: Number(row.id),
        ownerTelegramId: Number(row.owner_telegram_id || 0) || null,
        productId: Number(row.product_id || 0) || null,
        panelId: Number(row.panel_id || 0) || null,
        panelType,
        panelUserKey,
        uuid,
        eventType,
        configValue: String(row.config_value || ""),
        metadata: {
            ...(metadata || {}),
            deliveryMetadata: delivery.metadata || {}
        }
    });
}
function buildQrText(primaryText, configLinks, subscriptionUrl) {
    if (primaryText && primaryText.trim())
        return primaryText.trim();
    if (configLinks.length)
        return configLinks[0];
    if (subscriptionUrl)
        return subscriptionUrl;
    return "";
}
function buildPanelTemplateContext(params) {
    return {
        purchase_id: params.purchaseId,
        telegram_id: String(params.telegramId),
        product_id: String(params.productId),
        product_name: params.productName,
        size_mb: String(params.sizeMb),
        username: params.username,
        email: params.email,
        uuid: params.uuid || "",
        password: params.password || "",
        sub_id: params.subId || "",
        data_limit_bytes: String(params.dataLimitBytes),
        expiry_time: String(params.expiryTime)
    };
}
function parseSanaeiNested(raw) {
    if (typeof raw === "string") {
        return parseJsonValue(raw);
    }
    return raw;
}
function resolveSanaeiSubscriptionPublicPort(panelConfig, panelRow) {
    const fromRow = panelRow ? parseMaybeNumber(panelRow.subscription_public_port) : null;
    if (fromRow !== null && fromRow > 0 && fromRow <= 65535)
        return fromRow;
    const fromConfig = parseMaybeNumber(panelConfig.subscription_public_port ?? panelConfig.sub_link_port);
    if (fromConfig !== null && fromConfig > 0 && fromConfig <= 65535)
        return fromConfig;
    return null;
}
/** Hostname for public subscription URL or for @host in vless/vmess links (panel-level override). */
function sanitizeSubscriptionPublicHostInput(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    let candidate = trimmed;
    if (/^https?:\/\//i.test(candidate)) {
        try {
            return new URL(candidate).hostname || null;
        }
        catch {
            return null;
        }
    }
    candidate = candidate.split("/")[0].trim();
    if (candidate.includes(":") && !candidate.startsWith("[")) {
        candidate = candidate.split(":")[0].trim();
    }
    if (!candidate)
        return null;
    try {
        return new URL(`https://${candidate}`).hostname || null;
    }
    catch {
        return null;
    }
}
function resolveSanaeiSubscriptionLinkProtocol(panelRow) {
    if (!panelRow)
        return null;
    const p = String(panelRow.subscription_link_protocol || "").trim().toLowerCase();
    return p === "http" || p === "https" ? p : null;
}
/** Merge panel row `config_public_host` into product panel_config so buildSanaeiConfigLinks uses it as server_host. */
export function mergeSanaeiPanelRowIntoClientConfig(panelConfig, panelRow) {
    if (!panelRow)
        return panelConfig;
    const host = sanitizeSubscriptionPublicHostInput(String(panelRow.config_public_host || ""));
    if (!host)
        return panelConfig;
    return { ...panelConfig, server_host: host };
}
/** Subscription URL for 3x-ui; optional panel row supplies subscription_public_port when it differs from panel UI port. */
export function buildSanaeiSubscriptionUrl(baseUrl, panelConfig, subId, panelRow) {
    const customPath = String(panelConfig.subscription_path || panelConfig.sub_path || "sub").replace(/^\/+|\/+$/g, "");
    const portOverride = resolveSanaeiSubscriptionPublicPort(panelConfig, panelRow);
    const hostOverride = panelRow ? sanitizeSubscriptionPublicHostInput(String(panelRow.subscription_public_host || "")) : null;
    const protocolOverride = resolveSanaeiSubscriptionLinkProtocol(panelRow);
    let root = normalizeBaseUrl(baseUrl);
    try {
        const u = new URL(root);
        if (portOverride !== null)
            u.port = String(portOverride);
        if (hostOverride)
            u.hostname = hostOverride;
        if (protocolOverride)
            u.protocol = `${protocolOverride}:`;
        const path = u.pathname.replace(/\/+$/, "");
        root = `${u.origin}${path === "/" ? "" : path}`;
    }
    catch {
        /* keep root */
    }
    return `${root}/${customPath}/${encodeURIComponent(subId)}`;
}
function sanaeiSubscriptionUrlsMatchSubId(storedUrl, canonicalUrl) {
    try {
        const ua = new URL(storedUrl.trim());
        const ub = new URL(canonicalUrl.trim());
        const sa = ua.pathname.split("/").filter(Boolean);
        const sb = ub.pathname.split("/").filter(Boolean);
        if (!sa.length || !sb.length)
            return false;
        return decodeURIComponent(sa[sa.length - 1] || "") === decodeURIComponent(sb[sb.length - 1] || "");
    }
    catch {
        return storedUrl.trim() === canonicalUrl.trim();
    }
}
function extractSanaeiHost(panelBaseUrl, panelConfig, inbound) {
    const explicitHost = String(panelConfig.server_host || panelConfig.host || "").trim();
    if (explicitHost)
        return explicitHost;
    const listen = String(inbound.listen || "").trim();
    if (listen && listen !== "0.0.0.0" && listen !== "::" && listen !== "127.0.0.1")
        return listen;
    return new URL(normalizeBaseUrl(panelBaseUrl)).hostname;
}
export function buildSanaeiConfigLinks(panelBaseUrl, inbound, client, panelConfig) {
    const protocol = String(inbound.protocol || "").toLowerCase();
    const stream = toJsonObject(parseSanaeiNested(inbound.streamSettings)) || {};
    const settings = toJsonObject(parseSanaeiNested(inbound.settings)) || {};
    const network = String(stream.network || "tcp");
    const security = String(stream.security || "none");
    const host = extractSanaeiHost(panelBaseUrl, panelConfig, inbound);
    const port = Number(inbound.port || 0);
    const remark = encodeURIComponent(String(client.email || inbound.remark || "config"));
    const query = new URLSearchParams();
    if (security === "tls" || security === "reality")
        query.set("security", security);
    if (network && network !== "tcp")
        query.set("type", network);
    const tlsSettings = toJsonObject(stream.tlsSettings) || {};
    const realitySettings = toJsonObject(stream.realitySettings) || {};
    const wsSettings = toJsonObject(stream.wsSettings) || {};
    const grpcSettings = toJsonObject(stream.grpcSettings) || {};
    const httpSettings = toJsonObject(stream.httpSettings) || {};
    const tcpSettings = toJsonObject(stream.tcpSettings) || {};
    const kcpSettings = toJsonObject(stream.kcpSettings) || {};
    const splitHttpSettings = toJsonObject(stream.splitHTTPSettings || stream.splithttpSettings) || {};
    const httpUpgradeSettings = toJsonObject(stream.httpupgradeSettings || stream.httpUpgradeSettings) || {};
    const sni = String(panelConfig.sni || tlsSettings.serverName || realitySettings.serverName || "");
    if (sni)
        query.set("sni", sni);
    const fingerprint = String(panelConfig.fp || panelConfig.fingerprint || tlsSettings.fingerprint || realitySettings.fingerprint || "");
    if (fingerprint)
        query.set("fp", fingerprint);
    const alpn = Array.isArray(tlsSettings.alpn) ? tlsSettings.alpn.join(",") : String(tlsSettings.alpn || "");
    if (alpn)
        query.set("alpn", alpn);
    if (security === "reality") {
        const publicKey = String(panelConfig.pbk || realitySettings.publicKey || "");
        const shortId = String(panelConfig.sid || realitySettings.shortId || "");
        const spiderX = String(panelConfig.spx || realitySettings.spiderX || "");
        if (publicKey)
            query.set("pbk", publicKey);
        if (shortId)
            query.set("sid", shortId);
        if (spiderX)
            query.set("spx", spiderX);
    }
    const wsPath = String(panelConfig.path || wsSettings.path || httpUpgradeSettings.path || splitHttpSettings.path || "");
    const wsHost = String(panelConfig.host_header || toJsonObject(wsSettings.headers)?.Host || "");
    const serviceName = String(panelConfig.service_name || grpcSettings.serviceName || "");
    if (wsPath)
        query.set(network === "grpc" ? "serviceName" : "path", wsPath || serviceName);
    if (serviceName && network === "grpc")
        query.set("serviceName", serviceName);
    if (wsHost && (network === "ws" || network === "httpupgrade"))
        query.set("host", wsHost);
    if (network === "http") {
        const hosts = Array.isArray(httpSettings.host) ? httpSettings.host : [];
        if (hosts[0])
            query.set("host", String(hosts[0]));
        if (httpSettings.path)
            query.set("path", String(httpSettings.path));
    }
    if (network === "tcp") {
        const headerType = String(toJsonObject(tcpSettings.header)?.type || "");
        if (headerType)
            query.set("headerType", headerType);
    }
    if (network === "kcp") {
        const headerType = String(kcpSettings.headerType || "");
        if (headerType)
            query.set("headerType", headerType);
        const seed = String(kcpSettings.seed || "");
        if (seed)
            query.set("seed", seed);
    }
    const links = [];
    if (protocol === "vless") {
        query.set("encryption", "none");
        const flow = String(client.flow || panelConfig.flow || "");
        if (flow)
            query.set("flow", flow);
        links.push(`vless://${client.id}@${host}:${port}?${query.toString()}#${remark}`);
    }
    if (protocol === "vmess") {
        const vmess = {
            v: "2",
            ps: decodeURIComponent(remark),
            add: host,
            port: String(port),
            id: String(client.id || ""),
            aid: String(client.alterId || 0),
            scy: String(client.security || "auto"),
            net: network,
            type: String(toJsonObject(tcpSettings.header)?.type || "none"),
            host: query.get("host") || "",
            path: query.get("path") || "",
            tls: security === "none" ? "" : security,
            sni: query.get("sni") || "",
            alpn: query.get("alpn") || "",
            fp: query.get("fp") || ""
        };
        links.push(`vmess://${Buffer.from(JSON.stringify(vmess), "utf8").toString("base64")}`);
    }
    if (protocol === "trojan") {
        links.push(`trojan://${client.password}@${host}:${port}?${query.toString()}#${remark}`);
    }
    if (protocol === "shadowsocks") {
        const method = String(client.method || settings.method || panelConfig.method || "aes-128-gcm");
        const credentials = Buffer.from(`${method}:${client.password}`, "utf8").toString("base64");
        links.push(`ss://${credentials}@${host}:${port}#${remark}`);
    }
    return links.filter(Boolean);
}
/** Bracket IPv6 for vless/trojan/ss authority section. */
function formatHostForShareUri(hostname) {
    const h = hostname.trim();
    if (!h)
        return h;
    if (h.includes(":") && !h.startsWith("["))
        return `[${h}]`;
    return h;
}
/** Rewrite outbound host in a share link (vless / trojan / vmess / ss) without panel API. */
function replaceShareLinkOutboundHost(link, newHost) {
    const nh = formatHostForShareUri(newHost);
    if (!nh)
        return link;
    const s = link.trim();
    if (s.startsWith("vless://") || s.startsWith("trojan://")) {
        const scheme = s.startsWith("vless://") ? "vless://" : "trojan://";
        const rest = s.slice(scheme.length);
        const at = rest.indexOf("@");
        if (at < 0)
            return link;
        const cred = rest.slice(0, at);
        const tail = rest.slice(at + 1);
        let port = "";
        let suffix = "";
        if (tail.startsWith("[")) {
            const bi = tail.indexOf("]");
            if (bi < 0)
                return link;
            const after = tail.slice(bi + 1);
            const pm = after.match(/^(:[0-9]+)?(\?[^#]*)?(#.*)?$/);
            port = pm?.[1] || "";
            suffix = `${pm?.[2] || ""}${pm?.[3] || ""}`;
        }
        else {
            const m = tail.match(/^([^:\\/?#]+)(:\\d+)?(\\?[^#]*)?(#.*)?$/);
            if (!m)
                return link;
            port = m[2] || "";
            suffix = `${m[3] || ""}${m[4] || ""}`;
        }
        return `${scheme}${cred}@${nh}${port}${suffix}`;
    }
    if (s.startsWith("vmess://")) {
        try {
            const buf = Buffer.from(s.slice(8), "base64");
            const j = JSON.parse(buf.toString("utf8"));
            if (j && typeof j === "object") {
                j.add = newHost;
                return `vmess://${Buffer.from(JSON.stringify(j), "utf8").toString("base64")}`;
            }
        }
        catch {
            return link;
        }
    }
    if (s.startsWith("ss://")) {
        const body = s.slice(5);
        const at = body.lastIndexOf("@");
        if (at < 0)
            return link;
        const cred = body.slice(0, at);
        const tail = body.slice(at + 1);
        const m = tail.match(/^([^:\/?#]+)(:\d+)?(\?[^#]*)?(#.*)?$/);
        if (!m)
            return link;
        return `ss://${cred}@${nh}${m[2] || ""}${m[3] || ""}${m[4] || ""}`;
    }
    return link;
}
/** Recompute subscription + direct links from stored delivery + current panel row (list / labels). */
function applyLiveSanaeiPanelOverridesToDeliveryPayload(payload, panelRow, productPanelConfig) {
    const baseUrl = String(panelRow.base_url || "");
    const merged = mergeSanaeiPanelRowIntoClientConfig(sanitizePanelConfig(productPanelConfig), panelRow);
    const host = extractSanaeiHost(baseUrl, merged, {});
    const subId = String(payload.metadata?.subId || "").trim();
    const subscriptionUrl = subId ? buildSanaeiSubscriptionUrl(baseUrl, merged, subId, panelRow) : payload.subscriptionUrl;
    const configLinks = (payload.configLinks || []).map((l) => replaceShareLinkOutboundHost(l, host));
    return {
        outboundHost: host,
        payload: {
            ...payload,
            subscriptionUrl: subscriptionUrl || payload.subscriptionUrl,
            configLinks,
            primaryQr: buildQrText(payload.primaryText, configLinks, subscriptionUrl || payload.subscriptionUrl),
            primaryText: payload.primaryText
        }
    };
}
async function provisionMarzbanSale(panel, order, panelConfig, overridePanelType) {
    const login = await loginMarzbanPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !login.token) {
        throw new Error(`Marzban auth failed: ${login.res.status} ${responseSnippet(login.raw)}`);
    }
    const days = parseMaybeNumber(panelConfig.expire_days || panelConfig.days) || 0;
    const expireTime = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : 0;
    const dataLimitBytes = Math.max(0, Math.round((parseMaybeNumber(panelConfig.data_limit_mb) || Number(order.size_mb || 0)) * 1024 * 1024));
    // Use order's config_name if provided, otherwise generate with prefix + telegram_id + timestamp
    const configNameFromOrder = String(order.config_name || "").trim();
    let marzUsername = configNameFromOrder
        ? configNameFromOrder.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32)
        : String(panelConfig.username_prefix || "tg")
            .concat(`${order.telegram_id}_${Date.now()}`)
            .replace(/[^a-zA-Z0-9_]/g, "_")
            .slice(0, 32);
    // PasarGuard uses a completely different API from Marzban:
    //   - User creation uses `proxy_settings` (not `proxies`) and `group_ids` (not `inbounds`)
    //   - Groups are fetched from GET /api/groups and assigned by ID
    // Marzban uses `proxies: {protocol: {}}` + `inbounds: {protocol: [tags]}`
    const actualPanelType = overridePanelType || String(panel.panel_type || "marzban");
    const isPasarGuard = actualPanelType === "pasarguard";
    const protocol = String(panelConfig.protocol || "vless").toLowerCase();
    // PasarGuard: fetch all active groups and collect their IDs
    // Marzban: resolve inbounds (auto-fetch if not explicitly configured in panelConfig)
    let resolvedInbounds = {};
    let pasarguardGroupIds = [];
    if (isPasarGuard) {
        // PasarGuard: groups define the user's proxy access ΓÇö must assign at least one
        const configuredGroupIds = Array.isArray(panelConfig.group_ids) ? panelConfig.group_ids.map(Number).filter(Boolean) : [];
        if (configuredGroupIds.length > 0) {
            pasarguardGroupIds = configuredGroupIds;
        }
        else {
            // Auto-fetch all non-disabled groups and assign all of them
            const fetchedGroups = await getPasarguardGroups(String(panel.base_url), login.token);
            pasarguardGroupIds = fetchedGroups.map((g) => g.id);
            logInfo("pasarguard_provision_groups", {
                panelId: panel.id,
                panelUrl: panel.base_url,
                fetchedCount: fetchedGroups.length,
                groupIds: pasarguardGroupIds,
                groups: fetchedGroups
            });
        }
        if (pasarguardGroupIds.length === 0) {
            throw new Error("PasarGuard: no groups found on panel. Create at least one group before provisioning users.\n" +
                `Panel: ${panel.name} (${panel.base_url})\n` +
                "Check logs for API response details.");
        }
    }
    else {
        // Marzban: use configured inbounds or auto-fetch from /api/inbounds
        const configuredInbounds = toJsonObject(panelConfig.inbounds);
        if (configuredInbounds && Object.keys(configuredInbounds).length > 0) {
            for (const [proto, tags] of Object.entries(configuredInbounds)) {
                if (Array.isArray(tags))
                    resolvedInbounds[proto] = tags.map(String);
            }
        }
        else {
            const panelInbounds = await getMarzbanInbounds(String(panel.base_url), login.token);
            if (Object.keys(panelInbounds).length > 0) {
                if (panelInbounds[protocol] && panelInbounds[protocol].length > 0) {
                    resolvedInbounds = { [protocol]: panelInbounds[protocol] };
                }
                else {
                    resolvedInbounds = panelInbounds;
                }
            }
        }
    }
    // Retry loop: on "duplicate username" the panel rejects ΓÇö generate a fresh suffix and retry
    let marzRaw = "";
    let marzData = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
            const retryRnd = Math.floor(Math.random() * 90000) + 10000;
            const base = (configNameFromOrder || String(panelConfig.username_prefix || "tg").concat(`${order.telegram_id}`))
                .replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 26);
            marzUsername = `${base}_${retryRnd}`.slice(0, 32);
        }
        const ctx = buildPanelTemplateContext({
            purchaseId: String(order.purchase_id),
            telegramId: Number(order.telegram_id),
            productId: Number(order.product_id),
            productName: String(order.product_name || ""),
            sizeMb: Number(order.size_mb || 0),
            username: marzUsername,
            email: marzUsername,
            dataLimitBytes,
            expiryTime: expireTime
        });
        // Build the create-user payload based on panel type
        const marzDefaults = isPasarGuard
            ? {
                // PasarGuard API: proxy_settings + group_ids
                username: marzUsername,
                proxy_settings: {},
                group_ids: pasarguardGroupIds,
                expire: expireTime ? Math.floor(expireTime / 1000) : 0,
                data_limit: dataLimitBytes,
                data_limit_reset_strategy: String(panelConfig.data_limit_reset_strategy || "no_reset"),
                status: String(panelConfig.status || "active"),
                note: `order:${order.purchase_id}|telegram:${order.telegram_id}|product:${order.product_id}`
            }
            : {
                // Marzban API: proxies + inbounds
                username: marzUsername,
                proxies: { [protocol]: {} },
                inbounds: resolvedInbounds,
                expire: expireTime ? Math.floor(expireTime / 1000) : 0,
                data_limit: dataLimitBytes,
                data_limit_reset_strategy: String(panelConfig.data_limit_reset_strategy || "no_reset"),
                status: String(panelConfig.status || "active"),
                note: `order:${order.purchase_id}|telegram:${order.telegram_id}|product:${order.product_id}`
            };
        const marzMerged = applyTemplate(mergeDeep(marzDefaults, panelConfig.override || panelConfig.user || {}), ctx);
        const marzRes = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/api/user`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${login.token}`,
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify(marzMerged)
        });
        marzRaw = await marzRes.text();
        marzData = parseJsonObject(marzRaw);
        if (marzRes.ok && marzData)
            break;
        const isDup = marzRaw.toLowerCase().includes("duplicate") || marzRaw.toLowerCase().includes("already exist");
        if (!isDup)
            throw new Error(`Marzban create user failed: ${marzRes.status} ${responseSnippet(marzRaw)}`);
        // Duplicate username ΓÇö fall through to next attempt with new suffix
    }
    if (!marzData)
        throw new Error(`Marzban create user failed after retries: ${responseSnippet(marzRaw)}`);
    const data = marzData;
    const links = Array.isArray(data.links) ? data.links.map((item) => String(item || "").trim()).filter(Boolean) : [];
    // Handle relative subscription URLs returned by PasarGuard/Marzban (e.g. "/sub/token" ΓåÆ full URL)
    let subscriptionUrl = null;
    if (data.subscription_url) {
        const rawSub = String(data.subscription_url).trim();
        if (rawSub.startsWith("/")) {
            subscriptionUrl = normalizeBaseUrl(String(panel.base_url)) + rawSub;
        }
        else {
            subscriptionUrl = rawSub;
        }
    }
    const uuid = extractUuidFromText([String(links[0] || ""), String(subscriptionUrl || "")].filter(Boolean).join("\n"));
    const deliveryMode = String(order.panel_delivery_mode || "both");
    const finalLinks = deliveryMode === "sub" ? [] : links;
    const finalSub = deliveryMode === "configs" ? null : subscriptionUrl;
    return {
        configValue: finalLinks[0] || finalSub || marzUsername,
        deliveryPayload: {
            subscriptionUrl: finalSub,
            configLinks: finalLinks,
            primaryQr: buildQrText(finalLinks[0] || null, finalLinks, finalSub),
            primaryText: finalLinks[0] || finalSub || marzUsername,
            metadata: {
                panelType: overridePanelType || String(panel.panel_type || "marzban"),
                username: marzUsername,
                uuid,
                apiResponse: data
            }
        }
    };
}
async function provisionSanaeiSale(panel, order, panelConfig) {
    const login = await loginSanaeiPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !jsonSuccess(login.data) || !login.cookie) {
        throw new Error(`Sanaei auth failed: ${login.res.status} ${responseSnippet(login.raw)}`);
    }
    const inboundId = parseMaybeNumber(panelConfig.inbound_id || panelConfig.inboundId);
    if (!inboundId) {
        throw new Error("╪¿╪▒╪º█î ┘ü╪▒┘ê╪┤ ╪º╪▓ 3x-ui ╪¿╪º█î╪» inbound_id ╪»╪▒ ╪¬┘å╪╕█î┘à╪º╪¬ ┘à╪¡╪╡┘ê┘ä ╪½╪¿╪¬ ╪┤┘ê╪».");
    }
    const inbounds = await getSanaeiInbounds(String(panel.base_url), login.cookie);
    if (!inbounds.res.ok || !jsonSuccess(inbounds.data)) {
        throw new Error(`Sanaei list inbounds failed: ${inbounds.res.status} ${responseSnippet(inbounds.raw)}`);
    }
    const inbound = inbounds.items.find((item) => Number(item.id || 0) === inboundId);
    if (!inbound) {
        throw new Error(`inbound #${inboundId} ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪».`);
    }
    const protocol = String(inbound.protocol || "").toLowerCase();
    const sizeMbOverride = parseMaybeNumber(panelConfig.data_limit_mb) || Number(order.size_mb || 0);
    const dataLimitBytes = Math.max(0, Math.round(sizeMbOverride * 1024 * 1024));
    const days = parseMaybeNumber(panelConfig.expire_days || panelConfig.days) || 0;
    const expiryTime = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : 0;
    const clientId = randomUUID();
    const clientPassword = randomUUID().replaceAll("-", "");
    const subId = randomCode(16).toLowerCase();
    // Use order's config_name if provided, otherwise generate with prefix + telegram_id + timestamp
    const configNameFromOrder = String(order.config_name || "").trim();
    let sanaeiEmail = configNameFromOrder
        ? configNameFromOrder.replace(/[^\w@.\-]/g, "_").slice(0, 64)
        : String(panelConfig.email_prefix || "tg")
            .concat(`${order.telegram_id}_${Date.now()}`)
            .replace(/[^\w@.\-]/g, "_")
            .slice(0, 64);
    let sanaeiSubId = subId;
    let sanaeiClient = {};
    let sanaeiRaw = "";
    let sanaeiOk = false;
    // Retry loop: on "Duplicate email" the panel rejects ΓÇö regenerate email + subId and retry
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
            const retryRnd = Math.floor(Math.random() * 90000) + 10000;
            const base = configNameFromOrder
                ? configNameFromOrder.replace(/[^\w@.\-]/g, "_").slice(0, 58)
                : String(panelConfig.email_prefix || "tg").concat(`${order.telegram_id}`).replace(/[^\w@.\-]/g, "_").slice(0, 58);
            sanaeiEmail = `${base}_${retryRnd}`.slice(0, 64);
            sanaeiSubId = randomCode(16).toLowerCase();
        }
        const sanaeiCtx = buildPanelTemplateContext({
            purchaseId: String(order.purchase_id),
            telegramId: Number(order.telegram_id),
            productId: Number(order.product_id),
            productName: String(order.product_name || ""),
            sizeMb: Number(order.size_mb || 0),
            username: sanaeiEmail,
            email: sanaeiEmail,
            uuid: clientId,
            password: clientPassword,
            subId: sanaeiSubId,
            dataLimitBytes,
            expiryTime
        });
        const sanaeiDefaultClient = {
            email: sanaeiEmail,
            enable: parseMaybeBoolean(panelConfig.enable) ?? true,
            tgId: String(order.telegram_id),
            subId: sanaeiSubId,
            limitIp: parseMaybeNumber(panelConfig.limit_ip || panelConfig.limitIp) || 0,
            totalGB: dataLimitBytes,
            expiryTime
        };
        if (protocol === "vless" || protocol === "vmess")
            sanaeiDefaultClient.id = clientId;
        if (protocol === "trojan")
            sanaeiDefaultClient.password = clientPassword;
        if (protocol === "shadowsocks") {
            sanaeiDefaultClient.password = clientPassword;
            sanaeiDefaultClient.method = String(panelConfig.method || "aes-128-gcm");
        }
        if (protocol === "vless") {
            const flow = String(panelConfig.flow || "");
            if (flow)
                sanaeiDefaultClient.flow = flow;
        }
        sanaeiClient = applyTemplate(mergeDeep(sanaeiDefaultClient, panelConfig.client || panelConfig.override || {}), sanaeiCtx);
        const sanaeiRes = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/panel/api/inbounds/addClient`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Cookie: login.cookie,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                id: inboundId,
                settings: JSON.stringify({ clients: [sanaeiClient] })
            })
        });
        sanaeiRaw = await sanaeiRes.text();
        sanaeiOk = sanaeiRes.ok && (!sanaeiRaw.trim() || jsonSuccess(parseJsonObject(sanaeiRaw)));
        if (sanaeiOk)
            break;
        const isDup = sanaeiRaw.toLowerCase().includes("duplicate") || sanaeiRaw.toLowerCase().includes("already exist");
        if (!isDup)
            throw new Error(`Sanaei create client failed: ${sanaeiRes.status} ${responseSnippet(sanaeiRaw)}`);
        // Duplicate email ΓÇö fall through to next attempt with new suffix
    }
    if (!sanaeiOk)
        throw new Error(`Sanaei create client failed after retries: ${responseSnippet(sanaeiRaw)}`);
    const mergedClientCfg = mergeSanaeiPanelRowIntoClientConfig(panelConfig, panel);
    const configLinks = buildSanaeiConfigLinks(String(panel.base_url), inbound, toJsonObject(sanaeiClient) || {}, mergedClientCfg);
    const subscriptionUrl = buildSanaeiSubscriptionUrl(String(panel.base_url), panelConfig, sanaeiSubId, panel);
    const deliveryMode = String(order.panel_delivery_mode || "both");
    const finalLinks = deliveryMode === "sub" ? [] : configLinks;
    const finalSub = deliveryMode === "configs" ? null : subscriptionUrl;
    return {
        configValue: finalLinks[0] || finalSub || sanaeiEmail,
        deliveryPayload: {
            subscriptionUrl: finalSub,
            configLinks: finalLinks,
            primaryQr: buildQrText(finalLinks[0] || null, finalLinks, finalSub),
            primaryText: finalLinks[0] || finalSub || sanaeiEmail,
            metadata: {
                panelType: "sanaei",
                inboundId,
                protocol,
                email: sanaeiEmail,
                subId: sanaeiSubId,
                uuid: clientId
            }
        }
    };
}
async function testPanelConnection(panelId) {
    const rows = await sql `
    SELECT id, panel_type, base_url, username, password
    FROM panels
    WHERE id = ${panelId}
    LIMIT 1;
  `;
    if (!rows.length)
        return { ok: false, message: "┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." };
    const panel = rows[0];
    const panelType = String(panel.panel_type);
    const baseUrl = normalizeBaseUrl(String(panel.base_url));
    const username = String(panel.username || "");
    const password = String(panel.password || "");
    const startedAt = Date.now();
    try {
        if (!username || !password) {
            const detail = "┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î █î╪º ╪▒┘à╪▓ ╪╣╪¿┘ê╪▒ ┘╛┘å┘ä ┘ê╪º╪▒╪» ┘å╪┤╪»┘ç ╪º╪│╪¬.";
            await updatePanelCheckState(panelId, false, detail, {
                last_error: detail,
                last_check_ms: Date.now() - startedAt
            }, null);
            logInfo("panel_test_failed", { panelId, panelType, detail });
            return { ok: false, message: `╪º╪¬╪╡╪º┘ä ┘╛┘å┘ä ┘å╪º┘à┘ê┘ü┘é ╪¿┘ê╪».\n${detail}` };
        }
        if (isMarzbanLike(panelType)) {
            const login = await loginMarzbanPanel({
                base_url: String(panel.base_url),
                username: String(panel.username || ""),
                password: String(panel.password || "")
            });
            if (!login.res.ok || !login.token) {
                const label = panelTypeTitle(panelType);
                const detail = `${label} status ${login.res.status} | ${responseSnippet(login.raw)}`;
                await updatePanelCheckState(panelId, false, detail, {
                    last_error: detail,
                    last_status: login.res.status,
                    last_check_ms: Date.now() - startedAt
                }, null);
                return { ok: false, message: `╪º╪¬╪╡╪º┘ä ${label} ┘å╪º┘à┘ê┘ü┘é ╪¿┘ê╪».\n${detail}` };
            }
            // Fetch and cache available inbounds (Marzban) or groups (PasarGuard)
            // so admins can see what's available and provisioning can auto-select them.
            let checkMeta;
            if (panelType === "pasarguard") {
                const groups = await getPasarguardGroups(String(panel.base_url), login.token);
                checkMeta = {
                    last_status: login.res.status,
                    last_check_ms: Date.now() - startedAt,
                    api: panelType,
                    group_count: groups.length,
                    groups: groups.map((g) => ({ id: g.id, name: g.name, inbound_tags: g.inbound_tags }))
                };
            }
            else {
                const marzInbounds = await getMarzbanInbounds(String(panel.base_url), login.token);
                const inboundSummary = [];
                for (const [proto, tags] of Object.entries(marzInbounds)) {
                    for (const tag of tags)
                        inboundSummary.push({ protocol: proto, tag });
                }
                checkMeta = {
                    last_status: login.res.status,
                    last_check_ms: Date.now() - startedAt,
                    api: panelType,
                    inbound_count: inboundSummary.length,
                    inbounds: inboundSummary
                };
            }
            await updatePanelCheckState(panelId, true, "ok", checkMeta, login.token);
            return { ok: true, message: `╪º╪¬╪╡╪º┘ä ${panelTypeTitle(panelType)} ┘à┘ê┘ü┘é ╪¿┘ê╪» Γ£à` };
        }
        const login = await loginSanaeiPanel({
            base_url: String(panel.base_url),
            username: String(panel.username || ""),
            password: String(panel.password || "")
        });
        if (!login.res.ok || !jsonSuccess(login.data) || !login.cookie) {
            const detail = `Sanaei login status ${login.res.status} | ${responseSnippet(login.raw)}`;
            await updatePanelCheckState(panelId, false, detail, {
                last_error: detail,
                login_status: login.res.status,
                last_check_ms: Date.now() - startedAt
            }, null);
            return { ok: false, message: `┘ê╪▒┘ê╪» ╪¿┘ç ┘╛┘å┘ä Sanaei ┘å╪º┘à┘ê┘ü┘é ╪¿┘ê╪».\n${detail}` };
        }
        const inbounds = await getSanaeiInbounds(baseUrl, login.cookie);
        if (!inbounds.res.ok || !jsonSuccess(inbounds.data)) {
            const detail = `Sanaei status ${inbounds.res.status} | ${responseSnippet(inbounds.raw)}`;
            await updatePanelCheckState(panelId, false, detail, {
                last_error: detail,
                login_status: login.res.status,
                last_status: inbounds.res.status,
                last_check_ms: Date.now() - startedAt
            }, null);
            return { ok: false, message: `╪º╪¬╪╡╪º┘ä Sanaei ┘å╪º┘à┘ê┘ü┘é ╪¿┘ê╪».\n${detail}` };
        }
        await updatePanelCheckState(panelId, true, "ok", {
            login_status: login.res.status,
            last_status: inbounds.res.status,
            inbound_count: inbounds.items.length,
            inbounds: inbounds.items.map((item) => ({
                id: item.id,
                remark: item.remark,
                protocol: item.protocol,
                port: item.port
            })),
            last_check_ms: Date.now() - startedAt
        }, null);
        return { ok: true, message: "╪º╪¬╪╡╪º┘ä Sanaei ┘à┘ê┘ü┘é ╪¿┘ê╪» Γ£à" };
    }
    catch (error) {
        const message = String(error.message || error);
        await updatePanelCheckState(panelId, false, message, {
            last_error: message,
            last_check_ms: Date.now() - startedAt
        }, null);
        logError("panel_test_exception", error, { panelId, baseUrl, panelType });
        return { ok: false, message: `╪«╪╖╪º ╪»╪▒ ╪º╪¬╪╡╪º┘ä ╪¿┘ç ┘╛┘å┘ä.\n${message}` };
    }
}
async function showCustomerMigrationTargets(chatId, inventoryId, userId) {
    const ownRows = await sql `
    SELECT id, status, migrated_to_inventory_id FROM inventory
    WHERE id = ${inventoryId}
      AND owner_telegram_id = ${userId}
    LIMIT 1;
  `;
    if (!ownRows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¿╪▒╪º█î ╪┤┘à╪º ┘å█î╪│╪¬ █î╪º █î╪º┘ü╪¬ ┘å╪┤╪»." });
        return null;
    }
    const inv = ownRows[0];
    if (String(inv.status) === "migrated" || inv.migrated_to_inventory_id) {
        const newId = inv.migrated_to_inventory_id ? Number(inv.migrated_to_inventory_id) : null;
        await tg("sendMessage", {
            chat_id: chatId,
            text: `ΓÜí ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘é╪¿┘ä╪º┘ï ╪¿┘ç ┘╛┘å┘ä ╪¼╪»█î╪» ┘à┘å╪¬┘é┘ä ╪┤╪»┘ç ╪º╪│╪¬.\n${newId ? `┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪┤┘à╪º ╪»╪▒ ┘ä█î╪│╪¬ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º ┘à┘ê╪¼┘ê╪» ╪º╪│╪¬ (╪┤┘å╪º╪│┘ç: ${newId}).` : "┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪▒╪º ╪º╪▓ ┘ä█î╪│╪¬ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î╪¬╪º┘å ╪¿╪º╪▓ ┌⌐┘å█î╪»."}`
        });
        return null;
    }
    if (String(inv.status) !== "sold") {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ┘ê╪╢╪╣█î╪¬ ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
        return null;
    }
    // Rate-limit: max 3 customer-initiated migrations per 24 hours per user
    const recentMigrations = await sql `
    SELECT COUNT(*)::int AS cnt
    FROM panel_migrations
    WHERE requested_for = ${userId}
      AND requested_by_role = 'customer'
      AND created_at > NOW() - INTERVAL '24 hours';
  `;
    if (Number(recentMigrations[0]?.cnt ?? 0) >= 100) {
        await tg("sendMessage", { chat_id: chatId, text: "╪│┘é┘ü ┘à┘ç╪º╪¼╪▒╪¬ ╪▒┘ê╪▓╪º┘å┘ç (█î╪╣┘å█î 10 ╪¿╪º╪▒) ┘╛╪▒ ╪┤╪»┘ç ╪º╪│╪¬. █▓█┤ ╪│╪º╪╣╪¬ ╪»█î┌»╪▒ ╪º┘à╪¬╪¡╪º┘å ┌⌐┘å█î╪»." });
        return null;
    }
    const rows = await sql `
    SELECT id, name, panel_type
    FROM panels
    WHERE active = TRUE AND allow_customer_migration = TRUE
    ORDER BY priority DESC, id ASC;
  `;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ü╪╣┘ä╪º┘ï ┘à┘é╪╡╪» ┘ü╪╣╪º┘ä█î ╪¿╪▒╪º█î ┘à┘ç╪º╪¼╪▒╪¬ ╪ó╪▓╪º╪» ┘å╪┤╪»┘ç ╪º╪│╪¬." });
        return null;
    }
    const keyboard = rows.map((p) => [
        { text: `${p.name} (${String(p.panel_type).toUpperCase()})`, callback_data: `migrate_pick_${inventoryId}_${p.id}` }
    ]);
    keyboard.push([homeButton()]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "┘╛┘å┘ä ┘à┘é╪╡╪» ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:\n╪º┘å╪¬┘é╪º┘ä ╪¿╪▒╪º█î ╪┤┘à╪º ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ┘ü┘ê╪▒█î ╪º┘å╪¼╪º┘à ┘à█îΓÇî╪┤┘ê╪» Γ£à",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function createMigrationRequest(chatId, requestedBy, requestedFor, sourceInventoryId, targetPanelId, role) {
    const sourceRows = await sql `
    SELECT i.id, i.config_value, i.panel_id, i.migration_parent_inventory_id, i.migrated_to_inventory_id
    FROM inventory i
    WHERE i.id = ${sourceInventoryId}
      AND i.owner_telegram_id = ${requestedFor}
      AND i.status = 'sold'
      AND i.migrated_to_inventory_id IS NULL
    LIMIT 1;
  `;
    if (!sourceRows.length) {
        // Give a specific message based on what state the config is actually in
        const stateRow = await sql `
      SELECT id, status, migrated_to_inventory_id FROM inventory
      WHERE id = ${sourceInventoryId} AND owner_telegram_id = ${requestedFor}
      LIMIT 1;
    `;
        let msg = "ΓÜá∩╕Å ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¿╪▒╪º█î ╪┤┘à╪º ┘å█î╪│╪¬ █î╪º █î╪º┘ü╪¬ ┘å╪┤╪».";
        if (stateRow.length) {
            const st = String(stateRow[0].status || "");
            if (st === "migrated" || stateRow[0].migrated_to_inventory_id) {
                msg = "ΓÜí ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘é╪¿┘ä╪º┘ï ╪¿┘ç ┘╛┘å┘ä ╪¼╪»█î╪» ┘à┘å╪¬┘é┘ä ╪┤╪»┘ç ┘ê ╪»█î┌»╪▒ ┘é╪º╪¿┘ä ╪º┘å╪¬┘é╪º┘ä ┘à╪¼╪»╪» ┘å█î╪│╪¬.";
            }
            else if (st !== "sold") {
                msg = `ΓÜá∩╕Å ┘ê╪╢╪╣█î╪¬ ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┬½${st}┬╗ ╪º╪│╪¬ ┘ê ┘é╪º╪¿┘ä ╪º┘å╪¬┘é╪º┘ä ┘å█î╪│╪¬.`;
            }
        }
        await tg("sendMessage", { chat_id: chatId, text: msg });
        return false;
    }
    const targetRows = await sql `
    SELECT id, name, active, allow_customer_migration
    FROM panels
    WHERE id = ${targetPanelId}
    LIMIT 1;
  `;
    if (!targetRows.length || !targetRows[0].active) {
        await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à┘é╪╡╪» ┘ü╪╣╪º┘ä ┘å█î╪│╪¬." });
        return false;
    }
    if (role === "customer" && !targetRows[0].allow_customer_migration) {
        await tg("sendMessage", { chat_id: chatId, text: "╪º╪»┘à█î┘å ┘à┘ç╪º╪¼╪▒╪¬ ╪¿┘ç ╪º█î┘å ┘╛┘å┘ä ╪▒╪º ╪¿╪▒╪º█î ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪¿╪º╪▓ ┘å┌⌐╪▒╪»┘ç ╪º╪│╪¬." });
        return false;
    }
    // Rate-limit customer migrations: max 3 per 24 hours
    if (role === "customer") {
        const recentCount = await sql `
      SELECT COUNT(*)::int AS cnt
      FROM panel_migrations
      WHERE requested_for = ${requestedFor}
        AND requested_by_role = 'customer'
        AND created_at > NOW() - INTERVAL '24 hours';
    `;
        if (Number(recentCount[0]?.cnt ?? 0) >= 100) {
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘é┘ü ┘à┘ç╪º╪¼╪▒╪¬ ╪▒┘ê╪▓╪º┘å┘ç (█î╪╣┘å█î 10 ╪¿╪º╪▒) ┘╛╪▒ ╪┤╪»┘ç ╪º╪│╪¬. █▓█┤ ╪│╪º╪╣╪¬ ╪»█î┌»╪▒ ╪º┘à╪¬╪¡╪º┘å ┌⌐┘å█î╪»." });
            return false;
        }
    }
    const sourcePanelId = sourceRows[0].panel_id === null ? null : Number(sourceRows[0].panel_id);
    if (sourcePanelId !== null && sourcePanelId === targetPanelId) {
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ╪┤┘à╪º ┘ç┘à█î┘å ╪º┘ä╪º┘å ╪▒┘ê█î ┘ç┘à█î┘å ┘╛┘å┘ä ╪º╪│╪¬." });
        return false;
    }
    const exists = await sql `
    SELECT id
    FROM panel_migrations
    WHERE source_inventory_id = ${sourceInventoryId}
      AND target_panel_id = ${targetPanelId}
      AND status IN ('pending', 'approved')
    LIMIT 1;
  `;
    if (exists.length) {
        await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪º█î┘å ┘à┘é╪╡╪» ┘é╪¿┘ä╪º┘ï ╪»╪▒╪«┘ê╪º╪│╪¬ ╪½╪¿╪¬ ╪┤╪»┘ç ╪º╪│╪¬." });
        return false;
    }
    const inserted = await sql `
    INSERT INTO panel_migrations (
      source_inventory_id,
      source_panel_id,
      target_panel_id,
      requested_by,
      requested_for,
      requested_by_role,
      source_config_snapshot
    )
    VALUES (
      ${sourceInventoryId},
      ${sourceRows[0].panel_id || null},
      ${targetPanelId},
      ${requestedBy},
      ${requestedFor},
      ${role},
      ${String(sourceRows[0].config_value)}
    )
    RETURNING id;
  `;
    if (role === "customer") {
        const result = await completeMigration(Number(inserted[0].id), requestedBy, null);
        if (!result.ok) {
            await sql `
        UPDATE panel_migrations
        SET status = 'failed', processed_at = NOW(), processed_by = ${requestedBy}
        WHERE id = ${inserted[0].id};
      `;
            // Map internal reason codes to user-facing Persian messages
            const reason = String(result.reason || "");
            const reasonMessages = {
                no_traffic_data_client_not_found: "Γ¢ö ╪º┘å╪¬┘é╪º┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n╪º╪╖┘ä╪º╪╣╪º╪¬ ┘à╪╡╪▒┘ü ┌⌐╪º┘å┘ü█î┌» ┘é╪»█î┘à█î ┘╛█î╪»╪º ┘å╪┤╪».\n┘ä╪╖┘ü╪º┘ï ╪º╪▓ ╪º╪»┘à█î┘å ╪¿╪«┘ê╪º┘ç█î╪» ╪¿┌⌐╪º┘╛ ╪º█î┘å╪¿╪º┘å╪» ┘╛┘å┘ä ┘é╪»█î┘à█î ╪▒╪º ╪ó┘╛┘ä┘ê╪» ┌⌐┘å╪»╪î ╪│┘╛╪│ ╪»┘ê╪¿╪º╪▒┘ç ╪º┘à╪¬╪¡╪º┘å ┌⌐┘å█î╪».",
                no_traffic_data_unlimited_source: "Γ¢ö ╪º┘å╪¬┘é╪º┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n┌⌐╪º┘å┘ü█î┌» ┘é╪»█î┘à█î ╪┤┘à╪º ╪¡╪¼┘à ┘å╪º┘à╪¡╪»┘ê╪» ╪»╪º╪▒╪» ┘ê ┘å┘à█îΓÇî╪¬┘ê╪º┘å ╪ó┘å ╪▒╪º ╪«┘ê╪»┌⌐╪º╪▒ ┘à┘å╪¬┘é┘ä ┌⌐╪▒╪».\n╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪».",
                migration_not_found: "Γ¢ö ╪»╪▒╪«┘ê╪º╪│╪¬ ┘à┘ç╪º╪¼╪▒╪¬ █î╪º┘ü╪¬ ┘å╪┤╪». ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪».",
                target_config_empty: "Γ¢ö ╪º┘å╪¬┘é╪º┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪» ΓÇö ┘à┘é╪»╪º╪▒ ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪«╪º┘ä█î ╪º╪│╪¬.\n╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪».",
            };
            // auto_provision_failed has a dynamic prefix ΓÇö match by startsWith
            const userMsg = reasonMessages[reason]
                ?? (reason.startsWith("auto_provision_failed")
                    ? "Γ¢ö ╪º┘å╪¬┘é╪º┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪» ΓÇö ╪«╪╖╪º ╪»╪▒ ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪▒┘ê█î ┘╛┘å┘ä ┘à┘é╪╡╪».\n╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪»."
                    : "Γ¢ö ╪º┘å╪¬┘é╪º┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪». ╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪».");
            await tg("sendMessage", { chat_id: chatId, text: userMsg });
            await notifyAdmins(`ΓÜá∩╕Å ╪º┘å╪¬┘é╪º┘ä ┘ü┘ê╪▒█î ┘å╪º┘à┘ê┘ü┘é\n┌⌐╪»: ${inserted[0].id}\n┌⌐╪º╪▒╪¿╪▒: ${requestedFor}\n╪╣┘ä╪¬: ${result.reason}`);
            return false;
        }
        const isFromManualStock = sourceRows[0].panel_id === null && sourceRows[0].migration_parent_inventory_id === null;
        if (isFromManualStock) {
            await notifyAdmins(`≡ƒöö ╪º┘å╪¬┘é╪º┘ä ┘ü┘ê╪▒█î ╪º┘å╪¼╪º┘à ╪┤╪» (┘à┘å╪¿╪╣ ╪»╪│╪¬█î)\n┌⌐╪»: ${inserted[0].id}\n┌⌐╪º╪▒╪¿╪▒: ${requestedFor}\n┌⌐╪º┘å┘ü█î┌»: ${sourceInventoryId}`);
        }
        return true;
    }
    await tg("sendMessage", { chat_id: chatId, text: `╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘å╪¬┘é╪º┘ä ╪½╪¿╪¬ ╪┤╪» Γ£à\n┌⌐╪» ╪»╪▒╪«┘ê╪º╪│╪¬: ${inserted[0].id}` });
    await notifyAdmins(`≡ƒôÑ ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘å╪¬┘é╪º┘ä ╪¼╪»█î╪»\n┌⌐╪»: ${inserted[0].id}\n┌⌐╪º╪▒╪¿╪▒: ${requestedFor}\n┌⌐╪º┘å┘ü█î┌»: ${sourceInventoryId}`, {
        inline_keyboard: [[{ text: "╪¿╪º╪▓┌⌐╪▒╪»┘å ╪»╪▒╪«┘ê╪º╪│╪¬", callback_data: `admin_migration_open_${inserted[0].id}` }]]
    });
    return true;
}
async function showMyMigrations(chatId, userId) {
    const rows = await sql `
    SELECT
      m.id,
      m.source_inventory_id,
      m.status,
      m.created_at,
      p.name AS panel_name
    FROM panel_migrations m
    INNER JOIN panels p ON p.id = m.target_panel_id
    WHERE m.requested_for = ${userId}
    ORDER BY m.id DESC
    LIMIT 20;
  `;
    const lines = rows.map((r) => `#${r.id} | ┌⌐╪º┘å┘ü█î┌» ${r.source_inventory_id} ΓåÆ ${r.panel_name} | ${r.status} | ${r.created_at}`);
    const keyboard = [
        [{ text: "≡ƒöù ╪º┘å╪¬┘é╪º┘ä ╪¿╪º ┘ä█î┘å┌⌐ ╪│╪º╪¿╪│┌⌐╪▒█î┘╛╪┤┘å", callback_data: "sublink_migrate_start" }],
    ];
    keyboard.push([homeButton()]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: rows.length
            ? `≡ƒô£ ╪ó╪«╪▒█î┘å ╪»╪▒╪«┘ê╪º╪│╪¬ΓÇî┘ç╪º█î ╪º┘å╪¬┘é╪º┘ä ╪┤┘à╪º:\n\n${lines.join("\n")}`
            : "┘ç┘å┘ê╪▓ ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘å╪¬┘é╪º┘ä█î ┘å╪»╪º╪▒█î╪».\n\n╪¿╪▒╪º█î ╪º┘å╪¬┘é╪º┘ä ┌⌐╪º┘å┘ü█î┌» ╪º╪▓ ┘╛┘å┘ä ┘é╪»█î┘à█î╪î ╪º╪▓ ╪»┌⌐┘à┘ç ╪▓█î╪▒ ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»:",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function executeSubLinkMigration(chatId, userId, targetPanelId) {
    const state = await getState(userId);
    if (!state || state.state !== "sublink_migration_pending") {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ╪¼┘ä╪│┘ç ╪º┘å╪¬┘é╪º┘ä ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º╪¿╪¬╪»╪º ╪┤╪▒┘ê╪╣ ┌⌐┘å█î╪»." });
        return null;
    }
    const payload = state.payload;
    await clearState(userId);
    await tg("sendMessage", { chat_id: chatId, text: "ΓÅ│ ╪»╪▒ ╪¡╪º┘ä ╪º┘å╪¬┘é╪º┘ä ┌⌐╪º┘å┘ü█î┌»..." });
    try {
        // Load target panel
        const targetRows = await sql `
    SELECT id, name, panel_type, base_url, username, password, active
    FROM panels WHERE id = ${targetPanelId} AND active = TRUE LIMIT 1;
  `;
        if (!targetRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ┘╛┘å┘ä ┘à┘é╪╡╪» ┘╛█î╪»╪º ┘å╪┤╪» █î╪º ╪║█î╪▒┘ü╪╣╪º┘ä ╪º╪│╪¬." });
            return null;
        }
        const targetPanel = targetRows[0];
        const remainingMb = payload.remainingBytes > 0 ? Math.ceil(payload.remainingBytes / (1024 * 1024)) : 0;
        const remainingDays = payload.expireMs > Date.now()
            ? Math.ceil((payload.expireMs - Date.now()) / (1000 * 60 * 60 * 24))
            : 0;
        // Find a matching inventory record for the old config (to mark as migrated)
        const safeKey = payload.sourceUserKey.replace(/[%_]/g, "");
        const matchingInv = safeKey.length >= 4
            ? await sql `
        SELECT id, product_id, owner_telegram_id FROM inventory
        WHERE (
          config_value ILIKE ${"%" + safeKey + "%"}
          OR delivery_payload::text ILIKE ${"%" + safeKey + "%"}
        )
        AND status NOT IN ('migrated')
        LIMIT 1;
      `
            : [];
        // Determine product_id for new inventory record
        let productId = null;
        if (matchingInv.length && matchingInv[0].product_id) {
            productId = Number(matchingInv[0].product_id);
        }
        if (!productId) {
            const pp = await sql `SELECT id FROM products WHERE panel_id = ${targetPanelId} AND is_active = TRUE LIMIT 1;`;
            if (pp.length)
                productId = Number(pp[0].id);
        }
        if (!productId) {
            const ap = await sql `SELECT id FROM products WHERE is_active = TRUE ORDER BY id LIMIT 1;`;
            if (ap.length)
                productId = Number(ap[0].id);
        }
        if (!productId) {
            await tg("sendMessage", { chat_id: chatId, text: "Γ¢ö ┘à╪¡╪╡┘ê┘ä█î ╪¿╪▒╪º█î ╪½╪¿╪¬ ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ┘╛█î╪»╪º ┘å╪┤╪». ╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪»." });
            return null;
        }
        // Load product/panel-config
        const productRows = await sql `SELECT id, name, panel_config FROM products WHERE id = ${productId} LIMIT 1;`;
        if (!productRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "Γ¢ö ╪º╪╖┘ä╪º╪╣╪º╪¬ ┘à╪¡╪╡┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪». ╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪»." });
            return null;
        }
        const product = productRows[0];
        const rawPanelConfig = typeof product.panel_config === "string"
            ? (parseJsonObject(product.panel_config) || {})
            : (product.panel_config || {});
        const purchaseId = `SL-${Date.now()}`;
        const pseudoOrder = {
            telegram_id: userId,
            product_id: productId,
            product_name: String(product.name || "╪º┘å╪¬┘é╪º┘ä"),
            size_mb: remainingMb,
            purchase_id: purchaseId,
            config_name: payload.sourceUserKey.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 28),
            panel_delivery_mode: "both"
        };
        const panelConfigForProvision = {
            ...rawPanelConfig,
            ...(remainingMb > 0 ? { data_limit_mb: remainingMb } : {}),
            ...(remainingDays > 0 ? { expire_days: remainingDays } : {})
        };
        let finalConfigValue = null;
        let finalDeliveryPayload = null;
        try {
            const provision = await provisionMarzbanSale(targetPanel, pseudoOrder, panelConfigForProvision);
            if (provision.deliveryPayload.metadata) {
                provision.deliveryPayload.metadata.panelType = String(targetPanel.panel_type);
            }
            finalConfigValue = provision.configValue;
            finalDeliveryPayload = JSON.stringify(provision.deliveryPayload);
        }
        catch (err) {
            logError("sublink_migration_provision_failed", err, { userId, targetPanelId });
            await tg("sendMessage", {
                chat_id: chatId,
                text: `Γ¢ö ╪«╪╖╪º ╪»╪▒ ╪º█î╪¼╪º╪» ┌⌐╪º┘å┘ü█î┌» ╪▒┘ê█î ┘╛┘å┘ä ┘à┘é╪╡╪»:\n${String(err?.message || err)}\n╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪».`
            });
            return null;
        }
        if (!finalConfigValue) {
            await tg("sendMessage", { chat_id: chatId, text: "Γ¢ö ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪º█î╪¼╪º╪» ┘å╪┤╪». ╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪»." });
            return null;
        }
        // Insert new inventory record
        const insertedRows = finalDeliveryPayload
            ? await sql `
        INSERT INTO inventory (product_id, config_value, status, owner_telegram_id, panel_id, sold_at, delivery_payload)
        VALUES (${productId}, ${finalConfigValue}, 'sold', ${userId}, ${targetPanelId}, NOW(), ${finalDeliveryPayload}::jsonb)
        RETURNING id;
      `
            : await sql `
        INSERT INTO inventory (product_id, config_value, status, owner_telegram_id, panel_id, sold_at)
        VALUES (${productId}, ${finalConfigValue}, 'sold', ${userId}, ${targetPanelId}, NOW())
        RETURNING id;
      `;
        const newInventoryId = Number(insertedRows[0].id);
        // Mark old inventory record as migrated if it belongs to this user
        if (matchingInv.length && Number(matchingInv[0].owner_telegram_id) === userId) {
            await sql `
      UPDATE inventory
      SET status = 'migrated', migrated_to_inventory_id = ${newInventoryId}
      WHERE id = ${matchingInv[0].id};
    `;
        }
        await tg("sendMessage", { chat_id: chatId, text: "Γ£à ╪º┘å╪¬┘é╪º┘ä ┘à┘ê┘ü┘é█î╪¬ΓÇî╪ó┘à█î╪▓ ╪¿┘ê╪»! ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪┤┘à╪º:" });
        await sendConfigWithQr(userId, purchaseId, finalConfigValue, [[homeButton()]]);
        await notifyAdmins(`≡ƒöù ╪º┘å╪¬┘é╪º┘ä ╪¿╪º ┘ä█î┘å┌⌐\n┌⌐╪º╪▒╪¿╪▒: ${userId}\n┘╛┘å┘ä ┘à╪¿╪»╪º: ${payload.sourcePanelName}\n┘╛┘å┘ä ┘à┘é╪╡╪»: ${String(targetPanel.name)}\n┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪»: ${newInventoryId}`);
        return null;
    }
    catch (outerErr) {
        logError("sublink_migration_outer_failed", outerErr, { userId, targetPanelId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `Γ¢ö ╪«╪╖╪º ╪»╪▒ ╪º┘å╪¬┘é╪º┘ä ┌⌐╪º┘å┘ü█î┌»:\n${String(outerErr?.message || outerErr)}\n╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪».`
        }).catch(() => { });
        return null;
    }
}
async function showMyOrders(chatId, userId) {
    const rows = await sql `
    SELECT
      o.id,
      o.purchase_id,
      COALESCE(o.product_name_snapshot, p.name) AS product_name,
      o.status,
      o.payment_method,
      o.final_price,
      o.created_at
    FROM orders o
    INNER JOIN products p ON p.id = o.product_id
    WHERE o.telegram_id = ${userId}
    ORDER BY o.id DESC
    LIMIT 20;
  `;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ç┘å┘ê╪▓ ╪│┘ü╪º╪▒╪┤█î ╪½╪¿╪¬ ┘å┌⌐╪▒╪»┘çΓÇî╪º█î." });
        return null;
    }
    const keyboard = rows.map((o) => [
        cb(`${String(o.purchase_id)} | ${String(o.product_name)} | ${formatOrderStatusTitle(o.status)}`, `open_order_${String(o.purchase_id)}`, "primary")
    ]);
    keyboard.push([cb("≡ƒöÄ ┘╛█î┌»█î╪▒█î ╪¿╪º ╪┤┘å╪º╪│┘ç", "order_lookup", "primary")]);
    keyboard.push([homeButton()]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "≡ƒº╛ ╪│┘ü╪º╪▒╪┤ΓÇî┘ç╪º█î ╪º╪«█î╪▒╪¬ ≡ƒæç",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function showOrderDetails(chatId, userId, purchaseId) {
    const rows = await sql `
    SELECT
      o.id,
      o.purchase_id,
      COALESCE(o.product_name_snapshot, p.name) AS product_name,
      o.status,
      o.payment_method,
      o.final_price,
      o.created_at,
      o.inventory_id,
      o.tronado_payment_url,
      o.plisio_invoice_url,
      o.swapwallet_payment_url,
      o.receipt_file_id
    FROM orders o
    INNER JOIN products p ON p.id = o.product_id
    WHERE o.purchase_id = ${purchaseId} AND o.telegram_id = ${userId}
    LIMIT 1;
  `;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ ┘╛█î╪»╪º ┘å╪┤╪» █î╪º ┘à╪¬╪╣┘ä┘é ╪¿┘ç ╪¬┘ê ┘å█î╪│╪¬." });
        return null;
    }
    const o = rows[0];
    const statusTitle = formatOrderStatusTitle(o.status);
    const methodTitle = formatPaymentMethodTitle(o.payment_method);
    const lines = [
        `≡ƒº╛ ╪¼╪▓╪ª█î╪º╪¬ ╪│┘ü╪º╪▒╪┤`,
        ``,
        `╪┤┘å╪º╪│┘ç: ${String(o.purchase_id)}`,
        `┘à╪¡╪╡┘ê┘ä: ${String(o.product_name)}`,
        `┘à╪¿┘ä╪║: ${formatPriceToman(Number(o.final_price))} ╪¬┘ê┘à╪º┘å`,
        `╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬: ${methodTitle}`,
        `┘ê╪╢╪╣█î╪¬: ${statusTitle}`,
        `╪▓┘à╪º┘å: ${String(o.created_at)}`
    ];
    const keyboard = [];
    const paymentUrl = String(o.plisio_invoice_url || o.tronado_payment_url || o.swapwallet_payment_url || "").trim();
    if (paymentUrl && (String(o.status || "").toLowerCase() === "pending")) {
        keyboard.push([{ text: "≡ƒÆ│ ┘╛╪▒╪»╪º╪«╪¬", url: paymentUrl }]);
    }
    if (String(o.payment_method || "").toLowerCase() === "crypto") {
        keyboard.push([cb("Γ£à ╪¿╪▒╪▒╪│█î/╪½╪¿╪¬ ┘╛╪▒╪»╪º╪«╪¬", `check_order_${String(o.purchase_id)}`, "success")]);
    }
    if (String(o.payment_method || "").toLowerCase() === "card2card" && String(o.status || "").toLowerCase() === "awaiting_receipt") {
        keyboard.push([cb("≡ƒô╖ ╪º╪▒╪│╪º┘ä ╪▒╪│█î╪»", `order_send_receipt_${Number(o.id)}`, "success")]);
    }
    if (o.inventory_id) {
        keyboard.push([cb("≡ƒôª ┘à╪┤╪º┘ç╪»┘ç ┌⌐╪º┘å┘ü█î┌»", `open_config_${Number(o.inventory_id)}`, "primary")]);
    }
    if (String(o.payment_method || "").toLowerCase() !== "wallet" && ["pending", "awaiting_receipt"].includes(String(o.status || "").toLowerCase())) {
        keyboard.push([cb("≡ƒùæ ┘ä╪║┘ê ╪│┘ü╪º╪▒╪┤", `order_cancel_${String(o.purchase_id)}`, "danger")]);
    }
    keyboard.push([backButton("my_orders")]);
    keyboard.push([homeButton()]);
    await tg("sendMessage", { chat_id: chatId, text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } });
}
async function completeMigration(migrationId, decidedBy, targetConfigValue) {
    const rows = await sql `
    SELECT
      m.id,
      m.source_inventory_id,
      m.target_panel_id,
      m.requested_for,
      i.product_id,
      i.config_value,
      i.delivery_payload,
      i.panel_id AS source_panel_id
    FROM panel_migrations m
    INNER JOIN inventory i ON i.id = m.source_inventory_id
    WHERE m.id = ${migrationId} AND m.status = 'pending'
    LIMIT 1;
  `;
    if (!rows.length)
        return { ok: false, reason: "migration_not_found" };
    const m = rows[0];
    let finalConfigValue = targetConfigValue || String(m.config_value || "").trim();
    let finalDeliveryPayload = null;
    // Auto-provision on target panel when no targetConfigValue is given and target is Marzban-like
    if (!targetConfigValue && Number(m.target_panel_id) > 0) {
        const [targetPanelRows, productRows] = await Promise.all([
            sql `SELECT id, panel_type, base_url, username, password FROM panels WHERE id = ${m.target_panel_id} LIMIT 1;`,
            sql `SELECT id, size_mb, panel_config, panel_id FROM products WHERE id = ${m.product_id} LIMIT 1;`
        ]);
        const targetPanel = targetPanelRows[0];
        const product = productRows[0];
        if (targetPanel && isMarzbanLike(String(targetPanel.panel_type || "")) && product) {
            const srcDelivery = parseDeliveryPayload(m.delivery_payload);
            const srcPanelType = String(srcDelivery.metadata?.panelType || "");
            const srcIdentifier = String(srcDelivery.metadata?.username || srcDelivery.metadata?.uuid || srcDelivery.metadata?.email || srcDelivery.metadata?.subId || "").trim();
            // Only auto-provision when migrating FROM a Sanaei source
            if (srcPanelType === "sanaei" && srcIdentifier) {
                let oldDataLimitBytes = 0;
                let oldExpireSeconds = 0;
                // Try to get live client data from source Sanaei panel (with backup fallback built into findSanaeiClientByIdentifier)
                let clientFound = false;
                if (Number(m.source_panel_id) > 0) {
                    const srcPanelRows = await sql `SELECT id, panel_type, base_url, username, password FROM panels WHERE id = ${m.source_panel_id} LIMIT 1;`;
                    if (srcPanelRows.length) {
                        const found = await findSanaeiClientByIdentifier(srcPanelRows[0], srcIdentifier);
                        if (found.ok && found.client) {
                            clientFound = true;
                            const c = found.client;
                            // totalGB is stored as bytes in 3x-ui (field name is misleading)
                            const totalBytes = Number(c.totalGB || 0);
                            const usedUp = Number(c.up || 0);
                            const usedDown = Number(c.down || 0);
                            const remainingBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedUp - usedDown) : 0;
                            oldDataLimitBytes = remainingBytes;
                            const expiryTime = Number(c.expiryTime || 0);
                            oldExpireSeconds = expiryTime > 0 ? Math.floor(expiryTime / 1000) : 0;
                        }
                    }
                }
                // Prevent creating unlimited configs: data_limit=0 on Marzban/PasarGuard = unlimited.
                // If client data is unavailable, fall back to the product's defined size.
                // Only block if BOTH are missing ΓÇö that's the only case that would produce unlimited.
                const sizeMbFallback = Number(product.size_mb || 0);
                if (oldDataLimitBytes <= 0) {
                    if (sizeMbFallback > 0) {
                        oldDataLimitBytes = sizeMbFallback * 1024 * 1024;
                    }
                    else {
                        const reason = !clientFound
                            ? "no_traffic_data_client_not_found"
                            : "no_traffic_data_unlimited_source";
                        const userMsg = !clientFound
                            ? "┌⌐╪º┘å┘ü█î┌» ┘é╪»█î┘à█î ╪»╪▒ ┘╛┘å┘ä █î╪º ╪¿┌⌐╪º┘╛ ┘╛█î╪»╪º ┘å╪┤╪» ┘ê ╪¡╪¼┘à ┘à╪¡╪╡┘ê┘ä ┘å█î╪▓ ╪╡┘ü╪▒ ╪º╪│╪¬."
                            : "┌⌐╪º┘å┘ü█î┌» ┘é╪»█î┘à█î ┘å╪º┘à╪¡╪»┘ê╪» ╪º╪│╪¬ ┘ê ╪¡╪¼┘à ┘à╪¡╪╡┘ê┘ä ┘å█î╪▓ ╪╡┘ü╪▒ ╪º╪│╪¬.";
                        await tg("sendMessage", {
                            chat_id: m.requested_for,
                            text: `Γ¢ö ┘à┘ç╪º╪¼╪▒╪¬ ┘ä╪║┘ê ╪┤╪».\n${userMsg}\n╪¿╪▒╪º█î ╪¼┘ä┘ê┌»█î╪▒█î ╪º╪▓ ╪╡╪»┘ê╪▒ ┌⌐╪º┘å┘ü█î┌» ╪¿╪º ╪¡╪¼┘à ┘å╪º┘à╪¡╪»┘ê╪»╪î ╪º█î┘å ┘à┘ç╪º╪¼╪▒╪¬ ┘à╪¬┘ê┘é┘ü ╪┤╪».`
                        });
                        return { ok: false, reason };
                    }
                }
                const rawPanelConfig = typeof product.panel_config === "string"
                    ? parseJsonObject(product.panel_config) || {}
                    : product.panel_config || {};
                // Build a pseudo-order for provisionMarzbanSale
                const overrideDataLimitMb = Math.round(oldDataLimitBytes / (1024 * 1024));
                const expireTimestamp = oldExpireSeconds > 0 ? oldExpireSeconds * 1000 : 0;
                const daysFromNow = expireTimestamp > Date.now()
                    ? Math.ceil((expireTimestamp - Date.now()) / (1000 * 60 * 60 * 24))
                    : 0;
                const pseudoOrder = {
                    telegram_id: m.requested_for,
                    product_id: m.product_id,
                    product_name: String(product.name || ""),
                    size_mb: overrideDataLimitMb,
                    purchase_id: `M-${migrationId}`,
                    config_name: srcIdentifier.slice(0, 32),
                    panel_delivery_mode: "both"
                };
                const panelConfigForProvision = {
                    ...rawPanelConfig,
                    ...(overrideDataLimitMb > 0 ? { data_limit_mb: overrideDataLimitMb } : {}),
                    ...(daysFromNow > 0 ? { expire_days: daysFromNow } : {})
                };
                try {
                    const provision = await provisionMarzbanSale(targetPanel, pseudoOrder, panelConfigForProvision);
                    // Stamp the correct panelType (pasarguard) in metadata
                    if (provision.deliveryPayload.metadata) {
                        provision.deliveryPayload.metadata.panelType = String(targetPanel.panel_type);
                    }
                    finalConfigValue = provision.configValue;
                    finalDeliveryPayload = JSON.stringify(provision.deliveryPayload);
                }
                catch (err) {
                    logError("migration_provision_failed", err, { migrationId });
                    return { ok: false, reason: `auto_provision_failed: ${String(err?.message || err)}` };
                }
            }
        }
    }
    if (!finalConfigValue)
        return { ok: false, reason: "target_config_empty" };
    let insertedRows;
    if (finalDeliveryPayload) {
        insertedRows = await sql `
      INSERT INTO inventory (
        product_id, config_value, status, owner_telegram_id,
        panel_id, migration_parent_inventory_id, sold_at, delivery_payload
      )
      VALUES (
        ${m.product_id}, ${finalConfigValue}, 'sold', ${m.requested_for},
        ${m.target_panel_id}, ${m.source_inventory_id}, NOW(), ${finalDeliveryPayload}::jsonb
      )
      RETURNING id;
    `;
    }
    else {
        insertedRows = await sql `
      INSERT INTO inventory (
        product_id, config_value, status, owner_telegram_id,
        panel_id, migration_parent_inventory_id, sold_at
      )
      VALUES (
        ${m.product_id}, ${finalConfigValue}, 'sold', ${m.requested_for},
        ${m.target_panel_id}, ${m.source_inventory_id}, NOW()
      )
      RETURNING id;
    `;
    }
    // Mark source inventory as 'migrated' so it disappears from the user's active config
    // list and cannot be migrated again. Data is fully preserved in the DB.
    await sql `
    UPDATE inventory
    SET migrated_to_inventory_id = ${insertedRows[0].id}, status = 'migrated'
    WHERE id = ${m.source_inventory_id};
  `;
    await sql `
    UPDATE panel_migrations
    SET status = 'approved', target_config_value = ${finalConfigValue}, processed_at = NOW(), processed_by = ${decidedBy}
    WHERE id = ${migrationId};
  `;
    await tg("sendMessage", {
        chat_id: Number(m.requested_for),
        text: `╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘å╪¬┘é╪º┘ä #${migrationId} ╪¬╪º█î█î╪» ╪┤╪» Γ£à\n┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪┤┘à╪º:`,
    });
    await sendConfigWithQr(Number(m.requested_for), `M-${migrationId}`, finalConfigValue, [[homeButton()]]);
    return { ok: true, reason: "done" };
}
async function showProducts(chatId, forBuy, page = 0, kind = "") {
    const globalInfinite = await getBoolSetting("global_infinite_mode", false);
    const customEnabled = forBuy ? await getBoolSetting("custom_v2ray_enabled", false) : false;
    const customProductId = customEnabled ? Number((await getSetting("custom_v2ray_product_id")) || 0) : 0;
    if (forBuy && !kind) {
        const kindsRow = await sql `
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(panel_config->>'product_kind', 'v2ray') = 'v2ray') AS v2ray_count,
        COUNT(*) FILTER (WHERE COALESCE(panel_config->>'product_kind', 'v2ray') = 'account') AS account_count,
        COUNT(*) FILTER (WHERE COALESCE(panel_config->>'product_kind', 'v2ray') = 'wireguard') AS wireguard_count
      FROM products
      WHERE is_active = TRUE
    `;
        const v2rayCount = Number(kindsRow[0].v2ray_count);
        const accountCount = Number(kindsRow[0].account_count);
        const wireguardCount = Number(kindsRow[0].wireguard_count);
        if ((v2rayCount > 0 ? 1 : 0) + (accountCount > 0 ? 1 : 0) + (wireguardCount > 0 ? 1 : 0) > 1) {
            const keyboard = [];
            if (v2rayCount > 0)
                keyboard.push([cb("?? ?????? (V2Ray)", "buy_cat_v2ray_0", "primary")]);
            if (accountCount > 0)
                keyboard.push([cb("?? ?????", "buy_cat_account_0", "primary")]);
            if (wireguardCount > 0)
                keyboard.push([cb("?? ???????? (Wireguard)", "buy_cat_wireguard_0", "primary")]);
            keyboard.push([homeButton()]);
            await tg("sendMessage", { chat_id: chatId, text: "????????? ???? ??? ?? ?????? ????:", reply_markup: { inline_keyboard: keyboard } });
            return null;
        }
        else if (accountCount > 0 && v2rayCount === 0 && wireguardCount === 0) {
            kind = "account";
        }
        else if (wireguardCount > 0 && accountCount === 0 && v2rayCount === 0) {
            kind = "wireguard";
        }
        else {
            kind = "v2ray";
        }
    }
    const rows = await sql `
    SELECT
      p.id,
      p.name,
      p.size_mb,
      p.price_toman,
      p.is_infinite,
      p.sell_mode,
      p.panel_id,
      p.panel_sell_limit,
      p.panel_delivery_mode,
      pnl.name AS panel_name,
      pnl.active AS panel_active,
      pnl.allow_new_sales AS panel_allow_new_sales,
      COALESCE(p.panel_config->>'product_kind', 'v2ray') AS kind,
      (SELECT COUNT(*)::int FROM inventory i WHERE i.product_id = p.id AND i.status = 'available') AS stock,
      (
        SELECT COUNT(*)::int
        FROM orders o
        WHERE o.product_id = p.id
          AND o.sell_mode = 'panel'
          AND o.status NOT IN ('denied')
      ) AS panel_sales_count
    FROM products p
    LEFT JOIN panels pnl ON pnl.id = p.panel_id
    WHERE p.is_active = TRUE
    ORDER BY p.id ASC;
  `;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┘à╪¡╪╡┘ê┘ä ┘ü╪╣╪º┘ä█î ╪¬╪╣╪▒█î┘ü ┘å╪┤╪»┘ç ╪º╪│╪¬." });
        return null;
    }
    const dayPrice = customEnabled ? Math.max(0, Math.round((await getNumberSetting("custom_v2ray_extra_day_toman")) || 0)) : 0;
    const pricePerGb = customEnabled
        ? normalizePricePerGb(await getSetting("product_price_per_gb_toman"), normalizePricePerGb(await getSetting("topup_price_per_gb_toman")))
        : 0;
    const minCustomPrice = customEnabled ? Math.max(1, pricePerGb + 30 * dayPrice) : 0;
    const filteredRows = kind ? rows.filter((p) => p.kind === kind) : rows;
    if (!filteredRows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä█î █î╪º┘ü╪¬ ┘å╪┤╪»." });
        return null;
    }
    const standardRows = customEnabled && customProductId > 0 ? filteredRows.filter((p) => Number(p.id) !== customProductId) : filteredRows;
    const customRow = customEnabled && customProductId > 0 ? filteredRows.find((p) => Number(p.id) === customProductId) : null;
    const pageSize = 15;
    const totalPages = Math.ceil(standardRows.length / pageSize) || 1;
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePage * pageSize;
    const slice = standardRows.slice(start, start + pageSize);
    const keyboard = slice.map((p) => [
        cb(`${p.name} | ${formatPriceToman(Number(p.price_toman))} ╪¬┘ê┘à╪º┘å`, forBuy ? `buy_product_${p.id}` : `admin_inventory_product_${p.id}`, "primary")
    ]);
    if (forBuy && customRow) {
        keyboard.push([
            cb(`≡ƒÄ¢ ╪│┘ü╪º╪▒╪┤█î | ╪º╪▓ ${formatPriceToman(minCustomPrice)} ╪¬┘ê┘à╪º┘å`, `buy_custom_v2ray_${customProductId}`, "success")
        ]);
    }
    if (totalPages > 1) {
        const navRow = [];
        const pfx = forBuy ? (kind ? `buy_cat_${kind}_` : `buy_cat__`) : `admin_inv_`;
        if (safePage > 0)
            navRow.push({ text: "ΓùÇ∩╕Å ┘é╪¿┘ä█î", callback_data: `${pfx}${safePage - 1}` });
        navRow.push({ text: `╪╡┘ü╪¡┘ç ${safePage + 1} ╪º╪▓ ${totalPages}`, callback_data: "noop" });
        if (safePage < totalPages - 1)
            navRow.push({ text: "╪¿╪╣╪»█î Γû╢∩╕Å", callback_data: `${pfx}${safePage + 1}` });
        keyboard.push(navRow);
    }
    keyboard.push([homeButton()]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: forBuy ? "≡ƒ¢ì ┘à╪¡╪╡┘ê┘ä ┘à┘ê╪▒╪»┘å╪╕╪▒ ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:" : "┘à╪¡╪╡┘ê┘ä ╪¿╪▒╪º█î ┘à╪»█î╪▒█î╪¬ ┘à┘ê╪¼┘ê╪»█î:",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function listProductsForAdmin(chatId, userId, page = 0) {
    const showArchived = await getBoolSetting(`admin_products_show_archived_${userId}`, false);
    const rows = await sql `
    SELECT
      p.id,
      p.name,
      p.size_mb,
      p.price_toman,
      p.is_active,
      p.is_infinite,
      p.sell_mode,
      p.panel_id,
      p.panel_sell_limit,
      p.panel_delivery_mode,
      pnl.name AS panel_name
    FROM products p
    LEFT JOIN panels pnl ON pnl.id = p.panel_id
    WHERE (${showArchived} = TRUE OR p.is_active = TRUE)
    ORDER BY p.id ASC;
  `;
    const pageSize = 8;
    const totalPages = Math.ceil(rows.length / pageSize) || 1;
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePage * pageSize;
    const slice = rows.slice(start, start + pageSize);
    const keyboard = slice.flatMap((p) => [
        [
            {
                text: `${p.name} | ${formatPriceToman(Number(p.price_toman))} ╪¬┘ê┘à╪º┘å`,
                callback_data: `admin_edit_product_${p.id}`
            }
        ],
        [
            cb("┘ê█î╪▒╪º█î╪┤", `admin_edit_product_${p.id}`, "primary"),
            cb(p.is_active ? "╪║█î╪▒┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î" : "┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î", `admin_toggle_product_${p.id}`, p.is_active ? "danger" : "success"),
            cb(parseSellMode(String(p.sell_mode || "")) === "panel" ? "┘ü╪▒┘ê╪┤ ╪»╪│╪¬█î" : "┘ü╪▒┘ê╪┤ ╪º╪▓ ┘╛┘å┘ä", `admin_toggle_product_sell_mode_${p.id}`, "primary")
        ],
        [
            cb(p.is_infinite ? "╪¡╪░┘ü Γê₧" : "Γê₧", `admin_toggle_product_infinite_${p.id}`, "primary"),
            cb("╪¬┘å╪╕█î┘à ┘ü╪▒┘ê╪┤ ┘╛┘å┘ä", `admin_configure_product_panel_${p.id}`, "primary"),
            cb("≡ƒùæ ╪¡╪░┘ü", `admin_remove_product_${p.id}`, "danger")
        ]
    ]);
    if (totalPages > 1) {
        const navRow = [];
        if (safePage > 0)
            navRow.push({ text: "ΓùÇ∩╕Å ┘é╪¿┘ä█î", callback_data: `admin_products_page_${safePage - 1}` });
        navRow.push({ text: `╪╡┘ü╪¡┘ç ${safePage + 1} ╪º╪▓ ${totalPages}`, callback_data: "noop" });
        if (safePage < totalPages - 1)
            navRow.push({ text: "╪¿╪╣╪»█î Γû╢∩╕Å", callback_data: `admin_products_page_${safePage + 1}` });
        keyboard.push(navRow);
    }
    keyboard.push([cb(showArchived ? "≡ƒôª ┘à╪«┘ü█î ┌⌐╪▒╪»┘å ╪ó╪▒╪┤█î┘ê" : "≡ƒôª ┘å┘à╪º█î╪┤ ╪ó╪▒╪┤█î┘ê", showArchived ? "admin_products_hide_archived" : "admin_products_show_archived", "primary")]);
    keyboard.push([cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ┘à╪¡╪╡┘ê┘ä", "admin_add_product", "success")]);
    keyboard.push([backButton("admin_panel")]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "┘à╪»█î╪▒█î╪¬ ┘à╪¡╪╡┘ê┘ä╪º╪¬:",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function showWalletUsagePrompt(chatId, userId, productId, walletBalance) {
    const productRows = await sql `SELECT price_toman FROM products WHERE id = ${productId} LIMIT 1;`;
    if (!productRows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪»." });
        return null;
    }
    const productPrice = Number(productRows[0].price_toman || 0);
    const maxUsable = Math.min(walletBalance, productPrice);
    if (maxUsable <= 0) {
        await showPaymentMethods(chatId, userId, productId, 0);
        return null;
    }
    const keyboard = [
        [cb(`Γ£à ╪º╪│╪¬┘ü╪º╪»┘ç ╪º╪▓ ╪¡╪»╪º┌⌐╪½╪▒ ┘à┘à┌⌐┘å (${formatPriceToman(maxUsable)} ╪¬┘ê┘à╪º┘å)`, `use_wallet_${productId}_${maxUsable}`, "success")],
        [cb("Γ£ì∩╕Å ┘ê╪▒┘ê╪» ┘à╪¿┘ä╪║ ╪»┘ä╪«┘ê╪º┘ç", `use_wallet_custom_${productId}`, "primary")],
        [cb("Γ¥î ╪¿╪»┘ê┘å ╪º╪│╪¬┘ü╪º╪»┘ç ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä", `use_wallet_${productId}_0`, "danger")],
        [homeButton()]
    ];
    await tg("sendMessage", {
        chat_id: chatId,
        text: `╪┤┘à╪º ${formatPriceToman(walletBalance)} ╪¬┘ê┘à╪º┘å ╪»╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä ╪«┘ê╪» ╪»╪º╪▒█î╪».\n\n┘é█î┘à╪¬ ┘à╪¡╪╡┘ê┘ä: ${formatPriceToman(productPrice)} ╪¬┘ê┘à╪º┘å\n╪ó█î╪º ┘à╪º█î┘ä█î╪» ╪º╪▓ ┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪«┘ê╪» ╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪«╪┤█î (█î╪º ╪¬┘à╪º┘à) ┘ç╪▓█î┘å┘ç ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»╪ƒ`,
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function showPaymentMethods(chatId, userId, productId, walletUsed = 0) {
    const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
    const walletBalance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
    const state = await getState(userId);
    const bulkQty = state?.state === "bulk_purchase_pending"
        ? Math.max(1, Math.round(Number(state.payload?.quantity || 1)))
        : 1;
    const productRows = await sql `SELECT price_toman FROM products WHERE id = ${productId} LIMIT 1;`;
    if (!productRows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪»." });
        return null;
    }
    const unitPrice = Number(productRows[0].price_toman || 0);
    const productPrice = unitPrice * bulkQty;
    const finalPayable = Math.max(0, productPrice - walletUsed);
    const rows = await sql `SELECT code, title FROM payment_methods WHERE active = TRUE ORDER BY code ASC;`;
    if (!rows.length && walletBalance < finalPayable) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ü╪╣┘ä╪º┘ï ┘ç█î┌å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬ ┘ü╪╣╪º┘ä█î ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪» ┘ê ┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ┘ç┘à ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
        return null;
    }
    const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
    const hasCards = (await sql `SELECT 1 FROM cards WHERE active = TRUE LIMIT 1;`).length > 0;
    const hasPlisioKey = Boolean(((await getSetting("plisio_api_key")) || "").trim());
    const hasTetrapayKey = Boolean(((await getSetting("tetrapay_api_key")) || "").trim());
    const hasTronadoKey = Boolean(((await getSetting("tronado_api_key")) || "").trim());
    const hasSwapwalletKey = Boolean(((await getSetting("swapwallet_api_key")) || "").trim());
    const hasSwapwalletShop = Boolean(((await getSetting("swapwallet_shop_username")) || "").trim());
    const hasBusinessWallet = Boolean(((await getSetting("business_wallet_address")) || env.BUSINESS_WALLET_ADDRESS || "").trim());
    const cryptoWalletRows = await getActiveCryptoWallets();
    const hasCrypto = cryptoWalletRows.some(cryptoWalletReady);
    const filtered = rows.filter((m) => {
        const code = String(m.code);
        if (code === "card2card")
            return hasCards;
        if (code === "plisio")
            return Boolean(callbackBase) && hasPlisioKey;
        if (code === "tetrapay")
            return Boolean(callbackBase) && hasTetrapayKey;
        if (code === "tronado")
            return Boolean(callbackBase) && hasTronadoKey && hasBusinessWallet;
        if (code === "swapwallet")
            return Boolean(callbackBase) && hasSwapwalletKey && hasSwapwalletShop;
        if (code === "crypto")
            return hasCrypto;
        return true;
    });
    if (!filtered.length && finalPayable > 0) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ü╪╣┘ä╪º┘ï ┘ç█î┌å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬█î ┌⌐┘ç ╪»╪▒╪│╪¬ ╪¬┘å╪╕█î┘à ╪┤╪»┘ç ╪¿╪º╪┤╪» ╪»╪▒ ╪»╪│╪¬╪▒╪│ ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
        await notifyAdmins(`ΓÜá∩╕Å ┘ç█î┌å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬█î ╪¿╪▒╪º█î ┘å┘à╪º█î╪┤ ┘╛█î╪»╪º ┘å╪┤╪»\n` +
            `user:${userId}\n` +
            `product:${productId}\n` +
            `finalPayable:${finalPayable}\n` +
            `hasCards:${hasCards}\n` +
            `callbackBase:${callbackBase ? "ok" : "missing"}\n` +
            `plisioKey:${hasPlisioKey ? "ok" : "missing"}\n` +
            `tetrapayKey:${hasTetrapayKey ? "ok" : "missing"}\n` +
            `tronadoKey:${hasTronadoKey ? "ok" : "missing"}\n` +
            `swapwalletKey:${hasSwapwalletKey ? "ok" : "missing"}\n` +
            `swapwalletShop:${hasSwapwalletShop ? "ok" : "missing"}\n` +
            `businessWallet:${hasBusinessWallet ? "ok" : "missing"}\n` +
            `cryptoReady:${hasCrypto ? "ok" : "missing"}`, { inline_keyboard: [[{ text: "ΓÜÖ∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ ╪»╪▒┌»╪º┘çΓÇî┘ç╪º", callback_data: "admin_gateway_settings" }]] });
        return null;
    }
    const keyboard = [];
    if (walletUsed >= productPrice) {
        keyboard.push([cb(`≡ƒÆ░ ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪º┘à┘ä ╪¿╪º ┌⌐█î┘ü ┘╛┘ê┘ä (${formatPriceToman(productPrice)} ╪¬┘ê┘à╪º┘å)`, `select_pay_${productId}_wallet_${walletUsed}`, "success")]);
    }
    else {
        for (const m of filtered) {
            keyboard.push([cb(String(m.title), `select_pay_${productId}_${m.code}_${walletUsed}`, "primary")]);
        }
    }
    keyboard.push([homeButton()]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: walletUsed > 0 && walletUsed < productPrice
            ? `┘à╪¿┘ä╪║ ${formatPriceToman(walletUsed)} ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪│╪▒ ╪«┘ê╪º┘ç╪» ╪┤╪».\n┘à╪¿┘ä╪║ ╪¿╪º┘é█î┘à╪º┘å╪»┘ç ╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬: ${formatPriceToman(finalPayable)} ╪¬┘ê┘à╪º┘å\n┘ä╪╖┘ü╪º┘ï ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º┘é█î┘à╪º┘å╪»┘ç ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`
            : "╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function ensureCustomV2rayProduct() {
    const name = "╪│┘ü╪º╪▒╪┤█î";
    const pricePerGb = normalizePricePerGb(await getSetting("product_price_per_gb_toman"), normalizePricePerGb(await getSetting("topup_price_per_gb_toman")));
    const dayPrice = Math.max(0, Math.round((await getNumberSetting("custom_v2ray_extra_day_toman")) || 0));
    const minPrice = Math.max(1, pricePerGb + 30 * dayPrice);
    const baseConfig = { product_kind: "v2ray", custom_v2ray_product: true, expire_days: 30, data_limit_mb: 1024 };
    let productId = Number((await getSetting("custom_v2ray_product_id")) || 0);
    try {
        if (Number.isFinite(productId) && productId > 0) {
            const existing = await sql `SELECT id FROM products WHERE id = ${productId} LIMIT 1;`;
            if (existing.length) {
                await sql `
          UPDATE products
          SET name = ${name},
              size_mb = 1024,
              price_toman = ${minPrice},
              is_active = TRUE,
              panel_config = COALESCE(panel_config, '{}'::jsonb) || ${JSON.stringify(baseConfig)}::jsonb
          WHERE id = ${productId};
        `;
                return { ok: true, productId };
            }
        }
        const byName = await sql `SELECT id FROM products WHERE name = ${name} LIMIT 1;`;
        if (byName.length) {
            productId = Number(byName[0].id);
            await sql `
        UPDATE products
        SET size_mb = 1024,
            price_toman = ${minPrice},
            is_active = TRUE,
            panel_config = COALESCE(panel_config, '{}'::jsonb) || ${JSON.stringify(baseConfig)}::jsonb
        WHERE id = ${productId};
      `;
            await setSetting("custom_v2ray_product_id", String(productId));
            return { ok: true, productId };
        }
        const inserted = await sql `
      INSERT INTO products (name, size_mb, price_toman, is_active, is_infinite, sell_mode, panel_config)
      VALUES (${name}, 1024, ${minPrice}, TRUE, FALSE, 'manual', ${JSON.stringify(baseConfig)}::jsonb)
      RETURNING id;
    `;
        productId = Number(inserted[0].id);
        await setSetting("custom_v2ray_product_id", String(productId));
        return { ok: true, productId };
    }
    catch (error) {
        logError("ensure_custom_v2ray_product_failed", error, { productId });
        return { ok: false, productId: 0 };
    }
}
async function startCustomV2rayWizard(chatId, userId, productId) {
    const enabled = await getBoolSetting("custom_v2ray_enabled", false);
    const selectedProductId = Number((await getSetting("custom_v2ray_product_id")) || 0);
    if (!enabled || !selectedProductId || selectedProductId !== productId) {
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ╪│┘ü╪º╪▒╪┤█î ┘ü╪╣╪º┘ä ┘å█î╪│╪¬ █î╪º ╪»╪▒╪│╪¬ ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬." });
        return null;
    }
    const rows = await sql `
    SELECT id, name, price_toman, size_mb, is_infinite, sell_mode, panel_id, panel_delivery_mode, panel_config
    FROM products
    WHERE id = ${productId} AND is_active = TRUE
    LIMIT 1;
  `;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪»." });
        return null;
    }
    const product = rows[0];
    if (getV2rayProductKindFromRow(product) !== "v2ray") {
        await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┘à╪¡╪╡┘ê┘ä ╪│┘ü╪º╪▒╪┤█î ┘å█î╪│╪¬." });
        return null;
    }
    const minGb = Math.max(1, Math.round((await getNumberSetting("custom_v2ray_min_gb")) || 1));
    const minDays = Math.max(1, Math.round((await getNumberSetting("custom_v2ray_min_days")) || 30));
    const baseMb = minGb * 1024;
    const baseDays = minDays;
    const pricePerGb = normalizePricePerGb(await getSetting("product_price_per_gb_toman"), normalizePricePerGb(await getSetting("topup_price_per_gb_toman")));
    const dayPrice = Math.max(0, Math.round((await getNumberSetting("custom_v2ray_extra_day_toman")) || 0));
    const statePayload = {
        productId,
        baseMb,
        baseDays,
        dataMb: baseMb,
        days: baseDays,
        pricePerGb,
        dayPrice,
        quantity: 1,
        messageId: 0
    };
    await setState(userId, "custom_v2ray_wizard", statePayload);
    await renderCustomV2rayWizard(chatId, userId);
}
async function renderCustomV2rayWizard(chatId, userId, messageId) {
    const state = await getState(userId);
    if (!state || state.state !== "custom_v2ray_wizard")
        return null;
    const p = state.payload || {};
    const productId = Number(p.productId);
    if (!Number.isFinite(productId) || isNaN(productId)) {
        // Fallback if somehow state is corrupt
        return null;
    }
    const baseMb = Math.max(1, Math.round(Number(p.baseMb || 1024)));
    const baseDays = Math.max(1, Math.round(Number(p.baseDays || 30)));
    const dataMb = Math.max(baseMb, Math.round(Number(p.dataMb || baseMb)));
    const days = Math.max(baseDays, Math.round(Number(p.days || baseDays)));
    const pricePerGb = Math.max(1, Math.round(Number(p.pricePerGb || 500000)));
    const dayPrice = Math.max(0, Math.round(Number(p.dayPrice || 0)));
    const quantity = Math.max(1, Math.round(Number(p.quantity || 1)));
    const gb = Math.max(1, Math.round(dataMb / 1024));
    const unitPrice = Math.max(1, gb * pricePerGb + days * dayPrice);
    const totalPrice = unitPrice * quantity;
    const rows = await sql `SELECT name FROM products WHERE id = ${productId} LIMIT 1;`;
    const productName = rows.length ? String(rows[0].name || "-") : "-";
    const text = `≡ƒÄü ┘ü╪º┌⌐╪¬┘ê╪▒ ╪«╪▒█î╪» [${days} ╪▒┘ê╪▓╪î ${gb} ┌»█î┌»╪º╪¿╪º█î╪¬]\n\n` +
        `≡ƒö╕ ┘à╪¡╪╡┘ê┘ä: ${productName}\n` +
        `≡ƒö╕ ╪¡╪¼┘à: ${gb} ┌»█î┌»╪º╪¿╪º█î╪¬\n` +
        `≡ƒö╕ ╪▓┘à╪º┘å: ${days} ╪▒┘ê╪▓\n` +
        `≡ƒö╕ ╪¬╪╣╪»╪º╪» ┌⌐╪º┘å┘ü█î┌»: ${quantity} ╪╣╪»╪»\n\n` +
        `≡ƒÆ░ ┘à╪¿┘ä╪║: ${formatPriceToman(totalPrice)} ╪¬┘ê┘à╪º┘å${quantity > 1 ? ` (${quantity} ├ù ${formatPriceToman(unitPrice)})` : ""}\n\n` +
        `≡ƒôî ┘é█î┘à╪¬ΓÇî┘ç╪º:\n` +
        `- ┘ç╪▒ 1GB: ${formatPriceToman(pricePerGb)} ╪¬┘ê┘à╪º┘å\n` +
        `- ┘ç╪▒ ╪▒┘ê╪▓: ${formatPriceToman(dayPrice)} ╪¬┘ê┘à╪º┘å\n\n` +
        `≡ƒÆí ┘å┌⌐╪¬┘ç: ╪¿╪╣╪» ╪º╪▓ ┘╛╪▒╪»╪º╪«╪¬╪î ┌⌐╪º┘å┘ü█î┌» ╪¿╪▒ ╪º╪│╪º╪│ ┘ç┘à█î┘å ╪¡╪¼┘à ┘ê ╪▓┘à╪º┘å ╪│╪º╪«╪¬┘ç ┘à█îΓÇî╪┤┘ê╪».`;
    const keyboard = [];
    keyboard.push([
        cb("┌⌐╪º┘ç╪┤ -", "custom_v2ray_dec_data", "primary"),
        cb(`${gb} ┌»█î┌»╪º╪¿╪º█î╪¬`, "noop_custom_gb"),
        cb("╪º┘ü╪▓╪º█î╪┤ +", "custom_v2ray_inc_data", "primary")
    ]);
    keyboard.push([
        cb("┌⌐╪º┘ç╪┤ -", "custom_v2ray_dec_days", "primary"),
        cb(`${days} ╪▒┘ê╪▓`, "noop_custom_days"),
        cb("╪º┘ü╪▓╪º█î╪┤ +", "custom_v2ray_inc_days", "primary")
    ]);
    keyboard.push([
        cb("┌⌐╪º┘ç╪┤ -", "custom_v2ray_dec_count", "primary"),
        cb(`${quantity} ╪╣╪»╪»`, "noop_custom_count"),
        cb("╪º┘ü╪▓╪º█î╪┤ +", "custom_v2ray_inc_count", "primary")
    ]);
    keyboard.push([confirmButton(`custom_v2ray_confirm`, "Γ£à ╪¬╪º█î█î╪» ┘ê ┘╛╪▒╪»╪º╪«╪¬")]);
    keyboard.push([backButton("buy_menu")]);
    const targetMessageId = Number(messageId || p.messageId || 0);
    if (targetMessageId > 0) {
        await tg("editMessageText", { chat_id: chatId, message_id: targetMessageId, text, reply_markup: { inline_keyboard: keyboard } }).catch((e) => {
            logError("custom_v2ray_edit_failed", e, { userId, chatId, messageId: targetMessageId });
        });
        return null;
    }
    const msg = await tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } });
    await setState(userId, "custom_v2ray_wizard", { ...p, messageId: Number(msg?.message_id || 0), dataMb, days, quantity });
}
async function computeCustomV2rayCheckout(userId) {
    const state = await getState(userId);
    if (!state || state.state !== "custom_v2ray_wizard")
        return null;
    const p = state.payload || {};
    const baseMb = Math.max(1, Math.round(Number(p.baseMb || 1024)));
    const baseDays = Math.max(1, Math.round(Number(p.baseDays || 30)));
    const dataMb = Math.max(baseMb, Math.round(Number(p.dataMb || baseMb)));
    const days = Math.max(baseDays, Math.round(Number(p.days || baseDays)));
    const pricePerGb = Math.max(1, Math.round(Number(p.pricePerGb || 500000)));
    const dayPrice = Math.max(0, Math.round(Number(p.dayPrice || 0)));
    const quantity = Math.max(1, Math.round(Number(p.quantity || 1)));
    const gb = Math.max(1, Math.round(dataMb / 1024));
    const unitPrice = Math.max(1, gb * pricePerGb + days * dayPrice);
    const totalPrice = unitPrice * quantity;
    return {
        productId: Number(p.productId),
        baseMb,
        baseDays,
        dataMb,
        days,
        quantity,
        totalPrice
    };
}
async function showCustomWalletUsagePrompt(chatId, userId, totalPrice) {
    const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
    const walletBalance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
    const maxUsable = Math.min(walletBalance, totalPrice);
    if (maxUsable <= 0) {
        await showCustomPaymentMethods(chatId, userId, totalPrice, 0);
        return null;
    }
    const keyboard = [
        [cb(`Γ£à ╪º╪│╪¬┘ü╪º╪»┘ç ╪º╪▓ ╪¡╪»╪º┌⌐╪½╪▒ ┘à┘à┌⌐┘å (${formatPriceToman(maxUsable)} ╪¬┘ê┘à╪º┘å)`, `custom_v2ray_use_wallet_${maxUsable}`, "success")],
        [cb("Γ£ì∩╕Å ┘ê╪▒┘ê╪» ┘à╪¿┘ä╪║ ╪»┘ä╪«┘ê╪º┘ç", `custom_v2ray_use_wallet_custom`, "primary")],
        [cb("Γ¥î ╪¿╪»┘ê┘å ╪º╪│╪¬┘ü╪º╪»┘ç ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä", `custom_v2ray_use_wallet_0`, "danger")],
        [homeButton()]
    ];
    await tg("sendMessage", {
        chat_id: chatId,
        text: `┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä: ${formatPriceToman(walletBalance)} ╪¬┘ê┘à╪º┘å\n┌å┘ç ┘à┘é╪»╪º╪▒ ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪│╪▒ ╪┤┘ê╪»╪ƒ`,
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function showCustomPaymentMethods(chatId, userId, totalPrice, walletUsed) {
    const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
    const walletBalance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
    const safeWalletUsed = Math.max(0, Math.min(walletUsed, walletBalance, totalPrice));
    const finalPayable = Math.max(0, totalPrice - safeWalletUsed);
    const rows = await sql `SELECT code, title FROM payment_methods WHERE active = TRUE ORDER BY code ASC;`;
    const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
    const hasCards = (await sql `SELECT 1 FROM cards WHERE active = TRUE LIMIT 1;`).length > 0;
    const hasPlisioKey = Boolean(((await getSetting("plisio_api_key")) || "").trim());
    const hasTetrapayKey = Boolean(((await getSetting("tetrapay_api_key")) || "").trim());
    const hasTronadoKey = Boolean(((await getSetting("tronado_api_key")) || "").trim());
    const hasSwapwalletKey = Boolean(((await getSetting("swapwallet_api_key")) || "").trim());
    const hasSwapwalletShop = Boolean(((await getSetting("swapwallet_shop_username")) || "").trim());
    const hasBusinessWallet = Boolean(((await getSetting("business_wallet_address")) || env.BUSINESS_WALLET_ADDRESS || "").trim());
    const cryptoWalletRows = await getActiveCryptoWallets();
    const hasCrypto = cryptoWalletRows.some(cryptoWalletReady);
    const filtered = rows.filter((m) => {
        const code = String(m.code);
        if (code === "card2card")
            return hasCards;
        if (code === "plisio")
            return Boolean(callbackBase) && hasPlisioKey;
        if (code === "tetrapay")
            return Boolean(callbackBase) && hasTetrapayKey;
        if (code === "tronado")
            return Boolean(callbackBase) && hasTronadoKey && hasBusinessWallet;
        if (code === "swapwallet")
            return Boolean(callbackBase) && hasSwapwalletKey && hasSwapwalletShop;
        if (code === "crypto")
            return hasCrypto;
        return true;
    });
    if (!filtered.length && finalPayable > 0) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ü╪╣┘ä╪º┘ï ┘ç█î┌å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬█î ┌⌐┘ç ╪»╪▒╪│╪¬ ╪¬┘å╪╕█î┘à ╪┤╪»┘ç ╪¿╪º╪┤╪» ╪»╪▒ ╪»╪│╪¬╪▒╪│ ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
        await notifyAdmins(`ΓÜá∩╕Å ┘ç█î┌å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬█î ╪¿╪▒╪º█î ╪│┘ü╪º╪▒╪┤ ╪│┘ü╪º╪▒╪┤█î ┘╛█î╪»╪º ┘å╪┤╪»\n` +
            `user:${userId}\n` +
            `finalPayable:${finalPayable}\n` +
            `hasCards:${hasCards}\n` +
            `callbackBase:${callbackBase ? "ok" : "missing"}\n` +
            `plisioKey:${hasPlisioKey ? "ok" : "missing"}\n` +
            `tetrapayKey:${hasTetrapayKey ? "ok" : "missing"}\n` +
            `tronadoKey:${hasTronadoKey ? "ok" : "missing"}\n` +
            `swapwalletKey:${hasSwapwalletKey ? "ok" : "missing"}\n` +
            `swapwalletShop:${hasSwapwalletShop ? "ok" : "missing"}\n` +
            `businessWallet:${hasBusinessWallet ? "ok" : "missing"}\n` +
            `cryptoReady:${hasCrypto ? "ok" : "missing"}`, { inline_keyboard: [[{ text: "ΓÜÖ∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ ╪»╪▒┌»╪º┘çΓÇî┘ç╪º", callback_data: "admin_gateway_settings" }]] });
        return null;
    }
    const keyboard = [];
    if (safeWalletUsed >= totalPrice) {
        keyboard.push([cb(`≡ƒÆ░ ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪º┘à┘ä ╪¿╪º ┌⌐█î┘ü ┘╛┘ê┘ä (${formatPriceToman(totalPrice)} ╪¬┘ê┘à╪º┘å)`, `custom_v2ray_select_pay_wallet_${safeWalletUsed}`, "success")]);
    }
    else {
        for (const m of filtered) {
            keyboard.push([cb(String(m.title), `custom_v2ray_select_pay_${m.code}_${safeWalletUsed}`, "primary")]);
        }
    }
    keyboard.push([homeButton()]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: safeWalletUsed > 0 && safeWalletUsed < totalPrice
            ? `┘à╪¿┘ä╪║ ${formatPriceToman(safeWalletUsed)} ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪│╪▒ ╪«┘ê╪º┘ç╪» ╪┤╪».\n┘à╪¿┘ä╪║ ╪¿╪º┘é█î┘à╪º┘å╪»┘ç ╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬: ${formatPriceToman(finalPayable)} ╪¬┘ê┘à╪º┘å\n┘ä╪╖┘ü╪º┘ï ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º┘é█î┘à╪º┘å╪»┘ç ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`
            : "╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function showDiscountChoiceCustom(chatId, productId, paymentMethod, walletUsed) {
    await tg("sendMessage", {
        chat_id: chatId,
        text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»╪º╪▒█î╪»╪ƒ",
        reply_markup: {
            inline_keyboard: [
                [confirmButton(`custom_discount_yes_${productId}_${paymentMethod}_${walletUsed}`, "Γ£à ╪¿┘ä┘ç")],
                [cb("Γ¥î ┘å╪»╪º╪▒┘à", `custom_discount_no_${productId}_${paymentMethod}_${walletUsed}`, "primary")],
                [homeButton()]
            ]
        }
    });
}
async function showDiscountChoice(chatId, productId, paymentMethod, walletUsed = 0) {
    await tg("sendMessage", {
        chat_id: chatId,
        text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»╪º╪▒█î╪»╪ƒ",
        reply_markup: {
            inline_keyboard: [
                [confirmButton(`discount_yes_${productId}_${paymentMethod}_${walletUsed}`, "Γ£à ╪¿┘ä┘ç")],
                [cb("Γ¥î ┘å╪»╪º╪▒┘à", `discount_no_${productId}_${paymentMethod}_${walletUsed}`, "primary")],
                [homeButton()]
            ]
        }
    });
}
async function parseAndApplyState(chatId, userId, text, photoFileId, stickerFileId, animationFileId, state) {
    if (state.state === "await_bulk_quantity") {
        const quantity = Number(text.trim());
        if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¬╪╣╪»╪º╪» ╪¿╪º█î╪» ╪╣╪»╪»█î ╪¿█î┘å 1 ╪¬╪º 100 ╪¿╪º╪┤╪»." });
            return true;
        }
        const productId = Number(state.payload?.productId || 0);
        await setState(userId, "await_config_name", { productId, quantity });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¿╪▒╪º█î ${quantity} ╪╣╪»╪»${quantity > 1 ? " ╪º╪▓" : ""} ┘à╪¡╪╡┘ê┘ä █î┌⌐ ┘å╪º┘à ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:\n(╪º┌»╪▒ ┘å╪º┘à ╪¬┌⌐╪▒╪º╪▒█î ╪¿╪º╪┤╪»╪î ╪╣╪»╪» ╪¬╪╡╪º╪»┘ü█î ╪º╪╢╪º┘ü┘ç ┘à█îΓÇî╪┤┘ê╪»)\n\n┘à╪½╪º┘ä: config1, myVPN, etc`
        });
        return true;
    }
    if (state.state === "await_config_name") {
        const configName = text.trim();
        if (!configName || configName.length < 1 || configName.length > 50) {
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ╪¿╪º█î╪» ╪¿█î┘å 1 ╪¬╪º 50 ┌⌐╪º╪▒╪º┌⌐╪¬╪▒ ╪¿╪º╪┤╪»." });
            return true;
        }
        const productId = Number(state.payload?.productId || 0);
        const quantity = Number(state.payload?.quantity || 1);
        await clearState(userId);
        const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
        const walletBalance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
        if (walletBalance > 0) {
            await setState(userId, "bulk_purchase_pending", { productId, quantity, configName });
            await showWalletUsagePrompt(chatId, userId, productId, walletBalance);
        }
        else {
            await setState(userId, "bulk_purchase_pending", { productId, quantity, configName });
            await showPaymentMethods(chatId, userId, productId, 0);
        }
        return true;
    }
    if (state.state === "await_wallet_custom_amount") {
        const productId = Number(state.payload.productId);
        const amount = Number(text.trim());
        if (!Number.isFinite(amount) || amount <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┘ê╪º╪▒╪» ╪┤╪»┘ç ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return true;
        }
        const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
        const walletBalance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
        const productRows = await sql `SELECT price_toman FROM products WHERE id = ${productId} LIMIT 1;`;
        if (!productRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return true;
        }
        const productPrice = Number(productRows[0].price_toman || 0);
        if (amount > walletBalance) {
            await tg("sendMessage", { chat_id: chatId, text: `┘à┘ê╪¼┘ê╪»█î ╪┤┘à╪º ┌⌐╪º┘ü█î ┘å█î╪│╪¬ (┘à┘ê╪¼┘ê╪»█î ┘ü╪╣┘ä█î: ${formatPriceToman(walletBalance)} ╪¬┘ê┘à╪º┘å). ┘ä╪╖┘ü╪º┘ï ┘à╪¿┘ä╪║ ┌⌐┘à╪¬╪▒█î ┘ê╪º╪▒╪» ┌⌐┘å█î╪»:` });
            return true;
        }
        if (amount > productPrice) {
            await tg("sendMessage", { chat_id: chatId, text: `┘à╪¿┘ä╪║ ┘ê╪º╪▒╪» ╪┤╪»┘ç ╪º╪▓ ┘é█î┘à╪¬ ┘à╪¡╪╡┘ê┘ä ╪¿█î╪┤╪¬╪▒ ╪º╪│╪¬. ╪¡╪»╪º┌⌐╪½╪▒ ┘à╪¿┘ä╪║ ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ${formatPriceToman(productPrice)} ╪¬┘ê┘à╪º┘å ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ┘à╪¼╪»╪»╪º┘ï ┘ê╪º╪▒╪» ┌⌐┘å█î╪»:` });
            return true;
        }
        await clearState(userId);
        await showPaymentMethods(chatId, userId, productId, amount);
        return true;
    }
    if (state.state === "await_custom_v2ray_name") {
        const configName = text.trim();
        if (!configName || configName.length < 1 || configName.length > 50) {
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ╪¿╪º█î╪» ╪¿█î┘å 1 ╪¬╪º 50 ┌⌐╪º╪▒╪º┌⌐╪¬╪▒ ╪¿╪º╪┤╪»." });
            return true;
        }
        const checkout = sanitizePanelConfig(state.payload.checkout);
        if (!checkout || !checkout.productId) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪│┘ü╪º╪▒╪┤ ╪│┘ü╪º╪▒╪┤█î ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º┘ê┘ä ╪┤╪▒┘ê╪╣ ┌⌐┘å." });
            return true;
        }
        const quantity = Math.max(1, Math.round(Number(checkout.quantity || 1)));
        // For quantity > 1, generate multiple unique names based on base name
        let configNames = [];
        const sharedRandom = Math.floor(Math.random() * 100) + 1;
        for (let i = 1; i <= quantity; i++) {
            configNames.push(await generateUniqueConfigName(configName, userId, quantity, i, sharedRandom));
        }
        const checkoutWithName = { ...checkout, configName: configNames[0], configNames };
        await clearState(userId);
        await setState(userId, "custom_v2ray_checkout", checkoutWithName);
        await showCustomWalletUsagePrompt(chatId, userId, checkout.totalPrice);
        return true;
    }
    if (state.state === "await_custom_wallet_amount") {
        const amount = Number(text.trim());
        if (!Number.isFinite(amount) || amount < 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┘ê╪º╪▒╪» ╪┤╪»┘ç ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return true;
        }
        const checkout = sanitizePanelConfig(state.payload.checkout);
        const totalPrice = Math.max(1, Math.round(Number(checkout.totalPrice || 0)));
        const productId = Number(checkout.productId || 0);
        if (!Number.isFinite(productId) || productId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪│┘ü╪º╪▒╪┤ ╪│┘ü╪º╪▒╪┤█î ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º┘ê┘ä ╪┤╪▒┘ê╪╣ ┌⌐┘å." });
            return true;
        }
        const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
        const walletBalance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
        if (amount > walletBalance) {
            await tg("sendMessage", { chat_id: chatId, text: `┘à┘ê╪¼┘ê╪»█î ╪┤┘à╪º ┌⌐╪º┘ü█î ┘å█î╪│╪¬ (┘à┘ê╪¼┘ê╪»█î ┘ü╪╣┘ä█î: ${formatPriceToman(walletBalance)} ╪¬┘ê┘à╪º┘å).` });
            return true;
        }
        if (amount > totalPrice) {
            await tg("sendMessage", { chat_id: chatId, text: `┘à╪¿┘ä╪║ ┘ê╪º╪▒╪» ╪┤╪»┘ç ╪º╪▓ ┘à╪¿┘ä╪║ ╪│┘ü╪º╪▒╪┤ ╪¿█î╪┤╪¬╪▒ ╪º╪│╪¬. ╪¡╪»╪º┌⌐╪½╪▒ ${formatPriceToman(totalPrice)} ╪¬┘ê┘à╪º┘å.` });
            return true;
        }
        await clearState(userId);
        await setState(userId, "custom_v2ray_checkout", checkout);
        await showCustomPaymentMethods(chatId, userId, totalPrice, amount);
        return true;
    }
    if (state.state === "await_wallet_charge_amount") {
        const amount = Number(text.trim());
        if (!Number.isFinite(amount) || amount < 10000) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┘ê╪º╪▒╪» ╪┤╪»┘ç ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. ╪¡╪»╪º┘é┘ä ┘à╪¿┘ä╪║ 10,000 ╪¬┘ê┘à╪º┘å ╪º╪│╪¬." });
            return true;
        }
        const surcharge = await getPurchaseSurcharge();
        const finalAmount = amount + surcharge;
        await setState(userId, "await_wallet_charge_method", { amount: finalAmount });
        const methods = await sql `SELECT code, title FROM payment_methods WHERE active = TRUE;`;
        const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        const hasCards = (await sql `SELECT 1 FROM cards WHERE active = TRUE LIMIT 1;`).length > 0;
        const hasPlisioKey = Boolean(((await getSetting("plisio_api_key")) || "").trim());
        const hasTetrapayKey = Boolean(((await getSetting("tetrapay_api_key")) || "").trim());
        const hasTronadoKey = Boolean(((await getSetting("tronado_api_key")) || "").trim());
        const hasSwapwalletKey = Boolean(((await getSetting("swapwallet_api_key")) || "").trim());
        const hasSwapwalletShop = Boolean(((await getSetting("swapwallet_shop_username")) || "").trim());
        const hasBusinessWallet = Boolean(((await getSetting("business_wallet_address")) || env.BUSINESS_WALLET_ADDRESS || "").trim());
        const cryptoWalletRows = await getActiveCryptoWallets();
        const hasCrypto = cryptoWalletRows.some(cryptoWalletReady);
        const filtered = methods.filter((m) => {
            const code = String(m.code);
            if (code === "card2card")
                return hasCards;
            if (code === "plisio")
                return Boolean(callbackBase) && hasPlisioKey;
            if (code === "tetrapay")
                return Boolean(callbackBase) && hasTetrapayKey;
            if (code === "tronado")
                return Boolean(callbackBase) && hasTronadoKey && hasBusinessWallet;
            if (code === "swapwallet")
                return Boolean(callbackBase) && hasSwapwalletKey && hasSwapwalletShop;
            if (code === "crypto")
                return hasCrypto;
            return true;
        });
        if (!filtered.length) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪╣┘ä╪º┘ï ┘ç█î┌å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬█î ╪¿╪▒╪º█î ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ╪»╪▒ ╪»╪│╪¬╪▒╪│ ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪».",
                reply_markup: { inline_keyboard: [[backButton("wallet_menu", "≡ƒöÖ ╪¿╪º╪▓┌»╪┤╪¬")]] }
            });
            await notifyAdmins(`ΓÜá∩╕Å ┘ç█î┌å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬█î ╪¿╪▒╪º█î ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»\n` +
                `user:${userId}\n` +
                `amount:${amount}\n` +
                `hasCards:${hasCards}\n` +
                `callbackBase:${callbackBase ? "ok" : "missing"}\n` +
                `plisioKey:${hasPlisioKey ? "ok" : "missing"}\n` +
                `tetrapayKey:${hasTetrapayKey ? "ok" : "missing"}\n` +
                `tronadoKey:${hasTronadoKey ? "ok" : "missing"}\n` +
                `swapwalletKey:${hasSwapwalletKey ? "ok" : "missing"}\n` +
                `swapwalletShop:${hasSwapwalletShop ? "ok" : "missing"}\n` +
                `businessWallet:${hasBusinessWallet ? "ok" : "missing"}\n` +
                `cryptoReady:${hasCrypto ? "ok" : "missing"}`, { inline_keyboard: [[{ text: "ΓÜÖ∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ ╪»╪▒┌»╪º┘çΓÇî┘ç╪º", callback_data: "admin_gateway_settings" }]] });
            return true;
        }
        const buttons = filtered.map((m) => [cb(String(m.title), `wallet_charge_method_${m.code}`, "primary")]);
        buttons.push([backButton("wallet_menu", "≡ƒöÖ ╪¿╪º╪▓┌»╪┤╪¬")]);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¿┘ä╪║ ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å.\n┘ä╪╖┘ü╪º┘ï ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
            reply_markup: { inline_keyboard: buttons }
        });
        return true;
    }
    if (state.state === "await_order_lookup") {
        const purchaseId = text.trim();
        if (!purchaseId || purchaseId.length < 4) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ╪│┘ü╪º╪▒╪┤ ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▒╪│╪º┘ä ┌⌐┘å." });
            return true;
        }
        await clearState(userId);
        await showOrderDetails(chatId, userId, purchaseId);
        return true;
    }
    if (state.state === "await_migration_sublink") {
        const subLink = text.trim();
        if (!subLink) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ┘ä█î┘å┌⌐ █î╪º ┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┌⌐╪º┘å┘ü█î┌» ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
            return true;
        }
        await tg("sendMessage", { chat_id: chatId, text: "ΓÅ│ ╪»╪▒ ╪¡╪º┘ä ╪¼╪│╪¬╪¼┘ê ╪▒┘ê█î ┘╛┘å┘äΓÇî┘ç╪º ┘ê ╪¿┌⌐╪º┘╛ΓÇî┘ç╪º..." });
        const hit = await lookupIdentifierInPanels(subLink, { includeInactive: true });
        if (!hit.ok) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "Γ¥î ┌⌐╪º┘å┘ü█î┌»█î ╪¿╪º ╪º█î┘å ┘ä█î┘å┌⌐/┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┘╛█î╪»╪º ┘å╪┤╪».\n╪º┌»╪▒ ╪¿┌⌐╪º┘╛ ╪º█î┘å╪¿╪º┘å╪» ╪ó┘╛┘ä┘ê╪» ┘å╪┤╪»┘ç╪î ╪º╪▓ ╪º╪»┘à█î┘å ╪¿╪«┘ê╪º┘ç█î╪» ╪ó┘╛┘ä┘ê╪» ┌⌐┘å╪» ╪│┘╛╪│ ╪»┘ê╪¿╪º╪▒┘ç ╪º┘à╪¬╪¡╪º┘å ┌⌐┘å█î╪».\n\n█î╪º /cancel ╪¿╪▒╪º█î ┘ä╪║┘ê."
            });
            return true;
        }
        const panelUser = hit.panelUser;
        let remainingBytes = 0;
        let expireMs = 0;
        if (isMarzbanLike(hit.panelType)) {
            const dataLimit = Number(panelUser.data_limit || 0);
            const usedTraffic = Number(panelUser.used_traffic || panelUser.usedTraffic || 0);
            remainingBytes = dataLimit > 0 ? Math.max(0, dataLimit - usedTraffic) : 0;
            const expireSec = Number(panelUser.expire || 0);
            expireMs = expireSec > 0 ? expireSec * 1000 : 0;
        }
        else {
            const totalBytes = Number(panelUser.totalGB || 0);
            remainingBytes = totalBytes > 0 ? Math.max(0, totalBytes - Number(panelUser.up || 0) - Number(panelUser.down || 0)) : 0;
            expireMs = Number(panelUser.expiryTime || 0);
        }
        if (remainingBytes <= 0) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "ΓÜá∩╕Å ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¡╪¼┘à ╪¿╪º┘é█îΓÇî┘à╪º┘å╪»┘çΓÇî╪º█î ┘å╪»╪º╪▒╪» █î╪º ┘å╪º┘à╪¡╪»┘ê╪» ╪º╪│╪¬.\n╪º┘å╪¬┘é╪º┘ä ┘à╪│╪»┘ê╪» ╪┤╪» ╪¬╪º ╪º╪▓ ╪º█î╪¼╪º╪» ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪¡╪»┘ê╪» ╪¼┘ä┘ê┌»█î╪▒█î ╪┤┘ê╪»."
            });
            await clearState(userId);
            return true;
        }
        const remainingGb = (remainingBytes / (1024 * 1024 * 1024)).toFixed(2);
        const remainingDays = expireMs > Date.now() ? Math.ceil((expireMs - Date.now()) / 86400000) : 0;
        // Store lookup result and advance to panel-selection state
        await clearState(userId);
        await setState(userId, "sublink_migration_pending", {
            subLink,
            sourcePanelId: hit.panelId,
            sourcePanelName: hit.panelName,
            sourcePanelType: hit.panelType,
            sourceUserKey: hit.panelUserKey,
            remainingBytes,
            expireMs
        });
        const targetPanels = await sql `
      SELECT id, name, panel_type FROM panels
      WHERE active = TRUE AND allow_customer_migration = TRUE
      ORDER BY priority DESC, id ASC;
    `;
        if (!targetPanels.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ┘ü╪╣┘ä╪º┘ï ┘╛┘å┘ä ┘à┘é╪╡╪» ┘ü╪╣╪º┘ä█î ╪¿╪▒╪º█î ╪º┘å╪¬┘é╪º┘ä ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪». ╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪»." });
            return true;
        }
        const targetKeyboard = targetPanels.map((p) => [
            { text: `${p.name} (${String(p.panel_type).toUpperCase()})`, callback_data: `sublink_migrate_pick_${p.id}` }
        ]);
        targetKeyboard.push([homeButton()]);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `Γ£à ┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ╪┤╪»!\n≡ƒôì ┘╛┘å┘ä ┘ü╪╣┘ä█î: ${hit.panelName}\n≡ƒÆ╛ ╪¡╪¼┘à ╪¿╪º┘é█îΓÇî┘à╪º┘å╪»┘ç: ${remainingGb} GB\n≡ƒôà ╪º┘å┘é╪╢╪º: ${remainingDays > 0 ? remainingDays + " ╪▒┘ê╪▓" : "┘à┘å┘é╪╢█îΓÇî╪┤╪»┘ç"}\n\n≡ƒÄ» ┘╛┘å┘ä ┘à┘é╪╡╪» ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
            reply_markup: { inline_keyboard: targetKeyboard }
        });
        return true;
    }
    if (state.state === "await_crypto_receipt" && state.payload.purchaseId) {
        if (!photoFileId) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
            return true;
        }
        const purchaseId = String(state.payload.purchaseId || "").trim();
        const rows = await sql `
      UPDATE orders
      SET receipt_file_id = ${photoFileId}, status = 'receipt_submitted'
      WHERE purchase_id = ${purchaseId}
        AND telegram_id = ${userId}
        AND status = 'pending'
        AND payment_method = 'crypto'
      RETURNING id, purchase_id, product_name_snapshot, panel_delivery_mode, final_price, crypto_currency, crypto_network, crypto_amount, crypto_address;
    `;
        await clearState(userId);
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪» █î╪º ┘é╪º╪¿┘ä ╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ┘å█î╪│╪¬." });
            return true;
        }
        const orderId = Number(rows[0].id);
        await tg("sendMessage", { chat_id: chatId, text: "╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ╪½╪¿╪¬ ╪┤╪» Γ£à\n╪¿╪╣╪» ╪º╪▓ ╪¿╪▒╪▒╪│█î ╪º╪»┘à█î┘å╪î ╪│┘ü╪º╪▒╪┤ ╪¬┌⌐┘à█î┘ä ┘à█îΓÇî╪┤┘ê╪»." });
        const profileRows = await sql `
      SELECT username, first_name, last_name
      FROM users
      WHERE telegram_id = ${userId}
      LIMIT 1;
    `;
        const tgUsername = profileRows.length && profileRows[0].username ? `@${String(profileRows[0].username)}` : "-";
        const tgFullName = [profileRows[0]?.first_name, profileRows[0]?.last_name].filter(Boolean).join(" ").trim() || "-";
        const directCryptoDeliveryLabel = formatDeliveryModeLabel(parseDeliveryMode(String(rows[0].panel_delivery_mode || "")));
        const caption = `≡ƒ¬Ö ╪»╪▒╪«┘ê╪º╪│╪¬ ╪¬╪º█î█î╪» ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪▒█î┘╛╪¬┘ê\n` +
            `╪│┘ü╪º╪▒╪┤: ${rows[0].purchase_id}\n` +
            `┌⌐╪º╪▒╪¿╪▒: ${userId}\n` +
            `█î┘ê╪▓╪▒┘å█î┘à: ${tgUsername}\n` +
            `┘å╪º┘à: ${tgFullName}\n` +
            `┘à╪¡╪╡┘ê┘ä: ${rows[0].product_name_snapshot || "-"}\n` +
            `╪¬╪¡┘ê█î┘ä: ${directCryptoDeliveryLabel}\n` +
            `┘à╪¿┘ä╪║: ${formatPriceToman(Number(rows[0].final_price))} ╪¬┘ê┘à╪º┘å\n` +
            `╪º╪▒╪▓: ${rows[0].crypto_currency || "-"}\n` +
            `╪┤╪¿┌⌐┘ç: ${rows[0].crypto_network || "-"}\n` +
            `┘à┘é╪»╪º╪▒: ${rows[0].crypto_amount || "-"}\n` +
            `╪ó╪»╪▒╪│: ${shortAddr(String(rows[0].crypto_address || ""))}`;
        for (const adminId of await getAdminIds()) {
            await tg("sendPhoto", {
                photo: photoFileId,
                caption,
                reply_markup: {
                    inline_keyboard: [
                        [confirmButton(`crypto_accept_${orderId}`, "Γ£à ╪¬╪º█î█î╪»")],
                        [cancelButton(`crypto_deny_${orderId}`, "Γ¥î ╪▒╪»")]
                    ]
                }
            }).catch(() => { });
        }
        return true;
    }
    if (state.state === "await_wallet_receipt") {
        if (!photoFileId) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪¬╪╡┘ê█î╪▒ ╪▒╪│█î╪» ╪┤╪º╪▒┌ÿ ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
            return true;
        }
        const topupId = Number(state.payload.topupId);
        const rows = await sql `
      UPDATE wallet_topups
      SET receipt_file_id = ${photoFileId}, status = 'receipt_submitted'
      WHERE id = ${topupId}
      RETURNING id, amount, payment_method, crypto_network, crypto_address, crypto_amount;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪»╪▒╪«┘ê╪º╪│╪¬ ╪┤╪º╪▒┌ÿ █î╪º┘ü╪¬ ┘å╪┤╪»." });
            await clearState(userId);
            return true;
        }
        const profileRows = await sql `
      SELECT username, first_name, last_name
      FROM users
      WHERE telegram_id = ${userId}
      LIMIT 1;
    `;
        const username = profileRows.length && profileRows[0].username ? `@${String(profileRows[0].username)}` : "-";
        const fullName = [profileRows[0]?.first_name, profileRows[0]?.last_name].filter(Boolean).join(" ").trim() || "-";
        const paymentMethod = String(rows[0].payment_method || "");
        const paymentLabel = paymentMethod === "tronado"
            ? "Tronado"
            : paymentMethod === "tetrapay"
                ? "╪¬╪¬╪▒╪º┘╛█î"
                : paymentMethod === "plisio"
                    ? "Plisio"
                    : paymentMethod === "crypto"
                        ? "┌⌐╪▒█î┘╛╪¬┘ê"
                        : paymentMethod || "-";
        const cryptoDetails = paymentMethod === "crypto"
            ? `\n╪┤╪¿┌⌐┘ç: ${String(rows[0].crypto_network || "-")}\n┘à┘é╪»╪º╪▒: ${String(rows[0].crypto_amount || "-")}\n╪ó╪»╪▒╪│: ${shortAddr(String(rows[0].crypto_address || ""))}`
            : "";
        await clearState(userId);
        for (const adminId of await getAdminIds()) {
            try {
                await tg("sendPhoto", {
                    chat_id: adminId,
                    photo: photoFileId,
                    caption: `╪▒╪│█î╪» ╪¼╪»█î╪» ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä\n` +
                        `┌⌐╪º╪▒╪¿╪▒: ${userId}\n` +
                        `█î┘ê╪▓╪▒┘å█î┘à: ${username}\n` +
                        `┘å╪º┘à: ${fullName}\n` +
                        `┘à╪¿┘ä╪║: ${formatPriceToman(Number(rows[0].amount))} ╪¬┘ê┘à╪º┘å\n` +
                        `╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬: ${paymentLabel}` +
                        cryptoDetails,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                confirmButton(`wallet_accept_${topupId}`, "Γ£à ╪¬╪º█î█î╪»"),
                                cancelButton(`wallet_deny_${topupId}`, "Γ¥î ╪▒╪»")
                            ]
                        ]
                    }
                });
            }
            catch (error) {
                logError("notify_admin_wallet_receipt_failed", error, { adminId, topupId, userId });
            }
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪▒╪│█î╪» ╪º╪▒╪│╪º┘ä ╪┤╪» Γ£à\n┘╛╪│ ╪º╪▓ ╪¿╪▒╪▒╪│█î ╪º╪»┘à█î┘å ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪┤╪º╪▒┌ÿ ╪«┘ê╪º┘ç╪» ╪┤╪»." });
        return true;
    }
    if (state.state === "await_discount_code") {
        const productId = Number(state.payload.productId);
        const paymentMethod = String(state.payload.paymentMethod || "tronado");
        const walletUsed = Number(state.payload.walletUsed || 0);
        const discountCode = text.trim() || null;
        const quantity = Number(state.payload?.quantity || 1);
        const configName = state.payload?.configName;
        await clearState(userId);
        if (quantity > 1) {
            await createBulkOrders(chatId, userId, productId, paymentMethod, discountCode, walletUsed, quantity, String(configName || "config").trim() || "config");
        }
        else {
            await createOrder(chatId, userId, productId, paymentMethod, discountCode, walletUsed);
        }
        return true;
    }
    if (state.state === "await_custom_discount_code") {
        const productId = Number(state.payload.productId);
        const paymentMethod = String(state.payload.paymentMethod || "tronado");
        const walletUsed = Number(state.payload.walletUsed || 0);
        const checkout = sanitizePanelConfig(state.payload.checkout);
        const totalPrice = Math.max(1, Math.round(Number(checkout.totalPrice || 0)));
        const dataMb = Math.max(1, Math.round(Number(checkout.dataMb || 0)));
        const days = Math.max(30, Math.round(Number(checkout.days || 30)));
        const quantity = Math.max(1, Math.round(Number(checkout.quantity || 1)));
        const gb = Math.max(1, Math.round(dataMb / 1024));
        const configName = String(checkout.configName || "").trim() || undefined;
        const configNames = Array.isArray(checkout.configNames) ? checkout.configNames : (configName ? [configName] : []);
        const overrides = {
            basePriceToman: totalPrice,
            panelConfigPatch: { data_limit_mb: dataMb, expire_days: days, force_awaiting_config: true, ...(quantity > 1 ? { bulk_quantity: quantity, bulk_config_names: configNames } : {}) },
            productNameSuffix: `(╪│┘ü╪º╪▒╪┤█î ${gb}GB / ${days} ╪▒┘ê╪▓${quantity > 1 ? ` ├ù ${quantity}` : ""})`,
            configName
        };
        await clearState(userId);
        await createOrder(chatId, userId, productId, paymentMethod, text.trim() || null, walletUsed, overrides);
        return true;
    }
    if (state.state === "await_crypto_receipt" && state.payload.orderId) {
        if (!photoFileId) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å." });
            return true;
        }
        const orderId = Number(state.payload.orderId);
        const rows = await sql `
      UPDATE orders
      SET receipt_file_id = ${photoFileId}, status = 'receipt_submitted'
      WHERE id = ${orderId}
        AND telegram_id = ${userId}
        AND status = 'pending'
        AND payment_method IN ('tronado', 'plisio', 'tetrapay')
      RETURNING id;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪» █î╪º ┘é╪º╪¿┘ä ╪½╪¿╪¬ ╪▒╪│█î╪» ┘å█î╪│╪¬." });
            await clearState(userId);
            return true;
        }
        const infoRows = await sql `
      SELECT
        o.id,
        o.purchase_id,
        o.final_price,
        o.wallet_used,
        o.payment_method,
        o.tron_amount,
        o.tronado_token,
        o.tronado_payment_url,
        o.plisio_txn_id,
        o.plisio_invoice_url,
        o.plisio_status,
        o.panel_delivery_mode,
        COALESCE(o.product_name_snapshot, p.name) AS product_name,
        u.username,
        u.first_name,
        u.last_name
      FROM orders o
      INNER JOIN products p ON p.id = o.product_id
      LEFT JOIN users u ON u.telegram_id = o.telegram_id
      WHERE o.id = ${orderId}
      LIMIT 1;
    `;
        const o = infoRows[0] || {};
        const username = o.username ? `@${String(o.username)}` : "-";
        const fullName = [o.first_name ? String(o.first_name) : "", o.last_name ? String(o.last_name) : ""].filter(Boolean).join(" ").trim() || "-";
        const method = String(o.payment_method || "-");
        const walletUsed = Number(o.wallet_used || 0);
        const extraLines = [];
        if (method === "tronado") {
            extraLines.push(`┘à┘é╪»╪º╪▒ TRON: ${String(o.tron_amount || "-")}`);
            if (o.tronado_payment_url)
                extraLines.push(`┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬: ${String(o.tronado_payment_url)}`);
        }
        else if (method === "plisio") {
            if (o.plisio_txn_id)
                extraLines.push(`txn: ${String(o.plisio_txn_id)}`);
            if (o.plisio_status)
                extraLines.push(`status: ${String(o.plisio_status)}`);
            if (o.plisio_invoice_url)
                extraLines.push(`┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬: ${String(o.plisio_invoice_url)}`);
        }
        else if (method === "tetrapay") {
            if (o.tronado_token)
                extraLines.push(`authority: ${String(o.tronado_token)}`);
            if (o.tronado_payment_url)
                extraLines.push(`┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬: ${String(o.tronado_payment_url)}`);
        }
        const cryptoDeliveryLabel = formatDeliveryModeLabel(parseDeliveryMode(String(o.panel_delivery_mode || "")));
        const caption = `╪▒╪│█î╪» ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪▒█î┘╛╪¬┘ê ╪º╪▒╪│╪º┘ä ╪┤╪»\n` +
            `╪│┘ü╪º╪▒╪┤: ${String(o.purchase_id || "-")}\n` +
            `┌⌐╪º╪▒╪¿╪▒: ${userId}\n` +
            `█î┘ê╪▓╪▒┘å█î┘à: ${username}\n` +
            `┘å╪º┘à: ${fullName}\n` +
            `┘à╪¡╪╡┘ê┘ä: ${String(o.product_name || "-")}\n` +
            `╪¬╪¡┘ê█î┘ä: ${cryptoDeliveryLabel}\n` +
            `┘à╪¿┘ä╪║: ${formatPriceToman(Number(o.final_price || 0))} ╪¬┘ê┘à╪º┘å\n` +
            `╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬: ${method}` +
            (walletUsed > 0 ? `\n┌⌐╪│╪▒ ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä: ${formatPriceToman(walletUsed)} ╪¬┘ê┘à╪º┘å` : "") +
            (extraLines.length ? `\n${extraLines.join("\n")}` : "");
        await clearState(userId);
        for (const adminId of await getAdminIds()) {
            try {
                await tg("sendPhoto", {
                    chat_id: adminId,
                    photo: photoFileId,
                    caption,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "Γ£à ╪¬╪º█î█î╪»", callback_data: `crypto_accept_${orderId}` },
                                { text: "Γ¥î ╪▒╪»", callback_data: `crypto_deny_${orderId}` },
                                { text: "Γ¢ö ╪¿┘å", callback_data: `crypto_ban_${orderId}_${userId}` }
                            ]
                        ]
                    }
                });
            }
            catch (e) {
                logError("notify_admin_crypto_receipt_failed", e, { adminId, orderId, userId });
            }
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ╪º╪▒╪│╪º┘ä ╪┤╪» Γ£à\n╪¿╪╣╪» ╪º╪▓ ╪¿╪▒╪▒╪│█î ╪º╪»┘à█î┘å ┘å╪¬█î╪¼┘ç ╪¿┘ç╪¬ ╪«╪¿╪▒ ╪»╪º╪»┘ç ┘à█î╪┤┘ç." });
        return true;
    }
    if (state.state === "await_receipt") {
        if (!photoFileId) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪¬╪╡┘ê█î╪▒ ╪▒╪│█î╪» ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
            return true;
        }
        const orderId = Number(state.payload.orderId);
        let rows = [];
        try {
            rows = await sql `
        UPDATE orders
        SET receipt_file_id = ${photoFileId}, status = 'receipt_submitted'
        WHERE id = ${orderId}
          AND telegram_id = ${userId}
          AND status = 'awaiting_receipt'
          AND payment_method = 'card2card'
        RETURNING purchase_id, final_price, payment_method, wallet_used, panel_delivery_mode, product_name_snapshot;
      `;
        }
        catch (e) {
            logError("receipt_submit_transaction_failed", e, { orderId });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪½╪¿╪¬ ╪▒╪│█î╪». ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
            return true;
        }
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪» █î╪º ╪º┘à┌⌐╪º┘å ╪½╪¿╪¬ ╪▒╪│█î╪» ╪¿╪▒╪º█î ╪ó┘å ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪»." });
            await clearState(userId);
            return true;
        }
        const profileRows = await sql `
      SELECT username, first_name, last_name
      FROM users
      WHERE telegram_id = ${userId}
      LIMIT 1;
    `;
        const username = profileRows.length && profileRows[0].username ? `@${String(profileRows[0].username)}` : "-";
        const firstName = profileRows.length && profileRows[0].first_name ? String(profileRows[0].first_name) : "";
        const lastName = profileRows.length && profileRows[0].last_name ? String(profileRows[0].last_name) : "";
        const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || "-";
        const actualWalletUsed = Number(rows[0].wallet_used || 0);
        const walletUsedText = actualWalletUsed > 0 ? `\n┌⌐╪│╪▒ ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä: ${formatPriceToman(actualWalletUsed)} ╪¬┘ê┘à╪º┘å` : "";
        const cardDeliveryMode = parseDeliveryMode(String(rows[0].panel_delivery_mode || ""));
        const cardDeliveryLabel = formatDeliveryModeLabel(cardDeliveryMode);
        const cardProductSnap = String(rows[0].product_name_snapshot || "").trim();
        await clearState(userId);
        for (const adminId of await getAdminIds()) {
            try {
                await tg("sendPhoto", {
                    chat_id: adminId,
                    photo: photoFileId,
                    caption: `╪▒╪│█î╪» ╪¼╪»█î╪» ╪º╪▒╪│╪º┘ä ╪┤╪»\n` +
                        `╪│┘ü╪º╪▒╪┤: ${rows[0].purchase_id}\n` +
                        `┘à╪¡╪╡┘ê┘ä: ${cardProductSnap || "-"}\n` +
                        `╪¬╪¡┘ê█î┘ä: ${cardDeliveryLabel}\n` +
                        `┌⌐╪º╪▒╪¿╪▒: ${userId}\n` +
                        `█î┘ê╪▓╪▒┘å█î┘à: ${username}\n` +
                        `┘å╪º┘à: ${fullName}\n` +
                        `┘à╪¿┘ä╪║ ┘╛╪▒╪»╪º╪«╪¬█î: ${formatPriceToman(Number(rows[0].final_price))} ╪¬┘ê┘à╪º┘å` + walletUsedText,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                confirmButton(`receipt_accept_${orderId}`, "Γ£à ╪¬╪º█î█î╪»"),
                                cancelButton(`receipt_deny_${orderId}`, "Γ¥î ╪▒╪»"),
                                cb("Γ¢ö ╪¿┘å", `receipt_ban_${orderId}_${userId}`, "danger")
                            ]
                        ]
                    }
                });
            }
            catch (error) {
                logError("notify_admin_receipt_failed", error, { adminId, orderId, userId });
                continue;
            }
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪▒╪│█î╪» ╪º╪▒╪│╪º┘ä ╪┤╪» Γ£à\n┘╛╪│ ╪º╪▓ ╪¿╪▒╪▒╪│█î ╪º╪»┘à█î┘å ┘å╪¬█î╪¼┘ç ╪º╪╖┘ä╪º╪╣ ╪»╪º╪»┘ç ┘à█îΓÇî╪┤┘ê╪»." });
        return true;
    }
    if (state.state === "await_topup_receipt") {
        if (!photoFileId) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪¬╪╡┘ê█î╪▒ ╪▒╪│█î╪» ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
            return true;
        }
        const topupRequestId = Number(state.payload.topupRequestId);
        const rows = await sql `
      UPDATE topup_requests
      SET receipt_file_id = ${photoFileId}, status = 'receipt_submitted'
      WHERE id = ${topupRequestId}
      RETURNING purchase_id, requested_mb, final_price, inventory_id;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º █î╪º┘ü╪¬ ┘å╪┤╪»." });
            await clearState(userId);
            return true;
        }
        const profileRows = await sql `
      SELECT username, first_name, last_name
      FROM users
      WHERE telegram_id = ${userId}
      LIMIT 1;
    `;
        const username = profileRows.length && profileRows[0].username ? `@${String(profileRows[0].username)}` : "-";
        const firstName = profileRows.length && profileRows[0].first_name ? String(profileRows[0].first_name) : "";
        const lastName = profileRows.length && profileRows[0].last_name ? String(profileRows[0].last_name) : "";
        const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || "-";
        const cfgRows = await sql `
      SELECT i.config_value, p.name AS product_name, p.panel_delivery_mode
      FROM inventory i
      INNER JOIN products p ON p.id = i.product_id
      WHERE i.id = ${rows[0].inventory_id}
      LIMIT 1;
    `;
        const cfgText = String(cfgRows[0]?.config_value || "-");
        const topupProductName = String(cfgRows[0]?.product_name || "").trim();
        const topupDeliveryLabel = formatDeliveryModeLabel(parseDeliveryMode(String(cfgRows[0]?.panel_delivery_mode || "")));
        await clearState(userId);
        for (const adminId of await getAdminIds()) {
            try {
                await tg("sendPhoto", {
                    chat_id: adminId,
                    photo: photoFileId,
                    caption: `╪▒╪│█î╪» ╪¼╪»█î╪» ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º\n` +
                        `╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤: ${rows[0].purchase_id}\n` +
                        `┘à╪¡╪╡┘ê┘ä: ${topupProductName || "-"}\n` +
                        `╪¬╪¡┘ê█î┘ä (╪│╪▒┘ê█î╪│ ┘╛╪º█î┘ç): ${topupDeliveryLabel}\n` +
                        `┌⌐╪º╪▒╪¿╪▒: ${userId}\n` +
                        `█î┘ê╪▓╪▒┘å█î┘à: ${username}\n` +
                        `┘å╪º┘à: ${fullName}\n` +
                        `╪»╪▒╪«┘ê╪º╪│╪¬: ${rows[0].requested_mb}MB\n` +
                        `┘à╪¿┘ä╪║: ${formatPriceToman(Number(rows[0].final_price))} ╪¬┘ê┘à╪º┘å\n` +
                        `┌⌐╪º┘å┘ü█î┌»:\n${cfgText}`,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                confirmButton(`topup_accept_${topupRequestId}`, "Γ£à ╪¬╪º█î█î╪»"),
                                cancelButton(`topup_deny_${topupRequestId}`, "Γ¥î ╪▒╪»"),
                                cb("Γ¢ö ╪¿┘å", `topup_ban_${topupRequestId}_${userId}`, "danger")
                            ]
                        ]
                    }
                });
            }
            catch (error) {
                logError("notify_admin_topup_receipt_failed", error, { adminId, topupRequestId, userId });
                continue;
            }
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪▒╪│█î╪» ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪º╪▒╪│╪º┘ä ╪┤╪» Γ£à\n┘╛╪│ ╪º╪▓ ╪¿╪▒╪▒╪│█î ╪º╪»┘à█î┘å ╪º╪╖┘ä╪º╪╣ ┘à█îΓÇî╪»┘ç█î┘à." });
        return true;
    }
    if (state.state === "await_topup_custom_amount") {
        const inventoryId = Number(state.payload.inventoryId);
        const mb = parseDataAmountToMb(text);
        if (!Number.isFinite(inventoryId) || !mb || mb <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ü╪▒┘à╪¬ ╪¡╪¼┘à ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. ┘à╪½╪º┘ä: 1536 █î╪º 1.5GB █î╪º 800MB" });
            return true;
        }
        await clearState(userId);
        await createTopupCard2CardRequest(chatId, userId, inventoryId, mb);
        return true;
    }
    if (!isAdmin(userId))
        return false;
    if (state.state === "admin_set_start_media") {
        const kind = String(state.payload.kind || "").trim();
        const raw = text.trim();
        if (raw === "-") {
            await setSetting("start_media_kind", "none");
            await setSetting("start_media_value", "");
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪»█î╪º█î ╪┤╪▒┘ê╪╣ ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
            return true;
        }
        if (kind === "text") {
            if (!raw) {
                await tg("sendMessage", { chat_id: chatId, text: "┘à╪¬┘å ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
                return true;
            }
            await setSetting("start_media_kind", "text");
            await setSetting("start_media_value", raw);
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
            await tg("sendMessage", { chat_id: chatId, text: raw }).catch(() => { });
            return true;
        }
        if (kind === "sticker") {
            if (!stickerFileId) {
                await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪º╪│╪¬█î┌⌐╪▒ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å (┘å┘ç ╪╣┌⌐╪│)." });
                return true;
            }
            await setSetting("start_media_kind", "sticker");
            await setSetting("start_media_value", stickerFileId);
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
            await tg("sendSticker", { chat_id: chatId, sticker: stickerFileId }).catch(() => { });
            return true;
        }
        if (kind === "animation") {
            if (!animationFileId) {
                await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ┌»█î┘ü ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å." });
                return true;
            }
            await setSetting("start_media_kind", "animation");
            await setSetting("start_media_value", animationFileId);
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
            await tg("sendAnimation", { chat_id: chatId, animation: animationFileId }).catch(() => { });
            return true;
        }
        if (kind === "photo") {
            if (!photoFileId) {
                await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪╣┌⌐╪│ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å." });
                return true;
            }
            await setSetting("start_media_kind", "photo");
            await setSetting("start_media_value", photoFileId);
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
            await tg("sendPhoto", { chat_id: chatId, photo: photoFileId }).catch(() => { });
            return true;
        }
        await tg("sendMessage", { chat_id: chatId, text: "┘å┘ê╪╣ ┘à╪»█î╪º ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬. ╪º╪▓ ╪¬┘å╪╕█î┘à╪º╪¬ ╪»┘ê╪¿╪º╪▒┘ç ╪┤╪▒┘ê╪╣ ┌⌐┘å." });
        return true;
    }
    if (state.state === "admin_product_wizard") {
        const mode = String(state.payload.mode || "add");
        const step = String(state.payload.step || "name");
        const raw = text.trim();
        if (step === "name") {
            const name = mode === "edit" && raw === "-" ? String(state.payload.name || "") : raw;
            if (!name) {
                await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ┘à╪¡╪╡┘ê┘ä ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
                return true;
            }
            state.payload.name = name;
            state.payload.step = "product_kind";
            await setState(userId, "admin_product_wizard", state.payload);
            await promptProductWizardStep(chatId, state.payload);
            return true;
        }
        else if (step === "size_mb") {
            const productKind = parseProductKind(state.payload.productKind);
            if (productKind === "account") {
                state.payload.sizeMb = 0;
                state.payload.priceMode = "manual";
                state.payload.step = "price_mode";
                await setState(userId, "admin_product_wizard", state.payload);
                await promptProductWizardStep(chatId, state.payload);
                return true;
            }
            const sizeMbRaw = mode === "edit" && raw === "-" ? Number(state.payload.sizeMb || 0) : parseDataAmountToMb(raw);
            const sizeMb = Number(sizeMbRaw);
            if (!Number.isFinite(sizeMb) || sizeMb <= 0) {
                await tg("sendMessage", { chat_id: chatId, text: "╪¡╪¼┘à ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 2048 █î╪º 2GB █î╪º 800MB" });
                return true;
            }
            state.payload.sizeMb = Math.round(sizeMb);
            state.payload.step = "price_mode";
            await setState(userId, "admin_product_wizard", state.payload);
            await promptProductWizardStep(chatId, state.payload);
            return true;
        }
        else if (step === "price_toman") {
            const priceToman = mode === "edit" && raw === "-" ? Number(state.payload.priceToman || 0) : Number(raw);
            if (!Number.isFinite(priceToman) || priceToman <= 0) {
                await tg("sendMessage", { chat_id: chatId, text: "┘é█î┘à╪¬ ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 450000" });
                return true;
            }
            state.payload.priceToman = Math.round(priceToman);
            state.payload.step = "sell_mode";
            await setState(userId, "admin_product_wizard", state.payload);
            await promptProductWizardStep(chatId, state.payload);
            return true;
        }
        else if (step === "panel_sell_limit") {
            let panelSellLimit = state.payload.panelSellLimit === null || state.payload.panelSellLimit === undefined ? null : Number(state.payload.panelSellLimit);
            if (!(mode === "edit" && raw === "-")) {
                if (!raw || raw === "0") {
                    panelSellLimit = null;
                }
                else {
                    const n = Number(raw);
                    if (!Number.isFinite(n) || n < 0) {
                        await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 50 █î╪º 0 ╪¿╪▒╪º█î ╪¿╪»┘ê┘å ╪│┘é┘ü." });
                        return true;
                    }
                    panelSellLimit = Math.round(n);
                }
            }
            state.payload.panelSellLimit = panelSellLimit;
            state.payload.step = "panel_delivery_mode";
            await setState(userId, "admin_product_wizard", state.payload);
            await promptProductWizardStep(chatId, state.payload);
            return true;
        }
        else if (step === "inbound_id" || step === "protocol" || step === "expire_days" || step === "data_limit_mb") {
            const payload = { ...state.payload };
            const result = await saveProductWizard(payload);
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: result.message });
            if (result.ok)
                await listProductsForAdmin(chatId, userId);
            return true;
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪º█î┘å ┘à╪▒╪¡┘ä┘ç ╪º╪▓ ╪»┌⌐┘à┘çΓÇî┘ç╪º█î ┘╛█î╪º┘à ┘é╪¿┘ä█î ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»." });
        return true;
    }
    if (state.state === "admin_card_wizard") {
        const mode = String(state.payload.mode || "add");
        const step = String(state.payload.step || "label");
        const raw = text.trim();
        if (step === "label") {
            const label = mode === "edit" && raw === "-" ? String(state.payload.label || "") : raw;
            if (!label) {
                await tg("sendMessage", { chat_id: chatId, text: "╪╣┘å┘ê╪º┘å ┌⌐╪º╪▒╪¬ ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
                return true;
            }
            state.payload.label = label;
            state.payload.step = "card_number";
            await setState(userId, "admin_card_wizard", state.payload);
            await promptCardWizardStep(chatId, state.payload);
            return true;
        }
        else if (step === "card_number") {
            const cardNumber = mode === "edit" && raw === "-" ? String(state.payload.cardNumber || "") : raw;
            if (!cardNumber) {
                await tg("sendMessage", { chat_id: chatId, text: "╪┤┘à╪º╪▒┘ç ┌⌐╪º╪▒╪¬ ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
                return true;
            }
            state.payload.cardNumber = cardNumber;
            state.payload.step = "holder_name";
            await setState(userId, "admin_card_wizard", state.payload);
            await promptCardWizardStep(chatId, state.payload);
            return true;
        }
        else if (step === "holder_name") {
            const holderName = raw === "-" ? "" : mode === "edit" && raw === "-" ? String(state.payload.holderName || "") : raw;
            state.payload.holderName = holderName;
            state.payload.step = "bank_name";
            await setState(userId, "admin_card_wizard", state.payload);
            await promptCardWizardStep(chatId, state.payload);
            return true;
        }
        else if (step === "bank_name") {
            const bankName = raw === "-" ? "" : mode === "edit" && raw === "-" ? String(state.payload.bankName || "") : raw;
            if (mode === "add") {
                await sql `
          INSERT INTO cards (label, card_number, holder_name, bank_name)
          VALUES (${String(state.payload.label || "")}, ${String(state.payload.cardNumber || "")}, ${String(state.payload.holderName || "") || null}, ${bankName || null});
        `;
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¬ ╪½╪¿╪¬ ╪┤╪» Γ£à" });
                return true;
            }
            const cardId = Number(state.payload.cardId || 0);
            await sql `
        UPDATE cards
        SET label = ${String(state.payload.label || "")}, card_number = ${String(state.payload.cardNumber || "")}, holder_name = ${String(state.payload.holderName || "") || null}, bank_name = ${bankName || null}
        WHERE id = ${cardId};
      `;
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¬ ┘ê█î╪▒╪º█î╪┤ ╪┤╪» Γ£à" });
            return true;
        }
        return true;
    }
    if (state.state === "admin_discount_wizard") {
        const mode = String(state.payload.mode || "add");
        const step = String(state.payload.step || "code_mode");
        const raw = text.trim();
        if (step === "code") {
            const code = raw.toUpperCase();
            if (!code) {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
                return true;
            }
            const payload = { ...state.payload, code, step: "type" };
            await setState(userId, "admin_discount_wizard", payload);
            await promptDiscountWizardStep(chatId, payload);
            return true;
        }
        if (step === "amount") {
            const amount = mode === "edit" && raw === "-" ? Number(state.payload.amount || 0) : Number(raw);
            if (!Number.isFinite(amount) || amount < 0) {
                await tg("sendMessage", { chat_id: chatId, text: "┘à┘é╪»╪º╪▒ ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪»." });
                return true;
            }
            const payload = { ...state.payload, amount: Math.round(amount), step: "usage_limit" };
            await setState(userId, "admin_discount_wizard", payload);
            await promptDiscountWizardStep(chatId, payload);
            return true;
        }
        if (step === "usage_limit") {
            let usageLimit;
            if (mode === "edit" && raw === "-") {
                usageLimit = state.payload.usageLimit === null || state.payload.usageLimit === undefined ? null : Number(state.payload.usageLimit);
            }
            else if (!raw || raw === "0") {
                usageLimit = null;
            }
            else {
                const n = Number(raw);
                if (!Number.isFinite(n) || n < 0) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪│┘é┘ü ┘à╪╡╪▒┘ü ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». 0 ╪¿╪▒╪º█î ╪¿╪»┘ê┘å ╪│┘é┘ü." });
                    return true;
                }
                usageLimit = Math.round(n);
            }
            const type = String(state.payload.type || "").toLowerCase();
            const amount = Number(state.payload.amount || 0);
            if (!["percent", "fixed"].includes(type) || !Number.isFinite(amount)) {
                await tg("sendMessage", { chat_id: chatId, text: "┘å┘ê╪╣ █î╪º ┘à┘é╪»╪º╪▒ ╪¬╪«┘ü█î┘ü ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
                return true;
            }
            if (mode === "add") {
                const code = String(state.payload.code || "").toUpperCase();
                if (!code) {
                    await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
                    return true;
                }
                await sql `
          INSERT INTO discounts (code, type, amount, usage_limit)
          VALUES (${code}, ${type}, ${amount}, ${usageLimit});
        `;
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: `┌⌐╪» ╪¬╪«┘ü█î┘ü ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n┌⌐╪»: ${code}` });
                return true;
            }
            const id = Number(state.payload.discountId || 0);
            await sql `UPDATE discounts SET type = ${type}, amount = ${amount}, usage_limit = ${usageLimit} WHERE id = ${id};`;
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪¬╪«┘ü█î┘ü ┘ê█î╪▒╪º█î╪┤ ╪┤╪» Γ£à" });
            return true;
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪º█î┘å ┘à╪▒╪¡┘ä┘ç ╪º╪▓ ╪»┌⌐┘à┘çΓÇî┘ç╪º█î ┘╛█î╪º┘à ┘é╪¿┘ä█î ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»." });
        return true;
    }
    if (state.state === "admin_message_user_wizard") {
        const step = String(state.payload.step || "target");
        const raw = text.trim();
        if (step === "target") {
            if (!raw) {
                await tg("sendMessage", { chat_id: chatId, text: "┘à╪«╪º╪╖╪¿ ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪»." });
                return true;
            }
            const payload = { ...state.payload, targetRaw: raw, step: "message" };
            await setState(userId, "admin_message_user_wizard", payload);
            await tg("sendMessage", {
                chat_id: chatId,
                text: "╪º╪▒╪│╪º┘ä ┘╛█î╪º┘à - ┘à╪▒╪¡┘ä┘ç 2 ╪º╪▓ 2\n┘à╪¬┘å ┘╛█î╪º┘à ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».",
                reply_markup: { inline_keyboard: [[cancelButton("admin_message_user_wizard_cancel")]] }
            });
            return true;
        }
        const targetRaw = String(state.payload.targetRaw || "");
        const messageText = raw;
        if (!messageText) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¬┘å ┘╛█î╪º┘à ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
            return true;
        }
        let targetId = Number(targetRaw);
        if (!Number.isFinite(targetId)) {
            const username = targetRaw.replace("@", "").trim().toLowerCase();
            const rows = await sql `
        SELECT telegram_id
        FROM users
        WHERE LOWER(username) = ${username}
        ORDER BY last_seen_at DESC
        LIMIT 1;
      `;
            if (!rows.length) {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒ █î╪º┘ü╪¬ ┘å╪┤╪»." });
                return true;
            }
            targetId = Number(rows[0].telegram_id);
        }
        try {
            await tg("sendMessage", { chat_id: targetId, text: messageText });
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘╛█î╪º┘à ╪º╪▒╪│╪º┘ä ╪┤╪» Γ£à" });
        }
        catch (error) {
            logError("admin_message_user_failed", error, { fromAdminId: userId, targetId });
            await tg("sendMessage", { chat_id: chatId, text: "╪º╪▒╪│╪º┘ä ┘╛█î╪º┘à ╪º┘å╪¼╪º┘à ┘å╪┤╪». ┌⌐╪º╪▒╪¿╪▒ ┘à┘à┌⌐┘å ╪º╪│╪¬ ╪▒╪¿╪º╪¬ ╪▒╪º ╪¿┘ä╪º┌⌐ ┌⌐╪▒╪»┘ç ╪¿╪º╪┤╪»." });
        }
        return true;
    }
    if (state.state === "admin_broadcast_message_wizard") {
        const messageText = text.trim();
        if (!messageText) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¬┘å ┘╛█î╪º┘à ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
            return true;
        }
        // Get all users
        const users = await sql `SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL;`;
        const totalUsers = users.length;
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪»╪▒ ╪¡╪º┘ä ╪º╪▒╪│╪º┘ä ┘╛█î╪º┘à ╪¿┘ç ${totalUsers} ┌⌐╪º╪▒╪¿╪▒...`
        });
        let successCount = 0;
        let failCount = 0;
        for (const user of users) {
            const targetId = Number(user.telegram_id);
            try {
                await tg("sendMessage", { chat_id: targetId, text: messageText });
                successCount++;
            }
            catch (error) {
                failCount++;
                logError("broadcast_send_failed", error, { targetId });
            }
        }
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `Γ£à ┘╛█î╪º┘à ┘ç┘à┌»╪º┘å█î ╪º╪▒╪│╪º┘ä ╪┤╪»\n\nΓ£à ┘à┘ê┘ü┘é: ${successCount}\nΓ¥î ┘å╪º┘à┘ê┘ü┘é: ${failCount}\n≡ƒôè ┌⌐┘ä: ${totalUsers}`
        });
        return true;
    }
    if (state.state === "admin_direct_migrate_wizard") {
        const step = String(state.payload.step || "source_inventory_id");
        const raw = text.trim();
        if (step === "source_inventory_id") {
            const sourceInventoryId = Number(raw);
            if (!Number.isFinite(sourceInventoryId) || sourceInventoryId <= 0) {
                await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç inventory ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
                return true;
            }
            const payload = { ...state.payload, sourceInventoryId, step: "target_panel_id" };
            await setState(userId, "admin_direct_migrate_wizard", payload);
            await promptDirectMigrateTargetPanel(chatId);
            return true;
        }
        if (step === "user_telegram_id") {
            const requestedFor = Number(raw);
            if (!Number.isFinite(requestedFor) || requestedFor <= 0) {
                await tg("sendMessage", { chat_id: chatId, text: "telegram id ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
                return true;
            }
            const payload = { ...state.payload, requestedFor, step: "config" };
            await setState(userId, "admin_direct_migrate_wizard", payload);
            await tg("sendMessage", {
                chat_id: chatId,
                text: "╪º┘å╪¬┘é╪º┘ä ┘à╪│╪¬┘é█î┘à - ┘à╪▒╪¡┘ä┘ç 4 ╪º╪▓ 4\n╪º┌»╪▒ ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪»╪º╪▒█î╪» ╪¿┘ü╪▒╪│╪¬█î╪». ╪¿╪▒╪º█î ╪º┘å╪¬┘é╪º┘ä ╪¿╪º ┌⌐╪º┘å┘ü█î┌» ┘é╪¿┘ä█î╪î - ╪¿┘ü╪▒╪│╪¬█î╪».",
                reply_markup: { inline_keyboard: [[cancelButton("admin_direct_migrate_wizard_cancel")]] }
            });
            return true;
        }
        if (step === "config") {
            const sourceInventoryId = Number(state.payload.sourceInventoryId || 0);
            const targetPanelId = Number(state.payload.targetPanelId || 0);
            const requestedFor = Number(state.payload.requestedFor || 0);
            if (!Number.isFinite(sourceInventoryId) || !Number.isFinite(targetPanelId) || !Number.isFinite(requestedFor)) {
                await tg("sendMessage", { chat_id: chatId, text: "╪º╪╖┘ä╪º╪╣╪º╪¬ ╪º┘å╪¬┘é╪º┘ä ┌⌐╪º┘à┘ä ┘å█î╪│╪¬. ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
                return true;
            }
            const config = raw === "-" ? "" : raw;
            const ok = await createMigrationRequest(chatId, userId, requestedFor, sourceInventoryId, targetPanelId, "admin");
            if (!ok)
                return true;
            if (config) {
                const row = await sql `
          SELECT id
          FROM panel_migrations
          WHERE source_inventory_id = ${sourceInventoryId}
            AND target_panel_id = ${targetPanelId}
            AND requested_for = ${requestedFor}
            AND status = 'pending'
          ORDER BY id DESC
          LIMIT 1;
        `;
                if (row.length) {
                    const complete = await completeMigration(Number(row[0].id), userId, config);
                    await tg("sendMessage", { chat_id: chatId, text: complete.ok ? "╪º┘å╪¬┘é╪º┘ä ┘ü┘ê╪▒█î ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à" : `╪«╪╖╪º: ${complete.reason}` });
                }
            }
            await clearState(userId);
            return true;
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪º█î┘å ┘à╪▒╪¡┘ä┘ç ╪º╪▓ ╪»┌⌐┘à┘çΓÇî┘ç╪º█î ┘╛█î╪º┘à ┘é╪¿┘ä█î ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»." });
        return true;
    }
    if (state.state === "admin_manage_users") {
        const rawInput = text.trim();
        let targetUserId = null;
        let userRows = [];
        // First, try if it's a numeric Telegram ID
        if (/^\d+$/.test(rawInput)) {
            targetUserId = Number(rawInput);
            if (Number.isFinite(targetUserId) && targetUserId > 0) {
                userRows = await sql `
          SELECT telegram_id, username, first_name, last_name, wallet_balance
          FROM users
          WHERE telegram_id = ${targetUserId}
          LIMIT 1;
        `;
            }
        }
        // If not found by ID, try finding by username
        if (!userRows.length) {
            const cleanUsername = rawInput.replace("@", "").toLowerCase();
            userRows = await sql `
        SELECT telegram_id, username, first_name, last_name, wallet_balance
        FROM users
        WHERE LOWER(username) = ${cleanUsername}
        LIMIT 1;
      `;
        }
        if (!userRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒ ╪»╪▒ ╪▒╪¿╪º╪¬ █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return true;
        }
        const u = userRows[0];
        const username = u.username ? `@${String(u.username)}` : "-";
        const fullName = [u.first_name ? String(u.first_name) : "", u.last_name ? String(u.last_name) : ""].filter(Boolean).join(" ").trim() || "-";
        const balance = Number(u.wallet_balance || 0);
        // Escape Markdown special characters to fix the "Can't parse entities" error
        const escapeMd = (str) => str.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒæñ *╪º╪╖┘ä╪º╪╣╪º╪¬ ┌⌐╪º╪▒╪¿╪▒*\n\n╪ó█î╪»█î: \`${u.telegram_id}\`\n█î┘ê╪▓╪▒┘å█î┘à: ${escapeMd(username)}\n┘å╪º┘à: ${escapeMd(fullName)}\n\n┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä: ${formatPriceToman(balance)} ╪¬┘ê┘à╪º┘å`,
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("Γ₧ò ╪º┘ü╪▓╪º█î╪┤ ┘à┘ê╪¼┘ê╪»█î", `admin_wallet_add_${u.telegram_id}`, "success"),
                        cb("Γ₧û ┌⌐╪│╪▒ ┘à┘ê╪¼┘ê╪»█î", `admin_wallet_sub_${u.telegram_id}`, "danger")
                    ],
                    [backButton("admin_panel")]
                ]
            }
        });
        return true;
    }
    if (state.state === "admin_wallet_add") {
        const amount = Number(text.trim());
        const targetUserId = Number(state.payload.targetUserId);
        if (!Number.isFinite(amount) || amount <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return true;
        }
        await sql `
      UPDATE users
      SET wallet_balance = wallet_balance + ${amount}
      WHERE telegram_id = ${targetUserId};
    `;
        await sql `
      INSERT INTO wallet_transactions (telegram_id, amount, type, description)
      VALUES (${targetUserId}, ${amount}, 'admin_add', '╪º┘ü╪▓╪º█î╪┤ ┘à┘ê╪¼┘ê╪»█î ╪¬┘ê╪│╪╖ ┘à╪»█î╪▒█î╪¬');
    `;
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┘à╪¿┘ä╪║ ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å ╪¿╪º ┘à┘ê┘ü┘é█î╪¬ ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪º╪▒╪¿╪▒ ╪º╪╢╪º┘ü┘ç ╪┤╪» Γ£à` });
        try {
            await tg("sendMessage", {
                chat_id: targetUserId,
                text: `≡ƒÆ░ ┘à╪¿┘ä╪║ ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å ╪¬┘ê╪│╪╖ ┘à╪»█î╪▒█î╪¬ ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪º╪╢╪º┘ü┘ç ╪┤╪».`
            });
        }
        catch (e) {
            logError("notify_user_wallet_add_failed", e, { targetUserId });
        }
        return true;
    }
    if (state.state === "admin_wallet_sub") {
        const amount = Number(text.trim());
        const targetUserId = Number(state.payload.targetUserId);
        if (!Number.isFinite(amount) || amount <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return true;
        }
        const deducted = await sql `
      UPDATE users
      SET wallet_balance = GREATEST(0, wallet_balance - ${amount})
      WHERE telegram_id = ${targetUserId}
      RETURNING telegram_id;
    `;
        if (deducted.length) {
            await sql `
        INSERT INTO wallet_transactions (telegram_id, amount, type, description)
        VALUES (${targetUserId}, ${-amount}, 'admin_sub', '┌⌐╪│╪▒ ┘à┘ê╪¼┘ê╪»█î ╪¬┘ê╪│╪╖ ┘à╪»█î╪▒█î╪¬');
      `;
        }
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┘à╪¿┘ä╪║ ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å ╪¿╪º ┘à┘ê┘ü┘é█î╪¬ ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪º╪▒╪¿╪▒ ┌⌐╪│╪▒ ╪┤╪» Γ£à` });
        try {
            await tg("sendMessage", {
                chat_id: targetUserId,
                text: `≡ƒÆ╕ ┘à╪¿┘ä╪║ ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å ╪¬┘ê╪│╪╖ ┘à╪»█î╪▒█î╪¬ ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ┌⌐╪│╪▒ ╪┤╪».`
            });
        }
        catch (e) {
            logError("notify_user_wallet_sub_failed", e, { targetUserId });
        }
        return true;
    }
    if (state.state === "admin_add_product") {
        const parsed = parseProductInput(text);
        const useAutoPrice = !parsed.priceRaw || parsed.priceRaw.toLowerCase() === "auto";
        const price = useAutoPrice ? await getProductPriceFromSizeMb(parsed.sizeMb) : Number(parsed.priceRaw);
        if (!parsed.name || !Number.isFinite(parsed.sizeMb) || !Number.isFinite(price) || price <= 0) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ┘à╪¡╪╡┘ê┘ä ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬.\n" +
                    "┘é╪»█î┘à█î: ┘å╪º┘à|╪¡╪¼┘àMB|┘é█î┘à╪¬\n" +
                    "╪¼╪»█î╪»:\nname: 2GB ┘ê█î┌ÿ┘ç\nsize_mb: 2048\nprice_toman: auto\nsell_mode: panel\npanel_id: 1\npanel_sell_limit: 100\npanel_delivery_mode: both\npanel_config: {\"inbound_id\":1,\"protocol\":\"vless\"}"
            });
            return true;
        }
        if (parsed.sellMode === "panel" && !parsed.panelId) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î sell_mode: panel ╪¿╪º█î╪» panel_id ┘à╪┤╪«╪╡ ╪¿╪º╪┤╪»." });
            return true;
        }
        await sql `
      INSERT INTO products (name, size_mb, price_toman, is_infinite, sell_mode, panel_id, panel_sell_limit, panel_delivery_mode, panel_config)
      VALUES (
        ${parsed.name},
        ${parsed.sizeMb},
        ${price},
        ${parsed.sellMode === "panel" ? true : parsed.isInfinite},
        ${parsed.sellMode},
        ${parsed.sellMode === "panel" ? parsed.panelId : null},
        ${parsed.sellMode === "panel" ? parsed.panelSellLimit : null},
        ${parsed.panelDeliveryMode},
        ${JSON.stringify(parsed.panelConfig)}::jsonb
      )
      ON CONFLICT (name) DO UPDATE SET
        size_mb = EXCLUDED.size_mb,
        price_toman = EXCLUDED.price_toman,
        is_active = TRUE,
        is_infinite = EXCLUDED.is_infinite,
        sell_mode = EXCLUDED.sell_mode,
        panel_id = EXCLUDED.panel_id,
        panel_sell_limit = EXCLUDED.panel_sell_limit,
        panel_delivery_mode = EXCLUDED.panel_delivery_mode,
        panel_config = EXCLUDED.panel_config;
    `;
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n` +
                `┘é█î┘à╪¬: ${formatPriceToman(price)} ╪¬┘ê┘à╪º┘å (${useAutoPrice ? "╪«┘ê╪»┌⌐╪º╪▒" : "╪»┘ä╪«┘ê╪º┘ç"})\n` +
                `╪¡╪º┘ä╪¬ ┘ü╪▒┘ê╪┤: ${parsed.sellMode === "panel" ? "╪º╪▓ ┘╛┘å┘ä" : "╪»╪│╪¬█î"}\n` +
                `╪¬╪¡┘ê█î┘ä: ${parsed.panelDeliveryMode}`
        });
        return true;
    }
    if (state.state === "admin_edit_product") {
        const id = Number(state.payload.productId);
        const currentRows = await sql `
      SELECT name, size_mb, price_toman, is_infinite, sell_mode, panel_id, panel_sell_limit, panel_delivery_mode, panel_config
      FROM products
      WHERE id = ${id}
      LIMIT 1;
    `;
        if (!currentRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const parsed = parseProductInput(text, currentRows[0]);
        const useAutoPrice = !parsed.priceRaw || parsed.priceRaw.toLowerCase() === "auto";
        const price = useAutoPrice ? await getProductPriceFromSizeMb(parsed.sizeMb) : Number(parsed.priceRaw || currentRows[0].price_toman);
        if (!parsed.name || !Number.isFinite(parsed.sizeMb) || !Number.isFinite(price) || price <= 0) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ┘à╪¡╪╡┘ê┘ä ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬.\n" +
                    "┘å┘à┘ê┘å┘ç:\nname: 2GB ┘ê█î┌ÿ┘ç\nsize_mb: 2048\nprice_toman: auto\nsell_mode: panel\npanel_id: 1\npanel_delivery_mode: both"
            });
            return true;
        }
        if (parsed.sellMode === "panel" && !parsed.panelId) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î sell_mode: panel ╪¿╪º█î╪» panel_id ┘à╪┤╪«╪╡ ╪¿╪º╪┤╪»." });
            return true;
        }
        await sql `
      UPDATE products
      SET
        name = ${parsed.name},
        size_mb = ${parsed.sizeMb},
        price_toman = ${price},
        is_infinite = ${parsed.sellMode === "panel" ? true : parsed.isInfinite},
        sell_mode = ${parsed.sellMode},
        panel_id = ${parsed.sellMode === "panel" ? parsed.panelId : null},
        panel_sell_limit = ${parsed.sellMode === "panel" ? parsed.panelSellLimit : null},
        panel_delivery_mode = ${parsed.panelDeliveryMode},
        panel_config = ${JSON.stringify(parsed.panelConfig)}::jsonb
      WHERE id = ${id};
    `;
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪¡╪╡┘ê┘ä ┘ê█î╪▒╪º█î╪┤ ╪┤╪» Γ£à\n` +
                `┘é█î┘à╪¬: ${formatPriceToman(price)} ╪¬┘ê┘à╪º┘å (${useAutoPrice ? "╪«┘ê╪»┌⌐╪º╪▒" : "╪»┘ä╪«┘ê╪º┘ç"})\n` +
                `╪¡╪º┘ä╪¬ ┘ü╪▒┘ê╪┤: ${parsed.sellMode === "panel" ? "╪º╪▓ ┘╛┘å┘ä" : "╪»╪│╪¬█î"}\n` +
                `╪¬╪¡┘ê█î┘ä: ${parsed.panelDeliveryMode}`
        });
        return true;
    }
    if (state.state === "admin_product_panel_wizard") {
        const step = String(state.payload.step || "panel");
        const raw = text.trim();
        if (step === "sell_limit") {
            let panelSellLimit = state.payload.panelSellLimit === null || state.payload.panelSellLimit === undefined
                ? null
                : Number(state.payload.panelSellLimit);
            if (raw !== "-") {
                if (!raw || raw === "0") {
                    panelSellLimit = null;
                }
                else {
                    const n = Number(raw);
                    if (!Number.isFinite(n) || n < 0) {
                        await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½┘ä╪º 50 █î╪º 0 ╪¿╪▒╪º█î ╪¿╪»┘ê┘å ╪│┘é┘ü." });
                        return true;
                    }
                    panelSellLimit = Math.round(n);
                }
            }
            const payload = { ...state.payload, panelSellLimit, step: "delivery" };
            await setState(userId, "admin_product_panel_wizard", payload);
            await promptProductPanelWizardStep(chatId, payload);
            return true;
        }
        if (step === "inbound_id") {
            let inboundId = parseMaybeNumber(state.payload.inboundId) ?? 1;
            if (raw !== "-") {
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) {
                    await tg("sendMessage", { chat_id: chatId, text: "inbound_id ╪¿╪º█î╪» ╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ┘ê ╪¿╪▓╪▒┌»ΓÇî╪¬╪▒ ╪º╪▓ ╪╡┘ü╪▒ ╪¿╪º╪┤╪»." });
                    return true;
                }
                inboundId = Math.round(n);
            }
            const payload = { ...state.payload, inboundId, step: "protocol" };
            await setState(userId, "admin_product_panel_wizard", payload);
            await promptProductPanelWizardStep(chatId, payload);
            return true;
        }
        if (step === "protocol") {
            const protocol = raw === "-" ? String(state.payload.protocol || "vless").trim() : raw.trim().toLowerCase();
            if (!protocol) {
                await tg("sendMessage", { chat_id: chatId, text: "┘╛╪▒┘ê╪¬┌⌐┘ä ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
                return true;
            }
            const payload = { ...state.payload, protocol, step: "expire_days" };
            await setState(userId, "admin_product_panel_wizard", payload);
            await promptProductPanelWizardStep(chatId, payload);
            return true;
        }
        if (step === "expire_days") {
            let expireDays = parseMaybeNumber(state.payload.expireDays) ?? 30;
            if (raw !== "-") {
                const n = Number(raw);
                if (!Number.isFinite(n) || n < 0) {
                    await tg("sendMessage", { chat_id: chatId, text: "expire_days ╪¿╪º█î╪» ╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ┘ê ╪╡┘ü╪▒ █î╪º ╪¿█î╪┤╪¬╪▒ ╪¿╪º╪┤╪»." });
                    return true;
                }
                expireDays = Math.round(n);
            }
            const payload = { ...state.payload, expireDays, step: "data_limit_mb" };
            await setState(userId, "admin_product_panel_wizard", payload);
            await promptProductPanelWizardStep(chatId, payload);
            return true;
        }
        if (step === "data_limit_mb") {
            let dataLimitMb = parseMaybeNumber(state.payload.dataLimitMb) ?? 1024;
            if (raw !== "-") {
                const mb = parseDataAmountToMb(raw);
                if (!mb || mb <= 0) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪¡╪¼┘à ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 3072 █î╪º 3GB █î╪º 800MB" });
                    return true;
                }
                dataLimitMb = Math.round(mb);
            }
            const payload = { ...state.payload, dataLimitMb };
            const result = await saveProductPanelWizard(payload, false);
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: result.message });
            if (result.ok) {
                await listProductsForAdmin(chatId, userId);
            }
            return true;
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪º█î┘å ┘à╪▒╪¡┘ä┘ç ╪º╪▓ ╪»┌⌐┘à┘çΓÇî┘ç╪º█î ┘╛█î╪º┘à ┘é╪¿┘ä█î ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»." });
        return true;
    }
    if (state.state === "admin_add_stock") {
        const productId = Number(state.payload.productId);
        const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
        if (!lines.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┌⌐╪º┘å┘ü█î┌»█î ╪º╪▒╪│╪º┘ä ┘å╪┤╪»." });
            return true;
        }
        const deduped = Array.from(new Set(lines));
        let insertedCount = 0;
        let skippedCount = 0;
        const allExisting = await sql `SELECT config_value FROM inventory WHERE product_id = ${productId};`;
        const existingSet = new Set(allExisting.map(r => r.config_value));
        const toInsert = deduped.filter(line => !existingSet.has(line));
        skippedCount = deduped.length - toInsert.length;
        // Insert in chunks of 50 to avoid connection pooling limits on serverless
        const chunkSize = 50;
        for (let i = 0; i < toInsert.length; i += chunkSize) {
            const chunk = toInsert.slice(i, i + chunkSize);
            const insertPromises = chunk.map(line => sql `INSERT INTO inventory (product_id, config_value) VALUES (${productId}, ${line});`);
            await Promise.all(insertPromises);
            insertedCount += chunk.length;
        }
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪º┘ü╪▓┘ê╪»┘å ╪¿┘ç ╪º┘å╪¿╪º╪▒ ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à\n` +
                `╪º╪╢╪º┘ü┘ç ╪┤╪»: ${insertedCount}\n` +
                `╪¬┌⌐╪▒╪º╪▒█î/╪º╪│┌⌐█î┘╛: ${skippedCount}`
        });
        return true;
    }
    if (state.state === "admin_add_card") {
        const parsed = parseCardInput(text);
        if (!parsed.label || !parsed.cardNumber) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ┌⌐╪º╪▒╪¬ ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬.\n┘é╪»█î┘à█î: ┌⌐╪º╪▒╪¬ 1|6037...|╪╣┘ä█î ╪▒╪╢╪º█î█î|┘à┘ä█î\n╪¼╪»█î╪»:\nlabel: ┌⌐╪º╪▒╪¬ 1\ncard_number: 6037...\nholder_name: ╪╣┘ä█î ╪▒╪╢╪º█î█î\nbank_name: ┘à┘ä█î"
            });
            return true;
        }
        await sql `
      INSERT INTO cards (label, card_number, holder_name, bank_name)
      VALUES (${parsed.label}, ${parsed.cardNumber}, ${parsed.holderName || null}, ${parsed.bankName || null});
    `;
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¬ ╪½╪¿╪¬ ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_edit_card") {
        const cardId = Number(state.payload.cardId);
        const parsed = parseCardInput(text);
        if (!parsed.label || !parsed.cardNumber) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ┌⌐╪º╪▒╪¬ ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬.\n┘å┘à┘ê┘å┘ç:\nlabel: ┌⌐╪º╪▒╪¬ 1\ncard_number: 6037...\nholder_name: ╪╣┘ä█î ╪▒╪╢╪º█î█î\nbank_name: ┘à┘ä█î"
            });
            return true;
        }
        await sql `
      UPDATE cards
      SET label = ${parsed.label}, card_number = ${parsed.cardNumber}, holder_name = ${parsed.holderName || null}, bank_name = ${parsed.bankName || null}
      WHERE id = ${cardId};
    `;
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¬ ┘ê█î╪▒╪º█î╪┤ ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_add_discount") {
        const parsed = parseDiscountInput(text);
        if (!parsed.code || !["percent", "fixed"].includes(parsed.type) || !Number.isFinite(parsed.amount)) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ╪¬╪«┘ü█î┘ü ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬.\n" +
                    "┘é╪»█î┘à█î: RANDOM|percent|10|100\n" +
                    "╪¼╪»█î╪»:\ncode: RANDOM\ntype: percent\namount: 10\nusage_limit: 100"
            });
            return true;
        }
        await sql `
      INSERT INTO discounts (code, type, amount, usage_limit)
      VALUES (${parsed.code}, ${parsed.type}, ${parsed.amount}, ${parsed.usageLimit});
    `;
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┌⌐╪» ╪¬╪«┘ü█î┘ü ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n┌⌐╪»: ${parsed.code}` });
        return true;
    }
    if (state.state === "admin_edit_discount") {
        const id = Number(state.payload.discountId);
        const parsed = parseDiscountInput(text, "EXISTING");
        if (!["percent", "fixed"].includes(parsed.type) || !Number.isFinite(parsed.amount)) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ╪¬╪«┘ü█î┘ü ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬.\n┘å┘à┘ê┘å┘ç:\ntype: percent\namount: 10\nusage_limit: 100"
            });
            return true;
        }
        await sql `
      UPDATE discounts SET type = ${parsed.type}, amount = ${parsed.amount}, usage_limit = ${parsed.usageLimit}
      WHERE id = ${id};
    `;
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪¬╪«┘ü█î┘ü ┘ê█î╪▒╪º█î╪┤ ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_mandatory_channels") {
        const raw = text.trim();
        if (raw.toLowerCase() === "╪«╪º┘à┘ê╪┤") {
            await setSetting("mandatory_channels", "");
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘é┘ü┘ä ┌⌐╪º┘å╪º┘ä ╪«╪º┘à┘ê╪┤ ╪┤╪» Γ£à" });
            return true;
        }
        const channels = raw.split(/[\n,]+/).map(c => c.trim()).filter(Boolean);
        if (!channels.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä█î╪│╪¬ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬. ╪¡╪»╪º┘é┘ä █î┌⌐ ┌⌐╪º┘å╪º┘ä ┘ê╪º╪▒╪» ┌⌐┘å█î╪» █î╪º ╪¿┘å┘ê█î╪│█î╪» '╪«╪º┘à┘ê╪┤'." });
            return true;
        }
        await setSetting("mandatory_channels", channels.join(","));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┘ä█î╪│╪¬ ┌⌐╪º┘å╪º┘äΓÇî┘ç╪º█î ╪º╪¼╪¿╪º╪▒█î ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${channels.join("\n")}` });
        return true;
    }
    if (state.state === "admin_set_support") {
        const username = text.replace("@", "").trim();
        await setSetting("support_username", username);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `█î┘ê╪▓╪▒┘å█î┘à ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪½╪¿╪¬ ╪┤╪»: @${username}` });
        return true;
    }
    if (state.state === "admin_set_wallet") {
        const wallet = text.trim();
        await setSetting("business_wallet_address", wallet);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä ┘à┘é╪╡╪» ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_referral_threshold") {
        const threshold = Math.round(Number(text.trim()));
        if (!Number.isFinite(threshold) || threshold <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "█î┌⌐ ╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿╪▓╪▒┌»ΓÇî╪¬╪▒ ╪º╪▓ ╪╡┘ü╪▒ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: 5" });
            return true;
        }
        await setSetting("referral_invite_threshold", String(threshold));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪ó╪│╪¬╪º┘å┘ç ╪»╪╣┘ê╪¬ ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n┘ç╪▒ ${threshold} ╪»╪╣┘ê╪¬ ╪¬╪º█î█î╪»╪┤╪»┘ç = █î┌⌐ ╪¼╪º█î╪▓┘ç` });
        return true;
    }
    if (state.state === "admin_set_referral_wallet_amount") {
        const amount = Math.round(Number(text.trim()));
        if (!Number.isFinite(amount) || amount < 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┘à╪╣╪¬╪¿╪▒ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: 50000" });
            return true;
        }
        await setSetting("referral_wallet_amount_toman", String(amount));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┘à╪¿┘ä╪║ ╪¼╪º█î╪▓┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_reset_all_data") {
        const confirmation = text.trim().toUpperCase();
        if (confirmation !== "RESET ALL DATA") {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "╪╣╪¿╪º╪▒╪¬ ╪¬╪º█î█î╪» ╪»╪▒╪│╪¬ ┘å█î╪│╪¬.\n╪¿╪▒╪º█î ╪º┘å╪¼╪º┘à ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä ╪»┘é█î┘é╪º┘ï ╪¿┘å┘ê█î╪│█î╪»:\nRESET ALL DATA"
            });
            return true;
        }
        await resetBusinessDataPreserveCaches();
        invalidateSettingsCache();
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à\n┘ç┘à┘ç ╪»╪º╪»┘çΓÇî┘ç╪º█î ╪╣┘à┘ä█î╪º╪¬█î ╪¡╪░┘ü ╪┤╪»┘å╪» ┘ê ┘ü┘é╪╖ ╪»╪º╪»┘çΓÇî┘ç╪º█î ┌⌐╪┤ ┘à╪½┘ä ┘å╪▒╪« ╪º╪▒╪▓ ╪¡┘ü╪╕ ╪┤╪»."
        });
        await notifyAdmins(`≡ƒº¿ ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä ╪»╪º╪»┘çΓÇî┘ç╪º█î ╪▒╪¿╪º╪¬ ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å ${userId} ╪º┘å╪¼╪º┘à ╪┤╪».\n╪»╪º╪»┘çΓÇî┘ç╪º█î ┌⌐╪┤ ╪¡┘ü╪╕ ╪┤╪»┘å╪».`).catch(() => { });
        return true;
    }
    if (state.state === "admin_set_public_base_url") {
        const raw = text.trim();
        if (raw === "-") {
            await setSetting("public_base_url", "");
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
            return true;
        }
        if (!isValidHttpUrl(raw)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. ┘à╪½╪º┘ä: https://example.com" });
            return true;
        }
        await setSetting("public_base_url", raw);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_tronado_api_key") {
        const raw = text.trim();
        await setSetting("tronado_api_key", raw === "-" ? "" : raw);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» Tronado ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_tetrapay_api_key") {
        const raw = text.trim();
        await setSetting("tetrapay_api_key", raw === "-" ? "" : raw);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» TetraPay ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_plisio_api_key") {
        const raw = text.trim();
        await setSetting("plisio_api_key", raw === "-" ? "" : raw);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» Plisio ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_swapwallet_api_key") {
        const raw = text.trim();
        await setSetting("swapwallet_api_key", raw === "-" ? "" : raw);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» SwapWallet ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_swapwallet_shop_username") {
        const raw = text.trim();
        await setSetting("swapwallet_shop_username", raw === "-" ? "" : raw.replace("@", ""));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "Shop SwapWallet ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_usdt_toman_rate") {
        const raw = text.trim();
        if (raw === "-") {
            await setSetting("usdt_toman_rate", "");
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« ╪»╪│╪¬█î USDT ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
            return true;
        }
        const rate = Math.round(Number(raw));
        if (!Number.isFinite(rate) || rate <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 460000" });
            return true;
        }
        await setSetting("usdt_toman_rate", String(rate));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┘å╪▒╪« ╪»╪│╪¬█î USDT ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${rate} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_crypto_wallet_add_other_currency") {
        const currency = text.trim().toUpperCase();
        if (!currency) {
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ╪º╪▒╪▓ ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return true;
        }
        await setState(userId, "admin_crypto_wallet_add_other_network", { currency });
        await tg("sendMessage", { chat_id: chatId, text: "╪┤╪¿┌⌐┘ç/╪¿┘ä╪º┌⌐┌å█î┘å ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪» (┘à╪½╪º┘ä: BTC╪î TRC20╪î ERC20╪î TON):" });
        return true;
    }
    if (state.state === "admin_crypto_wallet_add_other_network") {
        const currency = String(state.payload.currency || "").toUpperCase();
        const network = text.trim().toUpperCase();
        if (!currency || !network) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤╪¿┌⌐┘ç ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return true;
        }
        const inserted = await sql `
      INSERT INTO crypto_wallets (currency, network, active)
      VALUES (${currency}, ${network}, FALSE)
      ON CONFLICT (currency, network) DO UPDATE SET currency = EXCLUDED.currency
      RETURNING id;
    `;
        const walletId = Number(inserted[0].id);
        await setState(userId, "admin_crypto_wallet_set_address", { walletId });
        await tg("sendMessage", { chat_id: chatId, text: `╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä ${currency} (${network}) ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -` });
        return true;
    }
    if (state.state === "admin_crypto_wallet_set_address") {
        const walletId = Number(state.payload.walletId);
        const raw = text.trim();
        const address = raw === "-" ? "" : raw;
        await sql `UPDATE crypto_wallets SET address = ${address} WHERE id = ${walletId};`;
        const rows = await sql `SELECT currency, network FROM crypto_wallets WHERE id = ${walletId} LIMIT 1;`;
        await clearState(userId);
        if (rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: `╪ó╪»╪▒╪│ ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${String(rows[0].currency)} (${String(rows[0].network)})` });
        }
        else {
            await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        }
        return true;
    }
    if (state.state === "admin_crypto_wallet_set_rate") {
        const walletId = Number(state.payload.walletId);
        const raw = text.trim();
        if (raw === "-") {
            await sql `UPDATE crypto_wallets SET rate_toman_per_unit = NULL, rate_mode = 'manual' WHERE id = ${walletId};`;
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« ╪»╪│╪¬█î ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
            return true;
        }
        const rate = Math.round(Number(raw));
        if (!Number.isFinite(rate) || rate <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 65000" });
            return true;
        }
        await sql `UPDATE crypto_wallets SET rate_toman_per_unit = ${rate}, rate_mode = 'manual' WHERE id = ${walletId};`;
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┘å╪▒╪« ╪»╪│╪¬█î ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${rate} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_crypto_wallet_set_extra") {
        const walletId = Number(state.payload.walletId);
        const raw = text.trim();
        if (raw === "-") {
            await sql `UPDATE crypto_wallets SET extra_toman_per_unit = 0 WHERE id = ${walletId};`;
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪¡╪º╪┤█î┘ç ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
            return true;
        }
        const extra = Math.round(Number(raw));
        if (!Number.isFinite(extra)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 2000" });
            return true;
        }
        await sql `UPDATE crypto_wallets SET extra_toman_per_unit = ${extra} WHERE id = ${walletId};`;
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪¡╪º╪┤█î┘ç ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${extra} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_set_plisio_extra_toman") {
        const raw = text.trim();
        if (raw === "-") {
            await setSetting("plisio_usdt_extra_toman", "");
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪¡╪º╪┤█î┘ç ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
            return true;
        }
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 2000" });
            return true;
        }
        await setSetting("plisio_usdt_extra_toman", String(n));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪¡╪º╪┤█î┘ç ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${n} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_set_plisio_fallback_rate") {
        const raw = text.trim();
        if (raw === "-") {
            await setSetting("plisio_usdt_rate_fallback_toman", "");
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« ╪»╪│╪¬█î (fallback) ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
            return true;
        }
        const rate = Math.round(Number(raw));
        if (!Number.isFinite(rate) || rate <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 65000" });
            return true;
        }
        await setSetting("plisio_usdt_rate_fallback_toman", String(rate));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┘å╪▒╪« ╪»╪│╪¬█î (fallback) ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${rate} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_pingchi_set_key") {
        const raw = text.trim();
        if (raw.length < 10) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return true;
        }
        await setSetting("pingchi_api_key", raw);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» ╪»╪│╪¬╪▒╪│█î ┘╛█î┘å┌»┌å█î ╪¿╪º ┘à┘ê┘ü┘é█î╪¬ ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_set_plisio_usd_rate") {
        const raw = text.trim();
        if (raw === "-") {
            await setSetting("plisio_usd_rate_toman", "");
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« ╪»┘ä╪º╪▒ ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
            return true;
        }
        const rate = Math.round(Number(raw));
        if (!Number.isFinite(rate) || rate <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 60000" });
            return true;
        }
        await setSetting("plisio_usd_rate_toman", String(rate));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┘å╪▒╪« ╪»┘ä╪º╪▒ Plisio ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${rate} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_set_topup_price") {
        const pricePerGb = normalizePricePerGb(text.trim());
        if (!Number.isFinite(pricePerGb) || pricePerGb <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 500000" });
            return true;
        }
        await setSetting("topup_price_per_gb_toman", String(Math.round(pricePerGb)));
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘é█î┘à╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪½╪¿╪¬ ╪┤╪» Γ£à\n┘ç╪▒ 1GB = ${formatPriceToman(Math.round(pricePerGb))} ╪¬┘ê┘à╪º┘å`
        });
        return true;
    }
    if (state.state === "admin_set_product_price") {
        const pricePerGb = normalizePricePerGb(text.trim());
        if (!Number.isFinite(pricePerGb) || pricePerGb <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 500000" });
            return true;
        }
        await setSetting("product_price_per_gb_toman", String(Math.round(pricePerGb)));
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘é█î┘à╪¬ ┘╛█î╪┤┘ü╪▒╪╢ ┘à╪¡╪╡┘ê┘ä╪º╪¬ ╪½╪¿╪¬ ╪┤╪» Γ£à\n┘ç╪▒ 1GB = ${formatPriceToman(Math.round(pricePerGb))} ╪¬┘ê┘à╪º┘å`
        });
        return true;
    }
    if (state.state === "admin_set_custom_v2ray_extra_day") {
        const raw = text.trim();
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n) || n < 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 10000\n╪¿╪▒╪º█î ╪«╪º┘à┘ê╪┤: 0" });
            return true;
        }
        await setSetting("custom_v2ray_extra_day_toman", String(n));
        const enabled = await getBoolSetting("custom_v2ray_enabled", false);
        const productId = Number((await getSetting("custom_v2ray_product_id")) || 0);
        if (enabled && Number.isFinite(productId) && productId > 0) {
            const pricePerGb = normalizePricePerGb(await getSetting("product_price_per_gb_toman"), normalizePricePerGb(await getSetting("topup_price_per_gb_toman")));
            const minGb = Math.max(1, Math.round((await getNumberSetting("custom_v2ray_min_gb")) || 1));
            const minDays = Math.max(1, Math.round((await getNumberSetting("custom_v2ray_min_days")) || 30));
            const minPrice = Math.max(1, (pricePerGb * minGb) + (minDays * Math.max(0, n)));
            await sql `UPDATE products SET price_toman = ${minPrice} WHERE id = ${productId};`;
        }
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n┘é█î┘à╪¬ ┘ç╪▒ ╪▒┘ê╪▓: ${formatPriceToman(n)} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_set_custom_v2ray_min_gb") {
        const raw = text.trim();
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n) || n < 1) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ╪¡╪»╪º┘é┘ä █▒ ┌»█î┌»╪º╪¿╪º█î╪¬" });
            return true;
        }
        await setSetting("custom_v2ray_min_gb", String(n));
        const enabled = await getBoolSetting("custom_v2ray_enabled", false);
        const productId = Number((await getSetting("custom_v2ray_product_id")) || 0);
        if (enabled && Number.isFinite(productId) && productId > 0) {
            const pricePerGb = normalizePricePerGb(await getSetting("product_price_per_gb_toman"), normalizePricePerGb(await getSetting("topup_price_per_gb_toman")));
            const minDays = Math.max(1, Math.round((await getNumberSetting("custom_v2ray_min_days")) || 30));
            const dayPrice = Math.max(0, Math.round((await getNumberSetting("custom_v2ray_extra_day_toman")) || 0));
            const minPrice = Math.max(1, (pricePerGb * n) + (minDays * dayPrice));
            await sql `UPDATE products SET price_toman = ${minPrice} WHERE id = ${productId};`;
        }
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n╪¡╪»╪º┘é┘ä ╪¡╪¼┘à ┌⌐╪º┘å┘ü█î┌» ╪»┘ä╪«┘ê╪º┘ç: ${n}GB` });
        return true;
    }
    if (state.state === "admin_set_custom_v2ray_min_days") {
        const raw = text.trim();
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n) || n < 1) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ╪¡╪»╪º┘é┘ä █▒ ╪▒┘ê╪▓" });
            return true;
        }
        await setSetting("custom_v2ray_min_days", String(n));
        const enabled = await getBoolSetting("custom_v2ray_enabled", false);
        const productId = Number((await getSetting("custom_v2ray_product_id")) || 0);
        if (enabled && Number.isFinite(productId) && productId > 0) {
            const pricePerGb = normalizePricePerGb(await getSetting("product_price_per_gb_toman"), normalizePricePerGb(await getSetting("topup_price_per_gb_toman")));
            const minGb = Math.max(1, Math.round((await getNumberSetting("custom_v2ray_min_gb")) || 1));
            const dayPrice = Math.max(0, Math.round((await getNumberSetting("custom_v2ray_extra_day_toman")) || 0));
            const minPrice = Math.max(1, (pricePerGb * minGb) + (n * dayPrice));
            await sql `UPDATE products SET price_toman = ${minPrice} WHERE id = ${productId};`;
        }
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n╪¡╪»╪º┘é┘ä ╪▓┘à╪º┘å ┌⌐╪º┘å┘ü█î┌» ╪»┘ä╪«┘ê╪º┘ç: ${n} ╪▒┘ê╪▓` });
        return true;
    }
    if (state.state === "admin_set_purchase_bonus_min") {
        const n = Math.round(Number(text.trim()));
        if (!Number.isFinite(n) || n < 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 1000" });
            return true;
        }
        await setSetting("purchase_bonus_min", String(n));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n╪¡╪»╪º┘é┘ä ╪¼╪º█î╪▓┘ç: ${formatPriceToman(n)} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_set_purchase_bonus_max") {
        const n = Math.round(Number(text.trim()));
        if (!Number.isFinite(n) || n < 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 10000" });
            return true;
        }
        await setSetting("purchase_bonus_max", String(n));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n╪¡╪»╪º┌⌐╪½╪▒ ╪¼╪º█î╪▓┘ç: ${formatPriceToman(n)} ╪¬┘ê┘à╪º┘å` });
        return true;
    }
    if (state.state === "admin_set_test_config_mb") {
        const n = Math.round(Number(text.trim()));
        if (!Number.isFinite(n) || n <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ (╪¿╪▓╪▒┌»╪¬╪▒ ╪º╪▓ ╪╡┘ü╪▒) ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 100" });
            return true;
        }
        await setSetting("test_config_mb", String(n));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n╪¡╪¼┘à ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬: ${n}MB` });
        return true;
    }
    if (state.state === "admin_set_test_config_hours") {
        const n = Math.round(Number(text.trim()));
        if (!Number.isFinite(n) || n <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ (╪¿╪▓╪▒┌»╪¬╪▒ ╪º╪▓ ╪╡┘ü╪▒) ╪¿┘ü╪▒╪│╪¬█î╪». ┘à╪½╪º┘ä: 24" });
            return true;
        }
        await setSetting("test_config_hours", String(n));
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n┘à╪»╪¬ ╪▓┘à╪º┘å ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬: ${n} ╪│╪º╪╣╪¬` });
        return true;
    }
    if (state.state === "admin_add_admin") {
        const newAdminId = Number(text.trim());
        if (!Number.isFinite(newAdminId) || newAdminId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï █î┌⌐ ╪ó█î╪»█î ╪╣╪»╪»█î ┘à╪╣╪¬╪¿╪▒ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
            return true;
        }
        // Check if user exists
        const userRows = await sql `SELECT telegram_id FROM users WHERE telegram_id = ${newAdminId} LIMIT 1;`;
        if (!userRows.length) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "ΓÜá∩╕Å ╪º█î┘å ┌⌐╪º╪▒╪¿╪▒ ┘ç┘å┘ê╪▓ ╪¿╪º ╪▒╪¿╪º╪¬ ╪¬╪╣╪º┘à┘ä█î ┘å╪»╪º╪┤╪¬┘ç ╪º╪│╪¬.\n╪ó█î╪º ┘à╪╖┘à╪ª┘å█î╪» ┘à█îΓÇî╪«┘ê╪º┘ç█î╪» ╪º╪»┘à█î┘å ┌⌐┘å█î╪»╪ƒ ╪¿╪▒╪º█î ╪¬╪º█î█î╪»╪î ╪»┘ê╪¿╪º╪▒┘ç ┘ç┘à█î┘å ╪ó█î╪»█î ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪»."
            });
            // Store pending admin add
            await setState(userId, "admin_confirm_add_admin", { pendingAdminId: newAdminId });
            return true;
        }
        // Add to admin_ids in settings
        const currentSetting = (await getSetting("admin_ids")) || "";
        const currentIds = String(currentSetting)
            .split(/[,\s]+/)
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isFinite(x));
        if (!currentIds.includes(newAdminId)) {
            currentIds.push(newAdminId);
            await setSetting("admin_ids", currentIds.join(","));
        }
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪º╪»┘à█î┘å ${newAdminId} ╪º╪╢╪º┘ü┘ç ╪┤╪» Γ£à` });
        return true;
    }
    if (state.state === "admin_confirm_add_admin") {
        const newAdminId = Number(text.trim());
        const pendingId = Number(state.payload?.pendingAdminId || 0);
        if (newAdminId !== pendingId) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪ó█î╪»█î ╪¿╪º ╪ó█î╪»█î ┘é╪¿┘ä█î ┘à╪╖╪º╪¿┘é╪¬ ┘å╪»╪º╪▒╪». ╪╣┘à┘ä█î╪º╪¬ ┘ä╪║┘ê ╪┤╪»." });
            return true;
        }
        // Add to admin_ids in settings
        const currentSetting = (await getSetting("admin_ids")) || "";
        const currentIds = String(currentSetting)
            .split(/[,\s]+/)
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isFinite(x));
        if (!currentIds.includes(newAdminId)) {
            currentIds.push(newAdminId);
            await setSetting("admin_ids", currentIds.join(","));
        }
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `╪º╪»┘à█î┘å ${newAdminId} ╪º╪╢╪º┘ü┘ç ╪┤╪» Γ£à` });
        return true;
    }
    if (state.state === "admin_ban_username") {
        const username = text.replace("@", "").trim().toLowerCase();
        if (!username) {
            await tg("sendMessage", { chat_id: chatId, text: "█î┘ê╪▓╪▒┘å█î┘à ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪»." });
            return true;
        }
        const rows = await sql `
      SELECT telegram_id
      FROM users
      WHERE LOWER(username) = ${username}
      ORDER BY last_seen_at DESC
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒█î ╪¿╪º ╪º█î┘å █î┘ê╪▓╪▒┘å█î┘à ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        await sql `
      INSERT INTO banned_users (telegram_id, reason, banned_by)
      VALUES (${rows[0].telegram_id}, 'manual_username_ban', ${userId})
      ON CONFLICT (telegram_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by;
    `;
        try {
            await tg("sendMessage", { chat_id: Number(rows[0].telegram_id), text: "╪»╪│╪¬╪▒╪│█î ╪┤┘à╪º ╪¿┘ç ╪»┘ä█î┘ä ╪¬╪«┘ä┘ü/╪│┘ê╪í╪º╪│╪¬┘ü╪º╪»┘ç ┘à╪│╪»┘ê╪» ╪┤╪»." });
        }
        catch (error) {
            logError("ban_user_notify_failed", error, { targetUserId: Number(rows[0].telegram_id), by: userId, mode: "username" });
        }
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: `┌⌐╪º╪▒╪¿╪▒ @${username} ╪¿┘å ╪┤╪» Γ£à` });
        return true;
    }
    if (state.state === "admin_message_user") {
        const { targetRaw, messageText } = parseAdminMessageInput(text);
        if (!targetRaw || !messageText) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ┘╛█î╪º┘à ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬.\n┘é╪»█î┘à█î: telegram_id|┘à╪¬┘å ┘╛█î╪º┘à\n╪¼╪»█î╪»:\ntarget: 123456\nmessage: ╪│┘ä╪º┘à"
            });
            return true;
        }
        if (!messageText) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¬┘å ┘╛█î╪º┘à ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
            return true;
        }
        let targetId = Number(targetRaw);
        if (!Number.isFinite(targetId)) {
            const username = targetRaw.replace("@", "").trim().toLowerCase();
            const rows = await sql `
        SELECT telegram_id
        FROM users
        WHERE LOWER(username) = ${username}
        ORDER BY last_seen_at DESC
        LIMIT 1;
      `;
            if (!rows.length) {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒ █î╪º┘ü╪¬ ┘å╪┤╪»." });
                return true;
            }
            targetId = Number(rows[0].telegram_id);
        }
        try {
            await tg("sendMessage", { chat_id: targetId, text: messageText });
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘╛█î╪º┘à ╪º╪▒╪│╪º┘ä ╪┤╪» Γ£à" });
        }
        catch (error) {
            logError("admin_message_user_failed", error, { fromAdminId: userId, targetId });
            await tg("sendMessage", { chat_id: chatId, text: "╪º╪▒╪│╪º┘ä ┘╛█î╪º┘à ╪º┘å╪¼╪º┘à ┘å╪┤╪». ┌⌐╪º╪▒╪¿╪▒ ┘à┘à┌⌐┘å ╪º╪│╪¬ ╪▒╪¿╪º╪¬ ╪▒╪º ╪¿┘ä╪º┌⌐ ┌⌐╪▒╪»┘ç ╪¿╪º╪┤╪»." });
        }
        return true;
    }
    if (state.state === "admin_lookup_purchase") {
        const purchaseId = text.trim();
        if (!purchaseId) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
            return true;
        }
        await sendPurchaseLookupResult(chatId, purchaseId);
        await clearState(userId);
        return true;
    }
    if (state.state === "admin_lookup_config") {
        const raw = text.trim();
        if (!raw) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┌⌐╪º┘à┘ä╪î UUID╪î ┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒ (╪¬┘ä┌»╪▒╪º┘à █î╪º ┘╛┘å┘ä) █î╪º ┘å╪º┘à ┘à╪¡╪╡┘ê┘ä ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
            return true;
        }
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isUuid = uuidRegex.test(raw);
        const matches = await sql `
      SELECT
        i.id,
        i.panel_id,
        i.owner_telegram_id,
        i.status,
        i.config_value,
        i.delivery_payload,
        p.name AS product_name,
        o.purchase_id,
        u.username AS tg_username,
        u.first_name AS tg_first_name,
        u.last_name AS tg_last_name
      FROM inventory i
      LEFT JOIN products p ON p.id = i.product_id
      LEFT JOIN orders o ON o.id = i.sold_order_id
      LEFT JOIN users u ON u.telegram_id = i.owner_telegram_id
      WHERE (
        (${isUuid} = TRUE AND (i.delivery_payload->'metadata'->>'uuid') = ${raw})
        OR (${isUuid} = FALSE AND (i.config_value = ${raw} OR i.config_value ILIKE ${"%" + raw + "%"}))
        OR (i.config_value ILIKE ${"%" + raw + "%"})
        OR ((i.delivery_payload->>'subscriptionUrl') ILIKE ${"%" + raw + "%"})
        OR (i.delivery_payload::text ILIKE ${"%" + raw + "%"})
        OR (u.username ILIKE ${"%" + raw + "%"})
        OR (u.first_name ILIKE ${"%" + raw + "%"})
        OR (u.last_name ILIKE ${"%" + raw + "%"})
        OR (p.name ILIKE ${"%" + raw + "%"})
      )
      ORDER BY i.id DESC
      LIMIT 10;
    `;
        if (matches.length) {
            const uniqueOwners = Array.from(new Set(matches.map((m) => Number(m.owner_telegram_id || 0)).filter((x) => x > 0)));
            if (uniqueOwners.length === 1) {
                const targetUser = uniqueOwners[0];
                const userRows = await sql `SELECT telegram_id, username, first_name, last_name FROM users WHERE telegram_id = ${targetUser} LIMIT 1;`;
                const u = userRows.length ? userRows[0] : { telegram_id: targetUser, username: null, first_name: null, last_name: null };
                const usernameLine = u.username ? `@${String(u.username)}` : "-";
                const fullName = [u.first_name ? String(u.first_name) : "", u.last_name ? String(u.last_name) : ""].filter(Boolean).join(" ").trim() || "-";
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: `Γ£à ┘╛█î╪»╪º ╪┤╪»\n` +
                        `≡ƒæñ ┌⌐╪º╪▒╪¿╪▒: ${targetUser}\n` +
                        `≡ƒåö █î┘ê╪▓╪▒┘å█î┘à: ${usernameLine}\n` +
                        `≡ƒô¢ ┘å╪º┘à: ${fullName}\n` +
                        `≡ƒôª ╪¬╪╣╪»╪º╪» ┘à┌å: ${matches.length}`,
                    reply_markup: {
                        inline_keyboard: [[{ text: "Γ¢ö ╪¿┘å ┌⌐╪º╪▒╪¿╪▒", callback_data: `admin_lookup_ban_${targetUser}` }]]
                    }
                });
            }
            else {
                const lines = matches.map((m) => {
                    const owner = Number(m.owner_telegram_id || 0) || "-";
                    const pid = String(m.purchase_id || "-");
                    return `#${m.id} | owner:${owner} | order:${pid} | ${String(m.product_name || "-")}`;
                });
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: `Γ£à ${matches.length} ┘å╪¬█î╪¼┘ç ┘╛█î╪»╪º ╪┤╪»\n` +
                        `┘à╪º┘ä┌⌐ █î┌⌐╪│╪º┘å ┘å█î╪│╪¬ █î╪º ╪¬╪╣█î█î┘å ┘å╪┤╪»┘ç:\n\n${lines.join("\n")}\n\n` +
                        `╪¼╪▓╪ª█î╪º╪¬ ┘ê ╪º╪¿╪▓╪º╪▒ ┘ç╪▒ ┘à┘ê╪▒╪» ╪»╪▒ ┘╛█î╪º┘àΓÇî┘ç╪º█î ╪¿╪╣╪»█î ╪ó┘à╪»┘ç ╪º╪│╪¬.`
                });
            }
            const panelCache = new Map();
            for (const row of matches) {
                let payload = parseDeliveryPayload(row.delivery_payload);
                let isPanelConfig = Boolean(payload.metadata?.panelType) && Number(row.panel_id || 0) > 0;
                if (!isPanelConfig && row.config_value) {
                    const foundOnPanel = await lookupIdentifierInPanels(String(row.config_value ?? ""));
                    if (foundOnPanel.ok && foundOnPanel.source === "panel") {
                        row.panel_id = foundOnPanel.panelId;
                        payload.metadata = payload.metadata || {};
                        payload.metadata.panelType = foundOnPanel.panelType;
                        if (isMarzbanLike(foundOnPanel.panelType)) {
                            payload.metadata.username = foundOnPanel.panelUserKey;
                            const userRec = foundOnPanel.panelUser;
                            if (userRec.links && Array.isArray(userRec.links) && userRec.links.length > 0 && !payload.subscriptionUrl) {
                                payload.subscriptionUrl = String(userRec.links[0]);
                            }
                        }
                        else if (foundOnPanel.panelType === "sanaei") {
                            payload.metadata.email = foundOnPanel.panelUserKey;
                            payload.metadata.inboundId = foundOnPanel.inboundId;
                            payload.metadata.uuid = extractUuidFromText(String(row.config_value ?? ""));
                        }
                        await sql `
              UPDATE inventory 
              SET panel_id = ${foundOnPanel.panelId}, delivery_payload = ${JSON.stringify(payload)}::jsonb
              WHERE id = ${row.id}
            `;
                        row.delivery_payload = JSON.stringify(payload);
                        isPanelConfig = true;
                    }
                }
                const revoked = payload.metadata?.revoked === true;
                const panelDetails = await buildInventoryPanelRuntimeDetails(Number(row.id), row.panel_id, row.delivery_payload, panelCache);
                const ownerLabel = Number(row.owner_telegram_id || 0) > 0 ? String(Number(row.owner_telegram_id)) : "-";
                const keyboard = [
                    [
                        revoked
                            ? confirmButton(`admin_lookup_toggle_inv_${row.id}`, "Γ£à ┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î")
                            : cb("≡ƒÜ½ ╪║█î╪▒┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î", `admin_lookup_toggle_inv_${row.id}`, "danger"),
                        cb("≡ƒùæ ╪¡╪░┘ü ┌⌐╪º┘à┘ä", `admin_lookup_delete_inv_${row.id}`, "danger")
                    ],
                    [
                        cb("≡ƒöä ╪¿╪º╪▓╪│╪º╪▓█î ┘ä█î┘å┌⌐", `admin_lookup_regen_link_${row.id}`, "primary")
                    ]
                ];
                if (isPanelConfig) {
                    keyboard.push([
                        cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ╪»█î╪¬╪º", `admin_lookup_add_data_${row.id}`, "primary"),
                        cb("Γ£Å∩╕Å ╪¬┘å╪╕█î┘à ╪│┘é┘ü ╪»█î╪¬╪º", `admin_lookup_set_data_${row.id}`, "primary")
                    ]);
                    keyboard.push([
                        cb("ΓÖ╗∩╕Å ╪▒█î╪│╪¬ ┘à╪╡╪▒┘ü", `admin_lookup_reset_data_${row.id}`, "primary"),
                        cb("≡ƒöù ┘ä█î┘å┌⌐ΓÇî┘ç╪º█î ┘à╪│╪¬┘é█î┘à", `admin_lookup_direct_links_${row.id}`, "primary")
                    ]);
                    keyboard.push([
                        cb("≡ƒôà ╪¬┘å╪╕█î┘à ╪º┘å┘é╪╢╪º", `admin_lookup_set_expiry_${row.id}`, "primary"),
                        cb("ΓÖ╛∩╕Å ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º", `admin_lookup_set_expiry_${row.id}_0`, "primary")
                    ]);
                }
                let prevConfigsText = "";
                if (payload.previousConfigs && payload.previousConfigs.length > 0) {
                    prevConfigsText = `\n\n≡ƒòÆ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î ┘é╪¿┘ä█î:\n${payload.previousConfigs.map((c) => escapeHtml(responseSnippet(c, 100))).join("\n")}`;
                }
                await tg("sendMessage", {
                    chat_id: chatId,
                    parse_mode: "HTML",
                    text: `≡ƒº╛ #${row.id} | ${row.product_name || "-"} | order:${row.purchase_id || "-"}${revoked ? " | ≡ƒÜ½" : ""}\n` +
                        `≡ƒæñ owner: ${ownerLabel} | ┘ê╪╢╪╣█î╪¬: ${row.status || "-"}\n` +
                        `${panelDetails ? `${escapeHtml(panelDetails)}\n` : "≡ƒûÑ ┘╛┘å┘ä: ┘å╪º┘à╪┤╪«╪╡\n"}` +
                        `\n${isPanelConfig
                            ? `≡ƒöù ╪│╪º╪¿:\n${payload.subscriptionUrl ? escapeHtml(String(payload.subscriptionUrl)) : "-"}`
                            : escapeHtml(responseSnippet(String(row.config_value || ""), 220))}${prevConfigsText}`,
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                });
            }
            await clearState(userId);
            return true;
        }
        const forensicMatches = await sql `
      SELECT
        id,
        inventory_id,
        owner_telegram_id,
        panel_id,
        panel_type,
        panel_user_key,
        uuid,
        event_type,
        config_value,
        created_at
      FROM config_forensics
      WHERE
        (${isUuid} = TRUE AND uuid = ${raw})
        OR (config_value ILIKE ${"%" + raw + "%"})
        OR (panel_user_key ILIKE ${"%" + raw + "%"})
        OR (metadata::text ILIKE ${"%" + raw + "%"})
      ORDER BY created_at DESC
      LIMIT 5;
    `;
        if (forensicMatches.length) {
            const lines = forensicMatches.map((m) => {
                const owner = Number(m.owner_telegram_id || 0) || "-";
                const dateStr = m.created_at ? new Date(m.created_at).toLocaleDateString("fa-IR") : "-";
                return `≡ƒö╣ ╪▒┘ê█î╪»╪º╪»: ${m.event_type} | ┘à╪º┘ä┌⌐: ${owner} | ╪¬╪º╪▒█î╪«: ${dateStr}`;
            });
            await tg("sendMessage", {
                chat_id: chatId,
                text: `≡ƒöÄ ╪│┘ê╪º╪¿┘é █î╪º┘ü╪¬ ╪┤╪»┘ç ╪»╪▒ ╪ó╪▒╪┤█î┘ê:\n\n${lines.join("\n")}\n\nΓÅ│ ╪»╪▒ ╪¡╪º┘ä ╪º╪│╪¬╪╣┘ä╪º┘à ┘à╪│╪¬┘é█î┘à ╪º╪▓ ┘╛┘å┘ä...`
            });
        }
        const panelMatch = await lookupIdentifierInPanels(raw);
        if (!panelMatch.ok) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┘à┘ê╪▒╪»█î ╪»╪▒ ┘ä█î╪│╪¬ ┘ü╪▒┘ê╪┤╪î ╪ó╪▒╪┤█î┘ê █î╪º ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            await clearState(userId);
            return true;
        }
        const targetUser = Number(panelMatch.ownerTelegramId || 0) || null;
        const userRows = targetUser
            ? await sql `SELECT telegram_id, username, first_name, last_name FROM users WHERE telegram_id = ${targetUser} LIMIT 1;`
            : [];
        const u = userRows.length ? userRows[0] : { telegram_id: targetUser, username: null, first_name: null, last_name: null };
        await recordForensicEvent({
            inventoryId: null,
            ownerTelegramId: targetUser,
            productId: null,
            panelId: Number(panelMatch.panelId || 0) || null,
            panelType: String(panelMatch.panelType || ""),
            panelUserKey: String(panelMatch.panelUserKey || ""),
            uuid: extractUuidFromText(raw),
            source: "panel_lookup",
            eventType: "admin_lookup_panel_hit",
            configValue: raw,
            metadata: { panelName: panelMatch.panelName || "", actorAdmin: userId }
        });
        const banBtn = targetUser && Number.isFinite(targetUser)
            ? [{ text: "Γ¢ö ╪¿┘å ┌⌐╪º╪▒╪¿╪▒", callback_data: `admin_lookup_ban_${targetUser}` }]
            : [{ text: "Γä╣∩╕Å ╪┤┘å╪º╪│┘ç ┌⌐╪º╪▒╪¿╪▒ ┘å╪º┘à╪┤╪«╪╡", callback_data: "noop_lookup_user_unknown" }];
        const panelKey = encodeURIComponent(String(panelMatch.panelUserKey || ""));
        const panelUser = toJsonObject(panelMatch.panelUser) || {};
        const panelSubscriptionUrl = String(panelUser.subscription_url || panelUser.subscriptionUrl || "").trim() ||
            (String(panelMatch.panelType || "") === "sanaei" && panelUser.subId && panelMatch.panelBaseUrl
                ? buildSanaeiSubscriptionUrl(String(panelMatch.panelBaseUrl), {}, String(panelUser.subId), {
                    subscription_public_port: panelMatch.subscriptionPublicPort ?? undefined,
                    subscription_public_host: panelMatch.subscriptionPublicHost ?? undefined,
                    subscription_link_protocol: panelMatch.subscriptionLinkProtocol ?? undefined
                })
                : "");
        const panelRuntimeLine = isMarzbanLike(String(panelMatch.panelType || ""))
            ? `≡ƒôè ┘à╪╡╪▒┘ü: ${Number(panelUser.data_limit || 0) > 0
                ? `${formatBytesShort(panelUser.used_traffic || panelUser.usedTraffic || 0)} / ${formatBytesShort(panelUser.data_limit)}`
                : "┘å╪º┘à╪¡╪»┘ê╪»"}\n≡ƒôà ╪º┘å┘é╪╢╪º: ${formatExpiryLabelFromSeconds(panelUser.expire)}`
            : `≡ƒôè ┘à╪╡╪▒┘ü: ${Number(panelUser.totalGB || 0) > 0
                ? `${formatBytesShort((Number(panelUser.up || 0) + Number(panelUser.down || 0)) || 0)} / ${formatBytesShort(panelUser.totalGB)}`
                : "┘å╪º┘à╪¡╪»┘ê╪»"}\n≡ƒôà ╪º┘å┘é╪╢╪º: ${formatExpiryLabelFromMilliseconds(panelUser.expiryTime)}`;
        const panelRevoked = (isMarzbanLike(String(panelMatch.panelType || "")) && panelUser.status === "disabled") ||
            (String(panelMatch.panelType || "") === "sanaei" && panelUser.enable === false);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `Γ£à ┘╛█î╪»╪º ╪┤╪» (Panel Fallback)\n` +
                `≡ƒûÑ ┘╛┘å┘ä: ${String(panelMatch.panelName || "-")} (${String(panelMatch.panelType || "-")})\n` +
                `≡ƒöæ ┌⌐┘ä█î╪» ┌⌐╪º╪▒╪¿╪▒ ┘╛┘å┘ä: ${String(panelMatch.panelUserKey || "-")}\n` +
                `≡ƒöù ╪│╪º╪¿: ${panelSubscriptionUrl || "-"}\n` +
                `${panelRuntimeLine}\n` +
                `≡ƒæñ ╪¬┘ä┌»╪▒╪º┘à: ${targetUser || "-"}\n` +
                `≡ƒåö █î┘ê╪▓╪▒┘å█î┘à: ${u.username ? `@${String(u.username)}` : "-"}\n` +
                `≡ƒô¢ ┘å╪º┘à: ${[u.first_name ? String(u.first_name) : "", u.last_name ? String(u.last_name) : ""].filter(Boolean).join(" ").trim() || "-"}`,
            reply_markup: {
                inline_keyboard: [
                    banBtn,
                    [
                        panelRevoked
                            ? confirmButton(`admin_panel_toggle_${panelMatch.panelId}_${panelKey}`, "Γ£à ┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î")
                            : cb("≡ƒÜ½ ╪║█î╪▒┘ü╪╣╪º┘äΓÇî╪│╪º╪▓█î", `admin_panel_toggle_${panelMatch.panelId}_${panelKey}`, "danger"),
                        cb("≡ƒùæ ╪¡╪░┘ü ┌⌐╪º┘à┘ä ╪º╪▓ ┘╛┘å┘ä", `admin_panel_del_${panelMatch.panelId}_${panelKey}`, "danger")
                    ],
                    [
                        cb("≡ƒöä ╪¿╪º╪▓╪│╪º╪▓█î ┘ä█î┘å┌⌐", `admin_panel_rv_${panelMatch.panelId}_${panelKey}`, "primary")
                    ],
                    [
                        cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ╪»█î╪¬╪º", `admin_panel_add_data_${panelMatch.panelId}_${panelKey}`, "primary"),
                        cb("Γ£Å∩╕Å ╪¬┘å╪╕█î┘à ╪│┘é┘ü ╪»█î╪¬╪º", `admin_panel_set_data_${panelMatch.panelId}_${panelKey}`, "primary")
                    ],
                    [cb("ΓÖ╗∩╕Å ╪▒█î╪│╪¬ ┘à╪╡╪▒┘ü", `admin_panel_reset_data_${panelMatch.panelId}_${panelKey}`, "primary")],
                    [
                        cb("≡ƒôà ╪¬┘å╪╕█î┘à ╪º┘å┘é╪╢╪º", `admin_panel_set_expiry_${panelMatch.panelId}_${panelKey}`, "primary"),
                        cb("ΓÖ╛∩╕Å ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º", `admin_panel_set_expiry_${panelMatch.panelId}_${panelKey}_days_0`, "primary")
                    ]
                ]
            }
        });
        await clearState(userId);
        return true;
    }
    if (state.state === "admin_lookup_add_data") {
        const inventoryId = Number(state.payload.inventoryId || 0);
        const addMb = parseDataAmountToMb(text);
        if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪┤╪»." });
            return true;
        }
        if (!addMb || addMb <= 0 || addMb > 1000000) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à┘é╪»╪º╪▒ ┘à╪╣╪¬╪¿╪▒ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». (╪¡╪»╪º┌⌐╪½╪▒ █▒█░█░█░ ┌»█î┌»╪º╪¿╪º█î╪¬)" });
            return true;
        }
        const rows = await sql `
      SELECT i.id, i.panel_id, i.delivery_payload
      FROM inventory i
      WHERE i.id = ${inventoryId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const row = rows[0];
        const delivery = parseDeliveryPayload(row.delivery_payload);
        const panelType = String(delivery.metadata?.panelType || "");
        const panelId = Number(row.panel_id || 0);
        if (!panelId || !panelType) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘╛┘å┘ä█î ┘å█î╪│╪¬." });
            return true;
        }
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!panelRows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const addBytes = Math.max(0, Math.round(addMb * 1024 * 1024));
        let result = { ok: false, message: "┘╛┘å┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." };
        if (isMarzbanLike(panelType)) {
            const username = String(delivery.metadata?.username || "").trim();
            if (!username) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "username ┘╛┘å┘ä ╪»╪▒ ┘à╪¬╪º╪»█î╪¬╪º ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            result = await applyTopupOnMarzban(panelRows[0], username, addBytes);
        }
        else if (panelType === "sanaei") {
            const inboundId = parseMaybeNumber(delivery.metadata?.inboundId);
            const email = String(delivery.metadata?.email || "").trim();
            if (!inboundId || !email) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "inbound/email ╪»╪▒ ┘à╪¬╪º╪»█î╪¬╪º ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘é╪╡ ╪º╪│╪¬." });
                return true;
            }
            result = await applyTopupOnSanaei(panelRows[0], inboundId, email, addBytes);
        }
        await clearState(userId);
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${result.message}` });
            return true;
        }
        await recordInventoryForensicEvent(inventoryId, "admin_lookup_add_data", { adminId: userId, addMb, panelResult: result.message });
        await tg("sendMessage", { chat_id: chatId, text: `╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à\n┘à┘é╪»╪º╪▒: ${addMb}MB\n${result.message}` });
        return true;
    }
    if (state.state === "admin_lookup_set_data") {
        const inventoryId = Number(state.payload.inventoryId || 0);
        const raw = text.trim();
        const isInfinite = raw === "0" || parseInfiniteDataFlag(raw);
        const targetMb = isInfinite ? 0 : parseDataAmountToMb(raw);
        if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪┤╪»." });
            return true;
        }
        if (!isInfinite && (!targetMb || targetMb <= 0 || targetMb > 1000000)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¡╪¼┘à ╪¼╪»█î╪» ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. (╪¡╪»╪º┌⌐╪½╪▒ █▒█░█░█░ ┌»█î┌»╪º╪¿╪º█î╪¬ █î╪º unlimited)" });
            return true;
        }
        const rows = await sql `
      SELECT i.id, i.panel_id, i.delivery_payload
      FROM inventory i
      WHERE i.id = ${inventoryId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const row = rows[0];
        const delivery = parseDeliveryPayload(row.delivery_payload);
        const panelType = String(delivery.metadata?.panelType || "");
        const panelId = Number(row.panel_id || 0);
        if (!panelId || !panelType) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘╛┘å┘ä█î ┘å█î╪│╪¬." });
            return true;
        }
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!panelRows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const targetBytes = isInfinite ? 0 : Math.max(0, Math.round(Number(targetMb || 0) * 1024 * 1024));
        let result = { ok: false, message: "┘╛┘å┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." };
        if (isMarzbanLike(panelType)) {
            const username = String(delivery.metadata?.username || "").trim();
            if (!username) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "username ┘╛┘å┘ä ╪»╪▒ ┘à╪¬╪º╪»█î╪¬╪º ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            result = await applyAdminSetLimitOnlyOnMarzban(panelRows[0], username, targetBytes);
        }
        else if (panelType === "sanaei") {
            const inboundId = parseMaybeNumber(delivery.metadata?.inboundId);
            const email = String(delivery.metadata?.email || "").trim();
            if (!inboundId || !email) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "inbound/email ╪»╪▒ ┘à╪¬╪º╪»█î╪¬╪º ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘é╪╡ ╪º╪│╪¬." });
                return true;
            }
            result = await applyAdminSetLimitOnlyOnSanaei(panelRows[0], inboundId, email, targetBytes);
        }
        await clearState(userId);
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪¬┘å╪╕█î┘à ╪│┘é┘ü ╪»█î╪¬╪º ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${result.message}` });
            return true;
        }
        await recordInventoryForensicEvent(inventoryId, "admin_lookup_set_data_limit", {
            adminId: userId,
            targetMb: isInfinite ? 0 : targetMb,
            isInfinite,
            panelResult: result.message
        });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪│┘é┘ü ╪»█î╪¬╪º█î ┌⌐╪º┘å┘ü█î┌» ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à\n╪│┘é┘ü ╪¼╪»█î╪»: ${isInfinite ? "┘å╪º┘à╪¡╪»┘ê╪»" : `${targetMb}MB`}\n${result.message}`
        });
        return true;
    }
    if (state.state === "admin_lookup_set_expiry") {
        const inventoryId = Number(state.payload.inventoryId || 0);
        const days = Math.round(Number(text.trim()));
        if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪┤╪»." });
            return true;
        }
        if (!Number.isFinite(days) || days < 0 || days > 3650) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». (█░ ╪¿╪▒╪º█î ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º╪î ╪¡╪»╪º┌⌐╪½╪▒ █│█╢█╡█░ ╪▒┘ê╪▓)" });
            return true;
        }
        const rows = await sql `
      SELECT i.id, i.panel_id, i.delivery_payload
      FROM inventory i
      WHERE i.id = ${inventoryId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const row = rows[0];
        const delivery = parseDeliveryPayload(row.delivery_payload);
        const panelType = String(delivery.metadata?.panelType || "");
        const panelId = Number(row.panel_id || 0);
        if (!panelId || !panelType) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘╛┘å┘ä█î ┘å█î╪│╪¬." });
            return true;
        }
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!panelRows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const expiryTimeMs = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : 0;
        let result = { ok: false, message: "┘╛┘å┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." };
        if (isMarzbanLike(panelType)) {
            const username = String(delivery.metadata?.username || "").trim();
            if (!username) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "username ┘╛┘å┘ä ╪»╪▒ ┘à╪¬╪º╪»█î╪¬╪º ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            result = await applyAdminSetExpiryOnMarzban(panelRows[0], username, expiryTimeMs);
        }
        else if (panelType === "sanaei") {
            const inboundId = parseMaybeNumber(delivery.metadata?.inboundId);
            const email = String(delivery.metadata?.email || "").trim();
            if (!inboundId || !email) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "inbound/email ╪»╪▒ ┘à╪¬╪º╪»█î╪¬╪º ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘é╪╡ ╪º╪│╪¬." });
                return true;
            }
            result = await applyAdminSetExpiryOnSanaei(panelRows[0], inboundId, email, expiryTimeMs);
        }
        await clearState(userId);
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪¬┘å╪╕█î┘à ╪º┘å┘é╪╢╪º ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${result.message}` });
            return true;
        }
        await recordInventoryForensicEvent(inventoryId, "admin_lookup_set_expiry", { adminId: userId, days, panelResult: result.message });
        await tg("sendMessage", { chat_id: chatId, text: days > 0 ? `╪º┘å┘é╪╢╪º ╪▒┘ê█î ${days} ╪▒┘ê╪▓ ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à` : "╪º┘å┘é╪╢╪º ╪¡╪░┘ü ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_panel_add_data") {
        const panelId = Number(state.payload.panelId || 0);
        const panelKey = String(state.payload.panelKey || "").trim();
        const addMb = parseDataAmountToMb(text);
        if (!Number.isFinite(panelId) || panelId <= 0 || !panelKey) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪┤╪»." });
            return true;
        }
        if (!addMb || addMb <= 0 || addMb > 1000000) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à┘é╪»╪º╪▒ ┘à╪╣╪¬╪¿╪▒ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». (╪¡╪»╪º┌⌐╪½╪▒ █▒█░█░█░ ┌»█î┌»╪º╪¿╪º█î╪¬)" });
            return true;
        }
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!panelRows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const panel = panelRows[0];
        const panelType = String(panel.panel_type || "");
        const addBytes = Math.max(0, Math.round(addMb * 1024 * 1024));
        let result = { ok: false, message: "┘╛┘å┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." };
        if (isMarzbanLike(panelType)) {
            const found = await lookupMarzbanUser(panel, panelKey);
            if (!found.ok || !found.user) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            const username = String(found.user.username || panelKey).trim();
            result = await applyTopupOnMarzban(panel, username, addBytes);
        }
        else if (panelType === "sanaei") {
            const found = await findSanaeiClientByIdentifier(panel, panelKey);
            if (!found.ok || !found.client || !found.inboundId) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä╪º█î┘å╪¬ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            const email = String(found.client.email || "").trim();
            if (!email) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "email ┌⌐┘ä╪º█î┘å╪¬ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            result = await applyTopupOnSanaei(panel, Number(found.inboundId), email, addBytes);
        }
        await clearState(userId);
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${result.message}` });
            return true;
        }
        await recordForensicEvent({
            inventoryId: null,
            ownerTelegramId: null,
            productId: null,
            panelId,
            panelType,
            panelUserKey: panelKey,
            uuid: extractUuidFromText(panelKey),
            source: "panel_action",
            eventType: "admin_panel_add_data",
            configValue: null,
            metadata: { adminId: userId, addMb, panelResult: result.message }
        });
        await tg("sendMessage", { chat_id: chatId, text: `╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à\n┘à┘é╪»╪º╪▒: ${addMb}MB` });
        return true;
    }
    if (state.state === "admin_panel_set_data") {
        const panelId = Number(state.payload.panelId || 0);
        const panelKey = String(state.payload.panelKey || "").trim();
        const raw = text.trim();
        const isInfinite = raw === "0" || parseInfiniteDataFlag(raw);
        const targetMb = isInfinite ? 0 : parseDataAmountToMb(raw);
        if (!Number.isFinite(panelId) || panelId <= 0 || !panelKey) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪┤╪»." });
            return true;
        }
        if (!isInfinite && (!targetMb || targetMb <= 0 || targetMb > 1000000)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¡╪¼┘à ╪¼╪»█î╪» ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. (╪¡╪»╪º┌⌐╪½╪▒ █▒█░█░█░ ┌»█î┌»╪º╪¿╪º█î╪¬ █î╪º unlimited)" });
            return true;
        }
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!panelRows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const panel = panelRows[0];
        const panelType = String(panel.panel_type || "");
        const targetBytes = isInfinite ? 0 : Math.max(0, Math.round(Number(targetMb || 0) * 1024 * 1024));
        let result = { ok: false, message: "┘╛┘å┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." };
        if (isMarzbanLike(panelType)) {
            const found = await lookupMarzbanUser(panel, panelKey);
            if (!found.ok || !found.user) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            const username = String(found.user.username || panelKey).trim();
            result = await applyAdminSetLimitOnlyOnMarzban(panel, username, targetBytes);
        }
        else if (panelType === "sanaei") {
            const found = await findSanaeiClientByIdentifier(panel, panelKey);
            if (!found.ok || !found.client || !found.inboundId) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä╪º█î┘å╪¬ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            const email = String(found.client.email || "").trim();
            if (!email) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "email ┌⌐┘ä╪º█î┘å╪¬ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            result = await applyAdminSetLimitOnlyOnSanaei(panel, Number(found.inboundId), email, targetBytes);
        }
        await clearState(userId);
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪¬┘å╪╕█î┘à ╪│┘é┘ü ╪»█î╪¬╪º ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${result.message}` });
            return true;
        }
        await recordForensicEvent({
            inventoryId: null,
            ownerTelegramId: null,
            productId: null,
            panelId,
            panelType,
            panelUserKey: panelKey,
            uuid: extractUuidFromText(panelKey),
            source: "panel_action",
            eventType: "admin_panel_set_data_limit",
            configValue: null,
            metadata: { adminId: userId, targetMb: isInfinite ? 0 : targetMb, isInfinite, panelResult: result.message }
        });
        await tg("sendMessage", { chat_id: chatId, text: `╪│┘é┘ü ╪»█î╪¬╪º█î ┌⌐╪º╪▒╪¿╪▒ ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à\n╪│∩┐╜∩┐╜┘ü ╪¼╪»█î╪»: ${isInfinite ? "┘å╪º┘à╪¡╪»┘ê╪»" : `${targetMb}MB`}` });
        return true;
    }
    if (state.state === "admin_panel_set_expiry") {
        const panelId = Number(state.payload.panelId || 0);
        const panelKey = String(state.payload.panelKey || "").trim();
        const days = Math.round(Number(text.trim()));
        if (!Number.isFinite(panelId) || panelId <= 0 || !panelKey) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪┤╪»." });
            return true;
        }
        if (!Number.isFinite(days) || days < 0 || days > 3650) {
            await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». (█░ ╪¿╪▒╪º█î ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º╪î ╪¡╪»╪º┌⌐╪½╪▒ █│█╢█╡█░ ╪▒┘ê╪▓)" });
            return true;
        }
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!panelRows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return true;
        }
        const panel = panelRows[0];
        const panelType = String(panel.panel_type || "");
        const expiryTimeMs = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : 0;
        let result = { ok: false, message: "┘╛┘å┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." };
        if (isMarzbanLike(panelType)) {
            const found = await lookupMarzbanUser(panel, panelKey);
            if (!found.ok || !found.user) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            const username = String(found.user.username || panelKey).trim();
            result = await applyAdminSetExpiryOnMarzban(panel, username, expiryTimeMs);
        }
        else if (panelType === "sanaei") {
            const found = await findSanaeiClientByIdentifier(panel, panelKey);
            if (!found.ok || !found.client || !found.inboundId) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä╪º█î┘å╪¬ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            const email = String(found.client.email || "").trim();
            if (!email) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "email ┌⌐┘ä╪º█î┘å╪¬ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            result = await applyAdminSetExpiryOnSanaei(panel, Number(found.inboundId), email, expiryTimeMs);
        }
        await clearState(userId);
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪¬┘å╪╕█î┘à ╪º┘å┘é╪╢╪º ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${result.message}` });
            return true;
        }
        await recordForensicEvent({
            inventoryId: null,
            ownerTelegramId: null,
            productId: null,
            panelId,
            panelType,
            panelUserKey: panelKey,
            uuid: extractUuidFromText(panelKey),
            source: "panel_action",
            eventType: "admin_panel_set_expiry",
            configValue: null,
            metadata: { adminId: userId, days, panelResult: result.message }
        });
        await tg("sendMessage", { chat_id: chatId, text: days > 0 ? `╪º┘å┘é╪╢╪º ╪▒┘ê█î ${days} ╪▒┘ê╪▓ ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à` : "╪º┘å┘é╪╢╪º ╪¡╪░┘ü ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_config_builder_wizard") {
        const step = String(state.payload.step || "target_user");
        const raw = text.trim();
        if (step === "target_user") {
            const target = await resolveTelegramTargetId(raw);
            if (!target.ok) {
                await tg("sendMessage", { chat_id: chatId, text: target.reason });
                return true;
            }
            const payload = {
                ...state.payload,
                step: "panel",
                targetUserId: target.telegramId,
                targetUsername: target.username || ""
            };
            await setState(userId, "admin_config_builder_wizard", payload);
            await promptAdminConfigBuilderPanel(chatId);
            return true;
        }
        if (step === "name") {
            const payload = {
                ...state.payload,
                step: "data",
                name: raw === "-" ? "" : raw
            };
            await setState(userId, "admin_config_builder_wizard", payload);
            await tg("sendMessage", {
                chat_id: chatId,
                text: "╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î - ┘à╪▒╪¡┘ä┘ç 4 ╪º╪▓ 5\n╪¡╪¼┘à ╪»█î╪¬╪º ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪» (┘à╪½╪º┘ä: 2GB █î╪º 2048MB).\n╪¿╪▒╪º█î ┘å╪º┘à╪¡╪»┘ê╪»: unlimited",
                reply_markup: { inline_keyboard: [[cancelButton("admin_config_builder_cancel")]] }
            });
            return true;
        }
        if (step === "data") {
            const isInfinite = parseInfiniteDataFlag(raw);
            const dataMb = isInfinite ? 0 : parseDataAmountToMb(raw);
            if (!isInfinite && (!dataMb || dataMb <= 0 || dataMb > 1000000)) {
                await tg("sendMessage", { chat_id: chatId, text: "┘à┘é╪»╪º╪▒ ┘à╪╣╪¬╪¿╪▒ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». (╪¡╪»╪º┌⌐╪½╪▒ █▒█░█░█░ ┌»█î┌»╪º╪¿╪º█î╪¬ █î╪º unlimited)" });
                return true;
            }
            const payload = {
                ...state.payload,
                step: "expiry",
                isInfinite,
                dataMb: isInfinite ? 0 : dataMb
            };
            await setState(userId, "admin_config_builder_wizard", payload);
            await tg("sendMessage", {
                chat_id: chatId,
                text: "╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î - ┘à╪▒╪¡┘ä┘ç 5 ╪º╪▓ 5\n╪¬╪╣╪»╪º╪» ╪▒┘ê╪▓ ╪º┘å┘é╪╢╪º ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n0 = ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º",
                reply_markup: { inline_keyboard: [[cancelButton("admin_config_builder_cancel")]] }
            });
            return true;
        }
        if (step === "expiry") {
            const days = Math.round(Number(raw));
            const targetUserId = Number(state.payload.targetUserId || 0);
            const panelId = Number(state.payload.panelId || 0);
            const configName = String(state.payload.name || "");
            const isInfinite = Boolean(state.payload.isInfinite);
            const dataMb = Number(state.payload.dataMb || 0);
            if (!Number.isFinite(days) || days < 0 || days > 3650) {
                await tg("sendMessage", { chat_id: chatId, text: "╪╣╪»╪» ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪». (█░ ╪¿╪▒╪º█î ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º╪î ╪¡╪»╪º┌⌐╪½╪▒ █│█╢█╡█░ ╪▒┘ê╪▓)" });
                return true;
            }
            if (!Number.isFinite(targetUserId) || targetUserId <= 0 || !Number.isFinite(panelId) || panelId <= 0) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "╪º╪╖┘ä╪º╪╣╪º╪¬ ╪│╪º╪«╪¬ ┘å╪º┘é╪╡ ╪º╪│╪¬. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ┘à┘å┘ê█î ╪º╪¿╪▓╪º╪▒ ╪┤╪▒┘ê╪╣ ┌⌐┘å█î╪»." });
                return true;
            }
            const panelRows = await sql `
        SELECT id, panel_type, base_url, username, password, subscription_public_port, subscription_public_host, subscription_link_protocol, config_public_host
        FROM panels
        WHERE id = ${panelId}
        LIMIT 1;
      `;
            if (!panelRows.length) {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ╪º┘å╪¬╪«╪º╪¿ΓÇî╪┤╪»┘ç ┘╛█î╪»╪º ┘å╪┤╪»." });
                return true;
            }
            const panel = panelRows[0];
            const panelType = String(panel.panel_type || "");
            const effectiveDataMb = isInfinite ? 0 : Math.max(1, Math.round(dataMb || 0));
            const panelConfig = {
                expire_days: days,
                data_limit_mb: effectiveDataMb,
                protocol: "vless",
                username_prefix: "adm",
                email_prefix: "adm"
            };
            if (panelType === "sanaei") {
                const inbound = await resolveFirstSanaeiInboundId(panel);
                if (!inbound.ok) {
                    await clearState(userId);
                    await tg("sendMessage", { chat_id: chatId, text: inbound.reason });
                    return true;
                }
                panelConfig.inbound_id = inbound.inboundId;
                panelConfig.protocol = inbound.protocol;
            }
            const productId = await ensureAdminCustomProductId();
            const purchaseId = `A${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
            const pseudoOrder = {
                purchase_id: purchaseId,
                telegram_id: targetUserId,
                product_id: productId,
                product_name: configName || "┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î ╪º╪»┘à█î┘å",
                size_mb: effectiveDataMb
            };
            let provision;
            try {
                provision =
                    isMarzbanLike(panelType)
                        ? await provisionMarzbanSale(panel, pseudoOrder, panelConfig)
                        : await provisionSanaeiSale(panel, pseudoOrder, panelConfig);
            }
            catch (error) {
                await clearState(userId);
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: `╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪▒┘ê█î ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${String(error.message || error)}`
                });
                return true;
            }
            const delivery = parseDeliveryPayload(provision.deliveryPayload);
            const metadata = {
                ...(delivery.metadata || {}),
                label: configName || "",
                isAdminCustom: true,
                customDataMb: effectiveDataMb,
                customInfinite: isInfinite,
                expire_days: days,
                createdByAdmin: userId
            };
            const meta = delivery.metadata;
            const panelUserKey = String(meta?.username || meta?.email || meta?.subId || meta?.uuid || "").trim() || null;
            const inserted = await sql `
        INSERT INTO inventory (product_id, panel_user_key, config_value, delivery_payload, status, owner_telegram_id, panel_id, sold_at)
        VALUES (${productId}, ${panelUserKey}, ${provision.configValue}, ${serializeDeliveryPayload({ ...delivery, metadata })}::jsonb, 'sold', ${targetUserId}, ${panelId}, NOW())
        RETURNING id;
      `;
            await recordInventoryForensicEvent(Number(inserted[0].id), "admin_custom_config_created", {
                adminId: userId,
                targetUserId,
                panelId,
                dataMb: effectiveDataMb,
                isInfinite,
                expireDays: days,
                label: configName || ""
            });
            await clearState(userId);
            try {
                await sendDeliveryPackage(targetUserId, purchaseId, provision.configValue, { ...delivery, metadata }, [[homeButton()]], "≡ƒÄü █î┌⌐ ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪¿╪▒╪º█î ╪┤┘à╪º ╪╡╪º╪»╪▒ ╪┤╪».");
            }
            catch (error) {
                logError("admin_custom_config_send_failed", error, { targetUserId, by: userId, inventoryId: Number(inserted[0].id) });
            }
            await tg("sendMessage", {
                chat_id: chatId,
                text: `┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
                    `╪┤┘å╪º╪│┘ç inventory: ${inserted[0].id}\n` +
                    `┌⌐╪º╪▒╪¿╪▒: ${targetUserId}\n` +
                    `┘╛┘å┘ä: #${panelId}\n` +
                    `╪¡╪¼┘à: ${isInfinite ? "┘å╪º┘à╪¡╪»┘ê╪»" : `${effectiveDataMb}MB`}\n` +
                    `╪º┘å┘é╪╢╪º: ${days > 0 ? `${days} ╪▒┘ê╪▓` : "╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º"}`
            });
            return true;
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪º█î┘å ┘à╪▒╪¡┘ä┘ç ╪º╪▓ ╪»┌⌐┘à┘çΓÇî┘ç╪º█î ┘╛█î╪º┘à ┘é╪¿┘ä█î ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»." });
        return true;
    }
    if (state.state === "admin_unban_user") {
        const target = Math.round(Number(text.trim()));
        if (!Number.isFinite(target) || target <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "telegram_id ┘à╪╣╪¬╪¿╪▒ ╪¿┘ü╪▒╪│╪¬█î╪»." });
            return true;
        }
        const deleted = await sql `DELETE FROM banned_users WHERE telegram_id = ${target} RETURNING telegram_id;`;
        await clearState(userId);
        if (!deleted.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌⌐╪º╪▒╪¿╪▒ ╪»╪▒ ┘ä█î╪│╪¬ ╪¿┘åΓÇî╪┤╪»┘çΓÇî┘ç╪º ┘å█î╪│╪¬." });
            return true;
        }
        try {
            await tg("sendMessage", { chat_id: target, text: "╪»╪│╪¬╪▒╪│█î ╪┤┘à╪º ╪▒┘ü╪╣ ┘à╪│╪»┘ê╪»█î╪¬ ╪┤╪» Γ£à" });
        }
        catch (error) {
            logError("unban_user_notify_failed", error, { targetUserId: target, by: userId });
        }
        await tg("sendMessage", { chat_id: chatId, text: `┌⌐╪º╪▒╪¿╪▒ ${target} ╪ó┘å╪¿┘å ╪┤╪» Γ£à` });
        return true;
    }
    if (state.state === "admin_inv_rename") {
        const inventoryId = Number(state.payload.inventoryId);
        const name = text.trim();
        if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪┤╪»." });
            return true;
        }
        const label = name === "-" ? "" : name;
        await sql `
      UPDATE inventory
      SET delivery_payload = jsonb_set(
        jsonb_set(COALESCE(delivery_payload, '{}'::jsonb), '{metadata}', COALESCE(delivery_payload->'metadata', '{}'::jsonb), true),
        '{metadata,label}',
        to_jsonb(${label}::text),
        true
      )
      WHERE id = ${inventoryId};
    `;
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_provide_config") {
        if (!await isAdmin(userId)) {
            await clearState(userId);
            return false;
        }
        const orderId = Number(state.payload.orderId);
        const orderRows = await sql `
      SELECT id, purchase_id, telegram_id, product_id
      FROM orders
      WHERE id = ${orderId}
      LIMIT 1;
    `;
        if (!orderRows.length) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return true;
        }
        const order = orderRows[0];
        const inserted = await sql `
      INSERT INTO inventory (product_id, config_value, status, owner_telegram_id, sold_order_id, sold_at)
      VALUES (${order.product_id}, ${text}, 'sold', ${order.telegram_id}, ${order.id}, NOW())
      RETURNING id;
    `;
        await sql `
      UPDATE orders
      SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), inventory_id = ${inserted[0].id}
      WHERE id = ${order.id};
    `;
        await recordInventoryForensicEvent(Number(inserted[0].id), "sale_delivered_manual", {
            purchaseId: String(order.purchase_id),
            by: userId
        });
        await clearState(userId);
        const profile = await getTelegramProfileText(Number(order.telegram_id));
        const productRows = await sql `SELECT name FROM products WHERE id = ${Number(order.product_id)} LIMIT 1;`;
        const productName = productRows.length ? String(productRows[0].name || `#${Number(order.product_id)}`) : `#${Number(order.product_id)}`;
        await sendDeliveryPackage(Number(order.telegram_id), String(order.purchase_id), String(text), { configLinks: [String(text)] }, [[homeButton()]]);
        await notifyAdmins(buildAdminDeliverySummary({
            purchaseId: String(order.purchase_id),
            userId: Number(order.telegram_id),
            telegramUsername: profile.username,
            telegramFullName: profile.fullName,
            productName,
            deliveryPayload: {}
        }), { inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${String(order.purchase_id)}` }]] });
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ╪¿╪▒╪º█î ┌⌐╪º╪▒╪¿╪▒ ╪º╪▒╪│╪º┘ä ╪┤╪» Γ£à" });
        return true;
    }
    if (state.state === "admin_panel_subport_edit") {
        const panelId = Number(state.payload.panelId || 0);
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return true;
        }
        const raw = text.trim();
        if (raw === "-") {
            await clearState(userId);
            await showPanelDetails(chatId, panelId, "╪¬╪║█î█î╪▒ ┘╛┘ê╪▒╪¬ ╪│╪º╪¿ ┘ä╪║┘ê ╪┤╪».");
            return true;
        }
        const lt = raw.toLowerCase();
        if (lt === "0" || lt === "auto") {
            await sql `UPDATE panels SET subscription_public_port = NULL WHERE id = ${panelId}`;
        }
        else {
            const n = parseMaybeNumber(raw);
            if (n === null || n < 1 || n > 65535) {
                await tg("sendMessage", { chat_id: chatId, text: "┘╛┘ê╪▒╪¬ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬. ╪╣╪»╪» █▒ ╪¬╪º █╢█╡█╡█│█╡╪î █î╪º 0/auto ╪¿╪▒╪º█î ╪«┘ê╪»┌⌐╪º╪▒." });
                return true;
            }
            await sql `UPDATE panels SET subscription_public_port = ${n} WHERE id = ${panelId}`;
        }
        await clearState(userId);
        await showPanelDetails(chatId, panelId, "┘╛┘ê╪▒╪¬ ┘ä█î┘å┌⌐ ╪│╪º╪¿ ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à");
        return true;
    }
    if (state.state === "admin_panel_suburl_host_edit") {
        const panelId = Number(state.payload.panelId || 0);
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return true;
        }
        const raw = text.trim();
        if (raw === "-") {
            await clearState(userId);
            await showPanelDetails(chatId, panelId, "╪¬┘å╪╕█î┘à ╪»╪º┘à┘å┘ç ┘ä█î┘å┌⌐ ╪│╪º╪¿ ┘ä╪║┘ê ╪┤╪».");
            return true;
        }
        const protoRaw = state.payload.subscriptionLinkProtocol;
        const protocolSql = protoRaw === "http" || protoRaw === "https" ? String(protoRaw) : null;
        const lt = raw.toLowerCase();
        let subscriptionPublicHost = null;
        if (lt !== "0" && lt !== "auto") {
            const h = sanitizeSubscriptionPublicHostInput(raw);
            if (!h) {
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: "┘å╪º┘à ┘à█î╪▓╪¿╪º┘å ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. ┘à╪½╪º┘ä: sub.example.com\n█î╪º https://sub.example.com\n0 █î╪º auto = ┘ç┘à╪º┘å ┘à█î╪▓╪¿╪º┘å ╪ó╪»╪▒╪│ ┘╛┘å┘ä"
                });
                return true;
            }
            subscriptionPublicHost = h;
        }
        await sql `
      UPDATE panels
      SET subscription_public_host = ${subscriptionPublicHost},
          subscription_link_protocol = ${protocolSql}
      WHERE id = ${panelId}
    `;
        await clearState(userId);
        await showPanelDetails(chatId, panelId, "╪»╪º┘à┘å┘ç ┘ê ┘╛╪▒┘ê╪¬┌⌐┘ä ┘ä█î┘å┌⌐ ╪│╪º╪¿ ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à");
        return true;
    }
    if (state.state === "admin_import_sanaei_backup") {
        const panelId = Number(state.payload.panelId || 0);
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return true;
        }
        if (text.trim() === "-") {
            await clearState(userId);
            await showPanelDetails(chatId, panelId, "┘ê╪º╪▒╪» ┌⌐╪▒╪»┘å ╪¿┌⌐╪º┘╛ ┘ä╪║┘ê ╪┤╪».");
            return true;
        }
        let parsed;
        try {
            parsed = JSON.parse(text.trim());
        }
        catch {
            await tg("sendMessage", { chat_id: chatId, text: "JSON ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬. ╪»┘ê╪¿╪º╪▒┘ç ╪¿┘ü╪▒╪│╪¬█î╪» █î╪º - ╪¿╪▒╪º█î ╪º┘å╪╡╪▒╪º┘ü." });
            return true;
        }
        let inboundList = [];
        if (Array.isArray(parsed)) {
            inboundList = parsed;
        }
        else if (parsed && typeof parsed === "object") {
            const obj = parsed;
            if (Array.isArray(obj.obj)) {
                inboundList = obj.obj;
            }
            else if (Array.isArray(obj.data)) {
                inboundList = obj.data;
            }
            else {
                inboundList = [parsed];
            }
        }
        if (!inboundList.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å inboundΓÇî╪º█î ╪»╪▒ JSON ┘╛█î╪»╪º ┘å╪┤╪». ╪»┘ê╪¿╪º╪▒┘ç ╪¿┘ü╪▒╪│╪¬█î╪» █î╪º - ╪¿╪▒╪º█î ╪º┘å╪╡╪▒╪º┘ü." });
            return true;
        }
        await setSetting(`sanaei_inbound_backup_${panelId}`, JSON.stringify(inboundList));
        await clearState(userId);
        let clientCount = 0;
        for (const ib of inboundList) {
            const ibObj = ib;
            const settings = toJsonObject(parseSanaeiNested(ibObj.settings)) || {};
            clientCount += Array.isArray(settings.clients) ? settings.clients.length : 0;
        }
        await showPanelDetails(chatId, panelId, `╪¿┌⌐╪º┘╛ inbound ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${inboundList.length} inbound | ${clientCount} ┌⌐┘ä╪º█î┘å╪¬`);
        return true;
    }
    if (state.state === "admin_panel_confighost_edit") {
        const panelId = Number(state.payload.panelId || 0);
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return true;
        }
        const raw = text.trim();
        if (raw === "-") {
            await clearState(userId);
            await showPanelDetails(chatId, panelId, "╪¬┘å╪╕█î┘à ╪»╪º┘à┘å┘ç ┌⌐╪º┘å┘ü█î┌» ┘ä╪║┘ê ╪┤╪».");
            return true;
        }
        const lt = raw.toLowerCase();
        if (lt === "0" || lt === "auto") {
            await sql `UPDATE panels SET config_public_host = NULL WHERE id = ${panelId}`;
        }
        else {
            const h = sanitizeSubscriptionPublicHostInput(raw);
            if (!h) {
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: "┘å╪º┘à ┘à█î╪▓╪¿╪º┘å ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. ┘à╪½╪º┘ä: v-panel.example.com\n0 █î╪º auto = ╪¬╪┤╪«█î╪╡ ╪«┘ê╪»┌⌐╪º╪▒\n- = ╪º┘å╪╡╪▒╪º┘ü"
                });
                return true;
            }
            await sql `UPDATE panels SET config_public_host = ${h} WHERE id = ${panelId}`;
        }
        await clearState(userId);
        await showPanelDetails(chatId, panelId, "╪»╪º┘à┘å┘ç ┘å┘à╪º█î╪┤ ╪»╪▒ ┌⌐╪º┘å┘ü█î┌» ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à");
        return true;
    }
    if (state.state === "admin_panel_wizard") {
        const mode = String(state.payload.mode || "add");
        const step = String(state.payload.step || "name");
        const panelId = Number(state.payload.panelId || 0);
        const panelType = parsePanelType(String(state.payload.panelType || ""));
        const currentName = String(state.payload.name || "");
        const currentBaseUrl = String(state.payload.baseUrl || "");
        const currentUsername = String(state.payload.username || "");
        const currentPassword = String(state.payload.password || "");
        if (!panelType) {
            await clearState(userId);
            await tg("sendMessage", { chat_id: chatId, text: "┘å┘ê╪╣ ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪┤╪». ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
            return true;
        }
        const raw = text.trim();
        if (step === "name") {
            const name = mode === "edit" && raw === "-" ? currentName : raw;
            if (!name) {
                await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ┘╛┘å┘ä ┘å┘à█îΓÇî╪¬┘ê╪º┘å╪» ╪«╪º┘ä█î ╪¿╪º╪┤╪»." });
                return true;
            }
            const payload = {
                ...state.payload,
                step: "base_url",
                name
            };
            await setState(userId, "admin_panel_wizard", payload);
            await promptPanelWizardStep(chatId, payload);
            return true;
        }
        if (step === "base_url") {
            const baseUrl = mode === "edit" && raw === "-" ? currentBaseUrl : normalizeBaseUrl(raw);
            if (!baseUrl || !isValidHttpUrl(baseUrl)) {
                await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ┘╛┘å┘ä ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬. ┘å┘à┘ê┘å┘ç: https://panel.example.com" });
                return true;
            }
            const payload = {
                ...state.payload,
                step: "username",
                baseUrl
            };
            await setState(userId, "admin_panel_wizard", payload);
            await promptPanelWizardStep(chatId, payload);
            return true;
        }
        if (step === "username") {
            const username = mode === "edit" && raw === "-" ? currentUsername : raw;
            if (!username) {
                await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┘╛┘å┘ä ╪º┘ä╪▓╪º┘à█î ╪º╪│╪¬." });
                return true;
            }
            const payload = {
                ...state.payload,
                step: "password",
                username
            };
            await setState(userId, "admin_panel_wizard", payload);
            await promptPanelWizardStep(chatId, payload);
            return true;
        }
        if (step === "password") {
            const password = mode === "edit" && raw === "-" ? currentPassword : raw;
            const name = String(state.payload.name || "");
            const baseUrl = String(state.payload.baseUrl || "");
            const username = String(state.payload.username || "");
            if (!password) {
                await tg("sendMessage", { chat_id: chatId, text: "╪▒┘à╪▓ ╪╣╪¿┘ê╪▒ ┘╛┘å┘ä ╪º┘ä╪▓╪º┘à█î ╪º╪│╪¬." });
                return true;
            }
            if (panelType === "sanaei") {
                const payload = { ...state.payload, step: "sub_port", password };
                await setState(userId, "admin_panel_wizard", payload);
                await promptPanelWizardStep(chatId, payload);
                return true;
            }
            try {
                if (mode === "add") {
                    await sql `
            INSERT INTO panels (name, panel_type, base_url, username, password, subscription_public_port)
            VALUES (${name}, ${panelType}, ${baseUrl}, ${username}, ${password}, NULL)
            ON CONFLICT (name) DO UPDATE
            SET panel_type = EXCLUDED.panel_type,
                base_url = EXCLUDED.base_url,
                username = EXCLUDED.username,
                password = EXCLUDED.password,
                subscription_public_port = panels.subscription_public_port,
                subscription_public_host = panels.subscription_public_host,
                subscription_link_protocol = panels.subscription_link_protocol,
                config_public_host = panels.config_public_host;
          `;
                    const idRows = await sql `SELECT id FROM panels WHERE name = ${name} LIMIT 1;`;
                    await clearState(userId);
                    if (!idRows.length) {
                        await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
                        return true;
                    }
                    const savedPanelId = Number(idRows[0].id);
                    const test = await testPanelConnection(savedPanelId);
                    logInfo("panel_saved", { panelId: savedPanelId, panelType, name, baseUrl, testOk: test.ok });
                    await showPanelDetails(chatId, savedPanelId, `┘╛┘å┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${test.message}`);
                    return true;
                }
                if (!Number.isFinite(panelId) || panelId <= 0) {
                    await clearState(userId);
                    await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
                    return true;
                }
                await sql `
          UPDATE panels
          SET name = ${name}, panel_type = ${panelType}, base_url = ${baseUrl}, username = ${username}, password = ${password}
          WHERE id = ${panelId};
        `;
                await clearState(userId);
                const test = await testPanelConnection(panelId);
                logInfo("panel_updated", { panelId, panelType, name, baseUrl, testOk: test.ok });
                await showPanelDetails(chatId, panelId, `╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛┘å┘ä ╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪┤╪» Γ£à\n${test.message}`);
                return true;
            }
            catch (error) {
                await clearState(userId);
                if (mode === "add") {
                    logError("panel_save_failed", error, { panelType, name, baseUrl, userId });
                    await tg("sendMessage", {
                        chat_id: chatId,
                        text: `╪░╪«█î╪▒┘ç ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${String(error.message || error)}`
                    });
                    return true;
                }
                logError("panel_update_failed", error, { panelId, panelType, name, baseUrl, userId });
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: `╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${String(error.message || error)}`
                });
                return true;
            }
        }
        if (step === "sub_port") {
            if (panelType !== "sanaei") {
                await clearState(userId);
                await tg("sendMessage", { chat_id: chatId, text: "┘à╪▒╪¡┘ä┘ç ┘╛┘ê╪▒╪¬ ╪│╪º╪¿ ┘ü┘é╪╖ ╪¿╪▒╪º█î Sanaei ┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
                return true;
            }
            const name = String(state.payload.name || "");
            const baseUrl = String(state.payload.baseUrl || "");
            const username = String(state.payload.username || "");
            const password = String(state.payload.password || "");
            const lt = raw.trim().toLowerCase();
            let subscriptionPublicPort = null;
            if (mode === "edit" && raw === "-") {
                subscriptionPublicPort = parseMaybeNumber(state.payload.subscriptionPublicPort);
            }
            else if (raw === "" || lt === "0" || lt === "auto") {
                subscriptionPublicPort = null;
            }
            else {
                const n = parseMaybeNumber(raw);
                if (n === null || n < 1 || n > 65535) {
                    await tg("sendMessage", { chat_id: chatId, text: "┘╛┘ê╪▒╪¬ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬. ╪╣╪»╪» █▒ ╪¬╪º █╢█╡█╡█│█╡╪î █î╪º 0/auto ╪¿╪▒╪º█î ╪«┘ê╪»┌⌐╪º╪▒." });
                    return true;
                }
                subscriptionPublicPort = n;
            }
            try {
                if (mode === "add") {
                    await sql `
            INSERT INTO panels (name, panel_type, base_url, username, password, subscription_public_port)
            VALUES (${name}, ${panelType}, ${baseUrl}, ${username}, ${password}, ${subscriptionPublicPort})
            ON CONFLICT (name) DO UPDATE
            SET panel_type = EXCLUDED.panel_type,
                base_url = EXCLUDED.base_url,
                username = EXCLUDED.username,
                password = EXCLUDED.password,
                subscription_public_port = EXCLUDED.subscription_public_port,
                subscription_public_host = panels.subscription_public_host,
                subscription_link_protocol = panels.subscription_link_protocol,
                config_public_host = panels.config_public_host;
          `;
                    const idRows = await sql `SELECT id FROM panels WHERE name = ${name} LIMIT 1;`;
                    await clearState(userId);
                    if (!idRows.length) {
                        await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
                        return true;
                    }
                    const savedPanelId = Number(idRows[0].id);
                    const test = await testPanelConnection(savedPanelId);
                    logInfo("panel_saved", { panelId: savedPanelId, panelType, name, baseUrl, testOk: test.ok });
                    await showPanelDetails(chatId, savedPanelId, `┘╛┘å┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${test.message}`);
                    return true;
                }
                if (!Number.isFinite(panelId) || panelId <= 0) {
                    await clearState(userId);
                    await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
                    return true;
                }
                await sql `
          UPDATE panels
          SET
            name = ${name},
            panel_type = ${panelType},
            base_url = ${baseUrl},
            username = ${username},
            password = ${password},
            subscription_public_port = ${subscriptionPublicPort}
          WHERE id = ${panelId};
        `;
                await clearState(userId);
                const test = await testPanelConnection(panelId);
                logInfo("panel_updated", { panelId, panelType, name, baseUrl, testOk: test.ok });
                await showPanelDetails(chatId, panelId, `╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛┘å┘ä ╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪┤╪» Γ£à\n${test.message}`);
                return true;
            }
            catch (error) {
                await clearState(userId);
                if (mode === "add") {
                    logError("panel_save_failed", error, { panelType, name, baseUrl, userId });
                    await tg("sendMessage", {
                        chat_id: chatId,
                        text: `╪░╪«█î╪▒┘ç ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${String(error.message || error)}`
                    });
                    return true;
                }
                logError("panel_update_failed", error, { panelId, panelType, name, baseUrl, userId });
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: `╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${String(error.message || error)}`
                });
                return true;
            }
        }
        return true;
    }
    if (state.state === "admin_panel_add") {
        const [typeRaw, nameRaw, baseUrlRaw, usernameRaw, passwordRaw] = text.split("|").map((x) => x.trim());
        const panelType = parsePanelType(typeRaw || "");
        const name = nameRaw || "";
        const baseUrl = normalizeBaseUrl(baseUrlRaw || "");
        const username = usernameRaw || "";
        const password = passwordRaw || "";
        if (!panelType || !name || !baseUrl || !isValidHttpUrl(baseUrl)) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ╪╡╪¡█î╪¡ ┘å█î╪│╪¬. ┘å┘à┘ê┘å┘ç:\nmarzban|Main Panel|https://panel.example.com|admin|pass"
            });
            return true;
        }
        if (!username || !password) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "╪¿╪▒╪º█î ╪º┘ü╪▓┘ê╪»┘å ┘╛┘å┘ä╪î ┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┘ê ╪▒┘à╪▓ ╪╣╪¿┘ê╪▒ ╪º┘ä╪▓╪º┘à█î ╪º╪│╪¬."
            });
            return true;
        }
        try {
            await sql `
        INSERT INTO panels (name, panel_type, base_url, username, password)
        VALUES (${name}, ${panelType}, ${baseUrl}, ${username}, ${password})
        ON CONFLICT (name) DO UPDATE
        SET panel_type = EXCLUDED.panel_type, base_url = EXCLUDED.base_url, username = EXCLUDED.username, password = EXCLUDED.password;
      `;
            const idRows = await sql `SELECT id FROM panels WHERE name = ${name} LIMIT 1;`;
            await clearState(userId);
            if (idRows.length) {
                const panelId = Number(idRows[0].id);
                const test = await testPanelConnection(panelId);
                await tg("sendMessage", { chat_id: chatId, text: `┘╛┘å┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à\n${test.message}` });
                logInfo("panel_saved", { panelId, panelType, name, baseUrl, testOk: test.ok });
                return true;
            }
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ╪░╪«█î╪▒┘ç ╪┤╪» Γ£à" });
            return true;
        }
        catch (error) {
            logError("panel_save_failed", error, { panelType, name, baseUrl, userId });
            await tg("sendMessage", {
                chat_id: chatId,
                text: `╪░╪«█î╪▒┘ç ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${String(error.message || error)}`
            });
            return true;
        }
    }
    if (state.state === "admin_panel_edit") {
        const panelId = Number(state.payload.panelId);
        const [nameRaw, baseUrlRaw, usernameRaw, passwordRaw] = text.split("|").map((x) => x.trim());
        const name = nameRaw || "";
        const baseUrl = normalizeBaseUrl(baseUrlRaw || "");
        const username = usernameRaw || "";
        const password = passwordRaw || "";
        if (!Number.isFinite(panelId) || panelId <= 0 || !name || !baseUrl || !isValidHttpUrl(baseUrl)) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ü╪▒┘à╪¬ ╪╡╪¡█î╪¡: ┘å╪º┘à|base_url|username|password" });
            return true;
        }
        if (!username || !password) {
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┘ê ╪▒┘à╪▓ ╪╣╪¿┘ê╪▒ ┘╛┘å┘ä ╪º┘ä╪▓╪º┘à█î ╪º╪│╪¬." });
            return true;
        }
        try {
            await sql `
        UPDATE panels
        SET name = ${name}, base_url = ${baseUrl}, username = ${username}, password = ${password}
        WHERE id = ${panelId};
      `;
            await clearState(userId);
            const test = await testPanelConnection(panelId);
            await tg("sendMessage", { chat_id: chatId, text: `╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛┘å┘ä ╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪┤╪» Γ£à\n${test.message}` });
            logInfo("panel_updated", { panelId, name, baseUrl, testOk: test.ok });
            return true;
        }
        catch (error) {
            logError("panel_update_failed", error, { panelId, name, baseUrl, userId });
            await tg("sendMessage", {
                chat_id: chatId,
                text: `╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${String(error.message || error)}`
            });
            return true;
        }
    }
    if (state.state === "admin_complete_migration_config") {
        const migrationId = Number(state.payload.migrationId);
        const result = await completeMigration(migrationId, userId, text.trim());
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: result.ok ? "╪º┘å╪¬┘é╪º┘ä ╪¬┌⌐┘à█î┘ä ╪┤╪» Γ£à" : `╪«╪╖╪º: ${result.reason}` });
        return true;
    }
    if (state.state === "admin_direct_migrate") {
        const { sourceInventoryId, targetPanelId, requestedFor, config } = parseDirectMigrateInput(text);
        if (!Number.isFinite(sourceInventoryId) || !Number.isFinite(targetPanelId) || !Number.isFinite(requestedFor)) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ü╪▒┘à╪¬ ┘à┘ç╪º╪¼╪▒╪¬ ┘à╪│╪¬┘é█î┘à ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬.\n" +
                    "┘é╪»█î┘à█î: inventory_id|target_panel_id|user_telegram_id|config\n" +
                    "╪¼╪»█î╪»:\nsource_inventory_id: 12\ntarget_panel_id: 3\nuser_telegram_id: 123456\nconfig: optional"
            });
            return true;
        }
        const ok = await createMigrationRequest(chatId, userId, requestedFor, sourceInventoryId, targetPanelId, "admin");
        if (!ok)
            return true;
        if (config) {
            const row = await sql `
        SELECT id
        FROM panel_migrations
        WHERE source_inventory_id = ${sourceInventoryId}
          AND target_panel_id = ${targetPanelId}
          AND requested_for = ${requestedFor}
          AND status = 'pending'
        ORDER BY id DESC
        LIMIT 1;
      `;
            if (row.length) {
                const complete = await completeMigration(Number(row[0].id), userId, config);
                await tg("sendMessage", { chat_id: chatId, text: complete.ok ? "╪º┘å╪¬┘é╪º┘ä ┘ü┘ê╪▒█î ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à" : `╪«╪╖╪º: ${complete.reason}` });
            }
        }
        await clearState(userId);
        return true;
    }
    return false;
}
async function resolveDiscount(code, basePrice) {
    if (!code)
        return { discountAmount: 0, discountCode: null };
    const rows = await sql `
    SELECT id, code, type, amount, usage_limit, used_count, active
    FROM discounts
    WHERE code = ${code.toUpperCase()} AND active = TRUE
    LIMIT 1;
  `;
    if (!rows.length)
        return { discountAmount: 0, discountCode: null };
    const d = rows[0];
    if (d.usage_limit !== null && Number(d.used_count) >= Number(d.usage_limit)) {
        return { discountAmount: 0, discountCode: null };
    }
    const discountAmount = d.type === "percent" ? Math.floor((basePrice * Number(d.amount)) / 100) : Number(d.amount);
    return { discountAmount: Math.max(0, Math.min(discountAmount, basePrice)), discountCode: String(d.code) };
}
async function claimDiscountUsage(code) {
    const rows = await sql `
    UPDATE discounts
    SET used_count = used_count + 1
    WHERE code = ${code.toUpperCase()}
      AND active = TRUE
      AND (usage_limit IS NULL OR used_count < usage_limit)
    RETURNING code;
  `;
    return rows.length > 0;
}
async function releaseDiscountUsage(code) {
    await sql `
    UPDATE discounts
    SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END
    WHERE code = ${code.toUpperCase()};
  `;
}
async function withClaimedDiscount(discountCode, action) {
    let claimed = false;
    try {
        if (discountCode) {
            claimed = await claimDiscountUsage(discountCode);
            if (!claimed) {
                throw new Error("discount_unavailable");
            }
        }
        return await action();
    }
    catch (error) {
        if (claimed && discountCode) {
            try {
                await releaseDiscountUsage(discountCode);
            }
            catch (releaseError) {
                logError("release_discount_usage_failed", releaseError, { discountCode });
            }
        }
        throw error;
    }
}
async function insertOrderRecord(input) {
    const panelConfigJson = JSON.stringify(input.panelConfigSnapshot || {});
    const quantity = Math.max(1, Math.round(Number(input.quantity ??
        sanitizePanelConfig(input.panelConfigSnapshot).bulk_quantity ??
        1)));
    const walletUsed = Math.max(0, Math.round(Number(input.walletUsed || 0)));
    const discountAmount = Math.max(0, Math.round(Number(input.discountAmount || 0)));
    const finalPrice = Math.max(0, Math.round(Number(input.finalPrice || 0)));
    const tronAmount = Number(input.tronAmount || 0);
    const walletDescription = input.walletTransactionDescription ||
        `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${input.productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${input.purchaseId})`;
    if (walletUsed > 0) {
        const rows = await sql `
      WITH deducted AS (
        UPDATE users
        SET wallet_balance = wallet_balance - ${walletUsed}
        WHERE telegram_id = ${input.telegramId}
          AND wallet_balance >= ${walletUsed}
        RETURNING telegram_id
      ),
      inserted AS (
        INSERT INTO orders
        (
          purchase_id, telegram_id, product_id, product_name_snapshot, sell_mode, source_panel_id, panel_delivery_mode, panel_config_snapshot,
          payment_method, card_id, discount_code, discount_amount, final_price, tron_amount, status, wallet_used, config_name, quantity,
          tronado_token, tronado_payment_url,
          plisio_txn_id, plisio_invoice_url, plisio_status,
          crypto_wallet_id, crypto_currency, crypto_network, crypto_address, crypto_amount, crypto_expires_at,
          swapwallet_invoice_id, swapwallet_payment_url, swapwallet_status
        )
        SELECT
          ${input.purchaseId}, telegram_id, ${input.productId}, ${input.productNameSnapshot}, ${input.sellMode}, ${input.sourcePanelId}, ${input.panelDeliveryMode},
          ${panelConfigJson}::jsonb,
          ${input.paymentMethod}, ${input.cardId ?? null}, ${input.discountCode}, ${discountAmount}, ${finalPrice}, ${tronAmount}, ${input.status}, ${walletUsed}, ${input.configName ?? null}, ${quantity},
          ${input.tronadoToken ?? null}, ${input.tronadoPaymentUrl ?? null},
          ${input.plisioTxnId ?? null}, ${input.plisioInvoiceUrl ?? null}, ${input.plisioStatus ?? null},
          ${input.cryptoWalletId ?? null}, ${input.cryptoCurrency ?? null}, ${input.cryptoNetwork ?? null}, ${input.cryptoAddress ?? null}, ${input.cryptoAmount ?? null}, ${input.cryptoExpiresAt ?? null},
          ${input.swapwalletInvoiceId ?? null}, ${input.swapwalletPaymentUrl ?? null}, ${input.swapwalletStatus ?? null}
        FROM deducted
        RETURNING id
      ),
      txn AS (
        INSERT INTO wallet_transactions (telegram_id, amount, type, description, created_at)
        SELECT telegram_id, ${-walletUsed}, 'purchase', ${walletDescription}, NOW()
        FROM deducted
        WHERE EXISTS (SELECT 1 FROM inserted)
        RETURNING id
      )
      SELECT id FROM inserted;
    `;
        if (!rows.length) {
            throw new Error("wallet_insufficient");
        }
        return Number(rows[0].id);
    }
    const rows = await sql `
    INSERT INTO orders
    (
      purchase_id, telegram_id, product_id, product_name_snapshot, sell_mode, source_panel_id, panel_delivery_mode, panel_config_snapshot,
      payment_method, card_id, discount_code, discount_amount, final_price, tron_amount, status, wallet_used, config_name, quantity,
      tronado_token, tronado_payment_url,
      plisio_txn_id, plisio_invoice_url, plisio_status,
      crypto_wallet_id, crypto_currency, crypto_network, crypto_address, crypto_amount, crypto_expires_at,
      swapwallet_invoice_id, swapwallet_payment_url, swapwallet_status
    )
    VALUES
    (
      ${input.purchaseId}, ${input.telegramId}, ${input.productId}, ${input.productNameSnapshot}, ${input.sellMode}, ${input.sourcePanelId}, ${input.panelDeliveryMode},
      ${panelConfigJson}::jsonb,
      ${input.paymentMethod}, ${input.cardId ?? null}, ${input.discountCode}, ${discountAmount}, ${finalPrice}, ${tronAmount}, ${input.status}, ${walletUsed}, ${input.configName ?? null}, ${quantity},
      ${input.tronadoToken ?? null}, ${input.tronadoPaymentUrl ?? null},
      ${input.plisioTxnId ?? null}, ${input.plisioInvoiceUrl ?? null}, ${input.plisioStatus ?? null},
      ${input.cryptoWalletId ?? null}, ${input.cryptoCurrency ?? null}, ${input.cryptoNetwork ?? null}, ${input.cryptoAddress ?? null}, ${input.cryptoAmount ?? null}, ${input.cryptoExpiresAt ?? null},
      ${input.swapwalletInvoiceId ?? null}, ${input.swapwalletPaymentUrl ?? null}, ${input.swapwalletStatus ?? null}
    )
    RETURNING id;
  `;
    if (!rows.length) {
        throw new Error("order_insert_failed");
    }
    return Number(rows[0].id);
}
async function refundWalletUsage(telegramId, amount, description) {
    const safeAmount = Math.max(0, Math.round(Number(amount || 0)));
    if (!safeAmount)
        return null;
    await sql `
    WITH refunded AS (
      UPDATE users
      SET wallet_balance = wallet_balance + ${safeAmount}
      WHERE telegram_id = ${telegramId}
      RETURNING telegram_id
    )
    INSERT INTO wallet_transactions (telegram_id, amount, type, description, created_at)
    SELECT telegram_id, ${safeAmount}, 'refund', ${description}, NOW()
    FROM refunded;
  `;
}
async function getPurchaseSurcharge() {
    const enabled = await getBoolSetting("purchase_bonus_enabled", false);
    if (!enabled)
        return 0;
    const minSurcharge = Math.max(1000, Math.round((await getNumberSetting("purchase_bonus_min")) ?? 1000));
    const maxSurcharge = Math.max(minSurcharge, Math.round((await getNumberSetting("purchase_bonus_max")) ?? 10000));
    return Math.round(Math.random() * (maxSurcharge - minSurcharge) + minSurcharge);
}
async function grantTestConfig(userId, chatId) {
    const [enabled, productIdRaw, testMbRaw, testHoursRaw] = await Promise.all([
        getBoolSetting("test_config_enabled", false),
        getSetting("test_config_product_id"),
        getNumberSetting("test_config_mb"),
        getNumberSetting("test_config_hours")
    ]);
    if (!enabled) {
        await tg("sendMessage", { chat_id: chatId, text: "Γ¥î ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪»╪▒ ╪¡╪º┘ä ╪¡╪º╪╢╪▒ ┘ü╪╣╪º┘ä ┘å█î╪│╪¬." });
        return;
    }
    const productId = Number(productIdRaw || 0);
    if (!productId) {
        await tg("sendMessage", { chat_id: chatId, text: "Γ¥î ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ┘ç┘å┘ê╪▓ ┘╛█î┌⌐╪▒╪¿┘å╪»█î ┘å╪┤╪»┘ç. ┘ä╪╖┘ü╪º┘ï ╪¿╪╣╪»╪º┘ï ╪º┘à╪¬╪¡╪º┘å ┌⌐┘å█î╪»." });
        return;
    }
    const userRows = await sql `SELECT test_config_used_at FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
    if (userRows.length && userRows[0].test_config_used_at) {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ╪┤┘à╪º ┘é╪¿┘ä╪º┘ï ╪º╪▓ ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐╪▒╪»┘çΓÇî╪º█î╪».\n┘ç╪▒ ┌⌐╪º╪▒╪¿╪▒ ┘ü┘é╪╖ █î┌⌐ ╪¿╪º╪▒ ┘à█îΓÇî╪¬┘ê╪º┘å╪» ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪»╪▒█î╪º┘ü╪¬ ┌⌐┘å╪»." });
        return;
    }
    const productRows = await sql `
    SELECT p.id, p.name, p.size_mb, p.sell_mode, p.panel_id, p.panel_delivery_mode, p.panel_config, p.is_active,
           pnl.active AS panel_active, pnl.allow_new_sales AS panel_allow_new_sales
    FROM products p
    LEFT JOIN panels pnl ON pnl.id = p.panel_id
    WHERE p.id = ${productId}
    LIMIT 1;
  `;
    if (!productRows.length || !productRows[0].panel_id || !productRows[0].panel_active || !productRows[0].panel_allow_new_sales) {
        await tg("sendMessage", { chat_id: chatId, text: "Γ¥î ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪»╪▒ ╪º█î┘å ┘ä╪¡╪╕┘ç ╪»╪▒ ╪»╪│╪¬╪▒╪│ ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿╪╣╪»╪º┘ï ╪º┘à╪¬╪¡╪º┘å ┌⌐┘å█î╪»." });
        return;
    }
    const product = productRows[0];
    const testMb = Math.max(1, Math.round(testMbRaw ?? 100));
    const testHours = Math.max(1, Math.round(testHoursRaw ?? 24));
    const testDays = Math.max(1, Math.round(testHours / 24));
    await sql `UPDATE users SET test_config_used_at = NOW() WHERE telegram_id = ${userId};`;
    const panelConfigSnapshot = {
        ...sanitizePanelConfig(product.panel_config),
        data_limit_mb: testMb,
        expire_days: testDays
    };
    const purchaseId = `TC${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
    let orderId;
    try {
        orderId = await insertOrderRecord({
            purchaseId,
            telegramId: userId,
            productId: Number(product.id),
            productNameSnapshot: `┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ | ${testMb}MB - ${testHours} ╪│╪º╪╣╪¬`,
            sellMode: "panel",
            sourcePanelId: Number(product.panel_id),
            panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
            panelConfigSnapshot,
            paymentMethod: "test_config",
            discountCode: null,
            discountAmount: 0,
            finalPrice: 0,
            tronAmount: 0,
            status: "pending",
            walletUsed: 0
        });
    }
    catch (err) {
        await sql `UPDATE users SET test_config_used_at = NULL WHERE telegram_id = ${userId};`;
        await tg("sendMessage", { chat_id: chatId, text: "Γ¥î ╪«╪╖╪º ╪»╪▒ ╪½╪¿╪¬ ╪│┘ü╪º╪▒╪┤ ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬." });
        return;
    }
    const result = await finalizeOrder(orderId, null);
    if (!result.ok) {
        await sql `UPDATE users SET test_config_used_at = NULL WHERE telegram_id = ${userId};`;
        await sql `DELETE FROM orders WHERE id = ${orderId} AND payment_method = 'test_config' AND status IN ('pending', 'receipt_submitted');`;
        await tg("sendMessage", { chat_id: chatId, text: "Γ¥î ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪». ┘ä╪╖┘ü╪º┘ï ╪¿╪╣╪»╪º┘ï ╪º┘à╪¬╪¡╪º┘å ┌⌐┘å█î╪»." });
        return;
    }
    await tg("sendMessage", { chat_id: chatId, text: `Γ£à ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪┤┘à╪º ╪ó┘à╪º╪»┘ç ╪┤╪»!\n╪¡╪¼┘à: ${testMb}MB | ┘à╪»╪¬: ${testHours} ╪│╪º╪╣╪¬` }).catch(() => { });
}
async function showAdminPurchaseBonusSettings(chatId) {
    const [enabled, minVal, maxVal] = await Promise.all([
        getBoolSetting("purchase_bonus_enabled", false),
        getNumberSetting("purchase_bonus_min"),
        getNumberSetting("purchase_bonus_max")
    ]);
    const minSurcharge = Math.round(minVal ?? 1000);
    const maxSurcharge = Math.round(maxVal ?? 10000);
    await tg("sendMessage", {
        chat_id: chatId,
        text: `≡ƒÄ▓ ╪¬┘å╪╕█î┘à╪º╪¬ ╪º╪╢╪º┘ü┘çΓÇî┘é█î┘à╪¬ ╪¬╪╡╪º╪»┘ü█î ╪«╪▒█î╪»\n\n` +
            `┘ê╪╢╪╣█î╪¬: ${enabled ? "Γ£à ┘ü╪╣╪º┘ä" : "Γ¥î ╪║█î╪▒┘ü╪╣╪º┘ä"}\n` +
            `╪¡╪»╪º┘é┘ä ╪º╪╢╪º┘ü┘çΓÇî┘é█î┘à╪¬: ${formatPriceToman(minSurcharge)} ╪¬┘ê┘à╪º┘å\n` +
            `╪¡╪»╪º┌⌐╪½╪▒ ╪º╪╢╪º┘ü┘çΓÇî┘é█î┘à╪¬: ${formatPriceToman(maxSurcharge)} ╪¬┘ê┘à╪º┘å\n\n` +
            `╪¿╪º ┘ü╪╣╪º┘ä ╪¿┘ê╪»┘å ╪º█î┘å ┌»╪▓█î┘å┘ç╪î ╪»╪▒ ┘ç╪▒ ╪«╪▒█î╪» █î┌⌐ ┘à╪¿┘ä╪║ ╪¬╪╡╪º╪»┘ü█î ╪¿█î┘å ╪¡╪»╪º┘é┘ä ┘ê ╪¡╪»╪º┌⌐╪½╪▒ ╪¿┘ç ┘é█î┘à╪¬ ┘å┘ç╪º█î█î ┌⌐╪º╪▒╪¿╪▒ ╪º╪╢╪º┘ü┘ç ┘à█îΓÇî╪┤┘ê╪» ╪¿╪▒╪º█î ╪¼┘ä┘ê ┌»█î╪▒█î ╪º╪▓ ┘à╪│╪»┘ê╪»█î ┌⌐╪º╪▒╪¬ ┘ç╪º.`,
        reply_markup: {
            inline_keyboard: [
                [cb(enabled ? "Γ¢ö ╪║█î╪▒┘ü╪╣╪º┘äΓÇî┌⌐╪▒╪»┘å" : "Γ£à ┘ü╪╣╪º┘äΓÇî┌⌐╪▒╪»┘å", "admin_toggle_purchase_bonus", enabled ? "danger" : "success")],
                [cb("≡ƒÆ░ ╪¬┘å╪╕█î┘à ╪¡╪»╪º┘é┘ä ╪º╪╢╪º┘ü┘çΓÇî┘é█î┘à╪¬", "admin_set_purchase_bonus_min", "primary")],
                [cb("≡ƒÆ░ ╪¬┘å╪╕█î┘à ╪¡╪»╪º┌⌐╪½╪▒ ╪º╪╢╪º┘ü┘çΓÇî┘é█î┘à╪¬", "admin_set_purchase_bonus_max", "primary")],
                [backButton("admin_settings")]
            ]
        }
    });
}
async function showAdminTestConfigSettings(chatId) {
    const [enabled, productIdRaw, testMbRaw, testHoursRaw] = await Promise.all([
        getBoolSetting("test_config_enabled", false),
        getSetting("test_config_product_id"),
        getNumberSetting("test_config_mb"),
        getNumberSetting("test_config_hours")
    ]);
    const productId = Number(productIdRaw || 0);
    let productName = "╪º┘å╪¬╪«╪º╪¿ ┘å╪┤╪»┘ç";
    if (productId) {
        const pRows = await sql `SELECT name FROM products WHERE id = ${productId} LIMIT 1;`;
        productName = pRows.length ? String(pRows[0].name || "") : "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»";
    }
    const testMb = Math.round(testMbRaw ?? 100);
    const testHours = Math.round(testHoursRaw ?? 24);
    const usedCount = await sql `SELECT COUNT(*)::int AS cnt FROM users WHERE test_config_used_at IS NOT NULL;`;
    const cnt = Number(usedCount[0]?.cnt || 0);
    await tg("sendMessage", {
        chat_id: chatId,
        text: `≡ƒº¬ ╪¬┘å╪╕█î┘à╪º╪¬ ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬\n\n` +
            `┘ê╪╢╪╣█î╪¬: ${enabled ? "Γ£à ┘ü╪╣╪º┘ä" : "Γ¥î ╪║█î╪▒┘ü╪╣╪º┘ä"}\n` +
            `┘à╪¡╪╡┘ê┘ä ┘╛┘å┘ä: ${productName}\n` +
            `╪¡╪¼┘à ╪¬╪│╪¬: ${testMb}MB\n` +
            `┘à╪»╪¬ ╪▓┘à╪º┘å: ${testHours} ╪│╪º╪╣╪¬\n` +
            `╪¬╪╣╪»╪º╪» ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪º╪│╪¬┘ü╪º╪»┘çΓÇî┌⌐╪▒╪»┘ç: ${cnt} ┘å┘ü╪▒`,
        reply_markup: {
            inline_keyboard: [
                [cb(enabled ? "Γ¢ö ╪║█î╪▒┘ü╪╣╪º┘äΓÇî┌⌐╪▒╪»┘å" : "Γ£à ┘ü╪╣╪º┘äΓÇî┌⌐╪▒╪»┘å", "admin_toggle_test_config", enabled ? "danger" : "success")],
                [cb("≡ƒôª ╪º┘å╪¬╪«╪º╪¿ ┘à╪¡╪╡┘ê┘ä ┘╛┘å┘ä", "admin_pick_test_config_product", "primary")],
                [cb("≡ƒôè ╪¬┘å╪╕█î┘à ╪¡╪¼┘à (MB)", "admin_set_test_config_mb", "primary")],
                [cb("ΓÅ▒ ╪¬┘å╪╕█î┘à ┘à╪»╪¬ (╪│╪º╪╣╪¬)", "admin_set_test_config_hours", "primary")],
                [cb(`≡ƒöä ╪▒█î╪│╪¬ ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ (${cnt} ┘å┘ü╪▒)`, "admin_reset_test_configs", "danger")],
                [backButton("admin_settings")]
            ]
        }
    });
}
async function showAdminTestConfigProductPicker(chatId) {
    const rows = await sql `
    SELECT id, name, is_active, sell_mode
    FROM products
    WHERE sell_mode = 'panel'
    ORDER BY is_active DESC, id ASC
    LIMIT 30;
  `;
    const keyboard = rows.map((row) => {
        const activeBadge = row.is_active ? "Γ£à" : "Γ¢ö";
        return [cb(`${activeBadge} ${String(row.name)} (#${Number(row.id)})`, `admin_test_config_product_${Number(row.id)}`, "primary")];
    });
    if (!rows.length) {
        keyboard.push([{ text: "┘ç█î┌å ┘à╪¡╪╡┘ê┘ä ┘╛┘å┘ä█î ┘╛█î╪»╪º ┘å╪┤╪»", callback_data: "noop_no_panel_products" }]);
    }
    keyboard.push([cb("≡ƒÜ½ ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å ┘à╪¡╪╡┘ê┘ä ╪º┘å╪¬╪«╪º╪¿ΓÇî╪┤╪»┘ç", "admin_test_config_clear_product", "danger")]);
    keyboard.push([backButton("admin_test_config_settings")]);
    await tg("sendMessage", {
        chat_id: chatId,
        text: "≡ƒº¬ ╪º┘å╪¬╪«╪º╪¿ ┘à╪¡╪╡┘ê┘ä ┘╛┘å┘ä ╪¿╪▒╪º█î ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬\n\n█î┌⌐ ┘à╪¡╪╡┘ê┘ä ╪¿╪º sell_mode = panel ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪».",
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function cancelExpiredCryptoOrders() {
    const rows = await sql `
    UPDATE orders
    SET status = 'cancelled'
    WHERE payment_method = 'crypto'
      AND status = 'pending'
      AND crypto_expires_at < NOW()
    RETURNING telegram_id, purchase_id, wallet_used;
  `;
    for (const row of rows) {
        const walletUsed = Number(row.wallet_used || 0);
        if (walletUsed > 0) {
            try {
                await refundWalletUsage(Number(row.telegram_id), walletUsed, `╪¿╪º╪▓┌»╪┤╪¬ ┘à╪¿┘ä╪║ ┌⌐█î┘ü ┘╛┘ê┘ä ╪¿┘ç ╪»┘ä█î┘ä ╪º┘å┘é╪╢╪º█î ╪│┘ü╪º╪▒╪┤ ${row.purchase_id}`);
            }
            catch (error) {
                logError("refund_expired_crypto_wallet_failed", error, {
                    telegramId: Number(row.telegram_id),
                    purchaseId: String(row.purchase_id || ""),
                    walletUsed
                });
            }
        }
    }
}
function getOrderInsertErrorCode(error) {
    return error instanceof Error ? error.message : "";
}
async function getProductPriceFromSizeMb(sizeMb) {
    const productRateRaw = await getSetting("product_price_per_gb_toman");
    const fallbackRateRaw = await getSetting("topup_price_per_gb_toman");
    const rate = normalizePricePerGb(productRateRaw || fallbackRateRaw || "500000");
    return Math.max(1, Math.ceil((sizeMb / 1024) * rate));
}
async function sendConfigWithQr(chatId, purchaseId, configValue, keyboard, prefixText) {
    const captionLines = [
        prefixText ? prefixText : null,
        `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}`,
        `┌⌐╪º┘å┘ü█î┌»:\n${configValue}`
    ].filter(Boolean);
    await tgSendConfigQr({
        chat_id: chatId,
        qrText: configValue,
        parse_mode: "HTML",
        caption: escapeHtml(truncateText(captionLines.join("\n\n"), 900)),
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function sendDeliveryPackage(chatId, purchaseId, fallbackConfigValue, deliveryPayload, keyboard, prefixText) {
    const configLinks = deliveryPayload.configLinks || [];
    const hasManyConfigs = configLinks.length > 1;
    // Only fall back to fallbackConfigValue when there is NO subscription URL ΓÇö otherwise
    // we'd show the sub link twice (once as "┘ä█î┘å┌⌐ ╪│╪º╪¿" and again as "┌⌐╪º┘å┘ü█î┌»").
    const firstConfig = configLinks.length
        ? configLinks[0]
        : (!deliveryPayload.subscriptionUrl ? fallbackConfigValue || "" : "");
    const finalKeyboard = keyboard.map((row) => [...row]);
    if (hasManyConfigs && purchaseId && purchaseId !== "-") {
        finalKeyboard.unshift([{ text: "≡ƒôâ ┘å┘à╪º█î╪┤ ╪¿┘é█î┘ç ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º", callback_data: `show_configs_${purchaseId}_1` }]);
    }
    const captionLines = [
        prefixText ? prefixText : null,
        `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}`,
        deliveryPayload.subscriptionUrl ? `┘ä█î┘å┌⌐ ╪│╪º╪¿:\n${deliveryPayload.subscriptionUrl}` : null,
        firstConfig ? `┌⌐╪º┘å┘ü█î┌»:\n${firstConfig}` : null,
        hasManyConfigs ? `(${configLinks.length - 1} ┌⌐╪º┘å┘ü█î┌» ╪»█î┌»╪▒ ┘ç┘à ┘à┘ê╪¼┘ê╪» ╪º╪│╪¬)` : null
    ].filter(Boolean);
    const qrText = String(firstConfig || deliveryPayload.subscriptionUrl || "").trim();
    if (!qrText) {
        await tg("sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            text: escapeHtml(captionLines.join("\n\n")),
            reply_markup: { inline_keyboard: finalKeyboard }
        });
        return null;
    }
    await tgSendConfigQr({
        chat_id: chatId,
        qrText,
        parse_mode: "HTML",
        caption: escapeHtml(truncateText(captionLines.join("\n\n"), 900)),
        reply_markup: { inline_keyboard: finalKeyboard }
    });
}
function buildAdminDeliverySummary(params) {
    const meta = params.deliveryPayload.metadata || {};
    const username = typeof meta.username === "string" ? meta.username : null;
    const email = typeof meta.email === "string" ? meta.email : null;
    const uuid = typeof meta.uuid === "string" ? meta.uuid : null;
    const days = typeof meta.expire_days === "number" ? meta.expire_days : null;
    // Collect all subscription URLs (single or bulk)
    const allSubUrls = [];
    if (Array.isArray(meta.allSubscriptionUrls)) {
        for (const u of meta.allSubscriptionUrls) {
            if (typeof u === "string" && u.trim())
                allSubUrls.push(u.trim());
        }
    }
    if (!allSubUrls.length && params.deliveryPayload.subscriptionUrl) {
        allSubUrls.push(params.deliveryPayload.subscriptionUrl);
    }
    const subUrlLines = allSubUrls.length > 1
        ? allSubUrls.map((u, i) => `┘ä█î┘å┌⌐ ╪│╪º╪¿ ${i + 1}:\n${u}`).join("\n\n")
        : allSubUrls.length === 1
            ? `┘ä█î┘å┌⌐ ╪│╪º╪¿:\n${allSubUrls[0]}`
            : null;
    const lines = [
        "Γ£à ╪│┘ü╪º╪▒╪┤ ╪¬╪¡┘ê█î┘ä ╪┤╪»",
        `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${params.purchaseId}`,
        `┌⌐╪º╪▒╪¿╪▒: ${params.userId}`,
        `█î┘ê╪▓╪▒┘å█î┘à: ${params.telegramUsername}`,
        `┘å╪º┘à: ${params.telegramFullName}`,
        `┘à╪¡╪╡┘ê┘ä: ${params.productName}`,
        params.walletUsed ? `┌⌐╪│╪▒ ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä: ${formatPriceToman(params.walletUsed)} ╪¬┘ê┘à╪º┘å` : null,
        subUrlLines,
        username ? `username: ${username}` : null,
        email ? `email: ${email}` : null,
        uuid ? `uuid: ${uuid}` : null,
        days !== null ? `expire_days: ${days}` : null
    ].filter(Boolean);
    return lines.join("\n\n");
}
async function createTopupCard2CardRequest(chatId, userId, inventoryId, mb) {
    const ownRows = await sql `
    SELECT i.id, i.config_value, i.status, i.migrated_to_inventory_id, p.price_toman, p.size_mb
    FROM inventory i
    INNER JOIN products p ON p.id = i.product_id
    WHERE i.id = ${inventoryId} AND i.owner_telegram_id = ${userId} AND i.status IN ('sold', 'migrated')
    LIMIT 1;
  `;
    if (!ownRows.length || !Number.isFinite(mb) || mb <= 0) {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ╪»╪▒╪«┘ê╪º╪│╪¬ ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬ █î╪º ┌⌐╪º┘å┘ü█î┌» ╪¿╪▒╪º█î ╪┤┘à╪º ┘å█î╪│╪¬." });
        return null;
    }
    if (String(ownRows[0].status) === "migrated" && ownRows[0].migrated_to_inventory_id) {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜí ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¿┘ç ┘╛┘å┘ä ╪¼╪»█î╪» ┘à┘å╪¬┘é┘ä ╪┤╪»┘ç. ╪¿╪▒╪º█î ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪º╪▓ ┘ä█î╪│╪¬ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î╪¬╪º┘å ╪º┘é╪»╪º┘à ┌⌐┘å█î╪»." });
        return null;
    }
    const rateSetting = await getSetting("topup_price_per_gb_toman");
    const defaultRate = Math.max(1, Math.round((Number(ownRows[0].price_toman || 500000) * 1024) / Math.max(1, Number(ownRows[0].size_mb || 1024))));
    const rate = normalizePricePerGb(rateSetting ?? defaultRate, defaultRate);
    const finalPrice = Math.max(1, Math.ceil((mb / 1024) * rate));
    const cards = await sql `SELECT id, label, card_number, holder_name, bank_name FROM cards WHERE active = TRUE ORDER BY id ASC;`;
    if (!cards.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ü╪╣┘ä╪º┘ï ┌⌐╪º╪▒╪¬ ┘ü╪╣╪º┘ä█î ╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪º╪▒╪¬ΓÇî╪¿┘çΓÇî┌⌐╪º╪▒╪¬ ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬." });
        return null;
    }
    const randomMode = await getBoolSetting("random_card_distribution", false);
    const mainCardRaw = await getSetting("main_card_id");
    const mainCardId = mainCardRaw ? Number(mainCardRaw) : NaN;
    const preferred = Number.isFinite(mainCardId) ? cards.find((c) => Number(c.id) === mainCardId) : null;
    const selected = randomMode ? cards[Math.floor(Math.random() * cards.length)] : preferred || cards[0];
    const purchaseId = `T${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
    const inserted = await sql `
    INSERT INTO topup_requests (purchase_id, telegram_id, inventory_id, requested_mb, payment_method, card_id, final_price, status)
    VALUES (${purchaseId}, ${userId}, ${inventoryId}, ${mb}, 'card2card', ${selected.id}, ${finalPrice}, 'awaiting_receipt')
    RETURNING id;
  `;
    await setState(userId, "await_topup_receipt", { topupRequestId: inserted[0].id });
    await tg("sendMessage", {
        chat_id: chatId,
        text: `╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
            `╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤: ${purchaseId}\n` +
            `┘à┘é╪»╪º╪▒: ${mb}MB\n` +
            `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n\n` +
            `┌⌐╪º╪▒╪¬ ┘à┘é╪╡╪»:\n` +
            `${selected.label}\n` +
            `╪┤┘à╪º╪▒┘ç ┌⌐╪º╪▒╪¬: ${selected.card_number}\n` +
            `${selected.holder_name ? `╪╡╪º╪¡╪¿ ┌⌐╪º╪▒╪¬: ${selected.holder_name}\n` : ""}` +
            `${selected.bank_name ? `╪¿╪º┘å┌⌐: ${selected.bank_name}\n` : ""}\n` +
            `┘╛╪│ ╪º╪▓ ┘╛╪▒╪»╪º╪«╪¬╪î ╪╣┌⌐╪│ ╪▒╪│█î╪» ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».`,
        reply_markup: { inline_keyboard: [[homeButton()]] }
    });
}
function extractSanaeiClients(inbound) {
    const settings = toJsonObject(parseSanaeiNested(inbound.settings)) || {};
    const clientsRaw = Array.isArray(settings.clients) ? settings.clients : [];
    return clientsRaw
        .map((item) => toJsonObject(item))
        .filter((item) => Boolean(item));
}
async function applyTopupOnMarzban(panel, username, addBytes) {
    const login = await loginMarzbanPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !login.token) {
        return { ok: false, message: `Marzban auth failed: ${login.res.status}` };
    }
    const baseUrl = normalizeBaseUrl(String(panel.base_url));
    const getRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}`, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${login.token}`,
            Accept: "application/json"
        }
    });
    const getRaw = await getRes.text();
    const getData = parseJsonObject(getRaw);
    if (!getRes.ok || !getData) {
        return { ok: false, message: `Marzban user lookup failed: ${getRes.status} ${responseSnippet(getRaw)}` };
    }
    const currentLimit = Number(getData.data_limit || 0);
    if (!Number.isFinite(currentLimit) || currentLimit <= 0) {
        return { ok: false, message: "Marzban user has no finite data limit." };
    }
    const targetLimit = Math.max(0, Math.round(currentLimit + addBytes));
    const currentExpire = Number(getData.expire || 0);
    const thirtyDaysSeconds = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
    const payload = {
        ...getData,
        data_limit: targetLimit
    };
    if (payload.status && !["active", "disabled", "on_hold"].includes(payload.status)) {
        payload.status = "active";
    }
    if (currentExpire !== 0 && currentExpire < thirtyDaysSeconds) {
        payload.expire = thirtyDaysSeconds;
    }
    const putRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${login.token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify(payload)
    });
    const putRaw = await putRes.text();
    if (!putRes.ok) {
        return { ok: false, message: `Marzban topup failed: ${putRes.status} ${responseSnippet(putRaw)}` };
    }
    return { ok: true, message: `Marzban data_limit ${currentLimit} -> ${targetLimit}` };
}
async function applyTopupOnSanaei(panel, inboundId, email, addBytes) {
    const login = await loginSanaeiPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !jsonSuccess(login.data) || !login.cookie) {
        return { ok: false, message: `Sanaei auth failed: ${login.res.status}` };
    }
    const inbounds = await getSanaeiInbounds(String(panel.base_url), login.cookie);
    if (!inbounds.res.ok || !jsonSuccess(inbounds.data)) {
        return { ok: false, message: `Sanaei list inbounds failed: ${inbounds.res.status}` };
    }
    const inbound = inbounds.items.find((item) => Number(item.id || 0) === inboundId);
    if (!inbound) {
        return { ok: false, message: `inbound #${inboundId} not found` };
    }
    const clients = extractSanaeiClients(inbound);
    const client = clients.find((item) => String(item.email || "").toLowerCase() === email.toLowerCase());
    if (!client) {
        return { ok: false, message: `client email not found: ${email}` };
    }
    const currentTotalGb = Number(client.totalGB || 0);
    if (!Number.isFinite(currentTotalGb) || currentTotalGb <= 0) {
        return { ok: false, message: "Sanaei client has no finite totalGB." };
    }
    const targetTotalGb = Math.max(0, Math.round(currentTotalGb + addBytes));
    const currentExpiryTime = Number(client.expiryTime || 0);
    const thirtyDaysMs = Date.now() + (30 * 24 * 60 * 60 * 1000);
    const updatedClient = {
        ...client,
        totalGB: targetTotalGb,
        enable: true
    };
    if (currentExpiryTime !== 0 && currentExpiryTime < thirtyDaysMs) {
        updatedClient.expiryTime = thirtyDaysMs;
    }
    const candidateIds = Array.from(new Set([String(client.id || ""), String(client.password || ""), String(client.email || "")].filter(Boolean)));
    let lastFail = "update endpoint failed";
    for (const candidateId of candidateIds) {
        const res = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/panel/api/inbounds/updateClient/${encodeURIComponent(candidateId)}`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Cookie: login.cookie,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                id: inboundId,
                settings: JSON.stringify({ clients: [updatedClient] })
            })
        });
        const raw = await res.text();
        const parsed = parseJsonObject(raw);
        if (res.ok && (!raw.trim() || jsonSuccess(parsed))) {
            return { ok: true, message: `Sanaei totalGB ${currentTotalGb} -> ${targetTotalGb}` };
        }
        lastFail = `${res.status} ${responseSnippet(raw)}`;
    }
    return { ok: false, message: `Sanaei topup failed: ${lastFail}` };
}
async function resolveTelegramTargetId(raw) {
    const normalized = raw.trim();
    const direct = Number(normalized);
    if (Number.isFinite(direct) && direct > 0) {
        return { ok: true, telegramId: Math.round(direct), username: "" };
    }
    const username = normalized.replace("@", "").trim().toLowerCase();
    if (!username) {
        return { ok: false, reason: "╪┤┘å╪º╪│┘ç ┌⌐╪º╪▒╪¿╪▒ ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." };
    }
    const rows = await sql `
    SELECT telegram_id, username
    FROM users
    WHERE LOWER(username) = ${username}
    ORDER BY last_seen_at DESC
    LIMIT 1;
  `;
    if (!rows.length) {
        return { ok: false, reason: "┌⌐╪º╪▒╪¿╪▒█î ╪¿╪º ╪º█î┘å █î┘ê╪▓╪▒┘å█î┘à ┘╛█î╪»╪º ┘å╪┤╪»." };
    }
    return { ok: true, telegramId: Number(rows[0].telegram_id), username: String(rows[0].username || username) };
}
async function ensureAdminCustomProductId() {
    const name = "__ADMIN_CUSTOM_CONFIG__";
    await sql `
    INSERT INTO products (name, size_mb, price_toman, is_active, is_infinite, sell_mode, panel_delivery_mode, panel_config)
    VALUES (${name}, 1024, 1, FALSE, FALSE, 'panel', 'both', '{}'::jsonb)
    ON CONFLICT (name) DO NOTHING;
  `;
    const rows = await sql `SELECT id FROM products WHERE name = ${name} LIMIT 1;`;
    if (!rows.length) {
        throw new Error("┘à╪¡╪╡┘ê┘ä ╪│█î╪│╪¬┘à█î ╪¿╪▒╪º█î ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î ┘╛█î╪»╪º ┘å╪┤╪».");
    }
    return Number(rows[0].id);
}
async function resolveFirstSanaeiInboundId(panel) {
    const login = await loginSanaeiPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !jsonSuccess(login.data) || !login.cookie) {
        return { ok: false, reason: `┘ê╪▒┘ê╪» ╪¿┘ç ┘╛┘å┘ä ╪│╪º┘å╪º█î█î ┘å╪º┘à┘ê┘ü┘é: ${login.res.status}` };
    }
    const inbounds = await getSanaeiInbounds(String(panel.base_url), login.cookie);
    if (!inbounds.res.ok || !jsonSuccess(inbounds.data) || !inbounds.items.length) {
        return { ok: false, reason: "┘ç█î┌å inbound ┘ü╪╣╪º┘ä█î ╪▒┘ê█î ┘╛┘å┘ä ╪│╪º┘å╪º█î█î ┘╛█î╪»╪º ┘å╪┤╪»." };
    }
    const first = inbounds.items[0];
    const inboundId = Number(first.id || 0);
    if (!Number.isFinite(inboundId) || inboundId <= 0) {
        return { ok: false, reason: "╪┤┘å╪º╪│┘ç inbound ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." };
    }
    return { ok: true, inboundId, protocol: String(first.protocol || "vless") };
}
export async function applyAdminResetUsageOnMarzban(panel, username) {
    const login = await loginMarzbanPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !login.token) {
        return { ok: false, message: `Marzban auth failed: ${login.res.status}` };
    }
    const baseUrl = normalizeBaseUrl(String(panel.base_url));
    const resetRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}/reset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json" }
    });
    if (!resetRes.ok) {
        const resetRaw = await resetRes.text();
        return { ok: false, message: `Marzban reset traffic failed: ${resetRes.status} ${responseSnippet(resetRaw)}` };
    }
    return { ok: true, message: "Marzban usage reset." };
}
export async function applyAdminResetUsageOnSanaei(panel, inboundId, email) {
    const login = await loginSanaeiPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !jsonSuccess(login.data) || !login.cookie) {
        return { ok: false, message: `Sanaei auth failed: ${login.res.status}` };
    }
    const baseUrl = normalizeBaseUrl(String(panel.base_url));
    const resetRes = await fetchWithTimeout(`${baseUrl}/panel/api/inbounds/${inboundId}/resetClientTraffic/${encodeURIComponent(email)}`, {
        method: "POST",
        headers: { Accept: "application/json", Cookie: login.cookie }
    });
    if (!resetRes.ok) {
        const resetRaw = await resetRes.text();
        return { ok: false, message: `Sanaei reset traffic failed: ${resetRes.status} ${responseSnippet(resetRaw)}` };
    }
    // Sanaei does not automatically re-enable the client after resetting traffic. We must explicitly enable them.
    const enableRes = await updateSanaeiClient(panel, inboundId, email, (client) => ({
        ...client,
        enable: true
    }));
    if (!enableRes.ok) {
        return { ok: true, message: `Sanaei usage reset but enable failed: ${enableRes.message}` };
    }
    return { ok: true, message: "Sanaei usage reset and client enabled." };
}
async function applyAdminSetLimitOnlyOnMarzban(panel, username, targetBytes) {
    const login = await loginMarzbanPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !login.token) {
        return { ok: false, message: `Marzban auth failed: ${login.res.status}` };
    }
    const baseUrl = normalizeBaseUrl(String(panel.base_url));
    const getRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json" }
    });
    const getRaw = await getRes.text();
    const getData = parseJsonObject(getRaw);
    if (!getRes.ok || !getData) {
        return { ok: false, message: `Marzban user lookup failed: ${getRes.status} ${responseSnippet(getRaw)}` };
    }
    const currentLimit = Number(getData.data_limit || 0);
    const newLimit = Math.max(0, Math.round(targetBytes));
    if (currentLimit === newLimit)
        return { ok: true, message: "Marzban data limit unchanged." };
    const payload = { ...getData, data_limit: newLimit };
    if (payload.status && !["active", "disabled", "on_hold"].includes(payload.status)) {
        payload.status = "active";
    }
    const putRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${login.token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify(payload)
    });
    const putRaw = await putRes.text();
    if (!putRes.ok) {
        return { ok: false, message: `Marzban limit update failed: ${putRes.status} ${responseSnippet(putRaw)}` };
    }
    return { ok: true, message: "Marzban data limit updated." };
}
async function applyAdminSetLimitOnlyOnSanaei(panel, inboundId, email, targetBytes) {
    const res = await updateSanaeiClient(panel, inboundId, email, (client) => ({
        ...client,
        totalGB: Math.max(0, Math.round(targetBytes)),
        enable: true
    }));
    if (!res.ok)
        return res;
    return { ok: true, message: "Sanaei data limit updated." };
}
export async function applyAdminSetDataLimitOnMarzban(panel, username, targetBytes) {
    const login = await loginMarzbanPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !login.token) {
        return { ok: false, message: `Marzban auth failed: ${login.res.status}` };
    }
    const baseUrl = normalizeBaseUrl(String(panel.base_url));
    const resetRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}/reset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json" }
    });
    if (!resetRes.ok) {
        const resetRaw = await resetRes.text();
        return { ok: false, message: `Marzban reset traffic failed: ${resetRes.status} ${responseSnippet(resetRaw)}` };
    }
    const getRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json" }
    });
    const getRaw = await getRes.text();
    const getData = parseJsonObject(getRaw);
    if (!getRes.ok || !getData) {
        return { ok: false, message: `Marzban user lookup failed: ${getRes.status} ${responseSnippet(getRaw)}` };
    }
    const currentLimit = Number(getData.data_limit || 0);
    const newLimit = Math.max(0, Math.round(targetBytes));
    if (currentLimit === newLimit) {
        return { ok: true, message: "Marzban data limit and usage reset." };
    }
    const payload = { ...getData, data_limit: newLimit };
    if (payload.status && !["active", "disabled", "on_hold"].includes(payload.status)) {
        payload.status = "active";
    }
    const putRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${login.token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify(payload)
    });
    const putRaw = await putRes.text();
    if (!putRes.ok) {
        return { ok: false, message: `Marzban limit update failed: ${putRes.status} ${responseSnippet(putRaw)}` };
    }
    return { ok: true, message: "Marzban data limit and usage reset." };
}
export async function applyAdminSetExpiryOnMarzban(panel, username, expiryTimeMs) {
    const login = await loginMarzbanPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !login.token) {
        return { ok: false, message: `Marzban auth failed: ${login.res.status}` };
    }
    const baseUrl = normalizeBaseUrl(String(panel.base_url));
    const getRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json" }
    });
    const getRaw = await getRes.text();
    const getData = parseJsonObject(getRaw);
    if (!getRes.ok || !getData) {
        return { ok: false, message: `Marzban user lookup failed: ${getRes.status} ${responseSnippet(getRaw)}` };
    }
    const user = getData;
    const statusRaw = user.status;
    const statusCandidate = typeof statusRaw === "string"
        ? statusRaw
        : statusRaw && typeof statusRaw === "object"
            ? String(statusRaw.status || statusRaw.value || statusRaw.name || "")
            : "";
    const status = ["active", "disabled", "on_hold"].includes(statusCandidate) ? statusCandidate : "active";
    const payload = {
        username: String(user.username || username),
        proxies: user.proxies || {},
        inbounds: user.inbounds || {},
        expire: expiryTimeMs > 0 ? Math.floor(expiryTimeMs / 1000) : 0,
        data_limit: Number(user.data_limit || 0),
        data_limit_reset_strategy: String(user.data_limit_reset_strategy || "no_reset"),
        status,
        note: String(user.note || "")
    };
    const putRes = await fetchWithTimeout(`${baseUrl}/api/user/${encodeURIComponent(username)}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${login.token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
        },
        body: JSON.stringify(payload)
    });
    const putRaw = await putRes.text();
    if (!putRes.ok) {
        return { ok: false, message: `Marzban expiry update failed: ${putRes.status} ${responseSnippet(putRaw)}` };
    }
    return { ok: true, message: "Marzban expiry updated." };
}
async function updateSanaeiClient(panel, inboundId, email, updater) {
    const login = await loginSanaeiPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !jsonSuccess(login.data) || !login.cookie) {
        return { ok: false, message: `Sanaei auth failed: ${login.res.status}` };
    }
    const inbounds = await getSanaeiInbounds(String(panel.base_url), login.cookie);
    if (!inbounds.res.ok || !jsonSuccess(inbounds.data)) {
        return { ok: false, message: `Sanaei list inbounds failed: ${inbounds.res.status}` };
    }
    const inbound = inbounds.items.find((item) => Number(item.id || 0) === inboundId);
    if (!inbound)
        return { ok: false, message: `inbound #${inboundId} not found` };
    const clients = extractSanaeiClients(inbound);
    const client = clients.find((item) => String(item.email || "").toLowerCase() === email.toLowerCase());
    if (!client)
        return { ok: false, message: `client email not found: ${email}` };
    const updatedClient = updater(client);
    const candidateIds = Array.from(new Set([String(client.id || ""), String(client.password || ""), String(client.email || "")].filter(Boolean)));
    let lastFail = "update endpoint failed";
    for (const candidateId of candidateIds) {
        const res = await fetchWithTimeout(`${normalizeBaseUrl(String(panel.base_url))}/panel/api/inbounds/updateClient/${encodeURIComponent(candidateId)}`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Cookie: login.cookie,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                id: inboundId,
                settings: JSON.stringify({ clients: [updatedClient] })
            })
        });
        const raw = await res.text();
        const parsed = parseJsonObject(raw);
        if (res.ok && (!raw.trim() || jsonSuccess(parsed)))
            return { ok: true, message: "Sanaei client updated." };
        lastFail = `${res.status} ${responseSnippet(raw)}`;
    }
    return { ok: false, message: `Sanaei update failed: ${lastFail}` };
}
export async function applyAdminSetDataLimitOnSanaei(panel, inboundId, email, targetBytes) {
    const login = await loginSanaeiPanel({
        base_url: String(panel.base_url),
        username: String(panel.username || ""),
        password: String(panel.password || "")
    });
    if (!login.res.ok || !jsonSuccess(login.data) || !login.cookie) {
        return { ok: false, message: `Sanaei auth failed: ${login.res.status}` };
    }
    const baseUrl = normalizeBaseUrl(String(panel.base_url));
    const resetRes = await fetchWithTimeout(`${baseUrl}/panel/api/inbounds/${inboundId}/resetClientTraffic/${encodeURIComponent(email)}`, {
        method: "POST",
        headers: { Accept: "application/json", Cookie: login.cookie }
    });
    const resetOk = resetRes.ok;
    const limitRes = await updateSanaeiClient(panel, inboundId, email, (client) => ({
        ...client,
        totalGB: Math.max(0, Math.round(targetBytes)),
        up: 0,
        down: 0,
        enable: true
    }));
    if (!limitRes.ok)
        return limitRes;
    return {
        ok: true,
        message: resetOk ? "Sanaei data limit and usage reset." : "Sanaei data limit updated (fallback reset)."
    };
}
export async function applyAdminSetExpiryOnSanaei(panel, inboundId, email, expiryTimeMs) {
    return updateSanaeiClient(panel, inboundId, email, (client) => ({
        ...client,
        expiryTime: Math.max(0, Math.round(expiryTimeMs))
    }));
}
async function tryAutoApplyPanelTopup(topupRequestId, doneBy) {
    const rows = await sql `
    SELECT
      tr.id,
      tr.telegram_id,
      tr.inventory_id,
      tr.requested_mb,
      tr.purchase_id,
      tr.status,
      i.panel_id,
      i.delivery_payload,
      p.panel_type,
      p.base_url,
      p.username,
      p.password
    FROM topup_requests tr
    INNER JOIN inventory i ON i.id = tr.inventory_id
    LEFT JOIN panels p ON p.id = i.panel_id
    WHERE tr.id = ${topupRequestId}
    LIMIT 1;
  `;
    if (!rows.length) {
        return { ok: false, message: "Topup request not found." };
    }
    const row = rows[0];
    if (String(row.status) !== "paid") {
        return { ok: false, message: "Topup request is not in paid state." };
    }
    if (!row.panel_id || !row.panel_type) {
        return { ok: false, message: "Inventory is not a panel-issued config." };
    }
    const payload = parseDeliveryPayload(row.delivery_payload);
    const metadata = payload.metadata || {};
    const addBytes = Math.max(0, Math.round(Number(row.requested_mb || 0) * 1024 * 1024));
    if (!addBytes) {
        return { ok: false, message: "Requested data amount is invalid." };
    }
    const panel = {
        base_url: row.base_url,
        username: row.username,
        password: row.password
    };
    let result = { ok: false, message: "Unsupported panel type." };
    if (isMarzbanLike(String(row.panel_type))) {
        const username = String(metadata.username || "").trim();
        if (!username) {
            return { ok: false, message: "Missing panel username in delivery metadata." };
        }
        result = await applyTopupOnMarzban(panel, username, addBytes);
    }
    else if (String(row.panel_type) === "sanaei") {
        const inboundId = parseMaybeNumber(metadata.inboundId);
        const email = String(metadata.email || "").trim();
        if (!inboundId || !email) {
            return { ok: false, message: "Missing inboundId/email in delivery metadata." };
        }
        result = await applyTopupOnSanaei(panel, inboundId, email, addBytes);
    }
    if (!result.ok) {
        return result;
    }
    const doneRows = await sql `
    UPDATE topup_requests
    SET status = 'done', done_at = NOW(), done_by = ${doneBy}
    WHERE id = ${topupRequestId} AND status = 'paid'
    RETURNING telegram_id, inventory_id, requested_mb, purchase_id;
  `;
    if (!doneRows.length) {
        return { ok: false, message: "Topup status changed before auto completion." };
    }
    const cfg = await sql `SELECT config_value FROM inventory WHERE id = ${doneRows[0].inventory_id} LIMIT 1;`;
    await tg("sendMessage", {
        chat_id: Number(doneRows[0].telegram_id),
        text: `╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ${doneRows[0].requested_mb}MB ╪┤┘à╪º ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à\n` +
            `╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤: ${doneRows[0].purchase_id}\n` +
            `┌⌐╪º┘å┘ü█î┌»:\n${String(cfg[0]?.config_value || "-")}`
    });
    return { ok: true, message: result.message };
}
async function generateUniqueConfigName(baseName, userId, quantity, index, sharedRandom) {
    // Use a 5-digit random to minimise collisions in the globally-shared panel namespace.
    // The panel enforces uniqueness across ALL users, so we must check globally too.
    const randomNum = sharedRandom ?? (Math.floor(Math.random() * 90000) + 10000);
    const nameWithRandom = `${baseName}${randomNum}`;
    let name = quantity === 1 ? nameWithRandom : `${nameWithRandom}_${index}`;
    // Check globally ΓÇö another user could already hold the same name on the panel
    const existing = await sql `
    SELECT id FROM orders
    WHERE config_name = ${name}
    LIMIT 1;
  `;
    if (existing.length > 0) {
        // Generate a completely fresh random and retry once more
        const retryRandom = Math.floor(Math.random() * 90000) + 10000;
        const retryBase = `${baseName}${retryRandom}`;
        name = quantity === 1 ? retryBase : `${retryBase}_${index}`;
    }
    return name;
}
async function createBulkOrders(chatId, userId, productId, paymentMethod, discountInput, walletUsedParam = 0, quantity = 1, baseName = "config") {
    const configNames = [];
    const sharedRandom = Math.floor(Math.random() * 100) + 1;
    for (let i = 1; i <= quantity; i++) {
        const configName = await generateUniqueConfigName(baseName, userId, quantity, i, sharedRandom);
        configNames.push(configName);
    }
    // Calculate total price - get product price and multiply by quantity
    const productRows = await sql `SELECT price_toman FROM products WHERE id = ${productId} LIMIT 1;`;
    if (!productRows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪»." });
        return null;
    }
    const unitPrice = Number(productRows[0].price_toman || 0);
    const totalPrice = unitPrice * quantity;
    // Create overrides with quantity info stored in panel config
    const overrides = {
        basePriceToman: totalPrice,
        configName: configNames[0], // First name for the first config
        panelConfigPatch: {
            bulk_quantity: quantity,
            bulk_config_names: configNames,
            bulk_base_name: baseName
        },
        productNameSuffix: quantity > 1 ? `(x${quantity})` : undefined
    };
    // Create a single order with total price
    const orderCreated = await createOrder(chatId, userId, productId, paymentMethod, discountInput, walletUsedParam, overrides);
    if (!orderCreated) {
        await tg("sendMessage", {
            chat_id: chatId,
            text: `Γ¥î ╪«╪╖╪º: ┘å╪¬┘ê╪º┘å╪│╪¬█î┘à ╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪▒╪º ╪½╪¿╪¬ ┌⌐┘å█î┘à. ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪» █î╪º ╪º╪▓ ┘╛╪┤╪¬█î╪¿╪º┘å█î ┌⌐┘à┌⌐ ╪¿┌»█î╪▒█î╪».`
        });
        return null;
    }
    return orderCreated;
}
async function createOrder(chatId, userId, productId, paymentMethod, discountInput, walletUsedParam = 0, overrides = null) {
    const globalInfinite = await getBoolSetting("global_infinite_mode", false);
    const rows = await sql `
    SELECT
      p.id,
      p.name,
      p.price_toman,
      p.size_mb,
      p.is_infinite,
      p.sell_mode,
      p.panel_id,
      p.panel_sell_limit,
      p.panel_delivery_mode,
      p.panel_config,
      pnl.active AS panel_active,
      pnl.allow_new_sales AS panel_allow_new_sales,
      (
        SELECT COUNT(*)::int
        FROM inventory i
        WHERE i.product_id = p.id AND i.status = 'available'
      ) AS stock,
      (
        SELECT COUNT(*)::int
        FROM orders o
        WHERE o.product_id = p.id
          AND o.sell_mode = 'panel'
          AND o.status NOT IN ('denied')
      ) AS panel_sales_count
    FROM products p
    LEFT JOIN panels pnl ON pnl.id = p.panel_id
    WHERE p.id = ${productId} AND p.is_active = TRUE
    LIMIT 1;
  `;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪»." });
        return null;
    }
    const product = rows[0];
    const sellMode = parseSellMode(String(product.sell_mode || ""));
    const panelRemaining = Number(product.panel_sell_limit || 0) > 0 ? Math.max(0, Number(product.panel_sell_limit) - Number(product.panel_sales_count || 0)) : Infinity;
    if (sellMode === "panel" &&
        (!product.panel_id || !product.panel_active || !product.panel_allow_new_sales || panelRemaining <= 0)) {
        await tg("sendMessage", { chat_id: chatId, text: "┘ü╪▒┘ê╪┤ ╪º╪▓ ┘╛┘å┘ä ╪¿╪▒╪º█î ╪º█î┘å ┘à╪¡╪╡┘ê┘ä ┘ü╪╣┘ä╪º┘ï ╪»╪▒ ╪»╪│╪¬╪▒╪│ ┘å█î╪│╪¬." });
        return null;
    }
    const allowNoStock = sanitizePanelConfig(overrides?.panelConfigPatch).force_awaiting_config === true;
    const surcharge = await getPurchaseSurcharge();
    const basePriceToman = Math.max(1, Math.round(Number(overrides?.basePriceToman ?? product.price_toman)) + surcharge);
    const configName = overrides?.configName ? String(overrides.configName).trim() : null;
    const basePanelConfig = sanitizePanelConfig(product.panel_config);
    const panelConfigSnapshot = overrides?.panelConfigPatch ? { ...basePanelConfig, ...sanitizePanelConfig(overrides.panelConfigPatch) } : basePanelConfig;
    const orderQuantity = getOrderBulkQuantity({ panel_config_snapshot: panelConfigSnapshot }, panelConfigSnapshot);
    if (sellMode !== "panel" && !globalInfinite && !product.is_infinite && Number(product.stock) < orderQuantity && !allowNoStock) {
        await tg("sendMessage", {
            chat_id: chatId,
            text: Number(product.stock) <= 0
                ? "┘à┘ê╪¼┘ê╪»█î ╪º█î┘å ┘à╪¡╪╡┘ê┘ä ╪¬┘à╪º┘à ╪┤╪»┘ç ╪º╪│╪¬."
                : `┘à┘ê╪¼┘ê╪»█î ┌⌐╪º┘ü█î ┘å█î╪│╪¬. ┘à┘ê╪¼┘ê╪»█î: ${Number(product.stock)} ╪╣╪»╪»╪î ╪»╪▒╪«┘ê╪º╪│╪¬ ╪┤┘à╪º: ${orderQuantity} ╪╣╪»╪».`
        });
        return null;
    }
    const productNameSnapshot = `${String(product.name || "")}${overrides?.productNameSuffix ? ` ${overrides.productNameSuffix}` : ""}`.trim();
    const { discountAmount, discountCode } = await resolveDiscount(discountInput, basePriceToman);
    let walletUsed = 0;
    let finalPrice = Math.max(1, basePriceToman - discountAmount);
    if (paymentMethod === "wallet") {
        const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
        const walletBalance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
        if (walletBalance < finalPrice) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
            return null;
        }
        walletUsed = finalPrice;
        finalPrice = 0;
    }
    else if (walletUsedParam > 0) {
        const userRows = await sql `SELECT wallet_balance FROM users WHERE telegram_id = ${userId} LIMIT 1;`;
        const walletBalance = userRows.length ? Number(userRows[0].wallet_balance || 0) : 0;
        walletUsed = Math.min(walletUsedParam, walletBalance, Math.max(0, basePriceToman - discountAmount));
        finalPrice = Math.max(1, basePriceToman - discountAmount - walletUsed);
    }
    let cryptoWalletId = null;
    if (paymentMethod.startsWith("crypto_")) {
        const parsed = Number(paymentMethod.replace("crypto_", ""));
        cryptoWalletId = Number.isFinite(parsed) ? parsed : null;
        paymentMethod = "crypto";
    }
    if (paymentMethod === "crypto" && cryptoWalletId === null) {
        const wallets = await getActiveCryptoWallets();
        const ready = wallets.filter(cryptoWalletReady);
        if (!ready.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê█î ┘ü╪╣╪º┘ä█î ╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬ ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        if (ready.length > 1) {
            await setState(userId, "await_crypto_wallet_select", { productId, discountInput, walletUsedParam, overrides });
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┌⌐╪»╪º┘à ┌⌐█î┘ü ┘╛┘ê┘ä ╪▒╪º ╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬ ╪º┘å╪¬╪«╪º╪¿ ┘à█îΓÇî┌⌐┘å█î╪»╪ƒ",
                reply_markup: { inline_keyboard: ready.slice(0, 12).map((w) => [{ text: cryptoWalletTitle(w), callback_data: `select_crypto_wallet_${w.id}` }]).concat([[homeButton()]]) }
            });
            return null;
        }
        cryptoWalletId = ready[0].id;
    }
    let swapwalletToken = null;
    let swapwalletNetwork = null;
    if (paymentMethod.startsWith("swapwallet_")) {
        const payload = paymentMethod.replace("swapwallet_", "");
        const parts = payload.split("_").map((x) => x.trim()).filter(Boolean);
        swapwalletToken = parts.length ? parts[0].toUpperCase() : null;
        swapwalletNetwork = parts.length > 1 ? parts[1].toUpperCase() : null;
        paymentMethod = "swapwallet";
    }
    if (paymentMethod === "swapwallet" && (!swapwalletToken || !swapwalletNetwork)) {
        try {
            const { getSwapwalletAllowedTokens } = await import("./swapwallet.js");
            const tokens = await getSwapwalletAllowedTokens();
            if (!tokens.length) {
                await tg("sendMessage", { chat_id: chatId, text: "┘ü╪╣┘ä╪º┘ï ┘ç█î┌å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬█î ╪¿╪▒╪º█î SwapWallet ╪»╪▒ ╪»╪│╪¬╪▒╪│ ┘å█î╪│╪¬." });
                return null;
            }
            await setState(userId, "await_swapwallet_asset_select", { productId, discountInput, walletUsedParam, overrides });
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º SwapWallet\n┌⌐╪»╪º┘à ╪º╪▒╪▓/╪┤╪¿┌⌐┘ç ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┘à█îΓÇî┌⌐┘å█î╪»╪ƒ",
                reply_markup: {
                    inline_keyboard: tokens
                        .slice(0, 12)
                        .map((t) => [cb(`${t.token} (${t.network})`, `swapwallet_asset_${t.token}_${t.network}`, "primary")])
                        .concat([[homeButton()]])
                }
            });
        }
        catch (e) {
            logError("swapwallet_allowed_tokens_failed", e, { userId, chatId });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪»╪▒█î╪º┘ü╪¬ ┌»╪▓█î┘å┘çΓÇî┘ç╪º█î ┘╛╪▒╪»╪º╪«╪¬ SwapWallet." });
        }
        return null;
    }
    const purchaseId = `P${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
    if (paymentMethod === "wallet") {
        try {
            const orderId = await withClaimedDiscount(discountCode, () => insertOrderRecord({
                purchaseId,
                telegramId: userId,
                productId: Number(product.id),
                productNameSnapshot,
                sellMode,
                sourcePanelId: product.panel_id ? Number(product.panel_id) : null,
                panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
                panelConfigSnapshot,
                paymentMethod: "wallet",
                discountCode,
                discountAmount,
                finalPrice: 0,
                tronAmount: 0,
                status: "pending",
                walletUsed,
                configName,
                walletTransactionDescription: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${purchaseId})`
            }));
            await tg("sendMessage", {
                chat_id: chatId,
                text: `Γ£à ┘à╪¿┘ä╪║ ${formatPriceToman(walletUsed)} ╪¬┘ê┘à╪º┘å ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ┌⌐╪│╪▒ ╪┤╪» ┘ê ╪│┘ü╪º╪▒╪┤ ╪½╪¿╪¬ ┌»╪▒╪»█î╪».\n╪»╪▒╪¡╪º┘ä ╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î ┘à╪¡╪╡┘ê┘ä...`
            });
            // Wrap finalizeOrder in a 24-second timeout so the user always gets a response
            // even if the panel is slow or Vercel kills the function at 30 s.
            let fulfillTimedOut = false;
            const fulfill = await Promise.race([
                finalizeOrder(orderId, null),
                new Promise((resolve) => setTimeout(() => { fulfillTimedOut = true; resolve({ ok: false, reason: "timeout" }); }, 24_000))
            ]);
            if (!fulfill.ok) {
                const reason = fulfill.reason;
                // provision_failed is fully handled inside finalizeOrder (sends retry/refund buttons itself)
                if (reason === "provision_failed") {
                    // nothing to do here
                }
                else if (reason === "already_paid" || reason === "already_processing" || reason === "awaiting_config") {
                    // already handled or queued ΓÇö no extra message needed
                }
                else {
                    // panel_unavailable, stock_empty, timeout, or any other reason:
                    // Payment was accepted but config could not be delivered ΓåÆ give the user options.
                    // Ensure order ends up in awaiting_config so the retry button can work.
                    await sql `
            UPDATE orders
            SET status = 'awaiting_config', paid_at = COALESCE(paid_at, NOW())
            WHERE id = ${orderId}
              AND status IN ('pending', 'fulfilling', 'receipt_submitted');
          `;
                    const reasonLabel = reason === "timeout" ? "┘à╪»╪¬ ╪▓┘à╪º┘å ┘╛╪º╪│╪«ΓÇî╪»┘ç█î ╪│╪▒┘ê╪▒ ╪¿█î╪┤ ╪º╪▓ ╪¡╪» ╪╖┘ê┘ä╪º┘å█î ╪┤╪»" :
                        reason === "panel_unavailable" ? "┘╛┘å┘ä ╪»╪▒ ╪º█î┘å ┘ä╪¡╪╕┘ç ╪»╪▒ ╪»╪│╪¬╪▒╪│ ┘å█î╪│╪¬" :
                            reason === "stock_empty" ? "┘à┘ê╪¼┘ê╪»█î ┘à╪¡╪╡┘ê┘ä ╪¬┘à╪º┘à ╪┤╪»┘ç ╪º╪│╪¬" :
                                "╪«╪╖╪º█î ┘å╪º╪┤┘å╪º╪«╪¬┘ç ╪»╪▒ ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌»";
                    await tg("sendMessage", {
                        chat_id: chatId,
                        parse_mode: "HTML",
                        text: `ΓÜá∩╕Å ┘╛╪▒╪»╪º╪«╪¬ ╪┤┘à╪º ╪½╪¿╪¬ ╪┤╪»╪î ╪º┘à╪º ╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î ┘à╪¡╪╡┘ê┘ä ╪¿╪º ┘à╪┤┌⌐┘ä ┘à┘ê╪º╪¼┘ç ╪┤╪».\n` +
                            `╪»┘ä█î┘ä: ${reasonLabel}\n\n` +
                            `┘ä╪╖┘ü╪º┘ï █î┌⌐█î ╪º╪▓ ┌»╪▓█î┘å┘çΓÇî┘ç╪º█î ╪▓█î╪▒ ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: "≡ƒöä ╪¬┘ä╪º╪┤ ┘à╪¼╪»╪» ╪¿╪▒╪º█î ╪»╪▒█î╪º┘ü╪¬ ┌⌐╪º┘å┘ü█î┌»", callback_data: `retry_config_${orderId}` }],
                                [{ text: "≡ƒÆ░ ╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä", callback_data: `refund_to_wallet_${orderId}` }]
                            ]
                        }
                    }).catch(() => { });
                    await notifyAdmins(`ΓÜá∩╕Å ╪│┘ü╪º╪▒╪┤ ${purchaseId} ┘╛╪▒╪»╪º╪«╪¬ ╪┤╪» (┌⌐█î┘ü ┘╛┘ê┘ä) ╪º┘à╪º ╪¬╪¡┘ê█î┘ä ┘å╪┤╪».\n╪»┘ä█î┘ä: ${reason}\n┌⌐╪º╪▒╪¿╪▒: ${userId}`, { inline_keyboard: [
                            [{ text: "╪º╪▒╪│╪º┘ä ┌⌐╪º┘å┘ü█î┌» ╪»╪│╪¬█î", callback_data: `admin_provide_config_${orderId}` }],
                            [{ text: "≡ƒöÄ ╪¿╪▒╪▒╪│█î ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]
                        ] });
                }
            }
            return purchaseId;
        }
        catch (error) {
            const code = getOrderInsertErrorCode(error);
            if (code === "discount_unavailable") {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»█î┌»╪▒ ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪½╪¿╪¬ ┌⌐┘å█î╪»." });
                return null;
            }
            if (code === "wallet_insufficient") {
                await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
                return null;
            }
            logError("create_wallet_order_failed", error, { chatId, userId, productId, purchaseId });
            await tg("sendMessage", { chat_id: chatId, text: "╪│╪º╪«╪¬ ╪│┘ü╪º╪▒╪┤ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪». ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
        }
        return null;
    }
    if (false && paymentMethod === "wallet") {
        // Atomic deduction and order insertion to prevent negative balance exploits
        const inserted = await sql `
      WITH deducted AS (
        UPDATE users
        SET wallet_balance = wallet_balance - ${walletUsed}
        WHERE telegram_id = ${userId} AND wallet_balance >= ${walletUsed}
        RETURNING telegram_id
      )
      INSERT INTO orders
      (
        purchase_id, telegram_id, product_id, product_name_snapshot, sell_mode, source_panel_id, panel_delivery_mode, panel_config_snapshot,
        payment_method, discount_code, discount_amount, final_price, tron_amount, status, wallet_used
      )
      SELECT
        ${purchaseId}, ${userId}, ${product.id}, ${productNameSnapshot}, ${sellMode}, ${product.panel_id || null}, ${parseDeliveryMode(String(product.panel_delivery_mode || ""))},
        ${JSON.stringify(panelConfigSnapshot)}::jsonb,
        'wallet', ${discountCode}, ${discountAmount}, 0, 0, 'pending', ${walletUsed}
      FROM deducted
      RETURNING id;
    `;
        if (!inserted.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ┌⌐╪º┘ü█î ┘å█î╪│╪¬ █î╪º ╪«╪╖╪º█î█î ╪▒╪« ╪»╪º╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        const negativeWalletUsed = -walletUsed;
        await sql `
      INSERT INTO wallet_transactions (telegram_id, amount, type, description, created_at)
      VALUES (${userId}, ${negativeWalletUsed}, 'purchase', ${`╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${purchaseId})`}, NOW());
    `;
        return purchaseId;
        const orderId = Number(inserted[0].id);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `Γ£à ┘à╪¿┘ä╪║ ${formatPriceToman(walletUsed)} ╪¬┘ê┘à╪º┘å ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ┌⌐╪│╪▒ ╪┤╪» ┘ê ╪│┘ü╪º╪▒╪┤ ╪½╪¿╪¬ ┌»╪▒╪»█î╪».\n╪»╪▒╪¡╪º┘ä ╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î ┘à╪¡╪╡┘ê┘ä...`
        });
        const fulfill = await finalizeOrder(orderId, null);
        if (!fulfill.ok && fulfill.reason === "stock_empty") {
            await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ╪╡┘ü╪▒ ╪º╪│╪¬. ╪º╪»┘à█î┘å ┘╛█î┌»█î╪▒█î ┘à█îΓÇî┌⌐┘å╪»." });
        }
        return null;
    }
    if (paymentMethod === "card2card") {
        const cards = await sql `SELECT id, label, card_number, holder_name, bank_name FROM cards WHERE active = TRUE ORDER BY id ASC;`;
        if (!cards.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ü╪╣┘ä╪º┘ï ┌⌐╪º╪▒╪¬ ┘ü╪╣╪º┘ä█î ╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪º╪▒╪¬ΓÇî╪¿┘çΓÇî┌⌐╪º╪▒╪¬ ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        const randomMode = await getBoolSetting("random_card_distribution", false);
        const mainCardRaw = await getSetting("main_card_id");
        const mainCardId = mainCardRaw ? Number(mainCardRaw) : NaN;
        const preferred = Number.isFinite(mainCardId) ? cards.find((c) => Number(c.id) === mainCardId) : null;
        const selected = randomMode ? cards[Math.floor(Math.random() * cards.length)] : preferred || cards[0];
        try {
            const orderId = await withClaimedDiscount(discountCode, () => insertOrderRecord({
                purchaseId,
                telegramId: userId,
                productId: Number(product.id),
                productNameSnapshot,
                sellMode,
                sourcePanelId: product.panel_id ? Number(product.panel_id) : null,
                panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
                panelConfigSnapshot,
                paymentMethod: "card2card",
                cardId: Number(selected.id),
                discountCode,
                discountAmount,
                finalPrice,
                tronAmount: 0,
                status: "awaiting_receipt",
                walletUsed,
                configName,
                walletTransactionDescription: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${purchaseId})`
            }));
            await setState(userId, "await_receipt", { orderId });
            await tg("sendMessage", {
                chat_id: chatId,
                text: `╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
                    `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
                    `┘à╪¡╪╡┘ê┘ä: ${productNameSnapshot}\n` +
                    `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n\n` +
                    `┌⌐╪º╪▒╪¬ ┘à┘é╪╡╪»:\n` +
                    `${selected.label}\n` +
                    `╪┤┘à╪º╪▒┘ç ┌⌐╪º╪▒╪¬: ${selected.card_number}\n` +
                    `${selected.holder_name ? `╪╡╪º╪¡╪¿ ┌⌐╪º╪▒╪¬: ${selected.holder_name}\n` : ""}` +
                    `${selected.bank_name ? `╪¿╪º┘å┌⌐: ${selected.bank_name}\n` : ""}\n` +
                    `ΓÜá∩╕ÅΓÜá∩╕Å ┘ç╪┤╪»╪º╪▒ ┘à┘ç┘à ΓÜá∩╕ÅΓÜá∩╕Å\n` +
                    `┘ä╪╖┘ü╪º┘ï ╪»┘é█î┘é╪º┘ï ┘à╪¿┘ä╪║ ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å ╪▒╪º ┘ê╪º╪▒█î╪▓ ┌⌐┘å█î╪».\n` +
                    `╪»╪▒ ╪╡┘ê╪▒╪¬ ┘ê╪º╪▒█î╪▓ ┘à╪¿┘ä╪║ ╪º╪┤╪¬╪¿╪º┘ç╪î ╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪¬╪ú█î█î╪» ┘å╪«┘ê╪º┘ç╪» ╪┤╪»!\n\n` +
                    `╪¿╪╣╪» ╪º╪▓ ╪º┘å╪¬┘é╪º┘ä╪î ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ╪▒╪│█î╪» ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».`,
                reply_markup: {
                    inline_keyboard: [[homeButton()]]
                }
            });
            return purchaseId;
        }
        catch (error) {
            const code = getOrderInsertErrorCode(error);
            if (code === "discount_unavailable") {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»█î┌»╪▒ ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪½╪¿╪¬ ┌⌐┘å█î╪»." });
                return null;
            }
            if (code === "wallet_insufficient") {
                await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪¿╪▒╪º█î ╪½╪¿╪¬ ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
                return null;
            }
            logError("create_card2card_order_failed", error, { chatId, userId, productId, purchaseId });
            await tg("sendMessage", { chat_id: chatId, text: "╪│╪º╪«╪¬ ╪│┘ü╪º╪▒╪┤ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪». ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
        }
        return null;
    }
    if (false && paymentMethod === "card2card") {
        const cards = await sql `SELECT id, label, card_number, holder_name, bank_name FROM cards WHERE active = TRUE ORDER BY id ASC;`;
        if (!cards.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ü╪╣┘ä╪º┘ï ┌⌐╪º╪▒╪¬ ┘ü╪╣╪º┘ä█î ╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪º╪▒╪¬ΓÇî╪¿┘çΓÇî┌⌐╪º╪▒╪¬ ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        const randomMode = await getBoolSetting("random_card_distribution", false);
        const mainCardRaw = await getSetting("main_card_id");
        const mainCardId = mainCardRaw ? Number(mainCardRaw) : NaN;
        const preferred = Number.isFinite(mainCardId) ? cards.find((c) => Number(c.id) === mainCardId) : null;
        const selected = randomMode ? cards[Math.floor(Math.random() * cards.length)] : preferred || cards[0];
        const inserted = await sql `
      INSERT INTO orders
      (
        purchase_id, telegram_id, product_id, product_name_snapshot, sell_mode, source_panel_id, panel_delivery_mode, panel_config_snapshot,
        payment_method, card_id, discount_code, discount_amount, final_price, tron_amount, status, wallet_used
      )
      VALUES
      (
        ${purchaseId}, ${userId}, ${product.id}, ${productNameSnapshot}, ${sellMode}, ${product.panel_id || null}, ${parseDeliveryMode(String(product.panel_delivery_mode || ""))},
        ${JSON.stringify(panelConfigSnapshot)}::jsonb,
        'card2card', ${selected.id}, ${discountCode}, ${discountAmount}, ${finalPrice}, 0, 'awaiting_receipt', ${walletUsed}
      )
      RETURNING id;
    `;
        await setState(userId, "await_receipt", { orderId: inserted[0].id });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
                `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
                `┘à╪¡╪╡┘ê┘ä: ${productNameSnapshot}\n` +
                `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n\n` +
                `┌⌐╪º╪▒╪¬ ┘à┘é╪╡╪»:\n` +
                `${selected.label}\n` +
                `╪┤┘à╪º╪▒┘ç ┌⌐╪º╪▒╪¬: ${selected.card_number}\n` +
                `${selected.holder_name ? `╪╡╪º╪¡╪¿ ┌⌐╪º╪▒╪¬: ${selected.holder_name}\n` : ""}` +
                `${selected.bank_name ? `╪¿╪º┘å┌⌐: ${selected.bank_name}\n` : ""}\n` +
                `╪¿╪╣╪» ╪º╪▓ ╪º┘å╪¬┘é╪º┘ä╪î ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ╪▒╪│█î╪» ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».`,
            reply_markup: {
                inline_keyboard: [[homeButton()]]
            }
        });
        return purchaseId;
    }
    if (paymentMethod === "crypto") {
        if (!cryptoWalletId) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê ╪º┘å╪¬╪«╪º╪¿ ┘å╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        const walletRows = await sql `
      SELECT id, currency, network, address, rate_mode, rate_toman_per_unit, extra_toman_per_unit, active
      FROM crypto_wallets
      WHERE id = ${cryptoWalletId}
      LIMIT 1;
    `;
        if (!walletRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const w = walletRows[0];
        if (!cryptoWalletReady(w)) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê ╪¿┘çΓÇî╪»╪▒╪│╪¬█î ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç █î╪º ╪║█î╪▒┘ü╪╣╪º┘ä ╪º╪│╪¬." });
            return null;
        }
        const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
        let tomanPerUnit = 0;
        if (w.rate_mode === "auto") {
            const base = await getCryptoTomanPerUnitCached(String(w.currency || ""));
            tomanPerUnit = base + Number(w.extra_toman_per_unit || 0);
        }
        else {
            tomanPerUnit = Number(w.rate_toman_per_unit || 0) + Number(w.extra_toman_per_unit || 0);
        }
        if (!Number.isFinite(tomanPerUnit) || tomanPerUnit <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return null;
        }
        const decimals = String(w.currency).toUpperCase() === "USDT" ? 2 : 5;
        const factor = 10 ** decimals;
        const cryptoAmount = Math.ceil((finalPrice / tomanPerUnit) * factor) / factor;
        if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┌⌐╪▒█î┘╛╪¬┘ê ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return null;
        }
        try {
            await withClaimedDiscount(discountCode, () => insertOrderRecord({
                purchaseId,
                telegramId: userId,
                productId: Number(product.id),
                productNameSnapshot,
                sellMode,
                sourcePanelId: product.panel_id ? Number(product.panel_id) : null,
                panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
                panelConfigSnapshot,
                paymentMethod: "crypto",
                discountCode,
                discountAmount,
                finalPrice,
                tronAmount: 0,
                status: "pending",
                walletUsed,
                configName,
                cryptoWalletId: Number(w.id),
                cryptoCurrency: String(w.currency),
                cryptoNetwork: String(w.network),
                cryptoAddress: String(w.address || ""),
                cryptoAmount,
                cryptoExpiresAt: expiresAt.toISOString(),
                walletTransactionDescription: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${purchaseId})`
            }));
        }
        catch (error) {
            const code = getOrderInsertErrorCode(error);
            if (code === "discount_unavailable") {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»█î┌»╪▒ ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪½╪¿╪¬ ┌⌐┘å█î╪»." });
                return null;
            }
            if (code === "wallet_insufficient") {
                await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪¿╪▒╪º█î ╪½╪¿╪¬ ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
                return null;
            }
            logError("create_crypto_order_failed", error, { chatId, userId, productId, purchaseId, cryptoWalletId });
            await tg("sendMessage", { chat_id: chatId, text: "╪│╪º╪«╪¬ ╪│┘ü╪º╪▒╪┤ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪». ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
            return null;
        }
        const cryptoText = `╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
            `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
            `┘à╪¡╪╡┘ê┘ä: ${productNameSnapshot}\n` +
            `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n\n` +
            `ΓÅ░ ┘à┘ç┘ä╪¬ ┘╛╪▒╪»╪º╪«╪¬: 20 ╪»┘é█î┘é┘ç\n` +
            `≡ƒ¬Ö ╪º╪▒╪▓: ${String(w.currency)}\n` +
            `≡ƒîÉ ╪┤╪¿┌⌐┘ç: ${String(w.network)}\n` +
            `Γÿæ∩╕Å ┘à╪¿┘ä╪║ ┘╛╪▒╪»╪º╪«╪¬█î: ${cryptoAmount}\n\n` +
            `≡ƒô▒ ╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä:\n\n${String(w.address || "-")}\n\n` +
            `╪¿╪╣╪» ╪º╪▓ ┘╛╪▒╪»╪º╪«╪¬ ╪▒┘ê█î ┬½╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬┬╗ ╪¿╪▓┘å█î╪» ┘ê ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».`;
        await tg("sendMessage", {
            chat_id: chatId,
            text: cryptoText,
            reply_markup: {
                inline_keyboard: [
                    [cb("Γ£à ╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬", `check_order_${purchaseId}`, "success")],
                    [homeButton()]
                ]
            }
        });
        return purchaseId;
    }
    if (false && paymentMethod === "crypto") {
        if (!cryptoWalletId) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê ╪º┘å╪¬╪«╪º╪¿ ┘å╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        const walletRows = await sql `
      SELECT id, currency, network, address, rate_mode, rate_toman_per_unit, extra_toman_per_unit, active
      FROM crypto_wallets
      WHERE id = ${cryptoWalletId}
      LIMIT 1;
    `;
        if (!walletRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const w = walletRows[0];
        if (!cryptoWalletReady(w)) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê ╪¿┘çΓÇî╪»╪▒╪│╪¬█î ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç █î╪º ╪║█î╪▒┘ü╪╣╪º┘ä ╪º╪│╪¬." });
            return null;
        }
        const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
        let tomanPerUnit = 0;
        if (w.rate_mode === "auto") {
            const base = await getCryptoTomanPerUnitCached(String(w.currency || ""));
            tomanPerUnit = base + Number(w.extra_toman_per_unit || 0);
        }
        else {
            tomanPerUnit = Number(w.rate_toman_per_unit || 0) + Number(w.extra_toman_per_unit || 0);
        }
        if (!Number.isFinite(tomanPerUnit) || tomanPerUnit <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return null;
        }
        const decimals = String(w.currency).toUpperCase() === "USDT" ? 2 : 5;
        const factor = 10 ** decimals;
        const cryptoAmount = Math.ceil((finalPrice / tomanPerUnit) * factor) / factor;
        if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ┌⌐╪▒█î┘╛╪¬┘ê ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return null;
        }
        await sql `
      INSERT INTO orders
      (
        purchase_id, telegram_id, product_id, product_name_snapshot, sell_mode, source_panel_id, panel_delivery_mode, panel_config_snapshot,
        payment_method, discount_code, discount_amount, final_price, tron_amount, status, wallet_used,
        crypto_wallet_id, crypto_currency, crypto_network, crypto_address, crypto_amount, crypto_expires_at
      )
      VALUES
      (
        ${purchaseId}, ${userId}, ${product.id}, ${productNameSnapshot}, ${sellMode}, ${product.panel_id || null}, ${parseDeliveryMode(String(product.panel_delivery_mode || ""))},
        ${JSON.stringify(panelConfigSnapshot)}::jsonb,
        'crypto', ${discountCode}, ${discountAmount}, ${finalPrice}, 0, 'pending', ${walletUsed},
        ${w.id}, ${w.currency}, ${w.network}, ${String(w.address || "")}, ${cryptoAmount}, ${expiresAt.toISOString()}
      );
    `;
        const cryptoText = `╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
            `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
            `┘à╪¡╪╡┘ê┘ä: ${productNameSnapshot}\n` +
            `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n\n` +
            `ΓÅ░ ┘à┘ç┘ä╪¬ ┘╛╪▒╪»╪º╪«╪¬: 20 ╪»┘é█î┘é┘ç\n` +
            `≡ƒ¬Ö ╪º╪▒╪▓: ${String(w.currency)}\n` +
            `≡ƒîÉ ╪┤╪¿┌⌐┘ç: ${String(w.network)}\n` +
            `Γÿæ∩╕Å ┘à╪¿┘ä╪║ ┘╛╪▒╪»╪º╪«╪¬█î: ${cryptoAmount}\n\n` +
            `≡ƒô▒ ╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä:\n\n${String(w.address || "-")}\n\n` +
            `╪¿╪╣╪» ╪º╪▓ ┘╛╪▒╪»╪º╪«╪¬ ╪▒┘ê█î ┬½╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬┬╗ ╪¿╪▓┘å█î╪» ┘ê ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».`;
        await tg("sendMessage", {
            chat_id: chatId,
            text: cryptoText,
            reply_markup: {
                inline_keyboard: [
                    [cb("Γ£à ╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬", `check_order_${purchaseId}`, "success")],
                    [homeButton()]
                ]
            }
        });
        return null;
    }
    if (paymentMethod === "swapwallet") {
        const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        if (!callbackBase) {
            await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ╪¿╪▒╪º█î Callback ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            await notifyAdmins(`ΓÜá∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ Callback Base ┘å╪º┘é╪╡ ╪º╪│╪¬ (SwapWallet)\n╪│┘ü╪º╪▒╪┤: ${purchaseId}`, {
                inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
            });
            return null;
        }
        const apiKey = ((await getSetting("swapwallet_api_key")) || "").trim();
        const shopUsername = ((await getSetting("swapwallet_shop_username")) || "").trim();
        if (!apiKey || !shopUsername) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¬┘å╪╕█î┘à╪º╪¬ SwapWallet ┌⌐╪º┘à┘ä ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            await notifyAdmins(`ΓÜá∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ SwapWallet ┘å╪º┘é╪╡ ╪º╪│╪¬\n╪│┘ü╪º╪▒╪┤: ${purchaseId}\napiKey:${apiKey ? "ok" : "missing"}\nshop:${shopUsername ? "ok" : "missing"}`, {
                inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
            });
            return null;
        }
        try {
            const { createSwapwalletTemporaryWalletInvoice } = await import("./swapwallet.js");
            const invoice = await createSwapwalletTemporaryWalletInvoice({
                apiKey,
                shopUsername,
                amountToman: finalPrice,
                allowedToken: String(swapwalletToken || "USDT"),
                network: String(swapwalletNetwork || "TRON"),
                ttlSeconds: 20 * 60,
                orderId: purchaseId,
                webhookUrl: `${callbackBase}/api/swapwallet-callback`,
                description: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot}`,
                customData: JSON.stringify({ purchaseId })
            });
            const linksRaw = Array.isArray(invoice.rawResult?.links) ? invoice.rawResult.links : [];
            const links = linksRaw
                .map((l) => ({ name: String(l?.name || "").trim(), url: String(l?.url || "").trim() }))
                .filter((l) => l.url);
            const primaryUrl = (links[0]?.url || invoice.urls[0] || "").trim() || null;
            const invoiceId = String(invoice.invoiceId || "").trim();
            await withClaimedDiscount(discountCode, () => insertOrderRecord({
                purchaseId,
                telegramId: userId,
                productId: Number(product.id),
                productNameSnapshot,
                sellMode,
                sourcePanelId: product.panel_id ? Number(product.panel_id) : null,
                panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
                panelConfigSnapshot,
                paymentMethod: "swapwallet",
                discountCode,
                discountAmount,
                finalPrice,
                tronAmount: 0,
                status: "pending",
                walletUsed,
                configName,
                swapwalletInvoiceId: invoiceId,
                swapwalletPaymentUrl: primaryUrl,
                swapwalletStatus: "new",
                walletTransactionDescription: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${purchaseId})`
            }));
            const exp = invoice.expiredAt ? `\nΓÅ░ ┘à┘ç┘ä╪¬ ┘╛╪▒╪»╪º╪«╪¬: ${String(invoice.expiredAt)}` : "";
            await tg("sendMessage", {
                chat_id: chatId,
                text: `╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
                    `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
                    `┘à╪¡╪╡┘ê┘ä: ${productNameSnapshot}\n` +
                    `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n` +
                    `╪▒┘ê╪┤: SwapWallet (${String(swapwalletToken)} / ${String(swapwalletNetwork)})\n\n` +
                    `≡ƒô▒ ╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä:\n\n${invoice.walletAddress}\n` +
                    exp +
                    `\n\n╪¿╪╣╪» ╪º╪▓ ┘╛╪▒╪»╪º╪«╪¬╪î ╪▒┘ê█î ┬½╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬┬╗ ╪¿╪▓┘å█î╪».`,
                reply_markup: {
                    inline_keyboard: [
                        ...links.slice(0, 2).map((l) => [{ text: l.name ? `≡ƒÆ│ ${l.name}` : "≡ƒÆ│ ┘╛╪▒╪»╪º╪«╪¬", url: l.url }]),
                        [cb("Γ£à ╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬", `check_order_${purchaseId}`, "success")],
                        [homeButton()]
                    ]
                }
            });
            return purchaseId;
        }
        catch (error) {
            const code = getOrderInsertErrorCode(error);
            if (code === "discount_unavailable") {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»█î┌»╪▒ ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪½╪¿╪¬ ┌⌐┘å█î╪»." });
                return null;
            }
            if (code === "wallet_insufficient") {
                await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪¿╪▒╪º█î ╪½╪¿╪¬ ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
                return null;
            }
            logError("create_swapwallet_invoice_failed", error, { chatId, userId, productId, purchaseId });
            await notifyAdmins(`Γ¥î ╪«╪╖╪º ╪»╪▒ ╪│╪º╪«╪¬ ┘ü╪º┌⌐╪¬┘ê╪▒ SwapWallet\n╪│┘ü╪º╪▒╪┤: ${purchaseId}\n╪╣┘ä╪¬: ${error.message || String(error)}`, {
                inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
            });
            await tg("sendMessage", { chat_id: chatId, text: "╪│╪º╪«╪¬ ┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪». ┘ä╪╖┘ü╪º┘ï ┌⌐┘à█î ╪¿╪╣╪» ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪» █î╪º ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            return null;
        }
    }
    if (paymentMethod === "tetrapay") {
        const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        if (!callbackBase) {
            await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ╪¿╪▒╪º█î Callback ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            await notifyAdmins(`ΓÜá∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ Callback Base ┘å╪º┘é╪╡ ╪º╪│╪¬ (╪¬╪¬╪▒╪º┘╛█î)\n╪│┘ü╪º╪▒╪┤: ${purchaseId}`, {
                inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
            });
            return null;
        }
        const tetrapayApiKey = ((await getSetting("tetrapay_api_key")) || "").trim();
        if (!tetrapayApiKey) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» ╪¬╪¬╪▒╪º┘╛█î ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            await notifyAdmins(`ΓÜá∩╕Å ┌⌐┘ä█î╪» ╪¬╪¬╪▒╪º┘╛█î ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬\n╪│┘ü╪º╪▒╪┤: ${purchaseId}`, {
                inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
            });
            return null;
        }
        try {
            const { createTetrapayOrder } = await import("./tetrapay.js");
            const orderRes = await createTetrapayOrder({
                purchaseId,
                amountToman: finalPrice,
                description: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot}`,
                callbackUrl: `${callbackBase}/api/tetrapay-callback`,
                apiKey: tetrapayApiKey
            });
            if (!orderRes.ok) {
                await tg("sendMessage", { chat_id: chatId, text: `╪«╪╖╪º ╪»╪▒ ╪º╪▒╪¬╪¿╪º╪╖ ╪¿╪º ╪»╪▒┌»╪º┘ç ╪¬╪¬╪▒╪º┘╛█î: ${orderRes.message}` });
                return null;
            }
            await withClaimedDiscount(discountCode, () => insertOrderRecord({
                purchaseId,
                telegramId: userId,
                productId: Number(product.id),
                productNameSnapshot,
                sellMode,
                sourcePanelId: product.panel_id ? Number(product.panel_id) : null,
                panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
                panelConfigSnapshot,
                paymentMethod: "tetrapay",
                discountCode,
                discountAmount,
                finalPrice,
                tronAmount: 0,
                status: "pending",
                walletUsed,
                configName,
                tronadoToken: orderRes.authority,
                tronadoPaymentUrl: orderRes.paymentUrlBot,
                walletTransactionDescription: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${purchaseId})`
            }));
            await tg("sendMessage", {
                chat_id: chatId,
                text: `╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
                    `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
                    `┘à╪¡╪╡┘ê┘ä: ${productNameSnapshot}\n` +
                    `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n\n` +
                    `╪¿╪▒╪º█î ┘╛╪▒╪»╪º╪«╪¬ ╪▒┘ê█î ╪»┌⌐┘à┘ç ╪▓█î╪▒ ┌⌐┘ä█î┌⌐ ┌⌐┘å█î╪».`,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "≡ƒÆ│ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º ╪¬╪¬╪▒╪º┘╛█î", url: orderRes.paymentUrlBot }],
                        [homeButton()]
                    ]
                }
            });
            return purchaseId;
        }
        catch (error) {
            const code = getOrderInsertErrorCode(error);
            if (code === "discount_unavailable") {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»█î┌»╪▒ ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪½╪¿╪¬ ┌⌐┘å█î╪»." });
                return null;
            }
            if (code === "wallet_insufficient") {
                await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪¿╪▒╪º█î ╪½╪¿╪¬ ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
                return null;
            }
            logError("create_tetrapay_order_failed", error, { chatId, userId, productId });
            await tg("sendMessage", { chat_id: chatId, text: `╪│╪º╪«╪¬ ╪│┘ü╪º╪▒╪┤ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪»: ${String(error.message || error)}` });
        }
        return null;
    }
    if (paymentMethod === "plisio") {
        const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        if (!callbackBase) {
            await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ╪¿╪▒╪º█î Callback ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            await notifyAdmins(`ΓÜá∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ Callback Base ┘å╪º┘é╪╡ ╪º╪│╪¬ (Plisio)\n╪│┘ü╪º╪▒╪┤: ${purchaseId}`, {
                inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
            });
            return null;
        }
        const plisioApiKey = ((await getSetting("plisio_api_key")) || "").trim();
        if (!plisioApiKey) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¬┘å╪╕█î┘à╪º╪¬ Plisio ┌⌐╪º┘à┘ä ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            await notifyAdmins(`ΓÜá∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ Plisio ┘å╪º┘é╪╡ ╪º╪│╪¬\n╪│┘ü╪º╪▒╪┤: ${purchaseId}\n┌⌐┘ä█î╪»: ${plisioApiKey ? "ok" : "missing"}`, { inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]] });
            return null;
        }
        try {
            const tomanPerUsdt = await getPlisioTomanPerUsdt();
            const usdtAmount = Math.max(0.01, Number((finalPrice / tomanPerUsdt).toFixed(2)));
            const { createPlisioInvoice } = await import("./plisio.js");
            const invoice = await createPlisioInvoice({
                apiKey: plisioApiKey,
                orderNumber: purchaseId.slice(1),
                orderName: purchaseId,
                sourceCurrency: "USD",
                sourceAmount: usdtAmount,
                callbackUrl: `${callbackBase}/api/plisio-callback?json=true`
            });
            await withClaimedDiscount(discountCode, () => insertOrderRecord({
                purchaseId,
                telegramId: userId,
                productId: Number(product.id),
                productNameSnapshot,
                sellMode,
                sourcePanelId: product.panel_id ? Number(product.panel_id) : null,
                panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
                panelConfigSnapshot,
                paymentMethod: "plisio",
                discountCode,
                discountAmount,
                finalPrice,
                tronAmount: 0,
                status: "pending",
                walletUsed,
                plisioTxnId: invoice.txnId,
                plisioInvoiceUrl: invoice.invoiceUrl,
                plisioStatus: "new",
                walletTransactionDescription: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${purchaseId})`
            }));
            await tg("sendMessage", {
                chat_id: chatId,
                text: `╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
                    `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
                    `┘à╪¡╪╡┘ê┘ä: ${productNameSnapshot}\n` +
                    `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n` +
                    `┘à╪╣╪º╪»┘ä ╪¬┘é╪▒█î╪¿█î: ${usdtAmount} USDT\n\n` +
                    `╪¿╪╣╪» ╪º╪▓ ┘╛╪▒╪»╪º╪«╪¬╪î ╪▒┘ê█î ╪»┌⌐┘à┘ç ┬½╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬┬╗ ╪¿╪▓┘å█î╪».`,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "≡ƒÆ│ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º Plisio", url: invoice.invoiceUrl }],
                        [cb("Γ£à ╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬", `check_order_${purchaseId}`, "success")],
                        [homeButton()]
                    ]
                }
            });
            return purchaseId;
        }
        catch (error) {
            const code = getOrderInsertErrorCode(error);
            if (code === "discount_unavailable") {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»█î┌»╪▒ ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪½╪¿╪¬ ┌⌐┘å█î╪»." });
                return null;
            }
            if (code === "wallet_insufficient") {
                await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪¿╪▒╪º█î ╪½╪¿╪¬ ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
                return null;
            }
            logError("create_plisio_invoice_failed", error, { chatId, userId, productId, purchaseId });
            await notifyAdmins(`Γ¥î ╪«╪╖╪º ╪»╪▒ ╪│╪º╪«╪¬ ┘ü╪º┌⌐╪¬┘ê╪▒ Plisio\n╪│┘ü╪º╪▒╪┤: ${purchaseId}\n╪╣┘ä╪¬: ${error.message || String(error)}`, {
                inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
            });
            await tg("sendMessage", { chat_id: chatId, text: "╪│╪º╪«╪¬ ┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪». ┘ä╪╖┘ü╪º┘ï ┌⌐┘à█î ╪¿╪╣╪» ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪» █î╪º ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
        }
        return null;
    }
    try {
        const walletFromSetting = await getSetting("business_wallet_address");
        const walletAddress = walletFromSetting || env.BUSINESS_WALLET_ADDRESS;
        if (!walletAddress) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¬┘å╪╕█î┘à╪º╪¬ ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪º┘à┘ä ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            return null;
        }
        const tronadoApiKey = ((await getSetting("tronado_api_key")) || "").trim();
        const tronPriceCandidate = await getTronPriceToman(tronadoApiKey || undefined);
        const tronPrice = Number.isFinite(tronPriceCandidate) && tronPriceCandidate >= 1_000 && tronPriceCandidate <= 50_000_000
            ? tronPriceCandidate
            : await getCryptoTomanPerUnitCached("TRX");
        const feePercentRaw = (await getNumberSetting("tronado_fee_percent")) ?? 0.2;
        const feePercent = Math.max(0, Math.min(1, Number(feePercentRaw)));
        const minFeeToman = Math.max(0, Math.round((await getNumberSetting("tronado_min_fee_toman")) ?? 11000));
        const feeToman = feePercent > 0 ? Math.max(minFeeToman, Math.round(finalPrice * feePercent)) : 0;
        const extraTrx = Math.max(0, Number((await getNumberSetting("tronado_extra_trx")) ?? 0.3));
        const requiredToman = finalPrice + feeToman;
        const baseTrx = requiredToman / tronPrice;
        const scale = 1_000_000;
        const tronAmount = Math.ceil((baseTrx + extraTrx) * scale) / scale;
        const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        if (!callbackBase) {
            await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ╪¿╪▒╪º█î Callback ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
            await notifyAdmins(`ΓÜá∩╕Å ╪¬┘å╪╕█î┘à╪º╪¬ Callback Base ┘å╪º┘é╪╡ ╪º╪│╪¬ (Tronado)\n╪│┘ü╪º╪▒╪┤: ${purchaseId}`, {
                inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
            });
            return null;
        }
        const token = await getOrderToken({
            paymentId: purchaseId,
            walletAddress,
            tronAmount: Math.max(0.1, tronAmount),
            callbackUrl: `${callbackBase}/api/tronado-callback`,
            apiKey: tronadoApiKey || undefined
        });
        await withClaimedDiscount(discountCode, () => insertOrderRecord({
            purchaseId,
            telegramId: userId,
            productId: Number(product.id),
            productNameSnapshot,
            sellMode,
            sourcePanelId: product.panel_id ? Number(product.panel_id) : null,
            panelDeliveryMode: parseDeliveryMode(String(product.panel_delivery_mode || "")),
            panelConfigSnapshot,
            paymentMethod: "tronado",
            discountCode,
            discountAmount,
            finalPrice,
            tronAmount: Math.max(0.1, tronAmount),
            status: "pending",
            walletUsed,
            tronadoToken: token.token,
            tronadoPaymentUrl: token.paymentUrl,
            walletTransactionDescription: `╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä ${productNameSnapshot} (╪│┘ü╪º╪▒╪┤ ${purchaseId})`
        }));
        const feeLine = feeToman > 0 ? `┌⌐╪º╪▒┘à╪▓╪»: ${formatPriceToman(feeToman)} ╪¬┘ê┘à╪º┘å\n` : "";
        const payableLine = feeToman > 0 ? `┘à╪¿┘ä╪║ ┘å┘ç╪º█î█î: ${formatPriceToman(requiredToman)} ╪¬┘ê┘à╪º┘å\n` : "";
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪│┘ü╪º╪▒╪┤ ╪┤┘à╪º ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n` +
                `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
                `┘à╪¡╪╡┘ê┘ä: ${productNameSnapshot}\n` +
                `┘à╪¿┘ä╪║: ${formatPriceToman(finalPrice)} ╪¬┘ê┘à╪º┘å\n` +
                feeLine +
                payableLine +
                `┘à┘é╪»╪º╪▒ TRON: ${Math.max(0.1, tronAmount)}\n\n` +
                `╪¿╪╣╪» ╪º╪▓ ┘╛╪▒╪»╪º╪«╪¬╪î ╪▒┘ê█î ╪»┌⌐┘à┘ç ┬½╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬┬╗ ╪¿╪▓┘å█î╪».`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "≡ƒÆ│ ┘╛╪▒╪»╪º╪«╪¬", url: token.paymentUrl }],
                    [cb("Γ£à ╪¿╪▒╪▒╪│█î ┘╛╪▒╪»╪º╪«╪¬", `check_order_${purchaseId}`, "success")],
                    [homeButton()]
                ]
            }
        });
        return purchaseId;
    }
    catch (error) {
        const code = getOrderInsertErrorCode(error);
        if (code === "discount_unavailable") {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪»█î┌»╪▒ ┘é╪º╪¿┘ä ╪º╪│╪¬┘ü╪º╪»┘ç ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪½╪¿╪¬ ┌⌐┘å█î╪»." });
            return null;
        }
        if (code === "wallet_insufficient") {
            await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪¼┘ê╪»█î ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪¿╪▒╪º█î ╪½╪¿╪¬ ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┌⌐╪º┘ü█î ┘å█î╪│╪¬." });
            return null;
        }
        logError("create_order_failed", error, { chatId, userId, productId, paymentMethod });
        await tg("sendMessage", { chat_id: chatId, text: `╪│╪º╪«╪¬ ╪│┘ü╪º╪▒╪┤ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪»: ${String(error.message || error)}` });
    }
    return null;
}
const CONFIGS_PER_PAGE = 8;
async function showMyConfigs(chatId, userId, forTopupFlow, page = 0) {
    const countRows = await sql `
    SELECT COUNT(*) AS total
    FROM inventory i
    WHERE i.owner_telegram_id = ${userId} AND i.status = 'sold';
  `;
    const total = Number(countRows[0]?.total || 0);
    if (total === 0) {
        await tg("sendMessage", { chat_id: chatId, text: "╪┤┘à╪º ┘ç┘å┘ê╪▓ ┌⌐╪º┘å┘ü█î┌»█î ╪«╪▒█î╪»╪º╪▒█î ┘å┌⌐╪▒╪»┘çΓÇî╪º█î╪»." });
        return null;
    }
    const totalPages = Math.ceil(total / CONFIGS_PER_PAGE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const offset = safePage * CONFIGS_PER_PAGE;
    const rows = await sql `
    SELECT i.id, i.config_value, i.delivery_payload, i.panel_id, p.panel_config, p.name, p.size_mb, o.purchase_id
    FROM inventory i
    INNER JOIN products p ON p.id = i.product_id
    LEFT JOIN orders o ON o.id = i.sold_order_id
    WHERE i.owner_telegram_id = ${userId} AND i.status = 'sold'
    ORDER BY i.id DESC
    LIMIT ${CONFIGS_PER_PAGE} OFFSET ${offset};
  `;
    const panelIds = [...new Set(rows.map((r) => Number(r.panel_id || 0)).filter((n) => n > 0))];
    const panelById = new Map();
    for (const pid of panelIds) {
        const p = await getPanelById(pid);
        if (p)
            panelById.set(pid, p);
    }
    const keyboard = rows.map((row) => [
        {
            text: (() => {
                const payload = parseDeliveryPayload(row.delivery_payload);
                const revoked = payload.metadata?.revoked === true;
                // Use the actual config identifier (email for sanaei, username for marzban), falling back to product name
                const configName = String(payload.metadata?.label || payload.metadata?.email || payload.metadata?.username || row.name || "").trim();
                const sizeMb = Number(row.size_mb || 0);
                const sizeLabel = sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(0)}GB` : sizeMb > 0 ? `${sizeMb}MB` : "";
                return `≡ƒö╣ ${configName}${revoked ? " ≡ƒÜ½" : ""}${sizeLabel ? ` | ${sizeLabel}` : ""}`;
            })(),
            callback_data: `open_config_${row.id}${forTopupFlow ? "_t" : ""}`
        }
    ]);
    // Pagination navigation row
    if (totalPages > 1) {
        const navRow = [];
        const prevCb = forTopupFlow ? `topup_page_${safePage - 1}` : `my_configs_page_${safePage - 1}`;
        const nextCb = forTopupFlow ? `topup_page_${safePage + 1}` : `my_configs_page_${safePage + 1}`;
        if (safePage > 0)
            navRow.push({ text: "ΓùÇ∩╕Å ┘é╪¿┘ä█î", callback_data: prevCb });
        navRow.push({ text: `╪╡┘ü╪¡┘ç ${safePage + 1} ╪º╪▓ ${totalPages}`, callback_data: "noop" });
        if (safePage < totalPages - 1)
            navRow.push({ text: "╪¿╪╣╪»█î Γû╢∩╕Å", callback_data: nextCb });
        keyboard.push(navRow);
    }
    if (!forTopupFlow) {
        keyboard.push([cb("≡ƒº╛ ╪│┘ü╪º╪▒╪┤ΓÇî┘ç╪º█î ┘à┘å", "my_orders", "primary"), cb("≡ƒöÄ ┘╛█î┌»█î╪▒█î ╪│┘ü╪º╪▒╪┤", "order_lookup", "primary")]);
        keyboard.push([cb("Γ₧ò ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", "topup_menu", "primary"), cb("≡ƒô£ ╪»╪▒╪«┘ê╪º╪│╪¬ΓÇî┘ç╪º█î ╪º┘å╪¬┘é╪º┘ä", "my_migrations", "primary")]);
    }
    keyboard.push([homeButton()]);
    const pageLabel = totalPages > 1 ? ` (╪╡┘ü╪¡┘ç ${safePage + 1} ╪º╪▓ ${totalPages})` : "";
    await tg("sendMessage", {
        chat_id: chatId,
        text: forTopupFlow
            ? `┌⌐╪º┘å┘ü█î┌» ┘à┘ê╪▒╪»┘å╪╕╪▒ ╪¿╪▒╪º█î ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»${pageLabel}:`
            : `┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î ╪«╪▒█î╪»╪º╪▒█îΓÇî╪┤╪»┘ç ╪┤┘à╪º ≡ƒæç${pageLabel}\n╪¿╪▒╪º█î ╪»█î╪»┘å ╪¼╪▓╪ª█î╪º╪¬ ┘ê QR ╪▒┘ê█î ┘ç╪▒ ┌⌐╪º┘å┘ü█î┌» ╪¿╪▓┘å█î╪»:`,
        reply_markup: { inline_keyboard: keyboard }
    });
}
async function openMyConfig(chatId, userId, inventoryId, fromTopupFlow) {
    const rows = await sql `
    SELECT i.id, i.config_value, i.delivery_payload, i.panel_id, i.status, i.migrated_to_inventory_id,
           p.name, p.panel_config, o.purchase_id
    FROM inventory i
    INNER JOIN products p ON p.id = i.product_id
    LEFT JOIN orders o ON o.id = i.sold_order_id
    WHERE i.id = ${inventoryId} AND i.owner_telegram_id = ${userId} AND i.status IN ('sold', 'migrated')
    LIMIT 1;
  `;
    if (!rows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¿╪▒╪º█î ╪┤┘à╪º ┘å█î╪│╪¬ █î╪º █î╪º┘ü╪¬ ┘å╪┤╪»." });
        return null;
    }
    // If this config was migrated, transparently redirect to the new config
    if (String(rows[0].status) === 'migrated' && rows[0].migrated_to_inventory_id) {
        const newId = Number(rows[0].migrated_to_inventory_id);
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜí ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¿┘ç ┘╛┘å┘ä ╪¼╪»█î╪» ┘à┘å╪¬┘é┘ä ╪┤╪»┘ç. ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ╪┤┘à╪º:" });
        return openMyConfig(chatId, userId, newId, fromTopupFlow);
    }
    const row = rows[0];
    const delivery = parseDeliveryPayload(row.delivery_payload);
    let displayDelivery = delivery;
    const revoked = delivery.metadata?.revoked === true;
    const isPanelConfig = Boolean(delivery.metadata?.panelType) && String(delivery.metadata?.panelType || "") !== "manual";
    const panelId = Number(row.panel_id || 0);
    // Validate panel config link matches and collect live stats
    let liveStats = null;
    if (isPanelConfig && panelId > 0) {
        const panelRows = await sql `SELECT * FROM panels WHERE id = ${panelId} LIMIT 1;`;
        if (panelRows.length > 0) {
            const panel = panelRows[0];
            const panelType = String(delivery.metadata?.panelType || panel.panel_type);
            const identifier = String(delivery.metadata?.username || delivery.metadata?.uuid || delivery.metadata?.email || delivery.metadata?.subId || "").trim();
            const userSubLink = String(delivery.subscriptionUrl || "").trim();
            let panelSubLink = "";
            let foundOnPanel = false;
            let panelError = false;
            if (isMarzbanLike(panelType)) {
                const found = await lookupMarzbanUser(panel, identifier);
                if (found.ok && found.user) {
                    foundOnPanel = true;
                    const u = found.user;
                    panelSubLink = u.subscription_url ? resolveMarzbanSubUrl(String(panel.base_url), String(u.subscription_url)) : "";
                    const totalBytes = Number(u.data_limit || 0);
                    const usedBytes = Number(u.used_traffic || u.usedTraffic || u.used_bytes || 0);
                    const remainBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) : 0;
                    const statusLabel = String(u.status || "-");
                    liveStats =
                        `≡ƒô╢ ┘ê╪╢╪╣█î╪¬: ${statusLabel}\n` +
                            `≡ƒôè ╪¡╪¼┘à: ${totalBytes > 0 ? `${formatBytesShort(remainBytes)} ╪¿╪º┘é█îΓÇî┘à╪º┘å╪»┘ç ╪º╪▓ ${formatBytesShort(totalBytes)}` : "┘å╪º┘à╪¡╪»┘ê╪»"}\n` +
                            `≡ƒôà ╪º┘å┘é╪╢╪º: ${formatExpiryLabelFromSeconds(u.expire)}`;
                }
                else if (found.message !== "user_not_found") {
                    panelError = true;
                }
            }
            else if (panelType === "sanaei") {
                const found = await findSanaeiClientByIdentifier(panel, identifier);
                if (found.ok && found.client) {
                    foundOnPanel = true;
                    const c = found.client;
                    const subId = String(c.subId || "");
                    const panelConfig = typeof row.panel_config === "string" ? parseJsonObject(row.panel_config) : row.panel_config;
                    if (subId) {
                        panelSubLink = buildSanaeiSubscriptionUrl(String(panel.base_url), panelConfig || {}, subId, panel).trim();
                    }
                    const totalBytes = Number(c.totalGB || 0); // stored in bytes despite the field name
                    const usedBytes = Math.max(0, Number(c.up || 0) + Number(c.down || 0));
                    const remainBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedBytes) : 0;
                    const enabled = parseMaybeBoolean(c.enable) !== false;
                    liveStats =
                        `≡ƒô╢ ┘ê╪╢╪╣█î╪¬: ${enabled ? "┘ü╪╣╪º┘ä Γ£à" : "╪║█î╪▒┘ü╪╣╪º┘ä Γ¥î"}\n` +
                            `≡ƒôè ╪¡╪¼┘à: ${totalBytes > 0 ? `${formatBytesShort(remainBytes)} ╪¿╪º┘é█îΓÇî┘à╪º┘å╪»┘ç ╪º╪▓ ${formatBytesShort(totalBytes)}` : "┘å╪º┘à╪¡╪»┘ê╪»"}\n` +
                            `≡ƒôà ╪º┘å┘é╪╢╪º: ${formatExpiryLabelFromMilliseconds(c.expiryTime)}`;
                }
                else if (found.message !== "client_not_found") {
                    panelError = true;
                }
            }
            if (!panelError) {
                if (!identifier) {
                    // No usable identifier in metadata ΓÇö cannot validate panel-side, skip entirely.
                    // (Old orders created before metadata was stored would otherwise be wrongly deleted.)
                }
                else if (!foundOnPanel) {
                    // Config is genuinely gone from the panel ΓÇö remove from inventory.
                    await sql `
            WITH
            nullify_orders AS (
              UPDATE orders SET inventory_id = NULL WHERE inventory_id = ${row.id}
            ),
            deleted_forensics AS (
              DELETE FROM config_forensics WHERE inventory_id = ${row.id}
            ),
            deleted_topups AS (
              DELETE FROM topup_requests WHERE inventory_id = ${row.id}
            ),
            deleted_migrations AS (
              DELETE FROM panel_migrations WHERE source_inventory_id = ${row.id}
            )
            DELETE FROM inventory WHERE id = ${row.id};
          `;
                    await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ╪»╪▒ ┘╛┘å┘ä █î╪º┘ü╪¬ ┘å╪┤╪». ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪º╪▓ ┘ä█î╪│╪¬ ╪┤┘à╪º ╪¡╪░┘ü ╪┤╪»." });
                    return null;
                }
                else {
                    // Config IS on the panel. Check for URL drift (panel domain/host change).
                    // Do NOT delete ΓÇö update our stored link and continue showing the config.
                    const linkMismatch = panelType === "sanaei" && userSubLink && panelSubLink
                        ? !sanaeiSubscriptionUrlsMatchSubId(userSubLink, panelSubLink)
                        : Boolean(userSubLink && panelSubLink && userSubLink !== panelSubLink);
                    if (linkMismatch && panelSubLink && panelType !== "sanaei") {
                        // For Marzban: silently update the stored subscription URL to match panel.
                        // (Sanaei is rebuilt fully below via applyLiveSanaeiPanelOverridesToDeliveryPayload.)
                        const updatedDelivery = { ...delivery, subscriptionUrl: panelSubLink };
                        await sql `
              UPDATE inventory
              SET delivery_payload = ${JSON.stringify(updatedDelivery)}::jsonb
              WHERE id = ${row.id};
            `;
                    }
                    // Note: (!panelSubLink && userSubLink) is intentionally NOT a deletion trigger.
                    // Some panel configs have no sub link exposed (disabled subscription, missing subId
                    // in panel response, or host not configured). The config is still valid and live.
                }
                if (panelType === "sanaei" && foundOnPanel && panelSubLink) {
                    const panelConfig = typeof row.panel_config === "string" ? parseJsonObject(row.panel_config) : row.panel_config;
                    const { payload: live } = applyLiveSanaeiPanelOverridesToDeliveryPayload(delivery, panel, (panelConfig || {}));
                    let primaryText = delivery.primaryText;
                    if (delivery.subscriptionUrl && primaryText === delivery.subscriptionUrl) {
                        primaryText = String(live.subscriptionUrl || primaryText);
                    }
                    else if ((delivery.configLinks || [])[0] && primaryText === (delivery.configLinks || [])[0]) {
                        primaryText = String((live.configLinks || [])[0] || primaryText);
                    }
                    displayDelivery = {
                        ...live,
                        primaryText: primaryText || live.primaryText || delivery.primaryText
                    };
                    displayDelivery.primaryQr = buildQrText(displayDelivery.primaryText, displayDelivery.configLinks || [], displayDelivery.subscriptionUrl);
                }
            }
        }
    }
    const keyboard = [
        [{ text: "Γ₧ò ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", callback_data: `request_topup_${row.id}` }],
        [{ text: "≡ƒöü ╪º┘å╪¬┘é╪º┘ä ╪¿┘ç ┘╛┘å┘ä ╪¼╪»█î╪»", callback_data: `config_migrate_targets_${row.id}` }],
        [{ text: "≡ƒº╣ ╪¡╪░┘ü ╪º╪▓ ┘ä█î╪│╪¬ ┘à┘å", callback_data: `customer_remove_cfg_${row.id}` }],
        ...(isPanelConfig ? [[{ text: "≡ƒöä ╪¿╪º╪▓╪│╪º╪▓█î ┘ä█î┘å┌⌐", callback_data: `customer_revoke_cfg_${row.id}` }]] : []),
        [{ text: "≡ƒôª ╪¿╪º╪▓┌»╪┤╪¬ ╪¿┘ç ┘ä█î╪│╪¬ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º", callback_data: fromTopupFlow ? "topup_menu" : "my_configs" }],
        [homeButton()]
    ];
    if (revoked) {
        await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å ╪║█î╪▒┘ü╪╣╪º┘ä ╪┤╪»┘ç ╪º╪│╪¬." });
    }
    await sendDeliveryPackage(chatId, String(row.purchase_id || "-"), String(row.config_value), displayDelivery, keyboard, `┘à╪¡╪╡┘ê┘ä: ${row.name}${liveStats ? `\n\n${liveStats}` : ""}`);
}
async function notifyAdmins(text, replyMarkup) {
    const ids = await getAdminIds();
    for (const adminId of ids) {
        if (!adminId)
            continue; // skip placeholder/zero IDs
        try {
            await tg("sendMessage", { chat_id: adminId, text, reply_markup: replyMarkup });
        }
        catch (error) {
            const errMsg = String(error?.message || "");
            // These are not actionable errors ΓÇö skip silently
            if (errMsg.includes("bot was blocked by the user") ||
                errMsg.includes("chat not found") ||
                errMsg.includes("user is deactivated") ||
                errMsg.includes("PEER_ID_INVALID")) {
                continue;
            }
            logError("notify_admin_generic_failed", error, { adminId });
            continue;
        }
    }
}
async function getTelegramProfileText(userId) {
    const rows = await sql `
    SELECT username, first_name, last_name
    FROM users
    WHERE telegram_id = ${userId}
    LIMIT 1;
  `;
    const username = rows.length && rows[0].username ? `@${String(rows[0].username)}` : "-";
    const fullName = [rows[0]?.first_name ? String(rows[0].first_name) : "", rows[0]?.last_name ? String(rows[0].last_name) : ""].filter(Boolean).join(" ").trim() || "-";
    return { username, fullName };
}
async function sendPurchaseLookupResult(chatId, purchaseId) {
    const orderRows = await sql `
    SELECT
      o.purchase_id,
      o.telegram_id,
      o.product_id,
      o.status,
      o.final_price,
      o.wallet_used,
      o.payment_method,
      o.created_at,
      COALESCE(o.product_name_snapshot, p.name) AS product_name,
      u.username,
      u.first_name,
      u.last_name
    FROM orders o
    LEFT JOIN products p ON p.id = o.product_id
    LEFT JOIN users u ON u.telegram_id = o.telegram_id
    WHERE o.purchase_id = ${purchaseId}
    LIMIT 1;
  `;
    if (orderRows.length) {
        const row = orderRows[0];
        const username = row.username ? `@${String(row.username)}` : "-";
        const fullName = [row.first_name ? String(row.first_name) : "", row.last_name ? String(row.last_name) : ""].filter(Boolean).join(" ").trim() || "-";
        const actualWalletUsed = Number(row.wallet_used || 0);
        const walletUsedText = actualWalletUsed > 0 ? `\n┌⌐╪│╪▒ ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä: ${formatPriceToman(actualWalletUsed)} ╪¬┘ê┘à╪º┘å` : "";
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¼╪▓╪ª█î╪º╪¬ ╪│┘ü╪º╪▒╪┤:\n` +
                `╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤: ${row.purchase_id}\n` +
                `┘å┘ê╪╣: ╪«╪▒█î╪» ┘à╪¡╪╡┘ê┘ä\n` +
                `┌⌐╪º╪▒╪¿╪▒: ${row.telegram_id}\n` +
                `█î┘ê╪▓╪▒┘å█î┘à: ${username}\n` +
                `┘å╪º┘à: ${fullName}\n` +
                `┘à╪¡╪╡┘ê┘ä: ${row.product_name || row.product_id}\n` +
                `┘à╪¿┘ä╪║ ┘╛╪▒╪»╪º╪«╪¬█î: ${formatPriceToman(Number(row.final_price))} ╪¬┘ê┘à╪º┘å` + walletUsedText + `\n` +
                `╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬: ${row.payment_method}\n` +
                `┘ê╪╢╪╣█î╪¬: ${row.status}\n` +
                `╪▓┘à╪º┘å: ${row.created_at}`
        });
        return true;
    }
    const topupRows = await sql `
    SELECT
      t.purchase_id,
      t.telegram_id,
      t.inventory_id,
      t.requested_mb,
      t.status,
      t.final_price,
      t.payment_method,
      t.created_at,
      u.username,
      u.first_name,
      u.last_name
    FROM topup_requests t
    LEFT JOIN users u ON u.telegram_id = t.telegram_id
    WHERE t.purchase_id = ${purchaseId}
    LIMIT 1;
  `;
    if (!topupRows.length) {
        await tg("sendMessage", { chat_id: chatId, text: "╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ┘╛█î╪»╪º ┘å╪┤╪»." });
        return false;
    }
    const row = topupRows[0];
    const username = row.username ? `@${String(row.username)}` : "-";
    const fullName = [row.first_name ? String(row.first_name) : "", row.last_name ? String(row.last_name) : ""].filter(Boolean).join(" ").trim() || "-";
    await tg("sendMessage", {
        chat_id: chatId,
        text: `╪¼╪▓╪ª█î╪º╪¬ ╪│┘ü╪º╪▒╪┤:\n` +
            `╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤: ${row.purchase_id}\n` +
            `┘å┘ê╪╣: ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º\n` +
            `┌⌐╪º╪▒╪¿╪▒: ${row.telegram_id}\n` +
            `█î┘ê╪▓╪▒┘å█î┘à: ${username}\n` +
            `┘å╪º┘à: ${fullName}\n` +
            `┌⌐╪º┘å┘ü█î┌»: ${row.inventory_id}\n` +
            `╪¡╪¼┘à ╪»╪▒╪«┘ê╪º╪│╪¬█î: ${row.requested_mb}MB\n` +
            `┘à╪¿┘ä╪║: ${formatPriceToman(Number(row.final_price))} ╪¬┘ê┘à╪º┘å\n` +
            `╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬: ${row.payment_method}\n` +
            `┘ê╪╢╪╣█î╪¬: ${row.status}\n` +
            `╪▓┘à╪º┘å: ${row.created_at}`
    });
    return true;
}
const rateLimitMap = new Map();
async function isRateLimited(userId, key, windowMs) {
    const mapKey = `rl_${key}_${userId}`;
    const now = Date.now();
    const last = rateLimitMap.get(mapKey) || 0;
    if (now - last < windowMs)
        return true;
    rateLimitMap.set(mapKey, now);
    // Clean up old entries occasionally to prevent memory leak
    if (rateLimitMap.size > 1000) {
        const cutoff = now - Math.max(windowMs, 60000);
        for (const [k, v] of rateLimitMap.entries()) {
            if (v < cutoff)
                rateLimitMap.delete(k);
        }
    }
    return false;
}
export async function fulfillOrderByPaymentId(paymentId) {
    await ensureSchema();
    const topupRows = await sql `
    SELECT id, telegram_id, amount, status, payment_method
    FROM wallet_topups
    WHERE receipt_file_id = ${paymentId}
    LIMIT 1;
  `;
    if (topupRows.length) {
        const topup = topupRows[0];
        if (topup.status === 'paid')
            return { ok: false, reason: "already_paid" };
        await sql `
      UPDATE wallet_topups
      SET status = 'paid', done_at = NOW()
      WHERE id = ${topup.id};
    `;
        await sql `
      UPDATE users
      SET wallet_balance = wallet_balance + ${topup.amount}
      WHERE telegram_id = ${topup.telegram_id};
    `;
        const paymentMethod = String(topup.payment_method || "");
        const paymentLabel = paymentMethod === "tronado"
            ? "Tronado"
            : paymentMethod === "tetrapay"
                ? "╪¬╪¬╪▒╪º┘╛█î"
                : paymentMethod === "plisio"
                    ? "Plisio"
                    : paymentMethod === "swapwallet"
                        ? "SwapWallet"
                        : paymentMethod === "crypto"
                            ? "┌⌐╪▒█î┘╛╪¬┘ê"
                            : paymentMethod || "-";
        await sql `
      INSERT INTO wallet_transactions (telegram_id, amount, type, description)
      VALUES (${topup.telegram_id}, ${topup.amount}, 'charge', ${`╪┤╪º╪▒┌ÿ ╪º╪▓ ╪╖╪▒█î┘é ${paymentLabel}`});
    `;
        try {
            await tg("sendMessage", {
                chat_id: Number(topup.telegram_id),
                text: `Γ£à ┘╛╪▒╪»╪º╪«╪¬ ╪┤┘à╪º ╪¿╪º ┘à┘ê┘ü┘é█î╪¬ ╪º┘å╪¼╪º┘à ╪┤╪» ┘ê ┘à╪¿┘ä╪║ ${formatPriceToman(Number(topup.amount))} ╪¬┘ê┘à╪º┘å ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪º╪╢╪º┘ü┘ç ╪┤╪».`
            });
            for (const adminId of await getAdminIds()) {
                await tg("sendMessage", {
                    chat_id: adminId,
                    text: `≡ƒÆ░ ┌⌐╪º╪▒╪¿╪▒ ${topup.telegram_id} ┘à╪¿┘ä╪║ ${formatPriceToman(Number(topup.amount))} ╪¬┘ê┘à╪º┘å ╪º╪▓ ╪╖╪▒█î┘é ${paymentLabel} ┌⌐█î┘ü ┘╛┘ê┘ä ╪«┘ê╪» ╪▒╪º ╪┤╪º╪▒┌ÿ ┌⌐╪▒╪».`
                }).catch(() => { });
            }
        }
        catch (e) {
            logError("notify_wallet_charge_success_failed", e, { topupId: topup.id });
        }
        return { ok: true, reason: "wallet_charged" };
    }
    const rows = await sql `
    SELECT id, purchase_id, telegram_id, product_id, status
    FROM orders
    WHERE purchase_id = ${paymentId}
    LIMIT 1;
  `;
    if (!rows.length) {
        return { ok: false, reason: "order_not_found" };
    }
    return await finalizeOrder(Number(rows[0].id), null);
}
async function finalizeOrder(orderId, decidedBy) {
    const locked = await sql `
    UPDATE orders
    SET status = 'fulfilling'
    WHERE id = ${orderId}
      AND status IN ('pending', 'receipt_submitted', 'awaiting_receipt')
    RETURNING id;
  `;
    if (!locked.length) {
        const s = await sql `SELECT status FROM orders WHERE id = ${orderId} LIMIT 1;`;
        const status = s.length ? String(s[0].status) : "";
        if (status === "paid")
            return { ok: true, reason: "already_paid" };
        if (status === "fulfilling")
            return { ok: true, reason: "already_processing" };
        if (status === "denied")
            return { ok: false, reason: "denied" };
        return { ok: false, reason: "order_not_found" };
    }
    const rows = await sql `
    SELECT
      o.id,
      o.purchase_id,
      o.telegram_id,
      o.product_id,
      o.status,
      o.sell_mode,
      o.source_panel_id,
      o.panel_delivery_mode,
      o.panel_config_snapshot,
      o.wallet_used,
      o.final_price,
      o.payment_method,
      o.config_name,
      o.quantity,
      COALESCE(o.product_name_snapshot, p.name) AS product_name,
      p.size_mb,
      p.is_infinite
    FROM orders o
    INNER JOIN products p ON p.id = o.product_id
    WHERE o.id = ${orderId}
    LIMIT 1;
  `;
    if (!rows.length)
        return { ok: false, reason: "order_not_found" };
    const order = rows[0];
    const profile = await getTelegramProfileText(Number(order.telegram_id));
    if (parseSellMode(String(order.sell_mode || "")) === "panel") {
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password, active, allow_new_sales, subscription_public_port, subscription_public_host, subscription_link_protocol, config_public_host
      FROM panels
      WHERE id = ${order.source_panel_id}
      LIMIT 1;
    `;
        if (!panelRows.length || !panelRows[0].active || !panelRows[0].allow_new_sales) {
            await sql `UPDATE orders SET status = 'receipt_submitted' WHERE id = ${order.id} AND status = 'fulfilling';`;
            return { ok: false, reason: "panel_unavailable" };
        }
        const panel = panelRows[0];
        const panelConfig = sanitizePanelConfig(order.panel_config_snapshot);
        // Check if this is a bulk order
        const bulkQuantity = getOrderBulkQuantity(order, panelConfig);
        const bulkConfigNames = Array.isArray(panelConfig.bulk_config_names) ? panelConfig.bulk_config_names : [];
        // For bulk orders, create multiple configs
        const allProvisions = [];
        for (let i = 0; i < bulkQuantity; i++) {
            const configName = bulkConfigNames[i] || String(order.config_name || "").trim() || null;
            const orderWithName = { ...order, config_name: configName };
            let provision;
            try {
                provision =
                    isMarzbanLike(String(panel.panel_type))
                        ? await provisionMarzbanSale(panel, orderWithName, panelConfig)
                        : await provisionSanaeiSale(panel, orderWithName, panelConfig);
                allProvisions.push(provision);
            }
            catch (err) {
                logError("provision_failed", err, { orderId, configIndex: i });
                // Mark order as awaiting_config (payment was accepted, config creation failed)
                await sql `
          UPDATE orders
          SET status = 'awaiting_config', paid_at = NOW(), admin_decision_by = ${decidedBy}
          WHERE id = ${order.id} AND status = 'fulfilling';
        `;
                // Give the user two choices: retry config creation or get a wallet refund
                await tg("sendMessage", {
                    chat_id: Number(order.telegram_id),
                    text: `Γ£à ┘╛╪▒╪»╪º╪«╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪»\n` +
                        `ΓÜá∩╕Å ┘à╪¬╪º╪│┘ü╪º┘å┘ç ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪¿╪▒╪º█î ╪│┘ü╪º╪▒╪┤ <b>${escapeHtml(String(order.purchase_id))}</b> ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪».\n` +
                        `${allProvisions.length > 0 ? `${allProvisions.length} ┌⌐╪º┘å┘ü█î┌» ╪º╪▓ ${bulkQuantity} ╪│╪º╪«╪¬┘ç ╪┤╪».\n` : ""}` +
                        `\n┘ä╪╖┘ü╪º┘ï █î┌⌐█î ╪º╪▓ ┌»╪▓█î┘å┘çΓÇî┘ç╪º█î ╪▓█î╪▒ ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "≡ƒöä ╪¬┘ä╪º╪┤ ┘à╪¼╪»╪» ╪¿╪▒╪º█î ╪»╪▒█î╪º┘ü╪¬ ┌⌐╪º┘å┘ü█î┌»", callback_data: `retry_config_${order.id}` }],
                            [{ text: "≡ƒÆ░ ╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä", callback_data: `refund_to_wallet_${order.id}` }]
                        ]
                    }
                }).catch(() => { });
                await notifyAdmins(`Γ¥î ╪«╪╖╪º█î ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪▒┘ê█î ┘╛┘å┘ä ╪¿╪▒╪º█î ╪│┘ü╪º╪▒╪┤ ${order.purchase_id}:\n${err.message || "Unknown error"}\n╪¬╪╣╪»╪º╪» ┌⌐┘ä: ${bulkQuantity}\n╪│╪º╪«╪¬┘ç ╪┤╪»┘ç: ${allProvisions.length}\n` +
                    `┌⌐╪º╪▒╪¿╪▒ ${order.telegram_id} ┌»╪▓█î┘å┘çΓÇî┘ç╪º█î ╪¬┘ä╪º╪┤ ┘à╪¼╪»╪» / ╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç ╪▒╪º ╪»╪▒█î╪º┘ü╪¬ ┌⌐╪▒╪».`, {
                    inline_keyboard: [
                        [{ text: "╪º╪▒╪│╪º┘ä ┌⌐╪º┘å┘ü█î┌» ╪»╪│╪¬█î", callback_data: `admin_provide_config_${order.id}` }],
                        [{ text: "≡ƒöÄ ╪¿╪▒╪▒╪│█î ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${String(order.purchase_id)}` }]
                    ]
                });
                return { ok: false, reason: "provision_failed" };
            }
        }
        // All provisions successful - save to inventory
        const allConfigLinks = [];
        const allSubscriptionUrls = [];
        let firstInventoryId = null;
        for (const provision of allProvisions) {
            const delivered = parseDeliveryPayload(provision.deliveryPayload);
            const panelUserKey = String(delivered.metadata?.username || delivered.metadata?.email || delivered.metadata?.subId || delivered.metadata?.uuid || "").trim() || null;
            const inserted = await sql `
        INSERT INTO inventory (
          product_id, panel_user_key, config_value, delivery_payload, status, owner_telegram_id, sold_order_id, panel_id, sold_at
        )
        VALUES (
          ${order.product_id},
          ${panelUserKey},
          ${provision.configValue},
          ${serializeDeliveryPayload(provision.deliveryPayload)}::jsonb,
          'sold',
          ${order.telegram_id},
          ${order.id},
          ${order.source_panel_id},
          NOW()
        )
        RETURNING id;
      `;
            if (!firstInventoryId)
                firstInventoryId = Number(inserted[0].id);
            await recordInventoryForensicEvent(Number(inserted[0].id), "sale_delivered", {
                purchaseId: String(order.purchase_id),
                by: decidedBy
            });
            if (provision.deliveryPayload.configLinks) {
                allConfigLinks.push(...provision.deliveryPayload.configLinks);
            }
            if (provision.deliveryPayload.subscriptionUrl) {
                allSubscriptionUrls.push(provision.deliveryPayload.subscriptionUrl);
            }
        }
        // Guard: only flip to 'paid' if the order is still locked as 'fulfilling'.
        // Without this guard a background finalizeOrder could overwrite a 'cancelled' status
        // that was set when the user requested a refund after a timeout.
        const paidUpdate = await sql `
      UPDATE orders
      SET status = 'paid', paid_at = NOW(), inventory_id = ${firstInventoryId}, admin_decision_by = ${decidedBy}
      WHERE id = ${order.id} AND status = 'fulfilling'
      RETURNING id;
    `;
        if (!paidUpdate.length) {
            // Order was cancelled/refunded while provisioning ran in the background.
            // Undo the inventory rows we just inserted and best-effort revoke from panel.
            await sql `DELETE FROM inventory WHERE sold_order_id = ${order.id};`;
            if (parseSellMode(String(order.sell_mode || "")) === "panel" && order.source_panel_id) {
                const cleanPanelRows = await sql `
          SELECT id, panel_type, base_url, username, password, active
          FROM panels WHERE id = ${order.source_panel_id} LIMIT 1;
        `;
                if (cleanPanelRows.length) {
                    const cleanPanel = cleanPanelRows[0];
                    for (const provision of allProvisions) {
                        const delivered = parseDeliveryPayload(provision.deliveryPayload);
                        const key = String(delivered.metadata?.username || delivered.metadata?.email || delivered.metadata?.subId || "").trim();
                        if (key) {
                            if (isMarzbanLike(String(cleanPanel.panel_type))) {
                                deleteMarzbanUser(cleanPanel, key).catch(() => { });
                            }
                            else if (String(cleanPanel.panel_type) === "sanaei") {
                                revokeSanaeiClient(cleanPanel, key).catch(() => { });
                            }
                        }
                    }
                }
            }
            else if (parseSellMode(String(order.sell_mode || "")) === "pingchi") {
                for (const provision of allProvisions) {
                    const delivered = parseDeliveryPayload(provision.deliveryPayload);
                    const key = String(delivered.metadata?.username || delivered.metadata?.email || delivered.metadata?.subId || "").trim();
                    if (key) {
                        pingchiApi("services.delete", { username: key }).catch(() => { });
                    }
                }
            }
            await notifyAdmins(`ΓÜá∩╕Å ╪│┘ü╪º╪▒╪┤ ${order.purchase_id}: ┘╛╪▒┘ê┘ê█î┌ÿ┘å ╪¬┌⌐┘à█î┘ä ╪┤╪» ╪º┘à╪º ╪│┘ü╪º╪▒╪┤ ┘é╪¿┘ä╪º┘ï ┘ä╪║┘ê/╪º╪│╪¬╪▒╪»╪º╪» ╪┤╪»┘ç ╪¿┘ê╪».\n` +
                `┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î ╪│╪º╪«╪¬┘çΓÇî╪┤╪»┘ç ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ╪┤╪»┘å╪».\n┌⌐╪º╪▒╪¿╪▒: ${order.telegram_id}`).catch(() => { });
            return { ok: false, reason: "order_cancelled_during_provision" };
        }
        await tg("sendMessage", {
            chat_id: Number(order.telegram_id),
            text: `┘╛╪▒╪»╪º╪«╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪» Γ£à${bulkQuantity > 1 ? `\n${bulkQuantity} ┌⌐╪º┘å┘ü█î┌» ╪│╪º╪«╪¬┘ç ╪┤╪».` : ""}`
        }).catch(() => { });
        // Deliver each config separately when every provision has its own subscription URL
        // (Sanaei / Marzban bulk: each user gets a distinct sub link)
        if (allSubscriptionUrls.length > 1) {
            for (let i = 0; i < allProvisions.length; i++) {
                const prov = allProvisions[i];
                const isLast = i === allProvisions.length - 1;
                const provLinks = prov.deliveryPayload.configLinks || [];
                const provSub = prov.deliveryPayload.subscriptionUrl || null;
                const singleDelivery = {
                    configLinks: provLinks,
                    subscriptionUrl: provSub,
                    primaryQr: buildQrText(provLinks[0] || null, provLinks, provSub),
                    primaryText: provLinks[0] || provSub || "",
                    metadata: prov.deliveryPayload.metadata
                };
                await sendDeliveryPackage(Number(order.telegram_id), String(order.purchase_id), String(provLinks[0] || provSub || ""), singleDelivery, isLast
                    ? [[{ text: "Γ₧ò ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", callback_data: "topup_menu" }], [homeButton()]]
                    : []).catch((e) => logError("delivery_package_failed", e, { orderId: order.id, configIndex: i }));
            }
        }
        else {
            // Single sub URL or no subs: send one combined message
            const combinedDelivery = {
                configLinks: allConfigLinks,
                subscriptionUrl: allSubscriptionUrls[0] || null,
                primaryQr: buildQrText(allConfigLinks[0] || null, allConfigLinks, allSubscriptionUrls[0] || null),
                primaryText: allConfigLinks[0] || allSubscriptionUrls[0] || "",
                metadata: {
                    bulkCount: bulkQuantity
                }
            };
            await sendDeliveryPackage(Number(order.telegram_id), String(order.purchase_id), String(allConfigLinks[0] || allSubscriptionUrls[0] || ""), combinedDelivery, [[{ text: "Γ₧ò ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", callback_data: "topup_menu" }], [homeButton()]]).catch((e) => logError("delivery_package_failed", e, { orderId: order.id }));
        }
        // Admin notification ΓÇö build a combined summary with ALL sub URLs
        const adminDelivery = {
            configLinks: allConfigLinks,
            subscriptionUrl: allSubscriptionUrls[0] || null,
            primaryText: allConfigLinks[0] || allSubscriptionUrls[0] || "",
            metadata: {
                bulkCount: bulkQuantity,
                allSubscriptionUrls: allSubscriptionUrls.length > 1 ? allSubscriptionUrls : undefined
            }
        };
        await notifyAdmins(buildAdminDeliverySummary({
            purchaseId: String(order.purchase_id),
            userId: Number(order.telegram_id),
            telegramUsername: profile.username,
            telegramFullName: profile.fullName,
            productName: String(order.product_name || "-") + (bulkQuantity > 1 ? ` (x${bulkQuantity})` : ""),
            deliveryPayload: adminDelivery,
            walletUsed: Number(order.wallet_used || 0)
        }), { inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${String(order.purchase_id)}` }]] });
        return { ok: true, reason: "fulfilled" };
    }
    else if (parseSellMode(String(order.sell_mode || "")) === "pingchi") {
        const panelConfig = sanitizePanelConfig(order.panel_config_snapshot);
        const bulkQuantity = getOrderBulkQuantity(order, panelConfig);
        const allProvisions = [];
        for (let i = 0; i < bulkQuantity; i++) {
            let provision;
            try {
                provision = await provisionPingchiSale({ purchase_id: String(order.purchase_id), product_name_snapshot: String(order.product_name) }, panelConfig);
                allProvisions.push(provision);
            }
            catch (err) {
                logError("pingchi_provision_failed", err, { orderId: order.id, configIndex: i });
                await sql `
          UPDATE orders
          SET status = 'awaiting_config', paid_at = NOW(), admin_decision_by = ${decidedBy}
          WHERE id = ${order.id} AND status = 'fulfilling';
        `;
                await tg("sendMessage", {
                    chat_id: Number(order.telegram_id),
                    text: `Γ£à ┘╛╪▒╪»╪º╪«╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪».\n╪º┘à╪º ┘à╪┤┌⌐┘ä█î ╪»╪▒ ╪º╪▒╪¬╪¿╪º╪╖ ╪¿╪º ╪│╪▒┘ê╪▒ ╪▒╪« ╪»╪º╪». ╪¿┘ç ╪º╪»┘à█î┘å ┘╛█î╪º┘à ╪»╪º╪»█î┘à ╪¬╪º ╪│╪▒█î╪╣╪º ╪¿╪▒╪▒╪│█î ┌⌐┘å╪».`
                }).catch(() => { });
                const adminIds = await getAdminIds();
                if (adminIds.length > 0) {
                    await tg("sendMessage", {
                        chat_id: adminIds[0],
                        text: `Γ¥î ╪«╪╖╪º█î ┘╛█î┘å┌»┌å█î (╪│┘ü╪º╪▒╪┤ ${order.purchase_id})\n${err.message || ""}`
                    }).catch(() => { });
                }
                return { ok: false, reason: "provision_failed" };
            }
        }
        // Save to inventory
        const allConfigLinks = [];
        const allSubscriptionUrls = [];
        let firstInventoryId = null;
        for (const provision of allProvisions) {
            const delivered = parseDeliveryPayload(provision.deliveryPayload);
            const panelUserKey = String(delivered.metadata?.username || delivered.metadata?.email || delivered.metadata?.subId || delivered.metadata?.uuid || "").trim() || null;
            const inserted = await sql `
        INSERT INTO inventory (
          product_id, panel_user_key, config_value, delivery_payload, status, owner_telegram_id, sold_order_id, panel_id, sold_at
        )
        VALUES (
          ${order.product_id},
          ${panelUserKey},
          ${provision.configValue},
          ${serializeDeliveryPayload(provision.deliveryPayload)}::jsonb,
          'sold',
          ${order.telegram_id},
          ${order.id},
          ${order.source_panel_id},
          NOW()
        )
        RETURNING id;
      `;
            if (!firstInventoryId)
                firstInventoryId = Number(inserted[0].id);
            await recordInventoryForensicEvent(Number(inserted[0].id), "sale_delivered", {
                purchaseId: String(order.purchase_id),
                by: decidedBy
            });
            if (provision.deliveryPayload.configLinks) {
                allConfigLinks.push(...provision.deliveryPayload.configLinks);
            }
            if (provision.deliveryPayload.subscriptionUrl) {
                allSubscriptionUrls.push(provision.deliveryPayload.subscriptionUrl);
            }
        }
        const updateResult = await sql `
      UPDATE orders
      SET status = 'paid', paid_at = NOW(), inventory_id = ${firstInventoryId}, admin_decision_by = ${decidedBy}
      WHERE id = ${order.id} AND status = 'fulfilling'
      RETURNING id, purchase_id;
    `;
        if (!updateResult.length) {
            // Order cancelled during provision
            for (const p of allProvisions) {
                const delivered = parseDeliveryPayload(p.deliveryPayload);
                const key = String(delivered.metadata?.username || delivered.metadata?.email || delivered.metadata?.subId || "").trim();
                if (key) {
                    pingchiApi("services.delete", { username: key }).catch(() => { });
                }
            }
            await notifyAdmins(`ΓÜá∩╕Å ╪│┘ü╪º╪▒╪┤ ${order.purchase_id} ┘ä╪║┘ê ╪┤╪» ┘ê ┘╛█î┘å┌»┌å█î ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ╪┤╪».`).catch(() => { });
            return { ok: false, reason: "order_cancelled_during_provision" };
        }
        await tg("sendMessage", {
            chat_id: Number(order.telegram_id),
            text: `┘╛╪▒╪»╪º╪«╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪» Γ£à${bulkQuantity > 1 ? `\n${bulkQuantity} ┌⌐╪º┘å┘ü█î┌» ╪│╪º╪«╪¬┘ç ╪┤╪».` : ""}`
        }).catch(() => { });
        for (let i = 0; i < allProvisions.length; i++) {
            const prov = allProvisions[i];
            const isLast = i === allProvisions.length - 1;
            const provLinks = prov.deliveryPayload.configLinks || [];
            const provSub = prov.deliveryPayload.subscriptionUrl || null;
            const singleDelivery = {
                configLinks: provLinks,
                subscriptionUrl: provSub,
                primaryQr: buildQrText(provLinks[0] || null, provLinks, provSub),
                primaryText: provLinks[0] || provSub || "",
                metadata: prov.deliveryPayload.metadata
            };
            await sendDeliveryPackage(Number(order.telegram_id), String(order.purchase_id), String(provLinks[0] || provSub || ""), singleDelivery, isLast ? [[{ text: "Γ₧ò ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", callback_data: "topup_menu" }], [homeButton()]] : []).catch((e) => logError("delivery_package_failed", e, { orderId: order.id, configIndex: i }));
        }
        const profile = await getTelegramProfileText(Number(order.telegram_id));
        const adminDelivery = {
            configLinks: allConfigLinks,
            subscriptionUrl: allSubscriptionUrls[0] || null,
            primaryText: allConfigLinks[0] || allSubscriptionUrls[0] || "",
            metadata: { bulkCount: bulkQuantity }
        };
        await notifyAdmins(buildAdminDeliverySummary({
            purchaseId: String(order.purchase_id),
            userId: Number(order.telegram_id),
            telegramUsername: profile.username,
            telegramFullName: profile.fullName,
            productName: String(order.product_name || "-") + (bulkQuantity > 1 ? ` (x${bulkQuantity})` : ""),
            deliveryPayload: adminDelivery,
            walletUsed: Number(order.wallet_used || 0)
        }), { inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪▒╪▒╪│█î", callback_data: `admin_open_purchase_${String(order.purchase_id)}` }]] });
        return { ok: true, reason: "fulfilled" };
    }
    const globalInfinite = await getBoolSetting("global_infinite_mode", false);
    const panelConfig = sanitizePanelConfig(order.panel_config_snapshot);
    const bulkQty = getOrderBulkQuantity(order, panelConfig);
    // Allocate N inventory items for bulk orders
    const allocatedItems = [];
    for (let i = 0; i < bulkQty; i++) {
        const allocated = await sql `
      UPDATE inventory
      SET status = 'sold', owner_telegram_id = ${order.telegram_id}, sold_order_id = ${order.id}, sold_at = NOW()
      WHERE id = (
        SELECT id FROM inventory
        WHERE product_id = ${order.product_id} AND status = 'available'
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, config_value;
    `;
        if (allocated.length) {
            const configValue = String(allocated[0].config_value);
            const itemPayload = serializeDeliveryPayload({
                configLinks: [configValue],
                primaryText: configValue
            });
            await sql `
        UPDATE inventory
        SET delivery_payload = ${itemPayload}::jsonb
        WHERE id = ${Number(allocated[0].id)};
      `;
            allocatedItems.push({ id: Number(allocated[0].id), config_value: configValue });
        }
        else {
            break;
        }
    }
    if (!allocatedItems.length) {
        const forceAwaitingConfig = panelConfig.force_awaiting_config === true;
        const forceRequireInventory = panelConfig.force_require_inventory === true;
        if (!forceRequireInventory && (globalInfinite || order.is_infinite || forceAwaitingConfig)) {
            await sql `
        UPDATE orders
        SET status = 'awaiting_config', paid_at = NOW(), admin_decision_by = ${decidedBy}
        WHERE id = ${order.id};
      `;
            await tg("sendMessage", {
                chat_id: Number(order.telegram_id),
                text: `┘╛╪▒╪»╪º╪«╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪» Γ£à\n╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${order.purchase_id}\n╪»╪▒ ╪¡╪º┘ä ╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î ┌⌐╪º┘å┘ü█î┌» ┘ç╪│╪¬█î┘à.`
            }).catch(() => { });
            const extraLines = [];
            if (typeof panelConfig.data_limit_mb === "number")
                extraLines.push(`╪¡╪¼┘à: ${Math.max(1, Math.round(Number(panelConfig.data_limit_mb) / 1024))} ┌»█î┌»╪º╪¿╪º█î╪¬`);
            if (typeof panelConfig.expire_days === "number")
                extraLines.push(`╪▓┘à╪º┘å: ${Math.max(1, Math.round(Number(panelConfig.expire_days)))} ╪▒┘ê╪▓`);
            const bulkQtyNotif = getOrderBulkQuantity(order, panelConfig);
            if (bulkQtyNotif > 1)
                extraLines.push(`╪¬╪╣╪»╪º╪» ┌⌐╪º┘å┘ü█î┌»: ${bulkQtyNotif} ╪╣╪»╪»`);
            const bulkNamesNotif = Array.isArray(panelConfig.bulk_config_names) ? panelConfig.bulk_config_names : [];
            if (bulkNamesNotif.length > 0)
                extraLines.push(`┘å╪º┘àΓÇî┘ç╪º: ${bulkNamesNotif.join(", ")}`);
            await notifyAdmins(`≡ƒ¢á ╪│┘ü╪º╪▒╪┤ ${order.purchase_id} ┘å█î╪º╪▓ ╪¿┘ç ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪»╪│╪¬█î ╪»╪º╪▒╪».${extraLines.length ? `\n${extraLines.join("\n")}` : ""}`, {
                inline_keyboard: [[{ text: "╪º╪▒╪│╪º┘ä ┌⌐╪º┘å┘ü█î┌»", callback_data: `admin_provide_config_${order.id}` }]]
            });
            return { ok: true, reason: "awaiting_config" };
        }
        await sql `UPDATE orders SET status = 'receipt_submitted' WHERE id = ${order.id} AND status = 'fulfilling';`;
        await notifyAdmins(`ΓÜá∩╕Å ╪│┘ü╪º╪▒╪┤ ${order.purchase_id} ┘╛╪▒╪»╪º╪«╪¬ ╪┤╪» ╪º┘à╪º ┘à┘ê╪¼┘ê╪»█î ╪º█î┘å ┘à╪¡╪╡┘ê┘ä ╪¬┘à╪º┘à ╪┤╪»┘ç ╪º╪│╪¬.`);
        return { ok: false, reason: "stock_empty" };
    }
    // Warn admin if fewer items were allocated than requested
    if (allocatedItems.length < bulkQty) {
        await notifyAdmins(`ΓÜá∩╕Å ╪│┘ü╪º╪▒╪┤ ${order.purchase_id}: ╪»╪▒╪«┘ê╪º╪│╪¬ ${bulkQty} ╪ó█î╪¬┘à ╪¿┘ê╪» ╪º┘à╪º ┘ü┘é╪╖ ${allocatedItems.length} ┘à┘ê╪¼┘ê╪» ╪¿┘ê╪».`);
    }
    await sql `
    UPDATE orders
    SET status = 'paid', paid_at = NOW(), inventory_id = ${allocatedItems[0].id}, admin_decision_by = ${decidedBy}
    WHERE id = ${order.id};
  `;
    for (const item of allocatedItems) {
        await recordInventoryForensicEvent(item.id, "sale_delivered", {
            purchaseId: String(order.purchase_id),
            by: decidedBy
        });
    }
    await tg("sendMessage", {
        chat_id: Number(order.telegram_id),
        text: `┘╛╪▒╪»╪º╪«╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪» Γ£à${allocatedItems.length > 1 ? `\n${allocatedItems.length} ┌⌐╪º┘å┘ü█î┌» ╪ó┘à╪º╪»┘ç ╪┤╪».` : ""}`
    }).catch(() => { });
    const allConfigLinks = allocatedItems.map((item) => item.config_value);
    const inventoryDelivery = {
        configLinks: allConfigLinks,
        primaryText: allConfigLinks[0] || "",
        metadata: { bulkCount: allocatedItems.length }
    };
    if (allConfigLinks.length > 1) {
        for (let i = 0; i < allConfigLinks.length; i++) {
            const configValue = allConfigLinks[i];
            const isLast = i === allConfigLinks.length - 1;
            await sendDeliveryPackage(Number(order.telegram_id), String(order.purchase_id), configValue, { configLinks: [configValue], primaryText: configValue }, isLast
                ? [
                    [{ text: "Γ₧ò ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", callback_data: "topup_menu" }],
                    [homeButton()]
                ]
                : []).catch((e) => logError("delivery_package_failed", e, { orderId: order.id, configIndex: i }));
        }
    }
    else {
        await sendDeliveryPackage(Number(order.telegram_id), String(order.purchase_id), allConfigLinks[0] || "", inventoryDelivery, [
            [{ text: "Γ₧ò ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", callback_data: "topup_menu" }],
            [homeButton()]
        ]).catch((e) => logError("delivery_package_failed", e, { orderId: order.id }));
    }
    await notifyAdmins(buildAdminDeliverySummary({
        purchaseId: String(order.purchase_id),
        userId: Number(order.telegram_id),
        telegramUsername: profile.username,
        telegramFullName: profile.fullName,
        productName: String(order.product_name || "-") + (allocatedItems.length > 1 ? ` (x${allocatedItems.length})` : ""),
        deliveryPayload: inventoryDelivery,
        walletUsed: Number(order.wallet_used || 0)
    }), { inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${String(order.purchase_id)}` }]] });
    return { ok: true, reason: "fulfilled" };
}
async function handleCallback(update) {
    if (!update?.data || !update.message)
        return null;
    const data = update.data;
    const userId = update.from.id;
    const chatId = update.message.chat.id;
    const upsertPromise = upsertUser(update.from);
    if (data !== "check_membership") {
        tg("answerCallbackQuery", { callback_query_id: update.id }).catch(() => { });
    }
    await upsertPromise;
    if (data.startsWith("noop_")) {
        return null;
    }
    if (await isBanned(userId)) {
        await tg("sendMessage", { chat_id: chatId, text: "╪»╪│╪¬╪▒╪│█î ╪┤┘à╪º ╪¿┘ç ╪»┘ä█î┘ä ╪¬╪«┘ä┘ü ┘à╪│╪»┘ê╪» ╪┤╪»┘ç ╪º╪│╪¬." });
        return null;
    }
    if (data !== "check_membership" && !(await checkMandatoryChannels(userId, chatId))) {
        return null;
    }
    if (data === "check_membership") {
        const isMember = await checkMandatoryChannels(userId, chatId, true);
        if (isMember) {
            await maybeQualifyReferralUser(userId);
            const msgId = update.message?.message_id || 0;
            if (msgId) {
                const deleted = await tg("deleteMessage", { chat_id: chatId, message_id: msgId }).catch(() => null);
                if (!deleted || !deleted.ok) {
                    await tg("editMessageText", { chat_id: chatId, message_id: msgId, text: "╪╣╪╢┘ê█î╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪» Γ£à" }).catch(() => { });
                }
            }
            await sendStartMedia(chatId);
            await sendMainMenu(chatId, userId, "╪╣╪╢┘ê█î╪¬ ╪┤┘à╪º ╪¬╪º█î█î╪» ╪┤╪» Γ£à");
        }
        else {
            await tg("answerCallbackQuery", { callback_query_id: update.id, text: "┘ç┘å┘ê╪▓ ╪»╪▒ ┘ç┘à┘ç ┌⌐╪º┘å╪º┘äΓÇî┘ç╪º ╪╣╪╢┘ê ┘å╪┤╪»┘çΓÇî╪º█î╪»!", show_alert: true }).catch(() => { });
        }
        return null;
    }
    await maybeQualifyReferralUser(userId);
    if (data === "home") {
        await clearState(userId);
        await sendMainMenu(chatId, userId);
        return null;
    }
    if (data === "wallet_menu") {
        await clearState(userId);
        await sendWalletMenu(chatId, userId);
        return null;
    }
    if (data === "wallet_transactions") {
        await clearState(userId);
        await showWalletTransactions(chatId, userId);
        return null;
    }
    if (data === "referral_menu") {
        await clearState(userId);
        await sendReferralMenu(chatId, userId);
        return null;
    }
    if (data === "referral_invitees") {
        await clearState(userId);
        await showReferralInvitees(chatId, userId);
        return null;
    }
    if (data === "referral_rewards_history") {
        await clearState(userId);
        await showReferralRewardHistory(chatId, userId);
        return null;
    }
    if (data === "referral_claim_help") {
        await clearState(userId);
        await sendReferralClaimHelp(chatId);
        return null;
    }
    if (data === "wallet_charge") {
        await setState(userId, "await_wallet_charge_amount");
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘à╪¿┘ä╪║ ╪┤╪º╪▒┌ÿ ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 50000",
            reply_markup: { inline_keyboard: [[backButton("wallet_menu")]] }
        });
        return null;
    }
    if (data.startsWith("wallet_charge_method_")) {
        const method = data.replace("wallet_charge_method_", "");
        const state = await getState(userId);
        if (!state || state.state !== "await_wallet_charge_method")
            return null;
        const amount = Number(state.payload.amount);
        if (method === "tronado") {
            const rows = await sql `
        INSERT INTO wallet_topups (telegram_id, amount, payment_method)
        VALUES (${userId}, ${amount}, 'tronado')
        RETURNING id;
      `;
            const topupId = Number(rows[0].id);
            try {
                const walletFromSetting = await getSetting("business_wallet_address");
                const walletAddress = walletFromSetting || env.BUSINESS_WALLET_ADDRESS;
                if (!walletAddress) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪¬┘å╪╕█î┘à╪º╪¬ ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪º┘à┘ä ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
                    return null;
                }
                const tronadoApiKey = ((await getSetting("tronado_api_key")) || "").trim();
                const tronPrice = await getTronPriceToman(tronadoApiKey || undefined);
                const tronAmount = Number((amount / tronPrice).toFixed(6));
                const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
                if (!callbackBase) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ╪¿╪▒╪º█î Callback ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
                    return null;
                }
                const paymentId = `W${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
                const tokenData = await getOrderToken({
                    paymentId,
                    walletAddress,
                    tronAmount: Math.max(0.1, tronAmount),
                    callbackUrl: `${callbackBase}/api/tronado-callback`,
                    apiKey: tronadoApiKey || undefined
                });
                await sql `UPDATE wallet_topups SET receipt_file_id = ${paymentId} WHERE id = ${topupId}`;
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: `┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬ ╪¬╪▒┘ê┘å╪º╪»┘ê ╪¿╪▒╪º█î ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ╪ó┘à╪º╪»┘ç ╪º╪│╪¬:\n┘à╪¿┘ä╪║: ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å`,
                    reply_markup: { inline_keyboard: [[{ text: "≡ƒÆ│ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º Tronado", url: tokenData.paymentUrl }]] }
                });
                await clearState(userId);
            }
            catch (error) {
                logError("create_wallet_tronado_failed", error, { userId, amount });
                await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪º█î╪¼╪º╪» ┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬." });
            }
        }
        else if (method === "tetrapay") {
            try {
                const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
                if (!callbackBase) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ╪¿╪▒╪º█î Callback ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
                    return null;
                }
                const tetrapayApiKey = ((await getSetting("tetrapay_api_key")) || "").trim();
                if (!tetrapayApiKey) {
                    await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» ╪¬╪¬╪▒╪º┘╛█î ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
                    return null;
                }
                const paymentId = `W${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
                const { createTetrapayOrder } = await import("./tetrapay.js");
                const orderRes = await createTetrapayOrder({
                    purchaseId: paymentId,
                    amountToman: amount,
                    description: `╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä`,
                    callbackUrl: `${callbackBase}/api/tetrapay-callback`,
                    apiKey: tetrapayApiKey
                });
                if (!orderRes.ok) {
                    await tg("sendMessage", { chat_id: chatId, text: `╪«╪╖╪º ╪»╪▒ ╪º╪▒╪¬╪¿╪º╪╖ ╪¿╪º ╪»╪▒┌»╪º┘ç ╪¬╪¬╪▒╪º┘╛█î: ${orderRes.message}` });
                    return null;
                }
                await sql `
          INSERT INTO wallet_topups (telegram_id, amount, payment_method, receipt_file_id)
          VALUES (${userId}, ${amount}, 'tetrapay', ${paymentId});
        `;
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: `┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬ ╪¬╪¬╪▒╪º┘╛█î ╪¿╪▒╪º█î ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ╪ó┘à╪º╪»┘ç ╪º╪│╪¬:\n┘à╪¿┘ä╪║: ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å`,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "≡ƒÆ│ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º ╪¬╪¬╪▒╪º┘╛█î", url: orderRes.paymentUrlBot }],
                            [homeButton()]
                        ]
                    }
                });
                await clearState(userId);
            }
            catch (error) {
                logError("create_wallet_tetrapay_failed", error, { userId, amount });
                await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪º█î╪¼╪º╪» ┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬." });
            }
        }
        else if (method === "plisio") {
            try {
                const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
                if (!callbackBase) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ╪│╪º█î╪¬ ╪¿╪▒╪º█î Callback ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
                    return null;
                }
                const plisioApiKey = ((await getSetting("plisio_api_key")) || "").trim();
                if (!plisioApiKey) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪¬┘å╪╕█î┘à╪º╪¬ Plisio ┌⌐╪º┘à┘ä ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
                    return null;
                }
                const paymentId = `W${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, "0")}`;
                const tomanPerUsdt = await getPlisioTomanPerUsdt();
                const usdtAmount = Math.max(0.01, Number((amount / tomanPerUsdt).toFixed(2)));
                const { createPlisioInvoice } = await import("./plisio.js");
                const invoice = await createPlisioInvoice({
                    apiKey: plisioApiKey,
                    orderNumber: paymentId.slice(1),
                    orderName: paymentId,
                    sourceCurrency: "USD",
                    sourceAmount: usdtAmount,
                    callbackUrl: `${callbackBase}/api/plisio-callback?json=true`
                });
                await sql `
          INSERT INTO wallet_topups (telegram_id, amount, payment_method, receipt_file_id)
          VALUES (${userId}, ${amount}, 'plisio', ${paymentId});
        `;
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: `┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬ Plisio ╪¿╪▒╪º█î ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ╪ó┘à╪º╪»┘ç ╪º╪│╪¬:\n┘à╪¿┘ä╪║: ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å\n┘à╪╣╪º╪»┘ä ╪¬┘é╪▒█î╪¿█î: ${usdtAmount} USDT`,
                    reply_markup: { inline_keyboard: [[{ text: "≡ƒÆ│ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪º Plisio", url: invoice.invoiceUrl }], [homeButton()]] }
                });
                await clearState(userId);
            }
            catch (error) {
                logError("create_wallet_plisio_failed", error, { userId, amount });
                await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪º█î╪¼╪º╪» ┘ä█î┘å┌⌐ ┘╛╪▒╪»╪º╪«╪¬." });
            }
        }
        else if (method === "crypto") {
            const wallets = await getActiveCryptoWallets();
            const ready = wallets.filter(cryptoWalletReady);
            if (!ready.length) {
                await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê█î ┘ü╪╣╪º┘ä█î ╪¿╪▒╪º█î ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬." });
                return null;
            }
            if (ready.length > 1) {
                await setState(userId, "await_wallet_charge_crypto_wallet_select", { amount });
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: "┌⌐╪»╪º┘à ┌⌐█î┘ü ┘╛┘ê┘ä ╪▒╪º ╪¿╪▒╪º█î ╪┤╪º╪▒┌ÿ ╪º┘å╪¬╪«╪º╪¿ ┘à█îΓÇî┌⌐┘å█î╪»╪ƒ",
                    reply_markup: {
                        inline_keyboard: ready
                            .slice(0, 12)
                            .map((w) => [cb(cryptoWalletTitle(w), `wallet_charge_crypto_wallet_${w.id}`, "primary")])
                            .concat([[backButton("wallet_menu", "≡ƒöÖ ╪¿╪º╪▓┌»╪┤╪¬")]])
                    }
                });
                return null;
            }
            await createCryptoWalletTopup(chatId, userId, amount, ready[0]);
        }
        else if (method === "card2card") {
            const cards = await sql `SELECT card_number, holder_name, bank_name FROM cards WHERE active = TRUE;`;
            if (!cards.length) {
                await tg("sendMessage", { chat_id: chatId, text: "┘ç█î┌å ┌⌐╪º╪▒╪¬█î ╪¿╪▒╪º█î ┌⌐╪º╪▒╪¬ΓÇî╪¿┘çΓÇî┌⌐╪º╪▒╪¬ ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬." });
                return null;
            }
            const rows = await sql `
        INSERT INTO wallet_topups (telegram_id, amount, payment_method)
        VALUES (${userId}, ${amount}, 'card2card')
        RETURNING id;
      `;
            const topupId = Number(rows[0].id);
            await setState(userId, "await_wallet_receipt", { topupId });
            const cardsText = cards
                .map(c => `≡ƒÆ│ ${c.card_number}\n≡ƒæñ ${c.holder_name || "┘å╪º┘à╪┤╪«╪╡"} (${c.bank_name || "┘å╪º┘à╪┤╪«╪╡"})`)
                .join("\n\n");
            await tg("sendMessage", {
                chat_id: chatId,
                text: `┘à╪¿┘ä╪║: ${formatPriceToman(amount)} ╪¬┘ê┘à╪º┘å\n\n┘ä╪╖┘ü╪º┘ï ┘à╪¿┘ä╪║ ╪▒╪º ╪¿┘ç █î┌⌐█î ╪º╪▓ ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º█î ╪▓█î╪▒ ┘ê╪º╪▒█î╪▓ ┌⌐┘å█î╪»:\n\n${cardsText}\n\n╪│┘╛╪│ ╪¬╪╡┘ê█î╪▒ ╪▒╪│█î╪» ╪▒╪º ┘ç┘à█î┘å╪¼╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».`
            });
        }
        else {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪▒╪º█î ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." });
        }
        return null;
    }
    if (data.startsWith("wallet_charge_crypto_wallet_")) {
        const walletId = Number(data.replace("wallet_charge_crypto_wallet_", ""));
        const state = await getState(userId);
        if (!state || state.state !== "await_wallet_charge_crypto_wallet_select")
            return null;
        const amount = Number(state.payload.amount);
        const walletRows = await sql `
      SELECT id, currency, network, address, rate_mode, rate_toman_per_unit, extra_toman_per_unit, active
      FROM crypto_wallets
      WHERE id = ${walletId}
      LIMIT 1;
    `;
        if (!walletRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const w = walletRows[0];
        if (!cryptoWalletReady(w)) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪▒█î┘╛╪¬┘ê ╪¿┘çΓÇî╪»╪▒╪│╪¬█î ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç █î╪º ╪║█î╪▒┘ü╪╣╪º┘ä ╪º╪│╪¬." });
            return null;
        }
        await createCryptoWalletTopup(chatId, userId, amount, w);
        return null;
    }
    if (data === "buy_menu" || data.startsWith("buy_cat_")) {
        let page = 0;
        let kind = "";
        if (data.startsWith("buy_cat_")) {
            const parts = data.replace("buy_cat_", "").split("_");
            kind = parts[0];
            page = Math.max(0, parseInt(parts[1], 10) || 0);
        }
        await showProducts(chatId, true, page, kind);
        return null;
    }
    if (data.startsWith("buy_custom_v2ray_")) {
        const productId = Number(data.replace("buy_custom_v2ray_", ""));
        await clearState(userId);
        await startCustomV2rayWizard(chatId, userId, productId);
        return null;
    }
    if (data.startsWith("buy_product_")) {
        const productId = Number(data.replace("buy_product_", ""));
        await setState(userId, "await_bulk_quantity", { productId });
        const quantityKeyboard = [
            [cb("1∩╕ÅΓâú 1 ╪╣╪»╪»", "bulk_qty_1"), cb("2∩╕ÅΓâú 2 ╪╣╪»╪»", "bulk_qty_2"), cb("3∩╕ÅΓâú 3 ╪╣╪»╪»", "bulk_qty_3")],
            [cb("4∩╕ÅΓâú 4 ╪╣╪»╪»", "bulk_qty_4"), cb("5∩╕ÅΓâú 5 ╪╣╪»╪»", "bulk_qty_5"), cb("Γ₧ò ╪│┘ü╪º╪▒╪┤█î", "bulk_qty_custom")],
            [homeButton()]
        ];
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┌å┘å╪» ╪╣╪»╪» ╪º╪▓ ╪º█î┘å ┘à╪¡╪╡┘ê┘ä ┘à█îΓÇî╪«┘ê╪º┘ç█î╪»╪ƒ",
            reply_markup: { inline_keyboard: quantityKeyboard }
        });
        return null;
    }
    if (data.startsWith("bulk_qty_")) {
        const state = await getState(userId);
        if (!state || state.state !== "await_bulk_quantity")
            return null;
        const qtyStr = data.replace("bulk_qty_", "");
        let quantity = 1;
        if (qtyStr === "custom") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¬╪╣╪»╪º╪» ┘à┘ê╪▒╪» ┘å╪╕╪▒ ╪▒╪º ┘ê╪º╪▒╪» ┌⌐┘å█î╪» (1-100):" });
            return null;
        }
        else {
            quantity = Number(qtyStr);
        }
        if (quantity < 1 || quantity > 100) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¬╪╣╪»╪º╪» ╪¿╪º█î╪» ╪¿█î┘å 1 ╪¬╪º 100 ╪¿╪º╪┤╪»." });
            return null;
        }
        const productId = Number(state.payload?.productId || 0);
        await setState(userId, "await_config_name", { productId, quantity });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¿╪▒╪º█î ${quantity} ╪╣╪»╪»${quantity > 1 ? " ╪º╪▓" : ""} ┘à╪¡╪╡┘ê┘ä █î┌⌐ ┘å╪º┘à ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:\n(╪º┌»╪▒ ┘å╪º┘à ╪¬┌⌐╪▒╪º╪▒█î ╪¿╪º╪┤╪»╪î ╪╣╪»╪» ╪¬╪╡╪º╪»┘ü█î ╪º╪╢╪º┘ü┘ç ┘à█îΓÇî╪┤┘ê╪»)\n\n┘à╪½╪º┘ä: config1, myVPN, etc`
        });
        return null;
    }
    if (data === "custom_v2ray_inc_count" || data === "custom_v2ray_dec_count") {
        try {
            const state = await getState(userId);
            if (!state || state.state !== "custom_v2ray_wizard")
                return null;
            const p = state.payload || {};
            const curQty = Math.max(1, Math.round(Number(p.quantity || 1)));
            const nextQty = data === "custom_v2ray_inc_count" ? curQty + 1 : Math.max(1, curQty - 1);
            await setState(userId, "custom_v2ray_wizard", { ...p, quantity: nextQty, messageId: Number(p.messageId || 0) });
            await renderCustomV2rayWizard(chatId, userId, update.message.message_id);
        }
        catch (e) {
            logError("custom_v2ray_count_adjust_failed", e, { userId, chatId, data });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪¬╪╣╪»╪º╪»." });
        }
        return null;
    }
    if (data === "custom_v2ray_inc_data" || data === "custom_v2ray_dec_data" || data === "custom_v2ray_inc_days" || data === "custom_v2ray_dec_days") {
        try {
            const state = await getState(userId);
            if (!state || state.state !== "custom_v2ray_wizard")
                return null;
            const p = state.payload || {};
            const baseMb = Math.max(1, Math.round(Number(p.baseMb || 1024)));
            const baseDays = Math.max(1, Math.round(Number(p.baseDays || 30)));
            const stepMb = 1024;
            const stepDays = 7;
            const curMb = Math.max(baseMb, Math.round(Number(p.dataMb || baseMb)));
            const curDays = Math.max(baseDays, Math.round(Number(p.days || baseDays)));
            let nextMb = curMb;
            let nextDays = curDays;
            if (data === "custom_v2ray_inc_data")
                nextMb = curMb + stepMb;
            if (data === "custom_v2ray_dec_data")
                nextMb = Math.max(baseMb, curMb - stepMb);
            if (data === "custom_v2ray_inc_days")
                nextDays = curDays + stepDays;
            if (data === "custom_v2ray_dec_days")
                nextDays = Math.max(baseDays, curDays - stepDays);
            await setState(userId, "custom_v2ray_wizard", { ...p, dataMb: nextMb, days: nextDays, messageId: Number(p.messageId || 0) });
            await renderCustomV2rayWizard(chatId, userId, update.message.message_id);
        }
        catch (e) {
            logError("custom_v2ray_adjust_failed", e, { userId, chatId, data });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ┘ü╪º┌⌐╪¬┘ê╪▒." });
        }
        return null;
    }
    if (data === "custom_v2ray_confirm") {
        try {
            const checkout = await computeCustomV2rayCheckout(userId);
            if (!checkout)
                return null;
            await clearState(userId);
            await setState(userId, "await_custom_v2ray_name", { checkout });
            const qty = Math.max(1, Math.round(Number(checkout.quantity || 1)));
            await tg("sendMessage", {
                chat_id: chatId,
                text: qty > 1
                    ? `╪¿╪▒╪º█î ${qty} ┌⌐╪º┘å┘ü█î┌» █î┌⌐ ┘å╪º┘à ┘╛╪º█î┘ç ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:\n(┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ┘å╪º┘à_1╪î ┘å╪º┘à_2╪î ... ╪│╪º╪«╪¬┘ç ┘à█îΓÇî╪┤┘ê┘å╪»)\n\n┘à╪½╪º┘ä: myVPN, config1, etc`
                    : "┘ä╪╖┘ü╪º┘ï █î┌⌐ ┘å╪º┘à ╪¿╪▒╪º█î ┌⌐╪º┘å┘ü█î┌» ╪«┘ê╪» ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:\n(╪º┌»╪▒ ┘å╪º┘à ╪¬┌⌐╪▒╪º╪▒█î ╪¿╪º╪┤╪»╪î ╪╣╪»╪» ╪¬╪╡╪º╪»┘ü█î ╪º╪╢╪º┘ü┘ç ┘à█îΓÇî╪┤┘ê╪»)\n\n┘à╪½╪º┘ä: myVPN, config1, etc"
            });
        }
        catch (e) {
            logError("custom_v2ray_confirm_failed", e, { userId, chatId });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪º╪»╪º┘à┘ç ┘╛╪▒╪»╪º╪«╪¬." });
        }
        return null;
    }
    if (data === "custom_v2ray_use_wallet_custom") {
        try {
            const state = await getState(userId);
            if (!state || state.state !== "custom_v2ray_checkout") {
                await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪│┘ü╪º╪▒╪┤ ╪│┘ü╪º╪▒╪┤█î ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º┘ê┘ä ╪┤╪▒┘ê╪╣ ┌⌐┘å." });
                return null;
            }
            await setState(userId, "await_custom_wallet_amount", { checkout: state.payload });
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║█î ┌⌐┘ç ┘à█îΓÇî╪«┘ê╪º┘ç█î ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪│╪▒ ╪┤┘ê╪» ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ┘ê╪º╪▒╪» ┌⌐┘å (┘ü┘é╪╖ ╪╣╪»╪»):" });
        }
        catch (e) {
            logError("custom_v2ray_wallet_custom_failed", e, { userId, chatId });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪º┘å╪¬╪«╪º╪¿ ┌⌐█î┘ü ┘╛┘ê┘ä." });
        }
        return null;
    }
    if (data.startsWith("custom_v2ray_use_wallet_")) {
        try {
            const amount = Number(data.replace("custom_v2ray_use_wallet_", ""));
            const state = await getState(userId);
            if (!state || state.state !== "custom_v2ray_checkout") {
                await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪│┘ü╪º╪▒╪┤ ╪│┘ü╪º╪▒╪┤█î ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º┘ê┘ä ╪┤╪▒┘ê╪╣ ┌⌐┘å." });
                return null;
            }
            const totalPrice = Math.max(1, Math.round(Number(state.payload.totalPrice || 0)));
            await showCustomPaymentMethods(chatId, userId, totalPrice, Math.max(0, Math.round(amount)));
        }
        catch (e) {
            logError("custom_v2ray_wallet_pick_failed", e, { userId, chatId });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪º┘å╪¬╪«╪º╪¿ ┌⌐█î┘ü ┘╛┘ê┘ä." });
        }
        return null;
    }
    if (data.startsWith("custom_v2ray_select_pay_")) {
        try {
            const payload = data.replace("custom_v2ray_select_pay_", "");
            const parts = payload.split("_");
            const method = parts[0];
            const walletUsed = Math.max(0, Math.round(Number(parts[1] || 0)));
            const state = await getState(userId);
            if (!state || state.state !== "custom_v2ray_checkout") {
                await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪│┘ü╪º╪▒╪┤ ╪│┘ü╪º╪▒╪┤█î ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º┘ê┘ä ╪┤╪▒┘ê╪╣ ┌⌐┘å." });
                return null;
            }
            await showDiscountChoiceCustom(chatId, Number(state.payload.productId || 0), method, walletUsed);
        }
        catch (e) {
            logError("custom_v2ray_select_pay_failed", e, { userId, chatId, data });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪º┘å╪¬╪«╪º╪¿ ╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬." });
        }
        return null;
    }
    if (data.startsWith("custom_discount_yes_")) {
        try {
            const payload = data.replace("custom_discount_yes_", "");
            const parts = payload.split("_");
            const productId = Number(parts[0]);
            let walletUsed = 0;
            if (parts.length >= 3 && !isNaN(Number(parts[parts.length - 1]))) {
                walletUsed = Number(parts.pop());
            }
            const paymentMethod = parts.slice(1).join("_");
            const state = await getState(userId);
            if (!state || state.state !== "custom_v2ray_checkout") {
                await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪│┘ü╪º╪▒╪┤ ╪│┘ü╪º╪▒╪┤█î ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º┘ê┘ä ╪┤╪▒┘ê╪╣ ┌⌐┘å." });
                return null;
            }
            await setState(userId, "await_custom_discount_code", { productId, paymentMethod, walletUsed, checkout: state.payload });
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»:" });
        }
        catch (e) {
            logError("custom_v2ray_discount_yes_failed", e, { userId, chatId, data });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ┘à╪▒╪¡┘ä┘ç ╪¬╪«┘ü█î┘ü." });
        }
        return null;
    }
    if (data.startsWith("custom_discount_no_")) {
        try {
            const payload = data.replace("custom_discount_no_", "");
            const parts = payload.split("_");
            const productId = Number(parts[0]);
            let walletUsed = 0;
            if (parts.length >= 3 && !isNaN(Number(parts[parts.length - 1]))) {
                walletUsed = Number(parts.pop());
            }
            const paymentMethod = parts.slice(1).join("_");
            const state = await getState(userId);
            if (!state || state.state !== "custom_v2ray_checkout") {
                await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪│┘ü╪º╪▒╪┤ ╪│┘ü╪º╪▒╪┤█î ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º┘ê┘ä ╪┤╪▒┘ê╪╣ ┌⌐┘å." });
                return null;
            }
            const checkout = state.payload || {};
            const totalPrice = Math.max(1, Math.round(Number(checkout.totalPrice || 0)));
            const dataMb = Math.max(1, Math.round(Number(checkout.dataMb || 0)));
            const days = Math.max(30, Math.round(Number(checkout.days || 30)));
            const quantity = Math.max(1, Math.round(Number(checkout.quantity || 1)));
            const gb = Math.max(1, Math.round(dataMb / 1024));
            const configName = String(checkout.configName || "").trim() || undefined;
            const configNames = Array.isArray(checkout.configNames) ? checkout.configNames : (configName ? [configName] : []);
            const overrides = {
                basePriceToman: totalPrice,
                panelConfigPatch: { data_limit_mb: dataMb, expire_days: days, force_awaiting_config: true, ...(quantity > 1 ? { bulk_quantity: quantity, bulk_config_names: configNames } : {}) },
                productNameSuffix: `(╪│┘ü╪º╪▒╪┤█î ${gb}GB / ${days} ╪▒┘ê╪▓${quantity > 1 ? ` ├ù ${quantity}` : ""})`,
                configName
            };
            await clearState(userId);
            await createOrder(chatId, userId, productId, paymentMethod, null, paymentMethod === "wallet" ? 0 : walletUsed, overrides);
        }
        catch (e) {
            logError("custom_v2ray_discount_no_failed", e, { userId, chatId, data });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪½╪¿╪¬ ╪│┘ü╪º╪▒╪┤." });
        }
        return null;
    }
    if (data.startsWith("use_wallet_custom_")) {
        const productId = Number(data.replace("use_wallet_custom_", ""));
        await setState(userId, "await_wallet_custom_amount", { productId });
        await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ┘à╪¿┘ä╪║█î ┌⌐┘ç ┘à█îΓÇî╪«┘ê╪º┘ç█î╪» ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪│╪▒ ╪┤┘ê╪» ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ┘ê╪º╪▒╪» ┌⌐┘å█î╪» (┘ü┘é╪╖ ╪╣╪»╪»):" });
        return null;
    }
    if (data.startsWith("use_wallet_")) {
        const parts = data.replace("use_wallet_", "").split("_");
        const productId = Number(parts[0]);
        const amount = Number(parts[1]);
        const state = await getState(userId);
        if (state?.state === "bulk_purchase_pending") {
            await setState(userId, "bulk_purchase_pending", { ...state.payload, walletUsed: amount });
        }
        await showPaymentMethods(chatId, userId, productId, amount);
        return null;
    }
    if (data.startsWith("select_pay_")) {
        const payload = data.replace("select_pay_", "");
        const parts = payload.split("_");
        const productId = Number(parts[0]);
        let walletUsed = 0;
        if (parts.length >= 3 && !isNaN(Number(parts[parts.length - 1]))) {
            walletUsed = Number(parts.pop());
        }
        const paymentMethod = parts.slice(1).join("_");
        const state = await getState(userId);
        if (state?.state === "bulk_purchase_pending") {
            const bulkData = state.payload;
            await setState(userId, "bulk_purchase_pending", { ...bulkData, paymentMethod, walletUsed });
        }
        await showDiscountChoice(chatId, productId, paymentMethod, walletUsed);
        return null;
    }
    if (data.startsWith("select_crypto_wallet_")) {
        const walletId = Number(data.replace("select_crypto_wallet_", ""));
        const state = await getState(userId);
        if (!state || state.state !== "await_crypto_wallet_select")
            return null;
        const productId = Number(state.payload.productId);
        const discountInput = state.payload.discountInput ? String(state.payload.discountInput) : null;
        const walletUsedParam = Number(state.payload.walletUsedParam || 0);
        const overrides = state.payload.overrides ? state.payload.overrides : null;
        await clearState(userId);
        await createOrder(chatId, userId, productId, `crypto_${walletId}`, discountInput, walletUsedParam, overrides);
        return null;
    }
    if (data.startsWith("swapwallet_asset_")) {
        const payload = data.replace("swapwallet_asset_", "");
        const parts = payload.split("_").map((x) => x.trim()).filter(Boolean);
        const token = parts.length ? parts[0].toUpperCase() : "";
        const network = parts.length > 1 ? parts[1].toUpperCase() : "";
        if (!token || !network)
            return null;
        const state = await getState(userId);
        if (!state || state.state !== "await_swapwallet_asset_select")
            return null;
        const productId = Number(state.payload.productId);
        const discountInput = state.payload.discountInput ? String(state.payload.discountInput) : null;
        const walletUsedParam = Number(state.payload.walletUsedParam || 0);
        const overrides = state.payload.overrides ? state.payload.overrides : null;
        await clearState(userId);
        await createOrder(chatId, userId, productId, `swapwallet_${token}_${network}`, discountInput, walletUsedParam, overrides);
        return null;
    }
    if (data.startsWith("discount_yes_")) {
        const payload = data.replace("discount_yes_", "");
        const parts = payload.split("_");
        const productId = Number(parts[0]);
        let walletUsed = 0;
        if (parts.length >= 3 && !isNaN(Number(parts[parts.length - 1]))) {
            walletUsed = Number(parts.pop());
        }
        const paymentMethod = parts.slice(1).join("_");
        const state = await getState(userId);
        if (state?.state === "bulk_purchase_pending") {
            const bulkData = state.payload;
            await setState(userId, "await_discount_code", { ...bulkData, productId, paymentMethod, walletUsed });
        }
        else {
            await setState(userId, "await_discount_code", { productId, paymentMethod, walletUsed });
        }
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪» ╪¬╪«┘ü█î┘ü ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»:" });
        return null;
    }
    if (data.startsWith("discount_no_")) {
        const payload = data.replace("discount_no_", "");
        const parts = payload.split("_");
        const productId = Number(parts[0]);
        let walletUsed = 0;
        if (parts.length >= 3 && !isNaN(Number(parts[parts.length - 1]))) {
            walletUsed = Number(parts.pop());
        }
        const paymentMethod = parts.slice(1).join("_");
        const state = await getState(userId);
        if (state?.state === "bulk_purchase_pending") {
            const bulkData = state.payload;
            const quantity = Number(bulkData.quantity || 1);
            const configName = String(bulkData.configName || "config");
            await clearState(userId);
            await createBulkOrders(chatId, userId, productId, paymentMethod, null, walletUsed, quantity, configName);
        }
        else {
            await clearState(userId);
            await createOrder(chatId, userId, productId, paymentMethod, null, walletUsed);
        }
        return null;
    }
    if (data.startsWith("check_order_")) {
        const purchaseId = data.replace("check_order_", "");
        if (await isRateLimited(userId, "check_order", 10_000)) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘à█î ╪╡╪¿╪▒ ┌⌐┘å█î╪» ┘ê ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
            return null;
        }
        try {
            const orderRows = await sql `
        SELECT payment_method, plisio_txn_id, receipt_file_id
        FROM orders
        WHERE purchase_id = ${purchaseId}
        LIMIT 1;
      `;
            if (!orderRows.length) {
                await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪»." });
                return null;
            }
            const paymentMethod = orderRows[0].payment_method;
            let isAccepted = false;
            if (paymentMethod === "tetrapay") {
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: "╪¿╪▒╪▒╪│█î ┘ê╪╢╪╣█î╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪¬╪¬╪▒╪º┘╛█î ┘à╪╣┘à┘ê┘ä╪º┘ï ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪º┘å╪¼╪º┘à ┘à█îΓÇî╪┤┘ê╪».\n╪º┌»╪▒ ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪▒╪»┘çΓÇî╪º█î ┘ê┘ä█î ╪¬╪º█î█î╪» ┘å┘à█îΓÇî╪┤┘ê╪»╪î ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å ╪¬╪º ╪º╪»┘à█î┘å ╪¿╪▒╪▒╪│█î ┌⌐┘å╪».",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "≡ƒô╖ ╪º╪▒╪│╪º┘ä ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬", callback_data: `crypto_receipt_${purchaseId}` }],
                            [{ text: "≡ƒÅá ┘à┘å┘ê█î ╪º╪╡┘ä█î", callback_data: "home" }]
                        ]
                    }
                });
                return null;
            }
            else if (paymentMethod === "tronado") {
                const tronadoApiKey = ((await getSetting("tronado_api_key")) || "").trim();
                const result = await getStatusByPaymentId(purchaseId, tronadoApiKey || undefined);
                const orderStatusTitle = result?.OrderStatusTitle || result?.Data?.OrderStatusTitle || result?.orderStatusTitle || result?.Data?.orderStatusTitle;
                const isPaid = result?.IsPaid === true || result?.Data?.IsPaid === true || result?.isPaid === true || result?.Data?.isPaid === true;
                isAccepted = orderStatusTitle === "PaymentAccepted" || isPaid;
            }
            else if (paymentMethod === "plisio") {
                const txnId = String(orderRows[0].plisio_txn_id || "").trim();
                if (!txnId) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ Plisio ┘å╪º┘é╪╡ ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
                    await notifyAdmins(`ΓÜá∩╕Å Plisio txn_id ╪¿╪▒╪º█î ╪│┘ü╪º╪▒╪┤ ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬\n╪│┘ü╪º╪▒╪┤: ${purchaseId}`, {
                        inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
                    });
                    return null;
                }
                const plisioApiKey = ((await getSetting("plisio_api_key")) || "").trim();
                if (!plisioApiKey) {
                    await tg("sendMessage", { chat_id: chatId, text: "╪¬┘å╪╕█î┘à╪º╪¬ Plisio ┌⌐╪º┘à┘ä ┘å█î╪│╪¬. ┘ä╪╖┘ü╪º┘ï ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪»." });
                    await notifyAdmins(`ΓÜá∩╕Å ┌⌐┘ä█î╪» Plisio ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬\n╪│┘ü╪º╪▒╪┤: ${purchaseId}`, {
                        inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
                    });
                    return null;
                }
                const { getPlisioOperation } = await import("./plisio.js");
                const op = await getPlisioOperation({ apiKey: plisioApiKey, operationId: txnId });
                const s = String(op?.status || "").toLowerCase().trim();
                await sql `UPDATE orders SET plisio_status = ${s} WHERE purchase_id = ${purchaseId};`;
                if (s === "expired" || s === "cancelled" || s === "error" || s === "cancelled duplicate") {
                    await tg("sendMessage", { chat_id: chatId, text: `┘ê╪╢╪╣█î╪¬ ┘╛╪▒╪»╪º╪«╪¬ Plisio: ${s}\n╪º┌»╪▒ ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪▒╪»┘çΓÇî╪º█î╪» ┘ê┘ä█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç╪î ╪¿┘ç ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘╛█î╪º┘à ╪»┘ç█î╪».` });
                    await notifyAdmins(`ΓÜá∩╕Å ┘ê╪╢╪╣█î╪¬ ┘å╪º┘à┘ê┘ü┘é Plisio\n╪│┘ü╪º╪▒╪┤: ${purchaseId}\nstatus: ${s}\ntxn: ${txnId}`, {
                        inline_keyboard: [[{ text: "≡ƒöÄ ╪¿╪º╪▓ ┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤", callback_data: `admin_open_purchase_${purchaseId}` }]]
                    });
                    return null;
                }
                isAccepted = s === "completed" || s === "mismatch";
            }
            else if (paymentMethod === "crypto") {
                const existingReceipt = String(orderRows[0].receipt_file_id || "").trim() || "";
                if (existingReceipt) {
                    await tg("sendMessage", { chat_id: chatId, text: "┘é╪¿┘ä╪º┘ï ╪¿╪▒╪º█î ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ╪º╪╖┘ä╪º╪╣╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪½╪¿╪¬ ╪┤╪»┘ç ┘ê ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒ ╪¬╪º█î█î╪» ╪º╪»┘à█î┘å ╪º╪│╪¬." });
                    return null;
                }
                await setState(userId, "await_crypto_receipt", { purchaseId });
                await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»:" });
                return null;
            }
            if (isAccepted) {
                const fulfill = await fulfillOrderByPaymentId(purchaseId);
                if (!fulfill.ok && fulfill.reason === "stock_empty") {
                    await tg("sendMessage", { chat_id: chatId, text: "┘╛╪▒╪»╪º╪«╪¬ ╪½╪¿╪¬ ╪┤╪» ┘ê┘ä█î ┘à┘ê╪¼┘ê╪»█î ╪╡┘ü╪▒ ╪º╪│╪¬. ╪º╪»┘à█î┘å ┘╛█î┌»█î╪▒█î ┘à█îΓÇî┌⌐┘å╪»." });
                }
            }
            else {
                const allowManual = paymentMethod === "tronado" || paymentMethod === "plisio" || paymentMethod === "tetrapay";
                await tg("sendMessage", {
                    chat_id: chatId,
                    text: "┘ç┘å┘ê╪▓ ┘╛╪▒╪»╪º╪«╪¬ ╪¬╪º█î█î╪» ┘å╪┤╪»┘ç ╪º╪│╪¬.\n╪º┌»╪▒ ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪▒╪»┘çΓÇî╪º█î ┘ê┘ä█î ╪¬╪º█î█î╪» ┘å┘à█îΓÇî╪┤┘ê╪»╪î ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å ╪¬╪º ╪º╪»┘à█î┘å ╪¿╪▒╪▒╪│█î ┌⌐┘å╪».",
                    ...(allowManual
                        ? {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: "≡ƒô╖ ╪º╪▒╪│╪º┘ä ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬", callback_data: `crypto_receipt_${purchaseId}` }],
                                    [{ text: "≡ƒÅá ┘à┘å┘ê█î ╪º╪╡┘ä█î", callback_data: "home" }]
                                ]
                            }
                        }
                        : {})
                });
            }
        }
        catch (error) {
            logError("check_order_status_failed", error, { purchaseId, userId, chatId });
            await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪¿╪▒╪▒╪│█î ┘ê╪╢╪╣█î╪¬ ┘╛╪▒╪»╪º╪«╪¬." });
        }
        return null;
    }
    if (data.startsWith("crypto_receipt_")) {
        const purchaseId = data.replace("crypto_receipt_", "").trim();
        if (!purchaseId)
            return null;
        const rows = await sql `
      SELECT id, status, payment_method
      FROM orders
      WHERE purchase_id = ${purchaseId} AND telegram_id = ${userId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const order = rows[0];
        const method = String(order.payment_method || "").toLowerCase();
        if (!(method === "tronado" || method === "plisio" || method === "tetrapay")) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┘å█î╪º╪▓█î ╪¿┘ç ╪º╪▒╪│╪º┘ä ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘å╪»╪º╪▒╪»." });
            return null;
        }
        const status = String(order.status || "").toLowerCase();
        if (status === "paid") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┘é╪¿┘ä╪º┘ï ┘╛╪▒╪»╪º╪«╪¬ ╪┤╪»┘ç ╪º╪│╪¬ Γ£à" });
            return null;
        }
        if (status === "denied" || status === "cancelled") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪│┘ü╪º╪▒╪┤ ╪¿╪│╪¬┘ç ╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        await setState(userId, "await_crypto_receipt", { orderId: Number(order.id) });
        await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ╪º╪│┌⌐╪▒█î┘åΓÇî╪┤╪º╪¬ ┘╛╪▒╪»╪º╪«╪¬ ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å:" });
        return null;
    }
    if (data.startsWith("show_configs_")) {
        const payload = data.replace("show_configs_", "");
        const parts = payload.split("_");
        const purchaseId = parts[0];
        const page = Math.max(1, Math.round(Number(parts[1] || 1)));
        // Fetch ALL inventory items for this purchase so bulk orders show every config + sub URL
        // Include 'migrated' so migrated bulk configs still show up with a note
        const rows = await sql `
      SELECT i.id, i.config_value, i.delivery_payload, i.status, i.migrated_to_inventory_id, p.name
      FROM inventory i
      INNER JOIN products p ON p.id = i.product_id
      LEFT JOIN orders o ON o.id = i.sold_order_id
      WHERE i.owner_telegram_id = ${userId}
        AND i.status IN ('sold', 'migrated')
        AND o.purchase_id = ${purchaseId}
      ORDER BY i.id ASC;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ╪¿╪▒╪º█î ╪┤┘à╪º ┘å█î╪│╪¬ █î╪º █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const productName = String(rows[0].name || "-");
        const entries = [];
        for (const inv of rows) {
            const pd = parseDeliveryPayload(inv.delivery_payload);
            const subUrl = pd.subscriptionUrl || null;
            const configValue = String(inv.config_value || "").trim();
            const links = (pd.configLinks?.length ? pd.configLinks : configValue ? [configValue] : []);
            if (links.length > 0) {
                // Each config link becomes its own entry (paired with the sub URL if any)
                for (const link of links) {
                    entries.push({ subUrl, configLink: link });
                }
            }
            else if (subUrl) {
                entries.push({ subUrl, configLink: null });
            }
        }
        if (entries.length <= 1) {
            await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┌⌐╪º┘å┘ü█î┌» ╪º╪╢╪º┘ü█î ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪»." });
            return null;
        }
        const pageSize = 3;
        const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
        const safePage = Math.min(totalPages, Math.max(1, page));
        const start = (safePage - 1) * pageSize;
        const slice = entries.slice(start, start + pageSize);
        const entryLines = slice.map((entry, idx) => {
            const num = start + idx + 1;
            const parts = [`${num})`];
            if (entry.subUrl)
                parts.push(`┘ä█î┘å┌⌐ ╪│╪º╪¿:\n${entry.subUrl}`);
            if (entry.configLink)
                parts.push(`┌⌐╪º┘å┘ü█î┌»:\n${entry.configLink}`);
            return parts.join("\n");
        });
        const text = `┘à╪¡╪╡┘ê┘ä: ${productName}\n` +
            `╪┤┘å╪º╪│┘ç ╪«╪▒█î╪»: ${purchaseId}\n` +
            `┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º (╪╡┘ü╪¡┘ç ${safePage}/${totalPages}):\n\n` +
            entryLines.join("\n\n");
        const navRow = [];
        if (safePage > 1)
            navRow.push({ text: "Γ¼à∩╕Å ┘é╪¿┘ä█î", callback_data: `show_configs_${purchaseId}_${safePage - 1}` });
        if (safePage < totalPages)
            navRow.push({ text: "╪¿╪╣╪»█î Γ₧í∩╕Å", callback_data: `show_configs_${purchaseId}_${safePage + 1}` });
        const keyboard = [];
        if (navRow.length)
            keyboard.push(navRow);
        keyboard.push([{ text: "≡ƒôª ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î ┘à┘å", callback_data: "my_configs" }]);
        keyboard.push([homeButton()]);
        await tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } });
        return null;
    }
    if (data === "my_configs") {
        await showMyConfigs(chatId, userId, false, 0);
        return null;
    }
    if (data.startsWith("my_configs_page_")) {
        const page = parseInt(data.replace("my_configs_page_", ""), 10);
        await showMyConfigs(chatId, userId, false, Number.isFinite(page) ? page : 0);
        return null;
    }
    if (data === "my_orders") {
        await showMyOrders(chatId, userId);
        return null;
    }
    if (data === "order_lookup") {
        await setState(userId, "await_order_lookup");
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪┤┘å╪º╪│┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å (┘à╪½╪º┘ä: P1712345678901234):",
            reply_markup: { inline_keyboard: [[backButton("my_orders")], [homeButton()]] }
        });
        return null;
    }
    if (data.startsWith("open_order_")) {
        const purchaseId = data.replace("open_order_", "").trim();
        if (!purchaseId)
            return null;
        await showOrderDetails(chatId, userId, purchaseId);
        return null;
    }
    if (data.startsWith("order_send_receipt_")) {
        const orderId = Number(data.replace("order_send_receipt_", ""));
        if (!Number.isFinite(orderId) || orderId <= 0)
            return null;
        const rows = await sql `SELECT id, status, purchase_id FROM orders WHERE id = ${orderId} AND telegram_id = ${userId} LIMIT 1;`;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        if (String(rows[0].status || "").toLowerCase() !== "awaiting_receipt") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┘å█î╪º╪▓█î ╪¿┘ç ╪º╪▒╪│╪º┘ä ╪▒╪│█î╪» ┘å█î╪│╪¬." });
            return null;
        }
        await setState(userId, "await_receipt", { orderId });
        const purchaseId = String(rows[0].purchase_id || "").trim();
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘ä╪╖┘ü╪º┘ï ╪¬╪╡┘ê█î╪▒ ╪▒╪│█î╪» ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ ╪╣┌⌐╪│ ╪º╪▒╪│╪º┘ä ┌⌐┘å:",
            reply_markup: { inline_keyboard: [[backButton(`open_order_${purchaseId}`)], [homeButton()]] }
        });
        return null;
    }
    if (data.startsWith("order_cancel_")) {
        const purchaseId = data.replace("order_cancel_", "").trim();
        if (!purchaseId)
            return null;
        const rows = await sql `
      UPDATE orders
      SET status = 'cancelled'
      WHERE purchase_id = ${purchaseId}
        AND telegram_id = ${userId}
        AND status IN ('pending', 'awaiting_receipt')
      RETURNING telegram_id, purchase_id, wallet_used;
    `;
        if (rows.length) {
            const walletUsed = Number(rows[0].wallet_used || 0);
            if (walletUsed > 0) {
                await refundWalletUsage(Number(rows[0].telegram_id), walletUsed, `╪¿╪º╪▓┌»╪┤╪¬ ┘à╪¿┘ä╪║ ┌⌐█î┘ü ┘╛┘ê┘ä ╪¿┘ç ╪»┘ä█î┘ä ┘ä╪║┘ê ╪│┘ü╪º╪▒╪┤ ${rows[0].purchase_id}`);
            }
        }
        await tg("sendMessage", {
            chat_id: chatId,
            text: rows.length
                ? (Number(rows[0].wallet_used || 0) > 0 ? "╪│┘ü╪º╪▒╪┤ ┘ä╪║┘ê ╪┤╪» ┘ê ┘à╪¿┘ä╪║ ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪¿╪▒┌»╪┤╪¬ Γ£à" : "╪│┘ü╪º╪▒╪┤ ┘ä╪║┘ê ╪┤╪» Γ£à")
                : "╪º┘à┌⌐╪º┘å ┘ä╪║┘ê ╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪»."
        });
        if (rows.length) {
            await showOrderDetails(chatId, userId, purchaseId);
        }
        return null;
    }
    if (data === "my_migrations") {
        await showMyMigrations(chatId, userId);
        return null;
    }
    if (data === "topup_menu") {
        await showMyConfigs(chatId, userId, true, 0);
        return null;
    }
    if (data.startsWith("topup_page_")) {
        const page = parseInt(data.replace("topup_page_", ""), 10);
        await showMyConfigs(chatId, userId, true, Number.isFinite(page) ? page : 0);
        return null;
    }
    if (data.startsWith("open_config_")) {
        const payload = data.replace("open_config_", "");
        const fromTopupFlow = payload.endsWith("_t");
        const inventoryId = Number(fromTopupFlow ? payload.slice(0, -2) : payload);
        if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ╪º┘å╪¬╪«╪º╪¿ΓÇî╪┤╪»┘ç ┘à╪╣╪¬╪¿╪▒ ┘å█î╪│╪¬." });
            return null;
        }
        await openMyConfig(chatId, userId, inventoryId, fromTopupFlow);
        return null;
    }
    if (data.startsWith("request_topup_")) {
        const inventoryId = Number(data.replace("request_topup_", ""));
        const ownRows = await sql `
      SELECT id, config_value, status, migrated_to_inventory_id FROM inventory
      WHERE id = ${inventoryId} AND owner_telegram_id = ${userId} AND status IN ('sold', 'migrated')
      LIMIT 1;
    `;
        if (!ownRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ╪¿╪▒╪º█î ╪┤┘à╪º ┘å█î╪│╪¬ █î╪º █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        // Migrated config ΓÇö redirect topup to the new config
        if (String(ownRows[0].status) === "migrated" && ownRows[0].migrated_to_inventory_id) {
            await tg("sendMessage", { chat_id: chatId, text: "ΓÜí ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘à┘å╪¬┘é┘ä ╪┤╪»┘ç. ╪¿╪▒╪º█î ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪º╪▓ ┘ä█î╪│╪¬ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î╪¬╪º┘å ╪º┘é╪»╪º┘à ┌⌐┘å█î╪»." });
            return null;
        }
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘à┘é╪»╪º╪▒ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:\n" +
                "500MB = ┘å█î┘à ┌»█î┌»╪º╪¿╪º█î╪¬\n" +
                "1024MB = █î┌⌐ ┌»█î┌»╪º╪¿╪º█î╪¬\n" +
                "2048MB = ╪»┘ê ┌»█î┌»╪º╪¿╪º█î╪¬",
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "500MB", callback_data: `topup_amount_${inventoryId}_500` },
                        { text: "1GB (1024MB)", callback_data: `topup_amount_${inventoryId}_1024` }
                    ],
                    [{ text: "2GB (2048MB)", callback_data: `topup_amount_${inventoryId}_2048` }],
                    [{ text: "Γ£ì∩╕Å ┘à┘é╪»╪º╪▒ ╪»┘ä╪«┘ê╪º┘ç", callback_data: `topup_custom_${inventoryId}` }],
                    [homeButton()]
                ]
            }
        });
        return null;
    }
    if (data === "sublink_migrate_start") {
        await clearState(userId);
        await setState(userId, "await_migration_sublink", {});
        await tg("sendMessage", {
            chat_id: chatId,
            text: "≡ƒöù ┘ä█î┘å┌⌐ ╪│╪º╪¿╪│┌⌐╪▒█î┘╛╪┤┘å █î╪º ┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┌⌐╪º┘å┘ü█î┌» ┘é╪»█î┘à█î ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»:\n\n(┘à╪½╪º┘ä: https://panel.example.com/sub/xxxx █î╪º ┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒█î ┘à╪½┘ä user123)\n\n/cancel ╪¿╪▒╪º█î ┘ä╪║┘ê"
        });
        return null;
    }
    if (data.startsWith("sublink_migrate_pick_")) {
        const targetPanelId = Number(data.replace("sublink_migrate_pick_", ""));
        await executeSubLinkMigration(chatId, userId, targetPanelId);
        return null;
    }
    if (data.startsWith("config_migrate_targets_")) {
        const inventoryId = Number(data.replace("config_migrate_targets_", ""));
        await showCustomerMigrationTargets(chatId, inventoryId, userId);
        return null;
    }
    if (data.startsWith("migrate_pick_")) {
        const payload = data.replace("migrate_pick_", "");
        const [inventoryRaw, panelRaw] = payload.split("_");
        const inventoryId = Number(inventoryRaw);
        const panelId = Number(panelRaw);
        await createMigrationRequest(chatId, userId, userId, inventoryId, panelId, "customer");
        return null;
    }
    if (data.startsWith("topup_custom_")) {
        const inventoryId = Number(data.replace("topup_custom_", ""));
        await setState(userId, "await_topup_custom_amount", { inventoryId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘à┘é╪»╪º╪▒ ╪»┘ä╪«┘ê╪º┘ç ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».\n┘å┘à┘ê┘å┘ç: 1536 █î╪º 1.5GB █î╪º 800MB"
        });
        return null;
    }
    if (data.startsWith("topup_amount_")) {
        const payload = data.replace("topup_amount_", "");
        const [inventoryIdRaw, mbRaw] = payload.split("_");
        const inventoryId = Number(inventoryIdRaw);
        const mb = Number(mbRaw);
        await createTopupCard2CardRequest(chatId, userId, inventoryId, mb);
        return null;
    }
    if (data.startsWith("customer_remove_cfg_")) {
        const inventoryId = Number(data.replace("customer_remove_cfg_", ""));
        const rows = await sql `
      SELECT id, owner_telegram_id, delivery_payload, status
      FROM inventory
      WHERE id = ${inventoryId} AND owner_telegram_id = ${userId} AND status IN ('sold', 'migrated')
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "ΓÜá∩╕Å ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪» █î╪º ┘à╪¬╪╣┘ä┘é ╪¿┘ç ╪┤┘à╪º ┘å█î╪│╪¬." });
            return null;
        }
        await recordInventoryForensicEvent(inventoryId, "customer_removed_from_inventory", { actorUser: userId });
        await sql `
      UPDATE inventory
      SET
        owner_telegram_id = NULL,
        delivery_payload = jsonb_set(
          jsonb_set(
            jsonb_set(COALESCE(delivery_payload, '{}'::jsonb), '{metadata}', COALESCE(delivery_payload->'metadata', '{}'::jsonb), true),
            '{metadata,removed_by_owner}',
            to_jsonb(TRUE),
            true
          ),
          '{metadata,removed_at}',
          to_jsonb(NOW()::text),
          true
        )
      WHERE id = ${inventoryId};
    `;
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ╪º╪▓ ┘ä█î╪│╪¬ ╪┤┘à╪º ╪¡╪░┘ü ╪┤╪» Γ£à\n╪º╪╖┘ä╪º╪╣╪º╪¬ ╪¿╪▒╪º█î ┘╛█î┌»█î╪▒█î ╪º┘à┘å█î╪¬█î ╪░╪«█î╪▒┘ç ╪┤╪»." });
        return null;
    }
    if (data.startsWith("customer_revoke_cfg_")) {
        const inventoryId = Number(data.replace("customer_revoke_cfg_", ""));
        await performRegenLink(inventoryId, userId, false, chatId);
        return null;
    }
    if (data === "support") {
        const support = await getSetting("support_username");
        if (!support) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛╪┤╪¬█î╪¿╪º┘å█î ┘ç┘å┘ê╪▓ ╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒåÿ ┘╛╪┤╪¬█î╪¿╪º┘å█î\n\n╪¿╪▒╪º█î ╪º╪▒╪¬╪¿╪º╪╖ ╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪▒┘ê█î ╪»┌⌐┘à┘ç ╪▓█î╪▒ ╪¿╪▓┘å█î╪» █î╪º ┘╛█î╪º┘à ╪»┘ç█î╪»:\n@${support}`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "≡ƒÆ¼ ┌å╪¬ ╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î", url: `https://t.me/${support}` }],
                    [homeButton()]
                ]
            }
        });
        return null;
    }
    if (!isAdmin(userId))
        return null;
    if (data.startsWith("admin_lookup_ban_")) {
        const targetUser = Number(data.replace("admin_lookup_ban_", ""));
        if (!Number.isFinite(targetUser) || targetUser <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º╪▒╪¿╪▒ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        await sql `
      INSERT INTO banned_users (telegram_id, reason, banned_by)
      VALUES (${targetUser}, 'lookup_abuse', ${userId})
      ON CONFLICT (telegram_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by;
    `;
        await tg("sendMessage", { chat_id: chatId, text: `┌⌐╪º╪▒╪¿╪▒ ${targetUser} ╪¿┘å ╪┤╪» Γ£à` });
        return null;
    }
    if (data.startsWith("admin_lookup_toggle_inv_")) {
        const inventoryId = Number(data.replace("admin_lookup_toggle_inv_", ""));
        if (!Number.isFinite(inventoryId))
            return null;
        const rows = await sql `
      SELECT i.id, i.panel_id, i.delivery_payload, i.owner_telegram_id
      FROM inventory i
      WHERE i.id = ${inventoryId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const row = rows[0];
        const delivery = parseDeliveryPayload(row.delivery_payload);
        const currentlyRevoked = !!delivery.metadata?.revoked;
        const willEnable = currentlyRevoked;
        const panelType = String(delivery.metadata?.panelType || "");
        const panelId = Number(row.panel_id || 0);
        const key = String(delivery.metadata?.username || delivery.metadata?.uuid || delivery.metadata?.email || delivery.metadata?.subId || "").trim();
        let panelToggleMessage = "╪╣┘à┘ä█î╪º╪¬ ╪▒┘ê█î ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».";
        if (panelId && panelType && key) {
            const panelRows = await sql `
        SELECT id, panel_type, base_url, username, password
        FROM panels
        WHERE id = ${panelId}
        LIMIT 1;
      `;
            if (panelRows.length) {
                const result = isMarzbanLike(panelType) ? await toggleMarzbanUser(panelRows[0], key, willEnable) : await toggleSanaeiClient(panelRows[0], key, willEnable);
                panelToggleMessage = result.ok ? "╪╣┘à┘ä█î╪º╪¬ ┘╛┘å┘ä ┘à┘ê┘ü┘é Γ£à" : `╪╣┘à┘ä█î╪º╪¬ ┘╛┘å┘ä ┘å╪º┘à┘ê┘ü┘é: ${result.message}`;
            }
        }
        await recordInventoryForensicEvent(inventoryId, willEnable ? "admin_enable" : "admin_disable", { adminId: userId, panelResult: panelToggleMessage });
        await sql `
      UPDATE inventory
      SET delivery_payload = jsonb_set(
        jsonb_set(COALESCE(delivery_payload, '{}'::jsonb), '{metadata}', COALESCE(delivery_payload->'metadata', '{}'::jsonb), true),
        '{metadata,revoked}',
        to_jsonb(${!willEnable}::boolean),
        true
      )
      WHERE id = ${inventoryId};
    `;
        await tg("sendMessage", { chat_id: chatId, text: `┘ê╪╢╪╣█î╪¬ ┌⌐╪º┘å┘ü█î┌» ╪¬╪║█î█î╪▒ █î╪º┘ü╪¬ (${willEnable ? '┘ü╪╣╪º┘ä' : '╪║█î╪▒┘ü╪╣╪º┘ä'}) Γ£à\n${panelToggleMessage}` });
        return null;
    }
    if (data.startsWith("admin_lookup_regen_link_")) {
        const inventoryId = Number(data.replace("admin_lookup_regen_link_", ""));
        if (!Number.isFinite(inventoryId))
            return null;
        await performRegenLink(inventoryId, userId, true, chatId);
        return null;
    }
    if (data.startsWith("admin_lookup_revoke_inv_")) {
        let inventoryIdRaw = data.replace("admin_lookup_revoke_inv_", "");
        const isConfirmed = inventoryIdRaw.endsWith("_confirm");
        if (isConfirmed) {
            inventoryIdRaw = inventoryIdRaw.replace("_confirm", "");
        }
        const inventoryId = Number(inventoryIdRaw);
        if (!isConfirmed) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: `ΓÜá∩╕Å ╪ó█î╪º ╪º╪▓ ┘ä╪║┘ê ╪»╪│╪¬╪▒╪│█î ┌⌐╪º┘å┘ü█î┌» #${inventoryId} ╪º╪╖┘à█î┘å╪º┘å ╪»╪º╪▒█î╪»╪ƒ\n╪º█î┘å ╪╣┘à┘ä ╪»╪│╪¬╪▒╪│█î ┌⌐╪º╪▒╪¿╪▒ ╪▒╪º ╪»╪▒ ┘╛┘å┘ä ┘ê ╪»█î╪¬╪º╪¿█î╪│ ╪║█î╪▒┘ü╪╣╪º┘ä ┘à█îΓÇî┌⌐┘å╪».`,
                reply_markup: {
                    inline_keyboard: [
                        [
                            cb("Γ£à ╪¬╪º█î█î╪»", `admin_lookup_revoke_inv_${inventoryId}_confirm`, "danger"),
                            cb("Γ¥î ╪º┘å╪╡╪▒╪º┘ü", "admin_lookup_action_cancel", "primary")
                        ]
                    ]
                }
            });
            return null;
        }
        const inventoryIdFinal = inventoryId;
        const rows = await sql `
      SELECT i.id, i.panel_id, i.delivery_payload, i.owner_telegram_id
      FROM inventory i
      WHERE i.id = ${inventoryIdFinal}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const row = rows[0];
        const delivery = parseDeliveryPayload(row.delivery_payload);
        const panelType = String(delivery.metadata?.panelType || "");
        const panelId = Number(row.panel_id || 0);
        const key = String(delivery.metadata?.username || delivery.metadata?.uuid || delivery.metadata?.email || delivery.metadata?.subId || "").trim();
        let panelRevokeMessage = "┘ä╪║┘ê ╪»╪│╪¬╪▒╪│█î ╪»╪▒ ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».";
        if (panelId && panelType && key) {
            const panelRows = await sql `
        SELECT id, panel_type, base_url, username, password
        FROM panels
        WHERE id = ${panelId}
        LIMIT 1;
      `;
            if (panelRows.length) {
                const result = isMarzbanLike(panelType) ? await toggleMarzbanUser(panelRows[0], key, false) : await toggleSanaeiClient(panelRows[0], key, false);
                panelRevokeMessage = result.ok ? "┘ä╪║┘ê ╪»╪│╪¬╪▒╪│█î ╪»╪▒ ┘╛┘å┘ä ┘à┘ê┘ü┘é Γ£à" : `┘ä╪║┘ê ╪»╪│╪¬╪▒╪│█î ╪»╪▒ ┘╛┘å┘ä ┘å╪º┘à┘ê┘ü┘é: ${result.message}`;
            }
        }
        await recordInventoryForensicEvent(inventoryId, "admin_revoke", { adminId: userId, panelResult: panelRevokeMessage });
        await sql `
      UPDATE inventory
      SET delivery_payload = jsonb_set(
        jsonb_set(COALESCE(delivery_payload, '{}'::jsonb), '{metadata}', COALESCE(delivery_payload->'metadata', '{}'::jsonb), true),
        '{metadata,revoked}',
        to_jsonb(TRUE),
        true
      )
      WHERE id = ${inventoryId};
    `;
        await tg("sendMessage", { chat_id: chatId, text: `╪»╪│╪¬╪▒╪│█î ┌⌐╪º┘å┘ü█î┌» ┘é╪╖╪╣ ╪┤╪» Γ£à\n${panelRevokeMessage}` });
        return null;
    }
    if (data.startsWith("admin_lookup_direct_links_")) {
        const inventoryId = Number(data.replace("admin_lookup_direct_links_", ""));
        if (!Number.isFinite(inventoryId))
            return null;
        const rows = await sql `
      SELECT id, delivery_payload, config_value
      FROM inventory
      WHERE id = ${inventoryId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const row = rows[0];
        const delivery = parseDeliveryPayload(row.delivery_payload);
        const links = delivery.configLinks || [];
        if (links.length === 0) {
            // Fallback to raw config value if no links array is present
            if (row.config_value && String(row.config_value).includes("://")) {
                links.push(String(row.config_value));
            }
            else {
                await tg("sendMessage", { chat_id: chatId, text: "┘ä█î┘å┌⌐ ┘à╪│╪¬┘é█î┘à█î ╪¿╪▒╪º█î ╪º█î┘å ┌⌐╪º┘å┘ü█î┌» █î╪º┘ü╪¬ ┘å╪┤╪»." });
                return null;
            }
        }
        // Send the links to the admin (using chunks to avoid Telegram's character limits for large link arrays)
        const chunkSize = 10;
        for (let i = 0; i < links.length; i += chunkSize) {
            const chunk = links.slice(i, i + chunkSize);
            const chunkText = chunk.map(l => `<code>${escapeHtml(l)}</code>`).join("\n\n");
            const msgText = i === 0 ? `≡ƒöù ┘ä█î┘å┌⌐ΓÇî┘ç╪º█î ┘à╪│╪¬┘é█î┘à (╪¬╪╣╪»╪º╪» ┌⌐┘ä: ${links.length}):\n\n${chunkText}` : chunkText;
            await tg("sendMessage", {
                chat_id: chatId,
                text: msgText,
                parse_mode: "HTML"
            });
        }
        return null;
    }
    if (data.startsWith("admin_lookup_delete_inv_")) {
        let inventoryIdRaw = data.replace("admin_lookup_delete_inv_", "");
        const isConfirmed = inventoryIdRaw.endsWith("_confirm");
        if (isConfirmed) {
            inventoryIdRaw = inventoryIdRaw.replace("_confirm", "");
        }
        const inventoryId = Number(inventoryIdRaw);
        if (!Number.isFinite(inventoryId)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        if (!isConfirmed) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: `≡ƒº¿ ╪«╪╖╪▒! ╪ó█î╪º ╪º╪▓ ╪¡╪░┘ü ┌⌐╪º┘à┘ä ┌⌐╪º┘å┘ü█î┌» #${inventoryId} ╪º╪╖┘à█î┘å╪º┘å ╪»╪º╪▒█î╪»╪ƒ\n╪º█î┘å ╪╣┘à┘ä ┘é╪º╪¿┘ä ╪¿╪º╪▓┌»╪┤╪¬ ┘å█î╪│╪¬ ┘ê ┌⌐╪º╪▒╪¿╪▒ ╪º╪▓ ╪»█î╪¬╪º╪¿█î╪│ ┘ê ┘╛┘å┘ä ╪¡╪░┘ü ┘à█îΓÇî╪┤┘ê╪».`,
                reply_markup: {
                    inline_keyboard: [
                        [
                            cb("≡ƒöÑ ╪¡╪░┘ü ┌⌐╪º┘à┘ä", `admin_lookup_delete_inv_${inventoryId}_confirm`, "danger"),
                            cb("Γ¥î ╪º┘å╪╡╪▒╪º┘ü", "admin_lookup_action_cancel", "primary")
                        ]
                    ]
                }
            });
            return null;
        }
        const inventoryIdFinal = inventoryId;
        const rows = await sql `
      SELECT i.id, i.panel_id, i.delivery_payload
      FROM inventory i
      WHERE i.id = ${inventoryIdFinal}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const row = rows[0];
        const delivery = parseDeliveryPayload(row.delivery_payload);
        const panelType = String(delivery.metadata?.panelType || "");
        const panelId = Number(row.panel_id || 0);
        const key = String(delivery.metadata?.username || delivery.metadata?.uuid || delivery.metadata?.email || delivery.metadata?.subId || "").trim();
        let panelDeleteMessage = "╪¡╪░┘ü ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ┘å╪┤╪».";
        if (panelId && panelType && key) {
            const panelRows = await sql `
        SELECT id, panel_type, base_url, username, password
        FROM panels
        WHERE id = ${panelId}
        LIMIT 1;
      `;
            if (panelRows.length) {
                const result = isMarzbanLike(panelType)
                    ? await deleteMarzbanUser(panelRows[0], key)
                    : await revokeSanaeiClient(panelRows[0], key);
                panelDeleteMessage = result.ok ? "╪¡╪░┘ü/╪║█î╪▒┘ü╪╣╪º┘ä╪│╪º╪▓█î ╪»╪▒ ┘╛┘å┘ä ┘à┘ê┘ü┘é Γ£à" : `╪º┘é╪»╪º┘à ┘╛┘å┘ä ┘å╪º┘à┘ê┘ü┘é: ${result.message}`;
            }
        }
        await recordInventoryForensicEvent(inventoryId, "admin_permanent_delete", { adminId: userId, panelResult: panelDeleteMessage });
        try {
            // Because `inventory` has multiple dependent tables without ON DELETE CASCADE,
            // we must manually delete dependent rows first to prevent foreign key violations.
            await sql `
        WITH deleted_forensics AS (
          DELETE FROM config_forensics WHERE inventory_id = ${inventoryId}
        ),
        deleted_topups AS (
          DELETE FROM topup_requests WHERE inventory_id = ${inventoryId}
        ),
        deleted_migrations AS (
          DELETE FROM panel_migrations WHERE source_inventory_id = ${inventoryId}
        )
        DELETE FROM inventory WHERE id = ${inventoryId};
      `;
            // Also nullify references in orders to prevent violating orders_inventory_id_fkey
            await sql `UPDATE orders SET inventory_id = NULL WHERE inventory_id = ${inventoryId}`;
            await tg("sendMessage", { chat_id: chatId, text: `┌⌐╪º┘å┘ü█î┌» ╪º╪▓ ╪»█î╪¬╪º╪¿█î╪│ ╪¡╪░┘ü ╪┤╪» Γ£à\n${panelDeleteMessage}` });
        }
        catch (err) {
            logError("admin_inventory_delete_failed", err, { inventoryId, adminId: userId });
            await tg("sendMessage", { chat_id: chatId, text: `Γ¥î ╪¡╪░┘ü ┌⌐╪º┘å┘ü█î┌» ╪º╪▓ ╪»█î╪¬╪º╪¿█î╪│ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪».\n${err.message}` });
        }
        return null;
    }
    if (data.startsWith("admin_lookup_add_data_")) {
        const inventoryId = Number(data.replace("admin_lookup_add_data_", ""));
        if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        await setState(userId, "admin_lookup_add_data", { inventoryId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘à┘é╪»╪º╪▒ ╪»█î╪¬╪º█î ╪º╪╢╪º┘ü┘ç ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 500MB █î╪º 2GB",
            reply_markup: { inline_keyboard: [[cancelButton("admin_lookup_action_cancel")]] }
        });
        return null;
    }
    if (data.startsWith("admin_lookup_set_data_")) {
        const inventoryId = Number(data.replace("admin_lookup_set_data_", ""));
        if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        await setState(userId, "admin_lookup_set_data", { inventoryId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪│┘é┘ü ╪»█î╪¬╪º█î ╪¼╪»█î╪» ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 50GB █î╪º 102400MB █î╪º unlimited\n╪¿╪▒╪º█î ┘å╪º┘à╪¡╪»┘ê╪»: unlimited █î╪º 0",
            reply_markup: { inline_keyboard: [[cancelButton("admin_lookup_action_cancel")]] }
        });
        return null;
    }
    if (data.startsWith("admin_lookup_reset_data_")) {
        let inventoryIdRaw = data.replace("admin_lookup_reset_data_", "");
        const isConfirmed = inventoryIdRaw.endsWith("_confirm");
        if (isConfirmed) {
            inventoryIdRaw = inventoryIdRaw.replace("_confirm", "");
        }
        const inventoryId = Number(inventoryIdRaw);
        if (!Number.isFinite(inventoryId)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        if (!isConfirmed) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: `ΓÜá∩╕Å ╪ó█î╪º ╪º╪▓ ╪▒█î╪│╪¬ ┌⌐╪▒╪»┘å ┘à╪╡╪▒┘ü ┌⌐╪º┘å┘ü█î┌» #${inventoryId} ╪º╪╖┘à█î┘å╪º┘å ╪»╪º╪▒█î╪»╪ƒ\n╪º█î┘å ╪╣┘à┘ä ┘ü┘é╪╖ ┘à╪╡╪▒┘ü ┌⌐╪º╪▒╪¿╪▒ ╪▒╪º ╪╡┘ü╪▒ ┘à█îΓÇî┌⌐┘å╪» ┘ê ╪│┘é┘ü ╪»█î╪¬╪º ╪▒╪º ╪¬╪║█î█î╪▒ ┘å┘à█îΓÇî╪»┘ç╪».`,
                reply_markup: {
                    inline_keyboard: [
                        [
                            confirmButton(`admin_lookup_reset_data_${inventoryId}_confirm`, "Γ£à ╪▒█î╪│╪¬ ╪┤┘ê╪»"),
                            cb("Γ¥î ╪º┘å╪╡╪▒╪º┘ü", "admin_lookup_action_cancel", "primary")
                        ]
                    ]
                }
            });
            return null;
        }
        const inventoryIdFinal = inventoryId;
        if (!Number.isFinite(inventoryIdFinal) || inventoryIdFinal <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const rows = await sql `
      SELECT i.id, i.panel_id, i.delivery_payload, p.size_mb, p.is_infinite
      FROM inventory i
      INNER JOIN products p ON p.id = i.product_id
      WHERE i.id = ${inventoryIdFinal}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const row = rows[0];
        const delivery = parseDeliveryPayload(row.delivery_payload);
        const panelType = String(delivery.metadata?.panelType || "");
        const panelId = Number(row.panel_id || 0);
        if (!panelId || !panelType) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌⌐╪º┘å┘ü█î┌» ┘╛┘å┘ä█î ┘å█î╪│╪¬." });
            return null;
        }
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!panelRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        let result = { ok: false, message: "┘╛┘å┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." };
        if (isMarzbanLike(panelType)) {
            const username = String(delivery.metadata?.username || "").trim();
            if (!username) {
                await tg("sendMessage", { chat_id: chatId, text: "username ┘╛┘å┘ä ╪»╪▒ ┘à╪¬╪º╪»█î╪¬╪º ┘╛█î╪»╪º ┘å╪┤╪»." });
                return null;
            }
            result = await applyAdminResetUsageOnMarzban(panelRows[0], username);
        }
        else if (panelType === "sanaei") {
            const inboundId = parseMaybeNumber(delivery.metadata?.inboundId);
            const email = String(delivery.metadata?.email || "").trim();
            if (!inboundId || !email) {
                await tg("sendMessage", { chat_id: chatId, text: "inbound/email ╪»╪▒ ┘à╪¬╪º╪»█î╪¬╪º ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘é╪╡ ╪º╪│╪¬." });
                return null;
            }
            result = await applyAdminResetUsageOnSanaei(panelRows[0], inboundId, email);
        }
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪▒█î╪│╪¬ ╪»█î╪¬╪º ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${result.message}` });
            return null;
        }
        await recordInventoryForensicEvent(inventoryId, "admin_lookup_reset_data", {
            adminId: userId,
            panelResult: result.message
        });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪╡╪▒┘ü ╪»█î╪¬╪º█î ┌⌐╪º┘å┘ü█î┌» ╪╡┘ü╪▒ ╪┤╪» Γ£à\n${result.message}`
        });
        return null;
    }
    if (data.startsWith("admin_lookup_set_expiry_")) {
        const payload = data.replace("admin_lookup_set_expiry_", "");
        const [inventoryRaw, daysRaw] = payload.split("_");
        const inventoryId = Number(inventoryRaw);
        const forcedDays = daysRaw !== undefined ? Number(daysRaw) : NaN;
        if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┌⌐╪º┘å┘ü█î┌» ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        if (Number.isFinite(forcedDays) && forcedDays >= 0) {
            await parseAndApplyState(chatId, userId, String(Math.round(forcedDays)), null, null, null, {
                state: "admin_lookup_set_expiry",
                payload: { inventoryId }
            });
            return null;
        }
        await setState(userId, "admin_lookup_set_expiry", { inventoryId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┌å┘å╪» ╪▒┘ê╪▓ ╪º┘å┘é╪╢╪º ╪¬┘å╪╕█î┘à ╪┤┘ê╪»╪ƒ\n0 = ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º",
            reply_markup: { inline_keyboard: [[cancelButton("admin_lookup_action_cancel")]] }
        });
        return null;
    }
    if (data === "admin_lookup_action_cancel") {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪╣┘à┘ä█î╪º╪¬ ╪º╪¿╪▓╪º╪▒ ┌⌐╪º┘å┘ü█î┌» ┘ä╪║┘ê ╪┤╪»." });
        return null;
    }
    if (data.startsWith("admin_panel_add_data_")) {
        const payload = data.replace("admin_panel_add_data_", "");
        const firstUnderscore = payload.indexOf("_");
        const panelId = Number(firstUnderscore >= 0 ? payload.slice(0, firstUnderscore) : "0");
        const panelKey = decodeURIComponent(firstUnderscore >= 0 ? payload.slice(firstUnderscore + 1) : "");
        if (!Number.isFinite(panelId) || panelId <= 0 || !panelKey) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ê╪▒┘ê╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪¿╪▒╪º█î ╪º┘ü╪▓┘ê╪»┘å ╪»█î╪¬╪º." });
            return null;
        }
        await setState(userId, "admin_panel_add_data", { panelId, panelKey });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘à┘é╪»╪º╪▒ ╪»█î╪¬╪º█î ╪º╪╢╪º┘ü┘ç ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 500MB █î╪º 2GB",
            reply_markup: { inline_keyboard: [[cancelButton("admin_lookup_action_cancel")]] }
        });
        return null;
    }
    if (data.startsWith("admin_panel_set_data_")) {
        const payload = data.replace("admin_panel_set_data_", "");
        const firstUnderscore = payload.indexOf("_");
        const panelId = Number(firstUnderscore >= 0 ? payload.slice(0, firstUnderscore) : "0");
        const panelKey = decodeURIComponent(firstUnderscore >= 0 ? payload.slice(firstUnderscore + 1) : "");
        if (!Number.isFinite(panelId) || panelId <= 0 || !panelKey) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ê╪▒┘ê╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪¿╪▒╪º█î ╪¬┘å╪╕█î┘à ╪│┘é┘ü ╪»█î╪¬╪º." });
            return null;
        }
        await setState(userId, "admin_panel_set_data", { panelId, panelKey });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪│┘é┘ü ╪»█î╪¬╪º█î ╪¼╪»█î╪» ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 50GB █î╪º 102400MB █î╪º unlimited\n╪¿╪▒╪º█î ┘å╪º┘à╪¡╪»┘ê╪»: unlimited █î╪º 0",
            reply_markup: { inline_keyboard: [[cancelButton("admin_lookup_action_cancel")]] }
        });
        return null;
    }
    if (data.startsWith("admin_panel_reset_data_")) {
        const payload = data.replace("admin_panel_reset_data_", "");
        const firstUnderscore = payload.indexOf("_");
        const panelId = Number(firstUnderscore >= 0 ? payload.slice(0, firstUnderscore) : "0");
        const panelKey = decodeURIComponent(firstUnderscore >= 0 ? payload.slice(firstUnderscore + 1) : "");
        if (!Number.isFinite(panelId) || panelId <= 0 || !panelKey) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ê╪▒┘ê╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪¿╪▒╪º█î ╪▒█î╪│╪¬ ╪»█î╪¬╪º." });
            return null;
        }
        const panelRows = await sql `
      SELECT id, panel_type, base_url, username, password
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!panelRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘à╪▒╪¬╪¿╪╖ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const panel = panelRows[0];
        const panelType = String(panel.panel_type || "");
        let result = { ok: false, message: "┘╛┘å┘ä ┘╛╪┤╪¬█î╪¿╪º┘å█î ┘å┘à█îΓÇî╪┤┘ê╪»." };
        let limitBytes = 0;
        if (isMarzbanLike(panelType)) {
            const found = await lookupMarzbanUser(panel, panelKey);
            if (!found.ok || !found.user) {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return null;
            }
            limitBytes = Math.max(0, Math.round(Number(found.user.data_limit || 0)));
            const username = String(found.user.username || panelKey).trim();
            result = await applyAdminResetUsageOnMarzban(panel, username);
        }
        else if (panelType === "sanaei") {
            const found = await findSanaeiClientByIdentifier(panel, panelKey);
            if (!found.ok || !found.client || !found.inboundId) {
                await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä╪º█î┘å╪¬ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return null;
            }
            const email = String(found.client.email || "").trim();
            if (!email) {
                await tg("sendMessage", { chat_id: chatId, text: "email ┌⌐┘ä╪º█î┘å╪¬ ╪▒┘ê█î ┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
                return null;
            }
            limitBytes = Math.max(0, Math.round(Number(found.client.totalGB || 0)));
            result = await applyAdminResetUsageOnSanaei(panel, Number(found.inboundId), email);
        }
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪▒█î╪│╪¬ ╪»█î╪¬╪º ╪º┘å╪¼╪º┘à ┘å╪┤╪».\n${result.message}` });
            return null;
        }
        await recordForensicEvent({
            inventoryId: null,
            ownerTelegramId: null,
            productId: null,
            panelId,
            panelType,
            panelUserKey: panelKey,
            uuid: extractUuidFromText(panelKey),
            source: "panel_action",
            eventType: "admin_panel_reset_data",
            configValue: null,
            metadata: { adminId: userId, resetBytes: limitBytes, panelResult: result.message }
        });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪╡╪▒┘ü ┌⌐╪º╪▒╪¿╪▒ ╪▒█î╪│╪¬ ╪┤╪» Γ£à\n╪│┘é┘ü ┘ü╪╣┘ä█î: ${limitBytes > 0 ? formatBytesShort(limitBytes) : "┘å╪º┘à╪¡╪»┘ê╪»"}`
        });
        return null;
    }
    if (data.startsWith("admin_panel_set_expiry_")) {
        const payload = data.replace("admin_panel_set_expiry_", "");
        const firstUnderscore = payload.indexOf("_");
        const panelId = Number(firstUnderscore >= 0 ? payload.slice(0, firstUnderscore) : "0");
        const rest = firstUnderscore >= 0 ? payload.slice(firstUnderscore + 1) : "";
        const marker = "_days_";
        const markerIndex = rest.lastIndexOf(marker);
        const maybeDaysRaw = markerIndex >= 0 ? rest.slice(markerIndex + marker.length) : "";
        const maybeDays = Number(maybeDaysRaw);
        const panelKeyEncoded = markerIndex >= 0 && Number.isFinite(maybeDays) ? rest.slice(0, markerIndex) : rest;
        const panelKey = decodeURIComponent(panelKeyEncoded);
        if (!Number.isFinite(panelId) || panelId <= 0 || !panelKey) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ê╪▒┘ê╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪¿╪▒╪º█î ╪¬┘å╪╕█î┘à ╪º┘å┘é╪╢╪º." });
            return null;
        }
        if (Number.isFinite(maybeDays) && maybeDays >= 0) {
            await parseAndApplyState(chatId, userId, String(Math.round(maybeDays)), null, null, null, {
                state: "admin_panel_set_expiry",
                payload: { panelId, panelKey }
            });
            return null;
        }
        await setState(userId, "admin_panel_set_expiry", { panelId, panelKey });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┌å┘å╪» ╪▒┘ê╪▓ ╪º┘å┘é╪╢╪º ╪¬┘å╪╕█î┘à ╪┤┘ê╪»╪ƒ\n0 = ╪¿╪»┘ê┘å ╪º┘å┘é╪╢╪º",
            reply_markup: { inline_keyboard: [[cancelButton("admin_lookup_action_cancel")]] }
        });
        return null;
    }
    // Toggle client on panel (admin_panel_toggle_{id}_{encodedKey}). Must run AFTER numeric
    // admin_panel_toggle_{id}, admin_panel_toggle_move_, and admin_panel_toggle_sales_ ΓÇö otherwise
    // those callbacks are misparsed (panel id becomes 0 / key empty ΓåÆ ┬½┘ê╪▒┘ê╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒...┬╗).
    if (data.startsWith("admin_panel_toggle_") &&
        !data.startsWith("admin_panel_toggle_move_") &&
        !data.startsWith("admin_panel_toggle_sales_") &&
        !/^admin_panel_toggle_\d+$/.test(data)) {
        const userToggleMatch = data.match(/^admin_panel_toggle_(\d+)_(.+)$/);
        const panelId = userToggleMatch ? Number(userToggleMatch[1]) : NaN;
        const key = userToggleMatch ? decodeURIComponent(userToggleMatch[2]) : "";
        const rows = await sql `
      SELECT id, panel_type, base_url, username, password, subscription_public_port
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!userToggleMatch || !Number.isFinite(panelId) || panelId <= 0 || !rows.length || !key) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ê╪▒┘ê╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪¿╪▒╪º█î ╪¬╪║█î█î╪▒ ┘ê╪╢╪╣█î╪¬ ┘╛┘å┘ä." });
            return null;
        }
        const panelType = String(rows[0].panel_type || "");
        let willEnable = true;
        if (isMarzbanLike(panelType)) {
            const found = await lookupMarzbanUser(rows[0], key);
            if (!found.ok || !found.user) {
                await tg("sendMessage", { chat_id: chatId, text: `┘╛█î╪»╪º ┘å╪┤╪»: ${found.message}` });
                return null;
            }
            willEnable = found.user.status === "disabled";
            const result = await toggleMarzbanUser(rows[0], key, willEnable);
            if (!result.ok) {
                await tg("sendMessage", { chat_id: chatId, text: `╪╣┘à┘ä█î╪º╪¬ ┘╛┘å┘ä ┘å╪º┘à┘ê┘ü┘é: ${result.message}` });
                return null;
            }
        }
        else {
            const found = await findSanaeiClientByIdentifier(rows[0], key);
            if (!found.ok || !found.client) {
                await tg("sendMessage", { chat_id: chatId, text: `┘╛█î╪»╪º ┘å╪┤╪»: ${found.message}` });
                return null;
            }
            willEnable = found.client.enable === false;
            const result = await toggleSanaeiClient(rows[0], key, willEnable);
            if (!result.ok) {
                await tg("sendMessage", { chat_id: chatId, text: `╪╣┘à┘ä█î╪º╪¬ ┘╛┘å┘ä ┘å╪º┘à┘ê┘ü┘é: ${result.message}` });
                return null;
            }
        }
        await recordForensicEvent({
            inventoryId: null,
            ownerTelegramId: null,
            productId: null,
            panelId,
            panelType,
            panelUserKey: key,
            uuid: extractUuidFromText(key),
            source: "panel_action",
            eventType: willEnable ? "admin_enable_panel_only" : "admin_disable_panel_only",
            configValue: null,
            metadata: { adminId: userId }
        });
        await tg("sendMessage", { chat_id: chatId, text: `┘ê╪╢╪╣█î╪¬ ┌⌐╪º╪▒╪¿╪▒ ╪»╪▒ ┘╛┘å┘ä ╪¬╪║█î█î╪▒ █î╪º┘ü╪¬ (${willEnable ? '┘ü╪╣╪º┘ä' : '╪║█î╪▒┘ü╪╣╪º┘ä'}) Γ£à` });
        return null;
    }
    if (data.startsWith("admin_panel_rv_")) {
        const isConfirmed = data.includes("_confirm");
        const payloadRaw = isConfirmed ? data.replace("admin_panel_rv_", "").replace("_confirm", "") : data.replace("admin_panel_rv_", "");
        if (!isConfirmed) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: `ΓÜá∩╕Å ╪ó█î╪º ╪º╪▓ ╪¿╪º╪▓╪│╪º╪▓█î ┘ä█î┘å┌⌐ ╪º█î┘å ┌⌐╪º╪▒╪¿╪▒ ╪▒┘ê█î ┘╛┘å┘ä ╪º╪╖┘à█î┘å╪º┘å ╪»╪º╪▒█î╪»╪ƒ`,
                reply_markup: {
                    inline_keyboard: [
                        [
                            cb("Γ£à ╪¬╪º█î█î╪»", `admin_panel_rv_${payloadRaw}_confirm`, "primary"),
                            cb("Γ¥î ╪º┘å╪╡╪▒╪º┘ü", "admin_lookup_action_cancel", "danger")
                        ]
                    ]
                }
            });
            return null;
        }
        const payload = payloadRaw;
        const firstUnderscore = payload.indexOf("_");
        const panelId = Number(firstUnderscore >= 0 ? payload.slice(0, firstUnderscore) : "0");
        const key = decodeURIComponent(firstUnderscore >= 0 ? payload.slice(firstUnderscore + 1) : "");
        const rows = await sql `
      SELECT id, panel_type, base_url, username, password, subscription_public_port, subscription_public_host, subscription_link_protocol, config_public_host
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!rows.length || !key) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ê╪▒┘ê╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪¿╪▒╪º█î ╪¿╪º╪▓╪│╪º╪▓█î ┘ä█î┘å┌⌐ ┘╛┘å┘ä." });
            return null;
        }
        const panelType = String(rows[0].panel_type || "");
        const result = isMarzbanLike(panelType) ? await regenerateMarzbanUserLink(rows[0], key) : await regenerateSanaeiClientLink(rows[0], key);
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪¿╪º╪▓╪│╪º╪▓█î ┘ä█î┘å┌⌐ ┘╛┘å┘ä ┘å╪º┘à┘ê┘ü┘é: ${result.message}` });
            return null;
        }
        let newLinkMsg = "";
        if (isMarzbanLike(panelType)) {
            const u = result.user;
            const links = Array.isArray(u.links) ? u.links.map((x) => String(x || "").trim()).filter(Boolean) : [];
            const subUrl = u.subscription_url ? resolveMarzbanSubUrl(String(rows[0].base_url), String(u.subscription_url)) : "";
            newLinkMsg = subUrl || links[0] || "";
        }
        else {
            const panelConfigRows = await sql `
        SELECT p.panel_config 
        FROM products p
        JOIN inventory i ON i.product_id = p.id
        WHERE i.panel_id = ${panelId} AND (i.delivery_payload->'metadata'->>'uuid' = ${key} OR i.delivery_payload->'metadata'->>'email' = ${key} OR i.delivery_payload->'metadata'->>'subId' = ${key} OR i.config_value ILIKE ${'%' + key + '%'})
        LIMIT 1;
      `;
            const panelConfig = panelConfigRows.length ? (typeof panelConfigRows[0].panel_config === "string" ? parseJsonObject(panelConfigRows[0].panel_config) : panelConfigRows[0].panel_config) || {} : {};
            const mergedCfg = mergeSanaeiPanelRowIntoClientConfig(panelConfig, rows[0]);
            const newConfigLinks = buildSanaeiConfigLinks(String(rows[0].base_url), result.inbound, result.client, mergedCfg);
            const subId = String(result.client?.subId || "");
            const subUrl = subId ? buildSanaeiSubscriptionUrl(String(rows[0].base_url), panelConfig, subId, rows[0]) : "";
            newLinkMsg = subUrl || newConfigLinks[0] || "";
        }
        await recordForensicEvent({
            inventoryId: null,
            ownerTelegramId: null,
            productId: null,
            panelId,
            panelType,
            panelUserKey: key,
            uuid: extractUuidFromText(key),
            source: "panel_action",
            eventType: "admin_revoke_panel_only",
            configValue: null,
            metadata: { adminId: userId }
        });
        await tg("sendMessage", { chat_id: chatId, text: `┘ä█î┘å┌⌐ ╪¼╪»█î╪» ╪│╪º╪«╪¬┘ç ╪┤╪» Γ£à\n\n${newLinkMsg}` });
        return null;
    }
    if (data.startsWith("admin_panel_del_")) {
        const isConfirmed = data.includes("_confirm");
        const payloadRaw = isConfirmed ? data.replace("admin_panel_del_", "").replace("_confirm", "") : data.replace("admin_panel_del_", "");
        if (!isConfirmed) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: `≡ƒº¿ ╪«╪╖╪▒! ╪ó█î╪º ╪º╪▓ ╪¡╪░┘ü ┌⌐╪º┘à┘ä ╪º█î┘å ┌⌐╪º╪▒╪¿╪▒ ╪º╪▓ ┘╛┘å┘ä ╪º╪╖┘à█î┘å╪º┘å ╪»╪º╪▒█î╪»╪ƒ\n╪º█î┘å ╪╣┘à┘ä ┘é╪º╪¿┘ä ╪¿╪º╪▓┌»╪┤╪¬ ┘å█î╪│╪¬.`,
                reply_markup: {
                    inline_keyboard: [
                        [
                            cb("≡ƒöÑ ╪¡╪░┘ü ┌⌐╪º┘à┘ä", `admin_panel_del_${payloadRaw}_confirm`, "danger"),
                            cb("Γ¥î ╪º┘å╪╡╪▒╪º┘ü", "admin_lookup_action_cancel", "primary")
                        ]
                    ]
                }
            });
            return null;
        }
        const payload = payloadRaw;
        const firstUnderscore = payload.indexOf("_");
        const panelId = Number(firstUnderscore >= 0 ? payload.slice(0, firstUnderscore) : "0");
        const key = decodeURIComponent(firstUnderscore >= 0 ? payload.slice(firstUnderscore + 1) : "");
        const rows = await sql `
      SELECT id, panel_type, base_url, username, password, subscription_public_port
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!rows.length || !key) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ê╪▒┘ê╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪¿╪▒╪º█î ╪¡╪░┘ü ┘╛┘å┘ä." });
            return null;
        }
        const panelType = String(rows[0].panel_type || "");
        const deliveryPayload = parseDeliveryPayload(rows[0].delivery_payload);
        let result = { ok: false, message: "unknown panel type" };
        if (deliveryPayload.type === "pingchi") {
            result = await pingchiApi("services.delete", { username: key });
        }
        else {
            result = isMarzbanLike(panelType) ? await deleteMarzbanUser(rows[0], key) : await revokeSanaeiClient(rows[0], key);
        }
        if (!result.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪¡╪░┘ü ╪»╪▒ ┘╛┘å┘ä ┘å╪º┘à┘ê┘ü┘é: ${result.message}` });
            return null;
        }
        await recordForensicEvent({
            inventoryId: null,
            ownerTelegramId: null,
            productId: null,
            panelId,
            panelType,
            panelUserKey: key,
            uuid: extractUuidFromText(key),
            source: "panel_action",
            eventType: "admin_delete_panel_only",
            configValue: null,
            metadata: { adminId: userId }
        });
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪░┘ü/╪║█î╪▒┘ü╪╣╪º┘ä╪│╪º╪▓█î ╪»╪▒ ┘╛┘å┘ä ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_panel") {
        await sendAdminPanel(chatId);
        return null;
    }
    if (data === "admin_panels") {
        await showPanelAdminMenu(chatId);
        return null;
    }
    if (data === "admin_panel_add") {
        await promptPanelTypePicker(chatId, "add");
        return null;
    }
    if (/^noop_panel_\d+$/.test(data)) {
        const panelId = Number((data.match(/\d+$/) || ["0"])[0]);
        await showPanelDetails(chatId, panelId);
        return null;
    }
    if (data.startsWith("admin_panel_open_")) {
        const panelId = Number((data.match(/\d+$/) || ["0"])[0]);
        await clearState(userId);
        await showPanelDetails(chatId, panelId);
        return null;
    }
    if (data.startsWith("admin_panel_set_subport_")) {
        const panelId = Number(data.replace("admin_panel_set_subport_", ""));
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const panel = await getPanelById(panelId);
        if (!panel || String(panel.panel_type) !== "sanaei") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌»╪▓█î┘å┘ç ┘ü┘é╪╖ ╪¿╪▒╪º█î ┘╛┘å┘ä Sanaei / 3x-ui ╪º╪│╪¬." });
            return null;
        }
        const cur = panel.subscription_public_port != null && Number(panel.subscription_public_port) > 0
            ? String(panel.subscription_public_port)
            : "╪«┘ê╪»┌⌐╪º╪▒ (┘╛┘ê╪▒╪¬ ╪ó╪»╪▒╪│ ┘╛┘å┘ä)";
        await setState(userId, "admin_panel_subport_edit", { panelId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒöó ┘╛┘ê╪▒╪¬ ╪╣┘à┘ê┘à█î ┘ä█î┘å┌⌐ ╪│╪º╪¿╪│┌⌐╪▒█î┘╛╪┤┘å\n┘╛┘å┘ä: ${panel.name}\n┘ü╪╣┘ä█î: ${cur}\n\n` +
                `╪╣╪»╪» █▒ΓÇô█╢█╡█╡█│█╡ ╪¿┘ü╪▒╪│╪¬█î╪» (┘à╪½┘ä╪º┘ï 8080).\n0 █î╪º auto = ┘ç┘à╪º┘å ┘╛┘ê╪▒╪¬ ╪ó╪»╪▒╪│ ┘╛┘å┘ä\n- = ╪º┘å╪╡╪▒╪º┘ü`,
            reply_markup: { inline_keyboard: [[{ text: "Γ¥î ╪º┘å╪╡╪▒╪º┘ü", callback_data: `admin_panel_open_${panelId}` }]] }
        });
        return null;
    }
    if (data.startsWith("admin_panel_set_suburl_")) {
        const panelId = Number(data.replace("admin_panel_set_suburl_", ""));
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const panel = await getPanelById(panelId);
        if (!panel || String(panel.panel_type) !== "sanaei") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌»╪▓█î┘å┘ç ┘ü┘é╪╖ ╪¿╪▒╪º█î ┘╛┘å┘ä Sanaei / 3x-ui ╪º╪│╪¬." });
            return null;
        }
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒöù ╪»╪º┘à┘å┘ç ┘ê ┘╛╪▒┘ê╪¬┌⌐┘ä ┘ä█î┘å┌⌐ ╪│╪º╪¿╪│┌⌐╪▒█î┘╛╪┤┘å\n┘╛┘å┘ä: ${panel.name}\n\n` +
                `█▒) ┘╛╪▒┘ê╪¬┌⌐┘ä ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪».\n` +
                `█▓) ╪│┘╛╪│ ┘ü┘é╪╖ ┘å╪º┘à ┘à█î╪▓╪¿╪º┘å ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪» (┘à╪½╪º┘ä: sub.example.com).\n\n` +
                `╪»╪▒ ┘à╪▒╪¡┘ä┘ç┘ö ╪»┘ê┘à: 0 █î╪º auto = ┘ç┘à╪º┘å hostname ╪ó╪»╪▒╪│ ┘╛┘å┘ä\n- = ╪º┘å╪╡╪▒╪º┘ü`,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "HTTPS", callback_data: `admin_panel_suburl_proto_${panelId}_https` },
                        { text: "HTTP", callback_data: `admin_panel_suburl_proto_${panelId}_http` }
                    ],
                    [{ text: "┘ç┘à╪º┘å ┘╛╪▒┘ê╪¬┌⌐┘ä ╪ó╪»╪▒╪│ ┘╛┘å┘ä", callback_data: `admin_panel_suburl_proto_${panelId}_def` }],
                    [{ text: "Γ¥î ╪º┘å╪╡╪▒╪º┘ü", callback_data: `admin_panel_open_${panelId}` }]
                ]
            }
        });
        return null;
    }
    const suburlProtoMatch = data.match(/^admin_panel_suburl_proto_(\d+)_(https|http|def)$/);
    if (suburlProtoMatch) {
        const panelId = Number(suburlProtoMatch[1]);
        const protoKey = suburlProtoMatch[2];
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const panel = await getPanelById(panelId);
        if (!panel || String(panel.panel_type) !== "sanaei") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌»╪▓█î┘å┘ç ┘ü┘é╪╖ ╪¿╪▒╪º█î ┘╛┘å┘ä Sanaei / 3x-ui ╪º╪│╪¬." });
            return null;
        }
        const subscriptionLinkProtocol = protoKey === "def" ? null : protoKey;
        await setState(userId, "admin_panel_suburl_host_edit", { panelId, subscriptionLinkProtocol });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘å╪º┘à ┘à█î╪▓╪¿╪º┘å ┘ä█î┘å┌⌐ ╪│╪º╪¿ ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪» (╪¿╪»┘ê┘å https://).\n` +
                `┘╛╪▒┘ê╪¬┌⌐┘ä ╪º┘å╪¬╪«╪º╪¿ΓÇî╪┤╪»┘ç: ${protoKey === "def" ? "┘ç┘à╪º┘å ╪ó╪»╪▒╪│ ┘╛┘å┘ä" : protoKey.toUpperCase()}\n\n` +
                `0 █î╪º auto = ┘ç┘à╪º┘å hostname ╪ó╪»╪▒╪│ ┘╛┘å┘ä\n- = ╪º┘å╪╡╪▒╪º┘ü`,
            reply_markup: { inline_keyboard: [[{ text: "Γ¥î ╪º┘å╪╡╪▒╪º┘ü", callback_data: `admin_panel_open_${panelId}` }]] }
        });
        return null;
    }
    if (data.startsWith("admin_panel_set_confighost_")) {
        const panelId = Number(data.replace("admin_panel_set_confighost_", ""));
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const panel = await getPanelById(panelId);
        if (!panel || String(panel.panel_type) !== "sanaei") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌»╪▓█î┘å┘ç ┘ü┘é╪╖ ╪¿╪▒╪º█î ┘╛┘å┘ä Sanaei / 3x-ui ╪º╪│╪¬." });
            return null;
        }
        const cur = String(panel.config_public_host || "").trim() || "╪¬╪┤╪«█î╪╡ ╪«┘ê╪»┌⌐╪º╪▒ (┘à╪¡╪╡┘ê┘ä/┘╛┘å┘ä)";
        await setState(userId, "admin_panel_confighost_edit", { panelId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒîÉ ╪»╪º┘à┘å┘ç┘ö ┘å┘à╪º█î╪┤ ╪»╪▒ ┘ä█î┘å┌⌐ ┌⌐╪º┘å┘ü█î┌» (vless/vmess/ΓÇª)\n┘╛┘å┘ä: ${panel.name}\n┘ü╪╣┘ä█î: ${cur}\n\n` +
                `┘ü┘é╪╖ ┘å╪º┘à ┘à█î╪▓╪¿╪º┘å ╪¿┘ü╪▒╪│╪¬█î╪» (┘à╪½╪º┘ä: v-panel.example.com)\n` +
                `0 █î╪º auto = ╪¬╪┤╪«█î╪╡ ╪«┘ê╪»┌⌐╪º╪▒\n- = ╪º┘å╪╡╪▒╪º┘ü`,
            reply_markup: { inline_keyboard: [[{ text: "Γ¥î ╪º┘å╪╡╪▒╪º┘ü", callback_data: `admin_panel_open_${panelId}` }]] }
        });
        return null;
    }
    if (data.startsWith("admin_panel_import_sanaei_backup_")) {
        const panelId = Number(data.replace("admin_panel_import_sanaei_backup_", ""));
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const panel = await getPanelById(panelId);
        if (!panel || String(panel.panel_type) !== "sanaei") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ┌»╪▓█î┘å┘ç ┘ü┘é╪╖ ╪¿╪▒╪º█î ┘╛┘å┘ä Sanaei / 3x-ui ╪º╪│╪¬." });
            return null;
        }
        const existing = await getSetting(`sanaei_inbound_backup_${panelId}`);
        let existingInfo = "";
        if (existing) {
            try {
                const arr = JSON.parse(existing);
                let clientCount = 0;
                for (const ib of arr) {
                    const ibObj = ib;
                    const s = toJsonObject(parseSanaeiNested(ibObj.settings)) || {};
                    clientCount += Array.isArray(s.clients) ? s.clients.length : 0;
                }
                existingInfo = `\n\n╪¿┌⌐╪º┘╛ ┘ü╪╣┘ä█î: ${arr.length} inbound | ${clientCount} ┌⌐┘ä╪º█î┘å╪¬`;
            }
            catch {
                existingInfo = "\n\n╪¿┌⌐╪º┘╛ ┘ü╪╣┘ä█î: ┘à┘ê╪¼┘ê╪» (┘å╪º┘à╪╣╪¬╪¿╪▒)";
            }
        }
        const token = generateAdminToken(userId);
        const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        const webLink = `${callbackBase}/inbound-import.html?token=${encodeURIComponent(token)}&panelId=${panelId}`;
        await setState(userId, "admin_import_sanaei_backup", { panelId });
        await tg("sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            text: `≡ƒôÑ ┘ê╪º╪▒╪» ┌⌐╪▒╪»┘å ╪¿┌⌐╪º┘╛ inbound ╪¿╪▒╪º█î ┘╛┘å┘ä: ${escapeHtml(String(panel.name || ""))}${escapeHtml(existingInfo)}\n\n` +
                `┌»╪▓█î┘å┘ç █▒ ΓÇö ╪╡┘ü╪¡┘ç ┘ê╪¿ (╪¬┘ê╪╡█î┘ç ╪┤╪»┘ç ╪¿╪▒╪º█î ┘ü╪º█î┘äΓÇî┘ç╪º█î ╪¿╪▓╪▒┌»):\n<code>${escapeHtml(webLink)}</code>\n\n` +
                `┌»╪▓█î┘å┘ç █▓ ΓÇö ╪º╪▒╪│╪º┘ä JSON ┘à╪│╪¬┘é█î┘à ╪»╪▒ ┘ç┘à█î┘å ┌å╪¬ (╪¿╪▒╪º█î ┘ü╪º█î┘äΓÇî┘ç╪º█î ┌⌐┘ê┌å┌⌐)\n` +
                `(╪º╪▓ ┘à╪│█î╪▒ Inbounds ΓåÆ Export █î╪º API /panel/api/inbounds/list)\n` +
                `- = ╪º┘å╪╡╪▒╪º┘ü`,
            reply_markup: { inline_keyboard: [[{ text: "Γ¥î ╪º┘å╪╡╪▒╪º┘ü", callback_data: `admin_panel_open_${panelId}` }]] }
        });
        return null;
    }
    if (data.startsWith("admin_panel_edit_")) {
        const panelId = Number(data.replace("admin_panel_edit_", ""));
        const panel = await getPanelById(panelId);
        if (!panel) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        await promptPanelTypePicker(chatId, "edit", panelId);
        return null;
    }
    if (data === "admin_panel_wizard_cancel") {
        await clearState(userId);
        await showPanelAdminMenu(chatId, "╪½╪¿╪¬ ┘╛┘å┘ä ┘ä╪║┘ê ╪┤╪».");
        return null;
    }
    if (data.startsWith("admin_panel_wizard_cancel_")) {
        const panelId = Number(data.replace("admin_panel_wizard_cancel_", ""));
        await clearState(userId);
        await showPanelDetails(chatId, panelId, "┘ê█î╪▒╪º█î╪┤ ┘╛┘å┘ä ┘ä╪║┘ê ╪┤╪».");
        return null;
    }
    if (data.startsWith("admin_panel_pick_type_add_")) {
        const panelType = parsePanelType(data.replace("admin_panel_pick_type_add_", ""));
        if (!panelType) {
            await tg("sendMessage", { chat_id: chatId, text: "┘å┘ê╪╣ ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        await startPanelWizard(chatId, userId, "add", panelType);
        return null;
    }
    if (data.startsWith("admin_panel_pick_type_edit_")) {
        const payload = data.replace("admin_panel_pick_type_edit_", "");
        const [panelIdRaw, panelTypeRaw] = payload.split("_");
        const panelId = Number(panelIdRaw);
        const panelType = parsePanelType(panelTypeRaw || "");
        if (!Number.isFinite(panelId) || panelId <= 0 || !panelType) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º╪╖┘ä╪º╪╣╪º╪¬ ┘ê█î╪▒╪º█î╪┤ ┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        await startPanelWizard(chatId, userId, "edit", panelType, panelId);
        return null;
    }
    if (/^admin_panel_toggle_\d+$/.test(data)) {
        const panelId = Number(data.replace("admin_panel_toggle_", ""));
        await sql `UPDATE panels SET active = NOT active WHERE id = ${panelId};`;
        await showPanelDetails(chatId, panelId, "┘ê╪╢╪╣█î╪¬ ┘╛┘å┘ä ╪¬╪║█î∩┐╜∩┐╜╪▒ ┌⌐╪▒╪» Γ£à");
        return null;
    }
    if (data.startsWith("admin_panel_toggle_move_")) {
        const panelId = Number(data.replace("admin_panel_toggle_move_", ""));
        await sql `UPDATE panels SET allow_customer_migration = NOT allow_customer_migration WHERE id = ${panelId};`;
        await showPanelDetails(chatId, panelId, "┘ê╪╢╪╣█î╪¬ ┘à┘ç╪º╪¼╪▒╪¬ ┌⌐╪º╪▒╪¿╪▒ ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à");
        return null;
    }
    if (data.startsWith("admin_panel_toggle_sales_")) {
        const panelId = Number(data.replace("admin_panel_toggle_sales_", ""));
        await sql `UPDATE panels SET allow_new_sales = NOT allow_new_sales WHERE id = ${panelId};`;
        await showPanelDetails(chatId, panelId, "┘ê╪╢╪╣█î╪¬ ┘ü╪▒┘ê╪┤ ╪¼╪»█î╪» ╪º█î┘å ┘╛┘å┘ä ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à");
        return null;
    }
    if (data === "admin_panel_test_all") {
        const rows = await sql `
      SELECT id, name
      FROM panels
      ORDER BY priority DESC, id ASC;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ç┘å┘ê╪▓ ┘ç█î┌å ┘╛┘å┘ä█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        const results = [];
        let okCount = 0;
        for (const row of rows) {
            const result = await testPanelConnection(Number(row.id));
            if (result.ok)
                okCount += 1;
            results.push(`${row.name}: ${result.ok ? "Γ£à" : "Γ¥î"}`);
        }
        await showPanelAdminMenu(chatId, `╪¬╪│╪¬ ┘ç┘à┘ç ┘╛┘å┘äΓÇî┘ç╪º ╪º┘å╪¼╪º┘à ╪┤╪».\n┘à┘ê┘ü┘é: ${okCount}/${rows.length}\n${results.join("\n")}`);
        return null;
    }
    if (data.startsWith("admin_panel_test_")) {
        const panelId = Number(data.replace("admin_panel_test_", ""));
        const result = await testPanelConnection(panelId);
        await showPanelDetails(chatId, panelId, result.message);
        return null;
    }
    if (data.startsWith("admin_panel_cache_")) {
        const panelId = Number(data.replace("admin_panel_cache_", ""));
        const rows = await sql `
      SELECT name, last_check_at, last_check_ok, last_check_message, cached_meta
      FROM panels
      WHERE id = ${panelId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const p = rows[0];
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┌⌐╪┤ ┘╛┘å┘ä: ${p.name}\n` +
                `╪ó╪«╪▒█î┘å ╪¬╪│╪¬: ${p.last_check_at || "-"}\n` +
                `┘å╪¬█î╪¼┘ç: ${panelResultLabel(p.last_check_ok)}\n` +
                `┘╛█î╪º┘à: ${p.last_check_message || "-"}\n` +
                `meta: ${JSON.stringify(p.cached_meta || {}, null, 2)}`,
            reply_markup: {
                inline_keyboard: [[backButton(`admin_panel_open_${panelId}`, "≡ƒöÖ ╪¿╪º╪▓┌»╪┤╪¬ ╪¿┘ç ┘╛┘å┘ä")]]
            }
        });
        return null;
    }
    if (data.startsWith("admin_panel_remove_yes_")) {
        const panelId = Number(data.replace("admin_panel_remove_yes_", ""));
        try {
            await sql `DELETE FROM panels WHERE id = ${panelId};`;
            await showPanelAdminMenu(chatId, "┘╛┘å┘ä ╪¡╪░┘ü ╪┤╪» Γ£à");
        }
        catch (err) {
            logError("admin_panel_delete_failed", err, { panelId, adminId: userId });
            await tg("sendMessage", { chat_id: chatId, text: `Γ¥î ╪¡╪░┘ü ┘╛┘å┘ä ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪». ┘à┘à┌⌐┘å ╪º╪│╪¬ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º █î╪º ┘à╪¡╪╡┘ê┘ä╪º╪¬█î ╪¿┘ç ╪ó┘å ┘à╪¬╪╡┘ä ╪¿╪º╪┤┘å╪».\n${err.message}` });
        }
        return null;
    }
    if (data.startsWith("admin_panel_remove_")) {
        const panelId = Number(data.replace("admin_panel_remove_", ""));
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪º╪▓ ╪¡╪░┘ü ╪º█î┘å ┘╛┘å┘ä ┘à╪╖┘à╪ª┘å ┘ç╪│╪¬█î╪»╪ƒ",
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("≡ƒùæ ╪¡╪░┘ü", `admin_panel_remove_yes_${panelId}`, "danger"),
                        cb("Γ¥î ╪«█î╪▒", `admin_panel_open_${panelId}`, "primary")
                    ]
                ]
            }
        });
        return null;
    }
    if (data === "admin_dead_configs") {
        const token = generateAdminToken(userId);
        const domain = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "localhost:3000";
        const protocol = domain.includes("localhost") ? "http" : "https";
        const link = `${protocol}://${domain}/cleanup.html?token=${token}`;
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒöÄ █î╪º┘ü╪¬┘å ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î ┘à╪▒╪»┘ç\n\n` +
                `╪º█î┘å ╪º╪¿╪▓╪º╪▒ ┘ü┘é╪╖ ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º ╪▒╪º ╪»╪▒ ┘╛┘å┘äΓÇî┘ç╪º█î ╪┤┘à╪º ╪¼╪│╪¬╪¼┘ê ┘à█îΓÇî┌⌐┘å╪» ┘ê ╪¬╪║█î█î╪▒█î ╪º█î╪¼╪º╪» ┘å┘à█îΓÇî┌⌐┘å╪».\n` +
                `╪¿╪▒╪º█î ╪¼┘ä┘ê┌»█î╪▒█î ╪º╪▓ ╪¬╪º█î┘àΓÇî╪º┘ê╪¬╪î ╪º╪│┌⌐┘å ╪º╪▓ ╪╖╪▒█î┘é ┘à╪▒┘ê╪▒┌»╪▒ ╪º┘å╪¼╪º┘à ┘à█îΓÇî╪┤┘ê╪».\n` +
                `┘ä█î┘å┌⌐ ╪▓█î╪▒ ┘ü┘é╪╖ ╪¬╪º █▓ ╪│╪º╪╣╪¬ ╪º╪╣╪¬╪¿╪º╪▒ ╪»╪º╪▒╪»:\n\n` +
                `<code>${escapeHtml(link)}</code>`,
            parse_mode: "HTML"
        });
        return null;
    }
    if (data === "admin_migrations") {
        const rows = await sql `
      SELECT m.id, m.requested_for, m.source_inventory_id, p.name AS target_panel_name, m.requested_by_role, m.status
      FROM panel_migrations m
      INNER JOIN panels p ON p.id = m.target_panel_id
      WHERE m.status = 'pending'
      ORDER BY m.id DESC
      LIMIT 30;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘å╪¬┘é╪º┘ä ╪¿╪º╪▓ ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪»." });
            return null;
        }
        const keyboard = rows.map((m) => [
            {
                text: `#${m.id} | ┌⌐╪º╪▒╪¿╪▒ ${m.requested_for} | ${m.target_panel_name} | ${m.requested_by_role}`,
                callback_data: `admin_migration_open_${m.id}`
            }
        ]);
        keyboard.push([backButton("admin_panels")]);
        await tg("sendMessage", { chat_id: chatId, text: "╪╡┘ü ╪º┘å╪¬┘é╪º┘äΓÇî┘ç╪º:", reply_markup: { inline_keyboard: keyboard } });
        return null;
    }
    if (data.startsWith("admin_migration_open_")) {
        const migrationId = Number(data.replace("admin_migration_open_", ""));
        const rows = await sql `
      SELECT
        m.id,
        m.status,
        m.requested_for,
        m.source_inventory_id,
        m.source_config_snapshot,
        p.name AS target_panel_name
      FROM panel_migrations m
      INNER JOIN panels p ON p.id = m.target_panel_id
      WHERE m.id = ${migrationId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪»╪▒╪«┘ê╪º╪│╪¬ █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const r = rows[0];
        await tg("sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            text: `╪»╪▒╪«┘ê╪º╪│╪¬ #${r.id}\n` +
                `┘ê╪╢╪╣█î╪¬: ${r.status}\n` +
                `┌⌐╪º╪▒╪¿╪▒: ${r.requested_for}\n` +
                `┌⌐╪º┘å┘ü█î┌» ┘à╪¿╪»╪º: ${r.source_inventory_id}\n` +
                `┘╛┘å┘ä ┘à┘é╪╡╪»: ${r.target_panel_name}\n\n` +
                `${escapeHtml(String(r.source_config_snapshot || "-"))}`,
            reply_markup: {
                inline_keyboard: [
                    [cb("ΓÜí ╪º┘å╪¬┘é╪º┘ä ╪¿╪º ┘ç┘à╪º┘å ┌⌐╪º┘å┘ü█î┌»", `admin_migration_auto_${r.id}`, "success")],
                    [cb("Γ£ì∩╕Å ╪½╪¿╪¬ ┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪»", `admin_migration_manual_${r.id}`, "primary")],
                    [cb("Γ¥î ╪▒╪» ╪»╪▒╪«┘ê╪º╪│╪¬", `admin_migration_reject_${r.id}`, "danger")],
                    [backButton("admin_migrations")]
                ]
            }
        });
        return null;
    }
    if (data.startsWith("admin_migration_auto_")) {
        const migrationId = Number(data.replace("admin_migration_auto_", ""));
        const result = await completeMigration(migrationId, userId, null);
        await tg("sendMessage", { chat_id: chatId, text: result.ok ? "╪º┘å╪¬┘é╪º┘ä ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à" : `╪«╪╖╪º: ${result.reason}` });
        return null;
    }
    if (data.startsWith("admin_migration_manual_")) {
        const migrationId = Number(data.replace("admin_migration_manual_", ""));
        await setState(userId, "admin_complete_migration_config", { migrationId });
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ╪¼╪»█î╪» ┘à┘é╪╡╪» ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
        return null;
    }
    if (data.startsWith("admin_migration_reject_")) {
        const migrationId = Number(data.replace("admin_migration_reject_", ""));
        const rows = await sql `
      UPDATE panel_migrations
      SET status = 'rejected', processed_at = NOW(), processed_by = ${userId}
      WHERE id = ${migrationId} AND status = 'pending'
      RETURNING requested_for;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪»╪▒╪«┘ê╪º╪│╪¬ ┘é╪º╪¿┘ä ╪▒╪» ┘å█î╪│╪¬." });
            return null;
        }
        await tg("sendMessage", { chat_id: Number(rows[0].requested_for), text: `╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘å╪¬┘é╪º┘ä #${migrationId} ╪▒╪» ╪┤╪» Γ¥î` });
        await tg("sendMessage", { chat_id: chatId, text: "╪»╪▒╪«┘ê╪º╪│╪¬ ╪▒╪» ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_products" || data.startsWith("admin_products_page_")) {
        let page = 0;
        if (data.startsWith("admin_products_page_")) {
            page = Math.max(0, parseInt(data.replace("admin_products_page_", ""), 10) || 0);
        }
        await listProductsForAdmin(chatId, userId, page);
        return null;
    }
    if (data === "admin_products_show_archived") {
        await setSetting(`admin_products_show_archived_${userId}`, "true");
        await listProductsForAdmin(chatId, userId);
        return null;
    }
    if (data === "admin_products_hide_archived") {
        await setSetting(`admin_products_show_archived_${userId}`, "false");
        await listProductsForAdmin(chatId, userId);
        return null;
    }
    if (data === "admin_add_product") {
        await startProductWizard(chatId, userId, "add");
        return null;
    }
    if (data.startsWith("admin_edit_product_")) {
        const productId = Number(data.replace("admin_edit_product_", ""));
        await startProductWizard(chatId, userId, "edit", productId);
        return null;
    }
    if (data.startsWith("admin_product_wizard_cancel_")) {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪½╪¿╪¬/┘ê█î╪▒╪º█î╪┤ ┘à╪¡╪╡┘ê┘ä ┘ä╪║┘ê ╪┤╪»." });
        await listProductsForAdmin(chatId, userId);
        return null;
    }
    if (data === "admin_product_wizard_price_auto") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        if (parseProductKind(state.payload.productKind) === "account") {
            const payload = { ...state.payload, priceMode: "manual", step: "price_toman" };
            await setState(userId, "admin_product_wizard", payload);
            await promptProductWizardStep(chatId, payload);
            return null;
        }
        const payload = { ...state.payload, priceMode: "auto", step: "sell_mode" };
        await setState(userId, "admin_product_wizard", payload);
        await promptProductWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_product_wizard_price_manual") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        const payload = { ...state.payload, priceMode: "manual", step: "price_toman" };
        await setState(userId, "admin_product_wizard", payload);
        await promptProductWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_product_wizard_sell_manual") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        const payload = { ...state.payload, sellMode: "manual", step: "is_infinite" };
        await setState(userId, "admin_product_wizard", payload);
        await promptProductWizardStep(chatId, payload);
        return null;
    }
    if (data.startsWith("admin_product_wizard_pingchi_plan_")) {
        const planId = Number(data.replace("admin_product_wizard_pingchi_plan_", ""));
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        const payload = { ...state.payload, panelConfig: { pingchi_plan_id: planId }, step: "is_infinite" };
        await setState(userId, "admin_product_wizard", payload);
        await promptProductWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_product_wizard_sell_pingchi") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        const payload = { ...state.payload, sellMode: "pingchi", step: "pingchi_plan_id" };
        await setState(userId, "admin_product_wizard", payload);
        await promptProductWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_product_wizard_sell_panel") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        if (parseProductKind(state.payload.productKind) === "account") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ┘à╪¡╪╡┘ê┘ä ╪º┌⌐╪º┘å╪¬█î╪î ┘ü╪▒┘ê╪┤ ╪º╪▓ ┘╛┘å┘ä ╪║█î╪▒┘ü╪╣╪º┘ä ╪º╪│╪¬ ┘ê ┘ü┘é╪╖ ┘ü╪▒┘ê╪┤ ╪»╪│╪¬█î ┘é╪º╪¿┘ä ╪º┘å╪¬╪«╪º╪¿ ╪º╪│╪¬." });
            return null;
        }
        const payload = { ...state.payload, sellMode: "panel", step: "panel_id" };
        await setState(userId, "admin_product_wizard", payload);
        await promptProductWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_product_wizard_kind_v2ray" || data === "admin_product_wizard_kind_account" || data === "admin_product_wizard_kind_wireguard") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        const productKind = data === "admin_product_wizard_kind_account" ? "account" : (data === "admin_product_wizard_kind_wireguard" ? "wireguard" : "v2ray");
        const payload = productKind === "account"
            ? { ...state.payload, productKind, sizeMb: 0, priceMode: "manual", step: "price_mode" }
            : { ...state.payload, productKind, step: "size_mb" };
        await setState(userId, "admin_product_wizard", payload);
        await promptProductWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_product_wizard_infinite_yes" || data === "admin_product_wizard_infinite_no") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        const isInfinite = data === "admin_product_wizard_infinite_yes";
        const payload = { ...state.payload, isInfinite };
        const result = await saveProductWizard(payload);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: result.message });
        if (result.ok)
            await listProductsForAdmin(chatId, userId);
        return null;
    }
    if (data.startsWith("admin_product_wizard_panel_")) {
        const panelId = Number(data.replace("admin_product_wizard_panel_", ""));
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        const payload = { ...state.payload, panelId, step: "panel_sell_limit" };
        await setState(userId, "admin_product_wizard", payload);
        await promptProductWizardStep(chatId, payload);
        return null;
    }
    if (data.startsWith("admin_product_wizard_delivery_")) {
        const panelDeliveryMode = parseDeliveryMode(data.replace("admin_product_wizard_delivery_", ""));
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪º┘ü╪▓┘ê╪»┘å/┘ê█î╪▒╪º█î╪┤ ┘à╪¡╪╡┘ê┘ä ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ╪º┘ê┘ä ╪┤╪▒┘ê╪╣ ┌⌐┘å█î╪»." });
            return null;
        }
        const payload = { ...state.payload, panelDeliveryMode };
        const result = await saveProductWizard(payload);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: result.message });
        if (result.ok)
            await listProductsForAdmin(chatId, userId);
        return null;
    }
    if (data.startsWith("admin_product_wizard_protocol_")) {
        const protocol = data.replace("admin_product_wizard_protocol_", "").trim().toLowerCase();
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_wizard")
            return null;
        const payload = { ...state.payload, protocol };
        const result = await saveProductWizard(payload);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: result.message });
        if (result.ok)
            await listProductsForAdmin(chatId, userId);
        return null;
    }
    if (data.startsWith("admin_toggle_product_infinite_")) {
        const productId = Number(data.replace("admin_toggle_product_infinite_", ""));
        await sql `UPDATE products SET is_infinite = NOT is_infinite WHERE id = ${productId};`;
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪º┘ä╪¬ ╪¿█î┘å┘ç╪º█î╪¬ ┘à╪¡╪╡┘ê┘ä ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à" });
        return null;
    }
    if (data.startsWith("admin_toggle_product_sell_mode_")) {
        const productId = Number(data.replace("admin_toggle_product_sell_mode_", ""));
        const rows = await sql `
      UPDATE products
      SET sell_mode = CASE WHEN sell_mode = 'panel' THEN 'manual' ELSE 'panel' END,
          is_infinite = CASE WHEN sell_mode = 'panel' THEN FALSE ELSE TRUE END
      WHERE id = ${productId}
      RETURNING sell_mode;
    `;
        await tg("sendMessage", {
            chat_id: chatId,
            text: rows.length ? `╪¡╪º┘ä╪¬ ┘ü╪▒┘ê╪┤ ┘à╪¡╪╡┘ê┘ä ╪▒┘ê█î ${rows[0].sell_mode === "panel" ? "┘ü╪▒┘ê╪┤ ╪º╪▓ ┘╛┘å┘ä" : "┘ü╪▒┘ê╪┤ ╪»╪│╪¬█î"} ┘é╪▒╪º╪▒ ┌»╪▒┘ü╪¬ Γ£à` : "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»."
        });
        return null;
    }
    if (data.startsWith("admin_configure_product_panel_")) {
        const productId = Number(data.replace("admin_configure_product_panel_", ""));
        const product = await getProductForPanelWizard(productId);
        if (!product) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const payload = productPanelWizardPayload(product);
        await setState(userId, "admin_product_panel_wizard", payload);
        await promptProductPanelWizardStep(chatId, payload);
        return null;
    }
    if (data.startsWith("admin_product_panel_wizard_cancel_")) {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪¬┘å╪╕█î┘à ┘ü╪▒┘ê╪┤ ┘╛┘å┘ä ┘ä╪║┘ê ╪┤╪»." });
        await listProductsForAdmin(chatId, userId);
        return null;
    }
    if (data.startsWith("admin_product_panel_pick_")) {
        const panelId = Number(data.replace("admin_product_panel_pick_", ""));
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_panel_wizard") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪¬┘å╪╕█î┘à ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪º╪▓ ┘ä█î╪│╪¬ ┘à╪¡╪╡┘ê┘ä╪º╪¬ ╪┤╪▒┘ê╪╣ ┌⌐┘å█î╪»." });
            return null;
        }
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const payload = { ...state.payload, panelId, step: "mode" };
        await setState(userId, "admin_product_panel_wizard", payload);
        await promptProductPanelWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_product_panel_quick") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_panel_wizard") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪¬┘å╪╕█î┘à ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
            return null;
        }
        const result = await saveProductPanelWizard(state.payload, true);
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: result.message });
        if (result.ok) {
            await listProductsForAdmin(chatId, userId);
        }
        return null;
    }
    if (data === "admin_product_panel_custom") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_panel_wizard") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪¬┘å╪╕█î┘à ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
            return null;
        }
        const payload = { ...state.payload, step: "sell_limit" };
        await setState(userId, "admin_product_panel_wizard", payload);
        await promptProductPanelWizardStep(chatId, payload);
        return null;
    }
    if (data.startsWith("admin_product_panel_delivery_")) {
        const mode = data.replace("admin_product_panel_delivery_", "");
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_panel_wizard") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪¬┘å╪╕█î┘à ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
            return null;
        }
        const panelDeliveryMode = parseDeliveryMode(mode);
        const payload = { ...state.payload, panelDeliveryMode, step: "inbound_id" };
        await setState(userId, "admin_product_panel_wizard", payload);
        await promptProductPanelWizardStep(chatId, payload);
        return null;
    }
    if (data.startsWith("admin_product_panel_protocol_")) {
        const protocol = data.replace("admin_product_panel_protocol_", "").trim().toLowerCase();
        const state = await getState(userId);
        if (!state || state.state !== "admin_product_panel_wizard") {
            await tg("sendMessage", { chat_id: chatId, text: "╪¼┘ä╪│┘ç ╪¬┘å╪╕█î┘à ┘à┘å┘é╪╢█î ╪┤╪»┘ç. ╪»┘ê╪¿╪º╪▒┘ç ╪¬┘ä╪º╪┤ ┌⌐┘å█î╪»." });
            return null;
        }
        if (!protocol) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛╪▒┘ê╪¬┌⌐┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const payload = { ...state.payload, protocol, step: "expire_days" };
        await setState(userId, "admin_product_panel_wizard", payload);
        await promptProductPanelWizardStep(chatId, payload);
        return null;
    }
    if (data.startsWith("admin_remove_product_yes_")) {
        const productId = Number(data.replace("admin_remove_product_yes_", ""));
        const refRows = await sql `
      SELECT
        (SELECT COUNT(*)::int FROM inventory WHERE product_id = ${productId}) AS inventory_count,
        (SELECT COUNT(*)::int FROM orders WHERE product_id = ${productId}) AS orders_count;
    `;
        const inventoryCount = Number(refRows[0]?.inventory_count || 0);
        const ordersCount = Number(refRows[0]?.orders_count || 0);
        if (inventoryCount > 0 || ordersCount > 0) {
            const archived = await sql `
        UPDATE products
        SET is_active = FALSE,
            name = (name || ' [archived#' || id::text || ']')
        WHERE id = ${productId}
        RETURNING name;
      `;
            await tg("sendMessage", {
                chat_id: chatId,
                text: "╪º█î┘å ┘à╪¡╪╡┘ê┘ä ┘é╪¿┘ä╪º┘ï ┘ü╪▒┘ê╪┤ ╪»╪º╪┤╪¬┘ç ┘ê ╪¡╪░┘ü ┌⌐╪º┘à┘ä ╪¿╪º╪╣╪½ ╪º╪▓ ╪»╪│╪¬ ╪▒┘ü╪¬┘å ╪º╪¬╪╡╪º┘ä ╪¿┘ç ╪│┘ê╪º╪¿┘é ┘à█îΓÇî╪┤┘ê╪».\n" +
                    "┘╛╪│ ╪¿┘çΓÇî╪╡┘ê╪▒╪¬ ╪«┘ê╪»┌⌐╪º╪▒ ╪ó╪▒╪┤█î┘ê/╪║█î╪▒┘ü╪╣╪º┘ä ╪┤╪» ╪¬╪º ┌⌐╪º╪▒╪¿╪▒╪º┘å ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î ┘ü╪▒┘ê╪«╪¬┘çΓÇî╪┤╪»┘ç ╪▒╪º ╪º╪▓ ╪»╪│╪¬ ┘å╪»┘ç┘å╪» Γ£à\n" +
                    `inventory: ${inventoryCount}\n` +
                    `orders: ${ordersCount}\n` +
                    (archived.length ? `┘å╪º┘à ╪¼╪»█î╪»: ${archived[0].name}` : "")
            });
            await listProductsForAdmin(chatId, userId);
            return null;
        }
        try {
            const deleted = await sql `
        DELETE FROM products
        WHERE id = ${productId}
        RETURNING name;
      `;
            if (!deleted.length) {
                await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪» █î╪º ┘é╪¿┘ä╪º┘ï ╪¡╪░┘ü ╪┤╪»┘ç ╪º╪│╪¬." });
                return null;
            }
            await tg("sendMessage", { chat_id: chatId, text: `┘à╪¡╪╡┘ê┘ä ┬½${deleted[0].name}┬╗ ╪¡╪░┘ü ╪┤╪» Γ£à` });
            await listProductsForAdmin(chatId, userId);
        }
        catch (err) {
            logError("admin_delete_product_failed", err, { productId, adminId: userId });
            await tg("sendMessage", { chat_id: chatId, text: `Γ¥î ╪¡╪░┘ü ┘à╪¡╪╡┘ê┘ä ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪». ┘à┘à┌⌐┘å ╪º╪│╪¬ ╪»█î╪¬╪º█î█î ╪¿┘ç ╪ó┘å ┘ê╪º╪¿╪│╪¬┘ç ╪¿╪º╪┤╪».\n${err.message}` });
        }
        return null;
    }
    if (data.startsWith("admin_remove_product_")) {
        const productId = Number(data.replace("admin_remove_product_", ""));
        const rows = await sql `SELECT name FROM products WHERE id = ${productId} LIMIT 1;`;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪º╪▓ ╪¡╪░┘ü ┘à╪¡╪╡┘ê┘ä ┬½${rows[0].name}┬╗ ┘à╪╖┘à╪ª┘å ┘ç╪│╪¬█î╪»╪ƒ`,
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("≡ƒùæ ╪¡╪░┘ü", `admin_remove_product_yes_${productId}`, "danger"),
                        cb("Γ¥î ╪«█î╪▒", "admin_products", "primary")
                    ]
                ]
            }
        });
        return null;
    }
    if (data.startsWith("admin_toggle_product_")) {
        const productId = Number(data.replace("admin_toggle_product_", ""));
        await sql `UPDATE products SET is_active = NOT is_active WHERE id = ${productId};`;
        await tg("sendMessage", { chat_id: chatId, text: "┘ê╪╢╪╣█î╪¬ ┘à╪¡╪╡┘ê┘ä ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à" });
        return null;
    }
    if (data === "admin_inventory" || data.startsWith("admin_inv_")) {
        let page = 0;
        if (data.startsWith("admin_inv_")) {
            page = Math.max(0, parseInt(data.replace("admin_inv_", ""), 10) || 0);
        }
        await showProducts(chatId, false, page, "");
        return null;
    }
    if (data.startsWith("admin_inventory_product_")) {
        const productId = Number(data.replace("admin_inventory_product_", ""));
        const countRows = await sql `
      SELECT
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END)::int AS available_count,
        SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END)::int AS sold_count
      FROM inventory
      WHERE product_id = ${productId};
    `;
        const availableCount = Number(countRows[0].available_count || 0);
        const soldCount = Number(countRows[0].sold_count || 0);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à┘ê╪¼┘ê╪»█î ┘à╪¡╪╡┘ê┘ä:\n╪ó╪▓╪º╪»: ${availableCount}\n┘ü╪▒┘ê╪«╪¬┘çΓÇî╪┤╪»┘ç: ${soldCount}`,
            reply_markup: {
                inline_keyboard: [
                    [cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ╪¿┘ç ╪º┘å╪¿╪º╪▒ (Storage)", `admin_add_stock_${productId}`, "success")],
                    [cb("≡ƒùæ ┘ä█î╪│╪¬ ┘é╪º╪¿┘ä ╪¡╪░┘ü", `admin_available_list_${productId}`, "primary")],
                    [cb("≡ƒôª ┘ä█î╪│╪¬ ┘ü╪▒┘ê╪«╪¬┘çΓÇî╪┤╪»┘çΓÇî┘ç╪º", `admin_sold_list_${productId}`, "primary")],
                    [backButton("admin_inventory")]
                ]
            }
        });
        return null;
    }
    if (data.startsWith("admin_add_stock_")) {
        const productId = Number(data.replace("admin_add_stock_", ""));
        await setState(userId, "admin_add_stock", { productId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "≡ƒùé ╪º┘ü╪▓┘ê╪»┘å ╪¿┘ç ╪º┘å╪¿╪º╪▒\n" +
                "┘ç╪▒ ┌⌐╪º┘å┘ü█î┌» ╪▒╪º ╪»╪▒ █î┌⌐ ╪«╪╖ Paste ┌⌐┘å█î╪».\n" +
                "┘å┘à┘ê┘å┘ç:\n" +
                "vmess://...\n" +
                "vless://...\n" +
                "trojan://..."
        });
        return null;
    }
    if (data.startsWith("admin_sold_list_")) {
        const productId = Number(data.replace("admin_sold_list_", ""));
        const rows = await sql `
      SELECT i.id, i.owner_telegram_id, i.config_value, i.delivery_payload, o.purchase_id
      FROM inventory i
      LEFT JOIN orders o ON o.id = i.sold_order_id
      WHERE i.product_id = ${productId} AND i.status = 'sold'
      ORDER BY i.sold_at DESC
      LIMIT 20;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä█î╪│╪¬ ┘ü╪▒┘ê╪┤ ╪«╪º┘ä█î ╪º╪│╪¬." });
            return null;
        }
        for (const row of rows) {
            const payload = parseDeliveryPayload(row.delivery_payload);
            const revoked = payload.metadata?.revoked === true;
            await tg("sendMessage", {
                chat_id: chatId,
                parse_mode: "HTML",
                text: `#${row.id} | ┌⌐╪º╪▒╪¿╪▒: ${row.owner_telegram_id || "-"} | ╪«╪▒█î╪»: ${row.purchase_id || "-"}${revoked ? " | ≡ƒÜ½" : ""}\n` +
                    `${escapeHtml(responseSnippet(String(row.config_value), 450))}`,
                reply_markup: {
                    inline_keyboard: [
                        [
                            revoked
                                ? confirmButton(`admin_inv_revoke_${row.id}`, "Γ£à ┘ü╪╣╪º┘ä")
                                : cb("≡ƒÜ½ ╪║█î╪▒┘ü╪╣╪º┘ä", `admin_inv_revoke_${row.id}`, "danger"),
                            cb("Γ£Å∩╕Å ┘å╪º┘à", `admin_inv_rename_${row.id}`, "primary")
                        ]
                    ]
                }
            });
        }
        return null;
    }
    if (data.startsWith("admin_inv_revoke_")) {
        const inventoryId = Number(data.replace("admin_inv_revoke_", ""));
        const rows = await sql `SELECT delivery_payload, owner_telegram_id FROM inventory WHERE id = ${inventoryId} LIMIT 1;`;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        const payload = parseDeliveryPayload(rows[0].delivery_payload);
        const revoked = payload.metadata?.revoked === true;
        await sql `
      UPDATE inventory
      SET delivery_payload = jsonb_set(
        jsonb_set(COALESCE(delivery_payload, '{}'::jsonb), '{metadata}', COALESCE(delivery_payload->'metadata', '{}'::jsonb), true),
        '{metadata,revoked}',
        to_jsonb(${!revoked}::boolean),
        true
      )
      WHERE id = ${inventoryId};
    `;
        try {
            const owner = Number(rows[0].owner_telegram_id || 0);
            if (owner) {
                await tg("sendMessage", { chat_id: owner, text: !revoked ? "┌⌐╪º┘å┘ü█î┌» ╪┤┘à╪º ╪¬┘ê╪│╪╖ ╪º╪»┘à█î┘å ╪║█î╪▒┘ü╪╣╪º┘ä ╪┤╪»." : "┌⌐╪º┘å┘ü█î┌» ╪┤┘à╪º ╪»┘ê╪¿╪º╪▒┘ç ┘ü╪╣╪º┘ä ╪┤╪» Γ£à" });
            }
        }
        catch (error) {
            logError("inventory_revoke_notify_failed", error, { inventoryId });
        }
        await tg("sendMessage", { chat_id: chatId, text: !revoked ? "╪║█î╪▒┘ü╪╣╪º┘ä ╪┤╪» Γ£à" : "┘ü╪╣╪º┘ä ╪┤╪» Γ£à" });
        return null;
    }
    if (data.startsWith("admin_inv_rename_")) {
        const inventoryId = Number(data.replace("admin_inv_rename_", ""));
        await setState(userId, "admin_inv_rename", { inventoryId });
        await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ╪¼╪»█î╪» ┌⌐╪º┘å┘ü█î┌» ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». (╪¿╪▒╪º█î ╪¡╪░┘ü ┘å╪º┘à: -)" });
        return null;
    }
    if (data.startsWith("admin_available_list_")) {
        const productId = Number(data.replace("admin_available_list_", ""));
        const rows = await sql `
      SELECT id, config_value
      FROM inventory
      WHERE product_id = ${productId} AND status = 'available'
      ORDER BY id DESC
      LIMIT 30;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à┘ê╪▒╪»█î ╪¿╪▒╪º█î ╪¡╪░┘ü ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪»." });
            return null;
        }
        await tg("sendMessage", { chat_id: chatId, text: "╪¿╪▒╪º█î ╪¡╪░┘ü ┘ç╪▒ ┌⌐╪º┘å┘ü█î┌» ╪▒┘ê█î ╪»┌⌐┘à┘ç ┬½╪¡╪░┘ü┬╗ ╪¿╪▓┘å█î╪»:" });
        for (const row of rows) {
            await tg("sendMessage", {
                chat_id: chatId,
                parse_mode: "HTML",
                text: `#${row.id}\n${escapeHtml(String(row.config_value))}`,
                reply_markup: {
                    inline_keyboard: [[cb("≡ƒùæ ╪¡╪░┘ü", `admin_delete_inventory_${row.id}`, "danger")]]
                }
            });
        }
        return null;
    }
    if (data.startsWith("admin_delete_inventory_")) {
        const inventoryId = Number(data.replace("admin_delete_inventory_", ""));
        try {
            await sql `
        WITH deleted_forensics AS (
          DELETE FROM config_forensics WHERE inventory_id = ${inventoryId}
        ),
        deleted_topups AS (
          DELETE FROM topup_requests WHERE inventory_id = ${inventoryId}
        ),
        deleted_migrations AS (
          DELETE FROM panel_migrations WHERE source_inventory_id = ${inventoryId}
        )
        DELETE FROM inventory
        WHERE id = ${inventoryId} AND status = 'available'
        RETURNING product_id;
      `;
            // Also nullify references in orders just in case an available config somehow ended up in an order
            await sql `UPDATE orders SET inventory_id = NULL WHERE inventory_id = ${inventoryId}`;
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┌⌐╪º┘å┘ü█î┌» ╪¡╪░┘ü ╪┤╪» Γ£à",
            });
        }
        catch (err) {
            logError("admin_delete_available_inventory_failed", err, { inventoryId, adminId: userId });
            await tg("sendMessage", { chat_id: chatId, text: `Γ¥î ╪¡╪░┘ü ┌⌐╪º┘å┘ü█î┌» ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪».\n${err.message}` });
        }
        return null;
    }
    if (data === "admin_discounts") {
        const rows = await sql `SELECT id, code, type, amount, active, usage_limit, used_count FROM discounts ORDER BY id DESC LIMIT 30;`;
        const keyboard = rows.flatMap((d) => [
            [cb(`${d.code} | ${d.type} ${d.amount} | ┘à╪╡╪▒┘ü ${d.used_count}/${d.usage_limit ?? "Γê₧"}`, `admin_edit_discount_${d.id}`, "primary")],
            [
                cb("┘ê█î╪▒╪º█î╪┤", `admin_edit_discount_${d.id}`, "primary"),
                cb(d.active ? "╪║█î╪▒┘ü╪╣╪º┘ä" : "┘ü╪╣╪º┘ä", `admin_toggle_discount_${d.id}`, d.active ? "danger" : "success"),
                cb("≡ƒùæ ╪¡╪░┘ü", `admin_delete_discount_${d.id}`, "danger")
            ]
        ]);
        keyboard.push([cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ╪¬╪«┘ü█î┘ü", "admin_add_discount", "success")]);
        keyboard.push([backButton("admin_panel")]);
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪»█î╪▒█î╪¬ ╪¬╪«┘ü█î┘ü:", reply_markup: { inline_keyboard: keyboard } });
        return null;
    }
    if (data === "admin_add_discount") {
        await startDiscountWizard(chatId, userId, "add");
        return null;
    }
    if (data.startsWith("admin_edit_discount_")) {
        const discountId = Number(data.replace("admin_edit_discount_", ""));
        await startDiscountWizard(chatId, userId, "edit", discountId);
        return null;
    }
    if (data.startsWith("admin_discount_wizard_cancel_")) {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪½╪¿╪¬/┘ê█î╪▒╪º█î╪┤ ╪¬╪«┘ü█î┘ü ┘ä╪║┘ê ╪┤╪»." });
        return null;
    }
    if (data === "admin_discount_wizard_code_random") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_discount_wizard")
            return null;
        const payload = { ...state.payload, code: randomCode(10), step: "type" };
        await setState(userId, "admin_discount_wizard", payload);
        await promptDiscountWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_discount_wizard_code_manual") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_discount_wizard")
            return null;
        const payload = { ...state.payload, step: "code" };
        await setState(userId, "admin_discount_wizard", payload);
        await promptDiscountWizardStep(chatId, payload);
        return null;
    }
    if (data === "admin_discount_wizard_type_percent" || data === "admin_discount_wizard_type_fixed") {
        const state = await getState(userId);
        if (!state || state.state !== "admin_discount_wizard")
            return null;
        const type = data.endsWith("_percent") ? "percent" : "fixed";
        const payload = { ...state.payload, type, step: "amount" };
        await setState(userId, "admin_discount_wizard", payload);
        await promptDiscountWizardStep(chatId, payload);
        return null;
    }
    if (data.startsWith("admin_delete_discount_")) {
        const discountId = Number(data.replace("admin_delete_discount_", ""));
        try {
            await sql `DELETE FROM discounts WHERE id = ${discountId};`;
            await tg("sendMessage", { chat_id: chatId, text: "╪¬╪«┘ü█î┘ü ╪¡╪░┘ü ╪┤╪» Γ£à" });
        }
        catch (err) {
            logError("admin_delete_discount_failed", err, { discountId, adminId: userId });
            await tg("sendMessage", { chat_id: chatId, text: `Γ¥î ╪¡╪░┘ü ╪¬╪«┘ü█î┘ü ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪».\n${err.message}` });
        }
        return null;
    }
    if (data.startsWith("admin_toggle_discount_")) {
        const discountId = Number(data.replace("admin_toggle_discount_", ""));
        await sql `UPDATE discounts SET active = NOT active WHERE id = ${discountId};`;
        await tg("sendMessage", { chat_id: chatId, text: "┘ê╪╢╪╣█î╪¬ ╪¬╪«┘ü█î┘ü ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à" });
        return null;
    }
    if (data === "admin_payment_methods") {
        const rows = await sql `SELECT code, title, active FROM payment_methods ORDER BY code ASC;`;
        const keyboard = rows.map((m) => [cb(`${m.title} | ${m.active ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"}`, `admin_toggle_method_${m.code}`, m.active ? "danger" : "success")]);
        keyboard.push([backButton("admin_panel")]);
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪»█î╪▒█î╪¬ ╪▒┘ê╪┤ΓÇî┘ç╪º█î ┘╛╪▒╪»╪º╪«╪¬:", reply_markup: { inline_keyboard: keyboard } });
        return null;
    }
    if (data.startsWith("admin_toggle_method_")) {
        const code = data.replace("admin_toggle_method_", "");
        await sql `UPDATE payment_methods SET active = NOT active WHERE code = ${code};`;
        await tg("sendMessage", { chat_id: chatId, text: "╪▒┘ê╪┤ ┘╛╪▒╪»╪º╪«╪¬ ╪¿╪▒┘ê╪▓╪▒╪│╪º┘å█î ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_cards") {
        const randomMode = await getBoolSetting("random_card_distribution", false);
        const mainCardRaw = await getSetting("main_card_id");
        const mainCardId = mainCardRaw ? Number(mainCardRaw) : NaN;
        const rows = await sql `
      SELECT
        c.id,
        c.label,
        c.card_number,
        c.active,
        (SELECT COUNT(*)::int FROM orders o WHERE o.card_id = c.id) AS total_orders,
        (
          SELECT COUNT(*)::int
          FROM orders o
          WHERE o.card_id = c.id AND (o.status = 'paid' OR o.status = 'awaiting_config')
        ) AS sold_count
      FROM cards c
      ORDER BY c.id ASC;
    `;
        const keyboard = rows.flatMap((c) => [
            [
                {
                    text: `${Number(c.id) === mainCardId ? "Γ¡É " : ""}${c.label} | ${c.card_number} | ${c.active ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"}\n` +
                        `┘ü╪▒┘ê╪┤: ${Number(c.sold_count || 0)} | ┌⌐┘ä ╪│┘ü╪º╪▒╪┤: ${Number(c.total_orders || 0)}`,
                    callback_data: `admin_edit_card_${c.id}`,
                    style: "primary"
                }
            ],
            [
                cb("┘ê█î╪▒╪º█î╪┤", `admin_edit_card_${c.id}`, "primary"),
                cb(c.active ? "╪║█î╪▒┘ü╪╣╪º┘ä" : "┘ü╪╣╪º┘ä", `admin_toggle_card_${c.id}`, c.active ? "danger" : "success"),
                cb("Γ¡É ┌⌐╪º╪▒╪¬ ╪º╪╡┘ä█î", `admin_set_main_card_${c.id}`, "success"),
                cb("≡ƒùæ ╪¡╪░┘ü", `admin_remove_card_${c.id}`, "danger")
            ]
        ]);
        keyboard.push([cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ┌⌐╪º╪▒╪¬", "admin_add_card", "success")]);
        keyboard.push([cb(randomMode ? "≡ƒÄ▓ ┘╛╪«╪┤ ╪▒┘å╪»┘ê┘à: ╪▒┘ê╪┤┘å" : "≡ƒÄ▓ ┘╛╪«╪┤ ╪▒┘å╪»┘ê┘à: ╪«╪º┘à┘ê╪┤", "admin_toggle_random_cards", randomMode ? "success" : "primary")]);
        keyboard.push([backButton("admin_panel")]);
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪»█î╪▒█î╪¬ ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º:", reply_markup: { inline_keyboard: keyboard } });
        return null;
    }
    if (data === "admin_add_card") {
        await startCardWizard(chatId, userId, "add");
        return null;
    }
    if (data.startsWith("admin_edit_card_")) {
        const cardId = Number(data.replace("admin_edit_card_", ""));
        await startCardWizard(chatId, userId, "edit", cardId);
        return null;
    }
    if (data.startsWith("admin_card_wizard_cancel_")) {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪½╪¿╪¬/┘ê█î╪▒╪º█î╪┤ ┌⌐╪º╪▒╪¬ ┘ä╪║┘ê ╪┤╪»." });
        return null;
    }
    if (data.startsWith("admin_toggle_card_")) {
        const cardId = Number(data.replace("admin_toggle_card_", ""));
        await sql `UPDATE cards SET active = NOT active WHERE id = ${cardId};`;
        await tg("sendMessage", { chat_id: chatId, text: "┘ê╪╢╪╣█î╪¬ ┌⌐╪º╪▒╪¬ ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à" });
        return null;
    }
    if (data.startsWith("admin_set_main_card_")) {
        const cardId = Number(data.replace("admin_set_main_card_", ""));
        const rows = await sql `SELECT id FROM cards WHERE id = ${cardId} AND active = TRUE LIMIT 1;`;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ü┘é╪╖ ┌⌐╪º╪▒╪¬ ┘ü╪╣╪º┘ä ┘à█îΓÇî╪¬┘ê╪º┘å╪» ┌⌐╪º╪▒╪¬ ╪º╪╡┘ä█î ╪¿╪º╪┤╪»." });
            return null;
        }
        await setSetting("main_card_id", String(cardId));
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¬ ╪º╪╡┘ä█î ╪¬╪╣█î█î┘å ╪┤╪» Γ£à" });
        return null;
    }
    if (data.startsWith("admin_remove_card_")) {
        const cardId = Number(data.replace("admin_remove_card_", ""));
        try {
            await sql `DELETE FROM cards WHERE id = ${cardId};`;
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¬ ╪¡╪░┘ü ╪┤╪» Γ£à" });
        }
        catch (err) {
            logError("admin_remove_card_failed", err, { cardId, adminId: userId });
            await tg("sendMessage", { chat_id: chatId, text: `Γ¥î ╪¡╪░┘ü ┌⌐╪º╪▒╪¬ ╪¿╪º ╪«╪╖╪º ┘à┘ê╪º╪¼┘ç ╪┤╪».\n${err.message}` });
        }
        return null;
    }
    if (data === "admin_toggle_random_cards") {
        const current = await getBoolSetting("random_card_distribution", false);
        await setSetting("random_card_distribution", (!current).toString());
        await tg("sendMessage", { chat_id: chatId, text: `┘╛╪«╪┤ ╪▒┘å╪»┘ê┘à ┌⌐╪º╪▒╪¬ ${!current ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"} ╪┤╪» Γ£à` });
        return null;
    }
    if (data.startsWith("wallet_accept_")) {
        const topupId = Number(data.replace("wallet_accept_", ""));
        const rows = await sql `
      UPDATE wallet_topups
      SET status = 'paid', done_at = NOW(), admin_decision_by = ${userId}
      WHERE id = ${topupId} AND status = 'receipt_submitted'
      RETURNING telegram_id, amount;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪»╪▒╪«┘ê╪º╪│╪¬ ┘é╪º╪¿┘ä ╪¬╪º█î█î╪» ┘å█î╪│╪¬ █î╪º ┘é╪¿┘ä╪º┘ï ╪¿╪▒╪▒╪│█î ╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        await sql `
      UPDATE users
      SET wallet_balance = wallet_balance + ${rows[0].amount}
      WHERE telegram_id = ${rows[0].telegram_id};
    `;
        await sql `
      INSERT INTO wallet_transactions (telegram_id, amount, type, description)
      VALUES (${rows[0].telegram_id}, ${rows[0].amount}, 'charge', '╪┤╪º╪▒┌ÿ ╪º╪▓ ╪╖╪▒█î┘é ┌⌐╪º╪▒╪¬ΓÇî╪¿┘çΓÇî┌⌐╪º╪▒╪¬');
    `;
        await tg("sendMessage", {
            chat_id: Number(rows[0].telegram_id),
            text: `╪▒╪│█î╪» ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ╪¬╪º█î█î╪» ╪┤╪» Γ£à\n┘à╪¿┘ä╪║ ${formatPriceToman(Number(rows[0].amount))} ╪¬┘ê┘à╪º┘å ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪º╪╢╪º┘ü┘ç ╪┤╪».`
        });
        await tg("sendMessage", { chat_id: chatId, text: "╪▒╪│█î╪» ╪¬╪º█î█î╪» ╪┤╪» ┘ê ┌⌐█î┘ü ┘╛┘ê┘ä ┌⌐╪º╪▒╪¿╪▒ ╪┤╪º╪▒┌ÿ ╪┤╪» Γ£à" });
        return null;
    }
    if (data.startsWith("wallet_deny_")) {
        const topupId = Number(data.replace("wallet_deny_", ""));
        const rows = await sql `
      UPDATE wallet_topups
      SET status = 'denied', admin_decision_by = ${userId}
      WHERE id = ${topupId} AND status = 'receipt_submitted'
      RETURNING telegram_id;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪»╪▒╪«┘ê╪º╪│╪¬ ┘é╪º╪¿┘ä ╪▒╪» ┘å█î╪│╪¬ █î╪º ┘é╪¿┘ä╪º┘ï ╪¿╪▒╪▒╪│█î ╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        await tg("sendMessage", { chat_id: Number(rows[0].telegram_id), text: `╪▒╪│█î╪» ╪┤╪º╪▒┌ÿ ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪▒╪» ╪┤╪» Γ¥î` });
        await tg("sendMessage", { chat_id: chatId, text: "╪▒╪» ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_manage_users") {
        await setState(userId, "admin_manage_users");
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘ä╪╖┘ü╪º┘ï ╪ó█î╪»█î ╪╣╪»╪»█î (Telegram ID) █î╪º █î┘ê╪▓╪▒┘å█î┘à (╪¿╪º @ █î╪º ╪¿╪»┘ê┘å @) ┌⌐╪º╪▒╪¿╪▒ ┘à┘ê╪▒╪»┘å╪╕╪▒ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»:",
            reply_markup: { inline_keyboard: [[backButton("admin_panel")]] }
        });
        return null;
    }
    if (data.startsWith("admin_wallet_add_")) {
        const targetUserId = Number(data.replace("admin_wallet_add_", ""));
        await setState(userId, "admin_wallet_add", { targetUserId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘à╪¿┘ä╪║█î ┌⌐┘ç ┘à█îΓÇî╪«┘ê╪º┘ç█î╪» ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ╪º█î┘å ┌⌐╪º╪▒╪¿╪▒ ╪º╪╢╪º┘ü┘ç ┌⌐┘å█î╪» ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ┘ê╪º╪▒╪» ┌⌐┘å█î╪»:",
            reply_markup: { inline_keyboard: [[backButton("admin_manage_users")]] }
        });
        return null;
    }
    if (data.startsWith("admin_wallet_sub_")) {
        const targetUserId = Number(data.replace("admin_wallet_sub_", ""));
        await setState(userId, "admin_wallet_sub", { targetUserId });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘à╪¿┘ä╪║█î ┌⌐┘ç ┘à█îΓÇî╪«┘ê╪º┘ç█î╪» ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä ╪º█î┘å ┌⌐╪º╪▒╪¿╪▒ ┌⌐┘à ┌⌐┘å█î╪» ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ┘ê╪º╪▒╪» ┌⌐┘å█î╪»:",
            reply_markup: { inline_keyboard: [[backButton("admin_manage_users")]] }
        });
        return null;
    }
    if (data === "admin_stats") {
        const m1 = await sql `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(p.panel_config->>'product_kind', 'v2ray') = 'account' THEN 0
              ELSE p.size_mb
            END
          ),
          0
        )::int AS sold_mb
      FROM orders o
      INNER JOIN products p ON p.id = o.product_id
      WHERE o.status = 'paid' OR o.status = 'awaiting_config';
    `;
        const m2 = await sql `SELECT COALESCE(SUM(requested_mb), 0)::int AS topup_mb FROM topup_requests WHERE status = 'done';`;
        const m3 = await sql `SELECT COUNT(*)::int AS total_users FROM users;`;
        const m4 = await sql `
      SELECT COUNT(DISTINCT telegram_id)::int AS customers
      FROM orders
      WHERE status = 'paid' OR status = 'awaiting_config';
    `;
        const m5 = await sql `
      SELECT
        COUNT(*) FILTER (WHERE status = 'approved')::int AS migrations_done,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS migrations_pending
      FROM panel_migrations;
    `;
        const m6 = await sql `
      SELECT
        COUNT(*) FILTER (WHERE referred_by_telegram_id IS NOT NULL)::int AS referral_leads,
        COUNT(*) FILTER (WHERE referred_by_telegram_id IS NOT NULL AND referral_qualified_at IS NOT NULL)::int AS referral_qualified
      FROM users;
    `;
        const m7 = await sql `SELECT COUNT(*)::int AS referral_rewards FROM referral_rewards;`;
        const soldMb = Number(m1[0].sold_mb || 0);
        const totalMb = soldMb + Number(m2[0].topup_mb || 0);
        const totalGb = (totalMb / 1024).toFixed(2);
        const soldGb = soldMb / 1024;
        const productRateRaw = await getSetting("product_price_per_gb_toman");
        const fallbackRateRaw = await getSetting("topup_price_per_gb_toman");
        const productRate = normalizePricePerGb(productRateRaw || fallbackRateRaw || "500000");
        const totalEarning = Math.max(0, Math.round(soldGb * productRate));
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒôè ╪ó┘à╪º╪▒ ┌⌐┘ä█î (┘ç┘à┘ç ╪▓┘à╪º┘åΓÇî┘ç╪º):\n\n` +
                `╪»█î╪¬╪º█î ┘ü╪▒┘ê╪«╪¬┘çΓÇî╪┤╪»┘ç: ${totalMb}MB (${totalGb}GB)\n` +
                `╪»╪▒╪ó┘à╪» ┌⌐┘ä: ${formatPriceToman(totalEarning)} ╪¬┘ê┘à╪º┘å\n` +
                `┌⌐┘ä ┌⌐╪º╪▒╪¿╪▒╪º┘å: ${Number(m3[0].total_users || 0)}\n` +
                `╪¬╪╣╪»╪º╪» ┘à╪┤╪¬╪▒█î╪º┘å: ${Number(m4[0].customers || 0)}\n` +
                `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪½╪¿╪¬ΓÇî╪┤╪»┘ç: ${Number(m6[0].referral_leads || 0)}\n` +
                `╪»╪╣┘ê╪¬ΓÇî┘ç╪º█î ╪¬╪º█î█î╪»╪┤╪»┘ç: ${Number(m6[0].referral_qualified || 0)}\n` +
                `╪¼┘ê╪º█î╪▓ ╪»╪╣┘ê╪¬ ┘╛╪▒╪»╪º╪«╪¬ΓÇî╪┤╪»┘ç: ${Number(m7[0].referral_rewards || 0)}\n` +
                `╪º┘å╪¬┘é╪º┘äΓÇî┘ç╪º█î ╪º┘å╪¼╪º┘àΓÇî╪┤╪»┘ç: ${Number(m5[0].migrations_done || 0)}\n` +
                `╪º┘å╪¬┘é╪º┘äΓÇî┘ç╪º█î ╪»╪▒ ╪╡┘ü: ${Number(m5[0].migrations_pending || 0)}`,
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("≡ƒôà ╪º┘à╪▒┘ê╪▓", "admin_stats_period_today", "primary"),
                        cb("≡ƒôà ╪»█î╪▒┘ê╪▓", "admin_stats_period_yesterday", "primary"),
                    ],
                    [
                        cb("≡ƒôà ┘ç┘ü╪¬┘ç ╪º╪«█î╪▒", "admin_stats_period_week", "primary"),
                        cb("≡ƒôà ┘à╪º┘ç ╪º╪«█î╪▒", "admin_stats_period_month", "primary"),
                    ],
                    [cb("≡ƒæÑ ┘à╪┤╪¬╪▒█î╪º┘å ┘ç╪▒ ┘à╪¡╪╡┘ê┘ä", "admin_stats_buyers", "primary")],
                    [backButton("admin_panel")]
                ]
            }
        });
        return null;
    }
    if (data.startsWith("admin_stats_period_")) {
        const period = data.replace("admin_stats_period_", "");
        let label = "";
        if (period === "today")
            label = "╪º┘à╪▒┘ê╪▓";
        else if (period === "yesterday")
            label = "╪»█î╪▒┘ê╪▓";
        else if (period === "week")
            label = "█╖ ╪▒┘ê╪▓ ╪º╪«█î╪▒";
        else if (period === "month")
            label = "█│█░ ╪▒┘ê╪▓ ╪º╪«█î╪▒";
        else
            return null;
        const ordersStats = period === "today"
            ? await sql `
          SELECT
            COUNT(*)::int AS total_orders,
            COUNT(*) FILTER (WHERE o.status IN ('paid','awaiting_config'))::int AS successful_orders,
            COUNT(*) FILTER (WHERE o.status = 'pending')::int AS pending_orders,
            COUNT(*) FILTER (WHERE o.status IN ('denied','cancelled'))::int AS failed_orders,
            COUNT(DISTINCT o.telegram_id)::int AS unique_customers,
            COALESCE(SUM(o.final_price) FILTER (WHERE o.status IN ('paid','awaiting_config')), 0)::bigint AS revenue_toman,
            COALESCE(SUM(o.wallet_used) FILTER (WHERE o.status IN ('paid','awaiting_config')), 0)::bigint AS wallet_used_toman,
            COALESCE(SUM(CASE WHEN o.status IN ('paid','awaiting_config') AND COALESCE(p.panel_config->>'product_kind','v2ray') != 'account' THEN p.size_mb ELSE 0 END), 0)::bigint AS sold_mb
          FROM orders o INNER JOIN products p ON p.id = o.product_id
          WHERE DATE(o.created_at) = CURRENT_DATE`
            : period === "yesterday"
                ? await sql `
            SELECT
              COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE o.status IN ('paid','awaiting_config'))::int AS successful_orders,
              COUNT(*) FILTER (WHERE o.status = 'pending')::int AS pending_orders,
              COUNT(*) FILTER (WHERE o.status IN ('denied','cancelled'))::int AS failed_orders,
              COUNT(DISTINCT o.telegram_id)::int AS unique_customers,
              COALESCE(SUM(o.final_price) FILTER (WHERE o.status IN ('paid','awaiting_config')), 0)::bigint AS revenue_toman,
              COALESCE(SUM(o.wallet_used) FILTER (WHERE o.status IN ('paid','awaiting_config')), 0)::bigint AS wallet_used_toman,
              COALESCE(SUM(CASE WHEN o.status IN ('paid','awaiting_config') AND COALESCE(p.panel_config->>'product_kind','v2ray') != 'account' THEN p.size_mb ELSE 0 END), 0)::bigint AS sold_mb
            FROM orders o INNER JOIN products p ON p.id = o.product_id
            WHERE DATE(o.created_at) = CURRENT_DATE - INTERVAL '1 day'`
                : period === "week"
                    ? await sql `
              SELECT
                COUNT(*)::int AS total_orders,
                COUNT(*) FILTER (WHERE o.status IN ('paid','awaiting_config'))::int AS successful_orders,
                COUNT(*) FILTER (WHERE o.status = 'pending')::int AS pending_orders,
                COUNT(*) FILTER (WHERE o.status IN ('denied','cancelled'))::int AS failed_orders,
                COUNT(DISTINCT o.telegram_id)::int AS unique_customers,
                COALESCE(SUM(o.final_price) FILTER (WHERE o.status IN ('paid','awaiting_config')), 0)::bigint AS revenue_toman,
                COALESCE(SUM(o.wallet_used) FILTER (WHERE o.status IN ('paid','awaiting_config')), 0)::bigint AS wallet_used_toman,
                COALESCE(SUM(CASE WHEN o.status IN ('paid','awaiting_config') AND COALESCE(p.panel_config->>'product_kind','v2ray') != 'account' THEN p.size_mb ELSE 0 END), 0)::bigint AS sold_mb
              FROM orders o INNER JOIN products p ON p.id = o.product_id
              WHERE o.created_at >= NOW() - INTERVAL '7 days'`
                    : await sql `
              SELECT
                COUNT(*)::int AS total_orders,
                COUNT(*) FILTER (WHERE o.status IN ('paid','awaiting_config'))::int AS successful_orders,
                COUNT(*) FILTER (WHERE o.status = 'pending')::int AS pending_orders,
                COUNT(*) FILTER (WHERE o.status IN ('denied','cancelled'))::int AS failed_orders,
                COUNT(DISTINCT o.telegram_id)::int AS unique_customers,
                COALESCE(SUM(o.final_price) FILTER (WHERE o.status IN ('paid','awaiting_config')), 0)::bigint AS revenue_toman,
                COALESCE(SUM(o.wallet_used) FILTER (WHERE o.status IN ('paid','awaiting_config')), 0)::bigint AS wallet_used_toman,
                COALESCE(SUM(CASE WHEN o.status IN ('paid','awaiting_config') AND COALESCE(p.panel_config->>'product_kind','v2ray') != 'account' THEN p.size_mb ELSE 0 END), 0)::bigint AS sold_mb
              FROM orders o INNER JOIN products p ON p.id = o.product_id
              WHERE o.created_at >= NOW() - INTERVAL '30 days'`;
        const newUsers = period === "today"
            ? await sql `SELECT COUNT(*)::int AS cnt FROM users WHERE DATE(created_at) = CURRENT_DATE`
            : period === "yesterday"
                ? await sql `SELECT COUNT(*)::int AS cnt FROM users WHERE DATE(created_at) = CURRENT_DATE - INTERVAL '1 day'`
                : period === "week"
                    ? await sql `SELECT COUNT(*)::int AS cnt FROM users WHERE created_at >= NOW() - INTERVAL '7 days'`
                    : await sql `SELECT COUNT(*)::int AS cnt FROM users WHERE created_at >= NOW() - INTERVAL '30 days'`;
        const topupStats = period === "today"
            ? await sql `SELECT COALESCE(SUM(requested_mb), 0)::bigint AS topup_mb FROM topup_requests WHERE status = 'done' AND DATE(done_at) = CURRENT_DATE`
            : period === "yesterday"
                ? await sql `SELECT COALESCE(SUM(requested_mb), 0)::bigint AS topup_mb FROM topup_requests WHERE status = 'done' AND DATE(done_at) = CURRENT_DATE - INTERVAL '1 day'`
                : period === "week"
                    ? await sql `SELECT COALESCE(SUM(requested_mb), 0)::bigint AS topup_mb FROM topup_requests WHERE status = 'done' AND done_at >= NOW() - INTERVAL '7 days'`
                    : await sql `SELECT COALESCE(SUM(requested_mb), 0)::bigint AS topup_mb FROM topup_requests WHERE status = 'done' AND done_at >= NOW() - INTERVAL '30 days'`;
        const topProducts = period === "today"
            ? await sql `SELECT COALESCE(o.product_name_snapshot, p.name) AS name, COUNT(*)::int AS cnt FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status IN ('paid','awaiting_config') AND DATE(o.created_at) = CURRENT_DATE GROUP BY 1 ORDER BY cnt DESC LIMIT 5`
            : period === "yesterday"
                ? await sql `SELECT COALESCE(o.product_name_snapshot, p.name) AS name, COUNT(*)::int AS cnt FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status IN ('paid','awaiting_config') AND DATE(o.created_at) = CURRENT_DATE - INTERVAL '1 day' GROUP BY 1 ORDER BY cnt DESC LIMIT 5`
                : period === "week"
                    ? await sql `SELECT COALESCE(o.product_name_snapshot, p.name) AS name, COUNT(*)::int AS cnt FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status IN ('paid','awaiting_config') AND o.created_at >= NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY cnt DESC LIMIT 5`
                    : await sql `SELECT COALESCE(o.product_name_snapshot, p.name) AS name, COUNT(*)::int AS cnt FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status IN ('paid','awaiting_config') AND o.created_at >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY cnt DESC LIMIT 5`;
        const paymentMethods = period === "today"
            ? await sql `SELECT payment_method, COUNT(*)::int AS cnt FROM orders WHERE status IN ('paid','awaiting_config') AND DATE(created_at) = CURRENT_DATE GROUP BY payment_method ORDER BY cnt DESC`
            : period === "yesterday"
                ? await sql `SELECT payment_method, COUNT(*)::int AS cnt FROM orders WHERE status IN ('paid','awaiting_config') AND DATE(created_at) = CURRENT_DATE - INTERVAL '1 day' GROUP BY payment_method ORDER BY cnt DESC`
                : period === "week"
                    ? await sql `SELECT payment_method, COUNT(*)::int AS cnt FROM orders WHERE status IN ('paid','awaiting_config') AND created_at >= NOW() - INTERVAL '7 days' GROUP BY payment_method ORDER BY cnt DESC`
                    : await sql `SELECT payment_method, COUNT(*)::int AS cnt FROM orders WHERE status IN ('paid','awaiting_config') AND created_at >= NOW() - INTERVAL '30 days' GROUP BY payment_method ORDER BY cnt DESC`;
        const stats = ordersStats[0] || {};
        const soldMbPeriod = Number(stats.sold_mb || 0);
        const topupMbPeriod = Number(topupStats[0]?.topup_mb || 0);
        const totalMbPeriod = soldMbPeriod + topupMbPeriod;
        const revenueToman = Number(stats.revenue_toman || 0);
        const walletUsedToman = Number(stats.wallet_used_toman || 0);
        const totalRevenue = revenueToman + walletUsedToman;
        const productLines = topProducts.length
            ? topProducts.map((p, i) => `  ${i + 1}. ${String(p.name || "-")} (${Number(p.cnt || 0)} ╪│┘ü╪º╪▒╪┤)`).join("\n")
            : "  ΓÇö";
        const paymentLines = paymentMethods.length
            ? paymentMethods.map((m) => `  ${formatPaymentMethodTitle(m.payment_method)}: ${Number(m.cnt || 0)}`).join("\n")
            : "  ΓÇö";
        const lines = [
            `≡ƒôè ╪ó┘à╪º╪▒ ╪¿╪º╪▓┘ç: ${label}`,
            ``,
            `≡ƒÆ░ ╪»╪▒╪ó┘à╪»`,
            `  ┘╛╪▒╪»╪º╪«╪¬ ┘å┘é╪»█î: ${formatPriceToman(revenueToman)} ╪¬┘ê┘à╪º┘å`,
            `  ╪º╪▓ ┌⌐█î┘ü ┘╛┘ê┘ä: ${formatPriceToman(walletUsedToman)} ╪¬┘ê┘à╪º┘å`,
            `  ╪¼┘à╪╣ ┌⌐┘ä: ${formatPriceToman(totalRevenue)} ╪¬┘ê┘à╪º┘å`,
            ``,
            `≡ƒôª ╪│┘ü╪º╪▒╪┤ΓÇî┘ç╪º`,
            `  ┌⌐┘ä: ${Number(stats.total_orders || 0)}`,
            `  ┘à┘ê┘ü┘é: ${Number(stats.successful_orders || 0)}`,
            `  ╪»╪▒ ╪º┘å╪¬╪╕╪º╪▒: ${Number(stats.pending_orders || 0)}`,
            `  ╪▒╪»/┘ä╪║┘ê: ${Number(stats.failed_orders || 0)}`,
            ``,
            `≡ƒô╢ ╪»█î╪¬╪º`,
            `  ┘ü╪▒┘ê╪┤ ┘à╪¡╪╡┘ê┘ä: ${soldMbPeriod}MB (${(soldMbPeriod / 1024).toFixed(2)}GB)`,
            `  ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º: ${topupMbPeriod}MB`,
            `  ╪¼┘à╪╣: ${totalMbPeriod}MB (${(totalMbPeriod / 1024).toFixed(2)}GB)`,
            ``,
            `≡ƒæÑ ┌⌐╪º╪▒╪¿╪▒╪º┘å`,
            `  ┘à╪┤╪¬╪▒█î╪º┘å ┘à┘å╪¡╪╡╪▒╪¿┘ü╪▒╪»: ${Number(stats.unique_customers || 0)}`,
            `  ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪¼╪»█î╪»: ${Number(newUsers[0]?.cnt || 0)}`,
            ``,
            `≡ƒÅå ┘╛╪▒┘ü╪▒┘ê╪┤ΓÇî╪¬╪▒█î┘å ┘à╪¡╪╡┘ê┘ä╪º╪¬`,
            productLines,
            ``,
            `≡ƒÆ│ ╪▒┘ê╪┤ΓÇî┘ç╪º█î ┘╛╪▒╪»╪º╪«╪¬`,
            paymentLines,
        ];
        await tg("sendMessage", {
            chat_id: chatId,
            text: lines.join("\n"),
            reply_markup: {
                inline_keyboard: [
                    [
                        cb("≡ƒôà ╪º┘à╪▒┘ê╪▓", "admin_stats_period_today", period === "today" ? "success" : "primary"),
                        cb("≡ƒôà ╪»█î╪▒┘ê╪▓", "admin_stats_period_yesterday", period === "yesterday" ? "success" : "primary"),
                    ],
                    [
                        cb("≡ƒôà ┘ç┘ü╪¬┘ç ╪º╪«█î╪▒", "admin_stats_period_week", period === "week" ? "success" : "primary"),
                        cb("≡ƒôà ┘à╪º┘ç ╪º╪«█î╪▒", "admin_stats_period_month", period === "month" ? "success" : "primary"),
                    ],
                    [backButton("admin_stats", "≡ƒöÖ ╪ó┘à╪º╪▒ ┌⌐┘ä█î")]
                ]
            }
        });
        return null;
    }
    if (data === "admin_stats_buyers") {
        const rows = await sql `
      SELECT p.id, p.name, COUNT(DISTINCT o.telegram_id)::int AS buyers
      FROM products p
      LEFT JOIN orders o
        ON o.product_id = p.id
       AND (o.status = 'paid' OR o.status = 'awaiting_config')
      GROUP BY p.id, p.name
      ORDER BY p.id ASC;
    `;
        const keyboard = rows.map((p) => [cb(`${p.name} | ┘à╪┤╪¬╪▒█î: ${Number(p.buyers || 0)}`, `admin_stats_buyers_product_${p.id}`, "primary")]);
        keyboard.push([backButton("admin_stats", "≡ƒöÖ ╪¿╪º╪▓┌»╪┤╪¬ ╪¿┘ç ╪ó┘à╪º╪▒")]);
        await tg("sendMessage", {
            chat_id: chatId,
            text: "█î┌⌐ ┘à╪¡╪╡┘ê┘ä ╪▒╪º ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:",
            reply_markup: { inline_keyboard: keyboard }
        });
        return null;
    }
    if (data.startsWith("admin_stats_buyers_product_")) {
        const productId = Number(data.replace("admin_stats_buyers_product_", ""));
        const productRows = await sql `SELECT name FROM products WHERE id = ${productId} LIMIT 1;`;
        if (!productRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const rows = await sql `
      SELECT
        o.telegram_id,
        u.username,
        u.first_name,
        u.last_name,
        COUNT(*)::int AS buy_count
      FROM orders o
      LEFT JOIN users u ON u.telegram_id = o.telegram_id
      WHERE o.product_id = ${productId}
        AND (o.status = 'paid' OR o.status = 'awaiting_config')
      GROUP BY o.telegram_id, u.username, u.first_name, u.last_name
      ORDER BY buy_count DESC, o.telegram_id DESC
      LIMIT 100;
    `;
        if (!rows.length) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: `╪¿╪▒╪º█î ┘à╪¡╪╡┘ê┘ä ┬½${productRows[0].name}┬╗ ┘ç┘å┘ê╪▓ ┘à╪┤╪¬╪▒█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬.`,
                reply_markup: { inline_keyboard: [[backButton("admin_stats_buyers")]] }
            });
            return null;
        }
        const lines = rows.map((r, idx) => {
            const username = r.username ? `@${String(r.username)}` : "-";
            const fullName = [r.first_name ? String(r.first_name) : "", r.last_name ? String(r.last_name) : ""].filter(Boolean).join(" ").trim() || "-";
            return `${idx + 1}) ID: ${r.telegram_id} | ${username} | ${fullName} | ╪«╪▒█î╪»: ${Number(r.buy_count || 0)}`;
        });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘à╪┤╪¬╪▒█î╪º┘å ┘à╪¡╪╡┘ê┘ä: ${productRows[0].name}\n\n${lines.join("\n")}`,
            reply_markup: { inline_keyboard: [[backButton("admin_stats_buyers")]] }
        });
        return null;
    }
    if (data === "admin_tools") {
        const currentAdmins = await getAdminIds();
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪º╪¿╪▓╪º╪▒┘ç╪º█î ╪│╪▒█î╪╣ ╪º╪»┘à█î┘å:\n\n╪º╪»┘à█î┘åΓÇî┘ç╪º█î ┘ü╪╣┘ä█î: ${currentAdmins.length > 0 ? currentAdmins.join(", ") : "┘å╪»╪º╪▒╪»"}`,
            reply_markup: {
                inline_keyboard: [
                    [cb("≡ƒææ ╪º┘ü╪▓┘ê╪»┘å ╪º╪»┘à█î┘å", "admin_tool_add_admin", "success"), cb("≡ƒÜ½ ╪¡╪░┘ü ╪º╪»┘à█î┘å", "admin_tool_remove_admin", "danger")],
                    [cb("Γ¢ö ╪¿┘å ╪¿╪º █î┘ê╪▓╪▒┘å█î┘à", "admin_tool_ban_username", "danger")],
                    [cb("≡ƒôó ┘╛█î╪º┘à ┘ç┘à┌»╪º┘å█î", "admin_broadcast_message", "primary")],
                    [cb("Γ£ë∩╕Å ╪º╪▒╪│╪º┘ä ┘╛█î╪º┘à ╪¿┘ç ┌⌐╪º╪▒╪¿╪▒", "admin_tool_message_user", "primary")],
                    [cb("≡ƒöÄ ╪¼╪│╪¬╪¼┘ê█î ╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤", "admin_tool_lookup_purchase", "primary")],
                    [cb("≡ƒº╛ ╪¼╪│╪¬╪¼┘ê█î ┌⌐╪º┘å┘ü█î┌»/UUID", "admin_tool_lookup_config", "primary")],
                    [cb("≡ƒ¢á ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î", "admin_tool_create_config", "primary")],
                    [cb("≡ƒöÄ █î╪º┘ü╪¬┘å ┌⌐╪º┘å┘ü█î┌»ΓÇî┘ç╪º█î ┘à╪▒╪»┘ç", "admin_dead_configs", "primary")],
                    [cb("≡ƒÜ½ ┘ä█î╪│╪¬ ╪¿┘åΓÇî╪┤╪»┘çΓÇî┘ç╪º", "admin_banned_list_1", "primary")],
                    [cb("≡ƒöü ╪º┘å╪¬┘é╪º┘ä ┘à╪│╪¬┘é█î┘à ┌⌐╪º┘å┘ü█î┌»", "admin_tool_direct_migrate", "primary")],
                    [cb("≡ƒº¿ ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┘ç┘à┘ç ╪»╪º╪»┘çΓÇî┘ç╪º", "admin_reset_all_prompt", "danger")],
                    [backButton("admin_panel")]
                ]
            }
        });
        return null;
    }
    if (data === "admin_tool_add_admin") {
        await setState(userId, "admin_add_admin");
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘ä╪╖┘ü╪º┘ï ╪ó█î╪»█î ╪╣╪»╪»█î (Telegram ID) ┌⌐╪º╪▒╪¿╪▒█î ┌⌐┘ç ┘à█îΓÇî╪«┘ê╪º┘ç█î╪» ╪º╪»┘à█î┘å ┌⌐┘å█î╪» ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»:",
            reply_markup: { inline_keyboard: [[backButton("admin_tools")]] }
        });
        return null;
    }
    if (data === "admin_tool_remove_admin") {
        const currentAdmins = await getAdminIds();
        const envIds = String(process.env.ADMIN_IDS || "")
            .split(",")
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isFinite(x));
        // Only show removable admins (ones that are in settings, not env)
        const removableAdmins = currentAdmins.filter(id => !envIds.includes(id));
        if (removableAdmins.length === 0) {
            await tg("sendMessage", {
                chat_id: chatId,
                text: "┘ç█î┌å ╪º╪»┘à█î┘å ┘é╪º╪¿┘ä ╪¡╪░┘ü█î ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪».\n(╪º╪»┘à█î┘åΓÇî┘ç╪º█î ╪¬╪╣╪▒█î┘ü ╪┤╪»┘ç ╪»╪▒ ADMIN_IDS ┘é╪º╪¿┘ä ╪¡╪░┘ü ╪º╪▓ ╪º█î┘å╪¼╪º ┘å█î╪│╪¬┘å╪»)",
                reply_markup: { inline_keyboard: [[backButton("admin_tools")]] }
            });
            return null;
        }
        const keyboard = removableAdmins.map(id => [cb(`╪¡╪░┘ü ${id}`, `admin_confirm_remove_admin_${id}`, "danger")]);
        keyboard.push([backButton("admin_tools")]);
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┌⌐╪»╪º┘à ╪º╪»┘à█î┘å ╪▒╪º ┘à█îΓÇî╪«┘ê╪º┘ç█î╪» ╪¡╪░┘ü ┌⌐┘å█î╪»╪ƒ",
            reply_markup: { inline_keyboard: keyboard }
        });
        return null;
    }
    if (data.startsWith("admin_confirm_remove_admin_")) {
        const adminIdToRemove = Number(data.replace("admin_confirm_remove_admin_", ""));
        if (!Number.isFinite(adminIdToRemove) || adminIdToRemove <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪ó█î╪»█î ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        // Get current admin_ids from settings
        const currentSetting = (await getSetting("admin_ids")) || "";
        const currentIds = String(currentSetting)
            .split(/[,\s]+/)
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isFinite(x) && x !== adminIdToRemove);
        await setSetting("admin_ids", currentIds.join(","));
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪º╪»┘à█î┘å ${adminIdToRemove} ╪¡╪░┘ü ╪┤╪» Γ£à`,
            reply_markup: { inline_keyboard: [[backButton("admin_tools")]] }
        });
        return null;
    }
    if (data === "admin_tool_ban_username") {
        await setState(userId, "admin_ban_username");
        await tg("sendMessage", { chat_id: chatId, text: "█î┘ê╪▓╪▒┘å█î┘à ╪▒╪º ╪¿╪º █î╪º ╪¿╪»┘ê┘å @ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
        return null;
    }
    if (data === "admin_tool_message_user") {
        await startMessageUserWizard(chatId, userId);
        return null;
    }
    if (data === "admin_broadcast_message") {
        await setState(userId, "admin_broadcast_message_wizard", { step: "compose" });
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┘╛█î╪º┘à ┘ç┘à┌»╪º┘å█î\n\n┘à╪¬┘å ┘╛█î╪º┘à█î ┌⌐┘ç ┘à█îΓÇî╪«┘ê╪º┘ç█î╪» ╪¿┘ç ┘ç┘à┘ç ┌⌐╪º╪▒╪¿╪▒╪º┘å ╪º╪▒╪│╪º┘ä ╪┤┘ê╪» ╪▒╪º ╪¿┘å┘ê█î╪│█î╪»:",
            reply_markup: { inline_keyboard: [[cancelButton("admin_broadcast_cancel")]] }
        });
        return null;
    }
    if (data === "admin_broadcast_cancel") {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪º╪▒╪│╪º┘ä ┘╛█î╪º┘à ┘ç┘à┌»╪º┘å█î ┘ä╪║┘ê ╪┤╪»." });
        return null;
    }
    if (data === "admin_message_user_wizard_cancel") {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪º╪▒╪│╪º┘ä ┘╛█î╪º┘à ┘ä╪║┘ê ╪┤╪»." });
        return null;
    }
    if (data === "admin_tool_lookup_purchase") {
        await setState(userId, "admin_lookup_purchase");
        await tg("sendMessage", { chat_id: chatId, text: "╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: P123... █î╪º T123..." });
        return null;
    }
    if (data === "admin_tool_lookup_config") {
        await setState(userId, "admin_lookup_config");
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┌⌐╪º┘å┘ü█î┌» ┌⌐╪º┘à┘ä╪î UUID╪î ┘å╪º┘à ┌⌐╪º╪▒╪¿╪▒ (╪¬┘ä┌»╪▒╪º┘à █î╪º ┘╛┘å┘ä) █î╪º ┘å╪º┘à ┘à╪¡╪╡┘ê┘ä ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n" +
                "╪¿╪╣╪» ╪º╪▓ ┘╛█î╪»╪º ╪┤╪»┘å ┘å╪¬█î╪¼┘ç ┘à█îΓÇî╪¬┘ê╪º┘å█î╪» ╪º╪▓ ┘ç┘à╪º┘å ┘╛█î╪º┘à:\n" +
                "Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ╪»█î╪¬╪º | ΓÖ╗∩╕Å ╪▒█î╪│╪¬ ╪»█î╪¬╪º | ≡ƒôà ╪¬┘å╪╕█î┘à/╪¡╪░┘ü ╪º┘å┘é╪╢╪º | ≡ƒÜ½ ┘ä╪║┘ê ╪»╪│╪¬╪▒╪│█î | ≡ƒùæ ╪¡╪░┘ü ┌⌐╪º┘à┘ä"
        });
        return null;
    }
    if (data === "admin_tool_create_config") {
        await startAdminConfigBuilderWizard(chatId, userId);
        return null;
    }
    if (data === "admin_config_builder_cancel") {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î ┘ä╪║┘ê ╪┤╪»." });
        return null;
    }
    if (data.startsWith("admin_config_builder_panel_")) {
        const panelId = Number(data.replace("admin_config_builder_panel_", ""));
        const state = await getState(userId);
        if (!state || state.state !== "admin_config_builder_wizard")
            return null;
        if (!Number.isFinite(panelId) || panelId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "┘╛┘å┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        const payload = {
            ...state.payload,
            panelId,
            step: "name"
        };
        await setState(userId, "admin_config_builder_wizard", payload);
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤█î - ┘à╪▒╪¡┘ä┘ç 3 ╪º╪▓ 5\n┘å╪º┘à ∩┐╜∩┐╜╪º┘å┘ü█î┌» ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪». (╪º╪«╪¬█î╪º╪▒█î)\n╪¿╪▒╪º█î ╪▒╪»╪┤╪»┘å: -",
            reply_markup: { inline_keyboard: [[cancelButton("admin_config_builder_cancel")]] }
        });
        return null;
    }
    if (data.startsWith("admin_open_purchase_")) {
        const purchaseId = data.replace("admin_open_purchase_", "").trim();
        if (!purchaseId) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        await sendPurchaseLookupResult(chatId, purchaseId);
        return null;
    }
    if (data.startsWith("admin_banned_list_")) {
        const page = Math.max(1, Math.round(Number(data.replace("admin_banned_list_", "")) || 1));
        const pageSize = 20;
        const offset = (page - 1) * pageSize;
        const rows = await sql `
      SELECT b.telegram_id, b.reason, b.banned_by, b.created_at, u.username, u.first_name, u.last_name
      FROM banned_users b
      LEFT JOIN users u ON u.telegram_id = b.telegram_id
      ORDER BY b.created_at DESC
      OFFSET ${offset}
      LIMIT ${pageSize};
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘ä█î╪│╪¬ ╪¿┘åΓÇî╪┤╪»┘çΓÇî┘ç╪º ╪«╪º┘ä█î ╪º╪│╪¬.", reply_markup: { inline_keyboard: [[backButton("admin_tools")]] } });
            return null;
        }
        const lines = rows.map((r) => {
            const uname = r.username ? `@${String(r.username)}` : "-";
            const fullName = [r.first_name ? String(r.first_name) : "", r.last_name ? String(r.last_name) : ""].filter(Boolean).join(" ").trim() || "-";
            return `${r.telegram_id} | ${uname} | ${fullName} | reason:${String(r.reason || "-")}`;
        });
        const keyboard = [];
        keyboard.push([
            cb("Γ¼à∩╕Å ┘é╪¿┘ä█î", `admin_banned_list_${Math.max(1, page - 1)}`, "primary"),
            cb("╪¿╪╣╪»█î Γ₧í∩╕Å", `admin_banned_list_${page + 1}`, "primary")
        ]);
        keyboard.push([cb("≡ƒöô ╪ó┘å╪¿┘å ┌⌐╪º╪▒╪¿╪▒", "admin_unban_prompt", "success")]);
        keyboard.push([backButton("admin_tools")]);
        await tg("sendMessage", { chat_id: chatId, text: `┘ä█î╪│╪¬ ╪¿┘åΓÇî╪┤╪»┘çΓÇî┘ç╪º (╪╡┘ü╪¡┘ç ${page})\n\n${lines.join("\n")}`, reply_markup: { inline_keyboard: keyboard } });
        return null;
    }
    if (data === "admin_unban_prompt") {
        await setState(userId, "admin_unban_user");
        await tg("sendMessage", { chat_id: chatId, text: "telegram_id ┌⌐╪º╪▒╪¿╪▒ ╪▒╪º ╪¿╪▒╪º█î ╪ó┘å╪¿┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
        return null;
    }
    if (data === "admin_tool_direct_migrate") {
        await startDirectMigrateWizard(chatId, userId);
        return null;
    }
    if (data === "admin_reset_all_prompt") {
        await clearState(userId);
        await tg("sendMessage", {
            chat_id: chatId,
            text: "ΓÜá∩╕Å ┘ç╪┤╪»╪º╪▒ ┘╛╪º┌⌐ΓÇî╪│╪º╪▓█î ┌⌐╪º┘à┘ä\n\n" +
                "╪º█î┘å ╪╣┘à┘ä█î╪º╪¬ ┘ç┘à┘ç ╪»╪º╪»┘çΓÇî┘ç╪º█î ╪╣┘à┘ä█î╪º╪¬█î ╪▒╪¿╪º╪¬ ╪▒╪º ╪¡╪░┘ü ┘à█îΓÇî┌⌐┘å╪»:\n" +
                "┌⌐╪º╪▒╪¿╪▒╪º┘å╪î ╪│┘ü╪º╪▒╪┤ΓÇî┘ç╪º╪î ┌⌐█î┘ü ┘╛┘ê┘äΓÇî┘ç╪º╪î ┘à╪¡╪╡┘ê┘ä╪º╪¬╪î ┘à┘ê╪¼┘ê╪»█î╪î ┘╛┘å┘äΓÇî┘ç╪º╪î ┌⌐╪º╪▒╪¬ΓÇî┘ç╪º╪î ╪¬╪«┘ü█î┘üΓÇî┘ç╪º╪î ╪¬┘å╪╕█î┘à╪º╪¬╪î ╪»╪º╪»┘çΓÇî┘ç╪º█î ╪»╪╣┘ê╪¬ ┘ê ╪¬╪▒╪º┌⌐┘å╪┤ΓÇî┘ç╪º.\n\n" +
                "┘ü┘é╪╖ ╪»╪º╪»┘çΓÇî┘ç╪º█î ┌⌐╪┤ ┘à╪½┘ä ┘å╪▒╪« ╪º╪▒╪▓ ╪¡┘ü╪╕ ┘à█îΓÇî╪┤┘ê╪».\n" +
                "╪º█î┘å ╪╣┘à┘ä█î╪º╪¬ ┘é╪º╪¿┘ä ╪¿╪º╪▓┌»╪┤╪¬ ┘å█î╪│╪¬.",
            reply_markup: {
                inline_keyboard: [
                    [cb("Γ£ì∩╕Å ╪º╪»╪º┘à┘ç ╪¿╪º ╪¬╪º█î█î╪» ┘å┘ê╪┤╪¬╪º╪▒█î", "admin_reset_all_begin", "danger")],
                    [backButton("admin_tools")]
                ]
            }
        });
        return null;
    }
    if (data === "admin_reset_all_begin") {
        await setState(userId, "admin_reset_all_data");
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪¿╪▒╪º█î ╪¬╪º█î█î╪» ┘å┘ç╪º█î█î╪î ╪╣╪¿╪º╪▒╪¬ ╪▓█î╪▒ ╪▒╪º ╪»┘é█î┘é╪º┘ï ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»:\n\n" +
                "RESET ALL DATA\n\n" +
                "╪¿╪╣╪» ╪º╪▓ ╪º╪▒╪│╪º┘ä ╪º█î┘å ╪╣╪¿╪º╪▒╪¬╪î ┘ç┘à┘ç ╪»╪º╪»┘çΓÇî┘ç╪º█î ╪╣┘à┘ä█î╪º╪¬█î ╪¡╪░┘ü ┘à█îΓÇî╪┤┘ê┘å╪» ┘ê ┘ü┘é╪╖ ┌⌐╪┤ ╪¡┘ü╪╕ ╪«┘ê╪º┘ç╪» ╪┤╪»."
        });
        return null;
    }
    if (data === "admin_direct_migrate_wizard_cancel") {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪º┘å╪¬┘é╪º┘ä ┘à╪│╪¬┘é█î┘à ┘ä╪║┘ê ╪┤╪»." });
        return null;
    }
    if (data.startsWith("admin_direct_migrate_panel_")) {
        const targetPanelId = Number(data.replace("admin_direct_migrate_panel_", ""));
        const state = await getState(userId);
        if (!state || state.state !== "admin_direct_migrate_wizard")
            return null;
        const payload = { ...state.payload, targetPanelId, step: "user_telegram_id" };
        await setState(userId, "admin_direct_migrate_wizard", payload);
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪º┘å╪¬┘é╪º┘ä ┘à╪│╪¬┘é█î┘à - ┘à╪▒╪¡┘ä┘ç 3 ╪º╪▓ 4\ntelegram id ┌⌐╪º╪▒╪¿╪▒ ┘à┘é╪╡╪» ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪».",
            reply_markup: { inline_keyboard: [[cancelButton("admin_direct_migrate_wizard_cancel")]] }
        });
        return null;
    }
    if (data === "admin_settings") {
        const [support, walletRaw, infiniteMode, topupPriceRaw, productPriceRaw, customExtraDayPrice, tronadoKey, tetrapayKey, plisioKey, swapwalletKey, swapwalletShop, plisioAutoRate, plisioExtra, plisioFallback1, plisioFallback2, startMediaKind, startMediaValue, purchaseBonusEnabled, purchaseBonusMin, purchaseBonusMax, testConfigEnabled, testConfigMb, testConfigHours] = await Promise.all([
            getSetting("support_username"),
            getSetting("business_wallet_address"),
            getBoolSetting("global_infinite_mode", false),
            getSetting("topup_price_per_gb_toman"),
            getSetting("product_price_per_gb_toman"),
            getNumberSetting("custom_v2ray_extra_day_toman"),
            getSetting("tronado_api_key"),
            getSetting("tetrapay_api_key"),
            getSetting("plisio_api_key"),
            getSetting("swapwallet_api_key"),
            getSetting("swapwallet_shop_username"),
            getBoolSetting("plisio_auto_rate", true),
            getSetting("plisio_usdt_extra_toman"),
            getSetting("plisio_usdt_rate_fallback_toman"),
            getSetting("plisio_usd_rate_toman"),
            getSetting("start_media_kind"),
            getSetting("start_media_value"),
            getBoolSetting("purchase_bonus_enabled", false),
            getNumberSetting("purchase_bonus_min"),
            getNumberSetting("purchase_bonus_max"),
            getBoolSetting("test_config_enabled", false),
            getNumberSetting("test_config_mb"),
            getNumberSetting("test_config_hours")
        ]);
        const wallet = walletRaw || env.BUSINESS_WALLET_ADDRESS || "╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç";
        const topupPricePerGb = normalizePricePerGb(topupPriceRaw);
        const productPricePerGb = normalizePricePerGb(productPriceRaw, topupPricePerGb);
        const customExtraDayPriceFmt = Math.max(0, Math.round(Number(customExtraDayPrice) || 0));
        const publicBaseUrl = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        const tronadoKeyMasked = maskSecret(tronadoKey || "");
        const tetrapayKeyMasked = maskSecret(tetrapayKey || "");
        const plisioKeyMasked = maskSecret(plisioKey || "");
        const swapwalletKeyMasked = maskSecret(swapwalletKey || "");
        const swapwalletShopFmt = ((swapwalletShop) || "").trim();
        const plisioFallback = plisioFallback1 || plisioFallback2 || "";
        const startMediaKindFmt = ((startMediaKind) || "none");
        const startMediaValueFmt = (startMediaValue) || "";
        const referralSettings = await getReferralSettingsSnapshot();
        const referralProductName = referralSettings.productId
            ? String((await sql `SELECT name FROM products WHERE id = ${referralSettings.productId} LIMIT 1;`)[0]?.name || "")
            : "";
        const bonusMin = Math.round(purchaseBonusMin ?? 1000);
        const bonusMax = Math.round(purchaseBonusMax ?? 10000);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à╪º╪¬ ┘ü╪╣┘ä█î:\n` +
                `┘╛╪┤╪¬█î╪¿╪º┘å█î: ${support ? `@${support}` : "╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç"}\n` +
                `┌⌐█î┘ü ┘╛┘ê┘ä ┘à┘é╪╡╪»: ${wallet}\n` +
                `╪ó╪»╪▒╪│ ╪│╪º█î╪¬ (Callback Base): ${publicBaseUrl || "╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç"}\n` +
                `┌⌐┘ä█î╪» Tronado: ${tronadoKeyMasked}\n` +
                `┌⌐┘ä█î╪» TetraPay: ${tetrapayKeyMasked}\n` +
                `┌⌐┘ä█î╪» Plisio: ${plisioKeyMasked}\n` +
                `┌⌐┘ä█î╪» SwapWallet: ${swapwalletKeyMasked}${swapwalletShopFmt ? ` | ${swapwalletShopFmt}` : ""}\n` +
                `┘å╪▒╪« Plisio: ${plisioAutoRate ? "╪«┘ê╪»┌⌐╪º╪▒ (USDT)" : "╪»╪│╪¬█î"}\n` +
                `╪¡╪º╪┤█î┘ç ╪¬┘ê┘à╪º┘å/USDT: ${plisioExtra || "0"}\n` +
                `${plisioFallback ? `┘å╪▒╪« ╪»╪│╪¬█î (fallback): ${plisioFallback}\n` : ""}` +
                `┘à╪»█î╪º█î ╪┤╪▒┘ê╪╣: ${startMediaTitle(startMediaKindFmt, startMediaValueFmt)}\n` +
                `╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬: ${referralSettings.enabled ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"} | ┘ç╪▒ ${referralSettings.threshold} ╪»╪╣┘ê╪¬ = ${describeReferralReward(referralSettings, referralProductName || null)}\n` +
                `╪¿█î┘å┘ç╪º█î╪¬ ╪│╪▒╪º╪│╪▒█î: ${infiniteMode ? "╪▒┘ê╪┤┘å" : "╪«╪º┘à┘ê╪┤"}\n` +
                `┘é█î┘à╪¬ ╪º┘ü╪▓╪º█î╪┤ ┘ç╪▒ 1GB: ${formatPriceToman(topupPricePerGb)} ╪¬┘ê┘à╪º┘å\n` +
                `┘é█î┘à╪¬ ┘╛█î╪┤┘ü╪▒╪╢ ┘ç╪▒ 1GB ┘à╪¡╪╡┘ê┘ä: ${formatPriceToman(productPricePerGb)} ╪¬┘ê┘à╪º┘å\n` +
                `┘é█î┘à╪¬ ┘ç╪▒ ╪▒┘ê╪▓ (╪│┘ü╪º╪▒╪┤█î): ${formatPriceToman(customExtraDayPriceFmt)} ╪¬┘ê┘à╪º┘å\n` +
                `┘à╪¿┘ä╪║ ╪¬╪╡╪º╪»┘ü█î ╪«╪▒█î╪»: ${purchaseBonusEnabled ? `Γ£à ┘ü╪╣╪º┘ä (${formatPriceToman(bonusMin)}~${formatPriceToman(bonusMax)} ╪¬┘ê┘à╪º┘å)` : "Γ¥î ╪║█î╪▒┘ü╪╣╪º┘ä"}\n` +
                `┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬: ${testConfigEnabled ? `Γ£à ┘ü╪╣╪º┘ä (${Math.round(testConfigMb ?? 100)}MB | ${Math.round(testConfigHours ?? 24)} ╪│╪º╪╣╪¬)` : "Γ¥î ╪║█î╪▒┘ü╪╣╪º┘ä"}`,
            reply_markup: {
                inline_keyboard: [
                    [cb("≡ƒôó ┌⌐╪º┘å╪º┘äΓÇî┘ç╪º█î ╪º╪¼╪¿╪º╪▒█î", "admin_set_mandatory_channels", "primary")],
                    [cb("≡ƒåÿ █î┘ê╪▓╪▒┘å█î┘à ┘╛╪┤╪¬█î╪¿╪º┘å█î", "admin_set_support", "primary")],
                    [cb("≡ƒæ¢ ┌⌐█î┘ü ┘╛┘ê┘ä ┘à┘é╪╡╪»", "admin_set_wallet", "primary")],
                    [cb("≡ƒÄü ╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬", "admin_referral_settings", "primary")],
                    [cb("≡ƒöæ ╪¬┘å╪╕█î┘à╪º╪¬ ╪»╪▒┌»╪º┘çΓÇî┘ç╪º", "admin_gateway_settings", "primary")],
                    [cb("≡ƒÄ¼ ┘à╪»█î╪º█î ╪┤╪▒┘ê╪╣", "admin_start_media", "primary")],
                    [cb("≡ƒôê ┘é█î┘à╪¬ ╪º┘ü╪▓╪º█î╪┤ ┘ç╪▒ 1GB", "admin_set_topup_price", "primary")],
                    [cb("≡ƒÅ╖ ┘é█î┘à╪¬ ┘╛█î╪┤┘ü╪▒╪╢ ┘ç╪▒ 1GB ┘à╪¡╪╡┘ê┘ä", "admin_set_product_price", "primary")],
                    [cb("≡ƒÄ¢ ┘à╪¡╪╡┘ê┘ä ╪│┘ü╪º╪▒╪┤█î", "admin_custom_v2ray_menu", "primary")],
                    [cb("≡ƒÄ▓ ┘à╪¿┘ä╪║ ╪¬╪╡╪º╪»┘ü█î ╪«╪▒█î╪»", "admin_purchase_bonus_settings", "primary")],
                    [cb("≡ƒº¬ ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪▒╪º█î┌»╪º┘å", "admin_test_config_settings", "primary")],
                    [
                        cb(infiniteMode ? "ΓÖ╛∩╕Å ╪«╪º┘à┘ê╪┤ΓÇî┌⌐╪▒╪»┘å ╪¡╪º┘ä╪¬ ╪¿█î┘å┘ç╪º█î╪¬" : "ΓÖ╛∩╕Å ╪▒┘ê╪┤┘åΓÇî┌⌐╪▒╪»┘å ╪¡╪º┘ä╪¬ ╪¿█î┘å┘ç╪º█î╪¬", "admin_toggle_global_infinite", infiniteMode ? "danger" : "success")
                    ],
                    [cb("≡ƒÆ╛ ┘╛╪┤╪¬█î╪¿╪º┘åΓÇî┌»█î╪▒█î ┘ê ╪¿╪º╪▓█î╪º╪¿█î ╪»╪º╪»┘ç", "admin_backup_menu", "primary")],
                    [backButton("admin_panel")]
                ]
            }
        });
        return null;
    }
    if (data === "admin_backup_menu") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "≡ƒÆ╛ ┘╛╪┤╪¬█î╪¿╪º┘åΓÇî┌»█î╪▒█î ┘ê ╪¿╪º╪▓█î╪º╪¿█î ╪»╪º╪»┘ç\n\n" +
                "ΓÇó ┘╛╪┤╪¬█î╪¿╪º┘åΓÇî┌»█î╪▒█î: ╪¬┘à╪º┘à ╪¼╪»╪º┘ê┘ä ┘╛╪º█î┌»╪º┘ç ╪»╪º╪»┘ç (╪¬┘å╪╕█î┘à╪º╪¬╪î ┌⌐╪º╪▒╪¿╪▒╪º┘å╪î ┘à╪¡╪╡┘ê┘ä╪º╪¬╪î ╪│┘ü╪º╪▒╪┤╪º╪¬ ┘ê ...) ╪▒╪º ╪¿┘ç ╪╡┘ê╪▒╪¬ █î┌⌐ ┘ü╪º█î┘ä JSON ╪╡╪º╪»╪▒ ┘à█îΓÇî┌⌐┘å╪».\n" +
                "ΓÇó ╪¿╪º╪▓█î╪º╪¿█î: ┘ü╪º█î┘ä JSON ╪¿┌⌐╪º┘╛ ╪▒╪º ╪»╪▒█î╪º┘ü╪¬ ┌⌐╪▒╪»┘ç ┘ê ╪¬┘à╪º┘à ╪»╪º╪»┘çΓÇî┘ç╪º ╪▒╪º ╪¼╪º█î┌»╪▓█î┘å ┘à█îΓÇî┌⌐┘å╪».\n\n" +
                "ΓÜá∩╕Å ╪¿╪º╪▓█î╪º╪¿█î ╪¬┘à╪º┘à ╪»╪º╪»┘çΓÇî┘ç╪º█î ┘ü╪╣┘ä█î ╪▒╪º ┘╛╪º┌⌐ ┌⌐╪▒╪»┘ç ┘ê ╪¿╪º ╪»╪º╪»┘çΓÇî┘ç╪º█î ╪¿┌⌐╪º┘╛ ╪¼╪º█î┌»╪▓█î┘å ┘à█îΓÇî┌⌐┘å╪».",
            reply_markup: {
                inline_keyboard: [
                    [cb("≡ƒôñ ┌»╪▒┘ü╪¬┘å ╪¿┌⌐╪º┘╛ ╪º┘ä╪º┘å", "admin_trigger_backup", "success")],
                    [cb("≡ƒôÑ ╪¿╪º╪▓█î╪º╪¿█î ╪º╪▓ ┘ü╪º█î┘ä ╪¿┌⌐╪º┘╛", "admin_trigger_restore", "danger")],
                    [cb("╪¬┘å╪╕█î┘à╪º╪¬ ┘╛█î┘å┌»┌å█î (Pingchi)", "admin_pingchi_settings", "primary")],
                    [backButton("admin_settings")]
                ]
            }
        });
        return null;
    }
    if (data === "admin_trigger_backup") {
        const token = generateAdminToken(userId);
        const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        const link = `${callbackBase}/backup.html?token=${encodeURIComponent(token)}`;
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒÆ╛ ┘╛╪┤╪¬█î╪¿╪º┘åΓÇî┌»█î╪▒█î ╪º╪▓ ╪▒╪¿╪º╪¬\n\n` +
                `╪▒┘ê█î ┘ä█î┘å┌⌐ ╪▓█î╪▒ ┌⌐┘ä█î┌⌐ ┌⌐┘å█î╪» ╪¬╪º ╪╡┘ü╪¡┘ç ╪¿┌⌐╪º┘╛ ╪¿╪º╪▓ ╪┤┘ê╪».\n` +
                `╪»╪▒ ╪ó┘å ╪╡┘ü╪¡┘ç ╪»┌⌐┘à┘ç ≡ƒôÑ Download Backup ╪▒╪º ╪¿╪▓┘å█î╪».\n\n` +
                `╪º█î┘å ┘ä█î┘å┌⌐ ╪¬╪º █▓ ╪│╪º╪╣╪¬ ┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬:\n\n` +
                `<code>${escapeHtml(link)}</code>\n\n` +
                `┘å┌⌐╪¬┘ç: ╪¿┌⌐╪º┘╛ ╪¼╪»┘ê┘ä ╪¿┘ç ╪¼╪»┘ê┘ä ╪»╪▒█î╪º┘ü╪¬ ┘à█îΓÇî╪┤┘ê╪» ╪¬╪º ╪º╪▓ ╪¬╪º█î┘àΓÇî╪º┘ê╪¬ ╪¼┘ä┘ê┌»█î╪▒█î ╪┤┘ê╪».`,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[backButton("admin_backup_menu")]]
            }
        });
        return null;
    }
    if (data === "admin_trigger_restore") {
        const token = generateAdminToken(userId);
        const callbackBase = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        const link = `${callbackBase}/backup.html?token=${encodeURIComponent(token)}`;
        await setState(userId, "admin_awaiting_restore_file");
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒôÑ ╪¿╪º╪▓█î╪º╪¿█î ╪º╪▓ ╪¿┌⌐╪º┘╛\n\n` +
                `ΓÜá∩╕Å ╪º█î┘å ╪╣┘à┘ä█î╪º╪¬ ╪¬┘à╪º┘à ╪»╪º╪»┘çΓÇî┘ç╪º█î ┘ü╪╣┘ä█î ╪▒╪º ┘╛╪º┌⌐ ┌⌐╪▒╪»┘ç ┘ê ╪¿╪º ╪»╪º╪»┘çΓÇî┘ç╪º█î ╪¿┌⌐╪º┘╛ ╪¼╪º█î┌»╪▓█î┘å ┘à█îΓÇî┌⌐┘å╪».\n\n` +
                `┌»╪▓█î┘å┘ç █▒ ΓÇö ╪╡┘ü╪¡┘ç ┘ê╪¿ (╪¬┘ê╪╡█î┘ç ╪┤╪»┘ç):\n<code>${escapeHtml(link)}</code>\n\n` +
                `┌»╪▓█î┘å┘ç █▓ ΓÇö ╪º╪▒╪│╪º┘ä ┘ü╪º█î┘ä JSON ╪¿┌⌐╪º┘╛ ┘à╪│╪¬┘é█î┘à ╪»╪▒ ┘ç┘à█î┘å ┌å╪¬\n` +
                `- = ┘ä╪║┘ê`,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[{ text: "Γ¥î ┘ä╪║┘ê", callback_data: "admin_cancel_restore" }]]
            }
        });
        return null;
    }
    if (data === "admin_cancel_restore") {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "╪¿╪º╪▓█î╪º╪¿█î ┘ä╪║┘ê ╪┤╪»." });
        return null;
    }
    if (data === "admin_pingchi_settings") {
        const key = await getPingchiKey();
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à╪º╪¬ ┘╛█î┘å┌»┌å█î (Pingchi)\n\n┌⌐┘ä█î╪» ┘ê╪¿ΓÇî╪│╪▒┘ê█î╪│: ${key ? "╪¬┘å╪╕█î┘à ╪┤╪»┘ç Γ£à" : "╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç Γ¥î"}\n\n╪º╪▓ ┌»╪▓█î┘å┘çΓÇî┘ç╪º█î ╪▓█î╪▒ ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»:`,
            reply_markup: {
                inline_keyboard: [
                    [cb("≡ƒöæ ╪¬┘å╪╕█î┘à ┌⌐┘ä█î╪» ╪»╪│╪¬╪▒╪│█î (API Key)", "admin_pingchi_set_key", "primary")],
                    [cb("≡ƒùæ ╪¡╪░┘ü ┌⌐┘ä█î╪» ╪»╪│╪¬╪▒╪│█î", "admin_pingchi_clear_key", "danger")],
                    [backButton("admin_settings")]
                ]
            }
        });
        return null;
    }
    if (data === "admin_pingchi_clear_key") {
        await sql `DELETE FROM settings WHERE key = 'pingchi_api_key'`;
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» ╪»╪│╪¬╪▒╪│█î ┘╛█î┘å┌»┌å█î ╪¡╪░┘ü ╪┤╪»." });
        return null;
    }
    if (data === "admin_pingchi_set_key") {
        await setState(userId, "admin_pingchi_set_key");
        await tg("sendMessage", { chat_id: chatId, text: "┘ä╪╖┘ü╪º┘ï ┌⌐┘ä█î╪» ╪»╪│╪¬╪▒╪│█î (API Key) ┘╛█î┘å┌»┌å█î ╪▒╪º ╪¿┘ü╪▒╪│╪¬█î╪»:" });
        return null;
    }
    if (data === "admin_referral_settings") {
        await showAdminReferralSettings(chatId);
        return null;
    }
    if (data === "admin_toggle_referral_enabled") {
        const current = await getBoolSetting("referral_enabled", false);
        await setSetting("referral_enabled", (!current).toString());
        await tg("sendMessage", { chat_id: chatId, text: `╪│█î╪│╪¬┘à ╪»╪╣┘ê╪¬ ${!current ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"} ╪┤╪» Γ£à` });
        return null;
    }
    if (data === "admin_set_referral_threshold") {
        await setState(userId, "admin_set_referral_threshold");
        await tg("sendMessage", { chat_id: chatId, text: "╪¬╪╣╪»╪º╪» ╪»╪╣┘ê╪¬ ┘ä╪º╪▓┘à ╪¿╪▒╪º█î ┘ç╪▒ ╪¼╪º█î╪▓┘ç ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 5" });
        return null;
    }
    if (data === "admin_set_referral_wallet_amount") {
        await setState(userId, "admin_set_referral_wallet_amount");
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¿┘ä╪║ ╪¼╪º█î╪▓┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 50000" });
        return null;
    }
    if (data === "admin_referral_reward_wallet") {
        await setSetting("referral_reward_type", "wallet");
        await tg("sendMessage", { chat_id: chatId, text: "┘å┘ê╪╣ ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪▒┘ê█î ╪º╪╣╪¬╪¿╪º╪▒ ┌⌐█î┘ü ┘╛┘ê┘ä ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_referral_reward_config") {
        await setSetting("referral_reward_type", "config");
        await tg("sendMessage", { chat_id: chatId, text: "┘å┘ê╪╣ ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪▒┘ê█î ┌⌐╪º┘å┘ü█î┌» ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_referral_delivery_panel") {
        await setSetting("referral_config_delivery_mode", "panel");
        await tg("sendMessage", { chat_id: chatId, text: "╪▒┘ê╪┤ ╪¬╪¡┘ê█î┘ä ╪¼╪º█î╪▓┘ç ┌⌐╪º┘å┘ü█î┌» ╪▒┘ê█î ┘╛┘å┘ä ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_referral_delivery_storage") {
        await setSetting("referral_config_delivery_mode", "admin");
        await tg("sendMessage", {
            chat_id: chatId,
            text: "╪º█î┘å ┌»╪▓█î┘å┘ç ╪¿┘ç ╪¡╪º┘ä╪¬ ╪¼╪»█î╪» ┘à┘å╪¬┘é┘ä ╪┤╪» Γ£à\n╪▒┘ê╪┤ ╪¬╪¡┘ê█î┘ä: ╪»╪│╪¬█î (╪º┘ê┘ä┘ê█î╪¬ ╪º┘å╪¿╪º╪▒╪î ╪»╪▒ ╪╡┘ê╪▒╪¬ ╪«╪º┘ä█î ╪¿┘ê╪»┘å ╪¬╪¡┘ê█î┘ä ╪»╪│╪¬█î ╪º╪»┘à█î┘å)"
        });
        return null;
    }
    if (data === "admin_referral_delivery_admin") {
        await setSetting("referral_config_delivery_mode", "admin");
        await tg("sendMessage", { chat_id: chatId, text: "╪▒┘ê╪┤ ╪¬╪¡┘ê█î┘ä ╪¼╪º█î╪▓┘ç ┌⌐╪º┘å┘ü█î┌» ╪▒┘ê█î ╪¬╪¡┘ê█î┘ä ╪»╪│╪¬█î ╪º╪»┘à█î┘å ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_referral_pick_product") {
        await showAdminReferralProductPicker(chatId);
        return null;
    }
    if (data === "admin_referral_clear_product") {
        await setSetting("referral_reward_product_id", "");
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
        return null;
    }
    if (data.startsWith("admin_referral_product_")) {
        const productId = Number(data.replace("admin_referral_product_", ""));
        const rows = await sql `SELECT name FROM products WHERE id = ${productId} LIMIT 1;`;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ┘à┘ê╪▒╪»┘å╪╕╪▒ ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        await setSetting("referral_reward_type", "config");
        await setSetting("referral_reward_product_id", String(productId));
        await tg("sendMessage", { chat_id: chatId, text: `┘à╪¡╪╡┘ê┘ä ╪¼╪º█î╪▓┘ç ╪»╪╣┘ê╪¬ ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à\n${String(rows[0].name)}` });
        return null;
    }
    if (data === "admin_start_media") {
        const kindRaw = ((await getSetting("start_media_kind")) || "none");
        const value = (await getSetting("start_media_value")) || "";
        const kind = ["none", "text", "sticker", "animation", "photo"].includes(kindRaw)
            ? kindRaw
            : "none";
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒÄ¼ ┘à╪»█î╪º█î ╪┤╪▒┘ê╪╣\n\n` +
                `┘ê╪╢╪╣█î╪¬ ┘ü╪╣┘ä█î: ${startMediaTitle(kind, value)}\n\n` +
                `┘å┌⌐╪¬┘ç: ╪º█î┘å ┘à╪»█î╪º ┘ü┘é╪╖ ┘ç┘å┌»╪º┘à /start ┘é╪¿┘ä ╪º╪▓ ┘à┘å┘ê█î ╪º╪╡┘ä█î ╪º╪▒╪│╪º┘ä ┘à█îΓÇî╪┤┘ê╪».`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "≡ƒÖé ╪º█î┘à┘ê╪¼█î/┘à╪¬┘å", callback_data: "admin_start_media_set_text" }],
                    [{ text: "≡ƒº⌐ ╪º╪│╪¬█î┌⌐╪▒", callback_data: "admin_start_media_set_sticker" }],
                    [{ text: "≡ƒÄ₧ ┌»█î┘ü", callback_data: "admin_start_media_set_animation" }],
                    [{ text: "≡ƒû╝ ╪╣┌⌐╪│", callback_data: "admin_start_media_set_photo" }],
                    [{ text: "≡ƒÜ½ ╪«╪º┘à┘ê╪┤", callback_data: "admin_start_media_disable" }],
                    [{ text: "≡ƒöÖ ╪¿╪º╪▓┌»╪┤╪¬", callback_data: "admin_settings" }]
                ]
            }
        });
        return null;
    }
    if (data === "admin_custom_v2ray_menu") {
        const enabled = await getBoolSetting("custom_v2ray_enabled", false);
        const dayPrice = Math.max(0, Math.round((await getNumberSetting("custom_v2ray_extra_day_toman")) || 0));
        const minGb = Math.max(1, Math.round((await getNumberSetting("custom_v2ray_min_gb")) || 1));
        const minDays = Math.max(1, Math.round((await getNumberSetting("custom_v2ray_min_days")) || 30));
        const pricePerGb = normalizePricePerGb(await getSetting("product_price_per_gb_toman"), normalizePricePerGb(await getSetting("topup_price_per_gb_toman")));
        const minPrice = Math.max(1, (pricePerGb * minGb) + (minDays * dayPrice));
        let productId = Number((await getSetting("custom_v2ray_product_id")) || 0);
        if (enabled && (!Number.isFinite(productId) || productId <= 0)) {
            const ensured = await ensureCustomV2rayProduct();
            if (ensured.ok)
                productId = ensured.productId;
        }
        const productRows = productId ? await sql `SELECT name, sell_mode, is_active FROM products WHERE id = ${productId} LIMIT 1;` : [];
        const productName = productRows.length ? String(productRows[0].name || "-") : "-";
        const sellMode = productRows.length ? parseSellMode(String(productRows[0].sell_mode || "")) : "manual";
        const isActive = productRows.length ? Boolean(productRows[0].is_active) : false;
        const keyboard = [];
        keyboard.push([cb(enabled ? "≡ƒÜ½ ╪«╪º┘à┘ê╪┤ΓÇî┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤█î" : "Γ£à ╪▒┘ê╪┤┘åΓÇî┌⌐╪▒╪»┘å ╪│┘ü╪º╪▒╪┤█î", "admin_custom_v2ray_toggle", enabled ? "danger" : "success")]);
        keyboard.push([cb("≡ƒôà ┘é█î┘à╪¬ ┘ç╪▒ ╪▒┘ê╪▓ (╪│┘ü╪º╪▒╪┤█î)", "admin_set_custom_v2ray_extra_day", "primary")]);
        keyboard.push([
            cb("╪¡╪»╪º┘é┘ä ╪¡╪¼┘à", "admin_set_custom_v2ray_min_gb", "primary"),
            cb("╪¡╪»╪º┘é┘ä ╪▓┘à╪º┘å", "admin_set_custom_v2ray_min_days", "primary")
        ]);
        if (productId) {
            keyboard.push([cb("Γ£Å∩╕Å ┘ê█î╪▒╪º█î╪┤ ┘à╪¡╪╡┘ê┘ä ╪│┘ü╪º╪▒╪┤█î", `admin_edit_product_${productId}`, "primary")]);
            keyboard.push([cb(sellMode === "panel" ? "ΓÜÖ∩╕Å ╪¡╪º┘ä╪¬ ┘ü╪▒┘ê╪┤: ┘╛┘å┘ä" : "ΓÜÖ∩╕Å ╪¡╪º┘ä╪¬ ┘ü╪▒┘ê╪┤: ╪»╪│╪¬█î", `admin_toggle_product_sell_mode_${productId}`, "primary")]);
            keyboard.push([cb("≡ƒº⌐ ╪¬┘å╪╕█î┘à ┘ü╪▒┘ê╪┤ ┘╛┘å┘ä", `admin_configure_product_panel_${productId}`, "primary")]);
        }
        keyboard.push([backButton("admin_settings")]);
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒÄ¢ ┘à╪¡╪╡┘ê┘ä ╪│┘ü╪º╪▒╪┤█î\n\n` +
                `┘ê╪╢╪╣█î╪¬: ${enabled ? "╪▒┘ê╪┤┘å Γ£à" : "╪«╪º┘à┘ê╪┤ ≡ƒÜ½"}\n` +
                `┘à╪¡╪╡┘ê┘ä: ${productId ? `${productName} (#${productId})${!isActive ? " (┘à╪«┘ü█î)" : ""}` : "╪│╪º╪«╪¬┘ç ┘å╪┤╪»┘ç"}\n` +
                `╪┤╪▒┘ê╪╣ ╪«╪▒█î╪»: ╪¡╪»╪º┘é┘ä ${minGb}GB / ╪¡╪»╪º┘é┘ä ${minDays} ╪▒┘ê╪▓\n` +
                `┘é█î┘à╪¬ ┘ç╪▒ 1GB: ${formatPriceToman(pricePerGb)} ╪¬┘ê┘à╪º┘å\n` +
                `┘é█î┘à╪¬ ┘ç╪▒ ╪▒┘ê╪▓: ${formatPriceToman(dayPrice)} ╪¬┘ê┘à╪º┘å\n` +
                `╪¡╪»╪º┘é┘ä ┘à╪¿┘ä╪║ ╪┤╪▒┘ê╪╣: ${formatPriceToman(minPrice)} ╪¬┘ê┘à╪º┘å\n\n` +
                `┘å┌⌐╪¬┘ç: ┘å┘ê╪╣ ╪¬╪¡┘ê█î┘ä (┘ü╪▒┘ê╪┤ ╪º╪▓ ┘╛┘å┘ä █î╪º ╪»╪│╪¬█î) ╪º╪▓ ╪╖╪▒█î┘é ┘ê█î╪▒╪º█î╪┤ ┘ç┘à█î┘å ┘à╪¡╪╡┘ê┘ä ╪¬╪╣█î█î┘å ┘à█îΓÇî╪┤┘ê╪».`,
            reply_markup: { inline_keyboard: keyboard }
        });
        return null;
    }
    if (data === "admin_custom_v2ray_toggle") {
        const current = await getBoolSetting("custom_v2ray_enabled", false);
        if (!current) {
            const ensured = await ensureCustomV2rayProduct();
            if (!ensured.ok) {
                await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪│╪º╪«╪¬/╪ó┘à╪º╪»┘çΓÇî╪│╪º╪▓█î ┘à╪¡╪╡┘ê┘ä ╪│┘ü╪º╪▒╪┤█î." });
                return null;
            }
            await sql `UPDATE products SET is_active = TRUE WHERE id = ${ensured.productId};`;
            await setSetting("custom_v2ray_enabled", "true");
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤█î ╪▒┘ê╪┤┘å ╪┤╪» Γ£à" });
            return null;
        }
        const productId = Number((await getSetting("custom_v2ray_product_id")) || 0);
        if (Number.isFinite(productId) && productId > 0) {
            await sql `UPDATE products SET is_active = FALSE WHERE id = ${productId};`;
        }
        await setSetting("custom_v2ray_enabled", "false");
        await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤█î ╪«╪º┘à┘ê╪┤ ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_start_media_disable") {
        await setSetting("start_media_kind", "none");
        await setSetting("start_media_value", "");
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪»█î╪º█î ╪┤╪▒┘ê╪╣ ╪«╪º┘à┘ê╪┤ ╪┤╪» Γ£à" });
        return null;
    }
    if (data.startsWith("admin_start_media_set_")) {
        const kind = data.replace("admin_start_media_set_", "").trim();
        if (kind !== "text" && kind !== "sticker" && kind !== "animation" && kind !== "photo") {
            await tg("sendMessage", { chat_id: chatId, text: "┌»╪▓█î┘å┘ç ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        await setState(userId, "admin_set_start_media", { kind });
        const hints = kind === "text"
            ? "┘à╪¬┘å/╪º█î┘à┘ê╪¼█î ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å.\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -"
            : kind === "sticker"
                ? "╪º╪│╪¬█î┌⌐╪▒ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å.\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -"
                : kind === "animation"
                    ? "┌»█î┘ü ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å.\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -"
                    : "╪╣┌⌐╪│ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å.\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -";
        await tg("sendMessage", { chat_id: chatId, text: `≡ƒÄ¼ ╪¬┘å╪╕█î┘à ┘à╪»█î╪º█î ╪┤╪▒┘ê╪╣\n\n${hints}` });
        return null;
    }
    if (data === "admin_set_mandatory_channels") {
        await setState(userId, "admin_set_mandatory_channels");
        const current = await getSetting("mandatory_channels");
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┘ä█î╪│╪¬ ┌⌐╪º┘å╪º┘äΓÇî┘ç╪º█î ╪º╪¼╪¿╪º╪▒█î ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n\n` +
                `┘ç╪▒ ┌⌐╪º┘å╪º┘ä ╪»╪▒ █î┌⌐ ╪«╪╖ █î╪º ╪¼╪»╪º ╪┤╪»┘ç ╪¿╪º ┘ê█î╪▒┌»┘ê┘ä.\n` +
                `┘à╪½╪º┘ä:\n<code>@channel1</code>\n<code>@channel2</code>\n\n` +
                `╪¿╪▒╪º█î ╪║█î╪▒┘ü╪╣╪º┘ä ┌⌐╪▒╪»┘å: <code>╪«╪º┘à┘ê╪┤</code>\n\n` +
                `┘ê╪╢╪╣█î╪¬ ┘ü╪╣┘ä█î:\n<code>${escapeHtml(current || "╪«╪º┘à┘ê╪┤")}</code>`,
            parse_mode: "HTML"
        });
        return null;
    }
    if (data === "admin_set_support") {
        await setState(userId, "admin_set_support");
        await tg("sendMessage", { chat_id: chatId, text: "█î┘ê╪▓╪▒┘å█î┘à ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪▒╪º ╪¿╪»┘ê┘å @ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
        return null;
    }
    if (data === "admin_set_wallet") {
        await setState(userId, "admin_set_wallet");
        await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä ┘à┘é╪╡╪» ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
        return null;
    }
    if (data === "admin_gateway_settings") {
        const publicBaseUrl = await getPublicBaseUrl(env.PUBLIC_BASE_URL);
        const tronadoKeyMasked = maskSecret((await getSetting("tronado_api_key")) || "");
        const tetrapayKeyMasked = maskSecret((await getSetting("tetrapay_api_key")) || "");
        const plisioKeyMasked = maskSecret((await getSetting("plisio_api_key")) || "");
        const swapwalletKeyMasked = maskSecret((await getSetting("swapwallet_api_key")) || "");
        const swapwalletShop = ((await getSetting("swapwallet_shop_username")) || "").trim();
        const usdtAutoRate = await getBoolSetting("usdt_auto_rate", true);
        const usdtManual = ((await getSetting("usdt_toman_rate")) || "").trim();
        const plisioAutoRate = await getBoolSetting("plisio_auto_rate", true);
        const plisioExtra = (await getSetting("plisio_usdt_extra_toman")) || "0";
        const plisioFallback = (await getSetting("plisio_usdt_rate_fallback_toman")) || (await getSetting("plisio_usd_rate_toman")) || "";
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à╪º╪¬ ╪»╪▒┌»╪º┘çΓÇî┘ç╪º:\n` +
                `╪ó╪»╪▒╪│ ╪│╪º█î╪¬ (Callback Base): ${publicBaseUrl || "╪¬┘å╪╕█î┘à ┘å╪┤╪»┘ç"}\n` +
                `Tronado: ${tronadoKeyMasked}\n` +
                `TetraPay: ${tetrapayKeyMasked}\n` +
                `Plisio: ${plisioKeyMasked}\n` +
                `SwapWallet: ${swapwalletKeyMasked}${swapwalletShop ? ` | ${swapwalletShop}` : ""}\n` +
                `┘å╪▒╪« USDT: ${usdtAutoRate ? "╪«┘ê╪»┌⌐╪º╪▒ (CoinGecko)" : "╪»╪│╪¬█î"}${usdtManual ? ` | ${usdtManual} ╪¬┘ê┘à╪º┘å` : ""}\n` +
                `┘å╪▒╪« Plisio: ${plisioAutoRate ? "╪«┘ê╪»┌⌐╪º╪▒ (IRRΓåÆUSDT)" : "╪»╪│╪¬█î"}\n` +
                `╪¡╪º╪┤█î┘ç ╪¬┘ê┘à╪º┘å/USDT: ${plisioExtra}\n` +
                `${plisioFallback ? `┘å╪▒╪« ╪»╪│╪¬█î (fallback): ${plisioFallback}\n` : ""}\n` +
                `╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å ┘ç╪▒ ┘à┘ê╪▒╪»: -`,
            reply_markup: {
                inline_keyboard: [
                    [cb("≡ƒîÉ ╪ó╪»╪▒╪│ ╪│╪º█î╪¬", "admin_set_public_base_url", "primary")],
                    [cb("≡ƒöæ ┌⌐┘ä█î╪» Tronado", "admin_set_tronado_api_key", "primary")],
                    [cb("≡ƒöæ ┌⌐┘ä█î╪» TetraPay", "admin_set_tetrapay_api_key", "primary")],
                    [cb("≡ƒöæ ┌⌐┘ä█î╪» Plisio", "admin_set_plisio_api_key", "primary")],
                    [cb("≡ƒöæ ┌⌐┘ä█î╪» SwapWallet", "admin_set_swapwallet_api_key", "primary")],
                    [cb("≡ƒÅ╖ Shop SwapWallet", "admin_set_swapwallet_shop_username", "primary")],
                    [cb("≡ƒ¬Ö ┌⌐█î┘ü ┘╛┘ê┘äΓÇî┘ç╪º█î ┌⌐╪▒█î┘╛╪¬┘ê", "admin_crypto_wallets", "primary")],
                    [cb(usdtAutoRate ? "Γ£à ┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒ USDT" : "Γ¥î ┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒ USDT", "admin_toggle_usdt_auto_rate", usdtAutoRate ? "success" : "danger")],
                    [cb("≡ƒÆ▒ ┘å╪▒╪« ╪»╪│╪¬█î USDT", "admin_set_usdt_toman_rate", "primary")],
                    [cb(plisioAutoRate ? "Γ£à ┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒ Plisio" : "Γ¥î ┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒ Plisio", "admin_toggle_plisio_auto_rate", plisioAutoRate ? "success" : "danger")],
                    [cb("Γ₧ò ╪¡╪º╪┤█î┘ç ╪¬┘ê┘à╪º┘å/USDT", "admin_set_plisio_extra_toman", "primary")],
                    [cb("≡ƒ¢ƒ ┘å╪▒╪« ╪»╪│╪¬█î (fallback)", "admin_set_plisio_fallback_rate", "primary")],
                    [backButton("admin_settings")]
                ]
            }
        });
        return null;
    }
    if (data === "admin_crypto_wallets") {
        const wallets = await sql `
      SELECT id, currency, network, address, rate_mode, rate_toman_per_unit, extra_toman_per_unit, active
      FROM crypto_wallets
      ORDER BY currency ASC, network ASC, id ASC;
    `;
        const lines = wallets.map((w) => {
            const row = w;
            const status = cryptoWalletReady(row) ? "Γ£à" : row.active ? "ΓÜá∩╕Å" : "Γ¢ö∩╕Å";
            const rate = row.rate_mode === "auto"
                ? "╪«┘ê╪»┌⌐╪º╪▒"
                : row.rate_toman_per_unit
                    ? `${formatPriceToman(Number(row.rate_toman_per_unit))} / 1`
                    : "-";
            const extra = Number(row.extra_toman_per_unit || 0);
            const extraText = extra ? ` +${formatPriceToman(extra)}` : "";
            return `${status} ${cryptoWalletTitle(row)} | ╪ó╪»╪▒╪│: ${shortAddr(row.address)} | ┘å╪▒╪«: ${rate}${extraText}`;
        });
        await tg("sendMessage", {
            chat_id: chatId,
            text: `┌⌐█î┘ü ┘╛┘ê┘äΓÇî┘ç╪º█î ┌⌐╪▒█î┘╛╪¬┘ê:\n\n${lines.length ? lines.join("\n") : "┘ç█î┌å ┘à┘ê╪▒╪»█î ╪½╪¿╪¬ ┘å╪┤╪»┘ç ╪º╪│╪¬."}`,
            reply_markup: {
                inline_keyboard: [
                    [cb("Γ₧ò ╪º┘ü╪▓┘ê╪»┘å ┌⌐█î┘ü ┘╛┘ê┘ä", "admin_crypto_wallet_add", "success")],
                    ...wallets.slice(0, 12).map((w) => {
                        const id = Number(w.id);
                        return [cb(`ΓÜÖ∩╕Å ${String(w.currency)} (${String(w.network)})`, `admin_crypto_wallet_edit_${id}`, "primary")];
                    }),
                    [backButton("admin_gateway_settings")]
                ]
            }
        });
        return null;
    }
    if (data === "admin_crypto_wallet_add") {
        await tg("sendMessage", {
            chat_id: chatId,
            text: "┌⌐╪»╪º┘à ┌⌐█î┘ü ┘╛┘ê┘ä ╪▒╪º ┘à█îΓÇî╪«┘ê╪º┘ç█î╪» ╪º╪╢╪º┘ü┘ç ┌⌐┘å█î╪»╪ƒ",
            reply_markup: {
                inline_keyboard: [
                    [cb("TRX (TRON)", "admin_crypto_wallet_add_trx_tron", "primary")],
                    [cb("TON (TON)", "admin_crypto_wallet_add_ton_ton", "primary")],
                    [cb("USDT (TRC20)", "admin_crypto_wallet_add_usdt_trc20", "primary")],
                    [cb("USDT (ERC20)", "admin_crypto_wallet_add_usdt_erc20", "primary")],
                    [cb("╪│╪º█î╪▒", "admin_crypto_wallet_add_other", "primary")],
                    [backButton("admin_crypto_wallets")]
                ]
            }
        });
        return null;
    }
    if (data.startsWith("admin_crypto_wallet_add_") && data !== "admin_crypto_wallet_add_other") {
        const payload = data.replace("admin_crypto_wallet_add_", "");
        const parts = payload.split("_");
        const currency = (parts[0] || "").toUpperCase();
        const network = (parts[1] || "").toUpperCase();
        const inserted = await sql `
      INSERT INTO crypto_wallets (currency, network, active)
      VALUES (${currency}, ${network}, FALSE)
      ON CONFLICT (currency, network) DO UPDATE SET currency = EXCLUDED.currency
      RETURNING id;
    `;
        const walletId = Number(inserted[0].id);
        await setState(userId, "admin_crypto_wallet_set_address", { walletId });
        await tg("sendMessage", { chat_id: chatId, text: `╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä ${currency} (${network}) ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -` });
        return null;
    }
    if (data === "admin_crypto_wallet_add_other") {
        await setState(userId, "admin_crypto_wallet_add_other_currency");
        await tg("sendMessage", { chat_id: chatId, text: "┘å╪º┘à ╪º╪▒╪▓ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪» (┘à╪½╪º┘ä: BTC █î╪º LTC):" });
        return null;
    }
    if (data.startsWith("admin_crypto_wallet_edit_")) {
        const walletId = Number(data.replace("admin_crypto_wallet_edit_", ""));
        const rows = await sql `
      SELECT id, currency, network, address, rate_mode, rate_toman_per_unit, extra_toman_per_unit, active
      FROM crypto_wallets
      WHERE id = ${walletId}
      LIMIT 1;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┌⌐█î┘ü ┘╛┘ê┘ä █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const w = rows[0];
        const rate = w.rate_mode === "auto" ? "╪«┘ê╪»┌⌐╪º╪▒" : w.rate_toman_per_unit ? `${formatPriceToman(Number(w.rate_toman_per_unit))} ╪¬┘ê┘à╪º┘å` : "-";
        await tg("sendMessage", {
            chat_id: chatId,
            text: `╪¬┘å╪╕█î┘à ┌⌐█î┘ü ┘╛┘ê┘ä:\n` +
                `${cryptoWalletTitle(w)}\n` +
                `┘ê╪╢╪╣█î╪¬: ${w.active ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"}\n` +
                `╪ó╪»╪▒╪│: ${w.address || "-"}\n` +
                `┘å╪▒╪«: ${rate}\n` +
                `╪¡╪º╪┤█î┘ç: ${formatPriceToman(Number(w.extra_toman_per_unit || 0))} ╪¬┘ê┘à╪º┘å`,
            reply_markup: {
                inline_keyboard: [
                    [cb("Γ£ì∩╕Å ╪¬┘å╪╕█î┘à ╪ó╪»╪▒╪│", `admin_crypto_wallet_set_address_${walletId}`, "primary")],
                    [cb(w.rate_mode === "auto" ? "Γ£à ┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒" : "Γ¥î ┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒", `admin_crypto_wallet_toggle_auto_${walletId}`, w.rate_mode === "auto" ? "success" : "danger")],
                    [cb("≡ƒÆ▒ ╪¬┘å╪╕█î┘à ┘å╪▒╪« ╪»╪│╪¬█î", `admin_crypto_wallet_set_rate_${walletId}`, "primary")],
                    [cb("Γ₧ò ╪¬┘å╪╕█î┘à ╪¡╪º╪┤█î┘ç ╪¬┘ê┘à╪º┘å", `admin_crypto_wallet_set_extra_${walletId}`, "primary")],
                    [cb(w.active ? "Γ¢ö∩╕Å ╪║█î╪▒┘ü╪╣╪º┘ä" : "Γ£à ┘ü╪╣╪º┘ä", `admin_crypto_wallet_toggle_${walletId}`, w.active ? "danger" : "success")],
                    [cb("≡ƒùæ ╪¡╪░┘ü", `admin_crypto_wallet_delete_${walletId}`, "danger")],
                    [backButton("admin_crypto_wallets")]
                ]
            }
        });
        return null;
    }
    if (data.startsWith("admin_crypto_wallet_set_address_")) {
        const walletId = Number(data.replace("admin_crypto_wallet_set_address_", ""));
        await setState(userId, "admin_crypto_wallet_set_address", { walletId });
        await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ┌⌐█î┘ü ┘╛┘ê┘ä ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data.startsWith("admin_crypto_wallet_set_rate_")) {
        const walletId = Number(data.replace("admin_crypto_wallet_set_rate_", ""));
        await setState(userId, "admin_crypto_wallet_set_rate", { walletId });
        await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« 1 ┘ê╪º╪¡╪» ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪» (┘ü┘é╪╖ ╪╣╪»╪»).\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data.startsWith("admin_crypto_wallet_set_extra_")) {
        const walletId = Number(data.replace("admin_crypto_wallet_set_extra_", ""));
        await setState(userId, "admin_crypto_wallet_set_extra", { walletId });
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪º╪┤█î┘ç ╪¬┘ê┘à╪º┘å (╪¿╪▒╪º█î ┘ç╪▒ 1 ┘ê╪º╪¡╪») ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪» (┘ü┘é╪╖ ╪╣╪»╪»).\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data.startsWith("admin_crypto_wallet_toggle_auto_")) {
        const walletId = Number(data.replace("admin_crypto_wallet_toggle_auto_", ""));
        const rows = await sql `SELECT id, currency, rate_mode FROM crypto_wallets WHERE id = ${walletId} LIMIT 1;`;
        if (!rows.length)
            return null;
        const current = String(rows[0].rate_mode || "manual");
        const next = current === "auto" ? "manual" : "auto";
        await sql `UPDATE crypto_wallets SET rate_mode = ${next} WHERE id = ${walletId};`;
        await tg("sendMessage", { chat_id: chatId, text: `┘å╪▒╪« ${next === "auto" ? "╪«┘ê╪»┌⌐╪º╪▒" : "╪»╪│╪¬█î"} ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à` });
        return null;
    }
    if (data.startsWith("admin_crypto_wallet_toggle_")) {
        const walletId = Number(data.replace("admin_crypto_wallet_toggle_", ""));
        const rows = await sql `UPDATE crypto_wallets SET active = NOT active WHERE id = ${walletId} RETURNING active;`;
        if (rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: `┘ê╪╢╪╣█î╪¬ ╪¿┘ç ${rows[0].active ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"} ╪¬╪║█î█î╪▒ ┌⌐╪▒╪» Γ£à` });
        }
        return null;
    }
    if (data.startsWith("admin_crypto_wallet_delete_")) {
        const walletId = Number(data.replace("admin_crypto_wallet_delete_", ""));
        await sql `DELETE FROM crypto_wallets WHERE id = ${walletId};`;
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪░┘ü ╪┤╪» Γ£à" });
        return null;
    }
    if (data === "admin_set_public_base_url") {
        await setState(userId, "admin_set_public_base_url");
        await tg("sendMessage", { chat_id: chatId, text: "╪ó╪»╪▒╪│ ┌⌐╪º┘à┘ä ╪│╪º█î╪¬ ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: https://example.com\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_set_tronado_api_key") {
        await setState(userId, "admin_set_tronado_api_key");
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» Tronado ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_set_tetrapay_api_key") {
        await setState(userId, "admin_set_tetrapay_api_key");
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» TetraPay ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_set_plisio_api_key") {
        await setState(userId, "admin_set_plisio_api_key");
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» Plisio ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_set_swapwallet_api_key") {
        await setState(userId, "admin_set_swapwallet_api_key");
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐┘ä█î╪» SwapWallet ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪».\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_set_swapwallet_shop_username") {
        await setState(userId, "admin_set_swapwallet_shop_username");
        await tg("sendMessage", { chat_id: chatId, text: "username ┘ü╪▒┘ê╪┤┌»╪º┘ç SwapWallet ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪» (╪¿╪»┘ê┘å @).\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_toggle_usdt_auto_rate") {
        const current = await getBoolSetting("usdt_auto_rate", true);
        await setSetting("usdt_auto_rate", (!current).toString());
        await tg("sendMessage", { chat_id: chatId, text: `┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒ USDT ${!current ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"} ╪┤╪» Γ£à` });
        return null;
    }
    if (data === "admin_set_usdt_toman_rate") {
        await setState(userId, "admin_set_usdt_toman_rate");
        await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« 1 USDT ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: 460000\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_toggle_plisio_auto_rate") {
        const current = await getBoolSetting("plisio_auto_rate", true);
        await setSetting("plisio_auto_rate", (!current).toString());
        await tg("sendMessage", { chat_id: chatId, text: `┘å╪▒╪« ╪«┘ê╪»┌⌐╪º╪▒ Plisio ${!current ? "┘ü╪╣╪º┘ä" : "╪║█î╪▒┘ü╪╣╪º┘ä"} ╪┤╪» Γ£à` });
        return null;
    }
    if (data === "admin_set_plisio_extra_toman") {
        await setState(userId, "admin_set_plisio_extra_toman");
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪º╪┤█î┘ç ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å (╪¿╪▒╪º█î ┘ç╪▒ 1 USDT) ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: 2000\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_set_plisio_fallback_rate") {
        await setState(userId, "admin_set_plisio_fallback_rate");
        await tg("sendMessage", { chat_id: chatId, text: "┘å╪▒╪« ╪»╪│╪¬█î USDT ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪» (fallback). ┘à╪½╪º┘ä: 65000\n╪¿╪▒╪º█î ┘╛╪º┌⌐ΓÇî┌⌐╪▒╪»┘å: -" });
        return null;
    }
    if (data === "admin_set_topup_price") {
        await setState(userId, "admin_set_topup_price");
        await tg("sendMessage", { chat_id: chatId, text: "┘é█î┘à╪¬ ┘ç╪▒ 1GB ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: 500000" });
        return null;
    }
    if (data === "admin_set_product_price") {
        await setState(userId, "admin_set_product_price");
        await tg("sendMessage", { chat_id: chatId, text: "┘é█î┘à╪¬ ┘╛█î╪┤┘ü╪▒╪╢ ┘ç╪▒ 1GB ┘à╪¡╪╡┘ê┘ä ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: 500000" });
        return null;
    }
    if (data === "admin_set_custom_v2ray_extra_day") {
        await setState(userId, "admin_set_custom_v2ray_extra_day");
        await tg("sendMessage", { chat_id: chatId, text: "┘é█î┘à╪¬ ┘ç╪▒ ╪▒┘ê╪▓ ╪¿╪▒╪º█î ┘à╪¡╪╡┘ê┘ä ╪│┘ü╪º╪▒╪┤█î ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪». ┘à╪½╪º┘ä: 10000\n╪¿╪▒╪º█î ╪«╪º┘à┘ê╪┤: 0" });
        return null;
    }
    if (data === "admin_set_custom_v2ray_min_gb") {
        await setState(userId, "admin_set_custom_v2ray_min_gb");
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪»╪º┘é┘ä ╪¡╪¼┘à ╪¿╪▒╪º█î ╪«╪▒█î╪» ┌⌐╪º┘å┘ü█î┌» ╪»┘ä╪«┘ê╪º┘ç ╪▒╪º ┘ê╪º╪▒╪» ┌⌐┘å█î╪» (╪¿┘ç ┌»█î┌»╪º╪¿╪º█î╪¬). ┘à╪½╪º┘ä: 1" });
        return null;
    }
    if (data === "admin_set_custom_v2ray_min_days") {
        await setState(userId, "admin_set_custom_v2ray_min_days");
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪»╪º┘é┘ä ╪▓┘à╪º┘å ╪¿╪▒╪º█î ╪«╪▒█î╪» ┌⌐╪º┘å┘ü█î┌» ╪»┘ä╪«┘ê╪º┘ç ╪▒╪º ┘ê╪º╪▒╪» ┌⌐┘å█î╪» (╪¿┘ç ╪▒┘ê╪▓). ┘à╪½╪º┘ä: 30" });
        return null;
    }
    if (data === "admin_toggle_global_infinite") {
        const current = await getBoolSetting("global_infinite_mode", false);
        await setSetting("global_infinite_mode", (!current).toString());
        await tg("sendMessage", { chat_id: chatId, text: `╪¡╪º┘ä╪¬ ╪¿█î┘å┘ç╪º█î╪¬ ╪│╪▒╪º╪│╪▒█î ${!current ? "╪▒┘ê╪┤┘å" : "╪«╪º┘à┘ê╪┤"} ╪┤╪» Γ£à` });
        return null;
    }
    if (data === "admin_purchase_bonus_settings") {
        await showAdminPurchaseBonusSettings(chatId);
        return null;
    }
    if (data === "admin_toggle_purchase_bonus") {
        const current = await getBoolSetting("purchase_bonus_enabled", false);
        await setSetting("purchase_bonus_enabled", (!current).toString());
        await tg("sendMessage", { chat_id: chatId, text: `╪¼╪º█î╪▓┘ç ╪¬╪╡╪º╪»┘ü█î ╪«╪▒█î╪» ${!current ? "Γ£à ┘ü╪╣╪º┘ä" : "Γ¥î ╪║█î╪▒┘ü╪╣╪º┘ä"} ╪┤╪».` });
        return null;
    }
    if (data === "admin_set_purchase_bonus_min") {
        await setState(userId, "admin_set_purchase_bonus_min");
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪»╪º┘é┘ä ┘à╪¿┘ä╪║ ╪¼╪º█î╪▓┘ç ╪¬╪╡╪º╪»┘ü█î ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ┘ê╪º╪▒╪» ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 1000" });
        return null;
    }
    if (data === "admin_set_purchase_bonus_max") {
        await setState(userId, "admin_set_purchase_bonus_max");
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪»╪º┌⌐╪½╪▒ ┘à╪¿┘ä╪║ ╪¼╪º█î╪▓┘ç ╪¬╪╡╪º╪»┘ü█î ╪▒╪º ╪¿┘ç ╪¬┘ê┘à╪º┘å ┘ê╪º╪▒╪» ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 10000" });
        return null;
    }
    if (data === "admin_test_config_settings") {
        await showAdminTestConfigSettings(chatId);
        return null;
    }
    if (data === "admin_toggle_test_config") {
        const current = await getBoolSetting("test_config_enabled", false);
        await setSetting("test_config_enabled", (!current).toString());
        await tg("sendMessage", { chat_id: chatId, text: `┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ${!current ? "Γ£à ┘ü╪╣╪º┘ä" : "Γ¥î ╪║█î╪▒┘ü╪╣╪º┘ä"} ╪┤╪».` });
        return null;
    }
    if (data === "admin_set_test_config_mb") {
        await setState(userId, "admin_set_test_config_mb");
        await tg("sendMessage", { chat_id: chatId, text: "╪¡╪¼┘à ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪▒╪º ╪¿┘ç ┘à┌»╪º╪¿╪º█î╪¬ ┘ê╪º╪▒╪» ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 100" });
        return null;
    }
    if (data === "admin_set_test_config_hours") {
        await setState(userId, "admin_set_test_config_hours");
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪»╪¬ ╪▓┘à╪º┘å ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪▒╪º ╪¿┘ç ╪│╪º╪╣╪¬ ┘ê╪º╪▒╪» ┌⌐┘å█î╪».\n┘à╪½╪º┘ä: 24" });
        return null;
    }
    if (data === "admin_reset_test_configs") {
        const result = await sql `UPDATE users SET test_config_used_at = NULL WHERE test_config_used_at IS NOT NULL RETURNING telegram_id;`;
        await tg("sendMessage", { chat_id: chatId, text: `Γ£à ╪▒█î╪│╪¬ ╪º┘å╪¼╪º┘à ╪┤╪».\n${result.length} ┌⌐╪º╪▒╪¿╪▒ ┘à╪¼╪»╪»╪º┘ï ┘à█îΓÇî╪¬┘ê╪º┘å┘å╪» ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪»╪▒█î╪º┘ü╪¬ ┌⌐┘å┘å╪».` });
        return null;
    }
    if (data === "admin_pick_test_config_product") {
        await showAdminTestConfigProductPicker(chatId);
        return null;
    }
    if (data === "admin_test_config_clear_product") {
        await setSetting("test_config_product_id", "");
        await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ┘╛╪º┌⌐ ╪┤╪» Γ£à" });
        return null;
    }
    if (data.startsWith("admin_test_config_product_")) {
        const productId = Number(data.replace("admin_test_config_product_", ""));
        const rows = await sql `SELECT name, sell_mode FROM products WHERE id = ${productId} LIMIT 1;`;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "┘à╪¡╪╡┘ê┘ä ┘╛█î╪»╪º ┘å╪┤╪»." });
            return null;
        }
        if (String(rows[0].sell_mode || "") !== "panel") {
            await tg("sendMessage", { chat_id: chatId, text: "Γ¥î ┘à╪¡╪╡┘ê┘ä ╪º┘å╪¬╪«╪º╪¿ΓÇî╪┤╪»┘ç ╪¿╪º█î╪» sell_mode = panel ╪»╪º╪┤╪¬┘ç ╪¿╪º╪┤╪»." });
            return null;
        }
        await setSetting("test_config_product_id", String(productId));
        await tg("sendMessage", { chat_id: chatId, text: `┘à╪¡╪╡┘ê┘ä ┌⌐╪º┘å┘ü█î┌» ╪¬╪│╪¬ ╪¬┘å╪╕█î┘à ╪┤╪» Γ£à\n${String(rows[0].name)}` });
        return null;
    }
    if (data === "test_config_claim") {
        await grantTestConfig(userId, chatId);
        return null;
    }
    if (data.startsWith("receipt_accept_")) {
        const orderId = Number(data.replace("receipt_accept_", ""));
        if (await isRateLimited(userId, "receipt_accept", 2000)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪»╪▒╪«┘ê╪º╪│╪¬ ╪┤┘à╪º ╪»╪▒ ╪¡╪º┘ä ┘╛╪▒╪»╪º╪▓╪┤ ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ┌å┘å╪» ┘ä╪¡╪╕┘ç ╪╡╪¿╪▒ ┌⌐┘å█î╪»." });
            return null;
        }
        const result = await finalizeOrder(orderId, userId);
        await tg("sendMessage", { chat_id: chatId, text: result.ok ? "╪│┘ü╪º╪▒╪┤ ╪¬╪º█î█î╪» ╪┤╪» Γ£à" : `╪«╪╖╪º: ${result.reason}` });
        return null;
    }
    if (data.startsWith("receipt_deny_")) {
        const orderId = Number(data.replace("receipt_deny_", ""));
        const rows = await sql `
      UPDATE orders
      SET status = 'denied', admin_decision_by = ${userId}
      WHERE id = ${orderId}
        AND status = 'receipt_submitted'
        AND payment_method = 'card2card'
      RETURNING telegram_id, purchase_id, wallet_used;
    `;
        if (rows.length) {
            const order = rows[0];
            const walletUsed = Number(order.wallet_used || 0);
            if (walletUsed > 0) {
                await refundWalletUsage(Number(order.telegram_id), walletUsed, `╪¿╪▒┌»╪┤╪¬ ┘ê╪¼┘ç ╪¿┘ç ╪»┘ä█î┘ä ╪▒╪» ╪▒╪│█î╪» ╪│┘ü╪º╪▒╪┤ ${order.purchase_id}`);
            }
            await tg("sendMessage", { chat_id: Number(order.telegram_id), text: `╪▒╪│█î╪» ╪│┘ü╪º╪▒╪┤ ${order.purchase_id} ╪▒╪» ╪┤╪» Γ¥î` });
        }
        await tg("sendMessage", { chat_id: chatId, text: rows.length ? "╪▒╪» ╪┤╪» Γ£à" : "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪» █î╪º ┘é╪¿┘ä╪º┘ï ╪¿╪▒╪▒╪│█î ╪┤╪»┘ç." });
        return null;
    }
    if (data.startsWith("crypto_accept_")) {
        const orderId = Number(data.replace("crypto_accept_", ""));
        if (await isRateLimited(userId, "crypto_accept", 2000)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪»╪▒╪«┘ê╪º╪│╪¬ ╪┤┘à╪º ╪»╪▒ ╪¡╪º┘ä ┘╛╪▒╪»╪º╪▓╪┤ ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï ┌å┘å╪» ┘ä╪¡╪╕┘ç ╪╡╪¿╪▒ ┌⌐┘å█î╪»." });
            return null;
        }
        const result = await finalizeOrder(orderId, userId);
        await tg("sendMessage", { chat_id: chatId, text: result.ok ? "╪│┘ü╪º╪▒╪┤ ╪¬╪º█î█î╪» ╪┤╪» Γ£à" : `╪«╪╖╪º: ${result.reason}` });
        return null;
    }
    if (data.startsWith("crypto_deny_")) {
        const orderId = Number(data.replace("crypto_deny_", ""));
        const rows = await sql `
      UPDATE orders
      SET status = 'denied', admin_decision_by = ${userId}
      WHERE id = ${orderId}
        AND status = 'receipt_submitted'
        AND payment_method IN ('crypto', 'tronado', 'plisio', 'tetrapay')
      RETURNING telegram_id, purchase_id, wallet_used;
    `;
        if (rows.length) {
            const order = rows[0];
            const walletUsed = Number(order.wallet_used || 0);
            if (walletUsed > 0) {
                await refundWalletUsage(Number(order.telegram_id), walletUsed, `╪¿╪▒┌»╪┤╪¬ ┘ê╪¼┘ç ╪¿┘ç ╪»┘ä█î┘ä ╪▒╪» ┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪▒█î┘╛╪¬┘ê ╪│┘ü╪º╪▒╪┤ ${order.purchase_id}`);
            }
            await tg("sendMessage", { chat_id: Number(order.telegram_id), text: `┘╛╪▒╪»╪º╪«╪¬ ┌⌐╪▒█î┘╛╪¬┘ê ╪│┘ü╪º╪▒╪┤ ${order.purchase_id} ╪▒╪» ╪┤╪» Γ¥î` });
        }
        await tg("sendMessage", { chat_id: chatId, text: rows.length ? "╪▒╪» ╪┤╪» Γ£à" : "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪» █î╪º ┘é╪¿┘ä╪º┘ï ╪¿╪▒╪▒╪│█î ╪┤╪»┘ç." });
        return null;
    }
    if (data.startsWith("receipt_ban_")) {
        const payload = data.replace("receipt_ban_", "");
        const [orderIdRaw] = payload.split("_");
        const orderId = Number(orderIdRaw);
        const rows = await sql `
      UPDATE orders
      SET status = 'denied', admin_decision_by = ${userId}
      WHERE id = ${orderId}
        AND status = 'receipt_submitted'
        AND payment_method = 'card2card'
      RETURNING telegram_id, purchase_id, wallet_used;
    `;
        if (rows.length) {
            const order = rows[0];
            const targetUser = Number(order.telegram_id);
            await sql `
        INSERT INTO banned_users (telegram_id, reason, banned_by)
        VALUES (${targetUser}, 'fake_receipt', ${userId})
        ON CONFLICT (telegram_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by;
      `;
            const walletUsed = Number(order.wallet_used || 0);
            if (walletUsed > 0) {
                await refundWalletUsage(targetUser, walletUsed, `╪¿╪▒┌»╪┤╪¬ ┘ê╪¼┘ç ╪│┘ü╪º╪▒╪┤ ${order.purchase_id}`);
            }
            try {
                await tg("sendMessage", { chat_id: targetUser, text: "╪¿┘ç ╪»┘ä█î┘ä ╪º╪▒╪│╪º┘ä ╪▒╪│█î╪» ┘å╪º┘à╪╣╪¬╪¿╪▒╪î ╪»╪│╪¬╪▒╪│█î ╪┤┘à╪º ┘à╪│╪»┘ê╪» ╪┤╪»." });
            }
            catch (error) {
                logError("ban_user_notify_failed", error, { targetUserId: targetUser, by: userId, mode: "receipt" });
            }
        }
        await tg("sendMessage", { chat_id: chatId, text: rows.length ? "┌⌐╪º╪▒╪¿╪▒ ╪¿┘å ╪┤╪» Γ£à" : "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪» █î╪º ┘é╪º╪¿┘ä ╪¿┘å ┘å█î╪│╪¬." });
        return null;
    }
    if (data.startsWith("crypto_ban_")) {
        const payload = data.replace("crypto_ban_", "");
        const [orderIdRaw] = payload.split("_");
        const orderId = Number(orderIdRaw);
        const rows = await sql `
      UPDATE orders
      SET status = 'denied', admin_decision_by = ${userId}
      WHERE id = ${orderId}
        AND status = 'receipt_submitted'
        AND payment_method IN ('tronado', 'plisio', 'tetrapay')
      RETURNING telegram_id, purchase_id, wallet_used;
    `;
        if (rows.length) {
            const order = rows[0];
            const targetUser = Number(order.telegram_id);
            await sql `
        INSERT INTO banned_users (telegram_id, reason, banned_by)
        VALUES (${targetUser}, 'fake_crypto_receipt', ${userId})
        ON CONFLICT (telegram_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by;
      `;
            const walletUsed = Number(order.wallet_used || 0);
            if (walletUsed > 0) {
                await refundWalletUsage(targetUser, walletUsed, `╪¿╪▒┌»╪┤╪¬ ┘ê╪¼┘ç ╪│┘ü╪º╪▒╪┤ ${order.purchase_id}`);
            }
            await tg("sendMessage", { chat_id: targetUser, text: "╪¿┘ç ╪»┘ä█î┘ä ╪º╪▒╪│╪º┘ä ╪▒╪│█î╪» ┘å╪º┘à╪╣╪¬╪¿╪▒╪î ╪»╪│╪¬╪▒╪│█î ╪┤┘à╪º ┘à╪│╪»┘ê╪» ╪┤╪»." }).catch(() => { });
        }
        await tg("sendMessage", { chat_id: chatId, text: rows.length ? "┌⌐╪º╪▒╪¿╪▒ ╪¿┘å ╪┤╪» Γ£à" : "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪» █î╪º ┘é╪º╪¿┘ä ╪¿┘å ┘å█î╪│╪¬." });
        return null;
    }
    if (data.startsWith("retry_config_")) {
        const orderId = Number(data.replace("retry_config_", ""));
        if (!Number.isFinite(orderId) || orderId <= 0)
            return null;
        const orderRows = await sql `
      SELECT id, purchase_id, telegram_id, final_price, wallet_used, status, product_id
      FROM orders
      WHERE id = ${orderId} AND telegram_id = ${userId}
      LIMIT 1;
    `;
        if (!orderRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const retryOrder = orderRows[0];
        const orderStatus = String(retryOrder.status);
        // ΓöÇΓöÇ Case 1: Config was already created ΓÇö just resend it ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (orderStatus === "paid") {
            const invRows = await sql `
        SELECT id, config_value, delivery_payload
        FROM inventory
        WHERE sold_order_id = ${orderId}
        ORDER BY id ASC;
      `;
            if (invRows.length > 0) {
                await tg("sendMessage", { chat_id: chatId, text: "Γ£à ┌⌐╪º┘å┘ü█î┌» ╪┤┘à╪º ┘é╪¿┘ä╪º┘ï ╪│╪º╪«╪¬┘ç ╪┤╪»┘ç. ╪»╪▒ ╪¡╪º┘ä ╪º╪▒╪│╪º┘ä ┘à╪¼╪»╪»..." }).catch(() => { });
                for (let i = 0; i < invRows.length; i++) {
                    const inv = invRows[i];
                    const dp = parseDeliveryPayload(inv.delivery_payload);
                    const isLast = i === invRows.length - 1;
                    await sendDeliveryPackage(chatId, String(retryOrder.purchase_id), String(inv.config_value ?? ""), dp, isLast ? [[{ text: "Γ₧ò ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", callback_data: "topup_menu" }], [homeButton()]] : []).catch(() => { });
                }
                return null;
            }
            // paid but no inventory rows ΓÇö fall through to retry
        }
        // ΓöÇΓöÇ Case 2: Must be awaiting_config to retry ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (orderStatus !== "awaiting_config") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪│┘ü╪º╪▒╪┤ ╪»█î┌»╪▒ ╪»╪▒ ┘ê╪╢╪╣█î╪¬ ┘é╪º╪¿┘ä ╪¬┘ä╪º╪┤ ┘à╪¼╪»╪» ┘å█î╪│╪¬." });
            return null;
        }
        // Before creating a NEW config, check if provisioning already ran but timed out
        // before delivery. If inventory rows exist, just resend and mark paid ΓÇö no new panel config needed.
        const existingInv = await sql `
      SELECT id, config_value, delivery_payload
      FROM inventory
      WHERE sold_order_id = ${orderId}
      ORDER BY id ASC;
    `;
        if (existingInv.length > 0) {
            await sql `
        UPDATE orders
        SET status = 'paid', paid_at = COALESCE(paid_at, NOW())
        WHERE id = ${orderId} AND status = 'awaiting_config' AND telegram_id = ${userId};
      `;
            await tg("sendMessage", { chat_id: chatId, text: "Γ£à ┌⌐╪º┘å┘ü█î┌» ╪┤┘à╪º ┘é╪¿┘ä╪º┘ï ╪│╪º╪«╪¬┘ç ╪┤╪»┘ç. ╪»╪▒ ╪¡╪º┘ä ╪º╪▒╪│╪º┘ä ┘à╪¼╪»╪»..." }).catch(() => { });
            for (let i = 0; i < existingInv.length; i++) {
                const inv = existingInv[i];
                const dp = parseDeliveryPayload(inv.delivery_payload);
                const isLast = i === existingInv.length - 1;
                await sendDeliveryPackage(chatId, String(retryOrder.purchase_id), String(inv.config_value ?? ""), dp, isLast ? [[{ text: "Γ₧ò ╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º", callback_data: "topup_menu" }], [homeButton()]] : []).catch(() => { });
            }
            return null;
        }
        await tg("sendMessage", {
            chat_id: chatId,
            text: `≡ƒöä ╪»╪▒ ╪¡╪º┘ä ╪¬┘ä╪º╪┤ ┘à╪¼╪»╪» ╪¿╪▒╪º█î ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤ ${retryOrder.purchase_id}...`
        }).catch(() => { });
        // Reset so finalizeOrder can lock it again
        await sql `
      UPDATE orders
      SET status = 'receipt_submitted'
      WHERE id = ${orderId} AND status = 'awaiting_config' AND telegram_id = ${userId};
    `;
        // Retry with timeout
        let retryTimedOut = false;
        const retryResult = await Promise.race([
            finalizeOrder(orderId, null),
            new Promise((resolve) => setTimeout(() => { retryTimedOut = true; resolve({ ok: false, reason: "timeout" }); }, 24_000))
        ]);
        if (retryResult.ok || retryResult.reason === "already_paid") {
            // Success ΓÇö delivery message already sent inside finalizeOrder
            return null;
        }
        // provision_failed is already handled inside finalizeOrder with buttons
        if (!retryTimedOut && retryResult.reason === "provision_failed") {
            return null;
        }
        // Any other failure (timeout, panel_unavailable, stock_emptyΓÇª) ΓåÆ
        // reset back to awaiting_config and show the two options again
        await sql `
      UPDATE orders
      SET status = 'awaiting_config', paid_at = COALESCE(paid_at, NOW())
      WHERE id = ${orderId}
        AND status IN ('fulfilling', 'receipt_submitted');
    `;
        await tg("sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            text: `ΓÜá∩╕Å ╪¬┘ä╪º╪┤ ┘à╪¼╪»╪» ╪¿╪▒╪º█î ╪│╪º╪«╪¬ ┌⌐╪º┘å┘ü█î┌» ╪│┘ü╪º╪▒╪┤ <b>${escapeHtml(String(retryOrder.purchase_id))}</b> ┘å╪º┘à┘ê┘ü┘é ╪¿┘ê╪».\n` +
                `┘ä╪╖┘ü╪º┘ï ╪»┘ê╪¿╪º╪▒┘ç ╪º┘å╪¬╪«╪º╪¿ ┌⌐┘å█î╪»:`,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "≡ƒöä ╪¬┘ä╪º╪┤ ┘à╪¼╪»╪» ╪¿╪▒╪º█î ╪»╪▒█î╪º┘ü╪¬ ┌⌐╪º┘å┘ü█î┌»", callback_data: `retry_config_${orderId}` }],
                    [{ text: "≡ƒÆ░ ╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä", callback_data: `refund_to_wallet_${orderId}` }]
                ]
            }
        }).catch(() => { });
        return null;
    }
    if (data.startsWith("refund_to_wallet_")) {
        const orderId = Number(data.replace("refund_to_wallet_", ""));
        if (!Number.isFinite(orderId) || orderId <= 0)
            return null;
        const orderRows = await sql `
      SELECT id, purchase_id, telegram_id, final_price, wallet_used, status, payment_method
      FROM orders
      WHERE id = ${orderId} AND telegram_id = ${userId}
      LIMIT 1;
    `;
        if (!orderRows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪│┘ü╪º╪▒╪┤ █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const refundOrder = orderRows[0];
        if (String(refundOrder.status) !== "awaiting_config") {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┘é╪¿┘ä╪º┘ï ┘╛╪▒╪»╪º╪▓╪┤ ╪┤╪»┘ç ┘ê ┘é╪º╪¿┘ä ╪º╪│╪¬╪▒╪»╪º╪» ┘å█î╪│╪¬." });
            return null;
        }
        // Atomically mark as cancelled ΓÇö prevent double-refunds
        const cancelled = await sql `
      UPDATE orders
      SET status = 'cancelled'
      WHERE id = ${orderId} AND status = 'awaiting_config' AND telegram_id = ${userId}
      RETURNING id;
    `;
        if (!cancelled.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪│┘ü╪º╪▒╪┤ ┘é╪¿┘ä╪º┘ï ┘╛╪▒╪»╪º╪▓╪┤ ╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        // --- Inventory cleanup ---
        // If provisioning ran (even partially) before the timeout fired, there may be
        // orphaned inventory rows and live panel configs. Delete them and revoke from panel
        // so the user cannot use a VPN config they are about to be refunded for.
        const orphanedInv = await sql `
      SELECT inv.id, inv.panel_user_key, inv.panel_id,
             p.panel_type, p.base_url, p.username, p.password, p.active
      FROM inventory inv
      LEFT JOIN panels p ON p.id = inv.panel_id
      WHERE inv.sold_order_id = ${orderId};
    `;
        if (orphanedInv.length > 0) {
            await sql `DELETE FROM inventory WHERE sold_order_id = ${orderId};`;
            const revokeResults = [];
            for (const inv of orphanedInv) {
                const key = String(inv.panel_user_key || "").trim();
                if (key && inv.panel_type) {
                    try {
                        let result = { ok: false, message: "unknown panel type" };
                        const dp = parseDeliveryPayload(inv.delivery_payload);
                        if (dp.type === "pingchi") {
                            result = await pingchiApi("services.delete", { username: key });
                        }
                        else {
                            result = isMarzbanLike(String(inv.panel_type))
                                ? await deleteMarzbanUser(inv, key)
                                : await revokeSanaeiClient(inv, key);
                        }
                        revokeResults.push(`${String(inv.panel_type)} ${key}: ${result.ok ? "Γ£à" : "ΓÜá∩╕Å " + String(result.message || "")}`);
                    }
                    catch (e) {
                        revokeResults.push(`${String(inv.panel_type)} ${key}: Γ¥î ╪«╪╖╪º`);
                    }
                }
            }
            await notifyAdmins(`ΓÜá∩╕Å ╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç ╪│┘ü╪º╪▒╪┤ ${refundOrder.purchase_id}: ${orphanedInv.length} ┌⌐╪º┘å┘ü█î┌» ╪º╪▓ inventory ╪¡╪░┘ü ┘ê ╪º╪▓ ┘╛┘å┘ä ╪¿╪º╪╖┘ä ╪┤╪».\n` +
                `┌⌐╪º╪▒╪¿╪▒: ${userId}\n` +
                (revokeResults.length ? `┘å╪¬╪º█î╪¼ ╪¿╪º╪╖┘äΓÇî╪│╪º╪▓█î:\n${revokeResults.join("\n")}` : "")).catch(() => { });
        }
        // --- End inventory cleanup ---
        // wallet_used is the amount deducted from the wallet (may equal full price for wallet orders).
        // final_price is the externally paid amount (0 for pure wallet orders).
        // Refund whichever was actually charged ΓÇö for wallet orders wallet_used is what matters.
        const walletUsedForRefund = Math.max(0, Math.round(Number(refundOrder.wallet_used || 0)));
        const finalPriceForRefund = Math.max(0, Math.round(Number(refundOrder.final_price || 0)));
        // Refund BOTH: wallet credit used + any external payment (card2card / crypto)
        // Both portions are returned as wallet balance so the user can buy again immediately.
        const refundAmount = walletUsedForRefund + finalPriceForRefund;
        if (refundAmount > 0) {
            try {
                await refundWalletUsage(userId, refundAmount, `╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç ╪│┘ü╪º╪▒╪┤ ${refundOrder.purchase_id} (╪º┘å╪¬╪«╪º╪¿ ┌⌐╪º╪▒╪¿╪▒)`);
            }
            catch (refundErr) {
                logError("user_refund_to_wallet_failed", refundErr, { orderId, userId, refundAmount });
                await tg("sendMessage", { chat_id: chatId, text: "╪«╪╖╪º ╪»╪▒ ╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç. ┘ä╪╖┘ü╪º┘ï ╪¿╪º ┘╛╪┤╪¬█î╪¿╪º┘å█î ╪¬┘à╪º╪│ ╪¿┌»█î╪▒█î╪»." }).catch(() => { });
                return null;
            }
        }
        await tg("sendMessage", {
            chat_id: chatId,
            text: `Γ£à ┘ê╪¼┘ç ╪│┘ü╪º╪▒╪┤ <b>${escapeHtml(String(refundOrder.purchase_id))}</b> ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ╪┤┘à╪º ╪¿╪▒┌»╪┤╪¬ ╪»╪º╪»┘ç ╪┤╪».\n` +
                `${refundAmount > 0 ? `≡ƒÆ░ ┘à╪¿┘ä╪║ ${formatPriceToman(refundAmount)} ╪¬┘ê┘à╪º┘å ╪¿┘ç ┌⌐█î┘ü ┘╛┘ê┘ä ╪º╪╢╪º┘ü┘ç ╪┤╪».` : ""}`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[homeButton()]] }
        }).catch(() => { });
        await notifyAdmins(`≡ƒÆ░ ╪¿╪º╪▓┌»╪┤╪¬ ┘ê╪¼┘ç ╪¬┘ê╪│╪╖ ┌⌐╪º╪▒╪¿╪▒ ${userId} ╪¿╪▒╪º█î ╪│┘ü╪º╪▒╪┤ ${refundOrder.purchase_id} ╪º┘å╪¼╪º┘à ╪┤╪».\n┘à╪¿┘ä╪║: ${formatPriceToman(refundAmount)} ╪¬┘ê┘à╪º┘å`);
        return null;
    }
    if (data.startsWith("admin_provide_config_")) {
        if (!await isAdmin(userId)) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪╣┘à┘ä█î╪º╪¬ ┘ü┘é╪╖ ╪¿╪▒╪º█î ╪º╪»┘à█î┘åΓÇî┘ç╪º ┘à╪¼╪º╪▓ ╪º╪│╪¬." });
            return null;
        }
        const orderId = Number(data.replace("admin_provide_config_", ""));
        if (!Number.isFinite(orderId) || orderId <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "╪┤┘å╪º╪│┘ç ╪│┘ü╪º╪▒╪┤ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬." });
            return null;
        }
        await setState(userId, "admin_provide_config", { orderId });
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º┘å┘ü█î┌» ╪ó┘à╪º╪»┘ç ╪▒╪º ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪» ╪¬╪º ╪¿╪▒╪º█î ┌⌐╪º╪▒╪¿╪▒ ╪¬╪¡┘ê█î┘ä ╪┤┘ê╪»." });
        return null;
    }
    if (data.startsWith("topup_accept_")) {
        const id = Number(data.replace("topup_accept_", ""));
        const rows = await sql `
      UPDATE topup_requests
      SET status = 'paid'
      WHERE id = ${id} AND status = 'receipt_submitted'
      RETURNING telegram_id, purchase_id;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪»╪▒╪«┘ê╪º╪│╪¬ ┘é╪º╪¿┘ä ╪¬╪º█î█î╪» ┘å█î╪│╪¬ █î╪º ┘é╪¿┘ä╪º┘ï ╪¿╪▒╪▒╪│█î ╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        await tg("sendMessage", {
            chat_id: Number(rows[0].telegram_id),
            text: `╪▒╪│█î╪» ╪│┘ü╪º╪▒╪┤ ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ${rows[0].purchase_id} ╪¬╪º█î█î╪» ╪┤╪» Γ£à\n╪º╪»┘à█î┘å ╪¿┘çΓÇî╪▓┘ê╪»█î ╪º┘ü╪▓╪º█î╪┤ ╪▒╪º ╪º╪╣┘à╪º┘ä ┘à█îΓÇî┌⌐┘å╪».`
        });
        const auto = await tryAutoApplyPanelTopup(id, userId);
        if (auto.ok) {
            await tg("sendMessage", { chat_id: chatId, text: `╪▒╪│█î╪» ╪¬╪º█î█î╪» ╪┤╪» ┘ê ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪«┘ê╪»┌⌐╪º╪▒ ╪º╪╣┘à╪º┘ä ╪┤╪» Γ£à\n${auto.message}` });
            return null;
        }
        logInfo("topup_auto_apply_skipped", { topupRequestId: id, reason: auto.message });
        await notifyAdmins(`Γ£à ╪▒╪│█î╪» ╪º┘ü╪▓╪º█î╪┤ ╪»█î╪¬╪º ╪¬╪º█î█î╪» ╪┤╪»: ${rows[0].purchase_id}`, {
            inline_keyboard: [[confirmButton(`done_topup_${id}`, "Γ£à ╪º┘å╪¼╪º┘à ╪┤╪»")]]
        });
        await tg("sendMessage", { chat_id: chatId, text: `╪▒╪│█î╪» ╪¬╪º█î█î╪» ╪┤╪» Γ£à\n╪º╪╣┘à╪º┘ä ╪«┘ê╪»┌⌐╪º╪▒ ╪º┘å╪¼╪º┘à ┘å╪┤╪»: ${auto.message}` });
        return null;
    }
    if (data.startsWith("topup_deny_")) {
        const id = Number(data.replace("topup_deny_", ""));
        const rows = await sql `
      UPDATE topup_requests
      SET status = 'denied'
      WHERE id = ${id} AND status = 'receipt_submitted'
      RETURNING telegram_id, purchase_id;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪»╪▒╪«┘ê╪º╪│╪¬ ┘é╪º╪¿┘ä ╪▒╪» ┘å█î╪│╪¬ █î╪º ┘é╪¿┘ä╪º┘ï ╪¿╪▒╪▒╪│█î ╪┤╪»┘ç ╪º╪│╪¬." });
            return null;
        }
        await tg("sendMessage", { chat_id: Number(rows[0].telegram_id), text: `╪▒╪│█î╪» ╪│┘ü╪º╪▒╪┤ ${rows[0].purchase_id} ╪▒╪» ╪┤╪» ∩┐╜∩┐╜∩┐╜` });
        await tg("sendMessage", { chat_id: chatId, text: "╪▒╪» ╪┤╪» Γ£à" });
        return null;
    }
    if (data.startsWith("topup_ban_")) {
        const payload = data.replace("topup_ban_", "");
        const [idRaw, targetUserRaw] = payload.split("_");
        const id = Number(idRaw);
        const targetUser = Number(targetUserRaw);
        await sql `
      INSERT INTO banned_users (telegram_id, reason, banned_by)
      VALUES (${targetUser}, 'fake_topup_receipt', ${userId})
      ON CONFLICT (telegram_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by;
    `;
        await sql `
      UPDATE topup_requests
      SET status = 'denied'
      WHERE id = ${id} AND status = 'receipt_submitted';
    `;
        try {
            await tg("sendMessage", { chat_id: targetUser, text: "╪¿┘ç ╪»┘ä█î┘ä ╪º╪▒╪│╪º┘ä ╪▒╪│█î╪» ┘å╪º┘à╪╣╪¬╪¿╪▒╪î ╪»╪│╪¬╪▒╪│█î ╪┤┘à╪º ┘à╪│╪»┘ê╪» ╪┤╪»." });
        }
        catch (error) {
            logError("ban_user_notify_failed", error, { targetUserId: targetUser, by: userId, mode: "topup_receipt" });
        }
        await tg("sendMessage", { chat_id: chatId, text: "┌⌐╪º╪▒╪¿╪▒ ╪¿┘å ╪┤╪» Γ£à" });
        return null;
    }
    if (data.startsWith("done_topup_")) {
        const id = Number(data.replace("done_topup_", ""));
        const rows = await sql `
      UPDATE topup_requests
      SET status = 'done', done_at = NOW(), done_by = ${userId}
      WHERE id = ${id} AND status = 'paid'
      RETURNING telegram_id, inventory_id, requested_mb, purchase_id;
    `;
        if (!rows.length) {
            await tg("sendMessage", { chat_id: chatId, text: "╪º█î┘å ╪»╪▒╪«┘ê╪º╪│╪¬ ┘é╪¿┘ä╪º ╪¿╪│╪¬┘ç ╪┤╪»┘ç █î╪º █î╪º┘ü╪¬ ┘å╪┤╪»." });
            return null;
        }
        const cfg = await sql `SELECT config_value FROM inventory WHERE id = ${rows[0].inventory_id} LIMIT 1;`;
        await tg("sendMessage", {
            chat_id: Number(rows[0].telegram_id),
            text: `╪»╪▒╪«┘ê╪º╪│╪¬ ╪º┘ü╪▓╪º█î╪┤ ${rows[0].requested_mb}MB ╪┤┘à╪º ╪º┘å╪¼╪º┘à ╪┤╪» Γ£à\n` +
                `╪┤┘à╪º╪▒┘ç ╪│┘ü╪º╪▒╪┤: ${rows[0].purchase_id}\n` +
                `┌⌐╪º┘å┘ü█î┌»:\n${String(cfg[0]?.config_value || "-")}`
        });
        await tg("sendMessage", { chat_id: chatId, text: "╪»╪▒╪«┘ê╪º╪│╪¬ ╪¿┘ç ╪¡╪º┘ä╪¬ Done ╪▒┘ü╪¬ Γ£à" });
        return null;
    }
}
async function checkMandatoryChannels(userId, chatId, silent = false) {
    if (await isAdmin(userId))
        return true;
    const channelsRaw = await getSetting("mandatory_channels");
    if (!channelsRaw)
        return true;
    const channels = channelsRaw.split(",").map(c => c.trim()).filter(Boolean);
    if (channels.length === 0)
        return true;
    const notJoined = [];
    for (const channelItem of channels) {
        let channelId = channelItem;
        let url = "";
        let name = channelItem;
        if (channelItem.includes("|")) {
            const parts = channelItem.split("|");
            channelId = parts[0];
            url = parts[1];
            name = parts[2] || parts[0];
        }
        else if (channelItem.startsWith("@")) {
            url = `https://t.me/${channelItem.replace("@", "")}`;
        }
        else {
            url = "https://t.me/";
        }
        try {
            const result = await tg("getChatMember", { chat_id: channelId, user_id: userId });
            if (!['creator', 'administrator', 'member', 'restricted'].includes(result.status)) {
                notJoined.push({ id: channelId, name: name, url });
            }
        }
        catch (error) {
            logError("check_channel_membership_failed", error, { channel: channelId, userId });
        }
    }
    if (notJoined.length > 0) {
        if (!silent) {
            const buttons = notJoined.map(c => {
                return [{ text: `╪╣╪╢┘ê█î╪¬ ╪»╪▒ ${c.name}`, url: c.url }];
            });
            buttons.push([cb("Γ£à ╪¿╪▒╪▒╪│█î ╪╣╪╢┘ê█î╪¬", "check_membership", "success")]);
            await tg("sendMessage", {
                chat_id: chatId,
                text: "╪¿╪▒╪º█î ╪º╪│╪¬┘ü╪º╪»┘ç ╪º╪▓ ╪▒╪¿╪º╪¬╪î ╪º┘ê┘ä ╪¿╪º█î╪» ╪»╪▒ ┌⌐╪º┘å╪º┘äΓÇî┘ç╪º█î ╪▓█î╪▒ ╪╣╪╢┘ê ╪¿╪┤█î.\n╪¿╪╣╪» ╪º╪▓ ╪╣╪╢┘ê█î╪¬╪î ╪▒┘ê█î ┬½╪¿╪▒╪▒╪│█î ╪╣╪╢┘ê█î╪¬┬╗ ╪¿╪▓┘å.",
                reply_markup: { inline_keyboard: buttons }
            });
        }
        return false;
    }
    return true;
}
async function handleMessage(update) {
    if (!update?.from)
        return null;
    const text = (update.text ?? update.caption ?? "").trim();
    const startCommand = parseStartCommand(text);
    const photoFileId = update.photo?.length ? update.photo[update.photo.length - 1].file_id : null;
    const stickerFileId = update.sticker?.file_id || null;
    const animationFileId = update.animation?.file_id || null;
    const chatId = update.chat.id;
    const userId = update.from.id;
    await upsertUser(update.from);
    const [banned] = await Promise.all([
        isBanned(userId),
        startCommand?.payload ? captureReferralAttribution(userId, startCommand.payload) : Promise.resolve()
    ]);
    if (banned) {
        await tg("sendMessage", { chat_id: chatId, text: "╪»╪│╪¬╪▒╪│█î ╪┤┘à╪º ╪¿┘ç ╪»┘ä█î┘ä ╪¬╪«┘ä┘ü ┘à╪│╪»┘ê╪» ╪┤╪»┘ç ╪º╪│╪¬." });
        return null;
    }
    if (!(await checkMandatoryChannels(userId, chatId))) {
        return null;
    }
    await maybeQualifyReferralUser(userId);
    if (startCommand) {
        await clearState(userId);
        await sendStartMedia(chatId);
        await sendMainMenu(chatId, userId);
        return null;
    }
    if (text === "/admin" && await isAdmin(userId)) {
        await sendAdminPanel(chatId);
        return null;
    }
    if (text === "/help") {
        if (await isAdmin(userId)) {
            await adminHelp(chatId);
        }
        else {
            const support = ((await getSetting("support_username")) || "").trim();
            await tg("sendMessage", { chat_id: chatId, text: support ? `Support: @${support.replace(/^@/, "")}` : "Support is not configured. Please contact the admin." });
        }
        return null;
    }
    const state = await getState(userId);
    // ΓöÇΓöÇ Document handling (used for restore-from-backup) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const documentFileId = update?.document?.file_id || null;
    if (documentFileId && state?.state === "admin_awaiting_restore_file" && await isAdmin(userId)) {
        await clearState(userId);
        await tg("sendMessage", { chat_id: chatId, text: "ΓÅ│ ╪»╪▒ ╪¡╪º┘ä ┘╛╪▒╪»╪º╪▓╪┤ ┘ê ╪¿╪º╪▓█î╪º╪¿█î ┘ü╪º█î┘ä ╪¿┌⌐╪º┘╛..." });
        try {
            const raw = await tgDownloadFile(documentFileId);
            let data;
            try {
                data = JSON.parse(raw);
            }
            catch {
                await tg("sendMessage", { chat_id: chatId, text: "Γ¥î ┘ü╪º█î┘ä ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬. ┘ä╪╖┘ü╪º┘ï █î┌⌐ ┘ü╪º█î┘ä JSON ┘à╪╣╪¬╪¿╪▒ ╪º╪▒╪│╪º┘ä ┌⌐┘å█î╪»." });
                return null;
            }
            if (data.version !== "1.0" || typeof data.tables !== "object") {
                await tg("sendMessage", { chat_id: chatId, text: "Γ¥î ┘ü╪▒┘à╪¬ ╪¿┌⌐╪º┘╛ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪º╪│╪¬. ┘ü╪º█î┘ä ╪¿╪º█î╪» ╪┤╪º┘à┘ä version ┘ê tables ╪¿╪º╪┤╪»." });
                return null;
            }
            const result = await restoreFromBackup(data);
            const totalRows = Object.values(result.restored).reduce((s, n) => s + n, 0);
            const summary = Object.entries(result.restored)
                .filter(([, n]) => n > 0)
                .map(([t, n]) => `${t}: ${n}`)
                .join("\n");
            await tg("sendMessage", {
                chat_id: chatId,
                text: `Γ£à ╪¿╪º╪▓█î╪º╪¿█î ┌⌐╪º┘à┘ä ╪┤╪»!\n≡ƒôè ┘à╪¼┘à┘ê╪╣: ${totalRows} ╪▒╪»█î┘ü\n\n${summary}`
            });
        }
        catch (err) {
            logError("admin_restore_failed", err);
            await tg("sendMessage", {
                chat_id: chatId,
                text: `Γ¥î ╪«╪╖╪º ╪»╪▒ ╪¿╪º╪▓█î╪º╪¿█î:\n${err.message || err}`
            });
        }
        return null;
    }
    if (text === "/cancel") {
        if (state) {
            await clearState(userId);
            await sendMainMenu(chatId, userId, "╪╣┘à┘ä█î╪º╪¬ ╪¼╪º╪▒█î ┘ä╪║┘ê ╪┤╪».");
            return null;
        }
        await sendMainMenu(chatId, userId, "┘ç█î┌å ╪╣┘à┘ä█î╪º╪¬ ┘ü╪╣╪º┘ä█î ╪¿╪▒╪º█î ┘ä╪║┘ê ┘ê╪¼┘ê╪» ┘å╪»╪º╪▒╪».");
        return null;
    }
    if (state) {
        const consumed = await parseAndApplyState(chatId, userId, text, photoFileId, stickerFileId, animationFileId, state);
        if (consumed)
            return null;
    }
    await sendMainMenu(chatId, userId, "╪»╪│╪¬┘ê╪▒ ┘å╪º┘à╪╣╪¬╪¿╪▒ ╪¿┘ê╪». ╪º╪▓ ┘à┘å┘ê█î ╪▓█î╪▒ ╪º╪│╪¬┘ü╪º╪»┘ç ┌⌐┘å█î╪»:");
}
export async function handleTelegramUpdate(update) {
    await ensureSchema();
    if (update.update_id) {
        const inserted = await sql `
      INSERT INTO processed_updates (update_id)
      VALUES (${update.update_id})
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id;
    `;
        if (!inserted.length) {
            logInfo("duplicate_update_ignored", { updateId: update.update_id });
            return null;
        }
        // Prune old updates asynchronously without awaiting
        sql `DELETE FROM processed_updates WHERE created_at < NOW() - INTERVAL '1 day'`.catch(() => { });
        cancelExpiredCryptoOrders().catch(() => { });
        sql `UPDATE wallet_topups SET status = 'cancelled' WHERE status = 'pending' AND crypto_expires_at IS NOT NULL AND crypto_expires_at < NOW()`.catch(() => { });
    }
    if (update.callback_query) {
        await handleCallback(update.callback_query);
        return null;
    }
    if (update.message) {
        await handleMessage(update.message);
    }
}
// Pingchi Integration
export async function getPingchiKey() {
    return String((await getSetting("pingchi_api_key")) || "").trim();
}
export async function pingchiApi(action, payload = {}) {
    const key = await getPingchiKey();
    if (!key)
        return { ok: false, message: "Pingchi API key not configured." };
    const res = await fetchWithTimeout("https://api.pinha.org/", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Access-Key": key
        },
        body: JSON.stringify({ action, ...payload })
    });
    const raw = await res.text();
    const data = parseJsonObject(raw);
    if (!res.ok || !data) {
        if (data && data.message)
            return { ok: false, message: data.message, code: data.code };
        return { ok: false, message: `Pingchi HTTP ${res.status}: ${responseSnippet(raw)}` };
    }
    return { ok: data.success, data: data.data, raw: data };
}
export async function provisionPingchiSale(order, panelConfig) {
    const planId = panelConfig.pingchi_plan_id;
    if (!planId)
        throw new Error("Pingchi plan ID not configured for this product.");
    // order_id has to be max 64 chars
    const orderId = order.purchase_id.substring(0, 64);
    const name = (order.product_name_snapshot || "?????").substring(0, 60);
    const res = await pingchiApi("services.create", {
        plan_id: planId,
        order_id: orderId,
        name: name
    });
    if (!res.ok) {
        throw new Error(`Pingchi error: ${res.message}`);
    }
    const service = res.data?.service || {};
    const subUrl = service.subscription_url || "";
    const username = service.username || "";
    const configValue = subUrl || username || "No link provided";
    const deliveryPayload = {
        type: "pingchi",
        subscriptionUrl: subUrl,
        configLinks: subUrl ? [subUrl] : [],
        metadata: { username }
    };
    return { configValue, deliveryPayload };
}
