/**
 * Shared backup/restore logic.
 * Imported by both api/backup.ts, api/restore.ts and lib/bot.ts.
 * Kept in lib/ to avoid circular imports (api files already import lib/bot.ts).
 */

import { ensureSchema, resetSchemaCache, sql } from "./db.js";
import { logError, logInfo } from "./log.js";
import { invalidateSettingsCache } from "./settings.js";

// ─── Tables exported / restored ──────────────────────────────────────────────
// Order here is FK-safe for insertion (parents before children).
export const BACKUP_TABLES = [
  "settings",
  "users",
  "panels",
  "products",
  "inventory",
  "discounts",
  "cards",
  "payment_methods",
  "crypto_wallets",
  "banned_users",
  "orders",
  "wallet_transactions",
  "wallet_topups",
  "referral_rewards",
  "topup_requests",
  "panel_migrations",
  "config_forensics",
] as const;

export type BackupData = {
  version: "1.0";
  exported_at: string;
  tables: Record<string, Record<string, unknown>[]>;
};

// ─── Export ───────────────────────────────────────────────────────────────────
export async function exportAllTables(): Promise<BackupData> {
  await ensureSchema();
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of BACKUP_TABLES) {
    try {
      // Use inline literal table name — not parameterized, safe since it's
      // from our own hardcoded array.
      switch (table) {
        case "settings":             tables[table] = await sql`SELECT * FROM settings;`; break;
        case "users":                tables[table] = await sql`SELECT * FROM users;`; break;
        case "panels":               tables[table] = await sql`SELECT * FROM panels;`; break;
        case "products":             tables[table] = await sql`SELECT * FROM products;`; break;
        case "inventory":            tables[table] = await sql`SELECT * FROM inventory;`; break;
        case "discounts":            tables[table] = await sql`SELECT * FROM discounts;`; break;
        case "cards":                tables[table] = await sql`SELECT * FROM cards;`; break;
        case "payment_methods":      tables[table] = await sql`SELECT * FROM payment_methods;`; break;
        case "crypto_wallets":       tables[table] = await sql`SELECT * FROM crypto_wallets;`; break;
        case "banned_users":         tables[table] = await sql`SELECT * FROM banned_users;`; break;
        case "orders":               tables[table] = await sql`SELECT * FROM orders;`; break;
        case "wallet_transactions":  tables[table] = await sql`SELECT * FROM wallet_transactions;`; break;
        case "wallet_topups":        tables[table] = await sql`SELECT * FROM wallet_topups;`; break;
        case "referral_rewards":     tables[table] = await sql`SELECT * FROM referral_rewards;`; break;
        case "topup_requests":       tables[table] = await sql`SELECT * FROM topup_requests;`; break;
        case "panel_migrations":     tables[table] = await sql`SELECT * FROM panel_migrations;`; break;
        case "config_forensics":     tables[table] = await sql`SELECT * FROM config_forensics;`; break;
        default:                     tables[table] = []; break;
      }
    } catch {
      tables[table] = [];
    }
  }
  return { version: "1.0", exported_at: new Date().toISOString(), tables };
}

// ─── Restore ──────────────────────────────────────────────────────────────────
export async function restoreFromBackup(data: BackupData): Promise<{ restored: Record<string, number> }> {
  await ensureSchema();

  // Truncate all tables — children first to satisfy FK constraints
  await sql`
    TRUNCATE TABLE
      config_forensics,
      panel_migrations,
      topup_requests,
      referral_rewards,
      wallet_topups,
      wallet_transactions,
      orders,
      banned_users,
      crypto_wallets,
      payment_methods,
      cards,
      discounts,
      inventory,
      products,
      panels,
      users,
      settings
    RESTART IDENTITY CASCADE;
  `;

  const restored: Record<string, number> = {};
  const t = data.tables ?? {};

  async function ins(table: string, rows: Record<string, unknown>[]): Promise<number> {
    if (!rows.length) return 0;
    const json = JSON.stringify(rows);
    try {
      // jsonb_populate_recordset() lets PostgreSQL handle all JSON→column type
      // coercions. Table names are inline literals (from our hardcoded list).
      switch (table) {
        case "settings":
          await sql`INSERT INTO settings SELECT * FROM jsonb_populate_recordset(NULL::settings, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "users":
          await sql`INSERT INTO users SELECT * FROM jsonb_populate_recordset(NULL::users, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "panels":
          await sql`INSERT INTO panels SELECT * FROM jsonb_populate_recordset(NULL::panels, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "products":
          await sql`INSERT INTO products SELECT * FROM jsonb_populate_recordset(NULL::products, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "inventory":
          await sql`INSERT INTO inventory SELECT * FROM jsonb_populate_recordset(NULL::inventory, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "discounts":
          await sql`INSERT INTO discounts SELECT * FROM jsonb_populate_recordset(NULL::discounts, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "cards":
          await sql`INSERT INTO cards SELECT * FROM jsonb_populate_recordset(NULL::cards, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "payment_methods":
          await sql`INSERT INTO payment_methods SELECT * FROM jsonb_populate_recordset(NULL::payment_methods, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "crypto_wallets":
          await sql`INSERT INTO crypto_wallets SELECT * FROM jsonb_populate_recordset(NULL::crypto_wallets, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "banned_users":
          await sql`INSERT INTO banned_users SELECT * FROM jsonb_populate_recordset(NULL::banned_users, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "orders":
          await sql`INSERT INTO orders SELECT * FROM jsonb_populate_recordset(NULL::orders, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "wallet_transactions":
          await sql`INSERT INTO wallet_transactions SELECT * FROM jsonb_populate_recordset(NULL::wallet_transactions, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "wallet_topups":
          await sql`INSERT INTO wallet_topups SELECT * FROM jsonb_populate_recordset(NULL::wallet_topups, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "referral_rewards":
          await sql`INSERT INTO referral_rewards SELECT * FROM jsonb_populate_recordset(NULL::referral_rewards, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "topup_requests":
          await sql`INSERT INTO topup_requests SELECT * FROM jsonb_populate_recordset(NULL::topup_requests, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "panel_migrations":
          await sql`INSERT INTO panel_migrations SELECT * FROM jsonb_populate_recordset(NULL::panel_migrations, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        case "config_forensics":
          await sql`INSERT INTO config_forensics SELECT * FROM jsonb_populate_recordset(NULL::config_forensics, ${json}::jsonb) ON CONFLICT DO NOTHING;`;
          break;
        default:
          return 0;
      }
      return rows.length;
    } catch (err) {
      logError("restore_table_failed", err, { table, rowCount: rows.length });
      return 0;
    }
  }

  const ORDER = [
    "settings", "users", "panels", "products", "inventory",
    "discounts", "cards", "payment_methods", "crypto_wallets", "banned_users",
    "orders", "wallet_transactions", "wallet_topups", "referral_rewards",
    "topup_requests", "panel_migrations", "config_forensics",
  ] as const;

  for (const table of ORDER) {
    restored[table] = await ins(table, (t[table] ?? []) as Record<string, unknown>[]);
  }

  // Reset SERIAL/BIGSERIAL sequences to avoid PK collisions on new inserts
  const seqResets: Array<() => Promise<unknown>> = [
    () => sql`SELECT setval(pg_get_serial_sequence('panels','id'), COALESCE((SELECT MAX(id) FROM panels),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('products','id'), COALESCE((SELECT MAX(id) FROM products),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('inventory','id'), COALESCE((SELECT MAX(id) FROM inventory),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('discounts','id'), COALESCE((SELECT MAX(id) FROM discounts),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('orders','id'), COALESCE((SELECT MAX(id) FROM orders),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('cards','id'), COALESCE((SELECT MAX(id) FROM cards),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('crypto_wallets','id'), COALESCE((SELECT MAX(id) FROM crypto_wallets),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('topup_requests','id'), COALESCE((SELECT MAX(id) FROM topup_requests),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('wallet_transactions','id'), COALESCE((SELECT MAX(id) FROM wallet_transactions),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('wallet_topups','id'), COALESCE((SELECT MAX(id) FROM wallet_topups),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('referral_rewards','id'), COALESCE((SELECT MAX(id) FROM referral_rewards),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('panel_migrations','id'), COALESCE((SELECT MAX(id) FROM panel_migrations),1));`,
    () => sql`SELECT setval(pg_get_serial_sequence('config_forensics','id'), COALESCE((SELECT MAX(id) FROM config_forensics),1));`,
  ];

  for (const fn of seqResets) {
    await fn().catch(() => {});
  }

  logInfo("restore_completed", { counts: restored });

  // Flush stale in-process caches so the restored data is visible immediately
  // without waiting for the next cold start.
  invalidateSettingsCache();
  resetSchemaCache();

  return { restored };
}
