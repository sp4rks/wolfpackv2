import { nickname, publicStats } from "../shared/player-stats.ts";

async function boundedText(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!stream) throw new Error("Missing body");
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > max) { await reader.cancel(); throw new Error("Too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return new TextDecoder().decode(bytes);
}
const reply = (message: string, status: number) => Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
export async function playerStats(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return reply("Method not allowed", 405);
  if (request.headers.get("Origin") !== url.origin) return reply("Origin not allowed", 403);
  let name: string;
  try {
    const body: unknown = JSON.parse(await boundedText(request.body, 512));
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { nickname?: unknown }).nickname !== "string") return reply("Nickname required", 400);
    name = (body as { nickname: string }).nickname;
    if (nickname(name) !== name) return reply("Invalid nickname", 400);
  } catch { return reply("Invalid request", 400); }
  try {
    const limit = await env.PLAYER_STATS_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") ?? "local" });
    if (!limit.success) return reply("Lookup rate limited", 429);
    // Workers accepts "manual", not "error"; reject every redirect below.
    const response = await fetch(`https://www.thunderskill.com/en/stat/${encodeURIComponent(name)}/export/json`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return reply("Public stats unavailable", 503);
    const parsed = publicStats(JSON.parse(await boundedText(response.body, 256_000)), name);
    if (!parsed) return reply("Public stats unavailable", 503);
    return Response.json(parsed, { headers: { "Cache-Control": "no-store" } });
  } catch { return reply("Public stats unavailable", 503); }
}
