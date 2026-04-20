import { tg } from "./telegram.js";

type StickerSet = {
  stickers?: Array<{ custom_emoji_id?: string }>;
};

const stickerSetCache = new Map<string, { ids: string[]; updatedAt: number }>();

const PACKS = {
  crypto: ["CryptoPJ"],
  proxy: ["Proxy_PJ10"],
  info: ["cwdinfo_aemoji"]
} as const;

async function getCustomEmojiIds(setName: string) {
  const now = Date.now();
  const hit = stickerSetCache.get(setName);
  if (hit && now - hit.updatedAt < 10 * 60_000) return hit.ids;
  const data = await tg<StickerSet>("getStickerSet", { name: setName });
  const ids = (data?.stickers || []).map((s) => String(s?.custom_emoji_id || "")).filter(Boolean);
  stickerSetCache.set(setName, { ids, updatedAt: now });
  return ids;
}

function pick<T>(arr: T[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function premiumPrefix(category: keyof typeof PACKS, fallback = "✨") {
  try {
    const pack = pick([...PACKS[category]]);
    const ids = await getCustomEmojiIds(pack);
    const id = ids.length ? pick(ids) : "";
    if (!id) return { text: `${fallback} `, entities: undefined as any };
    return {
      text: "⬜ ",
      entities: [{ type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: id }]
    };
  } catch {
    return { text: `${fallback} `, entities: undefined as any };
  }
}

export async function withPremiumPrefix(text: string, category: keyof typeof PACKS, fallback = "✨") {
  const p = await premiumPrefix(category, fallback);
  if (!p.entities) return { text: p.text + text };
  return { text: p.text + text, entities: p.entities };
}

