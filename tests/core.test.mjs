import test from 'node:test';
import assert from 'node:assert/strict';
import { characterHeight, spawnPlayer, stepPlayer } from '../dist/physics.js';
import { chooseLevel, endpointPair } from '../dist/planner.js';
import { normalizeShapes, verticalSlice } from '../dist/geometry.js';
import { createFallbackLevel } from '../dist/fallback.js';

function demoWorld(width = 1920, height = 1080) {
  const cardWidth = Math.max(150, Math.min(190, width * 0.11));
  const leftRatios = width <= 800 ? [0.07, 0.29, 0.51, 0.73] : [0.10, 0.28, 0.46, 0.64];
  return {
    width,
    height,
    characterHeight: characterHeight(height),
    platforms: [
      { id: 0, left: width * leftRatios[0], right: width * leftRatios[0] + cardWidth, top: height * 0.69 },
      { id: 1, left: width * leftRatios[1], right: width * leftRatios[1] + cardWidth, top: height * 0.62 },
      { id: 2, left: width * leftRatios[2], right: width * leftRatios[2] + cardWidth, top: height * 0.55 },
      { id: 3, left: width * leftRatios[3], right: width * leftRatios[3] + cardWidth, top: height * 0.48 },
    ],
  };
}

test('a platform catches falling feet and blocks a rising head from below', () => {
  const world = { width: 500, height: 500, characterHeight: 30,
    platforms: [{ id: 1, left: 100, right: 300, top: 300 }] };
  let player = { x: 180, footY: 230, velocityY: 0, groundedOn: null };
  for (let i = 0; i < 40; i++) player = stepPlayer(player, { horizontal: 0, jump: false }, world);
  assert.equal(player.groundedOn, 1);
  assert.equal(player.footY, 300);
  player = stepPlayer(player, { horizontal: 0, jump: true }, world);
  assert.equal(player.groundedOn, null);
  assert.ok(player.velocityY < 0);
  const below = { x: 180, footY: 331, velocityY: -300, groundedOn: null };
  const blocked = stepPlayer(below, { horizontal: 0, jump: false }, world);
  assert.equal(blocked.footY, 330);
  assert.equal(blocked.velocityY, 0);
});

test('a vertical page edge blocks horizontal crossing', () => {
  const world = { width: 500, height: 500, characterHeight: 30,
    platforms: [{ id: 1, left: 100, right: 400, top: 300 }],
    walls: [{ x: 220, top: 180, bottom: 350 }] };
  let player = spawnPlayer(world.platforms[0], world, 180);
  for (let i = 0; i < 50; i++) player = stepPlayer(player, { horizontal: 1, jump: false }, world);
  assert.ok(player.x + 30 * 0.42 / 2 <= 220.001);
});

test('a horizontal line also blocks side entry while the body straddles it', () => {
  const world = { width: 500, height: 500, characterHeight: 30,
    platforms: [{ id: 1, left: 220, right: 400, top: 300 }] };
  const player = stepPlayer({ x: 212, footY: 315, velocityY: 0, groundedOn: null },
    { horizontal: 1, jump: false }, world);
  assert.ok(player.x + 30 * 0.42 / 2 <= 220.001);
});

test('crouching halves horizontal speed and blocks jumping', () => {
  const world = { width: 500, height: 500, characterHeight: 30,
    platforms: [{ id: 1, left: 100, right: 400, top: 300 }] };
  const standing = spawnPlayer(world.platforms[0], world, 200);
  const walking = stepPlayer(standing, { horizontal: 1, jump: false }, world);
  const crouching = stepPlayer(standing, { horizontal: 1, jump: true, crouch: true }, world);
  assert.ok(Math.abs((crouching.x - standing.x) * 2 - (walking.x - standing.x)) < 0.001);
  assert.equal(crouching.groundedOn, 1);
  assert.equal(crouching.velocityY, 0);
});

for (const [width, height] of [[1920, 1080], [1366, 768], [800, 600]]) {
  test(`planner produces replayable route at ${width}x${height}`, () => {
    const world = demoWorld(width, height);
    const level = chooseLevel(world);
    assert.ok(level, 'expected a playable level');
    assert.ok(level.route.length >= 3 && level.route.length <= 4);
    assert.equal(level.recipes.length, level.route.length - 1);
    for (let i = 0; i < level.recipes.length; i++) {
      const recipe = level.recipes[i];
      const source = world.platforms.find(platform => platform.id === level.route[i]);
      assert.ok(source);
      let player = spawnPlayer(source, world, recipe.takeoffX);
      for (let frame = 0; frame < 110; frame++) {
        player = stepPlayer(player, {
          horizontal: frame < recipe.moveFrames ? recipe.horizontal : 0,
          jump: frame === 0,
        }, world);
        if (player.groundedOn !== null) break;
      }
      assert.equal(player.groundedOn, recipe.landedOn);
      assert.equal(recipe.landedOn, level.route[i + 1]);
    }
  });
}

test('planner refuses a truly disconnected or tiny viewport', () => {
  const world = { width: 1920, height: 1080, characterHeight: characterHeight(1080),
    platforms: [
      { id: 0, left: 100, right: 180, top: 800 },
      { id: 1, left: 1700, right: 1780, top: 500 },
    ] };
  assert.equal(chooseLevel(world), null);
  assert.equal(chooseLevel(demoWorld(500, 400)), null);
});

test('one broad page edge yields a page-only route with distinct start and goal', () => {
  const world = { width: 1200, height: 800, characterHeight: 24,
    platforms: [{ id: 7, left: 150, right: 600, top: 580, kind: 'page' }] };
  const first = chooseLevel(world, 0);
  const second = chooseLevel(world, 1);
  assert.ok(first);
  assert.equal(first.usedFallback, undefined);
  assert.equal(first.route.length, 1);
  assert.ok(Math.abs(first.startX - first.goalX) >= 240);
  assert.ok(Math.abs(second.startX - second.goalX) >= 240);
  assert.notEqual(first.startX, second.startX);
});

test('closed rectangles block their sides and bottom, and circles use a curved surface', () => {
  const shape = { id: 1, left: 200, right: 400, top: 200, bottom: 350, radius: 0, kind: 'rect' };
  const world = { width: 600, height: 600, characterHeight: 30, shapes: [shape],
    platforms: [{ id: 1, left: 200, right: 400, top: 200, shapeId: 1 }] };
  const blocked = stepPlayer({ x: 250, footY: 381, velocityY: -300, groundedOn: null },
    { horizontal: 0, jump: false }, world);
  assert.equal(blocked.footY, 380);
  assert.equal(blocked.velocityY, 0);
  const side = stepPlayer({ x: 192, footY: 280, velocityY: 0, groundedOn: null },
    { horizontal: 1, jump: false }, world);
  assert.ok(side.x <= 193.7);
  const circle = { ...shape, right: 300, bottom: 300, kind: 'ellipse' };
  assert.deepEqual(verticalSlice(circle, 249, 251), [200, 300]);
  assert.ok(verticalSlice(circle, 210, 215)[0] > 200);
});

test('narrow gaps merge and nearly duplicate nested contours are removed', () => {
  const rect = (id, left, right, top = 100, bottom = 200) =>
    ({ id, left, right, top, bottom, radius: 8, kind: 'rect' });
  const merged = normalizeShapes([rect(0, 0, 100), rect(1, 108, 200)], 24);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].right, 200);
  assert.equal(normalizeShapes([rect(0, 0, 200), rect(1, 5, 195, 105, 195)], 24).length, 1);
});

test('random endpoints avoid recent pairs and always have enough separation', () => {
  const world = { width: 1200, height: 800, characterHeight: 24,
    platforms: [{ id: 0, left: 100, right: 1000, top: 580, kind: 'page' }] };
  let seed = 123456;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const recent = [];
  for (let i = 0; i < 25; i++) {
    const level = chooseLevel(world, { random, recent });
    assert.ok(level);
    const pair = endpointPair(level);
    assert.ok(Math.abs(pair.startX - pair.goalX) >= 240);
    assert.ok(recent.every(old => Math.hypot(pair.startX - old.startX, pair.goalX - old.goalX) > 1));
    recent.push(pair);
  }
});

test('planner can choose a six-jump route without a three-jump ceiling', () => {
  const world = { width: 1600, height: 800, characterHeight: 24,
    platforms: Array.from({ length: 7 }, (_, id) => ({
      id, left: 80 + id * 190, right: 230 + id * 190, top: 550,
    })) };
  const level = chooseLevel(world);
  assert.ok(level);
  assert.equal(level.recipes.length, 6);
  assert.equal(new Set(level.route).size, 7);
});

for (const [width, height] of [[1920, 1080], [1366, 768], [800, 600], [640, 480]]) {
  test(`an empty page does not invent a map at ${width}x${height}`, () => {
    const world = { width, height, characterHeight: characterHeight(height), platforms: [] };
    assert.equal(createFallbackLevel(world), null);
  });
}
