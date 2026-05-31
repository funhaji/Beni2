// @ts-nocheck
import { ensureSchema, sql } from "../db.js";
import { verifyAdminToken, lookupIdentifierInPanels, isMarzbanLike, loginMarzbanPanel, normalizeBaseUrl, fetchWithTimeout, parseJsonObject, responseSnippet, getPasarguardGroups } from "../bot.js";
function formatBytes(bytes) {
    if (bytes <= 0)
        return "unlimited";
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1)
        return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
}
function formatExpiry(expireMs) {
    if (!expireMs || expireMs <= 0)
        return "unlimited";
    const remaining = expireMs - Date.now();
    if (remaining <= 0)
        return "expired";
    const days = Math.ceil(remaining / (1000 * 60 * 60 * 24));
    return `${days} days`;
}
export default async function handler(req, res) {
    try {
        await ensureSchema();
        if (req.method === "GET") {
            const token = String(req.query?.token || "");
            if (!token || !verifyAdminToken(token)) {
                return res.status(401).json({ ok: false, error: "Unauthorized" });
            }
            const panels = await sql `
        SELECT id, name, panel_type, active
        FROM panels
        WHERE active = TRUE
        ORDER BY priority DESC, id ASC;
      `;
            return res.json({ ok: true, panels });
        }
        if (req.method !== "POST") {
            return res.status(405).json({ ok: false, error: "Method not allowed" });
        }
        const body = req.body || {};
        const token = String(body.token || "");
        if (!token || !verifyAdminToken(token)) {
            return res.status(401).json({ ok: false, error: "Unauthorized" });
        }
        const action = String(body.action || "");
        // ── LOOKUP ────────────────────────────────────────────────────────────────
        if (action === "lookup") {
            const subLink = String(body.subLink || "").trim();
            if (!subLink)
                return res.status(400).json({ ok: false, error: "subLink is required" });
            // includeInactive: the source panel is often deactivated before migration
            const hit = await lookupIdentifierInPanels(subLink, { includeInactive: true });
            if (!hit.ok) {
                return res.json({ ok: false, error: "Config not found on any panel (active or inactive). Check the sub-link/username and make sure the inbound backup is uploaded." });
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
                // sanaei: totalGB is stored as bytes (field name is misleading)
                const totalBytes = Number(panelUser.totalGB || 0);
                const usedUp = Number(panelUser.up || 0);
                const usedDown = Number(panelUser.down || 0);
                remainingBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedUp - usedDown) : 0;
                expireMs = Number(panelUser.expiryTime || 0);
            }
            return res.json({
                ok: true,
                sourcePanelId: hit.panelId,
                sourcePanelName: hit.panelName,
                sourcePanelType: hit.panelType,
                sourceUserKey: hit.panelUserKey,
                remainingBytes,
                expireMs,
                remainingLabel: formatBytes(remainingBytes),
                expiryLabel: formatExpiry(expireMs),
            });
        }
        // ── PROVISION ─────────────────────────────────────────────────────────────
        if (action === "provision") {
            const subLink = String(body.subLink || "").trim();
            const targetPanelId = Number(body.targetPanelId || 0);
            if (!subLink)
                return res.status(400).json({ ok: false, error: "subLink is required" });
            if (!targetPanelId)
                return res.status(400).json({ ok: false, error: "targetPanelId is required" });
            // 1. Lookup old config — search inactive panels too
            const hit = await lookupIdentifierInPanels(subLink, { includeInactive: true });
            if (!hit.ok) {
                return res.json({ ok: false, error: "Config not found on any panel (active or inactive). Check the sub-link/username and make sure the inbound backup is uploaded." });
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
                const usedUp = Number(panelUser.up || 0);
                const usedDown = Number(panelUser.down || 0);
                remainingBytes = totalBytes > 0 ? Math.max(0, totalBytes - usedUp - usedDown) : 0;
                expireMs = Number(panelUser.expiryTime || 0);
            }
            // Block provisioning when remaining data is unknown/zero — setting data_limit=0
            // on Marzban/PasarGuard means unlimited, which must never happen silently.
            if (remainingBytes <= 0) {
                return res.json({
                    ok: false,
                    error: "Cannot determine remaining data for this config (value is 0 or unlimited). Migration blocked to prevent creating an unlimited config. Upload the inbound backup first."
                });
            }
            const remainingDays = expireMs > Date.now()
                ? Math.ceil((expireMs - Date.now()) / (1000 * 60 * 60 * 24))
                : 0;
            const remainingMb = remainingBytes > 0 ? Math.ceil(remainingBytes / (1024 * 1024)) : 0;
            // 2. Load target panel
            const targetRows = await sql `
        SELECT id, name, panel_type, base_url, username, password
        FROM panels WHERE id = ${targetPanelId} AND active = TRUE LIMIT 1;
      `;
            if (!targetRows.length) {
                return res.json({ ok: false, error: "Target panel not found or inactive" });
            }
            const targetPanel = targetRows[0];
            const targetType = String(targetPanel.panel_type || "");
            if (!isMarzbanLike(targetType)) {
                return res.json({ ok: false, error: "Only Marzban/PasarGuard targets are supported for web migration" });
            }
            // 3. Login to target panel
            const login = await loginMarzbanPanel({
                base_url: String(targetPanel.base_url),
                username: String(targetPanel.username || ""),
                password: String(targetPanel.password || "")
            });
            if (!login.res.ok || !login.token) {
                return res.json({ ok: false, error: `Target panel auth failed: ${responseSnippet(login.raw)}` });
            }
            // 4. Build new username
            const srcKey = String(hit.panelUserKey || "").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 26);
            const suffix = Math.floor(Math.random() * 9000) + 1000;
            const newUsername = `${srcKey || "m"}_${suffix}`.slice(0, 32);
            const expireTimeSec = expireMs > Date.now() ? Math.floor(expireMs / 1000) : 0;
            // 4b. Build user payload — PasarGuard and Marzban have different APIs
            const isPasarGuard = targetType === "pasarguard";
            let userPayload;
            if (isPasarGuard) {
                // PasarGuard: uses proxy_settings + group_ids (not proxies/inbounds)
                const groups = await getPasarguardGroups(String(targetPanel.base_url), login.token);
                if (groups.length === 0) {
                    return res.json({ ok: false, error: "PasarGuard: no groups found on panel. Create at least one group first." });
                }
                userPayload = {
                    username: newUsername,
                    proxy_settings: {},
                    group_ids: groups.map((g) => g.id),
                    expire: expireTimeSec,
                    data_limit: remainingBytes,
                    data_limit_reset_strategy: "no_reset",
                    status: "active",
                    note: `migrated_from:${hit.panelName}|key:${hit.panelUserKey}`
                };
            }
            else {
                // Marzban: fetch inbounds from /api/inbounds
                const inboundsRes = await fetchWithTimeout(`${normalizeBaseUrl(String(targetPanel.base_url))}/api/inbounds`, { headers: { Authorization: `Bearer ${login.token}`, Accept: "application/json" } });
                const inboundsRaw = await inboundsRes.text();
                const inboundsData = parseJsonObject(inboundsRaw);
                const inboundsMap = {};
                const proxiesMap = {};
                if (inboundsData && typeof inboundsData === "object") {
                    for (const [proto, entries] of Object.entries(inboundsData)) {
                        if (!Array.isArray(entries) || entries.length === 0)
                            continue;
                        const tags = entries
                            .map((e) => String(e.tag || ""))
                            .filter(Boolean);
                        if (tags.length > 0) {
                            inboundsMap[proto] = tags;
                            proxiesMap[proto] = {};
                        }
                    }
                }
                if (Object.keys(proxiesMap).length === 0) {
                    proxiesMap["vless"] = {};
                    inboundsMap["vless"] = [];
                }
                userPayload = {
                    username: newUsername,
                    proxies: proxiesMap,
                    inbounds: inboundsMap,
                    expire: expireTimeSec,
                    data_limit: remainingBytes,
                    data_limit_reset_strategy: "no_reset",
                    status: "active",
                    note: `migrated_from:${hit.panelName}|key:${hit.panelUserKey}`
                };
            }
            const createRes = await fetchWithTimeout(`${normalizeBaseUrl(String(targetPanel.base_url))}/api/user`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${login.token}`,
                    "Content-Type": "application/json",
                    Accept: "application/json"
                },
                body: JSON.stringify(userPayload)
            });
            const createRaw = await createRes.text();
            const createData = parseJsonObject(createRaw);
            if (!createRes.ok || !createData) {
                return res.json({ ok: false, error: `Provision failed: ${responseSnippet(createRaw)}` });
            }
            const links = Array.isArray(createData.links)
                ? createData.links.map((l) => String(l || "")).filter(Boolean)
                : [];
            return res.json({
                ok: true,
                username: newUsername,
                subscriptionUrl: createData.subscription_url || null,
                links,
                remainingLabel: formatBytes(remainingBytes),
                expiryLabel: formatExpiry(expireMs),
                sourcePanelName: hit.panelName,
                targetPanelName: String(targetPanel.name || ""),
                sourceUserKey: hit.panelUserKey
            });
        }
        return res.status(400).json({ ok: false, error: "Unknown action" });
    }
    catch (err) {
        console.error("[migrate] error:", err);
        return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
}
