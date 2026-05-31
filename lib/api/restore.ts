// @ts-nocheck
import { restoreFromBackup } from "../backup.js";
import { verifyAdminToken } from "../bot.js";
import { env } from "../env.js";
import { logError, logInfo } from "../log.js";
export default async function handler(req, res) {
    if (req.method !== "POST") {
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
        const body = req.body;
        if (!body || body.version !== "1.0" || typeof body.tables !== "object") {
            res.status(400).json({
                ok: false,
                error: "Invalid backup format. Expected { version: '1.0', tables: { ... } }"
            });
            return;
        }
        const result = await restoreFromBackup(body);
        logInfo("restore_api_completed", { restoredBy: adminId, counts: result.restored });
        res.status(200).json({ ok: true, restored: result.restored });
    }
    catch (error) {
        logError("restore_api_failed", error);
        res.status(500).json({
            ok: false,
            error: "Restore failed: " + String(error.message || error)
        });
    }
}
