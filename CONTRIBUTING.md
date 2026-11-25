# Contributing to Wolf Pack

You can run the checks and exercise the dashboard without War Thunder,
Cloudflare credentials, or a real squad invite. Use fixture data for development
and keep real invites, player names, and game data out of test fixtures and logs.

## Run the local checks

Install Bun and a Node.js version supported by [`package.json`](package.json).
The browser tests also need local Chromium: they use `/usr/bin/chromium` by
default, or the executable you set in `CHROMIUM_PATH`.

From the repo root:

```sh
bun install --frozen-lockfile
bun run check
bun run verify:dashboard
```

- `check` generates Worker types, checks both TypeScript projects, and runs the
  unit tests.
- `verify:dashboard` starts a Vite and Worker dev server on a free local port,
  waits for `/api/health`, runs the Playwright browser scenarios, and shuts down
  the server. It ignores an inherited `TEST_ORIGIN` and uses disposable local
  Worker state. Fixtures stand in for the game and external lookups. The suite
  does not contact the live game or production.

To run one browser scenario while iterating:

```sh
bun run verify:dashboard --test-name-pattern 'responsive live layout'
```

The filter is a test-name regex. An empty filter or one that matches nothing
fails. Run the full dashboard suite before integrating dashboard changes.

### Run checks for the area you changed

| Change | Local check |
| --- | --- |
| Worker build or configuration | `bun run build` builds locally. `bun run cf deploy --dry-run` also validates the deployment package without uploading or making a deployment API request. |
| Aircraft reference lookup | Run `bun run build`, then `bun run test:reference` to exercise the built Worker against a disposable D1 database. |
| Squad relay | Start the local server on port 5173 as shown below, then run `bun run test:room` in a second terminal. It uses real local Worker and Durable Object sockets. |
| Dashboard test runner | `bun run test:dashboard-runner` checks isolation, failure handling, and cleanup. |

Do not run `bun run deploy` as a verification step. Deployment and production
provisioning are managed separately.

## Open the dashboard locally

```sh
bun run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open <http://127.0.0.1:5173>. The page immediately tries to read War Thunder on
the same computer. With the game running and browser permission granted, look
for live values under **Instruments**. A plain dev server does not inject
fake game data; use `bun run verify:dashboard` to reproduce gameplay scenarios
without the game.

For a manual squad check, set and save a player name in **Settings**, open
**Squad** in the sidebar, and choose **Create squad**. Copy the local invite and
open it in a second browser profile. Set and save a different name in
**Settings**, open **Join squad** in the sidebar, and select **Join squad**.
Check that both names appear in the squad. The viewer does not need the game,
even though its dashboard will try to read it. Leaving the squad does not stop
game reads. **Reconnect** retries game access and an already-requested squad;
it does not join a new invite or a squad you left.

To run the browser tests against a dev server you started yourself, run
`TEST_ORIGIN=http://127.0.0.1:5173 bun run test:browser` in a second terminal.
Without `TEST_ORIGIN`, that script expects port 5178; `test:room` expects 5173.
For routine browser checks, prefer the self-contained verifier.

## Find the code

| Area | Start here |
| --- | --- |
| Dashboard, settings, and display units | [`index.html`](index.html), [`dashboard.ts`](src/client/dashboard.ts), [`dashboard.css`](src/client/dashboard.css), [`derived.ts`](src/client/derived.ts) |
| Local game reads and parsing | [`telemetry.ts`](src/client/telemetry.ts) polls and normalizes instruments; [`map.ts`](src/client/map.ts) loads map metadata and aircraft contacts; [`chat.ts`](src/client/chat.ts) reads chat and parses supported English radio calls; [`hud.ts`](src/client/hud.ts) observes local HUD kills. |
| Squad invites, messages, and lifecycle | [`squad.ts`](src/client/squad.ts) manages the browser connection; [`protocol.ts`](src/shared/protocol.ts) defines allowed messages; [`index.ts`](src/worker/index.ts) and [`squad-room.ts`](src/worker/squad-room.ts) route and relay them. |
| Climb-speed references and public stats | Client: [`climb-speed.ts`](src/client/climb-speed.ts), [`player-stats.ts`](src/client/player-stats.ts). Worker: [`index.ts`](src/worker/index.ts), [`aircraft-reference.ts`](src/worker/aircraft-reference.ts), [`player-stats.ts`](src/worker/player-stats.ts). |
| Worker and bindings | [`cloudflare.config.ts`](cloudflare.config.ts) configures assets, the custom domain, the SQLite-backed squad Durable Object, the reference database, and the lookup rate limiter. |

The Spotter’s Index layout follows the readability snapshot from
`designs/wolfpack-v2` at `22ee2d0c8eed8e426a157a2e4cef37b7af1b9ca3`.

## Preserve these behaviour and privacy boundaries

### Game data and the browser

- The game connection is read-only and fixed to `127.0.0.1:8111`. It uses
  `/state`, `/indicators`, `/map_info.json`, `/map_obj.json`,
  `/gamechat?lastId=N`, `/hudmsg?lastEvt=0&lastDmg=N`, and `/map.img?gen=N`. It does not request opponent
  endpoints. The map uses an ordinary image element at its native aspect ratio.
  Its overlay shows up to 200 recognized aircraft from the current game map
  feed: ownship, friendly (including green non-player aircraft), and enemy.
  Visibility depends on game mode, so the feed may not contain every enemy.
  Markers are anonymous and not joined to radio sightings, tracked, stored, or
  shared with the squad. Object failures clear markers without clearing a
  healthy map; generation changes and stale or invalid data clear them too.
- The browser must allow loopback access, and the game’s JSON must permit
  cross-origin reads. The image does not need CORS. Browser version and policy
  can affect [Local Network Access](https://developer.chrome.com/blog/local-network-access)
  and HTTPS-to-HTTP requests. If denied, allow access in the site settings, then
  reconnect. Do not forward ports or disable browser protections. The fixtures
  do not prove real game compatibility: test the actual game and intended HTTPS
  origin before claiming support.
- Chat stays in browser memory. The game provides no message timestamps:
  buffered messages are undated and do not create sightings. New supported
  English radio calls create local sightings stamped with their arrival time.
  Joined clients relay only parsed player, aircraft, grid, altitude and
  game-reported caller (not authenticated). No initial history, already-observed
  prejoin sightings, or retry recovery backfill is relayed. Recovery backfill
  may still appear locally, because its freshness cannot be established.
  The room broadcasts without storing history; receivers keep bounded
  reports for 120 seconds. Compatible near-simultaneous calls retain their
  richer altitude for up to eight seconds, not across incompatible reports.
  Show only the reported grid and altitude, not an inferred position. During
  retries, existing chat and sightings are historical. A known map change or
  invalid map clears local and room reports. A chat ID restart clears local
  reports but leaves room reports until expiry, leave, or a known map reset.
  Reconnect clears local reports and switches the room socket.

- The Squad kill count is a bounded, in-memory observation of the HUD `damage`
  lane, never sender chat or a scoreboard. Nonempty sender records are ignored. It counts supported English active and
  passive credited kills with a named attacker and vehicle, matched exactly to
  the joined own name after game colour and `=TAG= ` decoration removal. Game
  platform suffixes remain part of the name. Initial map and reconnect batches
  are baselined, not counted; a retry rebaselines and can miss events. Map
  changes, metadata interruptions (including invalid, unreachable, or stale
  metadata), and reconnect clear the summary. A missing or
  malformed feed is unavailable, not zero. Only the own absolute count or null
  is sent to the room, including counts already observed on the current map
  before joining; raw HUD content is never sent. The room stores counts in
  socket attachments, sums available members and deduplicates matching names by
  maximum. Disconnect and null remove contributions. English strings are informed by War
  Thunder Datamine `menu.csv` NET_UNIT_KILLED_FM/GM and NET_*_KILLED_BY_*
  localization; the [HUD endpoint documentation](https://github.com/lucasvmx/WarThunder-localhost-documentation/blob/master/Hudmsg/Hudmsg.md)
  and [Tailgunner telemetry](https://github.com/TheDR-lul/Tailgunner/blob/main/src-tauri/src/wt_telemetry.rs)
  describe the feed. Actual game and mode compatibility still needs verification.

### Squad sharing and settings

- Squad controls, connection and publishing status, the local squad label, and
  instrument sharing are in the sidebar’s **Squad** popover. Squad preferences
  require **Save squad preferences**; dismissing the popover discards unsaved
  edits. Player name, display units, and public player-stats privacy remain in
  **Settings**.
- **Share flight instruments with squad** defaults on. Publish only allowlisted
  own-aircraft readings while both connections are active. Turning sharing off
  clears the squad’s copy without stopping local instruments or the map. Missing
  or invalid readings are not zero, and a valid game response is not proof of a
  live battle. The UI waits for a fresh update instead of treating an untimed
  welcome snapshot as current.
- Sightings and own kill counts are shared automatically while joined, regardless
  of the instrument toggle. Older servers omit the welcome `kills` capability;
  clients do not send combat messages to them.
- The server assigns connection identities. Invites are random 128-bit bearer
  secrets: anyone with the link can join and use any display name. The key stays
  in the URL fragment, travels in the WebSocket subprotocol header, and is
  stripped before forwarding to the room. The same-origin check is not identity
  verification. Do not log invite headers or fragments, or use Cloudflare
  real-time tail with real invites. The room caps connections and rate-limits
  broadcasts. Current samples live in WebSocket attachments, not a database or
  server-side history.
- Readings and their short browser histories clear when polling stops, readings
  become unavailable, or `SAMPLE_LIFETIME_MS` expires. Bearing has no history.
  Climb angle is an indicated-airspeed estimate; the water/engine temperature
  label covers either sensor source. Squad awards and out-of-action status are
  unavailable. Display units and the squad label stay on the device; the label
  is not the room key. The distance preference is saved but unused.

### Aircraft references and public player stats

- Vy is a target **indicated airspeed** in km/h, not a vertical speed. The browser
  requests references for its own aircraft and fresh shared aircraft IDs; a
  remote row clears with its sample. Live signed climb rate is a separate
  instrument, shared under the existing instrument setting. The Worker reads the
  `mec_aircraft` table in the existing `wolfpack-reference` D1 database and
  validates all four mapped row identifiers. No production writes or schema
  changes are needed. The mapping is exact, checked against flight-model IDs
  and English names from War-Thunder-Datamine commit
  `79341db6c04e114bce622659fd37dfbcae310559`. An unverified duplicate LaGG row is
  omitted. See the [MEC workbook](https://docs.google.com/spreadsheets/d/1rmN88QSthSclf7kxd6-miXjPFZEGmBQ5xMumqixKC6s/edit#gid=1236982432),
  also recorded in `mec_workbook.source_url`.
- Exact aliases resolve the unit's `fmFile` and require identical effective
  flight-model bytes, with wrapper differences limited to cosmetic keys or
  byte-identical default weapons presets; loadout and upgrades were checked.
  D.521 is distinct from D.520 and has no workbook row. For selected unmapped
  aircraft, estimates come from the pinned [datamine](https://github.com/gszabi99/War-Thunder-Datamine/tree/79341db6c04e114bce622659fd37dfbcae310559):
  sea-level `altSpecs.altSpecs0.optSpeed` from the aircraft's performance file,
  converted from m/s to km/h and rounded (D.521: 60.3268 m/s → 217 km/h).
  Candidates had an economy rank and fighter or interceptor tag, but no jet fighter
  tag. Copied performance files were excluded unless their aircraft also had
  identical same-basename flight-model data. Speeds and climb had to be positive
  and finite, optimum speed below performance maximum, and performance maximum
  no greater than the current shop maximum speed. Workbook mappings take priority;
  the checked-in mappings and estimates do not require a runtime network lookup.
  These estimates have no specified throttle setting, are not separate 100% or
  WEP references, and may not apply at altitude.
- Squad IAS colours compare each reading with **the viewer’s aircraft target**,
  using each row’s throttle to choose between the normal and WEP references.
  Above 100% throttle, use WEP when available and the 100% target otherwise;
  at or below 100%, use the 100% target. They do not show each squadmate’s own
  optimum. Within ±2 km/h is on target; colour saturates at ±15%, and text gives
  the deviation.
  When only an estimate is available, the same estimated sea-level target is
  used regardless of throttle, without attributing it to a throttle setting.
- **Look up public player stats** defaults on. For eligible new locally observed named calls,
  Wolf Pack forwards just the normalized target nickname to ThunderSkill, not
  the chat, reporter, position, squad, or flight instruments. These are apparent
  targets, not confirmed enemies. Turning lookups off stops requests and clears
  results; turning them back on does not look up old sightings. Remote-only room
  sightings never trigger automatic lookups. The provider
  sees the requested nickname and normal connection metadata. The same-origin
  check is not authentication, and the rate limit is per Cloudflare location,
  not global.
- Normalize only exact names: strip a recognized `=TAG= ` prefix, preserve
  supported Unicode, spaces, `@live` or `@psn` suffixes, and `#` followed by digits.
  Do not guess console identities or query numeric privacy IDs, generic
  `Player 1` names, dot segments, or unsafe path characters.
- ThunderSkill’s mode-wide air kills per battle and air K/D are context, not
  current-aircraft performance or percentiles. Battles and deaths can include
  ground play. Below 20 battles, suppress lethality colours. The illustrative
  logarithmic experience scale anchors at 20, 300, and 1,500 battles. Source
  dates carry no timezone claim; private, missing, or failed lookups are
  unavailable, not zero.
