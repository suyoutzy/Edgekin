import { bodyHeight, characterHeight, playerWidth } from './dimensions.js';
import { normalizeShapes } from './geometry.js';
import { openContainers, shapeSegments } from './contours.js';
import { selectContours } from './contour-selection.js';
import type { Platform, Shape, World } from './types.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';

export interface PageSnapshot { element: Element; left: number; top: number; width: number; height: number }
const snapshots = new WeakMap<World, PageSnapshot[]>();
export function getPageSnapshot(world: World): PageSnapshot[] { return snapshots.get(world) ?? []; }

const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'PRE']);
const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'CIRCLE', 'ELLIPSE', 'POLYGON']);
export const CONTOUR_BUDGET = 240;
function visibleColor(color: string): boolean {
  return color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
}

/** Read explicit CSS/SVG polygons; keep convex shapes with 3–16 vertices. */
function polygonOf(element: Element, rect: DOMRect, clipPath: string): [number, number][] | null {
  let points: [number, number][] = [];
  const polygon = element instanceof SVGPolygonElement ? element :
    element.tagName.toUpperCase() === 'SVG' ? element.querySelector('polygon') : null;
  if (polygon instanceof SVGPolygonElement && polygon.points.numberOfItems >= 3 && polygon.points.numberOfItems <= 16) {
    const matrix = polygon.getScreenCTM();
    if (!matrix) return null;
    for (let i = 0; i < polygon.points.numberOfItems; i++) {
      const point = polygon.points.getItem(i).matrixTransform(matrix);
      points.push([point.x, point.y]);
    }
    const bounds = polygon.getBoundingClientRect();
    if (bounds.width < rect.width * .75 || bounds.height < rect.height * .75) return null;
  } else if (/^polygon\(/.test(clipPath)) {
    const pairs = clipPath.slice(8, -1).split(',');
    if (pairs.length < 3 || pairs.length > 16) return null;
    for (const pair of pairs) {
      const match = pair.trim().match(/^(-?[\d.]+)(%|px)?\s+(-?[\d.]+)(%|px)?$/);
      if (!match) return null;
      points.push([rect.left + Number(match[1]) * (match[2] === '%' ? rect.width / 100 : 1),
        rect.top + Number(match[3]) * (match[4] === '%' ? rect.height / 100 : 1)]);
    }
  } else return null;
  let direction = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!, c = points[(i + 2) % points.length]!;
    if (!a.every(Number.isFinite)) return null;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < .001) continue;
    if (direction && Math.sign(cross) !== direction) return null;
    direction = Math.sign(cross);
  }
  // Same-turn star paths can self-intersect. Every vertex must also lie on
  // the inward side of every edge before treating this as a convex solid.
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    if (points.some(point => direction * ((b[0] - a[0]) * (point[1] - a[1]) -
      (b[1] - a[1]) * (point[0] - a[0])) < -.001)) return null;
  }
  return direction ? points : null;
}

function* scanSteps(root: HTMLElement, width: number, height: number): Generator<void, World> {
  const totalStart = performance.now();
  let domStart = totalStart, domMs = 0, elementsVisited = 0;
  const tracked: PageSnapshot[] = [];
  const size = characterHeight(height);
  const shapes: Shape[] = [];
  const text: Platform[] = [];
  for (const element of root.querySelectorAll('*')) {
    elementsVisited++;
    if (elementsVisited % 128 === 0) { domMs += performance.now() - domStart; yield; domStart = performance.now(); }
    if (element.closest('[data-edgekin-ignore]') ||
      ['PATH', 'G', 'DEFS', 'SCRIPT', 'STYLE'].includes(element.tagName.toUpperCase())) continue;
    const tag = element.tagName.toUpperCase();
    const rect = element.getBoundingClientRect();
    if (rect.right <= 0 || rect.left >= width || rect.bottom <= 0 || rect.top >= height) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
    const border = ['top', 'right', 'bottom', 'left'].some(side =>
      style.getPropertyValue(`border-${side}-style`) !== 'none' &&
      Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
      visibleColor(style.getPropertyValue(`border-${side}-color`)));
    const background = visibleColor(style.backgroundColor) || style.backgroundImage !== 'none';
    const icon = Math.max(rect.width, rect.height) <= 48 &&
      (MEDIA_TAGS.has(tag) || tag === 'I' || element.getAttribute('role') === 'img' ||
        /icon|emoji|avatar/i.test(element.getAttribute('class') ?? '') ||
        ((element.textContent?.trim().length ?? 0) <= 4 &&
          /[\p{Extended_Pictographic}★♥◆⚙]/u.test(element.textContent ?? '')));
    const isSurface = border || background || MEDIA_TAGS.has(tag) ||
      icon || ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
    const control = ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(tag) ||
      ['button', 'textbox', 'combobox'].includes(element.getAttribute('role') ?? '') ||
      /(^|\s)(btn(?:-|\s|$)|Button(?:-|\s|$))/.test(element.getAttribute('class') ?? '');
    const exposed = (MEDIA_TAGS.has(tag) || style.backgroundImage !== 'none' ?
      [[.2, .12], [.5, .12], [.8, .12], [.2, .5], [.5, .5], [.8, .5], [.5, .8]] :
      [[.2, 0], [.5, 0], [.8, 0]]).some(([fx, fy]) => {
      const x = Math.max(0, Math.min(width - 1, rect.left + rect.width * fx!));
      const y = Math.max(0, Math.min(height - 1, rect.top + (fy ? rect.height * fy : Math.min(rect.height * .5, 12))));
      const hit = document.elementFromPoint(x, y);
      return hit === element || (hit !== null && element.contains(hit));
    });
    if (!exposed) continue;
    const minimum = icon ? Math.max(8, size * .3) : size * .65;
    if (isSurface && rect.width >= minimum && rect.height >= minimum &&
      !(rect.width > width * .95 && rect.height > height * .8)) {
      if (tracked.length < 256) tracked.push({ element, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      const radiusText = style.borderTopLeftRadius;
      const radius = Math.min(rect.width / 2, rect.height / 2,
        radiusText.includes('%') ? Math.min(rect.width, rect.height) * Number.parseFloat(radiusText) / 100 :
          Number.parseFloat(radiusText) || 0);
      const svgRound = tag === 'SVG' && [...element.querySelectorAll('circle,ellipse')].some(round => {
        const bounds = round.getBoundingClientRect();
        return bounds.width >= rect.width * .75 && bounds.height >= rect.height * .75;
      });
      const ellipse = ['CIRCLE', 'ELLIPSE'].includes(tag) || svgRound ||
        (radiusText.includes('%') && Number.parseFloat(radiusText) >= 50) ||
        (Math.abs(rect.width - rect.height) < Math.min(rect.width, rect.height) * .1 &&
          radius >= Math.min(rect.width, rect.height) * .47);
      const points = polygonOf(element, rect, style.clipPath);
      shapes.push({ id: shapes.length, left: points ? Math.min(...points.map(point => point[0])) : rect.left,
        right: points ? Math.max(...points.map(point => point[0])) : rect.right,
        top: points ? Math.min(...points.map(point => point[1])) : rect.top,
        bottom: points ? Math.max(...points.map(point => point[1])) : rect.bottom,
        radius, kind: points ? 'polygon' : ellipse ? 'ellipse' : 'rect', ...(points ? { points } : {}),
        ...(icon ? { detail: 'icon' as const } : {}), ...(control ? { control: true } : {}),
        ...(MEDIA_TAGS.has(tag) || style.backgroundImage !== 'none' ? { media: true } : {}) });
    } else if (TEXT_TAGS.has(tag) && element.textContent?.trim()) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const ink = range.getBoundingClientRect();
      if (ink.width >= size * 4 && ink.height < height * .28 && ink.top > size * 2 &&
        !element.closest('button,input,svg')) {
        text.push({ id: 0, left: Math.max(0, ink.left), right: Math.min(width, ink.right),
          top: ink.top, kind: 'page', tier: 'text' });
      }
    }
  }
  domMs += performance.now() - domStart;
  yield;
  const ordered = shapes.sort((a, b) => a.top - b.top || a.left - b.left);
  const normalizeStart = performance.now();
  const cleaned = normalizeShapes(ordered, size, bodyHeight({ characterHeight: size }, true));
  const normalizeMs = performance.now() - normalizeStart;
  yield;
  const openingsStart = performance.now();
  const candidates = openContainers(cleaned, size, width, height, Math.random, true);
  const openingsMs = performance.now() - openingsStart;
  yield;
  const surfacesStart = performance.now();
  const { shapes: normalized, stats: contourStats } = selectContours(candidates, CONTOUR_BUDGET);
  const segments = normalized.filter(shape => shape.hollow).flatMap(shape => shapeSegments(shape))
    .map((segment, id) => ({ ...segment, id }));
  const platforms: Platform[] = normalized.filter(shape => !shape.hollow && shape.top >= size * 1.7 &&
    shape.top < height - size && shape.right - shape.left >= playerWidth({ characterHeight: size }) + 2 &&
    !normalized.some(outer => !outer.hollow && outer.id !== shape.id && outer.left <= shape.left &&
      outer.right >= shape.right && outer.top < shape.top && outer.bottom > shape.top))
    .map(shape => {
      return { id: 0, left: Math.max(0, shape.left), right: Math.min(width, shape.right),
        top: shape.top, kind: 'page' as const, tier: 'visual' as const, shapeId: shape.id };
    }).filter(platform => platform.right - platform.left >= playerWidth({ characterHeight: size }) + 2);
  for (const segment of segments) {
    if (Math.abs(segment.x2 - segment.x1) < .1) continue;
    platforms.push({ id: 0, left: Math.min(segment.x1, segment.x2), right: Math.max(segment.x1, segment.x2),
      top: Math.min(segment.y1, segment.y2), shapeId: segment.shapeId, segmentId: segment.id,
      kind: 'page', tier: 'visual' });
  }
  for (const edge of text.slice(0, 16)) {
    if (normalized.some(shape => !shape.hollow && edge.top > shape.top && edge.top < shape.bottom &&
      edge.right > shape.left && edge.left < shape.right)) continue;
    if (platforms.some(other => Math.abs(other.top - edge.top) < size * 1.15 &&
      other.right > edge.left && other.left < edge.right)) continue;
    platforms.push(edge);
  }
  const world: World = { width, height, characterHeight: size, shapes: normalized, segments, contourStats,
    platforms: platforms.map((platform, id) => ({ ...platform, id })), scanTiming: {
      domMs, normalizeMs, openingsMs, surfacesMs: performance.now() - surfacesStart,
      totalMs: performance.now() - totalStart, elementsVisited,
    } };
  snapshots.set(world, tracked);
  return world;
}

export function scanPage(root: HTMLElement, width = innerWidth, height = innerHeight): World {
  const iterator = scanSteps(root, width, height);
  let next = iterator.next();
  while (!next.done) next = iterator.next();
  return next.value;
}

export async function scanPageAsync(root: HTMLElement, width = innerWidth, height = innerHeight,
  signal?: AbortSignal): Promise<World> {
  throwIfAborted(signal);
  const iterator = scanSteps(root, width, height);
  let next = iterator.next();
  while (!next.done) { await yieldToBrowser(signal); throwIfAborted(signal); next = iterator.next(); }
  return next.value;
}
