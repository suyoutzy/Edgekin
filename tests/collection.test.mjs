import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionSession, chooseReward, chooseRewardAsync, chooseRewardWithDiscoveryAsync, rewardDistance } from '../dist/rewards.js';
import { reachableJumps, recipeControl } from '../dist/planner.js';
import { spawnPlayer, stepPlayer, STEP_SECONDS } from '../dist/physics.js';
import { createPatrols, hitsPatrol, safeFromPatrols } from '../dist/hazards.js';

function random(seed = 321) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}
function floorWorld() {
  return { width: 1400, height: 800, characterHeight: 30,
    platforms: [{ id: 0, left: 50, right: 1350, top: 550, kind: 'page' }] };
}
function replay(world, from, target, patrols = []) {
  let player = { ...from, jumpBufferTime: 0, wallJumpTime: 0 }, time = target.startTime;
  for (const input of target.actions) {
    const next = stepPlayer(player, input, world, STEP_SECONDS, time);
    assert.equal(hitsPatrol(player, next, world, patrols, time, time + STEP_SECONDS), false,
      'the witness must avoid dynamic hazards');
    player = next;
    time += STEP_SECONDS;
  }
  assert.equal(player.groundedOn, target.platformId);
  assert.ok(Math.abs(player.x - target.x) < world.characterHeight * .65);
  return { player, time };
}

test('a coin is counted once, updates the safe checkpoint and survives map rebuilding', () => {
  const world = floorWorld(), run = new CollectionSession();
  run.begin(world, world.platforms[0], 100);
  const player = spawnPlayer(world.platforms[0], world, 900);
  run.target = { platformId: 0, x: 900, footY: 550 };
  assert.equal(run.collect({ ...player, groundedOn: null }, world), false);
  assert.equal(run.collect(player, world), true);
  assert.equal(run.score, 1);
  assert.equal(run.collect(player, world), false);
  const saved = run.respawn();
  assert.equal(saved.x, 900);
  saved.x = 1200;
  assert.equal(run.respawn().x, 900, 'checkpoint state cannot be mutated by a respawned body');
  run.begin(world, world.platforms[0], 100);
  assert.equal(run.score, 1, 'regenerating geometry does not reset the score');
});

test('continuous targets originate at each collected position and remain varied and replayable', () => {
  const world = floorWorld(), graph = new Map([[0, []]]), run = new CollectionSession();
  const sourcePlatforms = world.platforms;
  run.begin(world, sourcePlatforms[0], 100);
  let from = run.respawn(), time = 0;
  const rng = random(), targets = [];
  for (let count = 0; count < 24; count++) {
    const target = chooseReward(world, from, graph, { time, random: rng, recent: run.recent });
    assert.ok(target, 'a broad surface supports uninterrupted collection');
    assert.ok(Math.hypot(target.x - from.x, target.footY - from.footY) >= world.characterHeight * 2,
      'only immediate recollection is excluded; distance is not a difficulty score');
    const result = replay(world, from, target);
    run.target = target;
    assert.equal(run.collect(result.player, world), true);
    targets.push(target.x);
    from = result.player;
    time = result.time;
  }
  assert.equal(run.score, 24);
  assert.equal(world.platforms, sourcePlatforms);
  assert.equal(new Set(targets).size, 24, 'sampling is not a fixed cycle of points');
  assert.equal(run.recent.length, 12);
});

test('a checkpoint on a tiny icon preserves the actual supported arrival position', () => {
  const world = { ...floorWorld(), platforms: [{ id: 0, left: 100, right: 118, top: 550 }] };
  const run = new CollectionSession();
  run.begin(world, world.platforms[0], 109);
  run.target = { platformId: 0, x: 109, footY: 550 };
  const player = { ...spawnPlayer(world.platforms[0], world), x: 102 };
  assert.equal(run.collect(player, world), true);
  assert.equal(run.respawn().x, 102);
  assert.equal(stepPlayer(run.respawn(), { horizontal: 0, jump: false }, world).groundedOn, 0);
});

test('target selection prefers a reachable jump route over walking along the source floor', () => {
  const world = { width: 1000, height: 650, characterHeight: 24, platforms: [
    { id: 0, left: 50, right: 270, top: 500 },
    { id: 1, left: 320, right: 850, top: 440 },
  ] };
  const from = spawnPlayer(world.platforms[0], world, 120);
  const target = chooseReward(world, from, reachableJumps(world), { random: random() });
  assert.ok(target);
  assert.equal(target.platformId, 1);
  assert.ok(target.jumpCount > 0);
  replay(world, from, target);
});

test('a wall across one broad surface cannot be bypassed by the target selector', () => {
  const world = { ...floorWorld(), walls: [{ x: 330, top: 0, bottom: 550 }] };
  const from = spawnPlayer(world.platforms[0], world, 200);
  const target = chooseReward(world, from, new Map([[0, []]]), { random: random() });
  assert.ok(target, 'a shorter target on this side is preferable to ending the run');
  assert.ok(target.x < 330);
  replay(world, from, target);
});

test('continuous target validation retains low-beam crouching from the actual arrival position', () => {
  const world = { width: 1000, height: 600, characterHeight: 30, platforms: [
    { id: 0, left: 100, right: 340, top: 400 },
    { id: 1, left: 340, right: 900, top: 400 },
    { id: 2, left: 220, right: 560, top: 378 },
  ] };
  const graph = reachableJumps(world, [0]);
  graph.set(0, graph.get(0).filter(recipe => recipe.kind === 'crouch' && recipe.landedOn === 1));
  const from = spawnPlayer(world.platforms[0], world, 150);
  const target = chooseReward(world, from, graph, { random: random() });
  assert.ok(target);
  assert.equal(target.platformId, 1);
  assert.ok(target.crouchCount > 0);
  replay(world, from, target);
});

test('a reward beyond ordinary jump height has a replayable wall-jump witness', () => {
  const world = { width: 900, height: 650, characterHeight: 30,
    shapes: [{ id: 1, left: 300, right: 450, top: 310, bottom: 500, radius: 0, kind: 'rect' }],
    platforms: [{ id: 0, left: 100, right: 250, top: 500 },
      { id: 1, left: 300, right: 450, top: 310, shapeId: 1 }] };
  const from = spawnPlayer(world.platforms[0], world, 130);
  const target = chooseReward(world, from, reachableJumps(world), { random: random() });
  assert.ok(target);
  assert.equal(target.platformId, 1);
  assert.ok(target.wallJumpCount >= 1);
  assert.ok(target.jumpCount >= 2);
  replay(world, from, target);
});

test('a fake cached jump through a wall is rejected by full-world replay', () => {
  const world = { width: 900, height: 700, characterHeight: 30,
    platforms: [{ id: 0, left: 100, right: 260, top: 500 },
      { id: 1, left: 340, right: 800, top: 500 }],
    walls: [{ x: 300, top: 0, bottom: 700 }] };
  const from = spawnPlayer(world.platforms[0], world, 180);
  const graph = new Map([[0, [{ takeoffX: 245, horizontal: 1, moveFrames: 60,
    landedOn: 1, landingX: 480, kind: 'jump' }]]]);
  const target = chooseReward(world, from, graph, { random: random() });
  assert.ok(target, 'nearby fallback can still use the current floor');
  assert.equal(target.platformId, 0, 'the fake edge must never reach the far side');
  replay(world, from, target);
});

test('a tiny exhausted area does not produce a nearby or unreachable substitute coin', () => {
  const world = { ...floorWorld(), platforms: [{ id: 0, left: 100, right: 200, top: 550 }] };
  const from = spawnPlayer(world.platforms[0], world, 150);
  assert.equal(chooseReward(world, from, new Map([[0, []]])), null);
});

test('reward generation can be cancelled before it starts', async () => {
  const controller = new AbortController(); controller.abort();
  const world = floorWorld();
  await assert.rejects(chooseRewardAsync(world, spawnPlayer(world.platforms[0], world),
    new Map(), {}, controller.signal), { name: 'AbortError' });
});

test('a patrol can be crossed safely by actual jumping at eight starting phases', () => {
  const world = floorWorld(), from = spawnPlayer(world.platforms[0], world, 100);
  for (let phase = 0; phase < 1; phase += .125) {
    const patrols = [{ id: 0, platformId: 0, left: 650, right: 710, footY: 550,
      radius: 7.5, period: 3.5, phase }];
    const target = chooseReward(world, from, new Map([[0, []]]), { patrols, random: random(),
      recent: [90, 230, 450, 710].map(x => ({ x, footY: 550, platformId: 0 })) });
    assert.ok(target, `phase ${phase} must permit a target`);
    assert.ok(target.x > 755, 'the tested route actually crosses the patrol');
    assert.ok(target.jumpCount > 0);
    assert.ok(safeFromPatrols(world, patrols, target.x, target.footY));
    replay(world, from, target, patrols);
  }
});

test('patrol placement reserves broad flat jump space and avoids protected points', () => {
  const world = floorWorld(), points = [{ x: 100, footY: 550 }, { x: 1250, footY: 550 }];
  const patrols = createPatrols(world, points, [0], random());
  assert.equal(patrols.length, 1);
  assert.ok(patrols[0].right - patrols[0].left >= 650, 'a long floor gets a wide patrol range');
  assert.ok(Math.PI * (patrols[0].right - patrols[0].left) / patrols[0].period > 200,
    'peak speed is higher than the old two-height patrol');
  assert.ok(points.every(point => safeFromPatrols(world, patrols, point.x, point.footY)));
  const narrow = { ...world, platforms: [{ id: 0, left: 100, right: 450, top: 550 }] };
  assert.deepEqual(createPatrols(narrow, []), []);
  const low = { ...world, platforms: [...world.platforms, { id: 1, left: 50, right: 1350, top: 530 }] };
  assert.ok(!createPatrols(low, [], [0]).some(patrol => patrol.platformId === 0));
});

test('wide fast patrols permit verified targets at multiple starting phases', () => {
  const world = floorWorld(), from = spawnPlayer(world.platforms[0], world, 100);
  const base = createPatrols(world, [from, { x: 1250, footY: 550 }], [0], random())[0];
  for (let phase = 0; phase < 1; phase += .125) {
    const patrols = [{ ...base, phase }];
    const target = chooseReward(world, from, new Map([[0, []]]), { patrols, random: random() });
    assert.ok(target, `wide fast patrol should allow continued play at phase ${phase}`);
    replay(world, from, target, patrols);
  }
});

test('coins can use a patrol range when the actual arrival is safe', () => {
  const world = floorWorld(), from = spawnPlayer(world.platforms[0], world, 100);
  const patrols = [{ id: 0, platformId: 0, left: 300, right: 1340, footY: 550,
    radius: 7.5, period: 12, phase: .5 }];
  const target = chooseReward(world, from, new Map([[0, []]]), { patrols, random: random(),
    recent: [90, 230].map(x => ({ x, footY: 550, platformId: 0 })) });
  assert.ok(target);
  assert.ok(target.x >= 300 && target.x <= 1340, 'a swept area is no longer completely excluded');
  replay(world, from, target, patrols);
});

test('shorter and crouched targets keep small traversable regions playable', () => {
  const world = { ...floorWorld(), platforms: [{ id: 0, left: 100, right: 260, top: 550 },
    { id: 1, left: 80, right: 280, top: 528 }] };
  const from = spawnPlayer(world.platforms[0], world, 115, true);
  const target = chooseReward(world, from, new Map([[0, []]]), { random: random() });
  assert.ok(target);
  assert.ok(Math.abs(target.x - from.x) >= world.characterHeight * 2);
  assert.ok(Math.abs(target.x - from.x) < rewardDistance(world));
  const { player } = replay(world, from, target);
  assert.equal(player.crouching, true);
});

test('omitted reachable graph sources are sampled before declaring no target', async () => {
  const world = { width: 1000, height: 650, characterHeight: 24,
    platforms: [{ id: 0, left: 100, right: 150, top: 520 },
      { id: 1, left: 175, right: 235, top: 480 },
      { id: 2, left: 290, right: 820, top: 430 }] };
  const from = spawnPlayer(world.platforms[0], world, 125);
  const graph = new Map();
  const target = await chooseRewardWithDiscoveryAsync(world, from, graph, { random: random() });
  assert.ok(target);
  assert.ok(graph.has(0));
  replay(world, from, target);
});

test('a patrol at the landing point permits a target only after a safe waiting window', () => {
  const world = { width: 1100, height: 700, characterHeight: 30,
    platforms: [{ id: 0, left: 100, right: 260, top: 500 },
      { id: 1, left: 340, right: 1000, top: 500 }] };
  const recipe = reachableJumps(world, [0]).get(0).find(recipe => recipe.landedOn === 1 && recipe.kind === 'jump');
  assert.ok(recipe);
  const from = spawnPlayer(world.platforms[0], world, recipe.takeoffX);
  let landed = from, seconds = 0;
  for (let frame = 0; frame < 118; frame++) {
    landed = stepPlayer(landed, recipeControl(recipe, frame), world);
    seconds += STEP_SECONDS;
    if (landed.groundedOn === 1) break;
  }
  assert.equal(landed.groundedOn, 1);
  const patrols = [{ id: 0, platformId: 1, left: landed.x - 30, right: landed.x + 30,
    footY: 500, radius: 7.5, period: 3.5, phase: .25 - seconds / 3.5 }];
  const graph = new Map([[0, [recipe]], [1, []]]);
  const target = chooseReward(world, from, graph, { patrols, random: random() });
  assert.ok(target);
  const firstJump = target.actions.findIndex(input => input.jump);
  assert.ok(firstJump > 0, 'the direct launch collides; a delayed launch must be validated');
  replay(world, from, target, patrols);
});

test('relative-motion collision catches crossings between frames but clears a jump overhead', () => {
  const world = floorWorld();
  const patrols = [{ id: 0, platformId: 0, left: 300, right: 300, footY: 550,
    radius: 7.5, period: 3, phase: 0 }];
  const from = spawnPlayer(world.platforms[0], world, 240), to = { ...from, x: 340 };
  assert.equal(hitsPatrol(from, from, world, patrols, 0, STEP_SECONDS), false);
  assert.equal(hitsPatrol(to, to, world, patrols, 0, STEP_SECONDS), false);
  assert.equal(hitsPatrol(from, to, world, patrols, 0, STEP_SECONDS), true);
  assert.equal(hitsPatrol({ ...from, footY: 520 }, { ...to, footY: 520 }, world,
    patrols, 0, STEP_SECONDS), false);
  const moving = [{ ...patrols[0], left: 200, right: 400, period: .1 }];
  const stationary = { ...from, x: 300 };
  assert.equal(hitsPatrol(stationary, stationary, world, moving, 0, .05), true);
});
