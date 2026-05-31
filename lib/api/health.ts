// @ts-nocheck
import { ensureSchema } from "../db.js";
import { logError } from "../log.js";
export default async function handler(_req, res) {
    try {
        await ensureSchema();
        res.status(200).json({ ok: true });
    }
    catch (error) {
        logError("health_check_failed", error);
        res.status(500).json({ ok: false });
    }
}
