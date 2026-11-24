import { isRoomKey, SOCKET_PATH, SOCKET_PROTOCOL } from "../shared/protocol.ts";
export { SquadRoom } from "./squad-room.ts";

function reply(message: string, status: number): Response {
  return Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
  fetch(request, env): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") return reply("ok", 200);
    if (url.pathname !== SOCKET_PATH) return reply("Not found", 404);
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return reply("WebSocket upgrade required", 426);
    }
    if (request.headers.get("Origin") !== url.origin) return reply("Origin not allowed", 403);

    // Keep the invite out of URLs and strip it before forwarding to the room.
    const offered = request.headers.get("Sec-WebSocket-Protocol")?.split(",").map(p => p.trim());
    const roomKey = offered?.[1]?.slice("room.".length);
    if (offered?.length !== 2 || offered[0] !== SOCKET_PROTOCOL ||
        !offered[1]?.startsWith("room.") || !isRoomKey(roomKey)) {
      return reply("Valid squad invite required", 400);
    }

    return env.SQUADS.getByName(roomKey).fetch(new URL(SOCKET_PATH, url.origin).href, {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": SOCKET_PROTOCOL },
    });
  },
} satisfies ExportedHandler<Env>;
