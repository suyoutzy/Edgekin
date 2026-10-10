import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateBody, migrateTarget, removeSources, retainHelpers, reuseGraph, safeBody } from '../dist/map-update.js';
import { clonePlatformWorld, platformIsActive } from '../dist/platform-state.js';
import { spawnPlayer, stepPlayer, STEP_SECONDS } from '../dist/physics.js';

const idle = { horizontal: 0, jump: false };
const world = () => ({ width: 1400, height: 900, characterHeight: 30, shapes: [], segments: [],
  platforms: [{ id: 1, left: 100, right: 600, top: 700, key: 'floor' },
    { id: 2, left: 800, right: 1300, top: 650, key: 'other' }] });

test('moving/resizing support migrates the body and coin while preserving the relative edge position', () => {
  const before = world(), after = { ...before, platforms: [{ ...before.platforms[0], id: 31, left: 200, right: 1200, top: 680 }] };
  const body = spawnPlayer(before.platforms[0], before, 300);
  const migrated = migrateBody(body, before, after);
  assert.equal(migrated.x, 600); assert.equal(migrated.footY, 680); assert.equal(migrated.groundedOn, 31);
  const target = migrateTarget({ platformId: 1, x: 400, footY: 700 }, before, after);
  assert.equal(target.x, 800); assert.equal(target.platformId, 31);
  assert.equal(body.x, 300, 'migration does not mutate the old body');
});

test('airborne motion is retained, a deleted support gets a safe permanent fallback', () => {
  const before = world(), after = { ...before, platforms: [before.platforms[1]] };
  const body = { ...spawnPlayer(before.platforms[0], before, 300), groundedOn: null, footY: 550, velocityY: -200 };
  assert.deepEqual(migrateBody(body, before, after), body);
  assert.equal(migrateBody({ ...body, groundedOn: 1, footY: 700 }, before, after), null);
  assert.equal(safeBody(after, body).groundedOn, 2);
  assert.equal(safeBody({ ...after, platforms: [] }, body), null);
});

test('unchanged route witnesses are reused but an obstacle on the actual swept path invalidates the source', () => {
  const before = world(), recipe = { takeoffX: 500, landedOn: 2, landingX: 850,
    bounds: { left: 480, right: 870, top: 570, bottom: 700 } };
  const graph = new Map([[1, [recipe]], [2, []]]);
  const far = { id: 9, key: 'new', left: 1000, right: 1100, top: 100, bottom: 200, kind: 'rect', radius: 0 };
  assert.equal(reuseGraph(before, { ...before, shapes: [far] }, graph).get(1)[0].landedOn, 2);
  const blocking = { ...far, left: 700, right: 750, top: 400, bottom: 700 };
  assert.equal(reuseGraph(before, { ...before, shapes: [blocking] }, graph).has(1), false);
  assert.equal(reuseGraph(before, { ...before, characterHeight: 36 }, graph).size, 0);
});

test('removed composite sources promptly remove their contours and dependent helper platforms', () => {
  const before = world(); before.shapes = [{ id: 4, sourceIds: [10, 11], key: 'merged', left: 0, right: 600, top: 500, bottom: 700, kind: 'rect', radius: 0 }];
  before.platforms[0].shapeId = 4;
  before.platforms.push({ id: -2, left: 620, right: 720, top: 640, key: 'gap', generated: 'gap', anchorKeys: ['floor'] });
  const pruned = removeSources(before, [11]);
  assert.equal(pruned.shapes.length, 0);
  assert.deepEqual(pruned.platforms.map(platform => platform.id), [2]);
});

test('removing a text source prunes its fallback floor and dependent helpers', () => {
  const map = { width: 1000, height: 800, characterHeight: 24, platforms: [
    { id: 1, sourceId: 9, key: 'text:9', tier: 'text', left: 10, right: 300, top: 400 },
    { id: -1, key: 'gap', generated: 'gap', anchorKeys: ['text:9'], left: 300, right: 400, top: 450 }] };
  assert.deepEqual(removeSources(map, [9]).platforms, []);
});

test('contact platform timing survives background mapping and route simulations own a copy', () => {
  const before = world();
  before.platforms.push({ id: -1, left: 650, right: 760, top: 640, key: 'gap', generated: 'gap',
    anchorKeys: ['floor'], crumble: { warningSeconds: .3, hiddenSeconds: 3 } });
  before.platformStates = new Map([[-1, { phase: 'warning', triggeredAt: 4 }]]);
  const copied = clonePlatformWorld(before);
  copied.platformStates.get(-1).phase = 'hidden';
  assert.equal(before.platformStates.get(-1).phase, 'warning');
  const migrated = retainHelpers(before, world());
  assert.deepEqual(migrated.platformStates.get(-1), before.platformStates.get(-1));
  assert.notEqual(migrated.platformStates.get(-1), before.platformStates.get(-1));
});

test('a platform stays until collision, disappears after warning, and returns safely after three seconds', () => {
  const map = world(); map.platforms.push({ id: 3, left: 620, right: 770, top: 550,
    crumble: { warningSeconds: .3, hiddenSeconds: 3 } });
  const ledge = map.platforms[2];
  let body = { x: 700, footY: 540, groundedOn: null, velocityY: 120 };
  body = stepPlayer(body, idle, map, .1, 10);
  assert.equal(body.groundedOn, 3); assert.equal(map.platformStates.get(3).triggeredAt, 10);
  body = stepPlayer(body, idle, map, STEP_SECONDS, 10.2);
  assert.equal(map.platformStates.get(3).triggeredAt, 10, 'standing does not postpone disappearance');
  body = stepPlayer(body, idle, map, STEP_SECONDS, 10.3);
  assert.equal(body.groundedOn, null); assert.equal(body.coyoteTime, 0);
  assert.equal(platformIsActive(ledge, 13, map.platformStates), false);
  const occupying = { x: 700, footY: 560, groundedOn: null, velocityY: 0 };
  stepPlayer(occupying, idle, map, STEP_SECONDS, 13.31);
  assert.equal(platformIsActive(ledge, 13.31, map.platformStates), false, 'restoration cannot intersect a body');
  stepPlayer({ ...occupying, x: 900 }, idle, map, STEP_SECONDS, 13.4);
  assert.equal(platformIsActive(ledge, 13.4, map.platformStates), true);
  assert.equal(map.platformStates.get(3).phase, 'ready');
});

test('side and underside contact trigger the platform, passing nearby does not', () => {
  for (const mode of ['side', 'ceiling', 'near']) {
    const map = world(); map.platforms.push({ id: 3, left: 620, right: 770, top: 550,
      crumble: { warningSeconds: .3, hiddenSeconds: 3 } });
    const body = mode === 'side' ? { x: 610, footY: 560, velocityY: 0, groundedOn: null } :
      { x: mode === 'ceiling' ? 700 : 900, footY: 590, velocityY: -600, groundedOn: null };
    stepPlayer(body, { ...idle, horizontal: mode === 'side' ? 1 : 0 }, map, .05, 0);
    assert.equal(map.platformStates?.get(3)?.phase, mode === 'near' ? undefined : 'warning');
  }
});
