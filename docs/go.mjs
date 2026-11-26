import { territoryScoring } from './goscorer.mjs';

// Board coordinates start at the upper left. Colors are 1 for black and 2 for white.
const neighborTables = new Map();
export const BOARD_SIZE = 19;

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

export function createGame(size = BOARD_SIZE) {
  if (size !== BOARD_SIZE) fail('size', '새 대국은 19줄 바둑판에서 진행합니다.');
  const board = Array(size * size).fill(0);
  return {
    size, board, turn: 1, phase: 'playing', moveNumber: 0, passes: 0,
    captures: { 1: 0, 2: 0 }, lastMove: null, dead: [], confirmed: [],
    result: null, komi: 6.5, scoringRule: 'territory-v1', history: [positionKey(board)], resumeTurn: null,
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

// A region around isolated stones which reaches every edge is the open exterior.
// A lone wall across the board also divides that exterior into two broad three-edge
// regions. Retain closed corner/edge pockets and genuinely narrow edge strips.
function reviewExterior(board, size, territory, survivingColors) {
  const adjacent = neighbors(size);
  const seen = new Uint8Array(board.length);
  const soleColor = survivingColors === 1 || survivingColors === 2;
  const confined = new Map();
  let groups;
  function opponentConfined(owner) {
    if (confined.has(owner)) return confined.get(owner);
    groups ??= groupMap(board, adjacent);
    const opposing = [...new Set(groups)].filter(group => group?.color === 3 - owner);
    const allConfined = opposing.every(group => {
      if (group.liberties.size !== 1) return false;
      const [liberty] = group.liberties;
      if (adjacent[liberty].some(n => !board[n] || (board[n] === group.color && groups[n] !== group))) return false;
      return !group.stones.some(stone => adjacent[stone].some(n => groups[n]?.color === owner && groups[n].liberties.size === 1));
    });
    confined.set(owner, allConfined);
    return allConfined;
  }
  let needsReview = false;
  for (let start = 0; start < board.length; start++) {
    if (board[start] || seen[start]) continue;
    // Partition the mixed-color map by computed ownership as well as connectivity.
    // An isolated pocket or a local secured shape beside open dame keeps its score.
    const claimant = soleColor ? survivingColors : territory[start];
    const inClaim = point => !board[point] && (soleColor || territory[point] === claimant);
    const region = [start];
    seen[start] = 1;
    let edges = 0, openInterior = false;
    for (let i = 0; i < region.length; i++) {
      const point = region[i], x = point % size, y = Math.floor(point / size);
      if (!x) edges |= 1;
      if (x === size - 1) edges |= 2;
      if (!y) edges |= 4;
      if (y === size - 1) edges |= 8;
      if (adjacent[point].length === 4 && adjacent[point].every(inClaim)) openInterior = true;
      for (const next of adjacent[point]) {
        if (!seen[next] && inClaim(next)) { seen[next] = 1; region.push(next); }
      }
    }
    const broadSide = openInterior && [7, 11, 13, 14].includes(edges);
    const outside = edges === 15 || (broadSide && claimant && (soleColor || opponentConfined(claimant)));
    if (outside) needsReview = true;
    if (outside || soleColor) {
      const owner = outside ? 0 : claimant;
      for (const point of region) territory[point] = owner;
    }
  }
  return needsReview;
}

function proposalKey(game, rule) {
  return [rule, game.size, game.komi, game.captures[1], game.captures[2], positionKey(game.board), game.dead.join(',')].join('|');
}

export function scoreGame(game) {
  const rule = game.scoringRule ?? 'area-v1';
  if (rule !== 'area-v1' && rule !== 'territory-v1') fail('scoring_rule', '계가 규칙을 확인해 주세요.');
  const breakdown = {
    1: { territory: 0, captures: game.captures[1], dead: 0, stones: 0, komi: 0 },
    2: { territory: 0, captures: game.captures[2], dead: 0, stones: 0, komi: game.komi },
  };
  const dead = new Set(game.dead);
  const aliveBoard = game.board.slice();
  let survivingColors = 0;
  const surviving = [0, 0, 0];
  for (let point = 0; point < aliveBoard.length; point++) {
    const owner = aliveBoard[point];
    if (!owner) continue;
    if (dead.has(point)) {
      breakdown[3 - owner].dead++;
      aliveBoard[point] = 0;
    } else {
      survivingColors |= owner;
      surviving[owner]++;
      if (rule === 'area-v1') breakdown[owner].stones++;
    }
  }
  let territory, needsReview = false;
  if (rule === 'area-v1') {
    territory = areaScore(game).territory;
  } else if (survivingColors === 3 && (surviving[1] > 1 || surviving[2] > 1)) {
    const rows = [], marks = [];
    for (let y = 0; y < game.size; y++) {
      const start = y * game.size;
      const row = game.board.slice(start, start + game.size);
      rows.push(row);
      marks.push(row.map((stone, x) => Boolean(stone && dead.has(start + x))));
    }
    territory = territoryScoring(rows, marks).flat().map(cell => cell.isTerritoryFor);
  } else {
    // A single stone cannot enclose even a corner intersection. No life/seki
    // analysis is needed for two isolated stones or a single surviving color.
    territory = Array(aliveBoard.length).fill(0);
  }
  if (rule === 'territory-v1') needsReview = reviewExterior(aliveBoard, game.size, territory, survivingColors);
  for (const owner of territory) if (owner) breakdown[owner].territory++;
  const total = color => {
    const b = breakdown[color];
    return b.territory + b.komi + (rule === 'area-v1' ? b.stones : b.captures + b.dead);
  };
  const black = total(1), white = total(2);
  return { rule, black, white, winner: black > white ? 1 : 2, margin: Math.abs(black - white), territory, breakdown, needsReview, proposalKey: proposalKey(game, rule) };
}

function botScoreVote(game, color) {
  const adjacent = neighbors(game.size);
  const checked = new Set();
  let reader;
  function tryPlay(position, player, point) {
    try {
      return playStone(position, player, { x: point % game.size, y: Math.floor(point / game.size) });
    } catch (error) {
      if (error.code === 'suicide' || error.code === 'superko') return null;
      throw error;
    }
  }
  function canTakeCleanly(position, stone, group, defender) {
    if (group.liberties.size !== 1) return false;
    const liberty = group.liberties.values().next().value;
    const after = tryPlay(position, 3 - defender, liberty);
    // A ko or snapback still has to be resolved on the board.
    return after !== null && after.board[stone] === 0 && chain(after.board, adjacent, liberty).liberties.size > 1;
  }
  function enclosed(group, defender) {
    const pocket = new Set([...group.stones, ...group.liberties]), wall = new Set();
    for (const point of pocket) for (const neighbor of adjacent[point]) {
      if (pocket.has(neighbor) || wall.has(neighbor)) continue;
      if (game.board[neighbor] !== 3 - defender) return false;
      const enclosing = chain(game.board, adjacent, neighbor);
      // A weak surrounding wall can be threatened by a move outside the pocket.
      if ([...enclosing.liberties].filter(liberty => !pocket.has(liberty)).length < 3) return false;
      for (const member of enclosing.stones) wall.add(member);
    }
    return wall.size > 0;
  }
  function provenDead(stone, group, defender) {
    if (group.liberties.size === 2 && game.scoringRule === 'territory-v1' && enclosed(group, defender)) {
      reader ??= tacticalReader(game, adjacent);
      // Require a clean forced capture even if the surrounded player moves first.
      // A ko, a snapback or a line we cannot resolve is never proof of death.
      return [defender, 3 - defender].every(turn => reader.read(game.board, stone, defender, turn, 8, { left: 56 }, [], true) === 1);
    }
    if (!canTakeCleanly(game, stone, group, defender)) return false;
    const defenses = new Set(group.liberties), examinedEnemies = new Set();
    for (const member of group.stones) for (const point of adjacent[member]) {
      if (game.board[point] !== 3 - defender || examinedEnemies.has(point)) continue;
      const enemy = chain(game.board, adjacent, point);
      for (const enemyStone of enemy.stones) examinedEnemies.add(enemyStone);
      if (enemy.liberties.size === 1) defenses.add(enemy.liberties.values().next().value);
    }
    for (const defense of defenses) {
      const after = tryPlay(game, defender, defense);
      if (after && !canTakeCleanly(after, stone, chain(after.board, adjacent, stone), defender)) return false;
    }
    return true;
  }
  for (const stone of game.dead) {
    if (game.board[stone] !== color || checked.has(stone)) continue;
    const group = chain(game.board, adjacent, stone);
    for (const member of group.stones) checked.add(member);
    if (!provenDead(stone, group, color)) return { type: 'markDead', x: stone % game.size, y: Math.floor(stone / game.size) };
  }
  if (game.scoringRule === 'territory-v1') {
    const marks = new Set(game.dead);
    for (let stone = 0; stone < game.board.length; stone++) {
      if (game.board[stone] !== 3 - color || checked.has(stone)) continue;
      const group = chain(game.board, adjacent, stone);
      for (const member of group.stones) checked.add(member);
      // Unmarked opponent stones remain live. Resolve a proven capture by playing it out.
      if (!marks.has(stone) && provenDead(stone, group, 3 - color)) return { type: 'resume' };
    }
  }
  return { type: 'confirmScore' };
}

function scoringAction(game, color, action, scorePreview) {
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
    if (action.scoringRule !== undefined && action.scoringRule !== (game.scoringRule ?? 'area-v1')) {
      fail('scoring_rule', '현재 대국의 계가 규칙을 다시 확인해 주세요.');
    }
    if (game.confirmed.includes(color)) fail('already_confirmed', '이미 계가에 동의했습니다.');
    const confirmed = [...game.confirmed, color];
    if (confirmed.length < 2) return { ...game, turn: 3 - color, confirmed, lastMove };
    const rule = game.scoringRule ?? 'area-v1';
    const matchesProposal = scorePreview?.rule === rule && scorePreview.proposalKey === proposalKey(game, rule);
    const { black, white, winner, margin } = matchesProposal ? scorePreview : scoreGame(game);
    return { ...game, phase: 'finished', confirmed, lastMove, result: { winner, reason: 'score', black, white, margin } };
  }
  fail('scoring', '계가 중입니다. 사석을 확인하거나 대국을 재개해 주세요.');
}

export function applyAction(game, color, action, scorePreview) {
  if (color !== 1 && color !== 2) fail('color', '올바른 대국자를 지정해 주세요.');
  if (game.phase === 'finished') fail('finished', '이미 종료된 대국입니다.');
  if (!action || typeof action.type !== 'string') fail('action', '대국 명령을 확인해 주세요.');
  if (action.type === 'resign') {
    return { ...game, phase: 'finished', lastMove: { type: 'resign', color }, result: { winner: 3 - color, reason: 'resign', black: null, white: null, margin: null } };
  }
  if (game.phase === 'scoring') return scoringAction(game, color, action, scorePreview);
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

const searchLevels = {
  easy:   { width: 4, depth: 3, nodes: 12, noise: 10 },
  normal: { width: 7, depth: 9, nodes: 34, noise: 3 },
  hard:   { width: 10, depth: 22, nodes: 68, noise: 0.8 },
};

function trueEye(board, size, adjacent, point, color) {
  if (!adjacent[point].every(neighbor => board[neighbor] === color)) return false;
  const x = point % size, y = Math.floor(point / size);
  let hostile = 0;
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
    if (x + dx < 0 || x + dx >= size || y + dy < 0 || y + dy >= size) continue;
    if (board[(y + dy) * size + x + dx] === 3 - color) hostile++;
  }
  return hostile < (adjacent[point].length === 4 ? 2 : 1);
}

// Rank the entire board once. Read only the most promising variations afterwards.
function rankMove(index, context) {
  const { game, color, groups, adjacent, myDistance, enemyDistance, ownership, opening, tuning, rng } = context;
  const { size, board } = game;
  const enemy = 3 - color;
  const contacts = [];
  let open = 0;
  for (const point of adjacent[index]) {
    const group = groups[point];
    if (!group) open++;
    else if (!contacts.includes(group)) contacts.push(group);
  }
  let captured = 0, saved = 0, attacked = 0, pressured = 0, friendly = 0, friendlyWeak = 0;
  let escapeSpace = open;
  const newAtaris = [];
  for (const group of contacts) {
    const libs = group.liberties.size, count = group.stones.length;
    if (group.color === color) {
      friendly++;
      if (libs <= 3) friendlyWeak++;
      if (libs === 1) saved += count;
      escapeSpace = Math.max(escapeSpace, libs - 1);
    } else if (libs === 1) captured += count;
    else if (libs === 2) { attacked += Math.min(count, 5); newAtaris.push(group); }
    else if (libs === 3) pressured += Math.min(count, 4);
  }
  const emergencyConnection = saved > 0 && friendly > 1;
  if (!captured && !open && !emergencyConnection && trueEye(board, size, adjacent, index, color)) return null;
  if (!captured && !escapeSpace && friendly <= 1) return null;
  if (!captured && !saved && !attacked && escapeSpace <= 1 && friendly <= 1) return null;
  if (!captured && !saved && !attacked && ownership[index] === color && !opening) return null;
  if (!captured && !saved && !attacked && ownership[index] === enemy && trueEye(board, size, adjacent, index, enemy)) return null;

  const x = index % size, y = Math.floor(index / size);
  const edgeX = Math.min(x, size - 1 - x), edgeY = Math.min(y, size - 1 - y);
  const edge = Math.min(edgeX, edgeY), farEdge = Math.max(edgeX, edgeY);
  const mine = myDistance[index], theirs = enemyDistance[index], nearest = Math.min(mine, theirs);
  const cornerLine = size === 9 ? 2 : 3;
  let shape = 0;
  if (opening) {
    // Take open corners first. Approach and extend along the third/fourth lines.
    const cornerGap = Math.abs(edgeX - cornerLine) + Math.abs(edgeY - cornerLine);
    shape += 9 - Math.min(13, 2.3 * cornerGap) + 1.8 * Math.min(nearest, 6);
    if (farEdge > cornerLine + 1 && (edge === 2 || edge === 3)) shape += 3;
    if (nearest < 3) shape -= (3 - nearest) * 4;
    if (edge === 0) shape -= 9;
    if (edge === 1) shape -= 5;
  } else {
    // Extend toward open space from friendly strength, especially at a contested boundary.
    shape += 5 - Math.min(7, Math.abs(mine - 3));
    shape += 4 - Math.min(6, Math.abs(theirs - 3));
    if (ownership[index] === enemy && mine > 3) shape -= 10;
    if (edge === 0 && open > 1 && !attacked) shape -= 4;
  }
  if (mine === 1 && friendly === 1 && !friendlyWeak) shape -= 4;
  if (friendly >= 2) shape += friendlyWeak ? 7 : 2;
  if (friendlyWeak && escapeSpace >= 3 && theirs <= 2) shape += 4;
  if (open <= 1 && !captured && !friendly) shape -= 11;
  if (myDistance[index] === 2 && enemyDistance[index] === 2) shape += 2;
  // A corner-opening preference must not push an urgent edge capture outside the reading beam.
  if (captured || saved) shape = Math.max(-2, Math.min(4, shape)) + 5;
  const counterPriority = context.counterPriority[index];
  const score = shape + tuning.noise * rng() + 23 * captured + 17 * saved + counterPriority
    + 3.3 * attacked + 1.15 * pressured + (newAtaris.length > 1 ? 13 : 0);
  return { index, score, captured, saved, newAtaris, counterPriority };
}

// Short local variations use the same capture, suicide and positional-superko rules as playStone.
// Stamped arrays avoid allocating two Sets each time a hypothetical chain is inspected.
function tacticalReader(game, adjacent) {
  const stonesSeen = new Uint32Array(game.board.length), libertiesSeen = new Uint32Array(game.board.length);
  const previous = new Set(game.history);
  previous.add(positionKey(game.board));
  let stamp = 0;

  function inspect(board, start) {
    const tag = ++stamp;
    const stones = [start], liberties = [];
    const color = board[start];
    stonesSeen[start] = tag;
    for (let i = 0; i < stones.length; i++) {
      for (const point of adjacent[stones[i]]) {
        if (!board[point] && libertiesSeen[point] !== tag) {
          libertiesSeen[point] = tag;
          liberties.push(point);
        } else if (board[point] === color && stonesSeen[point] !== tag) {
          stonesSeen[point] = tag;
          stones.push(point);
        }
      }
    }
    return { stones, liberties };
  }

  function move(board, point, color, path) {
    if (board[point]) return null;
    const next = board.slice();
    next[point] = color;
    for (const neighbor of adjacent[point]) {
      if (next[neighbor] !== 3 - color || adjacent[neighbor].some(n => !next[n])) continue;
      const enemy = inspect(next, neighbor);
      if (!enemy.liberties.length) for (const stone of enemy.stones) next[stone] = 0;
    }
    if (!adjacent[point].some(n => !next[n]) && !inspect(next, point).liberties.length) return null;
    const key = positionKey(next);
    if (previous.has(key) || path.includes(key)) return null;
    return { board: next, key };
  }

  // A forcing capture is proven only if every legal extension and adjacent countercapture fails.
  // 1 means capture proven, -1 means escape from the forcing sequence, 0 means unresolved.
  function read(board, anchor, defender, turn, depth, budget, path, cleanCapture = false) {
    if (board[anchor] !== defender) return 1;
    const group = inspect(board, anchor);
    const count = group.liberties.length;
    if (count >= 3) return -1;
    if (!depth || !budget.left) return 0;
    const attack = turn !== defender;
    const choices = group.liberties.slice();
    if (!attack) {
      const examined = new Set();
      for (const stone of group.stones) for (const neighbor of adjacent[stone]) {
        if (board[neighbor] !== 3 - defender || examined.has(neighbor)) continue;
        const attacker = inspect(board, neighbor);
        for (const member of attacker.stones) examined.add(member);
        if (attacker.liberties.length === 1 && !choices.includes(attacker.liberties[0])) choices.unshift(attacker.liberties[0]);
      }
    }
    let best = attack ? -1 : 1, legal = false;
    for (const point of choices) {
      if (!budget.left) return 0;
      budget.left--;
      const next = move(board, point, turn, path);
      if (!next) continue;
      legal = true;
      path.push(next.key);
      const riskyCapture = cleanCapture && next.board[anchor] !== defender && inspect(next.board, point).liberties.length <= 1;
      const outcome = riskyCapture ? 0 : read(next.board, anchor, defender, 3 - turn, depth - 1, budget, path, cleanCapture);
      path.pop();
      if (attack && outcome === 1 || !attack && outcome === -1) return outcome;
      best = attack ? Math.max(best, outcome) : Math.min(best, outcome);
    }
    if (!legal && !attack) {
      // The defender may tenuki. A prohibited ko recapture is not a forced kill.
      return read(board, anchor, defender, 3 - turn, depth - 1, budget, path, cleanCapture);
    }
    return best;
  }
  return { inspect, move, read };
}

function readCandidate(candidate, context, reader, endangered) {
  const { game, color, tuning } = context;
  const next = reader.move(game.board, candidate.index, color, []);
  if (!next) return -Infinity;
  const board = next.board, enemy = 3 - color;
  const path = [next.key], budget = { left: tuning.nodes };
  const own = reader.inspect(board, candidate.index);
  let value = candidate.score - candidate.counterPriority;
  if (own.liberties.length <= 2) {
    const risk = reader.read(board, candidate.index, color, enemy, tuning.depth, budget, path);
    if (risk === 1) value -= 34 * own.stones.length + 12;
    else if (risk === 0) value -= (own.liberties.length === 1 ? 12 : 3) * Math.min(own.stones.length, 5);
  }

  // A countercapture may free a threatened chain even when the move does not touch that chain.
  if (candidate.captured) for (const original of endangered) {
    const anchor = original.stones[0];
    if (own.stones.includes(anchor)) continue;
    const rescued = reader.inspect(board, anchor);
    if (rescued.liberties.length < 2) continue;
    const risk = rescued.liberties.length > 2 ? -1 : reader.read(board, anchor, color, enemy, tuning.depth, budget, path);
    if (risk !== 1) value += (risk === -1 ? 18 : 11) * original.stones.length;
  }

  const replyPoints = new Map();
  for (const target of candidate.newAtaris) {
    const anchor = target.stones[0];
    if (board[anchor] !== enemy) continue;
    const current = reader.inspect(board, anchor);
    if (current.liberties.length !== 1) continue;
    const liberty = current.liberties[0];
    replyPoints.set(liberty, (replyPoints.get(liberty) ?? 0) + target.stones.length);
    const trapped = reader.read(board, anchor, enemy, enemy, tuning.depth, budget, path);
    if (trapped === 1) value += 18 * target.stones.length;
    if (trapped === -1) value -= 2.5 * Math.min(target.stones.length, 5);
  }
  if (replyPoints.size > 1 && own.liberties.length >= 2) {
    const prizes = [...replyPoints.values()].sort((a, b) => b - a);
    value += 18 * prizes[1];
  }
  return value;
}

export function chooseBotAction(game, difficulty = 'normal', rng = Math.random) {
  const color = game.turn;
  if (game.phase === 'finished') fail('finished', '이미 종료된 대국입니다.');
  if (game.phase === 'scoring') return botScoreVote(game, color);
  const tally = areaScore(game);
  const adjacent = neighbors(game.size);
  const groups = groupMap(game.board, adjacent);
  const tuning = Object.hasOwn(searchLevels, difficulty) ? searchLevels[difficulty] : searchLevels.normal;
  const opening = game.moveNumber < game.size * 2;
  const endangered = [...new Set(groups)].filter(g => g?.color === color && g.liberties.size === 1);
  const counterPriority = new Float64Array(game.board.length);
  for (const group of endangered) {
    const counters = new Set();
    for (const stone of group.stones) for (const neighbor of adjacent[stone]) {
      const opponent = groups[neighbor];
      if (opponent?.color !== 3 - color || opponent.liberties.size !== 1) continue;
      const liberty = opponent.liberties.values().next().value;
      if (!group.liberties.has(liberty)) counters.add(liberty);
    }
    for (const point of counters) counterPriority[point] += 16 * group.stones.length;
  }
  const context = {
    game, color, adjacent, groups, opening, tuning, rng, counterPriority,
    myDistance: distanceTo(game.board, adjacent, color), enemyDistance: distanceTo(game.board, adjacent, 3 - color),
    ownership: tally.territory,
  };
  const candidates = [];
  for (let index = 0; index < game.board.length; index++) {
    if (game.board[index]) continue;
    const move = rankMove(index, context);
    if (move) candidates.push(move);
  }
  candidates.sort((a, b) => b.score - a.score);
  const reader = tacticalReader(game, adjacent);
  let best = -Infinity, choice = null, examined = 0, usefulTactic = false;
  for (const candidate of candidates) {
    const value = readCandidate(candidate, context, reader, endangered);
    if (value === -Infinity) continue;
    if (value > 0 && (candidate.captured || candidate.saved)) usefulTactic = true;
    if (value > best) { best = value; choice = candidate; }
    if (++examined >= tuning.width && (best >= 0 || examined >= 2 * tuning.width)) break;
  }
  // Empty regions shared by both sides can still hide unsettled groups. An opening pass is never a score estimate.
  if (!choice || best < -3) return { type: 'pass' };
  if (game.passes && !opening && !usefulTactic && !choice.newAtaris.length) {
    // Count territory only when actually considering the opponent's pass. Area on
    // an unfinished board is a positional heuristic, not a settlement forecast.
    const final = game.scoringRule === 'territory-v1' ? scoreGame(game) : tally;
    if (!final.needsReview && final.winner === color) return { type: 'pass' };
  }
  return { type: 'play', x: choice.index % game.size, y: Math.floor(choice.index / game.size) };
}
