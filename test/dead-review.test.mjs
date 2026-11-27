import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, chooseBotAction, createGame, scoreGame } from '../shared/go.mjs';

const pass = { type: 'pass' };
const confirm = { type: 'confirmScore' };
const mark = (x, y) => ({ type: 'markDead', x, y });
const play = (x, y) => ({ type: 'play', x, y });
const point = ([x, y]) => 19 * y + x;
const next = (game, action) => applyAction(game, game.turn, action);
const review = game => next(next(game, pass), pass);

function position(black, white) {
  const game = createGame();
  for (const [color, stones] of [[1, black], [2, white]]) {
    for (const coord of stones) {
      assert.equal(game.board[point(coord)], 0);
      game.board[point(coord)] = color;
    }
  }
  return game;
}

function cornerEnclosure(length) {
  const trapped = Array.from({ length }, (_, x) => [x, 0]);
  const wall = Array.from({ length: length + 1 }, (_, x) => [x, 2]);
  wall.push([length, 0], [length, 1]);
  return [trapped, wall];
}

test('the second pass proposes every stone of a sealed chain in all corners and for either color', () => {
  const rotations = [
    ([x,y]) => [x,y], ([x,y]) => [18-y,x], ([x,y]) => [18-x,18-y], ([x,y]) => [y,18-x],
  ];
  for (const length of [1, 3, 8]) {
    for (const rotate of rotations) for (const defender of [1, 2]) {
      const [trapped, wall] = cornerEnclosure(length).map(coords => coords.map(rotate));
      const initial = defender === 1 ? position(trapped, wall) : position(wall, trapped);
      const first = next(initial, pass);
      assert.equal(first.phase, 'playing');
      assert.deepEqual(first.dead, []);
      const proposal = next(first, pass);
      const expected = trapped.map(point).sort((a, b) => a - b);
      assert.deepEqual(proposal.suggestedDead, expected);
      assert.deepEqual(proposal.dead, expected);
      assert.notEqual(proposal.dead, proposal.suggestedDead);
      assert.deepEqual(proposal.captures, initial.captures);
      assert.deepEqual(proposal.board, initial.board);
      assert.equal(scoreGame(proposal).breakdown[3 - defender].dead, length);
    }
  }
});

test('the defender can make two eyes by taking the middle of a straight three', () => {
  const wall = [], inside = [];
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 6; x++) {
    if (x === 0 || x === 6 || y === 0 || y === 4) wall.push([x, y]);
    else if (y !== 2 || x === 1 || x === 5) inside.push([x, y]);
  }
  const game = position(inside, wall);
  assert.deepEqual(review(game).suggestedDead, []);
  const twoEyes = next(game, play(3, 2));
  assert.deepEqual(review(twoEyes).suggestedDead, []);
  for (const x of [2, 4]) assert.throws(() => next(twoEyes, play(x, 2)), { code: 'suicide' });
});

test('in a small sealed chamber the attacker can kill even when the defender plays inside first', () => {
  const trapped = position([[0,0]], [[2,0],[2,1],[2,2],[1,2],[0,2]]);
  assert.deepEqual(review(trapped).suggestedDead, [0]);
});

test('playing outside the target can turn an apparent clean capture into a five-stone snapback', () => {
  const game = position([[0,0],[0,2],[1,2],[2,2],[3,1]], [[0,1],[1,1],[2,1],[2,0]]);
  const score = review(game);
  assert.ok(!score.suggestedDead.includes(0));
  const threat = next(game, play(3,0));
  const captured = next(threat, play(1,0));
  assert.equal(captured.captures[2], 1);
  const snappedBack = next(captured, play(0,0));
  assert.equal(snappedBack.captures[1], 5);
});

test('two eyes, mutual life, an open escape, a ko and a snapback are left for agreement', () => {
  const twoEyes = [[0,1],[1,1],[2,1],[3,1],[1,0],[3,0]];
  const secured = review(position(twoEyes, [[16,16]]));
  assert.deepEqual(secured.suggestedDead, []);
  for (const bot of [1, 2]) {
    const manual = applyAction(secured, 3 - bot, mark(0,1));
    const objection = chooseBotAction(manual);
    assert.equal(objection.type, 'markDead');
    assert.ok(twoEyes.map(point).includes(point([objection.x, objection.y])));
    assert.deepEqual(next(manual, objection).dead, []);
  }
  const seki = createGame();
  for (let y = 0; y < 19; y++) for (let x = 0; x < 19; x++) seki.board[point([x,y])] = x < 9 ? 1 : 2;
  for (const eye of [[3,3], [15,3], [9,9]]) seki.board[point(eye)] = 0;
  assert.deepEqual(review(seki).suggestedDead, []);
  const open = review(position([[0,0],[0,1]], [[1,0],[1,1],[7,8]]));
  assert.ok(open.suggestedDead.every(i => open.board[i] !== 1));
  const ko = [play(2,0),play(1,0),play(1,1),play(0,1),play(0,0)].reduce(next, createGame());
  assert.ok(!review(ko).suggestedDead.includes(point([0,0])));
  const snapback = position([[0,0],[0,1],[0,2],[2,1],[3,0],[1,3]], [[1,1],[1,2],[0,3],[2,0]]);
  assert.ok(!review(snapback).suggestedDead.includes(point([2,0])));
});

test('overrides survive a restore and reset votes, and a fresh review reads the board again', () => {
  const [stones, wall] = cornerEnclosure(3);
  const game = position(stones, wall);
  game.captures = { 1: 4, 2: 1 };
  const proposed = review(game);
  const voted = applyAction(proposed, 1, confirm);
  const undone = applyAction(voted, 2, mark(1,0));
  assert.deepEqual(undone.dead, []);
  assert.deepEqual(undone.confirmed, []);
  assert.deepEqual(undone.suggestedDead, [0,1,2]);
  assert.deepEqual(undone.captures, game.captures);
  const restored = JSON.parse(JSON.stringify(undone));
  assert.equal(scoreGame(restored).breakdown[2].dead, 0);
  assert.deepEqual(chooseBotAction({ ...restored, turn: 2 }), { type: 'resume' });
  const resumed = next(restored, { type: 'resume' });
  assert.deepEqual(resumed.dead, []);
  assert.deepEqual(resumed.suggestedDead, []);
  assert.deepEqual(review(resumed).suggestedDead, [0,1,2]);
  const confirmed = applyAction(applyAction(restored, 1, confirm), 2, confirm);
  assert.equal(confirmed.result.white, scoreGame(restored).white);
  assert.deepEqual(confirmed.dead, []);
});

test('area matches and an existing human scoring agreement keep their saved proposal', () => {
  const [stones, wall] = cornerEnclosure(2);
  const { scoringRule, ...oldGame } = position(stones, wall);
  assert.equal(scoringRule, 'territory-v1');
  for (const legacy of [oldGame, { ...oldGame, scoringRule: 'area-v1' }]) {
    const scoring = review(legacy);
    assert.deepEqual(scoring.dead, []);
    assert.equal(scoring.suggestedDead, undefined);
  }
  const { suggestedDead, ...saved } = review({ ...oldGame, scoringRule });
  assert.deepEqual(suggestedDead, [0,1]);
  saved.dead = [];
  saved.confirmed = [1];
  assert.deepEqual(applyAction(saved, 2, confirm).dead, []);
});
