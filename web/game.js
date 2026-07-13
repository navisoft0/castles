'use strict';
/* Castles — Jake's Way
 * Shed-type card game: equal-or-higher beats the pile, 2 resets, 8 burns.
 * Ported from the original Godot prototype to a self-contained HTML5 game.
 */

// ===== layout constants (stage is a fixed 1280x720, scaled to fit) =====
const W = 1280, H = 720, CW = 88, CH = 120;
const POS = {
  deck: { x: 500, y: 300 },
  pile: { x: 640, y: 300 },
  burn: { x: 780, y: 300 },
  hand: { 0: { cx: 640, y: 580 }, 1: { cx: 640, y: 18 } },   // 0 = you, 1 = AI
  castleY: { 0: 464, 1: 154 },
  slotX: [520, 640, 760],
  msg: { x: 250, y: 330 },
  pickup: { x: 250, y: 396 },
};
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANK_NAMES = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };

// ===== dom =====
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const cardsLayer = $('#cards');
const msgEl = $('#message');
const pickupBtn = $('#pickup-btn');
const autoBtn = $('#auto-btn');

// ===== audio =====
const SOUND_FILES = {
  place: ['card-place-1', 'card-place-2', 'card-place-3', 'card-place-4'],
  slide: ['card-slide-1', 'card-slide-2'],
  shuffle: ['card-shuffle'],
  fan: ['card-fan-1'],
  shove: ['card-shove-1'],
};
const soundBank = {};
for (const key of Object.keys(SOUND_FILES)) {
  soundBank[key] = SOUND_FILES[key].map((n) => {
    const a = new Audio('assets/audio/' + n + '.ogg');
    a.preload = 'auto';
    return a;
  });
}
let muted = localStorage.getItem('castles-muted') === '1';

function sfx(name) {
  if (muted) return;
  const pool = soundBank[name];
  const src = pool[Math.floor(Math.random() * pool.length)];
  const a = src.cloneNode();
  a.volume = 0.55;
  a.play().catch(() => {});
}

// ===== state =====
let game = null;
let busy = true;       // blocks input during animations / AI turn
let msgTimer = null;

function newGame() {
  const deck = [];
  let id = 0;
  for (let s = 0; s < 4; s++) {
    for (let v = 2; v <= 14; v++) {
      deck.push({ id: id++, s, v, jit: 0, el: null });
    }
  }
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return {
    deck,
    pile: [],
    burned: [],
    players: [
      { hand: [], up: [null, null, null], down: [null, null, null] },
      { hand: [], up: [null, null, null], down: [null, null, null] },
    ],
    phase: 'setupDown',   // setupDown -> setupUp -> play -> over
    turn: 0,
  };
}

function rankName(v) { return RANK_NAMES[v] || String(v); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rand(a, b) { return a + Math.random() * (b - a); }

function cardsLeft(p) {
  const pl = game.players[p];
  return pl.hand.length + pl.up.filter(Boolean).length + pl.down.filter(Boolean).length;
}

function topValue() {
  if (!game.pile.length) return 0;
  return game.pile[game.pile.length - 1].v;
}

function canPlay(card) {
  const t = topValue();
  return t === 0 || card.v === 2 || card.v === 8 || card.v >= t;
}

// Which zone the player must play from
function currentZone(p) {
  const pl = game.players[p];
  if (pl.hand.length) return 'hand';
  if (pl.up.some(Boolean)) return 'up';
  return 'down';
}

// ===== card elements & layout =====
function makeCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card back';
  el.style.setProperty('--col', String(card.v - 2));
  el.style.setProperty('--row', String(card.s));
  el.dataset.id = card.id;
  el.addEventListener('click', () => onCardClick(card));
  cardsLayer.appendChild(el);
  card.el = el;
  return el;
}

function place(card, x, y, rot, z, faceUp) {
  const el = card.el;
  el.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
  el.style.zIndex = z;
  el.classList.toggle('back', !faceUp);
}

function fanPositions(n, cx, spread) {
  const sp = n > 1 ? Math.min(spread, 560 / (n - 1)) : 0;
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(cx - ((n - 1) * sp) / 2 + i * sp - CW / 2);
  return xs;
}

function layoutAll() {
  // deck
  game.deck.forEach((c, i) => {
    c.el.classList.remove('gone');
    place(c, POS.deck.x - CW / 2 - i * 0.15, POS.deck.y - i * 0.2, 0, i, false);
  });
  // pile
  game.pile.forEach((c, i) => {
    c.el.classList.remove('gone');
    place(c, POS.pile.x - CW / 2, POS.pile.y, c.jit, 100 + i, true);
  });
  // burned (fade out at the burn zone)
  game.burned.forEach((c, i) => {
    place(c, POS.burn.x - CW / 2, POS.burn.y, c.jit, 1 + i, true);
    c.el.classList.add('gone');
  });
  // players
  for (let p = 0; p < 2; p++) {
    const pl = game.players[p];
    const hp = POS.hand[p];
    const xs = fanPositions(pl.hand.length, hp.cx, 58);
    const mid = (pl.hand.length - 1) / 2;
    pl.hand.forEach((c, i) => {
      const d = i - mid;
      const arc = Math.min(d * d * 0.5, 12);
      const faceUp = p === 0 && game.phase !== 'setupDown';
      place(c, xs[i], hp.y + (p === 0 ? arc : -arc), (p === 0 ? 1 : -1) * d * 1.6, 200 + i, faceUp);
      c.el.classList.toggle('inhand', p === 0);
    });
    for (let i = 0; i < 3; i++) {
      const slotX = POS.slotX[i] - CW / 2;
      const y = POS.castleY[p];
      if (pl.down[i]) place(pl.down[i], slotX, y, 0, 50, false);
      if (pl.up[i]) place(pl.up[i], slotX + 16, y + 3, 0, 60, true); // up cards are public
    }
  }
  updateCounts();
}

function updateCounts() {
  $('#deck-count').textContent = game.deck.length ? `Deck · ${game.deck.length}` : 'Deck empty';
  $('#pile-count').textContent = game.pile.length ? `Pile · ${game.pile.length}` : 'Pile';
  $('#burn-count').textContent = game.burned.length ? `Burned · ${game.burned.length}` : '';
  $('#burn-zone').style.opacity = game.burned.length ? 1 : 0.35;
}

// Highlight what the player can interact with right now
function refreshInteractivity() {
  document.querySelectorAll('.card').forEach((el) => el.classList.remove('clickable', 'glow', 'dim'));
  if (!game || game.phase === 'over') return;
  const me = game.players[0];

  if (game.phase === 'setupDown') {
    me.hand.forEach((c) => c.el.classList.add('clickable', 'glow'));
    return;
  }
  if (game.phase === 'setupUp') {
    me.hand.forEach((c) => c.el.classList.add('clickable', 'glow'));
    me.up.forEach((c) => { if (c) c.el.classList.add('clickable'); });
    return;
  }
  if (game.phase === 'play' && game.turn === 0 && !busy) {
    const zone = currentZone(0);
    if (zone === 'hand') {
      me.hand.forEach((c) => {
        c.el.classList.add('clickable');
        c.el.classList.toggle('glow', canPlay(c));
        c.el.classList.toggle('dim', !canPlay(c));
      });
    } else if (zone === 'up') {
      me.up.forEach((c) => {
        if (!c) return;
        c.el.classList.add('clickable');
        c.el.classList.toggle('glow', canPlay(c));
        c.el.classList.toggle('dim', !canPlay(c));
      });
    } else {
      me.down.forEach((c) => { if (c) c.el.classList.add('clickable', 'glow'); });
    }
  }
}

function setTurnLabels() {
  $('#player-label').classList.toggle('active', game.phase === 'play' && game.turn === 0);
  $('#ai-label').classList.toggle('active', game.phase === 'play' && game.turn === 1);
}

// ===== messages =====
function msg(text, sticky = false) {
  clearTimeout(msgTimer);
  msgEl.textContent = text;
  msgEl.classList.add('show');
  if (!sticky) msgTimer = setTimeout(() => msgEl.classList.remove('show'), 2400);
}

// ===== game flow =====
async function startGame() {
  cardsLayer.innerHTML = '';
  busy = true;
  pickupBtn.classList.add('hidden');
  autoBtn.classList.add('hidden');
  game = newGame();
  game.deck.forEach(makeCardEl);
  layoutAll();
  setTurnLabels();
  sfx('shuffle');
  await sleep(700);

  // deal 9 cards each, alternating
  for (let i = 0; i < 9; i++) {
    for (const p of [1, 0]) {
      const c = game.deck.pop();
      game.players[p].hand.push(c);
      sfx('slide');
      layoutAll();
      await sleep(90);
    }
  }

  // AI builds its castle immediately (3 random blind, 3 best face-up)
  aiSetup();
  layoutAll();

  busy = false;
  msg('Pick 3 cards for your face-down castle', true);
  autoBtn.classList.remove('hidden');
  refreshInteractivity();
}

function bestSetupCards(cards, n) {
  // Prefer magic cards (2, 8), then highest values
  return [...cards]
    .sort((a, b) => score(b) - score(a))
    .slice(0, n);
  function score(c) { return (c.v === 2 || c.v === 8) ? 100 + c.v : c.v; }
}

function aiSetup() {
  const ai = game.players[1];
  for (let i = 0; i < 3; i++) {
    const k = Math.floor(Math.random() * ai.hand.length);
    ai.down[i] = ai.hand.splice(k, 1)[0];
  }
  const ups = bestSetupCards(ai.hand, 3);
  ups.forEach((c, i) => {
    ai.up[i] = c;
    ai.hand.splice(ai.hand.indexOf(c), 1);
  });
}

function placeSetupCard(card) {
  const me = game.players[0];
  const zone = game.phase === 'setupDown' ? me.down : me.up;
  const slot = zone.indexOf(null);
  if (slot === -1) return;
  me.hand.splice(me.hand.indexOf(card), 1);
  zone[slot] = card;
  sfx('place');
  card.el.classList.add('pop');
  setTimeout(() => card.el.classList.remove('pop'), 320);
  layoutAll();

  if (game.phase === 'setupDown' && !zone.includes(null)) {
    game.phase = 'setupUp';
    layoutAll(); // reveals remaining hand
    msg('Now pick 3 cards to place face-up on top', true);
  } else if (game.phase === 'setupUp' && !zone.includes(null)) {
    beginPlay();
    return;
  }
  refreshInteractivity();
}

function returnUpCard(card) {
  const me = game.players[0];
  const i = me.up.indexOf(card);
  if (i === -1) return;
  me.up[i] = null;
  me.hand.push(card);
  sfx('slide');
  layoutAll();
  refreshInteractivity();
}

async function beginPlay() {
  game.phase = 'play';
  autoBtn.classList.add('hidden');
  busy = true;
  refreshInteractivity();
  layoutAll();
  await sleep(400);
  game.turn = Math.random() < 0.5 ? 0 : 1;
  setTurnLabels();
  if (game.turn === 0) {
    msg('You start!');
    playerTurnStart();
  } else {
    msg('Opponent starts');
    aiTurn();
  }
}

function playerTurnStart(extraMsg) {
  game.turn = 0;
  busy = false;
  setTurnLabels();
  const zone = currentZone(0);
  const me = game.players[0];
  let stuck = false;
  if (zone === 'hand') stuck = !me.hand.some(canPlay);
  else if (zone === 'up') stuck = !me.up.filter(Boolean).some(canPlay);
  if (stuck) {
    msg(extraMsg || 'No playable card — you must pick up the pile', true);
    pickupBtn.classList.remove('hidden');
  } else {
    pickupBtn.classList.add('hidden');
    if (extraMsg) msg(extraMsg);
  }
  refreshInteractivity();
}

async function doPlay(p, card, fromZone) {
  busy = true;
  pickupBtn.classList.add('hidden');
  refreshInteractivity();
  const pl = game.players[p];

  if (fromZone === 'hand') pl.hand.splice(pl.hand.indexOf(card), 1);
  else if (fromZone === 'up') pl.up[pl.up.indexOf(card)] = null;
  else pl.down[pl.down.indexOf(card)] = null;

  card.jit = rand(-14, 14);
  game.pile.push(card);
  sfx('place');
  card.el.classList.add('pop');
  setTimeout(() => card.el.classList.remove('pop'), 320);
  layoutAll();
  await sleep(320);

  let burned = false;
  if (card.v === 8) {
    await sleep(240);
    game.burned.push(...game.pile);
    game.pile.length = 0;
    sfx('shove');
    msg(p === 0 ? 'Burn! You go again' : 'Opponent burns the pile!');
    layoutAll();
    await sleep(350);
    burned = true;
  } else if (card.v === 2) {
    msg('Pile reset');
  }

  // refill hand to 3 while the deck lasts
  if (fromZone === 'hand') {
    while (pl.hand.length < 3 && game.deck.length) {
      pl.hand.push(game.deck.pop());
      sfx('slide');
      layoutAll();
      await sleep(140);
    }
  }

  if (cardsLeft(p) === 0) { gameOver(p); return 'over'; }
  return burned ? 'again' : 'next';
}

async function pickupPile(p) {
  busy = true;
  pickupBtn.classList.add('hidden');
  const pl = game.players[p];
  sfx('fan');
  msg(p === 0 ? 'You pick up the pile' : 'Opponent picks up the pile');
  pl.hand.push(...game.pile);
  game.pile.length = 0;
  layoutAll();
  refreshInteractivity();
  await sleep(550);
}

async function onCardClick(card) {
  if (!game || busy) return;

  if (game.phase === 'setupDown') {
    if (game.players[0].hand.includes(card)) placeSetupCard(card);
    return;
  }
  if (game.phase === 'setupUp') {
    if (game.players[0].hand.includes(card)) placeSetupCard(card);
    else if (game.players[0].up.includes(card)) returnUpCard(card);
    return;
  }
  if (game.phase !== 'play' || game.turn !== 0) return;

  const me = game.players[0];
  const zone = currentZone(0);

  if (zone === 'hand' && me.hand.includes(card)) {
    if (!canPlay(card)) return rejectCard(card);
    const r = await doPlay(0, card, 'hand');
    afterPlayerAction(r);
  } else if (zone === 'up' && me.up.includes(card)) {
    if (!canPlay(card)) return rejectCard(card);
    const r = await doPlay(0, card, 'up');
    afterPlayerAction(r);
  } else if (zone === 'down' && me.down.includes(card)) {
    await blindFlip(0, card);
  }
}

function rejectCard(card) {
  card.el.classList.add('shake');
  setTimeout(() => card.el.classList.remove('shake'), 320);
  msg(`A ${rankName(card.v)} can't beat a ${rankName(topValue())}`);
}

async function blindFlip(p, card) {
  busy = true;
  refreshInteractivity();
  const pl = game.players[p];
  card.el.classList.remove('back');
  card.el.classList.add('pop');
  setTimeout(() => card.el.classList.remove('pop'), 320);
  sfx('slide');
  await sleep(650);
  if (canPlay(card)) {
    msg(p === 0 ? `Lucky flip — ${rankName(card.v)} plays!` : `Opponent flips a ${rankName(card.v)} — it plays`);
    const r = await doPlay(p, card, 'down');
    if (p === 0) afterPlayerAction(r); else return r;
  } else {
    // failed blind flip: pick up pile plus the flipped card
    msg(p === 0
      ? `The ${rankName(card.v)} doesn't beat a ${rankName(topValue())} — you pick everything up`
      : `Opponent's ${rankName(card.v)} fails — they pick everything up`);
    pl.down[pl.down.indexOf(card)] = null;
    pl.hand.push(card);
    pl.hand.push(...game.pile);
    game.pile.length = 0;
    sfx('fan');
    layoutAll();
    await sleep(650);
    if (p === 0) afterPlayerAction('next'); else return 'next';
  }
  return 'next';
}

function afterPlayerAction(result) {
  if (result === 'over') return;
  if (result === 'again') { playerTurnStart('You go again!'); return; }
  aiTurn();
}

// ===== AI =====
function aiPick(cands) {
  const normals = cands.filter((c) => c.v !== 2 && c.v !== 8).sort((a, b) => a.v - b.v);
  if (normals.length) return normals[0];
  const eights = cands.filter((c) => c.v === 8);
  const twos = cands.filter((c) => c.v === 2);
  if (game.pile.length >= 4 && eights.length) return eights[0];
  return twos[0] || eights[0];
}

async function aiTurn() {
  game.turn = 1;
  busy = true;
  setTurnLabels();
  refreshInteractivity();
  const ai = game.players[1];

  for (;;) {
    await sleep(650);
    if (game.phase !== 'play') return;
    const zone = currentZone(1);

    if (zone === 'down') {
      const options = ai.down.filter(Boolean);
      const card = options[Math.floor(Math.random() * options.length)];
      const r = await blindFlip(1, card);
      if (game.phase !== 'play') return;
      if (r === 'again' && cardsLeft(1) > 0) continue;
      break;
    }

    const cards = zone === 'hand' ? ai.hand : ai.up.filter(Boolean);
    const cands = cards.filter(canPlay);
    if (!cands.length) { await pickupPile(1); break; }

    const card = aiPick(cands);
    const r = await doPlay(1, card, zone);
    if (r === 'over') return;
    if (r === 'again') continue;
    break;
  }
  playerTurnStart();
}

// ===== win / lose =====
function gameOver(winner) {
  game.phase = 'over';
  busy = true;
  setTurnLabels();
  refreshInteractivity();
  pickupBtn.classList.add('hidden');
  const you = winner === 0;
  $('#over-title').textContent = you ? 'You win! 🏰' : 'You lose';
  $('#over-text').textContent = you
    ? 'Your castle stands — every card shed. Well played!'
    : `The opponent shed everything first. You still held ${cardsLeft(0)} card${cardsLeft(0) === 1 ? '' : 's'}.`;
  setTimeout(() => $('#over-screen').classList.remove('hidden'), 900);
}

// ===== setup auto-place =====
function autoPlace() {
  if (!game || busy) return;
  const me = game.players[0];
  if (game.phase === 'setupDown') {
    while (me.down.includes(null)) {
      placeSetupCard(me.hand[Math.floor(Math.random() * me.hand.length)]);
    }
  } else if (game.phase === 'setupUp') {
    const picks = bestSetupCards(me.hand, 3 - me.up.filter(Boolean).length);
    for (const c of picks) {
      if (game.phase !== 'setupUp') break;
      placeSetupCard(c);
    }
  }
}

// ===== ui wiring =====
$('#play-btn').addEventListener('click', () => {
  $('#title-screen').classList.add('hidden');
  startGame();
});
$('#rules-btn').addEventListener('click', () => $('#rules-screen').classList.remove('hidden'));
$('#help-btn').addEventListener('click', () => $('#rules-screen').classList.remove('hidden'));
$('#rules-close-btn').addEventListener('click', () => $('#rules-screen').classList.add('hidden'));
$('#again-btn').addEventListener('click', () => {
  $('#over-screen').classList.add('hidden');
  startGame();
});
$('#restart-btn').addEventListener('click', () => {
  if (game && game.phase !== 'over') sfx('shuffle');
  $('#over-screen').classList.add('hidden');
  startGame();
});
pickupBtn.addEventListener('click', async () => {
  if (!game || game.phase !== 'play' || game.turn !== 0 || busy) return;
  await pickupPile(0);
  aiTurn();
});
autoBtn.addEventListener('click', autoPlace);

const muteBtn = $('#mute-btn');
function renderMute() { muteBtn.innerHTML = muted ? '&#128263;' : '&#128266;'; }
muteBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('castles-muted', muted ? '1' : '0');
  renderMute();
});
renderMute();

// position table zones from the same constants the cards use
function positionZones() {
  const set = (el, x, y) => { el.style.left = `${x - CW / 2 - 5}px`; el.style.top = `${y - 5}px`; };
  set($('#deck-zone'), POS.deck.x, POS.deck.y);
  set($('#pile-zone'), POS.pile.x, POS.pile.y);
  set($('#burn-zone'), POS.burn.x, POS.burn.y);
  document.querySelectorAll('.castle-slot').forEach((el) => {
    set(el, POS.slotX[+el.dataset.slot], POS.castleY[+el.dataset.owner]);
  });
  const msgP = POS.msg;
  msgEl.style.left = `${msgP.x}px`;
  msgEl.style.top = `${msgP.y}px`;
  msgEl.style.transform = 'translateX(-50%)';
  pickupBtn.style.left = `${POS.pickup.x}px`;
  pickupBtn.style.top = `${POS.pickup.y}px`;
  pickupBtn.style.transform = 'translateX(-50%)';
  $('#ai-label').style.left = '40px';
  $('#ai-label').style.top = '40px';
  $('#player-label').style.left = '40px';
  $('#player-label').style.top = `${H - 60}px`;
}

// scale the fixed 1280x720 stage to the window
function rescale() {
  const s = Math.min(window.innerWidth / W, window.innerHeight / H);
  stage.style.transform = `translate(${-W * s / 2}px, ${-H * s / 2}px) scale(${s})`;
}
window.addEventListener('resize', rescale);
positionZones();
rescale();

// test hook (used by automated browser tests; harmless in production)
window.__castles = {
  get game() { return game; },
  get busy() { return busy; },
  canPlay, currentZone, cardsLeft, topValue,
};
