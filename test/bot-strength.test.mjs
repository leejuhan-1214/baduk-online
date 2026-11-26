import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, chooseBotAction, createGame } from '../shared/go.mjs';

function play([x, y]) {
  return { type: 'play', x, y };
}

function rotate([x, y], turns) {
  for (let i = 0; i < turns; i++) [x, y] = [8 - y, x];
  return [x, y];
}

function position(black, white, turns) {
  assert.equal(black.length, white.length);
  let game = createGame(9);
  for (let i = 0; i < black.length; i++) {
    for (const [color, stones] of [[1, black], [2, white]]) {
      game = applyAction(game, color, play(rotate(stones[i], turns)));
    }
  }
  assert.equal(game.captures[1] + game.captures[2], 0);
  return game;
}

test('rescue a three-stone chain by extending its last liberty into a healthy ally', () => {
  const black = [[2,2], [2,3], [3,3], [4,2], [4,1], [7,7]];
  const white = [[1,2], [1,3], [2,4], [3,4], [4,3], [2,1]];
  for (let turns = 0; turns < 4; turns++) {
    const game = position(black, white, turns);
    const connect = play(rotate([3,2], turns));
    for (const difficulty of ['normal', 'hard']) {
      assert.deepEqual(chooseBotAction(game, difficulty, () => 0.5), connect);
    }
    const lost = applyAction(applyAction(game, 1, { type: 'pass' }), 2, connect);
    assert.equal(lost.captures[2], 3);
  }
});

test('a double atari wins one of two separate two-stone chains whichever one escapes', () => {
  const black = [[1,4], [2,5], [3,3], [3,5], [7,4], [6,5], [5,3], [5,5]];
  const white = [[2,4], [3,4], [6,4], [5,4], [1,0], [2,0], [3,0], [4,0]];
  for (let turns = 0; turns < 4; turns++) {
    const game = position(black, white, turns);
    const move = chooseBotAction(game, 'hard', () => 0.5);
    assert.deepEqual(move, play(rotate([4,4], turns)));
    const attacked = applyAction(game, 1, move);
    const escapeLeft = play(rotate([2,3], turns));
    const escapeRight = play(rotate([6,3], turns));
    for (const [escape, capture] of [[escapeLeft, escapeRight], [escapeRight, escapeLeft]]) {
      const escaped = applyAction(attacked, 2, escape);
      assert.equal(applyAction(escaped, 1, capture).captures[1], 2);
    }
  }
});

test('avoid an immediate four-stone snapback and rescue the chain by countercapture', () => {
  const black = [[0,0], [0,1], [0,2], [2,1], [3,0], [1,3]];
  const white = [[1,1], [1,2], [0,3], [7,7], [7,6], [2,0]];
  for (let turns = 0; turns < 4; turns++) {
    const game = position(black, white, turns);
    const bait = applyAction(game, 1, play(rotate([1,0], turns)));
    const snapback = applyAction(bait, 2, play(rotate([2,0], turns)));
    assert.equal(bait.captures[1], 1);
    assert.equal(snapback.captures[2], 4);
    const choice = chooseBotAction(game, 'hard', () => 0.5);
    assert.deepEqual(choice, play(rotate([0,4], turns)));
    const rescued = applyAction(game, 1, choice);
    const reply = applyAction(rescued, 2, play(rotate([1,0], turns)));
    assert.equal(rescued.captures[1], 1);
    assert.equal(reply.captures[2], 0);
  }
});

test('keep both true eyes of a living group while there is space to play elsewhere', () => {
  const black = [[0,0], [1,0], [2,0], [3,0], [4,0], [0,1], [2,1], [4,1],
    [0,2], [1,2], [2,2], [3,2], [4,2]];
  const white = [[7,0], [7,1], [7,2], [7,3], [7,4], [7,5], [7,6], [7,7],
    [7,8], [6,8], [5,8], [4,8], [3,8]];
  for (let turns = 0; turns < 4; turns++) {
    const game = position(black, white, turns);
    for (const difficulty of ['normal', 'hard']) {
      const choice = chooseBotAction(game, difficulty, () => 0.5);
      assert.equal(choice.type, 'play');
      assert.notDeepEqual(choice, play(rotate([1,1], turns)));
      assert.notDeepEqual(choice, play(rotate([3,1], turns)));
      applyAction(game, 1, choice);
    }
  }
});

test('connect through a surrounded point when four separate chains share it as a liberty', () => {
  const black = [[4,3], [4,2], [4,5], [3,4], [5,4]];
  const white = [[3,3], [5,3], [3,2], [5,2], [4,1]];
  for (let turns = 0; turns < 4; turns++) {
    const game = position(black, white, turns);
    const center = play([4,4]);
    const ignored = applyAction(applyAction(game, 1, { type: 'pass' }), 2, center);
    assert.equal(ignored.captures[2], 2);
    assert.deepEqual(chooseBotAction(game, 'hard', () => 0.5), center);
  }
});
