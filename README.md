# Wolf Pack

Wolf Pack is a second-screen dashboard for War Thunder pilots. See your airspeed,
altitude, climb rate, and other flight instruments in your browser. You can fly
solo or share your readings with friends in a private squad. There’s nothing to
install and no account to create.

## Get flying

1. Get into an aircraft in War Thunder, then [open Wolf Pack](https://wolfpack.sprks.me/)
   in a browser on the same computer.
2. Approve the browser’s **local network access** request to see your own
   instruments. This lets Wolf Pack read flight data from War Thunder on your
   computer. Wolf Pack reads from the game; it doesn’t control it. Look for live
   numbers under **Instruments**.
3. Want to share with friends? Set your **Player name** in **Settings** and save.
   Open **Squad** in the sidebar, select **Create squad**, then **Copy invite**.
   Send the link privately. Friends open it, set and save their player name in
   **Settings**, then open **Join squad** in the sidebar and select **Join squad**.
   They don’t need to run War Thunder or approve game access just to watch.

If your instruments don’t show up, check that the game is running and that your
browser allows local network access for Wolf Pack, then select **Reconnect**.

## What gets shared?

Your flight instruments are shared by default when you’re connected to both the
game and a squad. To keep them to yourself, open **Squad** in the sidebar, turn
off **Share flight instruments with squad**, and select **Save squad preferences**.

While joined, supported fresh friendly radio calls automatically share only the
parsed target, aircraft, grid, altitude and game-reported caller. Caller names
are not authenticated. Sightings expire in the room view; buffered chat,
already-observed prejoin sightings, and retry recovery backfill are not replayed.
The instrument toggle does not control this sharing.
Raw chat and HUD messages, map and anonymous aircraft positions stay local.

Each member also automatically shares their own observed kill count, not raw HUD
data. The room sums current members, counting duplicate pilot names once by
their highest count. It is not a scoreboard. A count already observed since
connecting to the current map is shared on joining; buffered history,
unsupported messages and events missed during retries are excluded. Map
metadata interruptions can reset a count. A dash means no member has an
available HUD feed. This has not been validated against a live game.
Live climb rates are shared with instruments. Vy 100% and WEP are best-climb
airspeed references looked up for each visible shared aircraft, not climb rates.
Where assigned references are unavailable, a labelled sea-level estimate may
appear instead; it has no specified throttle setting and may not apply at
altitude. IAS colours compare against the viewer's own aircraft.
The map shows current aircraft returned by the game, including friendly and
enemy markers; visibility depends on game mode, so not every enemy is shown.
Markers have no names and are not linked to sightings. Sightings come from some
in-game radio calls; they aren’t live player markers. By default, Wolf Pack sends locally observed target
names from those calls to ThunderSkill for public stats. You can turn off
**Look up public player stats** in **Settings**.

[Contributing to Wolf Pack](CONTRIBUTING.md)
