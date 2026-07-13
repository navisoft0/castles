# Castles

A fast card game in the shed/karma family, playable in the browser — solo
against AI bots or **online with 2–4 friends** via room codes. Build your
castle of face-down and face-up cards, then race to shed every card you hold.

The repo has three parts:

| Path | What it is |
|---|---|
| `web/` | The browser game (itch.io-ready static files) |
| `server/` | The online-play game server (small Node WebSocket service) |
| `Scenes/`, `Scripts/`, `main.tscn` | The original Godot 4.3 prototype this was refactored from |

## How to play

- **Setup** — Each player gets 3 face-down castle cards and 6 in hand; choose 3
  to place face-up on the castle. The other 3 are your starting hand.
- **Play** — Take turns playing one card onto the pile. Cards must be of
  **equal or higher** value than the top card (aces high).
- **Magic cards** — A **2** plays on anything and resets the pile. An **8**
  plays on anything and **burns** the pile out of the game — then you go again.
- **Stuck?** Pick up the whole pile into your hand.
- **Draw** — Refill your hand to 3 after playing, while the deck lasts.
- **The castle** — With hand and deck empty, play your face-up cards, then flip
  your face-down cards blind. A failed flip means you pick everything up!
- **Finish** — Shed everything to claim your place. With 3–4 players the game
  continues until one player is left holding cards.

## Online play

Friends-only rooms with 4-letter codes — no accounts, guest names only.
The server is authoritative: it holds the deck and every hand, validates each
move with the same rules engine the browser uses (`web/engine.js`), and sends
each player only what they're allowed to see, so peeking with dev tools shows
nothing.

Built-in robustness:

- **Reconnect** — refreshing or dropping keeps your seat; "Rejoin last game"
  restores it (60s grace before a bot takes over, and you can reclaim the seat
  from the bot any time after that too).
- **Turn timer** — 60s per turn; an AFK player's turn is auto-played so the
  table never freezes. Setup has a 90s limit.
- **Stalemate rule** — if 200 consecutive actions make no progress (a rare
  forced loop of pickups), the game ends and fewest cards wins.
- **Rematch** — the host can restart the room with the same seats.
- **Quick chat** — four canned phrases, no free text.

## Run it locally

```sh
# the game
cd web && python3 -m http.server 8000

# the server (optional, for online play)
npm install && npm start        # listens on :8902

# open http://localhost:8000 — online play auto-connects to localhost:8902
```

## Deploy the server to Railway

1. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   The root `package.json` makes Railway run `node server/index.js`; Railway
   injects `PORT` automatically. No other config is needed.
2. In the service's **Settings → Networking**, click **Generate Domain**.
   You'll get something like `castles-production.up.railway.app`.
3. Put that URL in `web/config.js` (note the `wss://` scheme):

   ```js
   window.CASTLES_SERVER = 'wss://castles-production.up.railway.app';
   ```

4. Rebuild the itch zip (below) and re-upload it.

Optional server tuning via Railway environment variables: `TURN_MS` (default
60000), `SETUP_MS` (90000), `TAKEOVER_MS` (60000), `ROOM_TTL_MS` (300000).

## Publish to itch.io

A ready-to-upload zip lives at `dist/castles-itch.zip`; rebuild it any time
with:

```sh
./build_itch_zip.sh
```

On itch.io:

1. Create a project → **Kind of project: HTML**.
2. Upload `dist/castles-itch.zip`, check **"This file will be played in the browser"**.
3. Viewport **1280 × 720**; enable **Mobile friendly**, **Fullscreen button**,
   and **Automatically start on page load**. Leave scrollbars and
   SharedArrayBuffer off.

Friends join by opening your itch page and entering the 4-letter room code
(itch.io embeds don't forward links with `?room=` codes, so codes are the way).

## Tech

- Plain HTML/CSS/JS, no build step. The rules live in `web/engine.js`, a pure
  DOM-free module shared verbatim by the browser and the Node server.
- 6,000-game randomized soak test of the engine plus Playwright end-to-end
  tests (2P/4P online, AFK timers, reconnect, rematch) back the rules.
- Card art and sounds are CC0 assets by [Kenney](https://kenney.itch.io)
  (see `web/CREDITS.txt`).
