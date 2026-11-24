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
export type MapUpdate = { status: "ready"; generation: number } | { status: "waiting" | "unreachable" };

// Only metadata is fetched as CORS JSON. The image itself is loaded by <img>.
export function watchMap(onUpdate: (update: MapUpdate) => void): () => void {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]);
      const options: RequestInit & { targetAddressSpace: "loopback" } = { signal, targetAddressSpace: "loopback", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error" };
      const response = await fetch(`${GAME_ORIGIN}/map_info.json`, options);
      if (!response.ok) throw new Error("Map metadata unavailable");
      const generation = mapGeneration(await response.json());
      if (!stop.signal.aborted) onUpdate(generation === null ? { status: "waiting" } : { status: "ready", generation });
    } catch {
      if (!stop.signal.aborted) onUpdate({ status: "unreachable" });
    }
    if (!stop.signal.aborted) timer = setTimeout(poll, POLL_MS);
  };
  void poll();
  return () => { stop.abort(); clearTimeout(timer); };
}
