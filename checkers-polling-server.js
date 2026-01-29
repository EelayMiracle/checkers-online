import express from 'express';
import { nanoid } from 'nanoid';
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static('public'));

const rooms = {};

function createInitialBoard() {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  for (let y = 0; y < 3; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2) b[y][x] = { color: 'black', king: false };
  for (let y = 5; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2) b[y][x] = { color: 'white', king: false };
  return b;
}

function isClearDiagonal(board, from, to) {
  const dx = Math.sign(to.x - from.x), dy = Math.sign(to.y - from.y);
  let x = from.x + dx, y = from.y + dy;
  while (x !== to.x) {
    if (board[y][x]) return false;
    x += dx; y += dy;
  }
  return true;
}

function hasAnyCaptureOnBoard(board, pos, piece) {
  const dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const inBounds = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;

  if (piece.king) {
    for (const [dX, dY] of dirs) {
      let x = pos.x + dX, y = pos.y + dY;
      while (inBounds(x, y)) {
        const t = board[y][x];
        if (!t) {
          x += dX; y += dY;
          continue;
        }
        if (t.color === piece.color) break;
        x += dX; y += dY;
        while (inBounds(x, y)) {
          const t2 = board[y][x];
          if (!t2) return true;
          break;
        }
        break;
      }
    }
    return false;
  }

  for (const [dX, dY] of dirs) {
    const mx = pos.x + dX, my = pos.y + dY;
    const tx = pos.x + 2 * dX, ty = pos.y + 2 * dY;
    if (!inBounds(tx, ty)) continue;
    const mid = board?.[my]?.[mx];
    if (mid && mid.color !== piece.color && !board[ty][tx]) return true;
  }
  return false;
}

function getCaptures(room, pos, piece) {
  const dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const res = [];
  if (piece.king) {
    const inBounds = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
    const cloneBoard = (board) => board.map(row => row.map(p => p ? { ...p } : null));

    for (const [dX, dY] of dirs) {
      let x = pos.x + dX, y = pos.y + dY;
      let enemy = null;
      while (inBounds(x, y)) {
        const t = room.board[y][x];
        if (t) {
          if (t.color === piece.color) break;
          enemy = { x, y };
          break;
        }
        x += dX; y += dY;
      }

      if (!enemy) continue;

      const landings = [];
      x = enemy.x + dX; y = enemy.y + dY;
      while (inBounds(x, y) && !room.board[y][x]) {
        landings.push({ x, y });
        x += dX; y += dY;
      }
      if (landings.length === 0) continue;

      const landingWithContinuation = [];
      for (const landing of landings) {
        const sim = cloneBoard(room.board);
        sim[pos.y][pos.x] = null;
        sim[enemy.y][enemy.x] = null;
        sim[landing.y][landing.x] = { ...piece };
        if (hasAnyCaptureOnBoard(sim, { x: landing.x, y: landing.y }, sim[landing.y][landing.x])) landingWithContinuation.push(landing);
      }

      const allowedLandings = landingWithContinuation.length > 0 ? landingWithContinuation : landings;
      for (const landing of allowedLandings) {
        res.push({ from: pos, over: enemy, to: { x: landing.x, y: landing.y } });
      }
    }
  } else {
    for (const [dX, dY] of dirs) {
      const mx = pos.x + dX, my = pos.y + dY;
      const tx = pos.x + 2 * dX, ty = pos.y + 2 * dY;
      if (tx < 0 || tx > 7 || ty < 0 || ty > 7) continue;
      const mid = room.board[my][mx];
      if (mid && mid.color !== piece.color && !room.board[ty][tx])
        res.push({ from: pos, over: { x: mx, y: my }, to: { x: tx, y: ty } });
    }
  }
  return res;
}

function playerMustCapture(room, color) {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = room.board[y][x];
    if (p && p.color === color && getCaptures(room, { x, y }, p).length) return true;
  }
  return false;
}

app.get('/room/create', (req, res) => {
  const id = nanoid(6);
  rooms[id] = {
    id,
    board: createInitialBoard(),
    clientToSeat: {},
    connected: { p1: false, p2: false },
    colors: { p1: 'white', p2: 'black' },
    profiles: {
      p1: { avatar: '??', name: '' },
      p2: { avatar: '??', name: '' },
    },
    turn: 'white',
    mustContinue: null,
    gameId: 1,
    // === ?????: ??? ????????????? ?????? ===
    lastMoveId: 0,
    lastMoveSound: null,  // 'move' | 'capture' | 'king'
    lastMoveBy: null,     // 'white' | 'black'
  };
  res.json({ roomId: id });
});

app.get('/room/:id/join', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const clientId = (req.query.clientId || '').toString().trim();
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const existingSeat = room.clientToSeat[clientId];
  if (existingSeat === 1) {
    room.connected.p1 = true;
    return res.json({ seat: 1, color: room.colors.p1 });
  }
  if (existingSeat === 2) {
    room.connected.p2 = true;
    return res.json({ seat: 2, color: room.colors.p2 });
  }

  if (!room.connected.p1) {
    room.clientToSeat[clientId] = 1;
    room.connected.p1 = true;
    return res.json({ seat: 1, color: room.colors.p1 });
  }
  if (!room.connected.p2) {
    room.clientToSeat[clientId] = 2;
    room.connected.p2 = true;
    return res.json({ seat: 2, color: room.colors.p2 });
  }

  return res.status(400).json({ error: 'Room full' });
});

app.post('/room/:id/profile', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { clientId, name, avatar } = req.body || {};
  const cid = (clientId || '').toString().trim();
  if (!cid) return res.status(400).json({ error: 'clientId required' });

  const seat = room.clientToSeat[cid];
  if (seat !== 1 && seat !== 2) return res.status(400).json({ error: 'Not joined' });
  const seatKey = seat === 1 ? 'p1' : 'p2';

  const safeName = (name || '').toString().trim().slice(0, 32);
  const safeAvatar = (avatar || '').toString().trim().slice(0, 4);
  room.profiles[seatKey] = {
    name: safeName,
    avatar: safeAvatar || room.profiles[seatKey]?.avatar || '??',
  };

  res.json({ ok: true, seat, profile: room.profiles[seatKey] });
});

app.get('/room/:id/state', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    id: room.id,
    board: room.board,
    turn: room.turn,
    mustContinue: room.mustContinue,
    connected: room.connected,
    profiles: room.profiles,
    colors: room.colors,
    gameId: room.gameId,
    // === ????? ===
    lastMoveId: room.lastMoveId,
    lastMoveSound: room.lastMoveSound,
    lastMoveBy: room.lastMoveBy,
  });
});

app.post('/room/:id/rematch', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const prevP1 = room.colors.p1;
  room.colors.p1 = room.colors.p2;
  room.colors.p2 = prevP1;

  room.board = createInitialBoard();
  room.turn = 'white';
  room.mustContinue = null;
  room.gameId = (room.gameId || 1) + 1;
  
  // === ?????: ????? ?????? ===
  room.lastMoveId = 0;
  room.lastMoveSound = null;
  room.lastMoveBy = null;

  res.json({ ok: true, gameId: room.gameId });
});

app.post('/room/:id/move', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { from, to, player } = req.body;
  const piece = room.board[from.y][from.x];
  if (!piece || piece.color !== player) return res.status(400).json({ error: '?? ???? ?????' });
  if (room.turn !== player) return res.status(400).json({ error: '?? ??? ???' });

  const dx = to.x - from.x, dy = to.y - from.y;
  const absx = Math.abs(dx), absy = Math.abs(dy);
  const mustCapture = playerMustCapture(room, player);
  const captures = getCaptures(room, from, piece);
  const isCaptureMove = captures.some(c => c.to.x === to.x && c.to.y === to.y);

  // === ?????: ??????????, ???? ?? ????? ?????? ?? ???? ===
  const wasKing = piece.king;

  if (isCaptureMove) {
    const cap = captures.find(c => c.to.x === to.x && c.to.y === to.y);
    room.board[cap.over.y][cap.over.x] = null;
    room.board[to.y][to.x] = piece;
    room.board[from.y][from.x] = null;

    if (!piece.king && ((piece.color === 'white' && to.y === 0) || (piece.color === 'black' && to.y === 7))) piece.king = true;

    // === ?????: ?????????? ???? ===
    const becameKing = !wasKing && piece.king;
    const soundType = becameKing ? 'king' : 'capture';
    room.lastMoveId++;
    room.lastMoveSound = soundType;
    room.lastMoveBy = player;

    const more = getCaptures(room, { x: to.x, y: to.y }, piece);
    if (more.length > 0) {
      room.mustContinue = { x: to.x, y: to.y, player };
    } else {
      room.mustContinue = null;
      room.turn = player === 'white' ? 'black' : 'white';
    }
    return res.json({ ok: true, board: room.board, mustContinue: room.mustContinue, turn: room.turn, lastMoveId: room.lastMoveId, lastMoveSound: room.lastMoveSound });
  }

  if (mustCapture) return res.status(400).json({ error: '?? ??????? ????' });
  if (room.board[to.y][to.x]) return res.status(400).json({ error: '?????? ??????' });
  if (absx !== absy) return res.status(400).json({ error: '??? ?????? ?? ?????????' });

  if (!piece.king) {
    const dir = piece.color === 'white' ? -1 : 1;
    if (absx !== 1 || dy !== dir) return res.status(400).json({ error: '??????? ????? ????? ?? 1 ??????' });
  } else {
    if (!isClearDiagonal(room.board, from, to)) return res.status(400).json({ error: '???? ?? ????????' });
  }

  room.board[to.y][to.x] = piece;
  room.board[from.y][from.x] = null;

  if (!piece.king && ((piece.color === 'white' && to.y === 0) || (piece.color === 'black' && to.y === 7))) piece.king = true;

  // === ?????: ?????????? ???? ??? ?????? ???? ===
  const becameKing = !wasKing && piece.king;
  const soundType = becameKing ? 'king' : 'move';
  room.lastMoveId++;
  room.lastMoveSound = soundType;
  room.lastMoveBy = player;

  room.turn = player === 'white' ? 'black' : 'white';
  room.mustContinue = null;
  res.json({ ok: true, board: room.board, mustContinue: room.mustContinue, turn: room.turn, lastMoveId: room.lastMoveId, lastMoveSound: room.lastMoveSound });
});
// =====================================================
// ================== ?????? ===========================
// =====================================================

const ugolkiRooms = {};

function createUgolkiBoard() {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  // ?????? ? ????? ??????? ???? (0-2, 0-2)
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      b[y][x] = { color: 'black' };
    }
  }
  // ????? ? ?????? ?????? ???? (5-7, 5-7)
  for (let y = 5; y < 8; y++) {
    for (let x = 5; x < 8; x++) {
      b[y][x] = { color: 'white' };
    }
  }
  return b;
}

function getUgolkiTargetZone(color) {
  const zone = [];
  if (color === 'white') {
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) zone.push({ x, y });
  } else {
    for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) zone.push({ x, y });
  }
  return zone;
}

function checkUgolkiWinner(board) {
  const whiteTarget = getUgolkiTargetZone('white');
  const whiteWin = whiteTarget.every(({ x, y }) => board[y][x]?.color === 'white');
  if (whiteWin) return 'white';

  const blackTarget = getUgolkiTargetZone('black');
  const blackWin = blackTarget.every(({ x, y }) => board[y][x]?.color === 'black');
  if (blackWin) return 'black';

  return null;
}

function getUgolkiMoves(board, pos) {
  const piece = board[pos.y][pos.x];
  if (!piece) return { steps: [], jumps: [] };

  const directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const inBounds = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
  const steps = [];
  const jumps = [];

  for (const [dx, dy] of directions) {
    const nx = pos.x + dx;
    const ny = pos.y + dy;
    if (!inBounds(nx, ny)) continue;

    if (!board[ny][nx]) {
      steps.push({ x: nx, y: ny });
    } else {
      const jx = pos.x + 2 * dx;
      const jy = pos.y + 2 * dy;
      if (inBounds(jx, jy) && !board[jy][jx]) {
        jumps.push({ x: jx, y: jy });
      }
    }
  }

  return { steps, jumps };
}

function checkUgolkiTimeout(room) {
  if (!room.jumpingFrom) return;
  
  const now = Date.now();
  const elapsed = now - room.lastActionAt;
  
  if (elapsed >= 5000) {
    const prevPlayer = room.turn;
    room.jumpingFrom = null;
    room.turn = room.turn === 'white' ? 'black' : 'white';
    room.lastActionAt = now;
    room.lastMoveId++;
    room.lastMoveSound = 'move';
    room.lastMoveBy = prevPlayer;
  }
}

app.get('/ugolki/room/create', (req, res) => {
  const id = nanoid(6);
  ugolkiRooms[id] = {
    id,
    board: createUgolkiBoard(),
    clientToSeat: {},
    connected: { p1: false, p2: false },
    colors: { p1: 'white', p2: 'black' },
    profiles: {
      p1: { avatar: '??', name: '' },
      p2: { avatar: '??', name: '' },
    },
    turn: 'white',
    jumpingFrom: null,
    lastActionAt: Date.now(),
    gameId: 1,
    winner: null,
    lastMoveId: 0,
    lastMoveSound: null,
    lastMoveBy: null,
  };
  res.json({ roomId: id });
});

app.get('/ugolki/room/:id/join', (req, res) => {
  const room = ugolkiRooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const clientId = (req.query.clientId || '').toString().trim();
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const existingSeat = room.clientToSeat[clientId];
  if (existingSeat === 1) {
    room.connected.p1 = true;
    return res.json({ seat: 1, color: room.colors.p1 });
  }
  if (existingSeat === 2) {
    room.connected.p2 = true;
    return res.json({ seat: 2, color: room.colors.p2 });
  }

  if (!room.connected.p1) {
    room.clientToSeat[clientId] = 1;
    room.connected.p1 = true;
    return res.json({ seat: 1, color: room.colors.p1 });
  }
  if (!room.connected.p2) {
    room.clientToSeat[clientId] = 2;
    room.connected.p2 = true;
    return res.json({ seat: 2, color: room.colors.p2 });
  }

  return res.status(400).json({ error: 'Room full' });
});

app.post('/ugolki/room/:id/profile', (req, res) => {
  const room = ugolkiRooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { clientId, name, avatar } = req.body || {};
  const cid = (clientId || '').toString().trim();
  if (!cid) return res.status(400).json({ error: 'clientId required' });

  const seat = room.clientToSeat[cid];
  if (seat !== 1 && seat !== 2) return res.status(400).json({ error: 'Not joined' });
  const seatKey = seat === 1 ? 'p1' : 'p2';

  const safeName = (name || '').toString().trim().slice(0, 32);
  const safeAvatar = (avatar || '').toString().trim().slice(0, 4);
  room.profiles[seatKey] = {
    name: safeName,
    avatar: safeAvatar || room.profiles[seatKey]?.avatar || '??',
  };

  res.json({ ok: true, seat, profile: room.profiles[seatKey] });
});

app.get('/ugolki/room/:id/state', (req, res) => {
  const room = ugolkiRooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  checkUgolkiTimeout(room);

  if (!room.winner) {
    room.winner = checkUgolkiWinner(room.board);
  }

  res.json({
    id: room.id,
    board: room.board,
    turn: room.turn,
    jumpingFrom: room.jumpingFrom,
    lastActionAt: room.lastActionAt,
    connected: room.connected,
    profiles: room.profiles,
    colors: room.colors,
    gameId: room.gameId,
    winner: room.winner,
    lastMoveId: room.lastMoveId,
    lastMoveSound: room.lastMoveSound,
    lastMoveBy: room.lastMoveBy,
  });
});

app.post('/ugolki/room/:id/move', (req, res) => {
  const room = ugolkiRooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  checkUgolkiTimeout(room);

  if (room.winner) return res.status(400).json({ error: '???? ????????' });

  const { from, to, player } = req.body;
  
  if (room.turn !== player) return res.status(400).json({ error: '?? ??? ???' });

  if (room.jumpingFrom) {
    if (from.x !== room.jumpingFrom.x || from.y !== room.jumpingFrom.y) {
      return res.status(400).json({ error: '??????????? ??????? ???? ?????? ??? ????????? ???' });
    }
  }

  const piece = room.board[from.y][from.x];
  if (!piece || piece.color !== player) return res.status(400).json({ error: '?? ???? ?????' });

  const { steps, jumps } = getUgolkiMoves(room.board, from);

  const isJump = jumps.some(j => j.x === to.x && j.y === to.y);
  const isStep = steps.some(s => s.x === to.x && s.y === to.y);

  if (!isJump && !isStep) {
    return res.status(400).json({ error: '???????????? ???' });
  }

  if (room.jumpingFrom && isStep) {
    return res.status(400).json({ error: '????? ?????? ????? ?????? ??????? ??? ????????? ???' });
  }

  room.board[to.y][to.x] = piece;
  room.board[from.y][from.x] = null;
  room.lastActionAt = Date.now();
  room.lastMoveId++;
  room.lastMoveSound = isJump ? 'capture' : 'move';
  room.lastMoveBy = player;

  if (isJump) {
    const { jumps: nextJumps } = getUgolkiMoves(room.board, to);
    if (nextJumps.length > 0) {
      room.jumpingFrom = { x: to.x, y: to.y };
    } else {
      room.jumpingFrom = null;
      room.turn = player === 'white' ? 'black' : 'white';
    }
  } else {
    room.jumpingFrom = null;
    room.turn = player === 'white' ? 'black' : 'white';
  }

  room.winner = checkUgolkiWinner(room.board);

  res.json({
    ok: true,
    board: room.board,
    turn: room.turn,
    jumpingFrom: room.jumpingFrom,
    winner: room.winner,
    lastMoveId: room.lastMoveId,
    lastMoveSound: room.lastMoveSound,
  });
});

app.post('/ugolki/room/:id/endTurn', (req, res) => {
  const room = ugolkiRooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { player } = req.body;

  if (room.turn !== player) return res.status(400).json({ error: '?? ??? ???' });
  if (!room.jumpingFrom) return res.status(400).json({ error: '?????? ?????????' });

  room.jumpingFrom = null;
  room.turn = player === 'white' ? 'black' : 'white';
  room.lastActionAt = Date.now();


  res.json({ ok: true, turn: room.turn });
});

app.post('/ugolki/room/:id/rematch', (req, res) => {
  const room = ugolkiRooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const prevP1 = room.colors.p1;
  room.colors.p1 = room.colors.p2;
  room.colors.p2 = prevP1;

  room.board = createUgolkiBoard();
  room.turn = 'white';
  room.jumpingFrom = null;
  room.lastActionAt = Date.now();
  room.gameId = (room.gameId || 1) + 1;
  room.winner = null;
  room.lastMoveId = 0;
  room.lastMoveSound = null;
  room.lastMoveBy = null;

  res.json({ ok: true, gameId: room.gameId });
});
app.listen(3000, () => console.log('Server on http://localhost:3000'));