'use strict';
/* Castles rules engine — pure logic, no DOM, no network.
 * Runs in the browser (practice mode) and in Node (authoritative server).
 *
 * Cards are integers 0..51: suit = id/13 | 0  (0 hearts, 1 diamonds, 2 clubs, 3 spades),
 * value = id % 13 + 2  (2..14, ace high).
 *
 * Rules: equal-or-higher beats the pile; 2 plays on anything and resets;
 * 8 plays on anything, burns the pile, and the player goes again.
 * Stuck players pick up the pile. Draw to 3 from the deck after hand plays.
 * Castle: 3 face-down cards (dealt blind) with 3 chosen face-up cards on top,
 * played once hand and deck are empty; face-down cards are flipped blind.
 * Players who shed everything finish with a placement; last one holding wins nothing.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CastlesEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const suitOf = (id) => (id / 13) | 0;
  const valueOf = (id) => (id % 13) + 2;

  function createGame(n, rng = Math.random) {
    if (!(n >= 2 && n <= 4)) throw new Error('players must be 2-4');
    const deck = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const players = [];
    for (let p = 0; p < n; p++) {
      players.push({
        hand: [],
        up: [null, null, null],
        down: [deck.pop(), deck.pop(), deck.pop()],
        place: 0,          // 0 = still playing, 1..n = finishing order
        setupDone: false,
      });
    }
    for (let i = 0; i < 6; i++) for (let p = 0; p < n; p++) players[p].hand.push(deck.pop());
    return {
      n, players, deck,
      pile: [], burned: [],
      phase: 'setup',      // setup -> play -> over
      turn: -1,
      finishedCount: 0,
      stall: 0,            // actions since anything irreversible happened
      best: players.map(() => 99), // per-seat minimum cardsLeft ever reached
      burnedSeen: 0,
    };
  }

  function topValue(state) {
    return state.pile.length ? valueOf(state.pile[state.pile.length - 1]) : 0;
  }

  function canPlay(state, card) {
    const t = topValue(state);
    const v = valueOf(card);
    return t === 0 || v === 2 || v === 8 || v >= t;
  }

  // The zone a seat must play from right now
  function zoneOf(state, seat) {
    const p = state.players[seat];
    if (p.hand.length) return 'hand';
    if (p.up.some((c) => c !== null)) return 'up';
    return 'down';
  }

  function zoneCards(state, seat) {
    const p = state.players[seat];
    const z = zoneOf(state, seat);
    if (z === 'hand') return p.hand.slice();
    if (z === 'up') return p.up.filter((c) => c !== null);
    return p.down.filter((c) => c !== null);
  }

  function cardsLeft(state, seat) {
    const p = state.players[seat];
    return p.hand.length + p.up.filter((c) => c !== null).length + p.down.filter((c) => c !== null).length;
  }

  // True when the seat has no legal play and must pick up (never true in 'down' zone:
  // blind flips are always attemptable)
  function isStuck(state, seat) {
    const z = zoneOf(state, seat);
    if (z === 'down') return false;
    return !zoneCards(state, seat).some((c) => canPlay(state, c));
  }

  function activeSeats(state) {
    const out = [];
    for (let s = 0; s < state.n; s++) if (state.players[s].place === 0) out.push(s);
    return out;
  }

  function nextSeat(state, from) {
    for (let i = 1; i <= state.n; i++) {
      const s = (from + i) % state.n;
      if (state.players[s].place === 0) return s;
    }
    return -1;
  }

  // ---- internal helpers used by apply ----

  function drawTo3(state, seat, events) {
    const p = state.players[seat];
    const drawn = [];
    while (p.hand.length < 3 && state.deck.length) {
      const c = state.deck.pop();
      p.hand.push(c);
      drawn.push(c);
    }
    if (drawn.length) events.push({ e: 'drew', seat, cards: drawn });
  }

  function checkFinished(state, seat, events) {
    if (state.players[seat].place !== 0 || cardsLeft(state, seat) !== 0) return false;
    state.players[seat].place = ++state.finishedCount;
    events.push({ e: 'finished', seat, place: state.players[seat].place });
    const active = activeSeats(state);
    if (active.length <= 1) {
      if (active.length === 1) state.players[active[0]].place = ++state.finishedCount;
      state.phase = 'over';
      events.push({ e: 'over', standings: standings(state) });
    }
    return true;
  }

  function standings(state) {
    return state.players
      .map((p, s) => ({ seat: s, place: p.place }))
      .sort((a, b) => a.place - b.place);
  }

  // Deadlock mercy rule: some late-game states cycle forever (cards circulate
  // through pickups with no burns or finishes possible). After STALL_LIMIT
  // actions with zero progress, end the game ranking unfinished players by
  // fewest cards held.
  const STALL_LIMIT = 200;

  function trackProgress(state, seat, events) {
    if (state.phase !== 'play') return;
    let progress = false;
    const left = cardsLeft(state, seat);
    if (left < state.best[seat]) { state.best[seat] = left; progress = true; }
    if (state.burned.length > state.burnedSeen) { state.burnedSeen = state.burned.length; progress = true; }
    if (progress) { state.stall = 0; return; }
    if (++state.stall < STALL_LIMIT) return;
    const rest = activeSeats(state)
      .map((s) => ({ s, left: cardsLeft(state, s) }))
      .sort((a, b) => a.left - b.left || a.s - b.s);
    for (const r of rest) state.players[r.s].place = ++state.finishedCount;
    state.phase = 'over';
    events.push({ e: 'over', standings: standings(state), stalemate: true });
  }

  function passTurn(state, from, events) {
    if (state.phase !== 'play') return;
    state.turn = nextSeat(state, from);
    events.push({ e: 'turn', seat: state.turn });
  }

  // Core "card lands on the pile" step shared by play and successful flips.
  // Returns true when the player burned and goes again.
  function settle(state, seat, card, fromHand, events) {
    state.pile.push(card);
    events.push({ e: 'played', seat, card });
    let again = false;
    if (valueOf(card) === 8) {
      state.burned.push(...state.pile);
      state.pile.length = 0;
      events.push({ e: 'burned', seat });
      again = true;
    } else if (valueOf(card) === 2) {
      events.push({ e: 'reset', seat });
    }
    if (fromHand) drawTo3(state, seat, events);
    const finished = checkFinished(state, seat, events);
    if (state.phase !== 'play') return false;
    if (again && !finished) {
      events.push({ e: 'turn', seat }); // explicit "goes again"
    } else {
      passTurn(state, seat, events);
    }
    return again && !finished;
  }

  /* Apply one action for a seat. Returns { ok, events } or { ok: false, error }.
   * Mutates state when ok. Actions:
   *   setup phase: {type:'up',   card}  place a hand card on the first empty up slot
   *                {type:'unup', card}  take a placed up card back (only while < 3 placed)
   *   play phase:  {type:'play', card}  play from hand or up zone
   *                {type:'flip', card}  blind-flip one of your down cards
   *                {type:'pickup'}      take the pile (only when stuck)
   */
  function applyAction(state, seat, action) {
    const events = [];
    const p = state.players[seat];
    if (!p) return { ok: false, error: 'bad seat' };

    if (state.phase === 'setup') {
      if (action.type === 'up') {
        if (p.setupDone) return { ok: false, error: 'setup already done' };
        const i = p.hand.indexOf(action.card);
        if (i === -1) return { ok: false, error: 'card not in hand' };
        const slot = p.up.indexOf(null);
        if (slot === -1) return { ok: false, error: 'up slots full' };
        p.hand.splice(i, 1);
        p.up[slot] = action.card;
        events.push({ e: 'setUp', seat, card: action.card, slot });
        if (p.up.indexOf(null) === -1) {
          p.setupDone = true;
          events.push({ e: 'setupDone', seat });
          if (state.players.every((q) => q.setupDone)) {
            state.phase = 'play';
            state.turn = Math.floor(Math.random() * state.n);
            events.push({ e: 'start', seat: state.turn });
          }
        }
        return { ok: true, events };
      }
      if (action.type === 'unup') {
        if (p.setupDone) return { ok: false, error: 'setup already done' };
        const slot = p.up.indexOf(action.card);
        if (slot === -1) return { ok: false, error: 'card not in up slots' };
        p.up[slot] = null;
        p.hand.push(action.card);
        events.push({ e: 'unsetUp', seat, card: action.card });
        return { ok: true, events };
      }
      return { ok: false, error: 'game has not started' };
    }

    if (state.phase !== 'play') return { ok: false, error: 'game is over' };
    if (state.turn !== seat) return { ok: false, error: 'not your turn' };
    const zone = zoneOf(state, seat);

    if (action.type === 'play') {
      if (zone === 'down') return { ok: false, error: 'must flip a face-down card' };
      const src = zone === 'hand' ? p.hand : p.up;
      const i = src.indexOf(action.card);
      if (i === -1) return { ok: false, error: 'card not in your ' + zone + ' zone' };
      if (!canPlay(state, action.card)) return { ok: false, error: 'card too low' };
      if (zone === 'hand') p.hand.splice(i, 1); else p.up[i] = null;
      settle(state, seat, action.card, zone === 'hand', events);
      trackProgress(state, seat, events);
      return { ok: true, events };
    }

    if (action.type === 'flip') {
      if (zone !== 'down') return { ok: false, error: 'not on your face-down cards yet' };
      const slot = action.slot;
      if (!(slot >= 0 && slot < 3) || p.down[slot] === null) return { ok: false, error: 'no card in that slot' };
      const card = p.down[slot];
      const ok = canPlay(state, card);
      events.push({ e: 'flipped', seat, card, slot, ok });
      p.down[slot] = null;
      if (ok) {
        settle(state, seat, card, false, events);
      } else {
        p.hand.push(card, ...state.pile);
        state.pile.length = 0;
        events.push({ e: 'pickup', seat, flipped: card });
        passTurn(state, seat, events);
      }
      trackProgress(state, seat, events);
      return { ok: true, events };
    }

    if (action.type === 'pickup') {
      if (!isStuck(state, seat)) return { ok: false, error: 'you have a playable card' };
      p.hand.push(...state.pile);
      state.pile.length = 0;
      events.push({ e: 'pickup', seat });
      passTurn(state, seat, events);
      trackProgress(state, seat, events);
      return { ok: true, events };
    }

    return { ok: false, error: 'unknown action' };
  }

  // Censored per-seat view: your hand in full; other hands and all face-down
  // cards as counts/occupancy only. Everything public (pile, up cards) as-is.
  function viewFor(state, seat) {
    return {
      n: state.n,
      seat,
      phase: state.phase,
      turn: state.turn,
      deckCount: state.deck.length,
      pile: state.pile.slice(),
      burnedCount: state.burned.length,
      players: state.players.map((p, s) => ({
        handCount: p.hand.length,
        hand: s === seat ? p.hand.slice() : undefined,
        up: p.up.slice(),                       // public
        down: p.down.map((c) => c !== null),    // occupancy only
        place: p.place,
        setupDone: p.setupDone,
      })),
    };
  }

  // ---- bot ----

  function setupScore(c) {
    const v = valueOf(c);
    return (v === 2 || v === 8) ? 100 + v : v;
  }

  // One action for the seat, or null if nothing to do
  function botAction(state, seat) {
    const p = state.players[seat];
    if (state.phase === 'setup') {
      if (p.setupDone) return null;
      const best = p.hand.slice().sort((a, b) => setupScore(b) - setupScore(a))[0];
      return { type: 'up', card: best };
    }
    if (state.phase !== 'play' || state.turn !== seat) return null;
    const zone = zoneOf(state, seat);
    if (zone === 'down') {
      const slots = [0, 1, 2].filter((i) => p.down[i] !== null);
      return { type: 'flip', slot: slots[Math.floor(Math.random() * slots.length)] };
    }
    const cands = zoneCards(state, seat).filter((c) => canPlay(state, c));
    if (!cands.length) return { type: 'pickup' };
    const normals = cands.filter((c) => valueOf(c) !== 2 && valueOf(c) !== 8).sort((a, b) => valueOf(a) - valueOf(b));
    if (normals.length) return { type: 'play', card: normals[0] };
    const eights = cands.filter((c) => valueOf(c) === 8);
    const twos = cands.filter((c) => valueOf(c) === 2);
    const pick = (state.pile.length >= 4 && eights.length) ? eights[0]
      : (twos.length ? twos[0] : eights[0]);
    return { type: 'play', card: pick };
  }

  // Strip hidden information from events before sending them to a seat:
  // cards another player drew are their secret.
  function censorEvents(events, seat) {
    return events.map((ev) => {
      if (ev.e === 'drew' && ev.seat !== seat) return { e: 'drew', seat: ev.seat, count: ev.cards.length };
      return ev;
    });
  }

  return {
    suitOf, valueOf,
    createGame, applyAction, viewFor, botAction, censorEvents,
    canPlay, topValue, zoneOf, zoneCards, cardsLeft, isStuck, activeSeats, standings,
  };
});
