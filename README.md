# Wolf Pack

An automatic, browser-only War Thunder aircraft feed and invite-only squad relay.
The Spotter’s Index UI follows the approved readability design snapshot from
`designs/wolfpack-v2`, based on revision
`7e3890382ae5b7a0af7b34e503e43255786f65a6` (snapshot CSS SHA `effa21d8`,
guide SHA `a7856e77`).

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
bun run test:browser             # route-fixture browser test; default port 5178
```

For the browser test, start the dev server with
`bun run dev -- --host 127.0.0.1 --port 5178 --strictPort`, or set
`TEST_ORIGIN`. It uses Playwright and local Chromium (`CHROMIUM_PATH` can
override `/usr/bin/chromium`). Route fixtures intercept every game request;
the test does not use or bind the actual game's port.

Open `http://127.0.0.1:5173`. Every open page starts game reads automatically;
permit loopback access if prompted. Viewers can use the squad without a local
game, though their own game feed will retry. Set a player name in Settings,
create a squad, and copy the invite to a viewer, who must choose to join.
Leaving a squad leaves the local game connection running. The reconnect icon
restarts game reads and reconnects a requested squad; it does not join an
unrequested invite or rejoin after leaving. If loopback permission is denied,
allow it in browser site settings and use reconnect. The endpoint is fixed and
read-only.

## Dashboard

The dashboard reads map metadata locally and displays the game's
map image directly when a valid generation is available. The image keeps its
native aspect ratio. No live player or other object markers are displayed;
awards and out-of-action status are unavailable.
Read-only game chat is local and kept in memory. The game provides no message
timestamps: buffered messages present at connection are shown undated and do
not generate sightings. After connection, supported English target radio
callouts create local reports with the time Wolf Pack received them. Reports
show only supplied grid and altitude, not an exact map position. Other
languages and arbitrary chat are not parsed. On temporary failure, previous
messages and reports remain historical while chat retries. Reports clear on
known map changes, game-reported invalid map, ID restart, or reconnect.
Own-aircraft readings appear when available, even without a squad.
The device-local **Share flight instruments with squad** setting defaults on:
when both game and squad are connected, allowlisted instruments are published.
Turning it off clears the squad's copy without stopping local readings or map.
The map is never sent to the squad. Welcome snapshots have no sample timestamp,
so the UI waits for the next update rather than presenting one as current.
Readings and their bounded recent histories clear on stop, unavailability or
expiry. Bearing has no history. The climb angle is an IAS-derived estimate,
not a true flight-path angle. Water/engine temperature is deliberately labeled
generically: the existing wire field can contain either the state water
temperature or the indicators engine-temperature fallback.

Selecting a sighting shows its reported details; unknown values remain unknown.
Display units and the show-own choice are saved locally; distance is saved but
not used. The squad name is a local label, not the bearer invite or room key.

## Integration seams

- `src/client/telemetry.ts`: `watchTelemetry` starts and stops polling;
  `normalizeTelemetry` converts the two game responses to nullable fields.
  The dashboard starts it on page initialization and restarts it on reconnect.
- `src/client/map.ts` polls only map metadata. The browser
  loads `/map.img?gen=N` in an ordinary image element, without CORS or canvas.
- `src/client/chat.ts` polls the fixed `/gamechat?lastId=N` endpoint and parses
  supported English target callouts locally.
- `src/client/squad.ts`: `inviteKey`, `inviteUrl`, and `connectSquad` provide
  connection status, room events, publication and close. `src/shared/protocol.ts`
  defines messages and the allowlisted telemetry shape.
- `src/client/dashboard.ts`, `derived.ts`, and `index.html`
  implement the presentation, derived units, and interaction
  with the existing transport. The server assigns connection identities;
  the client clears local state on disconnect and expires samples using
  `SAMPLE_LIFETIME_MS`.
- `cloudflare.config.ts` configures the Worker, assets, SQLite-backed
  Hibernating Durable Object and intended custom domain. The domain is
  configuration only; deployment and provisioning are managed separately.

## Privacy and browser limits

Only `/state`, `/indicators`, `/map_info.json`, `/gamechat` and the map image
are requested from `127.0.0.1:8111`; map-object and opponent endpoints are not requested.
Chat and derived sightings stay in the browser's memory, are never sent to the
squad or server, and are cleared when game reads restart.
The normalizer and relay allowlist own-aircraft instrument fields. Missing,
invalid or non-finite values are ignored. Game variants and aircraft expose different fields, and a
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
makes no database writes or server-side history. Short reading histories stay
in browser memory only and are cleared with the current sample.

The browser must permit cross-origin reads and loopback access, and the game's
JSON responses need suitable CORS headers. The image itself does not need CORS.
Local Network Access and HTTPS-to-HTTP
behavior vary by browser, version, permissions and policy; a failed fetch can
also mean the game is unavailable or its response is incompatible. Chromium's
[Local Network Access guidance](https://developer.chrome.com/blog/local-network-access)
describes its permission model. No public port forwarding or exposure is
required or recommended. Test with the actual game and intended HTTPS origin
before relying on the feed.
