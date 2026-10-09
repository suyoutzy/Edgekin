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
const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'CIRCLE', 'ELLIPSE']);
export const CONTOUR_BUDGET = 240;
function visibleColor(color: string): boolean {
  return color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
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
    const exposed = [.2, .5, .8].some(fraction => {
      const x = Math.max(0, Math.min(width - 1, rect.left + rect.width * fraction));
      const y = Math.max(0, Math.min(height - 1, rect.top + Math.min(rect.height * .5, 12)));
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
      shapes.push({ id: shapes.length, left: rect.left, right: rect.right,
        top: rect.top, bottom: rect.bottom, radius, kind: ellipse ? 'ellipse' : 'rect',
        ...(icon ? { detail: 'icon' as const } : {}), ...(control ? { control: true } : {}) });
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
  const candidates = openContainers(cleaned, size, width, height);
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
