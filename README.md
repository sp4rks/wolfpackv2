# WolfPack foundation

Minimal diagnostics for an opt-in, browser-only War Thunder aircraft feed and
an invite-only live squad relay. This is not the final UI.

## Local verification

Requires Bun and a Node version supported by `package.json`. Install with
`bun install --frozen-lockfile`, then:

```sh
bun run check                    # generated Worker types, TypeScript, unit tests
bun run build                    # local build only
bun run cf deploy --dry-run      # build and validate; no API request or upload
bun run dev -- --host 127.0.0.1 --port 5173
```

In a second terminal, while the dev server runs:

```sh
bun run test:room                # real local Worker and Durable Object sockets
```

Open `http://127.0.0.1:5173`, enter a name, create a squad, and copy the
invite link to another browser tab or device that can reach that server.
Join as a viewer; neither participant polls the game on joining. On the
game computer, press **Share game instruments** and permit loopback access if
prompted. Stop sharing or leave to clear the live sample. The other participant
does not need War Thunder. Localhost testing alone does not prove that a
public HTTPS site can access the game on every browser.

## Integration seams

- `src/client/telemetry.ts`: `watchTelemetry` starts and stops polling;
  `normalizeTelemetry` converts the two game responses to nullable fields.
  Call `watchTelemetry` only from an explicit sharing gesture.
- `src/client/squad.ts`: `inviteKey`, `inviteUrl`, and `connectSquad` provide
  connection status, room events, publication and close. `src/shared/protocol.ts`
  defines messages and the allowlisted telemetry shape.
- `src/client/diagnostics.ts` and `index.html` show a minimal end-to-end
  integration. The server assigns connection identities; clients should clear
  local state on disconnect and expire samples using `SAMPLE_LIFETIME_MS`.
- `cloudflare.config.ts` configures the Worker, assets, SQLite-backed
  Hibernating Durable Object and intended custom domain. The domain is
  configuration only; this project has not provisioned or deployed anything.

## Privacy and browser limits

Only `/state` and `/indicators` are requested from `127.0.0.1:8111`. The
normalizer and relay allowlist own-aircraft instrument fields; they do not
request map, chat, or opponent endpoints. Missing, invalid or non-finite values
are ignored. Game variants and aircraft expose different fields, and a
`valid` response is not proof that a player is in a battle.

The invite is a random 128-bit bearer secret in the URL fragment; anyone with
it can join and impersonate a display name. Share it privately. It is passed in
the WebSocket subprotocol header, not the request URL, and stripped before
forwarding to the Durable Object. The Worker does not log the key or telemetry;
Cloudflare real-time tail output can include request headers, so do not use it
with real invites. Avoid infrastructure/proxy header logging, browser extensions
or other tooling that could capture the header or fragment. The origin check
protects against cross-origin browser pages, not a non-browser client holding
the invite. The room caps connections and rate-limits sample broadcasts.
Samples live in WebSocket attachments for connected members; the application
makes no database writes and retains no history. Browsers clear stale displays.

The browser must permit cross-origin reads and loopback access, and the game
must return suitable CORS headers. Local Network Access and HTTPS-to-HTTP
behavior vary by browser, version, permissions and policy; a failed fetch can
also mean the game is unavailable or its response is incompatible. Chromium's
[Local Network Access guidance](https://developer.chrome.com/blog/local-network-access)
describes its permission model. No public port forwarding or exposure is
required or recommended. Test with the actual game and intended HTTPS origin
before relying on the feed.
