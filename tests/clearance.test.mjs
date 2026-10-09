import test from 'node:test';
import assert from 'node:assert/strict';
import { openContainers, openingCount, shapeSegments } from '../dist/contours.js';
import { stepPlayer } from '../dist/physics.js';

const size = 24;
const bodyWidth = size * .42;
const rect = (id, left, top, right, bottom) =>
  ({ id, left, top, right, bottom, radius: 0, kind: 'rect' });
const ellipse = (id, left, top, right, bottom) =>
  ({ id, left, top, right, bottom, radius: 0, kind: 'ellipse' });

// Measure the missing contour between consecutive remaining edges, rather than
// assuming an arc-length percentage represents physical passage clearance.
function contourGaps(shape) {
  const edges = shapeSegments(shape);
  const gaps = [];
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i], b = edges[(i + 1) % edges.length];
    if (Math.hypot(a.x2 - b.x1, a.y2 - b.y1) < .01) continue;
    gaps.push({ x: (a.x2 + b.x1) / 2, y: (a.y2 + b.y1) / 2,
      width: Math.abs(a.x2 - b.x1), height: Math.abs(a.y2 - b.y1),
      deltaY: b.y1 - a.y2 });
  }
  return gaps;
}

function open(shapes) {
  return openContainers(shapes, size, 1000, 800, () => 0);
}

test('a child strip immediately under the top forces a different entrance', () => {
  const shapes = open([rect(0, 100, 100, 700, 500), rect(1, 106, 106, 694, 140)]);
  const outer = shapes.find(shape => shape.id === 0);
  assert.ok(outer?.hollow, 'a safe entrance should exist below the strip');
  assert.ok(contourGaps(outer).every(gap => gap.y > outer.top + size),
    'the strip must not leave an unusable top entrance');
});

for (const [width, height] of [[70, 70], [400, 70], [400, 34]]) {
  test(`a ${width}x${height} curved container has a body-sized projected entrance`, () => {
    const outer = ellipse(0, 100, 100, 100 + width, 100 + height);
    // Keep the icon off the mouth of the bottom opening on very flat ellipses.
    const childX = height === 34 ? 150 : 100 + width / 2 - 5;
    const child = rect(1, childX, 100 + height / 2 - 5,
      childX + 10, 100 + height / 2 + 5);
    const shapes = open([outer, child]);
    const opened = shapes.find(shape => shape.id === outer.id);
    assert.ok(opened?.hollow, 'at least one safe side or bottom entrance is available');
    const gaps = contourGaps(opened);
    assert.equal(gaps.length, 1);
    for (const gap of gaps) {
      if (gap.width < .01) assert.ok(gap.height >= size + 4,
        `side gap is ${gap.height}px, smaller than standing body clearance`);
      else if (gap.height < .01) assert.ok(gap.width >= bodyWidth + 4,
        `bottom gap is ${gap.width}px, smaller than standing body width`);
      else assert.fail('axis-centred curved openings should have axis-aligned endpoints');
    }

    // Replay a body crossing the actual collision segments. A temporary level
    // floor keeps side-entry height constant; bottom entry uses upward motion.
    const gap = gaps[0];
    const segments = shapeSegments(opened).map((edge, id) => ({ ...edge, id }));
    const world = { width: 1000, height: 800, characterHeight: size, shapes,
      segments, platforms: [] };
    let player;
    let entered = false;
    if (gap.width < .01) {
      // A flat ellipse may need an entire half-arc removed, putting the mouth
      // at its centre. Clockwise endpoints retain the actual entry direction.
      const rightEntry = gap.deltaY > 0;
      const direction = rightEntry ? -1 : 1;
      const floor = { id: 900, left: 0, right: 1000, top: gap.y + size / 2 };
      world.platforms.push(floor);
      player = { x: rightEntry ? outer.right + bodyWidth + 8 : outer.left - bodyWidth - 8,
        footY: floor.top, velocityY: 0, groundedOn: floor.id };
      for (let frame = 0; frame < 90; frame++) {
        player = stepPlayer(player, { horizontal: direction, jump: false }, world);
        if (rightEntry ? player.x + bodyWidth / 2 < gap.x - .01 :
          player.x - bodyWidth / 2 > gap.x + .01) entered = true;
      }
    } else {
      player = { x: gap.x, footY: outer.bottom + size + 4,
        velocityY: -300, groundedOn: null };
      for (let frame = 0; frame < 35; frame++) {
        player = stepPlayer(player, { horizontal: 0, jump: false }, world);
        if (player.footY < gap.y - .01) entered = true;
      }
    }
    assert.ok(entered, 'the whole body should pass the remaining contour edges');
  });
}

test('an outside obstruction near the top also forces a different entrance', () => {
  const outer = rect(0, 100, 100, 300, 300);
  const child = rect(1, 180, 180, 200, 200);
  const plain = open([outer, child]).find(shape => shape.id === 0);
  assert.ok(contourGaps(plain).some(gap => Math.abs(gap.y - outer.top) < .01));
  const blocker = rect(2, 90, 70, 310, 99);
  const opened = open([outer, child, blocker]).find(shape => shape.id === 0);
  assert.ok(opened?.hollow);
  assert.ok(contourGaps(opened).every(gap => Math.abs(gap.y - outer.top) > .01),
    'clearance must include nearby obstacles outside the container');
});

test('a curve with only its top free keeps one entrance across the perimeter origin', () => {
  const outer = ellipse(0, 100, 100, 170, 170);
  const child = rect(1, 130, 130, 140, 140);
  const shapes = open([outer, child,
    rect(2, 171, 110, 185, 160), rect(3, 110, 171, 160, 185),
    rect(4, 85, 110, 99, 160)]);
  const opened = shapes.find(shape => shape.id === 0);
  assert.ok(opened?.hollow, 'the free top must keep the enclosing contour');
  assert.equal(openingCount(opened), 1);
  assert.equal(opened.openings.length, 2, 'a top gap spans both ends of perimeter coordinates');
  const gaps = contourGaps(opened);
  assert.equal(gaps.length, 1, 'the two stored intervals should draw a single mouth');
  const gap = gaps[0];
  assert.ok(gap.y < (outer.top + outer.bottom) / 2);
  assert.ok(gap.width >= bodyWidth + 4);

  const segments = shapeSegments(opened).map((edge, id) => ({ ...edge, id }));
  const world = { width: 1000, height: 800, characterHeight: size, shapes, segments,
    platforms: [{ id: 900, left: child.left, right: child.right, top: child.top, shapeId: child.id }] };
  let player = { x: gap.x, footY: outer.top - 4, velocityY: 0, groundedOn: null };
  let entered = false;
  for (let frame = 0; frame < 40; frame++) {
    player = stepPlayer(player, { horizontal: 0, jump: false }, world);
    if (player.footY - size > gap.y + .01 && player.footY < outer.bottom) entered = true;
  }
  assert.ok(entered, 'the complete standing body must fall through the top mouth');
  assert.equal(player.groundedOn, 900, 'the internal icon is a real landing surface');
});

test('a container with no body-sized entrance is removed while its child is kept', () => {
  const shapes = open([rect(0, 100, 100, 300, 300), rect(1, 106, 106, 294, 294)]);
  assert.ok(!shapes.some(shape => shape.id === 0));
  assert.ok(shapes.some(shape => shape.id === 1));
});

test('outside obstacles sealing every edge remove the shell and retain its contents', () => {
  const shapes = open([rect(0, 100, 100, 300, 300), rect(1, 160, 160, 180, 180),
    rect(2, 90, 70, 310, 99), rect(3, 90, 301, 310, 330),
    rect(4, 70, 90, 99, 310), rect(5, 301, 90, 330, 310)]);
  assert.ok(!shapes.some(shape => shape.id === 0));
  assert.ok(shapes.some(shape => shape.id === 1));
});
