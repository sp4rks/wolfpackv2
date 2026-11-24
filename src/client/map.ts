import { record } from "../shared/protocol.ts";
import { GAME_ORIGIN, POLL_MS } from "./telemetry.ts";

// A generation is the only game-controlled value used in the image URL.
export function mapGeneration(value: unknown): number | null {
  const info = record(value);
  if (!info || (info.valid !== undefined && info.valid !== true)) return null;
  const raw = info.map_generation;
  if (typeof raw !== "number" && !(typeof raw === "string" && /^\d{1,16}$/.test(raw))) return null;
  const generation = Number(raw);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}
export type MapUpdate = { status: "ready"; generation: number } | { status: "waiting" | "invalid" | "unreachable" };
export type Contact = { kind: "own" | "friendly" | "enemy"; x: number; y: number };
export type ContactUpdate = { status: "ready"; generation: number; contacts: Contact[] } | { status: "unavailable"; generation: number };
export const CONTACT_LIMIT = 200;

function colour(value: unknown): Contact["kind"] | null {
  let rgb: unknown = value;
  if (typeof value === "string" && /^#[\da-f]{6}$/i.test(value)) rgb = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
  const [r, g, b] = rgb as [number, number, number];
  // Require a strong, unambiguous dominant channel; avoid guessing team colours.
  if (b >= 160 && b >= r + 80 && b >= g + 80) return "friendly";
  if (g >= 160 && g >= r + 80 && g >= b + 80) return "friendly";
  if (r >= 160 && r >= g + 80 && r >= b + 80) return "enemy";
  return null;
}

// Null means an incompatible response; an empty array is a valid feed.
export function mapContacts(value: unknown): Contact[] | null {
  if (!Array.isArray(value)) return null;
  const contacts: Contact[] = [];
  for (const item of value) {
    const obj = record(item);
    if (!obj || obj.type !== "aircraft" || typeof obj.x !== "number" || !Number.isFinite(obj.x) || obj.x < 0 || obj.x > 1 || typeof obj.y !== "number" || !Number.isFinite(obj.y) || obj.y < 0 || obj.y > 1) continue;
    let kind: Contact["kind"] | null = null;
    if (obj.icon === "Player") kind = "own";
    else {
      const hex = obj.color === undefined ? null : colour(obj.color);
      const array = obj["color[]"] === undefined ? null : colour(obj["color[]"]);
      if ((obj.color !== undefined && !hex) || (obj["color[]"] !== undefined && !array) || (hex && array && hex !== array)) continue;
      kind = hex ?? array;
    }
    if (kind) contacts.push({ kind, x: obj.x, y: obj.y });
    if (contacts.length >= CONTACT_LIMIT) break;
  }
  return contacts;
}

// Sequential reads avoid overlap. Publish metadata before the separately bounded
// object request, then recheck it before publishing generation-bound contacts.
export function watchMap(onUpdate: (update: MapUpdate) => void, onContacts: (update: ContactUpdate) => void): () => void {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (path: string): Promise<unknown> => {
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]);
    const options: RequestInit & { targetAddressSpace: "loopback" } = { signal, targetAddressSpace: "loopback", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error" };
    const response = await fetch(`${GAME_ORIGIN}${path}`, options);
    if (!response.ok) throw new Error("Game map feed unavailable");
    return response.json();
  };
  const metadata = async (): Promise<MapUpdate> => {
    const value = await read("/map_info.json");
    const generation = mapGeneration(value);
    return generation === null ? { status: record(value)?.valid === false ? "invalid" : "waiting" } : { status: "ready", generation };
  };
  const poll = async () => {
    try {
      const initial = await metadata();
      if (stop.signal.aborted) return;
      onUpdate(initial);
      if (initial.status === "ready" && !stop.signal.aborted) {
        let contacts: Contact[] | null = null;
        try { contacts = mapContacts(await read("/map_obj.json")); } catch { /* Keep the image on object-only failure. */ }
        if (stop.signal.aborted) return;
        if (contacts === null) onContacts({ status: "unavailable", generation: initial.generation });
        else {
          const current = await metadata();
          if (stop.signal.aborted) return;
          onUpdate(current);
          if (current.status === "ready" && current.generation === initial.generation && !stop.signal.aborted) onContacts({ status: "ready", generation: current.generation, contacts });
        }
      }
    } catch {
      if (!stop.signal.aborted) onUpdate({ status: "unreachable" });
    }
    if (!stop.signal.aborted) timer = setTimeout(poll, POLL_MS);
  };
  void poll();
  return () => { stop.abort(); clearTimeout(timer); };
}
