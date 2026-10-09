import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLevel, reachableJumps, recipeControl } from '../dist/planner.js';
import { createFallbackLevel } from '../dist/fallback.js';
import { spawnPlayer, stepPlayer } from '../dist/physics.js';

function seededRandom(seed = 12345) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function replayRecipes(level) {
  for (let index = 0; index < level.recipes.length; index++) {
    const recipe = level.recipes[index];
    const source = level.world.platforms.find(platform => platform.id === level.route[index]);
    let player = spawnPlayer(source, level.world, recipe.takeoffX, recipe.takeoffCrouch);
    for (let frame = 0; frame < 190; frame++) {
      player = stepPlayer(player, recipeControl(recipe, frame), level.world);
      if (player.groundedOn !== null && player.groundedOn !== source.id) break;
    }
    assert.equal(player.groundedOn, recipe.landedOn, 'recipe must replay against the complete collision world');
  }
}

test('planner tries a lower-scoring page surface when complex endpoint routes cannot pass their walls', () => {
  const platforms = Array.from({ length: 7 }, (_, id) => ({
    id, left: 80 + id * 190, right: 230 + id * 190, top: 550, kind: 'page',
  }));
  platforms.push({ id: 7, left: 2000, right: 2800, top: 700, kind: 'page' });
  const world = { width: 3000, height: 800, characterHeight: 24, platforms,
    walls: platforms.slice(0, 7).map(platform => ({
      x: (platform.left + platform.right) / 2, top: 406, bottom: 551,
    })) };
  // Adjacent platforms have valid jump edges, but their middle walls prevent
  // chaining those edges or walking far enough to separate the endpoints.
  const graph = reachableJumps(world);
  assert.ok([...graph.values()].some(recipes => recipes.length > 0));
  // This regression concerns fallback selection when available actions cannot
  // cross intermediate walls. Wall jumps are covered separately in 0.2.
  const ordinary = new Map([...graph].map(([id, recipes]) =>
    [id, recipes.filter(recipe => recipe.kind === 'jump')]));
  const level = chooseLevel(world, { random: seededRandom(), graph: ordinary });
  assert.ok(level, 'the unobstructed, isolated page surface must still be offered');
  assert.deepEqual(level.route, [7]);
  assert.ok(Math.abs(level.startX - level.goalX) >= 260);
});

test('restricted jump sampling retains other platforms as real collision and landing targets', () => {
  const world = { width: 1200, height: 800, characterHeight: 24,
    platforms: [
      { id: 0, left: 100, right: 250, top: 550 },
      { id: 1, left: 290, right: 440, top: 550 },
      { id: 2, left: 900, right: 1050, top: 550 },
    ] };
  const graph = reachableJumps(world, [0]);
  assert.deepEqual([...graph.keys()], [0], 'unrelated takeoff sources are not sampled');
  const recipe = graph.get(0).find(item => item.landedOn === 1);
  assert.ok(recipe, 'the unsampled neighboring platform remains a landing target');
  replayRecipes({ world, route: [0, 1], recipes: [recipe] });
});

test('one-helper fallback yields an actual, fully replayable page-to-helper route', () => {
  const world = { width: 800, height: 600, characterHeight: 24,
    platforms: [{ id: 0, left: 100, right: 180, top: 400, kind: 'page' }] };
  assert.equal(chooseLevel(world, { random: seededRandom() }), null);
  const level = createFallbackLevel(world, { random: seededRandom() });
  assert.ok(level);
  assert.equal(level.usedFallback, true);
  const helpers = level.world.platforms.filter(platform => platform.kind === 'helper');
  assert.equal(helpers.length, 1);
  assert.ok(level.route.includes(helpers[0].id));
  assert.ok(level.route.includes(0));
  assert.ok(Math.hypot(level.startX - level.goalX,
    level.world.platforms.find(platform => platform.id === level.startId).top -
    level.world.platforms.find(platform => platform.id === level.goalId).top) >= 168);
  replayRecipes(level);
});

test('dense small-icon routes do not exhaust random attempts on endpoints that can never be far enough apart', () => {
  const shapes = Array.from({ length: 20 }, (_, id) => ({ id, left: 30 + id * 34,
    right: 48 + id * 34, top: 160, bottom: 178, radius: id % 4 === 3 ? 9 : 3,
    kind: id % 4 === 3 ? 'ellipse' : 'rect' }));
  const world = { width: 1920, height: 1080, characterHeight: 32.4, shapes,
    platforms: shapes.map(shape => ({ id: shape.id, left: shape.left, right: shape.right,
      top: shape.top, shapeId: shape.id })) };
  const graph = reachableJumps(world);
  for (let seed = 1; seed <= 20; seed++) {
    const level = chooseLevel(world, { graph, random: seededRandom(seed) });
    assert.ok(level, `expected a route for seed ${seed}`);
    assert.ok(Math.abs(level.startX - level.goalX) >= 260);
    const source = world.platforms.find(platform => platform.id === level.startId);
    assert.equal(spawnPlayer(source, world, level.startX).x, level.startX,
      'the sampled endpoint must not rely on a hidden spawn clamp');
    replayRecipes(level);
  }
});
