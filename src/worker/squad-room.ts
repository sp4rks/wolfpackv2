import { DurableObject } from "cloudflare:workers";
import {
  killIdentity, parseClientMessage, SAMPLE_LIFETIME_MS, SOCKET_PROTOCOL,
} from "../shared/protocol.ts";
import type { Member, ServerMessage } from "../shared/protocol.ts";

const MAX_CONNECTIONS = 16;
const MIN_UPDATE_MS = 750;
type Bucket = { tokens: number; at: number };
type Connection = { member: Member; sampledAt: number; kills?: number | null; sightings?: Bucket; killRate?: Bucket } | null;

function take(bucket: Bucket | undefined, now: number, capacity: number, perSecond: number): Bucket | null {
  const tokens = Math.min(capacity, (bucket?.tokens ?? capacity) + (bucket ? Math.max(0, now - bucket.at) * perSecond / 1000 : 0));
  return tokens < 1 ? null : { tokens: tokens - 1, at: now };
}

export class SquadRoom extends DurableObject<Env> {
  override fetch(): Response {
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
      return new Response("Squad room is full", { status: 503 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL },
    });
  }

  override webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): void {
    const message = typeof raw === "string" ? parseClientMessage(raw) : null;
    if (!message) return socket.close(1008, "Invalid message");

    const connection = this.connection(socket);
    if (message.type === "join") {
      if (connection) return socket.close(1008, "Already joined");
      const member = { id: crypto.randomUUID(), name: message.name, sample: null };
      const members = this.ctx.getWebSockets().flatMap(peer => {
        const state = this.connection(peer);
        if (!state || peer.readyState !== WebSocket.OPEN) return [];
        return [{
          ...state.member,
          sample: Date.now() - state.sampledAt < SAMPLE_LIFETIME_MS ? state.member.sample : null,
        }];
      });
      socket.serializeAttachment({ member, sampledAt: 0 });
      this.send(socket, { type: "welcome", selfId: member.id, members: [...members, member], kills: this.totalKills() });
      this.broadcast({ type: "member", member }, socket);
      return;
    }
    if (!connection) return socket.close(1008, "Join first");

    const now = Date.now();
    if (message.type === "sighting") {
      const sightings = take(connection.sightings, now, 24, 8);
      if (!sightings) return;
      socket.serializeAttachment({ ...connection, sightings });
      this.broadcast({ type: "sighting", sighting: message.sighting });
      return;
    }
    if (message.type === "kills") {
      if ((connection.kills ?? null) === message.kills) return;
      // Clears and resets to zero cannot be lost. Other changes consume tokens;
      // repeatedly dropping through null cannot bypass the burst limit.
      const reset = message.kills === null || (message.kills === 0 && connection.kills != null && connection.kills > 0);
      const killRate = reset ? connection.killRate : take(connection.killRate, now, 16, 4);
      if (!reset && !killRate) return;
      socket.serializeAttachment({ ...connection, kills: message.kills, killRate });
      this.broadcast({ type: "kills", kills: this.totalKills() });
      return;
    }
    if (!message.sample && !connection.member.sample) return;
    if (message.sample && now - connection.sampledAt < MIN_UPDATE_MS) return;
    const member = { ...connection.member, sample: message.sample };
    socket.serializeAttachment({ ...connection, member, sampledAt: message.sample ? now : connection.sampledAt });
    this.broadcast({ type: "member", member }, socket);
  }

  override webSocketClose(socket: WebSocket): void {
    // This compatibility date enables automatic Close frame replies.
    this.remove(socket);
  }

  override webSocketError(socket: WebSocket): void {
    this.remove(socket);
  }

  private connection(socket: WebSocket): Connection {
    return socket.deserializeAttachment() as Connection;
  }

  private remove(socket: WebSocket): void {
    const state = this.connection(socket);
    if (!state) return;
    socket.serializeAttachment(null);
    this.broadcast({ type: "left", id: state.member.id }, socket);
    this.broadcast({ type: "kills", kills: this.totalKills() }, socket);
  }

  private totalKills(): number | null {
    const counts = new Map<string, number>();
    for (const socket of this.ctx.getWebSockets()) {
      const state = this.connection(socket);
      if (!state || socket.readyState !== WebSocket.OPEN || state.kills == null) continue;
      const name = killIdentity(state.member.name);
      if (name) counts.set(name, Math.max(counts.get(name) ?? 0, state.kills));
    }
    return counts.size ? [...counts.values()].reduce((sum, n) => sum + n, 0) : null;
  }

  private broadcast(message: ServerMessage, sender?: WebSocket): void {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== sender && this.connection(peer)) this.send(peer, message);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // One failed connection must not interrupt delivery to other squadmates.
      socket.close(1011, "Delivery failed");
    }
  }
}
