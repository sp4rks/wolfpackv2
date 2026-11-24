# Wolf Pack

An opt-in, browser-only War Thunder aircraft feed and invite-only squad relay.
The Spotter’s Index UI follows the approved design reference at
`designs/wolfpack-v2`, revision `7e3890382ae5b7a0af7b34e503e43255786f65a6`.

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

Open `http://127.0.0.1:5173`, set a player name in Settings, create a squad, and copy the
invite link to another browser tab or device that can reach that server.
Join as a viewer; neither participant polls the game on joining. On the
game computer, press **Share game instruments** and permit loopback access if
prompted. Stop sharing or leave to clear the live sample. The other participant
does not need War Thunder. Localhost testing alone does not prove that a
public HTTPS site can access the game on every browser. Settings save does not
connect to the game. The endpoint is fixed and read-only.

## Real and sample views

Real view is the default. Its coastal chart is illustrative, not a game map;
live positions, sightings, chat, awards and out-of-action status are not
available. Real own-aircraft readings appear only after joining a squad and
explicitly choosing Share. Squad members see only the allowlisted instruments
another member chooses to share. Welcome snapshots have no sample timestamp,
so the UI waits for the next update rather than presenting one as current.
Readings and their bounded recent histories clear on stop, unavailability or
expiry. Bearing has no history. The climb angle is an IAS-derived estimate,
not a true flight-path angle. Water/engine temperature is deliberately labeled
generically: the existing wire field can contain either the state water
temperature or the indicators engine-temperature fallback.

**Explore sample view** explicitly disconnects and stops sharing. Everything in
that view, including ownship and squad markers, reports, chat, awards and
out-of-action state, is fictional. It makes no game reads or telemetry sends.
Returning to real view leaves the connection and sharing off. The selected
sighting is linked to its map marker and report; unknown values remain unknown.
Display units and the show-own choice are saved locally; distance is saved but
not used. The squad name is a local label, not the bearer invite or room key.

## Integration seams

- `src/client/telemetry.ts`: `watchTelemetry` starts and stops polling;
  `normalizeTelemetry` converts the two game responses to nullable fields.
  Call `watchTelemetry` only from an explicit sharing gesture.
- `src/client/squad.ts`: `inviteKey`, `inviteUrl`, and `connectSquad` provide
  connection status, room events, publication and close. `src/shared/protocol.ts`
  defines messages and the allowlisted telemetry shape.
- `src/client/dashboard.ts`, `derived.ts`, `sample.ts`, and `index.html`
  implement the presentation, derived units, fictional data, and interaction
  with the existing transport. The server assigns connection identities;
  the client clears local state on disconnect and expires samples using
  `SAMPLE_LIFETIME_MS`.
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
makes no database writes or server-side history. Short reading histories stay
in browser memory only and are cleared with the current sample.

The browser must permit cross-origin reads and loopback access, and the game
must return suitable CORS headers. Local Network Access and HTTPS-to-HTTP
behavior vary by browser, version, permissions and policy; a failed fetch can
also mean the game is unavailable or its response is incompatible. Chromium's
[Local Network Access guidance](https://developer.chrome.com/blog/local-network-access)
describes its permission model. No public port forwarding or exposure is
required or recommended. Test with the actual game and intended HTTPS origin
before relying on the feed.
