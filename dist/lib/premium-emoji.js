import { tg } from "./telegram.js";
const stickerSetCache = new Map();
const PACKS = {
    crypto: ["CryptoPJ"],
    proxy: ["Proxy_PJ10"],
    info: ["cwdinfo_aemoji"]
};
async function getCustomEmojiIds(setName) {
    const now = Date.now();
    const hit = stickerSetCache.get(setName);
    if (hit && now - hit.updatedAt < 10 * 60_000)
        return hit.ids;
    const data = await tg("getStickerSet", { name: setName });
    const ids = (data?.stickers || []).map((s) => String(s?.custom_emoji_id || "")).filter(Boolean);
    stickerSetCache.set(setName, { ids, updatedAt: now });
    return ids;
}
function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}
export async function premiumPrefix(category, fallback = "✨") {
    try {
        const pack = pick([...PACKS[category]]);
        const ids = await getCustomEmojiIds(pack);
        const id = ids.length ? pick(ids) : "";
        if (!id)
            return { text: `${fallback} `, entities: undefined };
        return {
            text: "⬜ ",
            entities: [{ type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: id }]
        };
    }
    catch {
        return { text: `${fallback} `, entities: undefined };
    }
}
export async function withPremiumPrefix(text, category, fallback = "✨") {
    const p = await premiumPrefix(category, fallback);
    if (!p.entities)
        return { text: p.text + text };
    return { text: p.text + text, entities: p.entities };
}
