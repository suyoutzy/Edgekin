import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeSegments, openContainers } from '../dist/contours.js';
import { movementSpeed, spawnPlayer, stepPlayer, STEP_SECONDS } from '../dist/physics.js';

const SIZE = 30;
const HALF_WIDTH = SIZE * .42 / 2;
const rectangle = (id, left = 200, right = 400, top = 100, bottom = 350) =>
  ({ id, left, right, top, bottom, radius: 0, kind: 'rect' });
const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < .00001, `${message}: ${actual} != ${expected}`);

// The rectangle's perimeter is 900 px, traversed clockwise from its top left.
// Side openings are 50 px high; horizontal openings are 60 px wide.
const openings = {
  left: { from: 740 / 900, to: 790 / 900 }, // y=260..210 on x=200
  top: { from: 60 / 900, to: 120 / 900 }, // x=260..320 on y=100
  bottom: { from: 530 / 900, to: 590 / 900 }, // x=320..260 on y=350
};

function fixture(side) {
  const shape = { ...rectangle(0), hollow: true, openings: [openings[side]] };
  const segments = shapeSegments(shape);
  const platforms = segments.filter(segment => Math.abs(segment.x2 - segment.x1) > .001)
    .map((segment, id) => ({
      id, left: Math.min(segment.x1, segment.x2), right: Math.max(segment.x1, segment.x2),
      top: Math.min(segment.y1, segment.y2), shapeId: shape.id, segmentId: segment.id,
      kind: 'page', tier: 'visual',
    }));
  return { width: 800, height: 600, characterHeight: SIZE, shapes: [shape], segments, platforms };
}

const airborne = (x, footY, velocityY = 0) => ({ x, footY, velocityY, groundedOn: null });
const idle = { horizontal: 0, jump: false };

test('a container side opening passes the body in both directions', () => {
  const world = fixture('left');
  const outside = stepPlayer(airborne(192, 250), { horizontal: 1, jump: false }, world);
  const inside = stepPlayer(airborne(208, 250), { horizontal: -1, jump: false }, world);
  const distance = movementSpeed(world) * STEP_SECONDS;
  close(outside.x, 192 + distance, 'outside to inside');
  close(inside.x, 208 - distance, 'inside to outside');
});

test('a container side remains impassable outside its opening in both directions', () => {
  const world = fixture('left');
  const outside = stepPlayer(airborne(192, 180), { horizontal: 1, jump: false }, world);
  const inside = stepPlayer(airborne(208, 180), { horizontal: -1, jump: false }, world);
  close(outside.x, 200 - HALF_WIDTH, 'outer side stops entry');
  close(inside.x, 200 + HALF_WIDTH, 'inner side stops exit');
});

test('the top opening admits falling feet and a rising head without an invisible platform', () => {
  const world = fixture('top');
  const entering = stepPlayer(airborne(290, 96, 300), idle, world);
  assert.ok(entering.footY > 100, 'falling body must cross the removed top edge');
  assert.equal(entering.groundedOn, null);
  const leaving = stepPlayer(airborne(290, 131, -300), idle, world);
  assert.ok(leaving.footY - SIZE < 100, 'rising head must cross the removed top edge');
  assert.ok(leaving.velocityY < 0);
});

test('the remaining top edge catches outside feet and blocks an inside head', () => {
  const world = fixture('top');
  const landing = stepPlayer(airborne(230, 96, 300), idle, world);
  close(landing.footY, 100, 'top landing height');
  assert.notEqual(landing.groundedOn, null);
  const head = stepPlayer(airborne(230, 131, -300), idle, world);
  close(head.footY, 130, 'inside head hits top');
  assert.equal(head.velocityY, 0);
});

test('the bottom opening permits inside falling and outside rising in both directions', () => {
  const world = fixture('bottom');
  const leaving = stepPlayer(airborne(290, 346, 300), idle, world);
  assert.ok(leaving.footY > 350, 'falling body must cross the removed bottom edge');
  assert.equal(leaving.groundedOn, null);
  const entering = stepPlayer(airborne(290, 381, -300), idle, world);
  assert.ok(entering.footY - SIZE < 350, 'rising head must cross the removed bottom edge');
  assert.ok(entering.velocityY < 0);
});

test('the uncut bottom is a floor inside and a ceiling outside', () => {
  const world = fixture('bottom');
  const floor = stepPlayer(airborne(230, 346, 300), idle, world);
  close(floor.footY, 350, 'interior floor landing');
  assert.notEqual(floor.groundedOn, null);
  const ceiling = stepPlayer(airborne(230, 381, -300), idle, world);
  close(ceiling.footY, 380, 'exterior head hits bottom');
  assert.equal(ceiling.velocityY, 0);
});

test('standing on a container floor does not disable its closed side wall', () => {
  const world = fixture('left');
  const floor = world.platforms.find(platform => platform.top === 350);
  assert.ok(floor);
  const player = spawnPlayer(floor, world, 392);
  const blocked = stepPlayer(player, { horizontal: 1, jump: false }, world);
  close(blocked.x, 400 - HALF_WIDTH, 'grounded player still hits container wall');
  assert.equal(blocked.groundedOn, floor.id);
});

test('contour segments remove exactly the opening and preserve the other edges', () => {
  const world = fixture('left');
  const length = world.segments.reduce((sum, edge) => sum + Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1), 0);
  close(length, 850, 'remaining rectangle perimeter');
  assert.equal(world.segments.filter(edge => edge.x1 === 200 && edge.x2 === 200).length, 2);
  assert.ok(!world.segments.some(edge => edge.x1 === 200 && edge.x2 === 200 &&
    Math.min(edge.y1, edge.y2) < 235 && Math.max(edge.y1, edge.y2) > 235), 'opening has no remaining segment');
  assert.ok(world.segments.some(edge => edge.x1 === 400 && edge.x2 === 400), 'opposite wall stays closed');
});

for (const randomValue of [0, .75]) {
  test(`nested ancestors each receive one or two openings, with random=${randomValue}`, () => {
    const shapes = [rectangle(0, 100, 700, 80, 560), rectangle(1, 180, 600, 160, 480),
      rectangle(2, 250, 350, 250, 310)];
    const opened = openContainers(shapes, SIZE, 800, 600, () => randomValue);
    for (const parent of opened.slice(0, 2)) {
      assert.equal(parent.hollow, true);
      assert.ok(parent.openings.length >= 1 && parent.openings.length <= 2);
      const perimeter = 2 * (parent.right - parent.left + parent.bottom - parent.top);
      for (const opening of parent.openings) {
        assert.ok(opening.from >= 0 && opening.to <= 1 && opening.to > opening.from);
        assert.ok((opening.to - opening.from) * perimeter >= SIZE * 1.25 - .00001,
          'opening must be wider than the body');
      }
      assert.ok(shapeSegments(parent).length > 0, 'opening must not erase the container');
    }
    assert.equal(opened[2].hollow, undefined, 'a leaf remains solid');
    assert.equal(opened[2].openings, undefined, 'a leaf has no generated opening');
    assert.equal(shapes[0].hollow, undefined, 'input geometry remains unchanged');
  });
}
