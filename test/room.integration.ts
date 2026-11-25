import { afterAll, expect, test } from "bun:test";
import { createRoomKey, SOCKET_PROTOCOL } from "../src/shared/protocol.ts";

// Start cf dev first. An explicit Origin exercises the same check as a browser.
const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:5173";
const endpoint = `${origin}/api/squad`;
const sockets: WebSocket[] = [];

function connect(key: string) {
  const socket = new WebSocket(endpoint.replace(/^http/, "ws"), {
    protocols: [SOCKET_PROTOCOL, `room.${key}`], headers: { Origin: origin },
  });
  sockets.push(socket);
  const pending: any[] = [];
  const listeners: ((value: any) => void)[] = [];
  socket.addEventListener("message", e => {
    const message = JSON.parse(String(e.data));
    const listener = listeners.shift();
    if (listener) listener(message); else pending.push(message);
  });
  return {
    socket,
    opened: new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket upgrade failed")), { once: true });
    }),
    next(): Promise<any> {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for room message")), 3000);
        listeners.push(value => { clearTimeout(timer); resolve(value); });
      });
    },
    send(value: unknown) { socket.send(JSON.stringify(value)); },
  };
}

afterAll(() => sockets.forEach(socket => socket.close()));

test("Worker validates routes and upgrade headers", async () => {
  expect((await fetch(`${origin}/api/health`)).status).toBe(200);
  expect((await fetch(`${origin}/api/no-such-route`)).status).toBe(404);
  expect((await fetch(endpoint)).status).toBe(426);
  const headers = { Upgrade: "websocket", Origin: "https://evil.example", "Sec-WebSocket-Protocol": `${SOCKET_PROTOCOL}, room.${createRoomKey()}` };
  expect((await fetch(endpoint, { headers })).status).toBe(403);
  expect((await fetch(endpoint, { headers: { ...headers, Origin: origin, "Sec-WebSocket-Protocol": "bad" } })).status).toBe(400);
});

test("two viewers relay, clear, disconnect and remain isolated", async () => {
  const key = createRoomKey();
  const a = connect(key);
  await a.opened;
  expect(a.socket.protocol).toBe(SOCKET_PROTOCOL);
  a.send({ type: "join", name: "Pilot" });
  const first = await a.next();
  expect(first.type).toBe("welcome");
  expect(first.members).toHaveLength(1);
  const b = connect(key);
  await b.opened;
  b.send({ type: "join", name: "Viewer" });
  const welcome = await b.next();
  expect(welcome.members).toHaveLength(2);
  expect((await a.next()).member.id).toBe(welcome.selfId);
  const otherKey = createRoomKey();
  const c = connect(otherKey);
  await c.opened;
  c.send({ type: "join", name: "Other" });
  expect((await c.next()).members).toHaveLength(1);
  a.send({ type: "telemetry", sample: { iasKph: 321, climbMps: -4.5, enemy: "not relayed" } });
  const update = await b.next();
  expect(update.member.id).toBe(first.selfId);
  expect(update.member.sample.iasKph).toBe(321);
  expect(update.member.sample.climbMps).toBe(-4.5);
  expect(update.member.sample.enemy).toBeUndefined();
  const late = connect(key);
  await late.opened;
  late.send({ type: "join", name: "Late viewer" });
  const lateWelcome = await late.next();
  expect(lateWelcome.members.find((member: { id: string }) => member.id === first.selfId).sample.iasKph).toBe(321);
  expect((await a.next()).member.id).toBe(lateWelcome.selfId);
  expect((await b.next()).member.id).toBe(lateWelcome.selfId);
  a.send({ type: "telemetry", sample: null });
  expect((await b.next()).member.sample).toBeNull();
  expect((await late.next()).member.sample).toBeNull();
  // A joining connection in the other room still sees only its own member.
  const d = connect(otherKey);
  await d.opened;
  d.send({ type: "join", name: "Isolated" });
  expect((await d.next()).members).toHaveLength(2);
  expect((await c.next()).member.name).toBe("Isolated");
  a.socket.close();
  expect(await b.next()).toEqual({ type: "left", id: first.selfId });
});

test("combat relay echoes sanitized calls and deduplicated absolute kill counts", async () => {
  const key = createRoomKey(), a = connect(key), b = connect(key);
  await Promise.all([a.opened, b.opened]);
  a.send({ type: "join", name: "=TAG= Pilot" }); expect((await a.next()).kills).toBeNull();
  b.send({ type: "join", name: "pilot" }); expect((await b.next()).kills).toBeNull(); await a.next();
  const isolated = connect(createRoomKey()); await isolated.opened;
  isolated.send({ type: "join", name: "Isolated" }); expect((await isolated.next()).kills).toBeNull();
  const sighting = { player: "Target", aircraft: "Plane", grid: "D4", altitudeM: 3000, reporter: "Pilot", raw: "secret" };
  a.send({ type: "sighting", sighting });
  for (const peer of [a, b]) {
    const got = await peer.next(); expect(got.type).toBe("sighting");
    expect(got.sighting).toEqual({ player: "Target", aircraft: "Plane", grid: "D4", altitudeM: 3000, reporter: "Pilot" });
  }
  // Ordinary batches are not constrained by the telemetry rate.
  for (let i = 0; i < 8; i++) a.send({ type: "sighting", sighting: { ...sighting, player: `Target${i}` } });
  for (const peer of [a, b]) for (let i = 0; i < 8; i++) expect((await peer.next()).sighting.player).toBe(`Target${i}`);
  a.send({ type: "kills", kills: 2 }); expect((await a.next()).kills).toBe(2); expect((await b.next()).kills).toBe(2);
  // An ordered frame in the other room must not be preceded by combat traffic.
  isolated.send({ type: "kills", kills: 7 });
  expect(await isolated.next()).toEqual({ type: "kills", kills: 7 });
  b.send({ type: "kills", kills: 3 }); expect((await a.next()).kills).toBe(3); expect((await b.next()).kills).toBe(3);
  const late = connect(key); await late.opened; late.send({ type: "join", name: "Wing" });
  expect((await late.next()).kills).toBe(3); await a.next(); await b.next();
  late.send({ type: "kills", kills: 1 });
  for (const peer of [a, b, late]) expect((await peer.next()).kills).toBe(4);
  b.send({ type: "kills", kills: null });
  for (const peer of [a, b, late]) expect((await peer.next()).kills).toBe(3);
  late.socket.close();
  expect((await a.next()).type).toBe("left"); expect((await a.next()).kills).toBe(2);
  expect((await b.next()).type).toBe("left"); expect((await b.next()).kills).toBe(2);
  a.send({ type: "kills", kills: null });
  expect((await a.next()).kills).toBeNull(); expect((await b.next()).kills).toBeNull();
});

test("malformed messages and messages before joining close the connection", async () => {
  const a = connect(createRoomKey());
  await a.opened;
  const closed = new Promise<number>(resolve => a.socket.addEventListener("close", e => resolve(e.code), { once: true }));
  a.send({ type: "telemetry", sample: null });
  expect(await closed).toBe(1008);
  const b = connect(createRoomKey());
  await b.opened;
  const closedB = new Promise<number>(resolve => b.socket.addEventListener("close", e => resolve(e.code), { once: true }));
  b.socket.send("{");
  expect(await closedB).toBe(1008);
});
