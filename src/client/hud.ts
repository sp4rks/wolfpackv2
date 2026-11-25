import { record } from "../shared/protocol.ts";
import { stripGameColors } from "./chat.ts";
import { GAME_ORIGIN, POLL_MS } from "./telemetry.ts";

// Clan decorations are not part of the nickname; platform prefixes/suffixes are.
export function killIdentity(value: string): string | null {
  const name = stripGameColors(value).trim().replace(/^=[^=\s]{1,32}=\s+/, "").trim();
  if (!name || name.length > 128 || /[<>\x00-\x1f\x7f]/.test(name)) return null;
  return name.toLowerCase();
}

// Datamine menu.csv: NET_UNIT_KILLED_FM/GM use active voice;
// NET_PLAYER_KILLED_BY_* and NET_UNIT_KILLED_BY_PLAYER use passive.
// Require a named attacker and vehicle in either form.
export function killAttacker(message: string): string | null {
  const value = stripGameColors(message).trim();
  if (value.length > 4096 || /\b(?:teamkill|team kill|friendly fire|assist(?:ed|s)?)\b/i.test(value)) return null;
  const vehicle = String.raw`\(([^()]+(?:\([^()]*\)[^()]*)*)\)`;
  const passive = value.match(new RegExp(String.raw`^(.+?)\s+(?:shot down\s+by|destroyed\s+by|has been destroyed\s+by)\s+(.+?)\s+${vehicle}\.?$`, "i"));
  if (passive) {
    if (!passive[1]!.trim() || !passive[3]!.trim()) return null;
    return killIdentity(passive[2]!);
  }
  const active = value.match(new RegExp(String.raw`^(.+?)\s+${vehicle}\s+(?:shot down|destroyed)\s+(?!by\b)(\S.*)$`, "i"));
  if (!active || !active[2]!.trim() || !active[3]!.trim() || /[<>\x00-\x1f\x7f]/.test(active[3]!)) return null;
  return killIdentity(active[1]!);
}

type Damage = { id: number; attacker: string | null };
export function hudDamage(value: unknown): Damage[] {
  const obj = record(value);
  if (!obj || !Array.isArray(obj.events) || !Array.isArray(obj.damage)) throw new Error("Invalid HUD response");
  const entries = new Map<number, Damage>();
  for (const item of obj.damage) {
    const entry = record(item);
    if (!entry || !Number.isSafeInteger(entry.id) || (entry.id as number) < 0) continue;
    const id = entry.id as number;
    if (entries.has(id)) continue;
    const valid = typeof entry.msg === "string" && (entry.enemy === undefined || typeof entry.enemy === "boolean") && entry.enemy !== true && (entry.sender === undefined || entry.sender === "");
    entries.set(id, { id, attacker: valid ? killAttacker(entry.msg as string) : null });
  }
  return [...entries.values()].sort((a, b) => a.id - b.id);
}

export type HudUpdate = { available: boolean; counts: ReadonlyMap<string, number> };
// Counts are local, bounded, and reset with each map watcher. Never send HUD data.
export function watchHud(onUpdate: (update: HudUpdate) => void): () => void {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor = 0, initialized = false, recovering = false;
  const counts = new Map<string, number>();
  const poll = async () => {
    try {
      const baseline = !initialized || recovering;
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]);
      const options: RequestInit & { targetAddressSpace: "loopback" } = { signal, targetAddressSpace: "loopback", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error" };
      const response = await fetch(`${GAME_ORIGIN}/hudmsg?lastEvt=0&lastDmg=${baseline ? 0 : cursor}`, options);
      if (!response.ok) throw new Error("HUD unavailable");
      const incoming = hudDamage(await response.json());
      if (stop.signal.aborted) return;
      const max = incoming.at(-1)?.id;
      // A lower nonempty sequence signals a game restart. Rebaseline rather
      // than attributing buffered IDs from the new sequence to this match.
      const restarted = initialized && max !== undefined && max < cursor;
      if (restarted) { counts.clear(); cursor = 0; }
      if (!baseline && !restarted) for (const entry of incoming) {
        if (entry.id <= cursor || !entry.attacker) continue;
        if (counts.has(entry.attacker) || counts.size < 512) counts.set(entry.attacker, (counts.get(entry.attacker) ?? 0) + 1);
      }
      cursor = Math.max(cursor, max ?? 0);
      initialized = true; recovering = false;
      onUpdate({ available: true, counts });
    } catch {
      if (stop.signal.aborted) return;
      recovering = true;
      onUpdate({ available: false, counts });
    }
    if (!stop.signal.aborted) timer = setTimeout(poll, POLL_MS);
  };
  void poll();
  return () => { stop.abort(); clearTimeout(timer); };
}
