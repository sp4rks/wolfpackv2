import { playerStats } from "./player-stats.ts";
import { climbEstimate, climbReference } from "./aircraft-reference.ts";
import { aircraftId, isRoomKey, SOCKET_PATH, SOCKET_PROTOCOL } from "../shared/protocol.ts";
export { SquadRoom } from "./squad-room.ts";

function reply(message: string, status: number): Response {
  return Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function climbSpeed(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return reply("Method not allowed", 405);
  const ids = url.searchParams.getAll("aircraft");
  if (ids.length !== 1 || !aircraftId(ids[0])) return reply("Valid aircraft ID required", 400);
  const reference = climbReference(ids[0]!);
  const result = (normalKph: number | null, wepKph: number | null, seconds: number) => Response.json({ normalKph, wepKph }, { headers: { "Cache-Control": `public, max-age=${seconds}` } });
  if (!reference) {
    const estimatedKph = climbEstimate(ids[0]!);
    if (estimatedKph !== undefined) return Response.json({ normalKph: null, wepKph: null, estimatedKph }, { headers: { "Cache-Control": "public, max-age=3600" } });
    return result(null, null, 300);
  }
  try {
    const row = await env.REFERENCE.prepare("SELECT climb_ias_100_percent_kmh AS normalKph, climb_ias_wep_kmh AS wepKph FROM mec_aircraft WHERE sheet_order = ? AND aircraft_row = ? AND sheet = ? AND aircraft = ? LIMIT 1").bind(...reference).first<{ normalKph: unknown; wepKph: unknown }>();
    const valid = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
    return result(valid(row?.normalKph), valid(row?.wepKph), row ? 3600 : 300);
  } catch { return reply("Reference unavailable", 503); }
}

export default {
  fetch(request, env): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/player-stats") return playerStats(request, env, url);
    if (url.pathname === "/api/climb-speed") return climbSpeed(request, env, url);
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
