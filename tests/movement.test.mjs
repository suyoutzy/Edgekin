import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyHeight, canOccupy, spawnPlayer, stepPlayer } from '../dist/physics.js';
import { assessRoute, chooseLevel, reachableJumps, reachableJumpsAsync, recipeControl } from '../dist/planner.js';
import { createFallbackLevelAsync } from '../dist/fallback.js';
import { normalizeShapes } from '../dist/geometry.js';

const idle = { horizontal: 0, jump: false };
const floorWorld = () => ({ width: 800, height: 600, characterHeight: 30,
  platforms: [{ id: 0, left: 100, right: 600, top: 400 }] });
function replay(world, sourceId, recipe) {
  const source = world.platforms.find(platform => platform.id === sourceId);
  let player = spawnPlayer(source, world, recipe.takeoffX, recipe.takeoffCrouch);
  let wallJumps = 0;
  for (let frame = 0; frame < 190; frame++) {
    player = stepPlayer(player, recipeControl(recipe, frame), world);
    if (player.event === 'wall-jump') wallJumps++;
    if (player.groundedOn !== null && player.groundedOn !== sourceId) break;
  }
  assert.equal(player.groundedOn, recipe.landedOn);
  return { player, wallJumps };
}

test('a low ceiling blocks standing but allows the actual crouched body through', () => {
  const world = floorWorld();
  world.platforms.push({ id: 1, left: 220, right: 380, top: 378 });
  let standing = spawnPlayer(world.platforms[0], world, 180);
  let crouched = standing;
  for (let i = 0; i < 100; i++) {
    standing = stepPlayer(standing, { horizontal: 1, jump: false }, world);
    crouched = stepPlayer(crouched, { horizontal: 1, jump: false, crouch: true }, world);
  }
  assert.ok(standing.x < 220);
  assert.ok(crouched.x > 380);
  assert.equal(crouched.groundedOn, 0);
  assert.equal(bodyHeight(world, true), 17.4);
});

test('releasing down under a beam keeps the crouch and rejects jump until standing is clear', () => {
  const world = floorWorld();
  world.platforms.push({ id: 1, left: 220, right: 380, top: 378 });
  let player = spawnPlayer(world.platforms[0], world, 280, true);
  player = stepPlayer(player, { horizontal: 1, jump: true }, world);
  assert.equal(player.crouching, true);
  assert.equal(player.velocityY, 0);
  assert.equal(player.jumpBufferTime, 0);
  assert.equal(canOccupy(world, 280, 400, false, 0), false);
  assert.equal(canOccupy(world, 280, 400, true, 0), true);
  for (let i = 0; i < 65; i++) player = stepPlayer(player, { horizontal: 1, jump: false }, world);
  assert.equal(player.crouching, false);
  player = stepPlayer(player, { horizontal: 0, jump: true }, world);
  assert.equal(player.event, 'jump');
});

test('jump pressed shortly before landing is buffered into the next grounded step', () => {
  const world = floorWorld();
  let player = { x: 180, footY: 390, velocityY: 220, groundedOn: null };
  player = stepPlayer(player, { ...idle, jump: true }, world);
  let jumped = false;
  for (let i = 0; i < 6; i++) {
    player = stepPlayer(player, idle, world);
    if (player.event === 'jump') jumped = true;
  }
  assert.equal(jumped, true);
  assert.ok(player.velocityY < 0);
});

test('an expired airborne jump request does not fire on a much later landing', () => {
  const world = floorWorld();
  let player = { x: 180, footY: 240, velocityY: 0, groundedOn: null };
  player = stepPlayer(player, { ...idle, jump: true }, world);
  for (let i = 0; i < 45; i++) {
    player = stepPlayer(player, idle, world);
    assert.notEqual(player.event, 'jump');
  }
  assert.equal(player.groundedOn, 0);
});

test('leaving an edge grants a short jump window, which expires', () => {
  const world = floorWorld();
  world.platforms[0].right = 150;
  let player = spawnPlayer(world.platforms[0], world, 143);
  while (player.groundedOn !== null) player = stepPlayer(player, { horizontal: 1, jump: false }, world);
  const early = stepPlayer(player, { ...idle, jump: true }, world);
  assert.equal(early.event, 'jump');
  assert.ok(early.velocityY < 0);
  for (let i = 0; i < 8; i++) player = stepPlayer(player, idle, world);
  const late = stepPlayer(player, { ...idle, jump: true }, world);
  assert.notEqual(late.event, 'jump');
  assert.ok(late.velocityY > 0);
});

test('a normal airborne jump cannot become an unintended second jump', () => {
  const world = floorWorld();
  let player = stepPlayer(spawnPlayer(world.platforms[0], world), { ...idle, jump: true }, world);
  const before = player.velocityY;
  player = stepPlayer(player, { ...idle, jump: true }, world);
  assert.equal(player.event, undefined);
  assert.ok(player.velocityY > before);
});

test('pressing up against a real wall kicks away, even while right remains held', () => {
  const world = floorWorld();
  world.walls = [{ x: 220, top: 100, bottom: 400 }];
  let player = { x: 213.7, footY: 300, velocityY: 80, groundedOn: null };
  player = stepPlayer(player, { horizontal: 1, jump: true }, world);
  assert.equal(player.event, 'wall-jump');
  assert.equal(player.wallJumpDirection, -1);
  const x = player.x;
  player = stepPlayer(player, { horizontal: 1, jump: false }, world);
  assert.ok(player.x < x);
  assert.ok(player.velocityY < 0);
});

test('crouching cannot wall jump, and a viewport border is not a wall', () => {
  const world = floorWorld();
  world.walls = [{ x: 220, top: 100, bottom: 400 }];
  const crouched = stepPlayer({ x: 213.7, footY: 300, velocityY: 80, groundedOn: null },
    { horizontal: 1, jump: true, crouch: true }, world);
  assert.ok(crouched.velocityY > 0);
  const border = stepPlayer({ x: 793.7, footY: 300, velocityY: 80, groundedOn: null },
    { horizontal: 1, jump: true }, world);
  assert.notEqual(border.event, 'wall-jump');
});

test('0.2 contour normalization preserves a gap the crouched body can use', () => {
  const rect = (id, top, bottom) => ({ id, left: 100, right: 300, top, bottom, radius: 0, kind: 'rect' });
  const shapes = [rect(0, 100, 200), rect(1, 225, 325)];
  assert.equal(normalizeShapes(shapes, 30).length, 1);
  assert.equal(normalizeShapes(shapes, 30, bodyHeight({ characterHeight: 30 }, true)).length, 2);
});

test('wall-jump recipes reach a ledge beyond a single jump and replay against the full world', () => {
  const world = { width: 800, height: 600, characterHeight: 24,
    shapes: [{ id: 1, left: 300, right: 450, top: 310, bottom: 540, radius: 0, kind: 'rect' }],
    platforms: [{ id: 0, left: 100, right: 250, top: 500 },
      { id: 1, left: 300, right: 450, top: 310, shapeId: 1 }] };
  const graph = reachableJumps(world);
  const recipe = graph.get(0).find(recipe => recipe.landedOn === 1);
  assert.ok(recipe);
  assert.equal(recipe.kind, 'wall-jump');
  assert.ok(replay(world, 0, recipe).wallJumps >= 2);
  const level = chooseLevel(world, { graph, random: () => .4 });
  assert.ok(level);
  const metrics = assessRoute(level, graph);
  assert.ok(metrics.wallJumpCount >= 2);
  assert.equal(metrics.testedVariants, 9);
  assert.ok(metrics.toleranceRatio >= 1 / 9 && metrics.toleranceRatio <= 1);
});

test('route search supports a right-then-left ascent with no horizontal-progress filter', () => {
  const world = { width: 900, height: 650, characterHeight: 24, platforms: [
    { id: 0, left: 100, right: 250, top: 520 },
    { id: 1, left: 230, right: 380, top: 450 },
    { id: 2, left: 0, right: 130, top: 380 },
  ] };
  const graph = reachableJumps(world);
  assert.ok(graph.get(0).some(recipe => recipe.landedOn === 1));
  assert.ok(graph.get(1).some(recipe => recipe.landedOn === 2));
  const ascending = new Map([...graph].map(([id, recipes]) =>
    [id, recipes.filter(recipe => recipe.landedOn === id + 1)]));
  const level = chooseLevel(world, { graph: ascending, random: () => .7 });
  assert.ok(level);
  assert.deepEqual(level.route, [0, 1, 2]);
  level.recipes.forEach((recipe, index) => replay(world, level.route[index], recipe));
});

test('the planner uses crouch traversal for two floors connected under a low beam', () => {
  const world = { width: 800, height: 600, characterHeight: 30, platforms: [
    { id: 0, left: 100, right: 340, top: 400 },
    { id: 1, left: 340, right: 600, top: 400 },
    { id: 2, left: 220, right: 560, top: 378 },
  ] };
  const recipe = reachableJumps(world, [0]).get(0).find(recipe => recipe.landedOn === 1);
  assert.ok(recipe);
  assert.equal(recipe.kind, 'crouch');
  assert.equal(replay(world, 0, recipe).player.crouching, true);
});

test('asynchronous route and helper generation respect an already cancelled request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reachableJumpsAsync(floorWorld(), undefined, controller.signal), { name: 'AbortError' });
  await assert.rejects(createFallbackLevelAsync({ ...floorWorld(), platforms: [] }, {}, controller.signal), { name: 'AbortError' });
});
