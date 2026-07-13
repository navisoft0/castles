'use strict';
/* Castles game server — authoritative referee for online rooms.
 *
 * One small Node process: WebSocket rooms in memory, no database.
 * The same rules engine the browser uses (web/engine.js) validates every
 * action here; clients only ever receive their own censored view of the game.
 *
 * Deploy: any Node host (Railway works out of the box — it provides PORT).
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('../web/engine.js');

const PORT = process.env.PORT || 8902;
const TURN_MS = +(process.env.TURN_MS || 60000);          // per-turn time limit
const SETUP_MS = +(process.env.SETUP_MS || 90000);        // setup phase time limit
const TAKEOVER_MS = +(process.env.TAKEOVER_MS || 60000);  // disconnect -> bot takeover
const ROOM_TTL_MS = +(process.env.ROOM_TTL_MS || 5 * 60 * 1000); // all-disconnected room GC
const BOT_DELAY_MS = +(process.env.BOT_DELAY_MS || 900);
const MAX_ROOMS = 500;
const MAX_MSG_BYTES = 4096;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I/L/O/0/1 lookalikes
const rooms = new Map(); // code -> room

/* room = {
 *   code, host, state (engine state or null in lobby),
 *   seats: [{ name, token, ws|null, bot, lastSeen, takeoverTimer }],
 *   turnTimer, turnDeadline, botTimer, emptySince
 * }
 */

function makeCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function roomInfoFor(room, seat) {
  return {
    t: 'room',
    code: room.code,
    seat,
    token: room.seats[seat].token,
    host: room.host,
    started: !!room.state,
    players: room.seats.map((s) => ({ name: s.name, connected: !!s.ws, bot: s.bot })),
  };
}

function broadcastRoom(room) {
  room.seats.forEach((s, i) => send(s.ws, roomInfoFor(room, i)));
}

function deadlineMsFor(room) {
  if (!room.state || room.state.phase !== 'play' || !room.turnDeadline) return 0;
  return Math.max(0, room.turnDeadline - Date.now());
}

function broadcastState(room, eventsBySeatFn) {
  const dl = deadlineMsFor(room);
  room.seats.forEach((s, i) => {
    send(s.ws, {
      t: 'state',
      view: E.viewFor(room.state, i),
      events: eventsBySeatFn ? eventsBySeatFn(i) : [],
      deadlineMs: dl,
    });
  });
}

function broadcastResult(room, events) {
  broadcastState(room, (seat) => E.censorEvents(events, seat));
}

// ---- game flow ----

function startGame(room) {
  room.state = E.createGame(room.seats.length);
  room.turnDeadline = 0;
  // anyone gone at (re)start plays as a bot until they rejoin
  for (const s of room.seats) if (!s.ws) s.bot = true;
  broadcastRoom(room); // flips started=true for clients
  broadcastState(room);
  armSetupTimer(room);
  scheduleBots(room);
}

function applyFor(room, seat, action) {
  const r = E.applyAction(room.state, seat, action);
  if (!r.ok) return r;
  afterAction(room, r.events);
  return r;
}

function afterAction(room, events) {
  const st = room.state;
  if (st.phase === 'play') {
    // any accepted action re-arms the turn clock for whoever is now on turn
    armTurnTimer(room);
  }
  if (st.phase === 'over') {
    clearTimeout(room.turnTimer);
    room.turnDeadline = 0;
  }
  broadcastResult(room, events);
  scheduleBots(room);
}

function armSetupTimer(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => {
    if (!room.state || room.state.phase !== 'setup') return;
    // auto-place for anyone still choosing
    for (let s = 0; s < room.seats.length; s++) {
      while (room.state.phase === 'setup' && !room.state.players[s].setupDone) {
        const a = E.botAction(room.state, s);
        if (!a) break;
        const r = E.applyAction(room.state, s, a);
        if (!r.ok) break;
        broadcastResult(room, r.events);
      }
    }
    if (room.state.phase === 'play') armTurnTimer(room);
    scheduleBots(room);
  }, SETUP_MS);
}

function armTurnTimer(room) {
  clearTimeout(room.turnTimer);
  room.turnDeadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_MS);
}

function onTurnTimeout(room) {
  const st = room.state;
  if (!st || st.phase !== 'play') return;
  const seat = st.turn;
  const a = E.botAction(st, seat);
  if (!a) return;
  const r = E.applyAction(st, seat, a);
  if (r.ok) afterAction(room, r.events);
}

// bots (takeover seats) act on their own clock
function scheduleBots(room) {
  clearTimeout(room.botTimer);
  const st = room.state;
  if (!st || st.phase === 'over') return;
  let due = null;
  if (st.phase === 'setup') {
    due = room.seats.findIndex((s, i) => s.bot && !st.players[i].setupDone);
    if (due === -1) due = null;
  } else if (room.seats[st.turn] && room.seats[st.turn].bot) {
    due = st.turn;
  }
  if (due === null) return;
  room.botTimer = setTimeout(() => {
    const a = E.botAction(room.state, due);
    if (a) {
      const r = E.applyAction(room.state, due, a);
      if (r.ok) { afterAction(room, r.events); return; }
    }
    scheduleBots(room);
  }, BOT_DELAY_MS);
}

// ---- connection lifecycle ----

function seatOf(room, ws) {
  return room.seats.findIndex((s) => s.ws === ws);
}

function detach(ws) {
  const { room } = ws.meta || {};
  if (!room) return;
  const seat = seatOf(room, ws);
  if (seat === -1) return;
  const s = room.seats[seat];
  s.ws = null;
  s.lastSeen = Date.now();
  if (!room.state) {
    // lobby: drop the seat entirely
    room.seats.splice(seat, 1);
    if (!room.seats.length) { destroyRoom(room); return; }
    if (room.host >= room.seats.length) room.host = 0;
    broadcastRoom(room);
    return;
  }
  broadcastRoom(room);
  if (room.state.phase !== 'over' && !s.bot) {
    clearTimeout(s.takeoverTimer);
    s.takeoverTimer = setTimeout(() => {
      if (s.ws || s.bot) return;
      s.bot = true;
      broadcastRoom(room);
      scheduleBots(room);
    }, TAKEOVER_MS);
  }
  maybeScheduleGC(room);
}

function maybeScheduleGC(room) {
  if (room.seats.some((s) => s.ws)) { room.emptySince = 0; return; }
  room.emptySince = Date.now();
}

function destroyRoom(room) {
  clearTimeout(room.turnTimer);
  clearTimeout(room.botTimer);
  for (const s of room.seats) clearTimeout(s.takeoverTimer);
  rooms.delete(room.code);
}

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.emptySince && Date.now() - room.emptySince > ROOM_TTL_MS) destroyRoom(room);
  }
}, 30000);

// ---- message handling ----

const handlers = {
  create(ws, d) {
    if (ws.meta.room) return send(ws, { t: 'error', msg: 'Already in a room.' });
    if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Server is full, try again later.' });
    const name = cleanName(d.name);
    if (!name) return send(ws, { t: 'error', msg: 'Enter a name first.' });
    const room = {
      code: makeCode(), host: 0, state: null,
      seats: [{ name, token: crypto.randomBytes(12).toString('hex'), ws, bot: false, lastSeen: Date.now() }],
      turnTimer: null, botTimer: null, turnDeadline: 0, emptySince: 0,
    };
    rooms.set(room.code, room);
    ws.meta.room = room;
    broadcastRoom(room);
  },

  join(ws, d) {
    if (ws.meta.room) return send(ws, { t: 'error', msg: 'Already in a room.' });
    const room = rooms.get(String(d.code || '').toUpperCase());
    if (!room) return send(ws, { t: 'error', msg: 'No room with that code.' });
    if (room.state) return send(ws, { t: 'error', msg: 'That game has already started.' });
    if (room.seats.length >= 4) return send(ws, { t: 'error', msg: 'That room is full.' });
    const name = cleanName(d.name);
    if (!name) return send(ws, { t: 'error', msg: 'Enter a name first.' });
    room.seats.push({ name, token: crypto.randomBytes(12).toString('hex'), ws, bot: false, lastSeen: Date.now() });
    ws.meta.room = room;
    broadcastRoom(room);
  },

  rejoin(ws, d) {
    if (ws.meta.room) return send(ws, { t: 'error', msg: 'Already in a room.' });
    const room = rooms.get(String(d.code || '').toUpperCase());
    if (!room) return send(ws, { t: 'error', msg: 'That room no longer exists.' });
    const seat = room.seats.findIndex((s) => s.token === d.token);
    if (seat === -1) return send(ws, { t: 'error', msg: 'Could not rejoin that game.' });
    const s = room.seats[seat];
    if (s.ws) { try { s.ws.close(); } catch (e) {} s.ws = null; }
    s.ws = ws;
    s.bot = false; // human takes their seat back from the bot
    clearTimeout(s.takeoverTimer);
    room.emptySince = 0;
    ws.meta.room = room;
    broadcastRoom(room);
    if (room.state) {
      send(ws, {
        t: 'state',
        view: E.viewFor(room.state, seat),
        events: [],
        deadlineMs: deadlineMsFor(room),
      });
      scheduleBots(room);
    }
  },

  start(ws) {
    const room = ws.meta.room;
    if (!room) return;
    const seat = seatOf(room, ws);
    if (seat !== room.host) return send(ws, { t: 'error', msg: 'Only the host can start the game.' });
    if (room.state) return;
    if (room.seats.length < 2) return send(ws, { t: 'error', msg: 'You need at least 2 players.' });
    startGame(room);
  },

  action(ws, d) {
    const room = ws.meta.room;
    if (!room || !room.state) return;
    const seat = seatOf(room, ws);
    if (seat === -1) return;
    const r = applyFor(room, seat, d.a || {});
    if (!r.ok) send(ws, { t: 'error', msg: r.error });
  },

  rematch(ws) {
    const room = ws.meta.room;
    if (!room || !room.state || room.state.phase !== 'over') return;
    const seat = seatOf(room, ws);
    if (seat !== room.host) return send(ws, { t: 'error', msg: 'Only the host can start a rematch.' });
    startGame(room);
  },

  chat(ws, d) {
    const room = ws.meta.room;
    if (!room) return;
    const seat = seatOf(room, ws);
    if (seat === -1) return;
    const now = Date.now();
    if (now - (ws.meta.lastChat || 0) < 1200) return;
    ws.meta.lastChat = now;
    const i = d.i | 0;
    if (i < 0 || i > 3) return;
    room.seats.forEach((s, j) => { if (j !== seat) send(s.ws, { t: 'chat', seat, i }); });
  },

  ping(ws) { send(ws, { t: 'pong' }); },
};

function cleanName(raw) {
  const name = String(raw || '').replace(/[\x00-\x1f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return name || null;
}

// ---- boot ----

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`castles server ok — ${rooms.size} room(s)\n`);
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws) => {
  ws.meta = { room: null, lastChat: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (buf) => {
    let d;
    try { d = JSON.parse(buf.toString()); } catch (e) { return; }
    const h = handlers[d.t];
    if (h) {
      try { h(ws, d); } catch (e) {
        console.error('handler error', d.t, e);
        send(ws, { t: 'error', msg: 'Server error.' });
      }
    }
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

// keepalive: terminate dead sockets so takeover timers actually run
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`castles server listening on :${PORT}`));
