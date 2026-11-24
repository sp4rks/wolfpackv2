import { DurableObject } from "cloudflare:workers";
import {
  parseClientMessage, SAMPLE_LIFETIME_MS, SOCKET_PROTOCOL,
} from "../shared/protocol.ts";
import type { Member, ServerMessage } from "../shared/protocol.ts";

const MAX_CONNECTIONS = 16;
const MIN_UPDATE_MS = 750;
type Connection = { member: Member; sampledAt: number } | null;

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
      this.send(socket, { type: "welcome", selfId: member.id, members: [...members, member] });
      this.broadcast({ type: "member", member }, socket);
      return;
    }
    if (!connection) return socket.close(1008, "Join first");

    const now = Date.now();
    if (!message.sample && !connection.member.sample) return;
    if (message.sample && now - connection.sampledAt < MIN_UPDATE_MS) return;
    const member = { ...connection.member, sample: message.sample };
    socket.serializeAttachment({ member, sampledAt: message.sample ? now : connection.sampledAt });
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
  }

  private broadcast(message: ServerMessage, sender: WebSocket): void {
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
