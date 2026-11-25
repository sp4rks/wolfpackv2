import { killIdentity, record } from "../shared/protocol.ts";
import { GAME_ORIGIN, POLL_MS } from "./telemetry.ts";

export type ChatMessage = { id: number; msg: string; sender: string | null; channel: string | null; enemy: boolean; receivedAt: number | null };
export type Sighting = { key: string; player: string; aircraft: string; reporter: string | null; grid: string | null; altitudeM: number | null; receivedAt: number; altitudeAt?: number };
const MAX_MESSAGES = 200;

// Preserve height only for the same closely timed call, never indefinitely
// through a chain of incomplete updates.
export function mergeSighting(previous: Sighting | undefined, next: Sighting): Sighting {
  if (!previous || next.altitudeM !== null || previous.altitudeM === null) return next;
  const norm = (s: string) => s.trim().toLocaleLowerCase();
  const altitudeAt = previous.altitudeAt ?? previous.receivedAt;
  const compatible = norm(previous.aircraft) === norm(next.aircraft) &&
    (!previous.grid || !next.grid || previous.grid === next.grid) &&
    (!previous.reporter || !next.reporter || (killIdentity(previous.reporter) !== null && killIdentity(previous.reporter) === killIdentity(next.reporter)));
  return compatible && Math.abs(next.receivedAt - altitudeAt) <= 8000
    ? { ...next, altitudeM: previous.altitudeM, altitudeAt } : next;
}

// Reject malformed entries instead of allowing unbounded or non-text game data into the UI.
export function normalizeChat(value: unknown): Omit<ChatMessage, "receivedAt">[] {
  if (!Array.isArray(value)) throw new Error("Invalid chat response");
  const messages = new Map<number, Omit<ChatMessage, "receivedAt">>();
  for (const item of value) {
    const v = record(item);
    if (!v || !Number.isSafeInteger(v.id) || (v.id as number) <= 0 ||
        typeof v.msg !== "string" || !v.msg.trim() || v.msg.length > 4096 ||
        (v.enemy !== undefined && typeof v.enemy !== "boolean")) continue;
    const bounded = (x: unknown) => typeof x === "string" && x.length <= 128 && !/[\x00-\x1f\x7f]/.test(x) && x.trim() ? x.trim() : null;
    const channel = typeof v.mode === "number" && Number.isSafeInteger(v.mode) ? String(v.mode) : bounded(v.mode);
    if (!messages.has(v.id as number)) messages.set(v.id as number, { id: v.id as number, msg: v.msg, sender: bounded(v.sender), channel, enemy: v.enemy === true });
    // Long sessions can return large valid backlogs. Keep only recent IDs,
    // including while normalizing, rather than failing bootstrap forever.
    if (messages.size > MAX_MESSAGES * 2) {
      const ids = [...messages.keys()].sort((a, b) => a - b);
      for (const id of ids.slice(0, ids.length - MAX_MESSAGES)) messages.delete(id);
    }
  }
  return [...messages.values()].sort((a, b) => a.id - b.id).slice(-MAX_MESSAGES);
}

const prefix = /^(?:I'm attacking|Assaulting|Starting combat with|Engaging with|Attack|Destroy|Eliminate|Someone, attack) (.+)!$/;
// Game color decoration is presentation only. Other markup stays literal text.
export function stripGameColors(value: string): string {
  return value.replace(/<color(?:=[^<>\r\n]{1,100})?>|<\/color>/gi, "");
}
export function parseSighting(message: ChatMessage): Sighting | null {
  if (message.enemy || message.receivedAt === null) return null;
  // Only game color wrappers are removed; all other markup remains plain text.
  let value = stripGameColors(message.msg).trim();
  let grid: string | null = null, altitudeM: number | null = null;
  const suffix = value.match(/\s*\[([^\[\]]*)\]\s*$/);
  if (suffix) {
    value = value.slice(0, suffix.index).trim();
    const parts = suffix[1]!.split(/,\s*(?=alt\.)/i);
    if (/^[A-Za-z]{1,2}\d{1,3}$/.test(parts[0]!.trim())) grid = parts[0]!.trim().toUpperCase();
    if (parts.length === 2) {
      const a = parts[1]!.match(/^alt\.\s*([+-]?(?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\.\d+)?)\s*(m|ft)$/i);
      if (a) {
        const n = Number(a[1]!.replace(/[ ,]/g, "")) * (a[2]!.toLowerCase() === "ft" ? 0.3048 : 1);
        if (Number.isFinite(n) && Math.abs(n) <= 100_000) altitudeM = n;
      }
    }
  }
  const target = value.match(prefix)?.[1];
  if (!target?.endsWith(")")) return null;
  let depth = 0, open = -1;
  for (let i = target.length - 1; i >= 0; i--) {
    if (target[i] === ")") depth++;
    else if (target[i] === "(" && --depth === 0) { open = i; break; }
  }
  if (open < 1) return null;
  const player = target.slice(0, open).trim(), aircraft = target.slice(open + 1, -1).trim();
  if (!player || player.toLowerCase() === "my target" || !aircraft || player.length > 128 || aircraft.length > 128 || /[<>]/.test(player + aircraft)) return null;
  const reporter = message.sender ? stripGameColors(message.sender).trim() || null : null;
  return { key: player.toLocaleLowerCase(), player, aircraft, reporter, grid, altitudeM, receivedAt: message.receivedAt };
}

export type ChatUpdate = { status: "live" | "retrying"; messages: ChatMessage[]; fresh: ChatMessage[]; reset: boolean; relayFresh: boolean };

// One request at a time. Recovery re-bootstraps to detect an ID restart.
export function watchChat(onUpdate: (update: ChatUpdate) => void): () => void {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, first = true, initialized = false, recovering = false, cursor = 0;
  let messages: ChatMessage[] = [];
  const poll = async () => {
    try {
      const baseline = !initialized || recovering;
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(first ? 30_000 : 3_000)]);
      const options: RequestInit & { targetAddressSpace: "loopback" } = { signal, targetAddressSpace: "loopback", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error" };
      const response = await fetch(`${GAME_ORIGIN}/gamechat?lastId=${baseline ? 0 : cursor}`, options);
      if (!response.ok) throw new Error("Chat unavailable");
      const incoming = normalizeChat(await response.json());
      if (stop.signal.aborted) return;
      const max = incoming.at(-1)?.id ?? 0;
      const reset = initialized && recovering && max < cursor;
      if (!initialized || reset) { messages = []; cursor = 0; }
      const now = Date.now();
      const fresh: ChatMessage[] = [];
      for (const entry of incoming) {
        if (entry.id <= cursor) continue;
        const msg = { ...entry, receivedAt: !initialized || reset ? null : now };
        messages.push(msg);
        if (msg.receivedAt !== null) fresh.push(msg);
      }
      cursor = Math.max(cursor, max);
      messages = messages.slice(-MAX_MESSAGES);
      initialized = true; recovering = false; first = false;
      onUpdate({ status: "live", messages: [...messages].reverse(), fresh, reset, relayFresh: !baseline });
    } catch {
      if (stop.signal.aborted) return;
      first = false; recovering = initialized;
      onUpdate({ status: "retrying", messages: [...messages].reverse(), fresh: [], reset: false, relayFresh: false });
    }
    if (!stop.signal.aborted) timer = setTimeout(poll, POLL_MS);
  };
  void poll();
  return () => { stop.abort(); clearTimeout(timer); };
}
