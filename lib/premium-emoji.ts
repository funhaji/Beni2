import { tg } from "./telegram.js";

type StickerSet = {
  stickers?: Array<{ custom_emoji_id?: string; emoji?: string }>;
};

type EmojiSample = { id: string; emoji: string };

const stickerSetCache = new Map<string, { samples: EmojiSample[]; updatedAt: number }>();

const PACKS = {
  crypto: ["CryptoPJ"],
  proxy: ["Proxy_PJ10"],
  info: ["cwdinfo_aemoji"]
} as const;

async function getCustomEmojiSamples(setName: string) {
  const now = Date.now();
  const hit = stickerSetCache.get(setName);
  if (hit && now - hit.updatedAt < 10 * 60_000) return hit.samples;
  const data = await tg<StickerSet>("getStickerSet", { name: setName });
  const samples = (data?.stickers || [])
    .map((s) => ({ id: String(s?.custom_emoji_id || ""), emoji: String(s?.emoji || "") }))
    .filter((x) => x.id && x.emoji);
  stickerSetCache.set(setName, { samples, updatedAt: now });
  return samples;
}

export async function premiumPrefix(category: keyof typeof PACKS, fallback = "✨") {
  try {
    const setName = PACKS[category][0];
    const samples = await getCustomEmojiSamples(setName);
    const sample = samples[0];
    if (!sample) return { text: `${fallback} `, entities: undefined as any };
    return {
      text: `${sample.emoji} `,
      entities: [{ type: "custom_emoji", offset: 0, length: sample.emoji.length, custom_emoji_id: sample.id }]
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
