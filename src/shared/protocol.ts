export const SOCKET_PATH = "/api/squad";
export const SOCKET_PROTOCOL = "wolfpack.v1";
export const SAMPLE_LIFETIME_MS = 12_000;

const readings = [
  "iasKph", "tasKph", "altitudeM", "climbMps", "headingDeg", "throttlePct",
  "oilTempC", "waterTempC", "propPitch", "manifoldPressure",
] as const;

export type Telemetry = Record<typeof readings[number], number | null> & {
  aircraft: string | null;
};

export type Member = {
  id: string;
  name: string;
  sample: Telemetry | null;
};

export type RoomSighting = {
  player: string; aircraft: string; grid: string | null;
  altitudeM: number | null; reporter: string | null;
};

// The game strips clan decorations when comparing kill identities.
export function killIdentity(value: string): string | null {
  const name = value.replace(/<color(?:=[^<>\r\n]{1,100})?>|<\/color>/gi, "").trim().replace(/^=[^=\s]{1,32}=\s+/, "").trim();
  if (!name || name.length > 128 || /[<>\x00-\x1f\x7f]/.test(name)) return null;
  return name.toLowerCase();
}

export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "telemetry"; sample: Telemetry | null }
  | { type: "sighting"; sighting: RoomSighting }
  | { type: "kills"; kills: number | null };

export type ServerMessage =
  | { type: "welcome"; selfId: string; members: Member[]; kills?: number | null }
  | { type: "member"; member: Member }
  | { type: "left"; id: string }
  | { type: "sighting"; sighting: RoomSighting }
  | { type: "kills"; kills: number | null };

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// Keep only parsed combat fields. An unsafe optional caller must not discard
// an otherwise usable sighting.
export function roomSighting(value: unknown): RoomSighting | null {
  const s = record(value);
  if (!s) return null;
  const bounded = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 128 && !/[<>\p{C}]/u.test(v);
  if (!bounded(s.player) || !bounded(s.aircraft) ||
      (s.grid !== null && (typeof s.grid !== "string" || !/^[A-Z]{1,2}\d{1,3}$/.test(s.grid))) ||
      (s.altitudeM !== null && (typeof s.altitudeM !== "number" || !Number.isFinite(s.altitudeM) || Math.abs(s.altitudeM) > 100_000))) return null;
  return { player: s.player.trim(), aircraft: s.aircraft.trim(), reporter: bounded(s.reporter) ? s.reporter.trim() : null, grid: s.grid as string | null, altitudeM: s.altitudeM as number | null };
}

export function reading(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000
    ? value
    : null;
}

export function aircraftId(value: unknown): string | null {
  return typeof value === "string" && /^[\w-]{1,100}$/.test(value) ? value : null;
}

export function displayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 32 && !/\p{C}/u.test(name) ? name : null;
}

export function isRoomKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function createRoomKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 2048) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const message = record(value);
  if (message?.type === "join") {
    const name = displayName(message.name);
    return name ? { type: "join", name } : null;
  }
  if (message?.type === "kills") {
    return message.kills === null || (Number.isSafeInteger(message.kills) && (message.kills as number) >= 0 && (message.kills as number) <= 100_000)
      ? { type: "kills", kills: message.kills as number | null } : null;
  }
  if (message?.type === "sighting") {
    const sighting = roomSighting(message.sighting);
    return sighting ? { type: "sighting", sighting } : null;
  }
  if (message?.type !== "telemetry") return null;
  if (message.sample === null) return { type: "telemetry", sample: null };
  const values = record(message.sample);
  if (!values) return null;

  const sample = { aircraft: aircraftId(values.aircraft) } as Telemetry;
  let hasReading = false;
  for (const key of readings) {
    sample[key] = reading(values[key]);
    hasReading ||= sample[key] !== null;
  }
  if (!hasReading) return null;
  return { type: "telemetry", sample };
}
