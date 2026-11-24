# Wolf Pack

An automatic, browser-only War Thunder aircraft feed and invite-only squad relay.
The Spotter’s Index UI follows the approved readability design snapshot from
`designs/wolfpack-v2`, based on revision
`b2f16417bea55514d5ca9c8a3c315136b0a7a073`.

## Local verification

Requires Bun and a Node version supported by `package.json`. Install with
`bun install --frozen-lockfile`, then:

```sh
bun run check                    # generated Worker types, TypeScript, unit tests
bun run build                    # local build only
bun run test:reference           # disposable workerd D1 fixture; run after build
bun run cf deploy --dry-run      # build and validate; no API request or upload
bun run verify:dashboard         # full dashboard browser fixture suite
```

The dashboard verifier also needs Playwright's local Chromium at
`/usr/bin/chromium`, or `CHROMIUM_PATH` set to a Chromium executable. For a
focused scenario during iteration, use Bun's test-name regex:

```sh
bun run verify:dashboard --test-name-pattern 'responsive live layout'
```

An empty or unmatched pattern fails. The verifier starts its own local Vite
and Worker dev server on an OS-assigned loopback port, waits for health, and
shuts it down afterwards. It overrides `TEST_ORIGIN` and uses ephemeral local
Worker state. The browser fixtures intercept game requests; this command does
not contact the live game or production and does not deploy. Run the full
`bun run verify:dashboard` before integration. To exercise the verifier's
failure, isolation and cleanup paths, run `bun run test:dashboard-runner`.

For manual integration testing, start `bun run dev -- --host 127.0.0.1 --port 5173`,
then run these in a second terminal. Set `TEST_ORIGIN` if the server is not
on the test's default URL:

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
Display units are saved locally; distance is saved but
not used. The squad name is a local label, not the bearer invite or room key.

## Reference speeds and public stats

Vy values are chart IAS targets in km/h, not vertical speeds in m/s. They come
from the existing `wolfpack-reference` D1 `mec_aircraft` data, whose
`mec_workbook.source_url` identifies the [MEC workbook](https://docs.google.com/spreadsheets/d/1rmN88QSthSclf7kxd6-miXjPFZEGmBQ5xMumqixKC6s/edit#gid=1236982432).
The explicit ID-to-row mapping was checked against flightmodel IDs and English
localisation from War-Thunder-Datamine commit `79341db6c04e114bce622659fd37dfbcae310559`;
no fuzzy matching is used. One unverified duplicate LaGG row is intentionally
omitted. The Worker validates all four mapped row identifiers and queries only
reference columns, with no production schema change or writes. The browser
requests its own aircraft ID only, never a squadmate's model; references can be
missing. IAS comparisons use the viewer's aircraft target and each row's
throttle, not that squadmate's actual optimum. A ±2 km/h band is on target;
colour saturates at ±15% and a textual description gives the deviation.

ThunderSkill mode-wide air kills/battle and air K/D are heuristic context,
not percentiles or current-aircraft performance. Battles and deaths can include
ground play; fewer than 20 battles suppress lethality colours. Source dates are
shown without a timezone claim. The source can be private, stale or unavailable.
Battles use an illustrative logarithmic experience scale: 20 is low, 300
typical and 1,500 high. These are not population percentiles.

Lookups strip a recognized `=TAG= ` clan prefix but do not guess a `*`
console identity. They accept bounded nicknames with spaces, Unicode letters and
marks, an explicit `@live` or `@psn` suffix, and `#` followed by digits.
Numeric privacy IDs, generic `Player 1` names, dot segments and unsafe path
characters are rejected. Only an exact normalized nickname is sent.

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
Chat and sighting details stay in the browser's memory, are never sent to the
squad, and are cleared when game reads restart. **Public player lookup is on by
default:** for eligible new named target callouts, the browser sends only the
normalized target nickname to Wolf Pack, which requests that public profile from
ThunderSkill. No chat text, reporter, position, squad or telemetry is sent in
the lookup. Disable it in Settings to stop future requests and clear results;
re-enabling does not backfill. Names are apparent targets, not verified enemies.
The fixed public provider sees the requested nickname and its usual connection
metadata; the same-origin check is not authentication. Provider failures and
private/missing profiles are unavailable, not zero. The rate limiter is per
Cloudflare location and is not a strict global abuse limit.
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
