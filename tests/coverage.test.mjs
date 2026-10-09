import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContours } from '../dist/contour-selection.js';
import { shapeSegments } from '../dist/contours.js';

function finalContours() {
  return [
    { id: 7, left: 100, right: 400, top: 100, bottom: 300, radius: 12,
      kind: 'rect', hollow: true, openings: [{ from: .1, to: .15 }, { from: .7, to: .76 }] },
    { id: 23, left: 150, right: 180, top: 150, bottom: 180, radius: 15,
      kind: 'ellipse', detail: 'icon' },
    { id: 41, left: 500, right: 650, top: 400, bottom: 450, radius: 6, kind: 'rect' },
  ];
}

test('coverage uses the final eligible contour count as its denominator', () => {
  const selected = selectContours(finalContours(), 2);
  assert.equal(selected.shapes.length, 2);
  assert.equal(selected.stats.eligibleCount, 3);
  assert.equal(selected.stats.renderedCount, 2);
  assert.equal(selected.stats.omittedCount, 1);
  assert.ok(Math.abs(selected.stats.complexityPercent - 200 / 3) < 1e-8,
    'two of three eligible contours must report approximately 66.666 percent');
});

test('every retained final contour produces 100 percent coverage below the runtime budget', () => {
  for (const budget of [3, 240]) {
    const selected = selectContours(finalContours(), budget);
    assert.equal(selected.shapes.length, 3);
    assert.deepEqual(selected.stats, {
      eligibleCount: 3, renderedCount: 3, omittedCount: 0, complexityPercent: 100,
    });
  }
});

test('an empty eligible contour set has no defined coverage percentage', () => {
  const selected = selectContours([], 240);
  assert.deepEqual(selected.shapes, []);
  assert.deepEqual(selected.stats, {
    eligibleCount: 0, renderedCount: 0, omittedCount: 0, complexityPercent: null,
  });
});

test('zero runtime budget omits every eligible contour and reports zero percent', () => {
  const selected = selectContours(finalContours(), 0);
  assert.deepEqual(selected.shapes, []);
  assert.deepEqual(selected.stats, {
    eligibleCount: 3, renderedCount: 0, omittedCount: 3, complexityPercent: 0,
  });
});

test('selection preserves input geometry, openings, order, and stable contour IDs', () => {
  const candidates = finalContours();
  const snapshot = structuredClone(candidates);
  const selected = selectContours(candidates, 2);
  assert.deepEqual(candidates, snapshot, 'selection must not mutate the final eligible collection');
  assert.deepEqual(selected.shapes.map(shape => shape.id), [7, 23]);
  for (const shape of selected.shapes) {
    assert.deepEqual(shape, snapshot.find(original => original.id === shape.id));
  }
});

test('curves and multiple opening fragments still count as one contour each', () => {
  const candidates = finalContours();
  assert.ok(shapeSegments(candidates[0]).length > 4, 'the open rounded rectangle contains many fragments');
  assert.ok(shapeSegments(candidates[1]).length > 4, 'the ellipse contains many curve segments');
  const selected = selectContours(candidates, 2);
  assert.equal(selected.stats.eligibleCount, 3, 'fragments must not inflate the eligible denominator');
  assert.equal(selected.stats.renderedCount, 2, 'fragments must not inflate the rendered numerator');
  assert.ok(Math.abs(selected.stats.complexityPercent - 200 / 3) < 1e-8);
});
