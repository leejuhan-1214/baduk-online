// Board coordinates start at the upper left. Colors are 1 for black and 2 for white.
const neighborTables = new Map();
const sizes = [9, 13, 19];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function neighbors(size) {
  if (!neighborTables.has(size)) {
    const table = Array.from({ length: size * size }, (_, index) => {
      const x = index % size;
      const y = Math.floor(index / size);
      const adjacent = [];
      if (x > 0) adjacent.push(index - 1);
      if (x < size - 1) adjacent.push(index + 1);
      if (y > 0) adjacent.push(index - size);
      if (y < size - 1) adjacent.push(index + size);
      return adjacent;
    });
    neighborTables.set(size, table);
  }
  return neighborTables.get(size);
}

// Three intersections fit in a base-27 digit. This is lossless for a fixed board size.
function positionKey(board) {
  let key = '';
  for (let i = 0; i < board.length; i += 3) {
    key += String.fromCharCode(65 + board[i] + 3 * (board[i + 1] || 0) + 9 * (board[i + 2] || 0));
  }
  return key;
}

function chain(board, adjacent, start) {
  const color = board[start];
  const stones = [start];
  const visited = new Set(stones);
  const liberties = new Set();
  for (let i = 0; i < stones.length; i++) {
    for (const point of adjacent[stones[i]]) {
      if (!board[point]) liberties.add(point);
      if (board[point] === color && !visited.has(point)) {
        visited.add(point);
        stones.push(point);
      }
    }
  }
  return { color, stones, liberties };
}

function actionPoint(game, action) {
  const { x, y } = action;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= game.size || y >= game.size) {
    fail('bounds', '바둑판 위의 교차점을 선택해 주세요.');
  }
  return y * game.size + x;
}

export function createGame(size = 19) {
  if (!sizes.includes(size)) fail('size', '9줄, 13줄, 19줄 바둑판을 선택할 수 있습니다.');
  const board = Array(size * size).fill(0);
  return {
    size, board, turn: 1, phase: 'playing', moveNumber: 0, passes: 0,
    captures: { 1: 0, 2: 0 }, lastMove: null, dead: [], confirmed: [],
    result: null, komi: 6.5, history: [positionKey(board)], resumeTurn: null,
  };
}

function playStone(game, color, action) {
  const start = actionPoint(game, action);
  if (game.board[start]) fail('occupied', '이미 돌이 놓여 있습니다.');
  const board = game.board.slice();
  const adjacent = neighbors(game.size);
  const enemy = 3 - color;
  board[start] = color;
  const checked = new Set();
  let captured = 0;
  for (const point of adjacent[start]) {
    if (board[point] !== enemy || checked.has(point)) continue;
    const group = chain(board, adjacent, point);
    for (const stone of group.stones) checked.add(stone);
    if (!group.liberties.size) {
      captured += group.stones.length;
      for (const stone of group.stones) board[stone] = 0;
    }
  }
  if (!chain(board, adjacent, start).liberties.size) fail('suicide', '활로가 없는 곳에는 돌을 놓을 수 없습니다.');
  const key = positionKey(board);
  if (game.history.includes(key)) fail('superko', '이전과 같은 판 모양을 반복할 수 없습니다.');
  return {
    ...game, board, turn: enemy, passes: 0, moveNumber: game.moveNumber + 1,
    captures: { ...game.captures, [color]: game.captures[color] + captured },
    lastMove: { type: 'play', color, x: action.x, y: action.y }, history: [...game.history, key],
  };
}

export function areaScore(game) {
  const board = game.board.slice();
  for (const stone of game.dead) board[stone] = 0;
  const adjacent = neighbors(game.size);
  const visited = new Uint8Array(board.length);
  const territory = Array(board.length).fill(0);
  const totals = [0, 0, game.komi];
  for (let i = 0; i < board.length; i++) {
    if (board[i]) {
      totals[board[i]]++;
      continue;
    }
    if (visited[i]) continue;
    const region = [i];
    let border = 0;
    visited[i] = 1;
    for (let j = 0; j < region.length; j++) {
      for (const point of adjacent[region[j]]) {
        if (board[point]) border |= board[point];
        else if (!visited[point]) {
          visited[point] = 1;
          region.push(point);
        }
      }
    }
    if (border === 1 || border === 2) {
      totals[border] += region.length;
      for (const point of region) territory[point] = border;
    }
  }
  const black = totals[1], white = totals[2];
  return { black, white, margin: Math.abs(black - white), winner: black > white ? 1 : 2, territory };
}

function scoringAction(game, color, action) {
  const lastMove = { type: action.type, color };
  if (action.type === 'resume') {
    return { ...game, phase: 'playing', passes: 0, turn: game.resumeTurn, resumeTurn: null, dead: [], confirmed: [], lastMove };
  }
  if (action.type === 'markDead') {
    const start = actionPoint(game, action);
    if (!game.board[start]) fail('no_stone', '사석으로 표시할 돌을 선택해 주세요.');
    const { stones } = chain(game.board, neighbors(game.size), start);
    const dead = new Set(game.dead);
    const remove = dead.has(start);
    for (const stone of stones) {
      if (remove) dead.delete(stone);
      else dead.add(stone);
    }
    return { ...game, turn: 3 - color, dead: [...dead].sort((a, b) => a - b), confirmed: [], lastMove: { ...lastMove, x: action.x, y: action.y } };
  }
  if (action.type === 'confirmScore') {
    if (game.confirmed.includes(color)) fail('already_confirmed', '이미 계가에 동의했습니다.');
    const confirmed = [...game.confirmed, color];
    if (confirmed.length < 2) return { ...game, turn: 3 - color, confirmed, lastMove };
    const { black, white, winner, margin } = areaScore(game);
    return { ...game, phase: 'finished', confirmed, lastMove, result: { winner, reason: 'score', black, white, margin } };
  }
  fail('scoring', '계가 중입니다. 사석을 확인하거나 대국을 재개해 주세요.');
}

export function applyAction(game, color, action) {
  if (color !== 1 && color !== 2) fail('color', '올바른 대국자를 지정해 주세요.');
  if (game.phase === 'finished') fail('finished', '이미 종료된 대국입니다.');
  if (!action || typeof action.type !== 'string') fail('action', '대국 명령을 확인해 주세요.');
  if (action.type === 'resign') {
    return { ...game, phase: 'finished', lastMove: { type: 'resign', color }, result: { winner: 3 - color, reason: 'resign', black: null, white: null, margin: null } };
  }
  if (game.phase === 'scoring') return scoringAction(game, color, action);
  if (color !== game.turn) fail('turn', '상대의 차례입니다.');
  if (action.type === 'play') return playStone(game, color, action);
  if (action.type === 'pass') {
    const passes = game.passes + 1;
    const turn = 3 - color;
    return { ...game, passes, turn, moveNumber: game.moveNumber + 1, lastMove: { type: 'pass', color }, phase: passes === 2 ? 'scoring' : 'playing', resumeTurn: passes === 2 ? turn : null };
  }
  fail('action', '지금은 사용할 수 없는 대국 명령입니다.');
}

function groupMap(board, adjacent) {
  const groups = Array(board.length);
  for (let i = 0; i < board.length; i++) {
    if (!board[i] || groups[i]) continue;
    const group = chain(board, adjacent, i);
    for (const stone of group.stones) groups[stone] = group;
  }
  return groups;
}

function distanceTo(board, adjacent, color) {
  const distance = new Uint16Array(board.length).fill(board.length);
  const queue = [];
  board.forEach((value, i) => {
    if (value === color) {
      queue.push(i);
      distance[i] = 0;
    }
  });
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacent[queue[i]]) {
      if (distance[next] > distance[queue[i]] + 1) {
        distance[next] = distance[queue[i]] + 1;
        queue.push(next);
      }
    }
  }
  return distance;
}

function rankMove(index, context) {
  const { game, color, groups, adjacent, myDistance, enemyDistance, ownership, level, rng } = context;
  const x = index % game.size, y = Math.floor(index / game.size);
  const edgeX = Math.min(x, game.size - 1 - x), edgeY = Math.min(y, game.size - 1 - y);
  const contacts = new Set(adjacent[index].map(point => groups[point]).filter(Boolean));
  const liberties = new Set(adjacent[index].filter(point => !game.board[point]));
  let captured = 0, saved = 0, attacked = 0;
  for (const group of contacts) {
    if (group.color === color) {
      for (const liberty of group.liberties) if (liberty !== index) liberties.add(liberty);
      if (group.liberties.size === 1) saved += group.stones.length;
    } else if (group.liberties.size === 1) captured += group.stones.length;
    else if (group.liberties.size === 2) attacked += group.stones.length;
  }
  if (!captured && !liberties.size) return null;
  if (!captured && liberties.size < 2 && !saved) return null;
  if (ownership[index] === color && !captured && !saved) return null;
  const starLine = game.size === 9 ? 2 : 3;
  const opening = game.moveNumber < game.size;
  const corner = Math.abs(edgeX - starLine) + Math.abs(edgeY - starLine);
  const nearest = Math.min(myDistance[index], enemyDistance[index]);
  const spread = Math.min(nearest, 5);
  const edge = Math.min(edgeX, edgeY);
  const noise = [20, 5, 1.8][level] * rng();
  let score = noise + spread + Math.min(edge, 3) - (opening ? corner * 1.5 : 0);
  if (game.moveNumber > 0 && myDistance[index] >= 2 && myDistance[index] <= 4) score += 3;
  if (!opening && enemyDistance[index] <= 2 && myDistance[index] <= 3) score += 4;
  const urgency = [5, 13, 20][level];
  score += urgency * captured + urgency * 0.8 * saved + Math.min(attacked, 6) * [0.5, 2.2, 3.8][level];
  if (!captured && liberties.size === 1) score -= urgency * (saved + 2);
  if (!captured && liberties.size === 2 && enemyDistance[index] === 1) score -= level * 2;
  return { action: { type: 'play', x, y }, score, captured, saved };
}

export function chooseBotAction(game, difficulty = 'normal', rng = Math.random) {
  const color = game.turn;
  if (game.phase === 'finished') fail('finished', '이미 종료된 대국입니다.');
  if (game.phase === 'scoring') {
    // Disputed bot stones stay on the board. The players can resume to settle them by capture.
    const disputed = game.dead.find(point => game.board[point] === color);
    if (disputed !== undefined) return { type: 'markDead', x: disputed % game.size, y: Math.floor(disputed / game.size) };
    return { type: 'confirmScore' };
  }
  const tally = areaScore(game);
  if (game.passes && tally.winner === color) return { type: 'pass' };
  const adjacent = neighbors(game.size);
  const context = {
    game, color, adjacent, groups: groupMap(game.board, adjacent),
    myDistance: distanceTo(game.board, adjacent, color), enemyDistance: distanceTo(game.board, adjacent, 3 - color),
    ownership: tally.territory, level: difficulty === 'easy' ? 0 : difficulty === 'hard' ? 2 : 1, rng,
  };
  const candidates = [];
  for (let index = 0; index < game.board.length; index++) {
    if (game.board[index]) continue;
    const move = rankMove(index, context);
    if (move) candidates.push(move);
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const move of candidates) {
    try {
      applyAction(game, color, move.action);
      return move.action;
    } catch (error) {
      if (error.code !== 'superko' && error.code !== 'suicide') throw error;
    }
  }
  return { type: 'pass' };
}
