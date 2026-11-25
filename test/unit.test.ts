import { describe, expect, test } from "bun:test";
import { normalizeTelemetry, readTelemetry } from "../src/client/telemetry.ts";
import { createRoomKey, isRoomKey, parseClientMessage } from "../src/shared/protocol.ts";
import { inviteKey, inviteUrl } from "../src/client/squad.ts";
import { addHistory, altitude, bearing, climb, climbAngle, defaults, emptyHistories, preferences, speed, temperature } from "../src/client/derived.ts";
import { normalizeChat, parseSighting, stripGameColors } from "../src/client/chat.ts";
import { CONTACT_LIMIT, mapContacts, mapGeneration, watchMap } from "../src/client/map.ts";

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
  test("normalizes aircraft contacts conservatively, including real game colours", () => {
    const aircraft = (data: object) => ({ type: "aircraft", x: .25, y: .75, icon: "Fighter", ...data });
    expect(mapContacts([
      aircraft({ color: "#185AFF", "color[]": [24, 90, 255] }),
      aircraft({ color: "#145CFF" }), aircraft({ "color[]": [36, 217, 33] }),
      aircraft({ color: "#fa3200", "color[]": [250, 50, 0] }),
      aircraft({ icon: "Player", color: "#fa3200" }), aircraft({ icon: "Player", color: "unknown" }),
      aircraft({ color: "#ffff00" }), aircraft({ color: "#185AFF", "color[]": [250, 50, 0] }),
      aircraft({ color: "#185AFF", "color[]": [1, 2] }), aircraft({ color: "#185AFF00" }),
      aircraft({ "color[]": [255, 0, -1] }), aircraft({ color: "#185AFF", x: "0.5" }),
      aircraft({ color: "#185AFF", x: Infinity }), aircraft({ color: "#185AFF", y: NaN }),
      aircraft({ color: "#185AFF", y: -.01 }), aircraft({ color: "#185AFF", x: 1.01 }),
      { type: "ground_model", x: .5, y: .5, color: "#fa3200" },
    ])).toEqual([
      { kind: "friendly", x: .25, y: .75 }, { kind: "friendly", x: .25, y: .75 },
      { kind: "friendly", x: .25, y: .75 }, { kind: "enemy", x: .25, y: .75 },
      { kind: "own", x: .25, y: .75 }, { kind: "own", x: .25, y: .75 },
    ]);
    expect(mapContacts([])).toEqual([]);
    expect(mapContacts({})).toBeNull();
    expect(mapContacts(Array.from({ length: CONTACT_LIMIT + 10 }, () => aircraft({ color: "#fa3200", x: 0, y: 1 })))?.length).toBe(CONTACT_LIMIT);
  });
  test("map reads are bounded, sequential, and never dispatch after abort", async () => {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; options: RequestInit & { targetAddressSpace?: string } }> = [];
    let release: ((value: Response) => void) | undefined;
    try {
      globalThis.fetch = ((url: string | URL | Request, options: RequestInit) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith("/map_obj.json")) return new Promise<Response>(resolve => { release = resolve; });
        return Promise.resolve(Response.json({ map_generation: 7 }));
      }) as typeof fetch;
      const updates: string[] = [];
      const stop = watchMap(update => updates.push(update.status), update => updates.push(update.status));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(calls.map(c => c.url)).toEqual(["http://127.0.0.1:8111/map_info.json", "http://127.0.0.1:8111/map_obj.json"]);
      expect(calls.every(({ options }) => options.mode === "cors" && options.credentials === "omit" && options.cache === "no-store" && options.redirect === "error" && options.targetAddressSpace === "loopback" && options.signal)).toBe(true);
      expect(updates).toEqual(["ready"]);
      stop();
      release!(Response.json([]));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(updates).toEqual(["ready"]);
      expect(calls).toHaveLength(2);
    } finally { globalThis.fetch = original; }
  });
  test("map metadata recheck preserves invalid, waiting and unreachable outcomes", async () => {
    const original = globalThis.fetch;
    try {
      for (const [response, expected] of [[{ valid: false }, "invalid"], [{}, "waiting"], [null, "unreachable"]] as const) {
        const calls: string[] = [], updates: string[] = [];
        let notify: (() => void) | undefined;
        const done = new Promise<void>(resolve => { notify = resolve; });
        globalThis.fetch = ((url: string | URL | Request) => {
          const path = new URL(String(url)).pathname;
          calls.push(path);
          if (calls.length === 3 && response === null) return Promise.reject(new Error("offline"));
          return Promise.resolve(Response.json(path === "/map_obj.json" ? [] : calls.length === 1 ? { map_generation: 4 } : response));
        }) as typeof fetch;
        const stop = watchMap(update => { updates.push(update.status); if (updates.length === 2) notify!(); }, () => updates.push("contacts"));
        await done;
        stop();
        expect(calls).toEqual(["/map_info.json", "/map_obj.json", "/map_info.json"]);
        expect(updates).toEqual(["ready", expected]);
      }
    } finally { globalThis.fetch = original; }
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

test("Vy comparison and compass fallback are truthful", async () => {
  const { iasComparison } = await import("../src/client/climb-speed.ts");
  expect(iasComparison(230, 100, { normalKph: 230, wepKph: 240 })?.description).toContain("100%");
  expect(iasComparison(240, 101, { normalKph: 230, wepKph: 240 })?.description).toContain("WEP");
  expect(iasComparison(240, 101, { normalKph: 230, wepKph: null })?.description).toContain("WEP reference unavailable");
  expect(iasComparison(null, 100, { normalKph: 230, wepKph: 240 })).toBeNull();
  expect(iasComparison(230, 100, { normalKph: null, wepKph: 240 })).toBeNull();
  expect(normalizeTelemetry({ valid: true, "IAS, km/h": 1 }, { valid: true, compass1: 0 })?.headingDeg).toBe(0);
  expect(normalizeTelemetry({ valid: true, "IAS, km/h": 1 }, { valid: true, compass1: -90 })?.headingDeg).toBe(270);
});

test("public profile normalization and heuristic metrics", async () => {
  const { nickname, publicStats } = await import("../src/shared/player-stats.ts");
  const { statColour, experienceColour } = await import("../src/client/player-stats.ts");
  expect(preferences({}).playerStats).toBe(true);
  expect(preferences({ playerStats: false }).playerStats).toBe(false);
  expect(nickname("=TAG= Ace_1")).toBe("Ace_1");
  for (const name of ["*Ace", ".", "..", "123456", "Player123", "Player 1", "Player_1", "Player-1", "Player.1", "=TAG= Player 1", "../Ace", "Ace/name", "Ace@unknown", "Ace#x"]) expect(nickname(name)).toBeNull();
  for (const name of ["Ace Pilot", "Éclair", "A\u0301ce", "Ace@live", "Ace@psn", "Ace#123", "Ace@live#123", "Ace#123@psn"]) expect(nickname(name)).toBe(name);
  const payload = { stats: { nick: "Ace_1", last_stat: "2026-11-20 12:30:00", a: { mission: 10, kb_pvp_air: 1.2, kd_pvp_air: null }, r: { mission: 20, kb_pvp_air: 2, kd_pvp_air: 3 }, s: { mission: 0 } } };
  expect(publicStats(payload, "ace_1")).toEqual({ updated: "2026-11-20", modes: [{ mode: "a", battles: 10, killsPerBattle: 1.2, airKd: null }, { mode: "r", battles: 20, killsPerBattle: 2, airKd: 3 }] });
  expect(publicStats(payload, "Other")).toBeNull();
  expect(statColour(2, "kills", 19)).toBeNull(); expect(statColour(null, "kd", 50)).toBeNull();
  expect(statColour(0, "kills", 20)?.label).toBe("low"); expect(statColour(1, "kills", 20)?.label).toBe("typical"); expect(statColour(2, "kills", 20)?.label).toBe("high");
  expect(experienceColour(20)).toEqual({ color: "rgb(155, 38, 36)", label: "low" });
  expect(experienceColour(300)).toEqual({ color: "rgb(35, 100, 58)", label: "typical" });
  expect(experienceColour(1500)).toEqual({ color: "rgb(103, 43, 139)", label: "high" });
  expect(experienceColour(0)).toBeNull();
});

test("player stats endpoint forwards only a bounded nickname and honors provider privacy", async () => {
  const { playerStats } = await import("../src/worker/player-stats.ts");
  const originalFetch = globalThis.fetch;
  const seen: { url: string; init?: RequestInit }[] = [];
  let status = 200, noMissions = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return Response.json({ stats: { nick: "Ace_1", last_stat: "2026-11-20 00:00:00", a: { mission: noMissions ? 0 : 22, kb_pvp_air: 1, kd_pvp_air: 2 }, r: { mission: 0 }, s: { mission: 0 }, secret: "not returned" } }, { status, headers: status === 302 ? { Location: "https://untrusted.example/collect" } : {} });
  }) as typeof fetch;
  const env = { PLAYER_STATS_LIMIT: { limit: async () => ({ success: true }) } } as any;
  const url = new URL("https://example.test/api/player-stats");
  const request = (body: string, origin = url.origin) => new Request(url, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
  try {
    expect((await playerStats(request('{"nickname":"Ace_1","position":"D4"}'), env, url)).status).toBe(400);
    expect((await playerStats(request('{"nickname":"Ace_1"}', "https://other.test"), env, url)).status).toBe(403);
    expect((await playerStats(request('{"nickname":"' + "a".repeat(600) + '"}'), env, url)).status).toBe(400);
    const response = await playerStats(request('{"nickname":"Ace_1"}'), env, url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: "2026-11-20", modes: [{ mode: "a", battles: 22, killsPerBattle: 1, airKd: 2 }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://www.thunderskill.com/en/stat/Ace_1/export/json");
    expect(seen[0]!.init?.headers).toBeUndefined(); expect(seen[0]!.init?.body).toBeUndefined();
    expect(seen[0]!.init?.redirect).toBe("manual");
    expect((await playerStats(request('{"nickname":".."}'), env, url)).status).toBe(400);
    expect((await playerStats(request('{"nickname":"Player 1"}'), env, url)).status).toBe(400);
    // A returned mismatched nickname stays unavailable, but the outbound path is safely encoded.
    expect((await playerStats(request('{"nickname":"Ace Pilot@live#123"}'), env, url)).status).toBe(503);
    expect(seen.at(-1)?.url).toBe("https://www.thunderskill.com/en/stat/Ace%20Pilot%40live%23123/export/json");
    noMissions = true;
    expect(await (await playerStats(request('{"nickname":"Ace_1"}'), env, url)).json()).toEqual({ updated: "2026-11-20", modes: [] });
    status = 403; expect((await playerStats(request('{"nickname":"Ace_1"}'), env, url)).status).toBe(503);
    status = 404; expect((await playerStats(request('{"nickname":"Ace_1"}'), env, url)).status).toBe(503);
    status = 302;
    const beforeRedirect = seen.length;
    expect((await playerStats(request('{"nickname":"Ace_1"}'), env, url)).status).toBe(503);
    expect(seen).toHaveLength(beforeRedirect + 1);
    expect(seen.at(-1)?.init?.redirect).toBe("manual");
    const limited = { PLAYER_STATS_LIMIT: { limit: async () => ({ success: false }) } } as any;
    expect((await playerStats(request('{"nickname":"Ace_1"}'), limited, url)).status).toBe(429);
  } finally { globalThis.fetch = originalFetch; }
});

describe("local HUD kill feed", () => {
  test("credits exact named active and passive killers only", async () => {
    const { killAttacker, killIdentity } = await import("../src/client/hud.ts");
    expect(killAttacker("<color=red>=CLAN= Pilot@live (Spitfire Mk (IX))</color> shot down Target (Bf 109)")).toBe("pilot@live");
    expect(killAttacker("Pilot (Plane) destroyed Target")).toBe("pilot");
    expect(killAttacker("Victim (Plane) shot down by =TAG= Pilot@psn (F-16).")).toBe("pilot@psn");
    expect(killAttacker("Victim (Plane) shot down  by Pilot (F-16)")).toBe("pilot");
    expect(killAttacker("Pilot (Plane) destroyed  Target")).toBe("pilot");
    expect(killAttacker("Pilot (Plane) shot down  by AI")).toBeNull();
    expect(killAttacker("Pilot (Plane) destroyed  by AI")).toBeNull();
    expect(killAttacker("Victim (Tank) has been destroyed by Pilot (Tank)")).toBe("pilot");
    expect(killAttacker("Victim (Plane) destroyed by Pilot (Plane)")).toBe("pilot");
    for (const msg of ["Pilot (Plane) shot down by AI", "Pilot (Plane) set afire Target (Plane)", "Pilot (Plane) assisted Target", "Pilot (Plane) has crashed.", "Pilot (Plane) destroyed Target (teamkill)", "Pilot destroyed Target"]) expect(killAttacker(msg)).toBeNull();
    expect(killIdentity("=TAG= PiLoT@live")).toBe("pilot@live");
    expect(killIdentity("Pilot@live")).not.toBe(killIdentity("Pilot"));
  });
  test("validates response and sorts/deduplicates unsorted IDs", async () => {
    const { hudDamage } = await import("../src/client/hud.ts");
    expect(() => hudDamage([])).toThrow();
    expect(() => hudDamage({ damage: [] })).toThrow();
    expect(hudDamage({ events: [], damage: [
      { id: 4, msg: "Wing (Plane) destroyed Other" },
      { id: 2, msg: "Pilot (Plane) destroyed Target" },
      { id: 4, msg: "Pilot (Plane) destroyed Other" },
      { id: 3, msg: "Pilot (Plane) destroyed Other", enemy: true },
      { id: 5, msg: 2 }, { id: 6, msg: "Pilot (Plane) destroyed Target", sender: "spoof" }, { id: -1, msg: "x" },
    ] })).toEqual([{ id: 2, attacker: "pilot" }, { id: 3, attacker: null }, { id: 4, attacker: "wing" }, { id: 5, attacker: null }, { id: 6, attacker: null }]);
  });
});
