import { record } from "./protocol.ts";

export type PublicMode = { mode: "a" | "r" | "s"; battles: number; killsPerBattle: number | null; airKd: number | null };
export type PublicStats = { updated: string | null; modes: PublicMode[] };

// Do not guess platform identities. Only strip the known clan prefix.
export function nickname(value: string): string | null {
  const name = value.replace(/^=[\p{L}\p{N}_-]{1,12}=\s+/u, "").trim();
  // A platform suffix and/or disambiguator are explicit identities, not guesses.
  const match = name.match(/^([\p{L}\p{M}\p{N}_. -]{2,32}?)(?:(@(?:live|psn))(#\d{1,8})?|(#\d{1,8})(@(?:live|psn))?)?$/iu);
  const base = match?.[1];
  if (!base || base === "." || base === ".." || !/\p{L}/u.test(base) ||
      base !== base.trim() || /^player[\s_.-]*\d+$/iu.test(base)) return null;
  return name;
}
export function publicStats(value: unknown, name: string): PublicStats | null {
  const stats = record(record(value)?.stats);
  if (!stats || typeof stats.nick !== "string" || stats.nick.toLowerCase() !== name.toLowerCase()) return null;
  const updated = typeof stats.last_stat === "string" && /^\d{4}-\d{2}-\d{2}(?:\b|$)/.test(stats.last_stat) ? stats.last_stat.slice(0, 10) : null;
  const modes: PublicMode[] = [];
  for (const mode of ["a", "r", "s"] as const) {
    const source = record(stats[mode]);
    const battles = source?.mission;
    if (typeof battles !== "number" || !Number.isSafeInteger(battles) || battles <= 0) continue;
    const metric = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    modes.push({ mode, battles, killsPerBattle: metric(source?.kb_pvp_air), airKd: metric(source?.kd_pvp_air) });
  }
  return { updated, modes };
}
