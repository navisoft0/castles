# Castles — Jake's Way

A fast, single-player card game in the shed/karma family, playable right in the
browser. Build your castle of face-down and face-up cards, then race an AI
opponent to shed every card you hold.

**The web game lives in [`web/`](web/) and is ready to publish on itch.io.**
The original Godot 4.3 prototype (scenes and scripts this game was refactored
from) remains in `Scenes/`, `Scripts/`, and `main.tscn`.

## How to play

- **Setup** — You're dealt 9 cards. Pick 3 *blind* as your face-down castle,
  then look at the rest and place 3 face-up on top of them. The last 3 are
  your starting hand.
- **Play** — Take turns playing one card onto the pile. Cards must be of
  **equal or higher** value than the top card (aces high).
- **Magic cards** — A **2** plays on anything and resets the pile. An **8**
  plays on anything and **burns** the pile out of the game — then you go again.
- **Stuck?** Pick up the whole pile into your hand.
- **Draw** — Refill your hand to 3 after playing, while the deck lasts.
- **The castle** — With hand and deck empty, play your face-up cards, then
  flip your face-down cards blind. A failed flip means you pick everything up!
- **Win** — First player with no cards left wins.

## Run it locally

Any static file server works:

```sh
cd web
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly with `file://` won't load the assets in most
browsers — use a server.)

## Publish to itch.io

A ready-to-upload zip is included at [`dist/castles-itch.zip`](dist/), or
rebuild it with:

```sh
./build_itch_zip.sh
```

Then on itch.io:

1. Create a new project → set **Kind of project** to **HTML**.
2. Upload `dist/castles-itch.zip` and check **"This file will be played in the browser"**.
3. Set **Viewport dimensions** to **1280 × 720** (the game scales itself to any
   embed size, so smaller viewports like 960 × 540 also work).
4. Optionally enable the fullscreen button and mobile-friendly flags — the game
   supports touch input.

## Tech

- Plain HTML/CSS/JS — no build step, no dependencies, fully self-contained
  (itch.io-friendly: no external network requests).
- Card art and sounds are CC0 assets by [Kenney](https://kenney.itch.io)
  (see `web/CREDITS.txt`).
