// @ts-nocheck
import { exportAllTables } from "../backup.js";
import { verifyAdminToken } from "../bot.js";
import { env } from "../env.js";
import { logError } from "../log.js";
import { ensureSchema, sql } from "../db.js";
// Tables that can be individually fetched — must match lib/backup.ts BACKUP_TABLES
const VALID_TABLES = [
    "settings", "users", "panels", "products", "inventory", "discounts",
    "cards", "payment_methods", "crypto_wallets", "banned_users", "orders",
    "wallet_transactions", "wallet_topups", "referral_rewards", "topup_requests",
    "panel_migrations", "config_forensics"
];
async function fetchTable(table) {
    switch (table) {
        case "settings": return sql `SELECT * FROM settings;`;
        case "users": return sql `SELECT * FROM users;`;
        case "panels": return sql `SELECT * FROM panels;`;
        case "products": return sql `SELECT * FROM products;`;
        case "inventory": return sql `SELECT * FROM inventory;`;
        case "discounts": return sql `SELECT * FROM discounts;`;
        case "cards": return sql `SELECT * FROM cards;`;
        case "payment_methods": return sql `SELECT * FROM payment_methods;`;
        case "crypto_wallets": return sql `SELECT * FROM crypto_wallets;`;
        case "banned_users": return sql `SELECT * FROM banned_users;`;
        case "orders": return sql `SELECT * FROM orders;`;
        case "wallet_transactions": return sql `SELECT * FROM wallet_transactions;`;
        case "wallet_topups": return sql `SELECT * FROM wallet_topups;`;
        case "referral_rewards": return sql `SELECT * FROM referral_rewards;`;
        case "topup_requests": return sql `SELECT * FROM topup_requests;`;
        case "panel_migrations": return sql `SELECT * FROM panel_migrations;`;
        case "config_forensics": return sql `SELECT * FROM config_forensics;`;
        default: return [];
    }
}
export default async function handler(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {
        res.status(405).json({ ok: false, error: "Method not allowed" });
        return;
    }
    const token = String(req.query?.token || req.body?.token || "");
    const xKey = String(req.headers?.["x-api-key"] || "");
    const adminId = verifyAdminToken(token);
    const keyOk = env.X_API_KEY && xKey === env.X_API_KEY;
    if (!adminId && !keyOk) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
    }
    try {
        await ensureSchema();
        // Single-table mode — used by the web backup page to fetch tables one at a time
        // and avoid serverless timeout on large databases
        const tableParam = String(req.query?.table || "").trim();
        if (tableParam) {
            if (!VALID_TABLES.includes(tableParam)) {
                res.status(400).json({ ok: false, error: "Unknown table: " + tableParam });
                return;
            }
            const rows = await fetchTable(tableParam);
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.status(200).json({ ok: true, table: tableParam, rows });
            return;
        }
        // Full backup mode — original behavior
        const backup = await exportAllTables();
        const json = JSON.stringify(backup, null, 2);
        const filename = `backup_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.status(200).send(json);
    }
    catch (error) {
        logError("backup_api_failed", error);
        res.status(500).json({ ok: false, error: "Backup failed" });
    }
}
