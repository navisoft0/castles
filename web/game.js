'use strict';
/* Castles — client. Renders per-seat views from the shared rules engine,
 * either from a local practice game (vs bots) or from the online server.
 */

const E = window.CastlesEngine;

// ===== layout constants (fixed 1280x720 stage, scaled to fit) =====
const W = 1280, H = 720, CW = 88, CH = 120;
const POS = {
  deck: { x: 500, y: 300 },
  pile: { x: 640, y: 300 },
  burn: { x: 780, y: 300 },
  myHand: { cx: 640, y: 580 },
  myCastleY: 464,
  mySlotX: [520, 640, 760],
  msg: { x: 250, y: 330 },
  timer: { x: 250, y: 296 },
  pickup: { x: 250, y: 396 },
};
// Opponent panel geometry by opponent count
const OPP_GEOM = {
  1: { centers: [640], cw: 72, ch: 98 },
  2: { centers: [390, 890], cw: 62, ch: 85 },
  3: { centers: [260, 640, 1020], cw: 56, ch: 76 },
};
const RANK_NAMES = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const BOT_NAMES = ['Ada', 'Byte', 'Cleo'];
const CHAT_PHRASES = ['👍 Nice!', '😖 Ouch', '⏳ Hurry up', '🏰 Good game'];

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const cardsLayer = $('#cards');
const msgEl = $('#message');
const pickupBtn = $('#pickup-btn');
const autoBtn = $('#auto-btn');
const timerEl = $('#turn-timer');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rankName(v) { return RANK_NAMES[v] || String(v); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
  const a = pool[Math.floor(Math.random() * pool.length)].cloneNode();
  a.volume = 0.55;
  a.play().catch(() => {});
}

// ===== mode / session state =====
let mode = null;         // {kind:'local'|'online', ...}
let view = null;         // latest rendered view
let names = [];          // per-seat names
let seatBots = [];       // per-seat bot flags (online)
let seatConn = [];       // per-seat connected flags (online)
let jitters = {};        // card id -> pile rotation
let msgTimer = null;
let queue = [];          // pending {view, events}
let pumping = false;

const cardEls = new Map();   // card id -> element
const ghostEls = new Map();  // key -> element

// ===== geometry =====
function relIndex(seat) {
  return (seat - mode.mySeat + view.n) % view.n;
}

function seatGeom(seat) {
  const rel = relIndex(seat);
  if (rel === 0) {
    return {
      me: true, cw: CW, ch: CH,
      handCx: POS.myHand.cx, handY: POS.myHand.y, handSpread: 58, handMax: 560,
      castleY: POS.myCastleY, slotX: POS.mySlotX.slice(),
      nameX: 185, nameY: H - 46, bubble: { x: 640, y: 530 },
    };
  }
  const g = OPP_GEOM[view.n - 1];
  const cx = g.centers[rel - 1];
  const gap = g.cw + 12;
  return {
    me: false, cw: g.cw, ch: g.ch,
    handCx: cx, handY: 32, handSpread: g.cw * 0.5, handMax: gap * 3 - 10,
    castleY: 32 + g.ch + 16, slotX: [cx - gap, cx, cx + gap],
    nameX: cx, nameY: 8, bubble: { x: cx, y: 32 + g.ch * 2 + 24 },
    panel: { x: cx - gap * 1.5 - 12, y: 2, w: gap * 3 + 24, h: g.ch * 2 + 54 },
  };
}

// ===== card / ghost elements =====
function setCardFace(el, id) {
  el.style.setProperty('--col', String(E.valueOf(id) - 2));
  el.style.setProperty('--row', String(E.suitOf(id)));
}

function getCardEl(id, spawnX, spawnY) {
  let el = cardEls.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'card back notrans';
    setCardFace(el, id);
    el.addEventListener('click', () => onCardClick(id));
    el.style.transform = `translate(${spawnX}px, ${spawnY}px)`;
    cardsLayer.appendChild(el);
    cardEls.set(id, el);
    el.getBoundingClientRect(); // flush so the next transform animates
    el.classList.remove('notrans');
  }
  return el;
}

function getGhost(key, spawnX, spawnY, onClick) {
  let el = ghostEls.get(key);
  if (!el) {
    el = document.createElement('div');
    el.className = 'card back notrans';
    el.dataset.ghost = key;
    if (onClick) el.addEventListener('click', onClick);
    el.style.transform = `translate(${spawnX}px, ${spawnY}px)`;
    cardsLayer.appendChild(el);
    ghostEls.set(key, el);
    el.getBoundingClientRect();
    el.classList.remove('notrans');
  }
  return el;
}

function removeEl(el, fade) {
  if (fade) {
    el.classList.add('gone');
    setTimeout(() => el.remove(), 350);
  } else el.remove();
}

function place(el, x, y, rot, z, faceUp, cw, ch) {
  el.style.setProperty('--cw', (cw || CW) + 'px');
  el.style.setProperty('--ch', (ch || CH) + 'px');
  el.style.transform = `translate(${x}px, ${y}px) rotate(${rot || 0}deg)`;
  el.style.zIndex = z;
  el.classList.toggle('back', !faceUp);
}

function fanX(i, n, cx, spread, maxW, cw) {
  const sp = n > 1 ? Math.min(spread, maxW / (n - 1)) : 0;
  return cx - ((n - 1) * sp) / 2 + i * sp - cw / 2;
}

// ===== rendering =====
function sortedHand(cards) {
  return cards.slice().sort((a, b) => E.valueOf(a) - E.valueOf(b) || E.suitOf(a) - E.suitOf(b));
}

function spawnPoint() {
  // where fresh elements appear from when priming a new game
  return { x: POS.deck.x - CW / 2, y: POS.deck.y };
}

function render() {
  if (!view) return;
  const seen = new Set();      // card ids visible this frame
  const ghostsSeen = new Set();
  const sp = spawnPoint();

  // deck ghosts
  const deckShow = Math.min(view.deckCount, 8);
  for (let i = 0; i < deckShow; i++) {
    const key = 'deck-' + i;
    ghostsSeen.add(key);
    const el = getGhost(key, sp.x, sp.y);
    place(el, POS.deck.x - CW / 2 - i * 0.2, POS.deck.y - i * 0.25, 0, 10 + i, false);
  }

  // pile
  view.pile.forEach((id, i) => {
    seen.add(id);
    if (!(id in jitters)) jitters[id] = Math.random() * 28 - 14;
    const el = getCardEl(id, sp.x, sp.y);
    place(el, POS.pile.x - CW / 2, POS.pile.y, jitters[id], 100 + i, true);
    el.classList.remove('inhand');
  });

  // players
  for (let s = 0; s < view.n; s++) {
    const p = view.players[s];
    const g = seatGeom(s);
    if (g.me) {
      const hand = sortedHand(p.hand || []);
      hand.forEach((id, i) => {
        seen.add(id);
        const el = getCardEl(id, sp.x, sp.y);
        const d = i - (hand.length - 1) / 2;
        const arc = Math.min(d * d * 0.5, 12);
        place(el, fanX(i, hand.length, g.handCx, g.handSpread, g.handMax, g.cw), g.handY + arc, d * 1.6, 200 + i, true, g.cw, g.ch);
        el.classList.add('inhand');
      });
    } else {
      for (let i = 0; i < p.handCount; i++) {
        const key = `hand-${s}-${i}`;
        ghostsSeen.add(key);
        const el = getGhost(key, sp.x, sp.y);
        const d = i - (p.handCount - 1) / 2;
        place(el, fanX(i, p.handCount, g.handCx, g.handSpread, g.handMax, g.cw), g.handY - Math.min(d * d * 0.4, 10), -d * 1.6, 200 + i, false, g.cw, g.ch);
      }
    }
    for (let k = 0; k < 3; k++) {
      if (p.down[k]) {
        const key = `down-${s}-${k}`;
        ghostsSeen.add(key);
        const el = getGhost(key, sp.x, sp.y, () => onDownClick(s, k));
        place(el, g.slotX[k] - g.cw / 2, g.castleY, 0, 50, false, g.cw, g.ch);
      }
      const upId = p.up[k];
      if (upId !== null && upId !== undefined) {
        seen.add(upId);
        const el = getCardEl(upId, sp.x, sp.y);
        place(el, g.slotX[k] - g.cw / 2 + g.cw * 0.18, g.castleY + 3, 0, 60, true, g.cw, g.ch);
        el.classList.remove('inhand');
      }
    }
  }

  // cull vanished elements (burned cards, consumed ghosts)
  for (const [id, el] of cardEls) {
    if (!seen.has(id)) { cardEls.delete(id); removeEl(el, true); }
  }
  for (const [key, el] of ghostEls) {
    if (!ghostsSeen.has(key)) { ghostEls.delete(key); removeEl(el, false); }
  }

  updateLabels();
  refreshInteractivity();
}

function updateLabels() {
  $('#deck-count').textContent = view.deckCount ? `Deck · ${view.deckCount}` : 'Deck empty';
  $('#pile-count').textContent = view.pile.length ? `Pile · ${view.pile.length}` : 'Pile';
  $('#burn-count').textContent = view.burnedCount ? `Burned · ${view.burnedCount}` : '';
  $('#burn-zone').style.opacity = view.burnedCount ? 1 : 0.35;

  for (let s = 0; s < view.n; s++) {
    const nameEl = document.querySelector(`.seat-name[data-seat="${s}"]`);
    const panelEl = document.querySelector(`.seat-panel[data-seat="${s}"]`);
    if (!nameEl) continue;
    const p = view.players[s];
    let label = esc(names[s] || `Player ${s + 1}`);
    if (relIndex(s) === 0) label += ' (you)';
    let tag = '';
    if (p.place) tag = ` <span class="tag place-tag">${placeName(p.place, view.n)}</span>`;
    else if (seatBots[s]) tag = ' <span class="tag">(bot)</span>';
    else if (seatConn[s] === false) tag = ' <span class="tag">(reconnecting…)</span>';
    else if (view.phase === 'setup') tag = p.setupDone ? ' <span class="tag">✓ ready</span>' : ' <span class="tag">choosing…</span>';
    nameEl.innerHTML = label + tag;
    const active = view.phase === 'play' && view.turn === s;
    nameEl.classList.toggle('active', active);
    if (panelEl) panelEl.classList.toggle('active', active);
  }
}

function placeName(place, n) {
  if (place === n) return 'last';
  return ['1st', '2nd', '3rd', '4th'][place - 1];
}

// ----- interactivity -----
function myZone() {
  const p = view.players[mode.mySeat];
  if (p.handCount > 0) return 'hand';
  if (p.up.some((c) => c !== null)) return 'up';
  return 'down';
}

function canPlayId(id) {
  const t = view.pile.length ? E.valueOf(view.pile[view.pile.length - 1]) : 0;
  const v = E.valueOf(id);
  return t === 0 || v === 2 || v === 8 || v >= t;
}

function refreshInteractivity() {
  document.querySelectorAll('.card').forEach((el) => el.classList.remove('clickable', 'glow', 'dim'));
  pickupBtn.classList.add('hidden');
  autoBtn.classList.add('hidden');
  if (!view || !mode || view.phase === 'over' || pumping) return;
  const me = view.players[mode.mySeat];

  if (view.phase === 'setup') {
    if (!me.setupDone) {
      autoBtn.classList.remove('hidden');
      for (const id of me.hand) cardEls.get(id)?.classList.add('clickable', 'glow');
      for (const id of me.up) if (id !== null) cardEls.get(id)?.classList.add('clickable');
    }
    return;
  }
  if (view.phase !== 'play' || view.turn !== mode.mySeat) return;

  const zone = myZone();
  if (zone === 'hand' || zone === 'up') {
    const ids = zone === 'hand' ? me.hand : me.up.filter((c) => c !== null);
    let any = false;
    for (const id of ids) {
      const el = cardEls.get(id);
      if (!el) continue;
      el.classList.add('clickable');
      if (canPlayId(id)) { el.classList.add('glow'); any = true; }
      else el.classList.add('dim');
    }
    if (!any) pickupBtn.classList.remove('hidden');
  } else {
    for (let k = 0; k < 3; k++) {
      if (me.down[k]) ghostEls.get(`down-${mode.mySeat}-${k}`)?.classList.add('clickable', 'glow');
    }
  }
}

// ===== messages / timer =====
function msg(text, sticky = false) {
  clearTimeout(msgTimer);
  msgEl.textContent = text;
  msgEl.classList.add('show');
  if (!sticky) msgTimer = setTimeout(() => msgEl.classList.remove('show'), 2400);
}

let timerInterval = null;
function startTimerDisplay() {
  stopTimerDisplay();
  timerInterval = setInterval(() => {
    if (!mode || mode.kind !== 'online' || !mode.deadline || !view || view.phase !== 'play') {
      timerEl.textContent = '';
      return;
    }
    const left = Math.max(0, Math.ceil((mode.deadline - Date.now()) / 1000));
    const who = view.turn === mode.mySeat ? 'Your turn' : `${names[view.turn] || 'Their'} turn`;
    timerEl.textContent = left <= 20 ? `${who} · ${left}s` : who;
  }, 250);
}
function stopTimerDisplay() {
  clearInterval(timerInterval);
  timerEl.textContent = '';
}

// ===== event playback =====
function pushView(v, events) {
  queue.push({ v, events });
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const { v, events } = queue.shift();
      await playback(v, events || []);
    }
  } finally {
    pumping = false;
    refreshInteractivity();
  }
}

function seatOrigin(seat) {
  const g = seatGeom(seat);
  return { x: g.handCx - g.cw / 2, y: g.handY };
}

async function playback(nextView, events) {
  const prev = view;
  for (const ev of events) {
    switch (ev.e) {
      case 'setUp': case 'unsetUp': {
        if (ev.seat !== mode.mySeat) sfx('place');
        break;
      }
      case 'start': {
        view = nextView; render();
        msg(ev.seat === mode.mySeat ? 'Everyone is ready — you start!' : `Everyone is ready — ${names[ev.seat]} starts`);
        await sleep(500);
        break;
      }
      case 'played': {
        const o = seatOrigin(ev.seat);
        const el = getCardEl(ev.card, o.x, o.y);
        if (!(ev.card in jitters)) jitters[ev.card] = Math.random() * 28 - 14;
        setCardFace(el, ev.card);
        place(el, POS.pile.x - CW / 2, POS.pile.y, jitters[ev.card], 400, true);
        el.classList.add('pop');
        setTimeout(() => el.classList.remove('pop'), 320);
        sfx('place');
        await sleep(330);
        break;
      }
      case 'burned': {
        sfx('shove');
        msg(ev.seat === mode.mySeat ? 'Burn! You go again' : `${names[ev.seat]} burns the pile!`);
        await sleep(420);
        break;
      }
      case 'reset': {
        msg(ev.seat === mode.mySeat ? 'Pile reset' : `${names[ev.seat]} resets the pile`);
        break;
      }
      case 'drew': {
        sfx('slide');
        await sleep(160);
        break;
      }
      case 'flipped': {
        // reveal the blind card at its slot before it moves
        const g = seatGeom(ev.seat);
        const key = `down-${ev.seat}-${ev.slot}`;
        const ghost = ghostEls.get(key);
        if (ghost) { ghostEls.delete(key); ghost.remove(); }
        const el = getCardEl(ev.card, g.slotX[ev.slot] - g.cw / 2, g.castleY);
        setCardFace(el, ev.card);
        place(el, g.slotX[ev.slot] - g.cw / 2, g.castleY, 0, 500, true, g.cw, g.ch);
        el.classList.add('pop');
        setTimeout(() => el.classList.remove('pop'), 320);
        sfx('slide');
        await sleep(700);
        if (!ev.ok) {
          msg(ev.seat === mode.mySeat
            ? `The ${rankName(E.valueOf(ev.card))} doesn't play — you pick everything up`
            : `${names[ev.seat]} flips a ${rankName(E.valueOf(ev.card))} — it fails!`);
        } else if (ev.seat === mode.mySeat) {
          msg(`Lucky flip — the ${rankName(E.valueOf(ev.card))} plays!`);
        }
        break;
      }
      case 'pickup': {
        sfx('fan');
        if (!ev.flipped) msg(ev.seat === mode.mySeat ? 'You pick up the pile' : `${names[ev.seat]} picks up the pile`);
        // sweep pile toward the seat
        const o = seatOrigin(ev.seat);
        if (prev) for (const id of prev.pile) {
          const el = cardEls.get(id);
          if (el) place(el, o.x, o.y, 0, 300, false);
        }
        await sleep(420);
        break;
      }
      case 'finished': {
        msg(ev.seat === mode.mySeat
          ? `You're out — ${placeName(ev.place, nextView.n)} place!`
          : `${names[ev.seat]} is out — ${placeName(ev.place, nextView.n)} place`);
        await sleep(600);
        break;
      }
      case 'turn': break;
      case 'over': {
        view = nextView; render();
        await sleep(700);
        showOver(ev);
        break;
      }
    }
  }
  view = nextView;
  render();
}

// ===== game over =====
function showOver(ev) {
  stopTimerDisplay();
  const list = $('#standings');
  list.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉', '💀'];
  for (const st of ev.standings) {
    const li = document.createElement('li');
    const isMe = st.seat === mode.mySeat;
    li.innerHTML = `<span class="medal">${st.place === view.n ? '💀' : medals[st.place - 1]}</span>${esc(names[st.seat] || 'Player')}${isMe ? ' (you)' : ''}`;
    if (isMe) li.classList.add('me');
    list.appendChild(li);
  }
  const myPlace = ev.standings.find((s) => s.seat === mode.mySeat).place;
  $('#over-title').textContent = myPlace === 1 ? 'You win! 🏰' : (myPlace < view.n ? 'Well fought' : 'You lose');
  $('#over-text').textContent = ev.stalemate ? 'Deadlock — nobody could make progress, so fewest cards wins.' : '';
  $('#again-btn').classList.toggle('hidden', mode.kind !== 'local');
  $('#rematch-btn').classList.toggle('hidden', !(mode.kind === 'online' && mode.host === mode.mySeat));
  $('#over-screen').classList.remove('hidden');
}

// ===== input =====
function sendAction(a) {
  if (mode.kind === 'local') {
    const r = E.applyAction(mode.state, mode.mySeat, a);
    if (!r.ok) return r;
    pushView(E.viewFor(mode.state, mode.mySeat), E.censorEvents(r.events, mode.mySeat));
    runBots();
    return r;
  }
  mode.ws.send(JSON.stringify({ t: 'action', a }));
  return { ok: true };
}

function rejectCard(id) {
  const el = cardEls.get(id);
  if (el) {
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 320);
  }
  const t = view.pile.length ? E.valueOf(view.pile[view.pile.length - 1]) : 0;
  msg(`A ${rankName(E.valueOf(id))} can't beat a ${rankName(t)}`);
}

function onCardClick(id) {
  if (!mode || !view || pumping) return;
  const me = view.players[mode.mySeat];

  if (view.phase === 'setup' && !me.setupDone) {
    if (me.hand.includes(id)) { sfx('place'); sendAction({ type: 'up', card: id }); }
    else if (me.up.includes(id)) { sfx('slide'); sendAction({ type: 'unup', card: id }); }
    return;
  }
  if (view.phase !== 'play' || view.turn !== mode.mySeat) return;
  const zone = myZone();
  if (zone === 'hand' && me.hand.includes(id)) {
    if (!canPlayId(id)) return rejectCard(id);
    sendAction({ type: 'play', card: id });
  } else if (zone === 'up' && me.up.includes(id)) {
    if (!canPlayId(id)) return rejectCard(id);
    sendAction({ type: 'play', card: id });
  }
}

function onDownClick(seat, slot) {
  if (!mode || !view || pumping) return;
  if (seat !== mode.mySeat || view.phase !== 'play' || view.turn !== mode.mySeat) return;
  if (myZone() !== 'down') return;
  sendAction({ type: 'flip', slot });
}

pickupBtn.addEventListener('click', () => {
  if (!mode || !view || pumping || view.phase !== 'play' || view.turn !== mode.mySeat) return;
  sendAction({ type: 'pickup' });
});

autoBtn.addEventListener('click', () => {
  if (!mode || !view || view.phase !== 'setup') return;
  const me = view.players[mode.mySeat];
  if (me.setupDone) return;
  const need = 3 - me.up.filter((c) => c !== null).length;
  const score = (id) => { const v = E.valueOf(id); return (v === 2 || v === 8) ? 100 + v : v; };
  const picks = me.hand.slice().sort((a, b) => score(b) - score(a)).slice(0, need);
  sfx('place');
  for (const id of picks) sendAction({ type: 'up', card: id });
});

// ===== seat furniture (panels, slots, labels) =====
function buildTable() {
  $('#panels').innerHTML = '';
  $('#slots').innerHTML = '';
  for (let s = 0; s < view.n; s++) {
    const g = seatGeom(s);
    if (g.panel) {
      const div = document.createElement('div');
      div.className = 'seat-panel';
      div.dataset.seat = s;
      Object.assign(div.style, { left: g.panel.x + 'px', top: g.panel.y + 'px', width: g.panel.w + 'px', height: g.panel.h + 'px' });
      $('#panels').appendChild(div);
    }
    const nm = document.createElement('div');
    nm.className = 'seat-name';
    nm.dataset.seat = s;
    nm.style.left = g.nameX + 'px';
    nm.style.top = g.nameY + 'px';
    if (g.me) nm.style.transform = 'none';
    $('#panels').appendChild(nm);
    for (let k = 0; k < 3; k++) {
      const slot = document.createElement('div');
      slot.className = 'castle-slot';
      Object.assign(slot.style, {
        left: (g.slotX[k] - g.cw / 2 - 5) + 'px', top: (g.castleY - 5) + 'px',
        width: (g.cw + 10) + 'px', height: (g.ch + 10) + 'px',
      });
      $('#slots').appendChild(slot);
    }
  }
}

function clearTable() {
  for (const [, el] of cardEls) el.remove();
  for (const [, el] of ghostEls) el.remove();
  cardEls.clear();
  ghostEls.clear();
  jitters = {};
  queue = [];
  $('#panels').innerHTML = '';
  $('#slots').innerHTML = '';
  msgEl.classList.remove('show');
  stopTimerDisplay();
  pickupBtn.classList.add('hidden');
  autoBtn.classList.add('hidden');
  $('#chat-bar').classList.add('hidden');
}

// ===== local (practice) mode =====
let practiceN = 2;
let botsRunning = false;

function startLocal() {
  clearTable();
  const state = E.createGame(practiceN);
  mode = { kind: 'local', state, mySeat: 0 };
  names = ['You'];
  seatBots = [false];
  seatConn = [true];
  for (let i = 1; i < practiceN; i++) { names.push(BOT_NAMES[i - 1]); seatBots.push(true); seatConn.push(true); }
  view = E.viewFor(state, 0);
  buildTable();
  sfx('shuffle');
  render();
  msg('Choose 3 cards to place face-up on your castle', true);
  runBots();
}

async function runBots() {
  if (botsRunning || !mode || mode.kind !== 'local') return;
  botsRunning = true;
  try {
    for (;;) {
      const state = mode.state;
      if (state.phase === 'over') break;
      let acted = false;
      for (let s = 1; s < state.n; s++) {
        const a = E.botAction(state, s);
        if (!a) continue;
        await sleep(state.phase === 'setup' ? 350 : 750);
        if (!mode || mode.kind !== 'local' || mode.state !== state) return;
        const r = E.applyAction(state, s, a);
        if (r.ok) pushView(E.viewFor(state, 0), E.censorEvents(r.events, 0));
        acted = true;
        break;
      }
      if (!acted) break;
    }
  } finally {
    botsRunning = false;
  }
}

// ===== online mode =====
// resolution order: explicit ?server= override (handy for dev/testing),
// then the deployed config.js value, then a localhost fallback for development
const SERVER_URL = new URLSearchParams(location.search).get('server')
  || (window.CASTLES_SERVER && window.CASTLES_SERVER.trim())
  || (['localhost', '127.0.0.1'].includes(location.hostname) ? 'ws://localhost:8902' : '');

function setOnlineStatus(text, ok) {
  const el = $('#online-status');
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function saveSession(data) {
  try { sessionStorage.setItem('castles-room', JSON.stringify({ ...data, at: Date.now() })); } catch (e) {}
}
function loadSession() {
  try {
    const d = JSON.parse(sessionStorage.getItem('castles-room'));
    if (d && Date.now() - d.at < 2 * 3600 * 1000) return d;
  } catch (e) {}
  return null;
}
function clearSession() {
  try { sessionStorage.removeItem('castles-room'); } catch (e) {}
}

function connect(onOpen) {
  if (!SERVER_URL) {
    setOnlineStatus('Online play is not configured for this build.');
    return null;
  }
  let ws;
  try { ws = new WebSocket(SERVER_URL); } catch (e) {
    setOnlineStatus('Could not reach the game server.');
    return null;
  }
  ws.addEventListener('open', () => onOpen(ws));
  ws.addEventListener('message', (m) => onServerMessage(ws, m));
  ws.addEventListener('close', () => onSocketClose(ws));
  ws.addEventListener('error', () => {});
  return ws;
}

function onServerMessage(ws, m) {
  let d;
  try { d = JSON.parse(m.data); } catch (e) { return; }

  if (d.t === 'error') {
    setOnlineStatus(d.msg);
    if (mode && mode.kind === 'online' && view) msg(d.msg);
    return;
  }
  if (d.t === 'room') {
    // seat/token assignment or lobby update
    if (!mode || mode.kind !== 'online' || mode.ws !== ws) {
      mode = { kind: 'online', ws, mySeat: d.seat, code: d.code, token: d.token, host: d.host, deadline: 0 };
    }
    mode.mySeat = d.seat !== undefined ? d.seat : mode.mySeat;
    mode.host = d.host;
    if (d.token) mode.token = d.token;
    names = d.players.map((p) => p.name);
    seatBots = d.players.map((p) => !!p.bot);
    seatConn = d.players.map((p) => !!p.connected);
    saveSession({ code: d.code, token: mode.token, name: names[mode.mySeat] });
    if (!d.started) {
      showLobby(d);
    } else if (view) {
      updateLabels();
    }
    return;
  }
  if (d.t === 'state') {
    hideAllOverlays();
    $('#chat-bar').classList.remove('hidden');
    mode.deadline = d.deadlineMs ? Date.now() + d.deadlineMs : 0;
    if (!view || d.view.phase === 'setup' && view.phase === 'over') {
      // fresh game (first state or rematch)
      clearTableSoft();
      view = d.view;
      buildTable();
      sfx('shuffle');
      render();
      if (view.phase === 'setup') msg('Choose 3 cards to place face-up on your castle', true);
      startTimerDisplay();
      pushView(d.view, []);
    } else {
      pushView(d.view, d.events || []);
    }
    return;
  }
  if (d.t === 'chat') {
    showBubble(d.seat, CHAT_PHRASES[d.i] || '…');
    return;
  }
  if (d.t === 'gone') {
    msg('The room was closed');
    leaveToTitle();
  }
}

function clearTableSoft() {
  for (const [, el] of cardEls) el.remove();
  for (const [, el] of ghostEls) el.remove();
  cardEls.clear();
  ghostEls.clear();
  jitters = {};
  queue = [];
}

let reconnectTries = 0;
function onSocketClose(ws) {
  if (!mode || mode.kind !== 'online' || mode.ws !== ws) return;
  if (!view) {
    // lost connection in lobby
    showScreen('online');
    setOnlineStatus('Connection lost.');
    mode = null;
    return;
  }
  if (view.phase === 'over') { return; }
  $('#reconnect-screen').classList.remove('hidden');
  attemptRejoin();
}

async function attemptRejoin() {
  const sess = loadSession();
  if (!sess) { leaveToTitle(); return; }
  reconnectTries = 0;
  const tryOnce = () => {
    if (!$('#reconnect-screen') || $('#reconnect-screen').classList.contains('hidden')) return;
    if (++reconnectTries > 15) {
      $('#reconnect-status').textContent = 'Could not reconnect.';
      return;
    }
    $('#reconnect-status').textContent = `Trying to reconnect… (${reconnectTries})`;
    const ws = connect((ws) => {
      ws.send(JSON.stringify({ t: 'rejoin', code: sess.code, token: sess.token }));
    });
    if (!ws) return;
    ws.addEventListener('message', function onMsg(m) {
      let d;
      try { d = JSON.parse(m.data); } catch (e) { return; }
      if (d.t === 'room') {
        mode = { kind: 'online', ws, mySeat: d.seat, code: d.code, token: sess.token, host: d.host, deadline: 0 };
        $('#reconnect-screen').classList.add('hidden');
        view = null; // full state will arrive next
        ws.removeEventListener('message', onMsg);
      } else if (d.t === 'error') {
        ws.close();
      }
    });
    ws.addEventListener('close', () => setTimeout(tryOnce, 2500));
  };
  tryOnce();
}

function showBubble(seat, text) {
  const g = seatGeom(seat);
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  b.style.left = g.bubble.x + 'px';
  b.style.top = g.bubble.y + 'px';
  $('#bubbles').appendChild(b);
  setTimeout(() => b.classList.add('fade'), 2100);
  setTimeout(() => b.remove(), 2600);
}

let lastChat = 0;
document.querySelectorAll('.btn-chat').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!mode || mode.kind !== 'online') return;
    if (Date.now() - lastChat < 1500) return;
    lastChat = Date.now();
    mode.ws.send(JSON.stringify({ t: 'chat', i: +btn.dataset.chat }));
    showBubble(mode.mySeat, CHAT_PHRASES[+btn.dataset.chat]);
  });
});

// ===== screens =====
function showScreen(name) {
  for (const id of ['title-screen', 'online-screen', 'lobby-screen', 'rules-screen', 'over-screen', 'reconnect-screen']) {
    $('#' + id).classList.toggle('hidden', id !== name + '-screen');
  }
}
function hideAllOverlays() {
  for (const id of ['title-screen', 'online-screen', 'lobby-screen', 'over-screen', 'reconnect-screen']) {
    $('#' + id).classList.add('hidden');
  }
}

function showLobby(d) {
  showScreen('lobby');
  $('#lobby-code').textContent = d.code;
  const ul = $('#lobby-players');
  ul.innerHTML = '';
  d.players.forEach((p, s) => {
    const li = document.createElement('li');
    li.innerHTML = `${esc(p.name)}${s === mode.mySeat ? ' <span class="you">(you)</span>' : ''}${p.connected ? '' : ' <span class="off">— disconnected</span>'}`;
    ul.appendChild(li);
  });
  const isHost = mode.host === mode.mySeat;
  $('#start-btn').classList.toggle('hidden', !isHost);
  $('#start-btn').disabled = d.players.length < 2;
  $('#lobby-status').textContent = isHost
    ? (d.players.length < 2 ? 'Waiting for at least one more player…' : 'Ready when you are!')
    : `Waiting for ${names[mode.host] || 'the host'} to start…`;
  $('#lobby-status').classList.add('ok');
  // invite links only make sense outside an iframe (itch.io doesn't forward them)
  $('#link-wrap').classList.toggle('hidden', window.top !== window.self);
}

function leaveToTitle() {
  if (mode && mode.kind === 'online' && mode.ws) {
    try { mode.ws.close(); } catch (e) {}
  }
  clearSession();
  mode = null;
  view = null;
  clearTable();
  showScreen('title');
}

// ----- ui wiring -----
document.querySelectorAll('.btn-count').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-count').forEach((b) => b.classList.remove('sel'));
    btn.classList.add('sel');
    practiceN = +btn.dataset.count;
  });
});

$('#practice-btn').addEventListener('click', () => { hideAllOverlays(); startLocal(); });
$('#online-btn').addEventListener('click', () => {
  showScreen('online');
  setOnlineStatus(SERVER_URL ? '' : 'Online play is not configured for this build.');
  $('#rejoin-btn').classList.toggle('hidden', !loadSession());
  $('#name-input').value = localStorage.getItem('castles-name') || '';
});
$('#rules-btn').addEventListener('click', () => $('#rules-screen').classList.remove('hidden'));
$('#help-btn').addEventListener('click', () => $('#rules-screen').classList.remove('hidden'));
$('#rules-close-btn').addEventListener('click', () => {
  $('#rules-screen').classList.add('hidden');
  if (!mode) showScreen('title');
});
$('#online-back-btn').addEventListener('click', () => showScreen('title'));

function myName() {
  const v = $('#name-input').value.trim().slice(0, 14);
  if (!v) { setOnlineStatus('Enter a name first.'); return null; }
  localStorage.setItem('castles-name', v);
  return v;
}

$('#create-btn').addEventListener('click', () => {
  const name = myName();
  if (!name) return;
  setOnlineStatus('Connecting…', true);
  connect((ws) => ws.send(JSON.stringify({ t: 'create', name })));
});
$('#join-btn').addEventListener('click', joinRoom);
$('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
function joinRoom() {
  const name = myName();
  if (!name) return;
  const code = $('#code-input').value.trim().toUpperCase();
  if (code.length !== 4) { setOnlineStatus('Room codes are 4 letters.'); return; }
  setOnlineStatus('Connecting…', true);
  connect((ws) => ws.send(JSON.stringify({ t: 'join', code, name })));
}
$('#rejoin-btn').addEventListener('click', () => {
  const sess = loadSession();
  if (!sess) return;
  setOnlineStatus('Rejoining…', true);
  connect((ws) => ws.send(JSON.stringify({ t: 'rejoin', code: sess.code, token: sess.token })));
});

$('#start-btn').addEventListener('click', () => {
  if (mode && mode.kind === 'online') mode.ws.send(JSON.stringify({ t: 'start' }));
});
$('#lobby-leave-btn').addEventListener('click', leaveToTitle);
$('#copy-link').addEventListener('click', (e) => {
  e.preventDefault();
  const url = `${location.origin}${location.pathname}?room=${mode ? mode.code : ''}`;
  navigator.clipboard?.writeText(url).then(
    () => { $('#lobby-status').textContent = 'Link copied!'; },
    () => { $('#lobby-status').textContent = url; },
  );
});

$('#again-btn').addEventListener('click', () => { $('#over-screen').classList.add('hidden'); startLocal(); });
$('#rematch-btn').addEventListener('click', () => {
  if (mode && mode.kind === 'online') mode.ws.send(JSON.stringify({ t: 'rematch' }));
});
$('#over-leave-btn').addEventListener('click', leaveToTitle);
$('#reconnect-leave-btn').addEventListener('click', leaveToTitle);
$('#leave-btn').addEventListener('click', leaveToTitle);

const muteBtn = $('#mute-btn');
function renderMute() { muteBtn.innerHTML = muted ? '&#128263;' : '&#128266;'; }
muteBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('castles-muted', muted ? '1' : '0');
  renderMute();
});
renderMute();

// ===== static zone positioning & scaling =====
function positionZones() {
  const set = (el, x, y) => { el.style.left = `${x - CW / 2 - 5}px`; el.style.top = `${y - 5}px`; };
  set($('#deck-zone'), POS.deck.x, POS.deck.y);
  set($('#pile-zone'), POS.pile.x, POS.pile.y);
  set($('#burn-zone'), POS.burn.x, POS.burn.y);
  msgEl.style.left = POS.msg.x + 'px';
  msgEl.style.top = POS.msg.y + 'px';
  msgEl.style.transform = 'translateX(-50%)';
  timerEl.style.left = POS.timer.x + 'px';
  timerEl.style.top = POS.timer.y + 'px';
  timerEl.style.transform = 'translateX(-50%)';
  pickupBtn.style.left = POS.pickup.x + 'px';
  pickupBtn.style.top = POS.pickup.y + 'px';
  pickupBtn.style.transform = 'translateX(-50%)';
}

function rescale() {
  const s = Math.min(window.innerWidth / W, window.innerHeight / H);
  stage.style.transform = `translate(${-W * s / 2}px, ${-H * s / 2}px) scale(${s})`;
}
window.addEventListener('resize', rescale);
positionZones();
rescale();

// deep link: ?room=CODE opens the join screen with the code prefilled
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam && roomParam.length === 4) {
  showScreen('online');
  $('#code-input').value = roomParam.toUpperCase();
  $('#name-input').value = localStorage.getItem('castles-name') || '';
  setOnlineStatus(SERVER_URL ? 'Enter your name and hit Join!' : 'Online play is not configured for this build.', true);
}

// test hook (used by automated browser tests; harmless in production)
window.__castles = {
  get mode() { return mode; },
  get view() { return view; },
  get pumping() { return pumping; },
  get cardEls() { return cardEls; },
  get ghostEls() { return ghostEls; },
  engine: E,
};
