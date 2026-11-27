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
export type MapMetadata = { name: string | null; areaKm2: number | null };
export type MapUpdate = { status: "ready"; generation: number; metadata: MapMetadata } | { status: "waiting" | "invalid" | "unreachable" };
export type Contact = { kind: "own" | "friendly" | "enemy"; x: number; y: number };
export type ContactUpdate = { status: "ready"; generation: number; contacts: Contact[] } | { status: "unavailable"; generation: number };
export const CONTACT_LIMIT = 200;

// Bounds are full-map metres, independent of the display crop. Do not infer
// missing metadata from a generation, mission, or coordinates.
export function mapMetadata(value: unknown): MapMetadata {
  const info = record(value);
  const name = typeof info?.map_name === "string" ? info.map_name.trim().slice(0, 120) || null : null;
  const coordinate = (v: unknown): number | null => {
    if (typeof v !== "number" && !(typeof v === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim()))) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const min = info?.map_min, max = info?.map_max;
  if (!Array.isArray(min) || !Array.isArray(max) || min.length !== 2 || max.length !== 2) return { name, areaKm2: null };
  const x0 = coordinate(min[0]), y0 = coordinate(min[1]), x1 = coordinate(max[0]), y1 = coordinate(max[1]);
  if (x0 === null || y0 === null || x1 === null || y1 === null) return { name, areaKm2: null };
  const width = x1 - x0, height = y1 - y0;
  const area = (width / 1000) * (height / 1000);
  return { name, areaKm2: width > 0 && height > 0 && Number.isFinite(area) && area > 0 ? area : null };
}

// A square crop in normalized coordinates keeps the raster's native aspect
// ratio. The same transform is used for both axes and for marker positions.
export function contactCrop(contacts: readonly Contact[] | null): { x: number; y: number; size: number } {
  if (!contacts?.length) return { x: 0, y: 0, size: 1 };
  const xs = contacts.map(c => c.x), ys = contacts.map(c => c.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const size = Math.min(1, Math.max(.25, (maxX - minX) / .8, (maxY - minY) / .8));
  const origin = (min: number, max: number) => Math.max(0, Math.min(1 - size, (min + max - size) / 2));
  return { x: origin(minX, maxX), y: origin(minY, maxY), size };
}

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
    return generation === null ? { status: record(value)?.valid === false ? "invalid" : "waiting" } : { status: "ready", generation, metadata: mapMetadata(value) };
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
