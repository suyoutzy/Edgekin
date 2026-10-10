import test from 'node:test';
import assert from 'node:assert/strict';
import { RegionRotation, regionId, regionPoints, distributedSources } from '../dist/regions.js';
import { CollectionSession, chooseReward, chooseRewardWithDiscoveryAsync } from '../dist/rewards.js';
import { chooseLevel, reachableJumps } from '../dist/planner.js';
import { connectRegions, findConnection, permanentComponent } from '../dist/connections.js';
import { spawnPlayer, stepPlayer, STEP_SECONDS } from '../dist/physics.js';

const random = (seed = 321) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const wide = () => ({ width: 1920, height: 800, characterHeight: 30,
  platforms: [{ id: 0, left: 20, right: 1800, top: 330 }, { id: 1, left: 200, right: 1900, top: 420 }] });
function arrive(world, source, target) {
  let body = source, time = target.startTime;
  for (const input of target.actions) { body = stepPlayer(body, input, world, STEP_SECONDS, time); time += STEP_SECONDS; }
  assert.equal(body.groundedOn, target.platformId);
  assert.ok(Math.abs(body.x - target.x) <= 30 * .65);
  return { body, time };
}

test('region bags give equal turns and avoid a repeat across the round boundary', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rotation = new RegionRotation(), rng = random(seed), output = [];
    for (let i = 0; i < 60; i++) {
      const id = rotation.order([0, 1, 2, 3, 4, 5], rng)[0];
      assert.notEqual(id, output.at(-1)); output.push(id); rotation.commit(id);
    }
    for (let i = 0; i < 60; i += 6) assert.equal(new Set(output.slice(i, i + 6)).size, 6);
  }
});

test('long page edges supply all regions before graph connectivity is considered', () => {
  const world = wide(), points = regionPoints(world, random());
  assert.equal(new Set(points.map(point => point.regionId)).size, 6);
  for (let id = 0; id < 6; id++) assert.ok(points.filter(point => point.regionId === id).length <= 8);
  const incomplete = { ...world, reserved: [{ left: 1200, right: 1920, top: 0, bottom: 380 }] };
  assert.ok(regionPoints(incomplete).every(point => point.regionId !== 2));
  assert.ok(regionPoints(incomplete).some(point => point.regionId === 5), 'only the actual occupied area is excluded');
});

test('a deferred region remains a priority without starving the three connected regions', () => {
  const rotation = new RegionRotation(), rng = random(54), counts = [0, 0, 0, 0];
  for (let i = 0; i < 60; i++) {
    const order = rotation.order([0, 1, 2, 3], rng);
    assert.ok(order.includes(0));
    const chosen = order.find(id => id !== 0); counts[chosen]++; rotation.commit(chosen);
  }
  assert.deepEqual(counts, [0, 20, 20, 20]);
});

test('source budget reaches each region despite many wide surfaces in one corner', () => {
  const world = wide();
  const platforms = Array.from({ length: 80 }, (_, id) => ({ id, left: 20, right: 560, top: 500 + id }));
  platforms.push({ id: 100, left: 760, right: 850, top: 300 }, { id: 101, left: 1400, right: 1450, top: 300 });
  const picked = distributedSources(world, platforms);
  assert.equal(picked.length, 48);
  assert.ok(picked.some(platform => platform.id === 100)); assert.ok(picked.some(platform => platform.id === 101));
});

test('sixty replayed coins traverse all six regions with a varied coordinate each round', () => {
  const world = wide(), graph = reachableJumps(world), run = new CollectionSession(), rng = random(8);
  run.begin(world, world.platforms[1], 300);
  let from = run.respawn(), time = 0;
  const regions = [], coordinates = [];
  for (let i = 0; i < 60; i++) {
    const target = chooseReward(world, from, graph, { time, rotation: run.rotation, recent: run.recent, random: rng });
    assert.ok(target, `coin ${i + 1}`);
    const result = arrive(world, from, target);
    run.target = target; assert.ok(run.collect(result.body, world));
    regions.push(target.regionId); coordinates.push(`${target.x}:${target.footY}`);
    from = result.body; time = result.time;
  }
  for (let i = 0; i < 60; i += 6) assert.equal(new Set(regions.slice(i, i + 6)).size, 6);
  assert.ok(regions.every((id, i) => !i || id !== regions[i - 1]));
  assert.equal(new Set(coordinates).size, 60);
});

test('a missing frontier is expanded even while the local floor has another coin', async () => {
  const world = { width: 1000, height: 650, characterHeight: 24, platforms: [
    { id: 0, left: 100, right: 350, top: 520 }, { id: 1, left: 400, right: 450, top: 480 },
    { id: 2, left: 480, right: 820, top: 430 }] };
  const graph = reachableJumps(world, [0]);
  assert.ok(graph.get(0).some(recipe => recipe.landedOn === 1));
  assert.ok(!graph.has(1));
  const target = await chooseRewardWithDiscoveryAsync(world, spawnPlayer(world.platforms[0], world, 200), graph, { random: random() });
  assert.ok(target); assert.ok(graph.has(1), 'having a local coin cannot suppress frontier discovery');
});

test('a sparse sidebar and central content gain a permanent two-way bridge chain', () => {
  const original = { width: 1920, height: 1080, characterHeight: 30, platforms: [
    { id: 0, left: 30, right: 310, top: 850, key: 'sidebar' },
    { id: 1, left: 760, right: 1420, top: 650, key: 'content' }] };
  const result = connectRegions(original, reachableJumps(original));
  const bridges = result.world.platforms.filter(platform => platform.bridge);
  assert.ok(bridges.length > 0 && bridges.length <= 6);
  assert.ok(bridges.every(platform => !platform.blink && !platform.crumble));
  assert.equal(original.platforms.length, 2);
  const run = new CollectionSession(); run.begin(result.world, original.platforms[0], 250);
  const target = chooseReward(result.world, run.respawn(), result.graph, { rotation: run.rotation,
    random: random(), recent: [{ x: 250, footY: 850, platformId: 0 }] });
  assert.ok(target); assert.ok(target.x > 600, 'the coin can escape the sidebar');
  const reached = arrive(result.world, run.respawn(), target);
  const back = chooseReward(result.world, reached.body, result.graph, { preferred: { platformId: 0, x: 250 }, time: reached.time });
  assert.ok(back); arrive(result.world, reached.body, back);
});

test('a raised solid ledge is approached from beyond its underside on a broad floor', () => {
  const world = { width: 1200, height: 700, characterHeight: 30, platforms: [
    { id: 0, left: 500, right: 1100, top: 594 }, { id: 1, left: 680, right: 758, top: 519 }] };
  const iterator = findConnection(world, world.platforms[0], world.platforms[1]);
  let result = iterator.next(); while (!result.done) result = iterator.next();
  assert.ok(result.value);
  assert.ok(result.value.takeoffX < world.platforms[1].left || result.value.takeoffX > world.platforms[1].right);
  let body = spawnPlayer(world.platforms[0], world, result.value.takeoffX);
  for (const [frame, input] of result.value.steps.entries()) body = stepPlayer(body, input, world, STEP_SECONDS, frame * STEP_SECONDS);
  assert.equal(body.groundedOn, 1);
});

test('vertically overlapping page surfaces gain staggered solid ledges and return routes', () => {
  const world = { width: 1920, height: 1080, characterHeight: 30, platforms: [
    { id: 0, key: 'upper', left: 1150, right: 1800, top: 330 },
    { id: 1, key: 'lower', left: 740, right: 1400, top: 625 }] };
  const connected = connectRegions(world, reachableJumps(world));
  assert.ok(permanentComponent(connected.graph, 0, connected.world).has(1));
  const bridges = connected.world.platforms.filter(p => p.bridge);
  assert.ok(bridges.length && bridges.length <= 3);
  assert.ok(new Set(bridges.map(p => p.left)).size > 1);
  const from = spawnPlayer(world.platforms[0], connected.world, 1400);
  const target = chooseReward(connected.world, from, connected.graph, { preferred: { platformId: 1, x: 1000 } });
  assert.ok(target); const reached = arrive(connected.world, from, target);
  const back = chooseReward(connected.world, reached.body, connected.graph, { preferred: { platformId: 0, x: 1400 }, time: reached.time });
  assert.ok(back); arrive(connected.world, reached.body, back);
});

test('regional rewards do not enter a one-way drop and initial spawn favours returnable regions', () => {
  const world = { width: 1920, height: 1080, characterHeight: 30, platforms: [
    { id: 0, left: 200, right: 1800, top: 450 }, { id: 1, left: 20, right: 140, top: 900 }] };
  const graph = reachableJumps(world);
  assert.ok(graph.get(0).some(recipe => recipe.landedOn === 1));
  assert.ok(!permanentComponent(graph, 0, world).has(1));
  assert.equal(chooseLevel(world, { graph, relaxed: true, random: random() }).startId, 0);
  const rotation = new RegionRotation(); rotation.commit(1);
  const target = chooseReward(world, spawnPlayer(world.platforms[0], world, 1000), graph,
    { rotation, random: random() });
  assert.ok(target); assert.equal(target.platformId, 0);
  assert.ok(regionPoints(world).some(point => point.regionId === 3), 'unconnected regions remain in the coverage denominator');
});

test('a graph return edge on the far side of a wall cannot certify the actual coin position', () => {
  const world = { width: 1000, height: 900, characterHeight: 30,
    walls: [{ x: 460, top: 400, bottom: 600 }], platforms: [
      { id: 0, left: 60, right: 930, top: 600 }, { id: 1, left: 150, right: 800, top: 520 }] };
  const makeRecipe = (source, x, moveFrames, jump, destination) => {
    let body = spawnPlayer(world.platforms[source], world, x);
    const steps = [];
    for (let frame = 0; frame < 120; frame++) {
      const input = { horizontal: frame < moveFrames ? 1 : 0, jump: frame === 0 && jump };
      steps.push(input); body = stepPlayer(body, input, world, STEP_SECONDS, frame * STEP_SECONDS);
      if (body.groundedOn === destination) return { takeoffX: x, horizontal: 1, moveFrames,
        landingX: body.x, landedOn: destination, kind: jump ? 'jump' : 'walk', steps };
    }
    assert.fail('The graph edge itself must be a real, executable connection');
  };
  const graph = new Map([[0, [makeRecipe(0, 70, 45, true, 1)]], [1, [makeRecipe(1, 790, 30, false, 0)]]]);
  assert.ok(permanentComponent(graph, 0, world).has(1), 'platform graph alone incorrectly suggests a return');
  const source = spawnPlayer(world.platforms[0], world, 100), preferred = { platformId: 1, x: 260 };
  const forward = chooseReward(world, source, graph, { preferred });
  assert.ok(forward); arrive(world, source, forward);
  assert.equal(chooseReward(world, source, graph, { preferred, rotation: new RegionRotation() }), null,
    'the return takeoff is unreachable from the coin side of the wall');
});
