import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, applyAction, scoreGame, chooseBotAction } from '../shared/go.mjs';

const index = (x, y) => y * 19 + x;
const play = (x, y) => ({ type: 'play', x, y });
const pass = { type: 'pass' };
const confirm = { type: 'confirmScore', scoringRule: 'territory-v1' };
const mark = (x, y) => ({ type: 'markDead', x, y });
const next = (game, action) => applyAction(game, game.turn, action);

function fixture(black, white, captures = { 1: 0, 2: 0 }) {
  const game = createGame();
  for (const [color, points] of [[1, black], [2, white]]) {
    for (const [x, y] of points) {
      assert.equal(game.board[index(x, y)], 0);
      game.board[index(x, y)] = color;
    }
  }
  game.captures = captures;
  return next(next(game, pass), pass);
}

test('lone stones and an open exterior do not become territory when the players pass early', () => {
  const empty = scoreGame(createGame());
  assert.deepEqual([empty.black, empty.white, empty.needsReview], [0, 6.5, true]);
  const loneGame = fixture([[3, 3]], []);
  const lone = scoreGame(loneGame);
  assert.deepEqual([lone.black, lone.white, lone.breakdown[1].stones, lone.needsReview], [0, 6.5, 0, true]);
  assert.ok(lone.territory.every(point => !point));
  const mixed = fixture([[3, 3]], [[15, 15]]);
  const distantDead = scoreGame(applyAction(mixed, 1, mark(15, 15)));
  assert.deepEqual([distantDead.black, distantDead.white, distantDead.breakdown[1].territory, distantDead.breakdown[1].dead], [1, 6.5, 0, 1]);
  const corner = scoreGame(fixture([[0,1],[1,1],[2,1],[3,1],[1,0],[3,0]], []));
  assert.equal(corner.black, 2);
  assert.equal(corner.territory[index(0,0)], 1);
  assert.equal(corner.territory[index(2,0)], 1);
  assert.equal(corner.territory[index(10,10)], 0);
});

test('a played capture is permanently credited once without counting living stones', () => {
  const game = [play(0,1), play(0,0), play(1,0), pass, pass].reduce(next, createGame());
  const score = scoreGame(game);
  assert.deepEqual(game.captures, { 1: 1, 2: 0 });
  assert.deepEqual(score.breakdown[1], { territory: 1, captures: 1, dead: 0, stones: 0, komi: 0 });
  assert.equal(score.black, 2);
  assert.equal(score.white, 6.5);
  assert.equal(game.board[index(0,0)], 0);
  assert.throws(() => applyAction(game, 2, mark(0,0)), { code: 'no_stone' });
});

test('a sole spanning wall does not claim broad three-edge exteriors on either side', () => {
  const wall = y => Array.from({ length: 19 }, (_, x) => [x,y]);
  const divided = scoreGame(fixture(wall(9), []));
  assert.deepEqual([divided.black, divided.white, divided.needsReview], [0, 6.5, true]);
  assert.equal(divided.territory[index(9,4)], 0);
  assert.equal(divided.territory[index(9,14)], 0);
  const shallowSide = scoreGame(fixture(wall(1), []));
  assert.equal(shallowSide.black, 19);
  assert.equal(shallowSide.territory[index(9,0)], 1);
  assert.equal(shallowSide.territory[index(9,14)], 0);
});

test('a trapped but unmarked opponent does not make the open exterior territory', () => {
  const proposed = [play(0,1), play(0,0), play(2,0), pass, play(1,1), pass, pass].reduce(next, createGame());
  assert.deepEqual(proposed.suggestedDead, [0]);
  const position = applyAction(proposed, 1, mark(0,0));
  const before = scoreGame(position);
  assert.deepEqual([before.black, before.white, before.needsReview], [0, 6.5, true]);
  assert.ok(before.territory.every(point => !point));
  const marked = applyAction(position, 1, mark(0,0));
  const after = scoreGame(marked);
  assert.deepEqual(after.breakdown[1], { territory: 2, dead: 1, captures: 0, stones: 0, komi: 0 });
  assert.deepEqual([after.black, after.white], [3, 6.5]);
  assert.deepEqual(scoreGame(applyAction(marked, 2, mark(0,0))), before);

  const wall = Array.from({ length: 19 }, (_, x) => [x,9]);
  const confined = scoreGame(applyAction(fixture([...wall, [0,1],[2,0],[1,1]], [[0,0]]), 1, mark(0,0)));
  assert.deepEqual([confined.black, confined.white, confined.needsReview], [0, 6.5, true]);
  const independent = scoreGame(fixture(wall, [[8,15]]));
  assert.equal(independent.territory[index(9,4)], 1, 'an independent opponent across a complete wall preserves the ordinary side-territory ruling');
  const pockets = scoreGame(applyAction(fixture([[0,1],[2,0],[1,1], [18,1],[17,1],[16,1],[15,1],[17,0],[15,0]], [[0,0]]), 1, mark(0,0)));
  assert.equal(pockets.black, 2);
  assert.equal(pockets.territory[index(18,0)], 1);
  assert.equal(pockets.territory[index(16,0)], 1);
  assert.equal(pockets.territory[index(9,9)], 0);
});

test('marking, undoing and re-marking a two-stone dead chain never alters historic prisoners', () => {
  const suggested = fixture([[1,0],[1,1],[4,0],[4,1],[0,2],[1,2],[2,2],[3,2],[4,2]], [[2,0],[3,0],[16,16]], { 1: 3, 2: 2 });
  assert.deepEqual(suggested.suggestedDead, [index(2,0), index(3,0)]);
  const original = applyAction(suggested, 1, mark(2,0));
  const originalScore = scoreGame(original);
  const firstVote = applyAction(original, 1, confirm);
  const marked = applyAction(firstVote, 2, mark(2,0));
  assert.deepEqual(marked.confirmed, []);
  assert.deepEqual(marked.dead, [index(2,0), index(3,0)]);
  assert.deepEqual(marked.captures, { 1: 3, 2: 2 });
  assert.deepEqual(marked.board, original.board);
  const proposal = scoreGame(marked);
  assert.deepEqual(proposal.breakdown[1], { territory: 6, captures: 3, dead: 2, stones: 0, komi: 0 });
  assert.deepEqual(proposal.breakdown[2], { territory: 0, captures: 2, dead: 0, stones: 0, komi: 6.5 });
  assert.deepEqual([proposal.black, proposal.white], [11, 8.5]);
  assert.equal(proposal.territory[index(2,0)], 1);
  assert.equal(proposal.territory[index(3,0)], 1);
  assert.equal(scoreGame({ ...marked, dead: [...marked.dead, marked.dead[0]] }).breakdown[1].dead, 2);
  const unmarked = applyAction(marked, 1, mark(3,0));
  assert.deepEqual(scoreGame(unmarked), originalScore);
  const markedAgain = applyAction(unmarked, 2, mark(3,0));
  assert.deepEqual(scoreGame(markedAgain), proposal);
  const resumed = applyAction(markedAgain, 1, { type: 'resume' });
  assert.deepEqual(resumed.dead, []);
  assert.deepEqual(resumed.captures, original.captures);
  const voted = applyAction(markedAgain, 1, confirm);
  for (const preview of [proposal, originalScore]) {
    assert.deepEqual(applyAction(voted, 2, confirm, preview).result, { reason: 'score', winner: 1, margin: 2.5, black: 11, white: 8.5 });
  }
});

test('mutual life with a private eye on each side and one shared liberty gives neither player territory', () => {
  const game = createGame();
  for (let y = 0; y < 19; y++) for (let x = 0; x < 19; x++) game.board[index(x,y)] = x < 9 ? 1 : 2;
  const empty = [index(3,3), index(15,3), index(9,9)];
  for (const point of empty) game.board[point] = 0;
  const score = scoreGame(game);
  assert.deepEqual([score.black, score.white, score.needsReview], [0, 6.5, false]);
  assert.deepEqual(empty.map(point => score.territory[point]), [0, 0, 0]);
  for (const [color, eye] of [[1, [3,3]], [2, [15,3]]]) {
    const filled = applyAction({ ...game, turn: color }, color, play(9,9));
    const lost = next(filled, play(...eye));
    assert.equal(lost.board[index(9,9)], 0);
    assert.ok(lost.captures[3 - color] > 1);
  }
});

test('old and new matches keep their own scoring and reject confirmations for a different rule', () => {
  const game = fixture([[3,3]], []);
  const { scoringRule, ...legacy } = game;
  assert.equal(scoringRule, 'territory-v1');
  for (const older of [legacy, { ...legacy, scoringRule: 'area-v1' }]) {
    const score = scoreGame(older);
    assert.equal(score.rule, 'area-v1');
    assert.deepEqual([score.black, score.white, score.breakdown[1].stones], [361, 6.5, 1]);
    assert.throws(() => applyAction(older, 1, confirm), { code: 'scoring_rule' });
    const firstVote = applyAction(older, 1, { type: 'confirmScore' });
    assert.equal(applyAction(firstVote, 2, { type: 'confirmScore' }).result.black, 361);
  }
  assert.throws(() => applyAction(game, 1, { type: 'confirmScore', scoringRule: 'area-v1' }), { code: 'scoring_rule' });
});

test('bot accepts an enclosed two-liberty dead stone and leaves uncertain stones to the players', () => {
  const enclosed = fixture([[0,0]], [[2,0],[1,1],[0,2],[2,1],[1,2]]);
  assert.deepEqual(enclosed.suggestedDead, [index(0,0)]);
  assert.deepEqual(chooseBotAction({ ...enclosed, turn: 1 }), { type: 'confirmScore' });
  const pair = fixture([[0,0],[1,0]], [[2,0],[2,1],[0,2],[1,2],[2,2]]);
  assert.deepEqual(pair.dead, [index(0,0), index(1,0)]);
  assert.deepEqual(chooseBotAction(pair), { type: 'confirmScore' });
  assert.deepEqual(chooseBotAction(applyAction(enclosed, 1, mark(0,0))), { type: 'resume' });
  const unsettled = fixture([[0,0]], [[16,16]]);
  assert.deepEqual(chooseBotAction(applyAction(unsettled, 2, mark(0,0))), mark(0,0));
  const ko = [play(2,0), play(1,0), play(1,1), play(0,1), play(0,0), pass, pass].reduce(next, createGame());
  assert.deepEqual(chooseBotAction(applyAction(ko, 2, mark(0,0))), mark(0,0));
  const snapback = fixture([[0,0],[0,1],[0,2],[2,1],[3,0],[1,3]], [[1,1],[1,2],[0,3],[2,0]]);
  assert.deepEqual(chooseBotAction(applyAction(snapback, 1, mark(2,0))), mark(2,0));
});

test('bot does not accept a provisional area lead when a late pass leaves the board open', () => {
  const game = fixture([[3,3]], [[15,15]], { 1: 19, 2: 19 });
  const playing = { ...game, phase: 'playing', moveNumber: 45, turn: 2, passes: 1, lastMove: { type: 'pass', color: 1 } };
  for (const level of ['easy', 'normal', 'hard']) {
    const choice = chooseBotAction(playing, level, () => 0.5);
    assert.equal(choice.type, 'play');
    assert.equal(next(playing, choice).phase, 'playing');
  }
});
