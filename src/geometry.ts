import type { Platform, Shape, World } from './types.js';
import { getSegment, segmentSlice } from './contours.js';
import { playerWidth } from './dimensions.js';
const shapeMaps = new WeakMap<World, Map<number, Shape>>();

/** Convex polygon projection clipped to a body-width/body-height slab. */
function polygonSlice(shape: Shape, low: number, high: number, axis: 0 | 1): [number, number] | null {
  const values: number[] = [], points = shape.points ?? [];
  const other = axis === 0 ? 1 : 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    if (a[axis] >= low && a[axis] <= high) values.push(a[other]);
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < .000001) continue;
    for (const bound of [low, high]) {
      const t = (bound - a[axis]) / delta;
      if (t >= 0 && t <= 1) values.push(a[other] + (b[other] - a[other]) * t);
    }
  }
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

/** Exact axis slices for convex polygons, ellipses and uniformly rounded rectangles. */
export function verticalSlice(shape: Shape, left: number, right: number): [number, number] | null {
  if (right <= shape.left || left >= shape.right) return null;
  if (shape.kind === 'polygon') return polygonSlice(shape, left, right, 0);
  const center = (shape.left + shape.right) / 2;
  const x = Math.max(left, Math.min(right, center));
  if (shape.kind === 'ellipse') {
    const rx = (shape.right - shape.left) / 2;
    const ry = (shape.bottom - shape.top) / 2;
    const dy = ry * Math.sqrt(Math.max(0, 1 - ((x - center) / rx) ** 2));
    const cy = (shape.top + shape.bottom) / 2;
    return [cy - dy, cy + dy];
  }
  const radius = shape.radius;
  const dx = Math.max(shape.left + radius - x, x - (shape.right - radius), 0);
  const inset = radius ? radius - Math.sqrt(Math.max(0, radius * radius - dx * dx)) : 0;
  return [shape.top + inset, shape.bottom - inset];
}

export function horizontalSlice(shape: Shape, top: number, bottom: number): [number, number] | null {
  if (bottom <= shape.top || top >= shape.bottom) return null;
  if (shape.kind === 'polygon') return polygonSlice(shape, top, bottom, 1);
  const center = (shape.top + shape.bottom) / 2;
  const y = Math.max(top, Math.min(bottom, center));
  if (shape.kind === 'ellipse') {
    const ry = (shape.bottom - shape.top) / 2;
    const rx = (shape.right - shape.left) / 2;
    const dx = rx * Math.sqrt(Math.max(0, 1 - ((y - center) / ry) ** 2));
    const cx = (shape.left + shape.right) / 2;
    return [cx - dx, cx + dx];
  }
  const r = shape.radius;
  const dy = Math.max(shape.top + r - y, y - (shape.bottom - r), 0);
  const inset = r ? r - Math.sqrt(Math.max(0, r * r - dy * dy)) : 0;
  return [shape.left + inset, shape.right - inset];
}

export function surfaceY(platform: Platform, x: number, world: World): number {
  if (platform.segmentId !== undefined) {
    const segment = getSegment(world, platform.segmentId);
    return segment ? segmentSlice(segment, x - playerWidth(world) / 2,
      x + playerWidth(world) / 2, 'x')?.[0] ?? platform.top : platform.top;
  }
  if (platform.shapeId === undefined) return platform.top;
  let map = shapeMaps.get(world);
  if (!map) { map = new Map(world.shapes?.map(shape => [shape.id, shape])); shapeMaps.set(world, map); }
  const shape = map.get(platform.shapeId);
  return shape ? verticalSlice(shape, x - playerWidth(world) / 2,
    x + playerWidth(world) / 2)?.[0] ?? platform.top : platform.top;
}

/** Remove duplicate outlines and close gaps narrower than the standing body. */
export function normalizeShapes(input: Shape[], size: number, clearanceHeight = size): Shape[] {
  const area = (shape: Shape): number => (shape.right - shape.left) * (shape.bottom - shape.top);
  const bodyWidth = playerWidth({ characterHeight: size });
  const duplicateInset = Math.max(4, Math.min(size * .4, clearanceHeight * .65));
  const contains = (outer: Shape, inner: Shape): boolean => outer !== inner &&
    outer.left <= inner.left + .5 && outer.right >= inner.right - .5 &&
    outer.top <= inner.top + .5 && outer.bottom >= inner.bottom - .5 && area(outer) > area(inner);
  const suppresses = (outer: Shape, inner: Shape): boolean => {
    if (!contains(outer, inner)) return false;
    // Controls are one obstacle: their label, SVG and decorative icon do not
    // create a useful room inside the overall button/input outline.
    if (outer.control) return true;
    const left = inner.left - outer.left, right = outer.right - inner.right;
    const top = inner.top - outer.top, bottom = outer.bottom - inner.bottom;
    if (left < size * .55 && right < size * .55 && top < clearanceHeight + 2 && bottom < clearanceHeight + 2) return true;
    const width = outer.right - outer.left, height = outer.bottom - outer.top;
    if (width < bodyWidth + 2 || height < clearanceHeight + 2) return true;
    // A short reaction pill cannot fit a standing path above or below its
    // emoji. Spacious cards retain their interior objects.
    return (height < size * 2 && Math.max(top, bottom) < clearanceHeight + 2) ||
      (width < bodyWidth * 3 && Math.max(left, right) < bodyWidth + 2);
  };
  const spatialOrder = (a: Shape, b: Shape): number => a.top - b.top || a.left - b.left ||
    a.bottom - b.bottom || a.right - b.right || Number(Boolean(b.control)) - Number(Boolean(a.control)) ||
    a.kind.localeCompare(b.kind) || a.radius - b.radius;
  const unique: Shape[] = [];
  // Keep the encompassing outline for almost coincident DOM/SVG bounds.
  for (const original of [...input].sort((a, b) => area(b) - area(a) || spatialOrder(a, b))) {
    const duplicate = unique.find(other => Math.abs(other.left - original.left) < duplicateInset &&
      Math.abs(other.right - original.right) < duplicateInset && Math.abs(other.top - original.top) < duplicateInset &&
      Math.abs(other.bottom - original.bottom) < duplicateInset);
    if (duplicate) {
      if (original.kind === 'polygon') {
        duplicate.kind = 'polygon'; duplicate.points = original.points;
        duplicate.left = original.left; duplicate.right = original.right;
        duplicate.top = original.top; duplicate.bottom = original.bottom;
      }
      if (original.control) duplicate.control = true;
      if (original.media) duplicate.media = true;
      continue;
    }
    unique.push({ ...original });
  }
  const candidates = unique.filter(inner => !unique.some(outer => {
    if (suppresses(outer, inner)) return true;
    if (outer === inner || area(outer) <= area(inner)) return false;
    const overlapX = Math.max(0, Math.min(outer.right, inner.right) - Math.max(outer.left, inner.left));
    const overlapY = Math.max(0, Math.min(outer.bottom, inner.bottom) - Math.max(outer.top, inner.top));
    if (overlapX * overlapY < area(inner) * .35 || contains(outer, inner)) return false;
    // A frame straddling a much larger card creates crossing walls rather than a room.
    // Keep separate overlapping cards, but omit mostly enclosed decorations.
    return area(outer) >= area(inner) * 3 ||
      (Math.abs(outer.left - inner.left) < bodyWidth && Math.abs(outer.right - inner.right) < bodyWidth &&
        Math.abs(outer.top - inner.top) < clearanceHeight && Math.abs(outer.bottom - inner.bottom) < clearanceHeight);
  }));
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]!]!; index = parent[index]!; }
    return index;
  };
  const mergeable = (a: Shape, b: Shape): boolean => {
    if (a.kind !== 'rect' || b.kind !== 'rect') return false;
    const icons = a.detail === 'icon' || b.detail === 'icon';
    if (a.detail === 'icon' && b.detail === 'icon' && !a.control && !b.control) return false;
    const gapX = Math.max(a.left - b.right, b.left - a.right);
    const gapY = Math.max(a.top - b.bottom, b.top - a.bottom);
    const alignedRows = Math.abs(a.top - b.top) < size * .4 && Math.abs(a.bottom - b.bottom) < size * .4;
    const alignedColumns = Math.abs(a.left - b.left) < size * .4 && Math.abs(a.right - b.right) < size * .4;
    // Joined controls often overlap their shared CSS border by 1-2 pixels.
    // Larger overlaps are separate geometry and must not turn into one box.
    return (alignedRows && gapX >= -2 && gapX < size * .55 &&
      (!icons || a.control || b.control || gapX <= 2)) ||
      (alignedColumns && gapY >= -2 && gapY < (clearanceHeight === size ? size * 1.15 : clearanceHeight + 2) &&
      (!icons || a.control || b.control || gapY <= 2));
  };
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (mergeable(candidates[i]!, candidates[j]!)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, Shape[]>();
  candidates.forEach((shape, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(shape); groups.set(root, group);
  });
  const merged = [...groups.values()].map(group => {
    const shape = { ...group[0]! };
    if (group.length === 1) return shape;
    shape.left = Math.min(...group.map(item => item.left));
    shape.right = Math.max(...group.map(item => item.right));
    shape.top = Math.min(...group.map(item => item.top));
    shape.bottom = Math.max(...group.map(item => item.bottom));
    shape.radius = Math.min(...group.map(item => item.radius));
    if (group.some(item => item.control)) shape.control = true;
    if (group.some(item => item.media)) shape.media = true;
    if (shape.control || group.some(item => item.detail !== 'icon')) delete shape.detail;
    delete shape.hollow; delete shape.openings;
    return shape;
  }).sort(spatialOrder);
  const retained = merged.filter(shape => !merged.some(outer => suppresses(outer, shape)));
  return retained.filter((shape, index) => !retained.some((other, otherIndex) => {
      if (shape.detail === 'icon') return false;
      if (other === shape || area(other) < area(shape) ||
        (area(other) === area(shape) && otherIndex > index)) return false;
      const gapX = Math.max(shape.left - other.right, other.left - shape.right);
      const gapY = Math.max(shape.top - other.bottom, other.top - shape.bottom);
      const overlapX = Math.min(shape.right, other.right) - Math.max(shape.left, other.left);
      const overlapY = Math.min(shape.bottom, other.bottom) - Math.max(shape.top, other.top);
      return (gapX >= 0 && gapX < size * .55 && overlapY >= size) ||
        (gapY >= 0 && gapY < (clearanceHeight === size ? size * 1.15 : clearanceHeight + 2) && overlapX >= size * .42);
    }))
    .map((shape, id) => ({ ...shape, id }));
}
