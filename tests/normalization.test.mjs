import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShapes } from '../dist/geometry.js';

const size = 24;
const rect = (id, left, top, right, bottom, extra = {}) =>
  ({ id, left, top, right, bottom, radius: 6, kind: 'rect', ...extra });
const icon = (id, left, top, right, bottom, extra = {}) =>
  rect(id, left, top, right, bottom, { detail: 'icon', ...extra });
const bounds = shapes => shapes.map(({ left, top, right, bottom, kind, control }) =>
  ({ left, top, right, bottom, kind, control: Boolean(control) }));

test('Sponsor-sized control keeps its outer box and removes its heart and inner SVG bounds', () => {
  const input = [rect(0, 1090, 198, 1218, 232, { control: true }),
    icon(1, 1102, 207, 1118, 223), icon(2, 1105, 210, 1115, 220, { kind: 'ellipse' })];
  const normalized = normalizeShapes(input, size);
  assert.deepEqual(bounds(normalized), bounds([input[0]]));
  assert.equal(input.length, 3, 'normalization must not alter the source collection');
});

test('Star and its dropdown sharing a one-pixel border form one control with no interior seam', () => {
  const input = [rect(0, 690, 200, 794, 234, { control: true }),
    rect(1, 793, 200, 825, 234, { control: true, detail: 'icon' }),
    icon(2, 702, 209, 718, 225), icon(3, 805, 213, 813, 221)];
  const normalized = normalizeShapes(input, size);
  assert.deepEqual(bounds(normalized), bounds([rect(0, 690, 200, 825, 234, { control: true })]));
  assert.equal(normalized[0].detail, undefined, 'the joined control is not a standalone icon');
});

test('duplicate wrapper bounds retain control semantics from the enclosed input', () => {
  const wrapper = rect(0, 100, 100, 502, 302);
  const input = rect(1, 101, 101, 501, 301, { control: true });
  const decoration = icon(2, 180, 180, 200, 200);
  const normalized = normalizeShapes([wrapper, input, decoration], size);
  assert.deepEqual(bounds(normalized), bounds([{ ...wrapper, control: true }]));
});

test('a reaction pill without control metadata drops a nested emoji but keeps the pill', () => {
  const input = [rect(0, 500, 720, 570, 752), icon(1, 512, 728, 528, 744)];
  assert.deepEqual(bounds(normalizeShapes(input, size)), bounds([input[0]]));
});

test('a compact SVG outer circle keeps one outline instead of a useless inner ring', () => {
  const outer = icon(0, 100, 100, 124, 124, { kind: 'ellipse' });
  const inner = icon(1, 105, 105, 119, 119, { kind: 'ellipse' });
  assert.deepEqual(bounds(normalizeShapes([inner, outer], size)), bounds([outer]));
});

test('body-sized space in a large card preserves interior objects and isolated icons', () => {
  const card = rect(0, 500, 400, 1500, 900);
  const internal = icon(1, 520, 420, 550, 450);
  const isolated = icon(2, 100, 100, 116, 116);
  const other = icon(3, 120, 100, 136, 116);
  const normalized = normalizeShapes([card, internal, isolated, other], size);
  assert.equal(normalized.length, 4);
  assert.equal(normalized.filter(shape => shape.detail === 'icon').length, 3);
  assert.ok(normalized.some(shape => shape.left === internal.left && shape.top === internal.top));
});

test('contact merging is transitive and independent of input enumeration order', () => {
  const a = rect(0, 100, 100, 200, 134, { control: true });
  const b = rect(1, 198, 100, 250, 134, { control: true });
  const c = rect(2, 249, 100, 280, 134, { control: true });
  const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
  const expected = bounds([rect(0, 100, 100, 280, 134, { control: true })]);
  for (const order of orders) assert.deepEqual(bounds(normalizeShapes(order, size)), expected);
});

test('two pixels of shared border merge, while a large overlap remains separate geometry', () => {
  const contact = [rect(0, 100, 100, 200, 140), rect(1, 198, 100, 250, 140)];
  assert.equal(normalizeShapes(contact, size).length, 1);
  const overlapping = [rect(0, 100, 100, 400, 200), rect(1, 350, 100, 650, 200)];
  assert.equal(normalizeShapes(overlapping, size).length, 2);
});

test('existing narrow-gap merging and misaligned-gap suppression are preserved', () => {
  const aligned = [rect(0, 0, 100, 100, 200), rect(1, 108, 100, 200, 200)];
  assert.deepEqual(bounds(normalizeShapes(aligned, size)), bounds([rect(0, 0, 100, 200, 200)]));
  const misaligned = [rect(0, 0, 100, 100, 200), rect(1, 108, 108, 200, 190)];
  assert.deepEqual(bounds(normalizeShapes(misaligned, size)), bounds([misaligned[0]]));
});
