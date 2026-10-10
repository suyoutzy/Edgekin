import test from 'node:test';
import assert from 'node:assert/strict';
import { stepPlayer, spawnPlayer, canOccupy, STEP_SECONDS, movementSpeed } from '../dist/physics.js';
import { platformIsActive } from '../dist/platform-state.js';
import { CollectionSession, chooseReward } from '../dist/rewards.js';
import { reachableJumps, chooseLevel } from '../dist/planner.js';
import { verticalSlice, horizontalSlice, normalizeShapes } from '../dist/geometry.js';
import { shapeSegments } from '../dist/contours.js';

const world = () => ({ width: 1400, height: 800, characterHeight: 30,
  platforms: [{ id: 0, left: 50, right: 1350, top: 650 }] });
const idle = { horizontal: 0, jump: false };

test('fast fall cancels ascent immediately, retains aerial movement, and cannot tunnel through a floor', () => {
  const map = world();
  let body = stepPlayer(spawnPlayer(map.platforms[0], map, 300), { ...idle, jump: true }, map);
  for (let i = 0; i < 8; i++) body = stepPlayer(body, idle, map);
  const falling = stepPlayer(body, { ...idle, horizontal: 1, fastFall: true }, map);
  assert.ok(body.velocityY < 0 && falling.velocityY > 600);
  assert.ok(falling.x - body.x > movementSpeed(map) * STEP_SECONDS * .99);
  assert.equal(falling.crouching, false);
  assert.equal(falling.event, 'fast-fall');
  body = falling;
  for (let i = 0; i < 80 && body.groundedOn === null; i++) body = stepPlayer(body, { ...idle, fastFall: true }, map);
  assert.equal(body.groundedOn, 0);
  assert.equal(body.footY, 650);
  assert.equal(body.velocityY, 0);
  const crouch = stepPlayer(body, { ...idle, horizontal: 1, crouch: true, jump: true }, map);
  assert.equal(crouch.groundedOn, 0);
  assert.ok(Math.abs(crouch.x - body.x - movementSpeed(map) * STEP_SECONDS / 2) < .001);
});

test('temporary platforms lose all collision while hidden and regain their solid underside', () => {
  const map = world();
  map.platforms.push({ id: 1, left: 200, right: 450, top: 480,
    blink: { period: 7, visibleSeconds: 5, phase: 0 } });
  const ledge = map.platforms[1];
  assert.equal(platformIsActive(ledge, 4.9), true);
  assert.equal(platformIsActive(ledge, 5), false);
  assert.equal(platformIsActive(ledge, 6.99), false);
  assert.equal(platformIsActive(ledge, 7), true);
  const supported = spawnPlayer(ledge, map, 300);
  const removed = stepPlayer(supported, idle, map, STEP_SECONDS, 5);
  assert.equal(removed.groundedOn, null);
  assert.equal(removed.coyoteTime, 0);
  assert.equal(stepPlayer(supported, idle, map, STEP_SECONDS, 7).groundedOn, 1);
  assert.equal(canOccupy(map, 300, 495, false, undefined, 4), false);
  assert.equal(canOccupy(map, 300, 495, false, undefined, 5), true);
  const under = { x: 300, footY: 530, velocityY: -600, groundedOn: null };
  const blocked = stepPlayer(under, idle, map, .05, 7);
  assert.equal(blocked.event, 'ceiling');
  assert.equal(blocked.footY, 510);
  assert.ok(stepPlayer(under, idle, map, .05, 5).footY < 510);
});

test('respawn penalty changes only score and clamps to zero, checkpoint and pending coin survive', () => {
  const map = world(), run = new CollectionSession();
  run.begin(map, map.platforms[0], 300);
  run.score = 3;
  run.target = { platformId: 0, x: 1200, footY: 650 };
  const checkpoint = run.respawn();
  assert.equal(run.penalize(), 1);
  assert.equal(run.score, 2);
  assert.deepEqual(run.respawn(), checkpoint);
  assert.equal(run.target.x, 1200);
  run.penalize(); run.penalize();
  assert.equal(run.penalize(), 0);
  assert.equal(run.score, 0);
  run.score = 2;
  run.begin(map, map.platforms[0], 400);
  assert.equal(run.score, 2, 'layout rebuilds do not charge a failure');
});

test('a familiar two-corner loop yields to a fresh region even on the same broad floor', () => {
  const map = world(), from = spawnPlayer(map.platforms[0], map, 90);
  const recent = [90, 1300, 90, 1300].map(x => ({ x, footY: 650, platformId: 0 }));
  const coin = chooseReward(map, from, new Map([[0, []]]), { recent, random: () => .5 });
  assert.ok(coin);
  assert.ok(coin.x > 250 && coin.x < 1100, 'old corners must not win over unvisited space');
});

test('fresh destinations take priority over a recently visited platform, with bounded repetition fallback', () => {
  const map = { ...world(), platforms: [{ id: 0, left: 100, right: 300, top: 600 },
    { id: 1, left: 330, right: 520, top: 560 }, { id: 2, left: 330, right: 520, top: 470 }] };
  const graph = reachableJumps(map), from = spawnPlayer(map.platforms[0], map, 240);
  const coin = chooseReward(map, from, graph, { random: () => .5,
    recent: [{ platformId: 1, x: 500, footY: 560 }] });
  assert.ok(coin);
  assert.notEqual(coin.platformId, 1);
  const one = world(), player = spawnPlayer(one.platforms[0], one, 100);
  const repeated = chooseReward(one, player, new Map([[0, []]]), { random: () => .5,
    recent: [100, 340, 690, 1290].map(x => ({ x, footY: 650, platformId: 0 })) });
  assert.ok(repeated, 'small maps are allowed to reuse a valid region when fresh choices are exhausted');
});

test('coins and initial endpoints never use disappearing supports', () => {
  const map = { ...world(), platforms: [{ id: 0, left: 50, right: 700, top: 650 },
    { id: 1, left: 100, right: 240, top: 595, blink: { period: 7, visibleSeconds: 5, phase: 0 } }] };
  const graph = reachableJumps(map), source = spawnPlayer(map.platforms[0], map, 300);
  const coin = chooseReward(map, source, graph, { random: () => .5, time: 4.5 });
  assert.ok(coin);
  assert.equal(coin.platformId, 0);
  let body = source, time = coin.startTime;
  for (const input of coin.actions) {
    body = stepPlayer(body, input, map, STEP_SECONDS, time);
    time += STEP_SECONDS;
  }
  assert.equal(body.groundedOn, coin.platformId);
  let seed = 42;
  const level = chooseLevel(map, { graph, relaxed: true,
    random: () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; } });
  assert.ok(level);
  assert.equal(level.startId, 0); assert.equal(level.goalId, 0);
});

test('convex webpage polygons use sloping edges for collision and merge duplicate SVG boxes', () => {
  const diamond = { id: 0, left: 200, right: 400, top: 200, bottom: 400, radius: 0,
    kind: 'polygon', points: [[300, 200], [400, 300], [300, 400], [200, 300]] };
  assert.deepEqual(verticalSlice(diamond, 245, 255), [245, 355]);
  assert.deepEqual(horizontalSlice(diamond, 245, 255), [245, 355]);
  assert.equal(shapeSegments(diamond).length, 4);
  const map = { ...world(), shapes: [diamond], platforms: [{ id: 0, left: 200, right: 400, top: 200, shapeId: 0 }] };
  assert.ok(canOccupy(map, 220, 245), 'empty area above the slope is no longer a rectangular obstacle');
  assert.equal(canOccupy(map, 220, 320), false);
  const body = stepPlayer({ x: 250, footY: 230, velocityY: 600, groundedOn: null }, idle, map, .05);
  assert.equal(body.groundedOn, 0);
  assert.ok(body.footY > 240 && body.footY < 245);
  const rect = { ...diamond, kind: 'rect', points: undefined };
  const merged = normalizeShapes([rect, diamond], 30, 17.4);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'polygon');
});

test('a coin beyond a temporary bridge has a replayable timed route across hidden and visible phases', () => {
  const map = { width: 1100, height: 800, characterHeight: 30,
    platforms: [{ id: 0, left: 100, right: 260, top: 650 },
      { id: 1, left: 330, right: 450, top: 590, blink: { period: 7, visibleSeconds: 5, phase: 0 } },
      { id: 2, left: 520, right: 850, top: 500 }] };
  const graph = reachableJumps(map), from = spawnPlayer(map.platforms[0], map, 220);
  assert.ok(!graph.get(0).some(recipe => recipe.landedOn === 2), 'the destination requires its intermediate ledge');
  for (const phase of [4.8, 5.8, 6.8, 7.8]) {
    const coin = chooseReward(map, from, graph, { time: phase, random: () => .5,
      recent: [{ x: 180, footY: 650, platformId: 0 }] });
    assert.ok(coin, `phase ${phase} must allow continued exploration`);
    assert.equal(coin.platformId, 2);
    assert.deepEqual(coin.route, [0, 1, 2]);
    let body = from, seconds = coin.startTime, usedBridge = false;
    for (const input of coin.actions) {
      body = stepPlayer(body, input, map, STEP_SECONDS, seconds);
      if (body.groundedOn === 1) {
        assert.equal(platformIsActive(map.platforms[1], seconds), true, 'a hidden surface must never carry the witness');
        usedBridge = true;
      }
      seconds += STEP_SECONDS;
    }
    assert.ok(usedBridge);
    assert.equal(body.groundedOn, 2);
    assert.ok(Math.abs(body.x - coin.x) < 20);
  }
});
