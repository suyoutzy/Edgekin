import { canOccupy, movementSpeed, playerWidth, spawnPlayer, stepPlayer, STEP_SECONDS } from './physics.js';
import { surfaceY } from './geometry.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';
import type { Platform, World } from './types.js';

/** A short ordinary jump/drop witness, using the same collision world as play. */
function connects(world: World, source: Platform, target: Platform): boolean {
  const margin = playerWidth(world) / 2 + 1;
  let targetX = Math.max(target.left + margin, Math.min(target.right - margin, (source.left + source.right) / 2));
  // Returning to a floor directly below requires first leaving this ledge.
  if (target.top > source.top && targetX >= source.left && targetX <= source.right) {
    targetX = source.right + margin * 2 <= target.right - margin ? source.right + margin * 2 :
      Math.max(target.left + margin, source.left - margin * 2);
  }
  for (const fraction of [0, .25, .5, .75, 1]) {
    const x = source.left + margin + Math.max(0, source.right - source.left - margin * 2) * fraction;
    if (!canOccupy(world, x, surfaceY(source, x, world), false, source.id)) continue;
    const direction = targetX >= x ? 1 : -1;
    const duration = Math.round(Math.abs(targetX - x) / (movementSpeed(world) * STEP_SECONDS));
    for (const moveFrames of [duration - 5, duration, duration + 5, duration + 12, duration + 24]) {
      if (moveFrames < 0 || moveFrames > 75) continue;
      for (const jump of target.top > source.top ? [true, false] : [true]) {
        let player = spawnPlayer(source, world, x);
        for (let frame = 0; frame < 100; frame++) {
          player = stepPlayer(player, { horizontal: frame < moveFrames ? direction : 0,
            jump: frame === 0 && jump }, world);
          if (player.groundedOn !== null && player.groundedOn !== source.id) {
            if (player.groundedOn === target.id && canOccupy(world, player.x, player.footY, false, target.id)) return true;
            break;
          }
          if (frame > 1 && player.groundedOn === source.id && jump) break;
          if (player.footY > world.height) break;
        }
      }
    }
  }
  return false;
}

function vacant(world: World, ledge: Platform): boolean {
  const size = world.characterHeight;
  const left = ledge.left - size * .6, right = ledge.right + size * .6;
  const top = ledge.top - size * 4.5, bottom = ledge.top + size * .7;
  if (left < 8 || right > world.width - 8 || top < size || bottom > world.height - size * .6 ||
    (right > world.width - 520 && top < 145)) return false;
  // Check the entire vacant patch, not just the proposed landing position.
  const intersects = (a: number, b: number, c: number, d: number): boolean =>
    a < right && b > left && c < bottom && d > top;
  if ((world.shapes ?? []).some(shape => !shape.hollow && intersects(shape.left, shape.right, shape.top, shape.bottom))) return false;
  if ((world.segments ?? []).some(edge => intersects(Math.min(edge.x1, edge.x2) - .01,
    Math.max(edge.x1, edge.x2) + .01, Math.min(edge.y1, edge.y2) - .01, Math.max(edge.y1, edge.y2) + .01))) return false;
  if ((world.walls ?? []).some(wall => intersects(wall.x - .01, wall.x + .01, wall.top, wall.bottom))) return false;
  return !world.platforms.some(platform => intersects(platform.left, platform.right, platform.top - .01, platform.top + .01));
}

function* supplement(source: World): Generator<void, World> {
  if (source.width < 640 || source.height < 480 || !source.platforms.length) return source;
  const size = source.characterHeight, ledgeWidth = size * 3.8;
  const limit = Math.min(5, Math.max(3, Math.floor(source.width * source.height / 450000)));
  const anchors = source.platforms.filter(platform => platform.right - platform.left >= size * 2 &&
    platform.top >= size * 2 && platform.top <= source.height - size)
    .sort((a, b) => b.top - a.top || b.right - b.left - (a.right - a.left));
  let world = source, count = 0, attempts = 0;
  let nextId = Math.max(-1, ...source.platforms.map(platform => platform.id)) + 1;
  for (let cursor = 0; cursor < anchors.length && count < limit && attempts < 240; cursor++) {
    const anchor = anchors[cursor]!;
    const positions: number[] = [];
    if (anchor.right - anchor.left >= size * 9) {
      positions.push((anchor.left + anchor.right - ledgeWidth) / 2);
    }
    positions.push(anchor.left - size - ledgeWidth, anchor.right + size);
    if (anchor.right - anchor.left >= size * 9) {
      for (const fraction of [.25, .75]) positions.push(anchor.left + (anchor.right - anchor.left) * fraction - ledgeWidth / 2);
    }
    for (const left of positions) {
      for (const lift of [2.1, 1.4, -1.4]) {
        if (++attempts > 240 || count >= limit) break;
        const ledge: Platform = { id: nextId, left, right: left + ledgeWidth,
          top: surfaceY(anchor, Math.max(anchor.left, Math.min(anchor.right, left + ledgeWidth / 2)), world) - size * lift,
          kind: 'helper', tier: 'visual', generated: 'gap' };
        if (!vacant(world, ledge) || world.platforms.some(platform => platform.generated === 'gap' &&
          Math.hypot((platform.left + platform.right - ledge.left - ledge.right) / 2,
            platform.top - ledge.top) < size * 5)) continue;
        const candidate = { ...world, platforms: [...world.platforms, ledge] };
        // Every addition connects both ways; isolated decoration is discarded.
        if (connects(candidate, anchor, ledge) && connects(candidate, ledge, anchor)) {
          world = candidate;
          count++; nextId++;
        }
        yield;
      }
    }
    // Webpage surfaces anchor the extra ledges; avoid chains of artificial stairs.
  }
  // One optional timing challenge; coins/checkpoints stay on permanent terrain.
  const helpers = world.platforms.filter(platform => platform.generated === 'gap');
  const timed = helpers.length >= 2 ? helpers[helpers.length - 1] : undefined;
  return timed ? { ...world, platforms: world.platforms.map(platform => platform.id === timed.id ?
    { ...platform, blink: { period: 7, visibleSeconds: 5, phase: 0 } } : platform) } : world;
}

export function addGapPlatforms(source: World): World {
  const iterator = supplement(source);
  let next = iterator.next();
  while (!next.done) next = iterator.next();
  return next.value;
}

export async function addGapPlatformsAsync(source: World, signal?: AbortSignal): Promise<World> {
  throwIfAborted(signal);
  const iterator = supplement(source);
  let next = iterator.next(), batch = performance.now();
  while (!next.done) {
    throwIfAborted(signal);
    if (performance.now() - batch >= 6) { await yieldToBrowser(signal); batch = performance.now(); }
    next = iterator.next();
  }
  return next.value;
}
