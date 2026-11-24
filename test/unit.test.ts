import { describe, expect, test } from "bun:test";
import { normalizeTelemetry, readTelemetry } from "../src/client/telemetry.ts";
import { createRoomKey, isRoomKey, parseClientMessage } from "../src/shared/protocol.ts";
import { inviteKey, inviteUrl } from "../src/client/squad.ts";
import { addHistory, altitude, bearing, climb, climbAngle, defaults, emptyHistories, preferences, speed, temperature } from "../src/client/derived.ts";
import { normalizeChat, parseSighting, stripGameColors } from "../src/client/chat.ts";
import { mapGeneration } from "../src/client/map.ts";

const sampleOwn = { aircraft: "test", iasKph: 286, tasKph: 304, altitudeM: 2450, headingDeg: 74, climbMps: 4.2, throttlePct: 87, waterTempC: 91, oilTempC: 78, propPitch: null, manifoldPressure: null };

describe("dashboard readings and settings", () => {
  test("sharing defaults on and survives validated saved preferences", () => {
    expect(preferences({}).shareInstruments).toBe(true);
    expect(preferences({ shareInstruments: false }).shareInstruments).toBe(false);
    expect(preferences({ shareInstruments: "false" }).shareInstruments).toBe(true);
  });
  test("converts units, preserves missing readings, and validates stored preferences", () => {
    const prefs = preferences({ speed: "mph", altitude: "ft", climb: "ftmin", temp: "f", distance: "nm", player: "  Ace  " });
    expect(prefs.player).toBe("Ace");
    expect(speed(100, prefs)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(62.1371));
    expect(altitude(100, prefs)).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(328.084));
    expect(climb(1, prefs)).toBe("+197");
    expect(temperature(100, prefs)).toBe("212");
    expect(speed(null, prefs)).toBe("—");
    expect(preferences({ speed: "invalid", player: "bad\u0000name", endpoint: "https://elsewhere" })).toEqual(defaults);
  });
  test("derives compass and meaningful IAS-based angle", () => {
    expect(bearing(null)).toBe("—");
    expect(bearing(359)).toBe("359° N");
    expect(bearing(-90)).toBe("270° W");
    expect(bearing(74)).toBe("074° ENE");
    expect(climbAngle(0, 4)).toBeNull();
    expect(climbAngle(null, 4)).toBeNull();
    expect(climbAngle(360, 10)).toBeCloseTo(5.7106, 3);
  });
  test("histories are bounded and break on missing data", () => {
    const history = emptyHistories();
    for (let i = 0; i < 20; i++) addHistory(history, { ...sampleOwn, iasKph: i });
    expect(history.iasKph).toHaveLength(12);
    expect(history.iasKph[0]).toBe(8);
    addHistory(history, { ...sampleOwn, iasKph: null });
    expect(history.iasKph).toEqual([]);
    expect("headingDeg" in history).toBe(false);
  });
});

describe("game map metadata", () => {
  test("accepts numeric generations only and rejects invalid or absent status", () => {
    expect(mapGeneration({ map_generation: "12" })).toBe(12);
    expect(mapGeneration({ valid: true, map_generation: 0 })).toBe(0);
    for (const input of [null, {}, { valid: false, map_generation: 2 }, { valid: "true", map_generation: 1 }, { map_generation: "-1" }, { map_generation: "1?x=y" }, { map_generation: 1.5 }, { map_generation: Infinity }]) {
      expect(mapGeneration(input)).toBeNull();
    }
  });
});

describe("flight data", () => {
  test("normalizes only valid, allowlisted aircraft fields", () => {
    expect(normalizeTelemetry(
      { valid: true, "IAS, km/h": 200, "H, m": 1200, "pitch 1, deg": 23, "manifold pressure 1, atm": 1.2, chat: "secret" },
      { valid: true, army: "air", type: "p_51", compass: -5, enemy: 42 },
    )).toEqual({
      aircraft: "p_51", iasKph: 200, tasKph: null, altitudeM: 1200,
      climbMps: null, headingDeg: 355, throttlePct: null, oilTempC: null,
      waterTempC: null, propPitch: 23, manifoldPressure: 1.2,
    });
  });

  test("handles absent and invalid status, keys, and values", () => {
    expect(normalizeTelemetry(null, null)).toBeNull();
    expect(normalizeTelemetry({ valid: false, "IAS, km/h": 200 }, { valid: false, compass: 2 })).toBeNull();
    expect(normalizeTelemetry({ "IAS, km/h": 2 }, {})).toBeNull();
    expect(normalizeTelemetry({ valid: true, "IAS, km/h": 3 }, { valid: true, army: "tank" })).toBeNull();
    expect(normalizeTelemetry({ valid: true, "Vy, m/s": 4, "IAS, km/h": Infinity }, null)?.climbMps).toBe(4);
    expect(normalizeTelemetry(null, { valid: true, type: "air", compass: "4" })).toBeNull();
  });

  test("reads only both loopback endpoints and rejects HTTP errors", async () => {
    const calls: [string, RequestInit][] = [];
    const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
      calls.push([String(url), options!]);
      return Response.json(String(url).endsWith("/state")
        ? { valid: true, "IAS, km/h": 12 } : { valid: false });
    }) as typeof fetch;
    expect((await readTelemetry(new AbortController().signal, fetcher))?.iasKph).toBe(12);
    expect(calls.map(([url]) => url).sort()).toEqual(["http://127.0.0.1:8111/indicators", "http://127.0.0.1:8111/state"]);
    expect(calls.every(([, options]) => options.credentials === "omit" && options.mode === "cors")).toBe(true);
    await expect(readTelemetry(new AbortController().signal, (async () => new Response("", { status: 503 })) as typeof fetch)).rejects.toThrow("503");
  });
});

describe("protocol", () => {
  test("invite uses a 128-bit key only in the fragment", () => {
    const key = createRoomKey();
    expect(isRoomKey(key)).toBe(true);
    const url = inviteUrl(key, "https://example.com");
    expect(url.pathname + url.search).toBe("/");
    expect(inviteKey(url)).toBe(key);
    expect(inviteKey(new URL("https://example.com/#room=bad"))).toBeNull();
  });
  test("validates names and allowlists samples", () => {
    expect(parseClientMessage('{"type":"join","name":"  Ace  "}')).toEqual({ type: "join", name: "Ace" });
    expect(parseClientMessage('{"type":"join","name":"\\u0000"}')).toBeNull();
    expect(parseClientMessage("x".repeat(2049))).toBeNull();
    expect(parseClientMessage('{"type":"telemetry","sample":{"enemy":2}}')).toBeNull();
    expect(parseClientMessage('{"type":"telemetry","sample":{"iasKph":100,"enemy":2}}')).toEqual({
      type: "telemetry",
      sample: { aircraft: null, iasKph: 100, tasKph: null, altitudeM: null, climbMps: null, headingDeg: null, throttlePct: null, oilTempC: null, waterTempC: null, propPitch: null, manifoldPressure: null },
    });
    expect(parseClientMessage('{"type":"telemetry","sample":null}')).toEqual({ type: "telemetry", sample: null });
  });
});

describe("game chat reports", () => {
  const message = (msg: string, extra = {}) => ({ id: 1, msg, sender: "Scout", channel: "Team", enemy: false, receivedAt: 100, ...extra });
  test("recognizes only documented target callouts and preserves full names", () => {
    for (const prefix of ["I'm attacking", "Assaulting", "Starting combat with", "Engaging with", "Attack", "Destroy", "Eliminate", "Someone, attack"]) {
      expect(parseSighting(message(`${prefix} =V3PER= *BlazingTiger552(F4U)!`))?.player).toBe("=V3PER= *BlazingTiger552");
    }
    expect(parseSighting(message("Engaging with Canniballistic(P-40F)! [D4, alt. 4200 m]"))).toMatchObject({ grid: "D4", altitudeM: 4200, reporter: "Scout" });
    expect(parseSighting(message("Someone, attack Abscon (P-40F)!"))).toMatchObject({ player: "Abscon", grid: null, altitudeM: null });
    expect(parseSighting(message("Attack Ace(Plane (Mk II))! <color=@red>[B4, alt. 2,100 ft]</color>"))).toMatchObject({ aircraft: "Plane (Mk II)", grid: "B4", altitudeM: 640.08 });
    expect(parseSighting(message("Attack Ace(Plane)! [B4, alt. +2 100 m]"))?.altitudeM).toBe(2100);
    expect(parseSighting(message("Attack Ace(Plane)! [B4, alt. -1 000 ft]"))?.altitudeM).toBe(-304.8);
    expect(parseSighting(message("Attack Ace(Plane)! [B4, alt. 12 34 m]"))?.altitudeM).toBeNull();
    expect(parseSighting(message("Attack Ace(Plane)! [B4, alt. rubbish]"))).toMatchObject({ grid: "B4", altitudeM: null });
    expect(parseSighting(message("Attack Ace(Plane)! [B4]"))?.grid).toBe("B4");
    for (const bad of ["Attention to the designated grid square! [F7]", "Someone said Attack Ace(Plane)!", "Attack my target(Plane)!", "Attack Ace(Plane)! trailing", "<script>Attack Ace(Plane)!</script>"]) expect(parseSighting(message(bad))).toBeNull();
    expect(parseSighting(message("Attack Ace(Plane)!", { enemy: true }))).toBeNull();
    expect(parseSighting(message("Attack Ace(Plane)!", { receivedAt: null }))).toBeNull();
  });
  test("bounds, sorts and deduplicates game messages", () => {
    expect(normalizeChat([{ id: 2, msg: "two", mode: "team" }, { id: 1, msg: "one", sender: "Scout", enemy: false }, { id: 2, msg: "duplicate" }, { id: -1, msg: "bad" }, { id: 3, msg: "x".repeat(4097) }])).toMatchObject([{ id: 1, sender: "Scout" }, { id: 2, msg: "two", channel: "team" }]);
    expect(() => normalizeChat({})).toThrow();
    const backlog = normalizeChat(Array.from({ length: 2500 }, (_, i) => ({ id: 2500 - i, msg: `Message ${i}` })));
    expect(backlog).toHaveLength(200);
    expect(backlog[0]?.id).toBe(2301);
    expect(backlog.at(-1)?.id).toBe(2500);
  });
  test("removes game color tags but retains unrelated markup literally", () => {
    expect(stripGameColors('<color=@red>Hello</color> <img src=x onerror=alert(1)>')).toBe('Hello <img src=x onerror=alert(1)>');
  });
});
