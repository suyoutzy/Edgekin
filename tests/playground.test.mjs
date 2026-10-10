import test from 'node:test';
import assert from 'node:assert/strict';
import { addGapPlatforms, addGapPlatformsAsync } from '../dist/playground.js';
import { normalizeShapes } from '../dist/geometry.js';
import { openContainers, shapeSegments } from '../dist/contours.js';
import { canOccupy, spawnPlayer, stepPlayer, STEP_SECONDS, COYOTE_SECONDS } from '../dist/physics.js';
import { reachableJumps, chooseLevel } from '../dist/planner.js';

const rect = (id, left, top, right, bottom, extra = {}) =>
  ({ id, left, top, right, bottom, radius: 8, kind: 'rect', ...extra });
const floor = () => ({ width: 1400, height: 900, characterHeight: 30,
  platforms: [{ id: 0, left: 200, right: 1000, top: 700, kind: 'page' }] });

test('a sparse page gains a bounded connected set of actual jump surfaces', () => {
  const original = floor(), result = addGapPlatforms(original);
  assert.equal(original.platforms.length, 1, 'the page snapshot is retained');
  const added = result.platforms.filter(item => item.generated === 'gap');
  assert.ok(added.length >= 2 && added.length <= 5);
  assert.ok(added.filter(item => item.blink).length <= 1);
  const graph = reachableJumps(result);
  const connected = new Set([0]);
  for (let pass = 0; pass < added.length; pass++) for (const id of [...connected]) {
    for (const recipe of graph.get(id) ?? []) connected.add(recipe.landedOn);
  }
  assert.ok(added.every(item => connected.has(item.id)), 'new ledges have a real incoming route');
  assert.ok(added.every(item => (graph.get(item.id)?.length ?? 0) > 0), 'new ledges permit a return route');
  assert.ok(chooseLevel(result, { graph, relaxed: true }));
  for (const item of added) assert.equal(canOccupy(result, (item.left + item.right) / 2, item.top, false, item.id), true);
});

test('empty pages and tiny viewports do not receive a synthetic preset level', () => {
  const empty = { ...floor(), platforms: [] };
  assert.equal(addGapPlatforms(empty), empty);
  const tiny = { ...floor(), width: 500, height: 400 };
  assert.equal(addGapPlatforms(tiny), tiny);
});

test('dense occupied space is left free of supplemental platforms', () => {
  const dense = { ...floor(), shapes: [rect(0, 0, 0, 1400, 900)] };
  assert.equal(addGapPlatforms(dense), dense);
});

test('large empty rectangles can be opened for playable interiors, controls cannot', () => {
  const box = rect(0, 300, 250, 1100, 620);
  const opened = openContainers([box], 30, 1400, 900, () => .3, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].hollow, true);
  assert.ok(opened[0].openings.length >= 1);
  const segments = shapeSegments(opened[0]);
  const world = { ...floor(), shapes: opened, segments,
    platforms: segments.filter(edge => Math.abs(edge.x2 - edge.x1) > .1).map((edge, id) =>
      ({ id, left: Math.min(edge.x1, edge.x2), right: Math.max(edge.x1, edge.x2),
        top: Math.min(edge.y1, edge.y2), shapeId: 0, segmentId: edge.id, kind: 'page' })) };
  const result = addGapPlatforms(world);
  assert.ok(result.platforms.some(item => item.generated === 'gap' && item.left > box.left &&
    item.right < box.right && item.top > box.top && item.top < box.bottom));
  assert.ok(result.platforms.some(item => item.generated === 'gap' && item.right < box.left),
    'the vacant outside space is connected through a low entrance');
  assert.equal(openContainers([{ ...box, control: true }], 30, 1400, 900, () => .3, true)[0].hollow, undefined);
  const photo = openContainers([{ ...box, media: true }], 30, 1400, 900, () => .3, true);
  assert.equal(canOccupy({ ...world, shapes: photo, segments: [], platforms: [] }, 700, 500), false,
    'a large photo is occupied content rather than an empty room');
});

test('supplemental platform generation respects cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(addGapPlatformsAsync(floor(), controller.signal), { name: 'AbortError' });
});

test('near-coincident large frames become one outline without erasing useful rooms', () => {
  const outer = rect(0, 300, 650, 1100, 720);
  const inner = rect(1, 307, 656, 1094, 713, { control: true });
  const normalized = normalizeShapes([outer, inner], 30, 17.4);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].control, true);
  assert.equal(normalizeShapes([rect(0, 300, 100, 1100, 700), rect(1, 360, 160, 1040, 640)], 30, 17.4).length, 2);
});

test('a mostly enclosed image crossing a card edge no longer makes crossing frames', () => {
  const card = rect(0, 300, 400, 1100, 780);
  const image = rect(1, 840, 360, 1000, 560);
  const result = normalizeShapes([card, image], 30, 17.4);
  assert.equal(result.length, 1);
  assert.equal(result[0].left, card.left);
  const independent = [rect(0, 100, 100, 400, 200), rect(1, 350, 100, 650, 200)];
  assert.equal(normalizeShapes(independent, 30, 17.4).length, 2);
});

test('edge jump forgiveness lasts one following frame rather than the old six frames', () => {
  assert.equal(COYOTE_SECONDS, .02);
  const world = { ...floor(), platforms: [{ id: 0, left: 100, right: 200, top: 700 }] };
  let player = spawnPlayer(world.platforms[0], world, 190);
  while (player.groundedOn !== null) player = stepPlayer(player, { horizontal: 1, jump: false }, world);
  assert.equal(stepPlayer(player, { horizontal: 0, jump: true }, world).event, 'jump');
  const delayed = stepPlayer(player, { horizontal: 0, jump: false }, world);
  assert.notEqual(stepPlayer(delayed, { horizontal: 0, jump: true }, world).event, 'jump');
  assert.ok(STEP_SECONDS < COYOTE_SECONDS);
});
