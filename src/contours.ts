import type { BoundarySegment, Shape, World } from './types.js';
import { playerWidth } from './dimensions.js';

export function containsShape(outer: Shape, inner: Shape): boolean {
  return outer.id !== inner.id && outer.left <= inner.left + .5 && outer.right >= inner.right - .5 &&
    outer.top <= inner.top + .5 && outer.bottom >= inner.bottom - .5 &&
    (outer.right - outer.left) * (outer.bottom - outer.top) >
      (inner.right - inner.left) * (inner.bottom - inner.top) * 1.05;
}

function vertices(shape: Shape): [number, number][] {
  const { left, right, top, bottom } = shape;
  if (shape.kind === 'ellipse') {
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    return Array.from({ length: 48 }, (_, i) => {
      const angle = -Math.PI / 2 + i * Math.PI / 24;
      return [cx + (right - left) / 2 * Math.cos(angle), cy + (bottom - top) / 2 * Math.sin(angle)];
    });
  }
  const r = shape.radius;
  if (!r) return [[left, top], [right, top], [right, bottom], [left, bottom]];
  const corners = [[right - r, top + r, -Math.PI / 2], [right - r, bottom - r, 0],
    [left + r, bottom - r, Math.PI / 2], [left + r, top + r, Math.PI]];
  return corners.flatMap(([cx, cy, angle]) => Array.from({ length: 7 }, (_, i) =>
    [cx! + r * Math.cos(angle! + i * Math.PI / 12),
      cy! + r * Math.sin(angle! + i * Math.PI / 12)] as [number, number]));
}

export function shapeSegments(shape: Shape): BoundarySegment[] {
  const points = vertices(shape);
  const edges = points.map((point, i) => {
    const next = points[(i + 1) % points.length]!;
    return { point, next, length: Math.hypot(next[0] - point[0], next[1] - point[1]) };
  });
  const perimeter = edges.reduce((n, edge) => n + edge.length, 0);
  let offset = 0;
  const result: BoundarySegment[] = [];
  for (const edge of edges) {
    const start = offset / perimeter, end = (offset + edge.length) / perimeter;
    offset += edge.length;
    let intervals: [number, number][] = [[start, end]];
    for (const opening of shape.openings ?? []) {
      intervals = intervals.flatMap(([a, b]) => {
        if (opening.to <= a || opening.from >= b) return [[a, b]];
        const kept: [number, number][] = [];
        if (opening.from > a) kept.push([a, Math.min(b, opening.from)]);
        if (opening.to < b) kept.push([Math.max(a, opening.to), b]);
        return kept;
      });
    }
    for (const [a, b] of intervals) {
      if (b - a < .000001) continue;
      const t1 = (a - start) / (end - start), t2 = (b - start) / (end - start);
      result.push({ id: result.length, shapeId: shape.id,
        x1: edge.point[0] + (edge.next[0] - edge.point[0]) * t1,
        y1: edge.point[1] + (edge.next[1] - edge.point[1]) * t1,
        x2: edge.point[0] + (edge.next[0] - edge.point[0]) * t2,
        y2: edge.point[1] + (edge.next[1] - edge.point[1]) * t2 });
    }
  }
  return result;
}

export function openingCount(shape: Shape): number {
  const openings = shape.openings ?? [];
  // A single gap crossing the perimeter origin is stored as two intervals.
  return openings.length - (openings.some(gap => gap.from === 0) &&
    openings.some(gap => gap.to === 1) ? 1 : 0);
}

interface Box { left: number; right: number; top: number; bottom: number }
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Parameter interval of a segment inside an axis-aligned clearance box. */
function clipSegment(edge: BoundarySegment, box: Box): [number, number] | null {
  let from = 0, to = 1;
  for (const [a, delta, low, high] of [[edge.x1, edge.x2 - edge.x1, box.left, box.right],
    [edge.y1, edge.y2 - edge.y1, box.top, box.bottom]]) {
    if (Math.abs(delta!) < .000001) { if (a! < low! || a! > high!) return null; continue; }
    const t1 = (low! - a!) / delta!, t2 = (high! - a!) / delta!;
    from = Math.max(from, Math.min(t1, t2)); to = Math.min(to, Math.max(t1, t2));
    if (from > to) return null;
  }
  return [from, to];
}

/** Open nested containers, checking the full standing body on both sides of a gap. */
export function openContainers(shapes: Shape[], size: number, width: number, height: number,
  random: () => number = Math.random, openEmpty = false): Shape[] {
  const eligible = new Set(shapes.filter(shape => (shapes.some(inner => containsShape(shape, inner)) ||
    (openEmpty && !shape.control && !shape.media && shape.kind === 'rect' &&
      shape.right - shape.left >= size * 12 && shape.bottom - shape.top >= size * 6)) &&
    Math.min(shape.right - shape.left, shape.bottom - shape.top) >= size * 1.4).map(shape => shape.id));
  const resolved = new Map<number, Shape>();
  const removed = new Set<number>();
  // Resolve inner shells first so an outer entrance can take their real gaps into account.
  const ordered = [...shapes].sort((a, b) =>
    (a.right - a.left) * (a.bottom - a.top) - (b.right - b.left) * (b.bottom - b.top));
  for (const shape of ordered) {
    if (!eligible.has(shape.id)) { resolved.set(shape.id, shape); continue; }
    const base = { ...shape, hollow: true, openings: [] as { from: number; to: number }[] };
    const segments = shapeSegments(base);
    const perimeter = segments.reduce((n, edge) => n + Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1), 0);
    const bodyWidth = playerWidth({ characterHeight: size });
    const clear = (box: Box): boolean => box.left >= 0 && box.right <= width &&
      box.top >= 0 && box.bottom <= height && !shapes.some(other => {
        if (other.id === shape.id || removed.has(other.id) || !overlaps(other, box)) return false;
        const actual = resolved.get(other.id) ?? other;
        if (eligible.has(other.id)) return shapeSegments({ ...actual, hollow: true })
          .some(edge => clipSegment(edge, box) !== null);
        return true;
      });
    let offset = 0;
    const emptyRoom = openEmpty && !shapes.some(inner => containsShape(shape, inner));
    const possible: { from: number; to: number; edge: number; side: number; y: number }[] = [];
    for (const edge of segments) {
      const length = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1);
      const start = offset; offset += length;
      const vertical = Math.abs(edge.x2 - edge.x1) < .001;
      const horizontal = Math.abs(edge.y2 - edge.y1) < .001;
      if (!vertical && !horizontal) continue;
      const gap = size * (vertical ? (emptyRoom ? 2.5 : 1.65) : 1.25);
      if (length < gap + 12) continue;
      for (let attempt = 0; attempt < 12; attempt++) {
        const distance = 6 + (attempt === 0 ? random() : (attempt - 1) / 10) * (length - gap - 12);
        const t = (distance + gap / 2) / length;
        const cx = edge.x1 + (edge.x2 - edge.x1) * t, cy = edge.y1 + (edge.y2 - edge.y1) * t;
        const box = vertical ? { left: cx - bodyWidth - 2, right: cx + bodyWidth + 2,
          top: cy - size / 2 - 2, bottom: cy + size / 2 + 2 } :
          { left: cx - bodyWidth / 2 - 2, right: cx + bodyWidth / 2 + 2,
            top: cy - size - 2, bottom: cy + size + 2 };
        if (clear(box)) possible.push({ from: (start + distance) / perimeter,
          to: (start + distance + gap) / perimeter, edge: edge.id,
          side: vertical ? (cx < (shape.left + shape.right) / 2 ? -1 : 1) : 0, y: cy });
      }
    }
    const count = emptyRoom ? 2 : random() < .5 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      if (!possible.length) break;
      // Empty rooms need useful entrances from both vacant sides, near a floor.
      // Nested content shells retain their freely randomized openings.
      const sides = emptyRoom ? possible.map((gap, index) => ({ gap, index }))
        .filter(({ gap }) => gap.side === (i === 0 ? -1 : 1))
        .sort((a, b) => Math.abs(a.gap.y - (shape.bottom - size * 1.5)) -
          Math.abs(b.gap.y - (shape.bottom - size * 1.5))) : [];
      const index = sides.length ? sides[0]!.index :
        Math.min(possible.length - 1, Math.floor(random() * possible.length));
      const selected = possible[index]!;
      base.openings.push({ from: selected.from, to: selected.to });
      for (let j = possible.length - 1; j >= 0; j--) {
        if (possible[j]!.edge === selected.edge) possible.splice(j, 1);
      }
    }
    // For curves, cut by projected body clearance rather than by arc length.
    if (!base.openings.length && shape.kind === 'ellipse') {
      const cx = (shape.left + shape.right) / 2, cy = (shape.top + shape.bottom) / 2;
      const sides = [0, 1, 2, 3]; // right, bottom, left, top
      while (sides.length) {
        const index = Math.min(sides.length - 1, Math.floor(random() * sides.length));
        const side = sides.splice(index, 1)[0]!;
        const horizontal = side === 1 || side === 3;
        const x = side === 0 ? shape.right : side === 2 ? shape.left : cx;
        const y = side === 1 ? shape.bottom : side === 3 ? shape.top : cy;
        const passage = horizontal ? { left: x - bodyWidth / 2 - 2, right: x + bodyWidth / 2 + 2,
          top: y - size - 2, bottom: y + size + 2 } :
          { left: x - bodyWidth - 2, right: x + bodyWidth + 2,
            top: y - size / 2 - 2, bottom: y + size / 2 + 2 };
        if (!clear(passage)) continue;
        const cut = horizontal ? { ...passage, left: x - size * .625, right: x + size * .625,
          ...(side === 1 ? { top: cy } : { bottom: cy }) } :
          { ...passage, top: y - size * .825, bottom: y + size * .825,
          left: side === 0 ? cx : shape.left - bodyWidth - 2,
          right: side === 0 ? shape.right + bodyWidth + 2 : cx };
        let distance = 0;
        const intervals: { from: number; to: number }[] = [];
        for (const edge of segments) {
          const length = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1);
          const interval = clipSegment(edge, cut);
          if (interval) {
            const from = (distance + length * interval[0]) / perimeter;
            const to = (distance + length * interval[1]) / perimeter;
            const previous = intervals.at(-1);
            if (previous && Math.abs(previous.to - from) < .000001) previous.to = to;
            else intervals.push({ from, to });
          }
          distance += length;
        }
        const span = intervals.reduce((sum, gap) => sum + gap.to - gap.from, 0);
        if (span > 0 && span < .75 &&
          !shapeSegments({ ...base, openings: intervals }).some(edge => clipSegment(edge, passage))) {
          base.openings.push(...intervals); break;
        }
      }
    }
    if (base.openings.length) resolved.set(shape.id, base);
    // An enclosing shell with no body-sized entrance only traps its contents.
    // Keep its children and omit that shell rather than leave an inaccessible room.
    else removed.add(shape.id);
  }
  return shapes.filter(shape => !removed.has(shape.id)).map(shape => resolved.get(shape.id)!);
}

export function segmentSlice(segment: BoundarySegment, from: number, to: number,
  axis: 'x' | 'y'): [number, number] | null {
  const a1 = axis === 'x' ? segment.x1 : segment.y1;
  const a2 = axis === 'x' ? segment.x2 : segment.y2;
  const b1 = axis === 'x' ? segment.y1 : segment.x1;
  const b2 = axis === 'x' ? segment.y2 : segment.x2;
  if (to <= Math.min(a1, a2) || from >= Math.max(a1, a2)) {
    if (Math.abs(a1 - a2) > .001 || a1 <= from || a1 >= to) return null;
  }
  if (Math.abs(a2 - a1) < .001) return [Math.min(b1, b2), Math.max(b1, b2)];
  const t1 = Math.max(0, Math.min(1, (from - a1) / (a2 - a1)));
  const t2 = Math.max(0, Math.min(1, (to - a1) / (a2 - a1)));
  const p = b1 + (b2 - b1) * t1, q = b1 + (b2 - b1) * t2;
  return [Math.min(p, q), Math.max(p, q)];
}

const segmentMaps = new WeakMap<World, Map<number, BoundarySegment>>();
export function getSegment(world: World, id: number): BoundarySegment | undefined {
  let map = segmentMaps.get(world);
  if (!map) { map = new Map(world.segments?.map(segment => [segment.id, segment])); segmentMaps.set(world, map); }
  return map.get(id);
}
