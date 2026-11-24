import { displayName, isRoomKey, SOCKET_PATH, SOCKET_PROTOCOL } from "../shared/protocol.ts";
import type { ClientMessage, ServerMessage, Telemetry } from "../shared/protocol.ts";

export type SquadStatus = "connecting" | "joined" | "disconnected";

export function inviteKey(url = new URL(location.href)): string | null {
  const key = new URLSearchParams(url.hash.slice(1)).get("room");
  return isRoomKey(key) ? key : null;
}

export function inviteUrl(roomKey: string, origin = location.origin): URL {
  if (!isRoomKey(roomKey)) throw new Error("Invalid squad invite");
  const url = new URL("/", origin);
  url.hash = `room=${roomKey}`;
  return url;
}

export function connectSquad(options: {
  roomKey: string;
  name: string;
  onStatus: (status: SquadStatus) => void;
  onMessage: (message: ServerMessage) => void;
}) {
  const name = displayName(options.name);
  if (!name || !isRoomKey(options.roomKey)) throw new Error("Invalid squad invite or name");

  const url = new URL(SOCKET_PATH, location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, [SOCKET_PROTOCOL, `room.${options.roomKey}`]);
  let joined = false;
  options.onStatus("connecting");

  function send(message: ClientMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    // A congested connection cannot guarantee delivery of a clear. Disconnect
    // instead, so the room removes this member and their last sample.
    if (socket.bufferedAmount >= 8192) return socket.close(1000, "Connection congested");
    socket.send(JSON.stringify(message));
  }

  socket.addEventListener("open", () => send({ type: "join", name }));
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as ServerMessage;
    if (message.type === "welcome") {
      joined = true;
      options.onStatus("joined");
    }
    options.onMessage(message);
  });
  socket.addEventListener("close", () => {
    joined = false;
    options.onStatus("disconnected");
  });
  return {
    publish(sample: Telemetry | null) {
      if (joined) send({ type: "telemetry", sample });
    },
    close() {
      joined = false;
      socket.close();
    },
  };
}
