import { bodyHeight, playerWidth } from './dimensions.js';
import { canOccupy } from './physics.js';
import { surfaceY } from './geometry.js';
import { randomUnit } from './planner.js';
import type { Patrol, Player, World } from './types.js';

export function patrolPosition(patrol: Patrol, seconds: number): { x: number; y: number } {
  const wave = (1 - Math.cos((seconds / patrol.period + patrol.phase) * Math.PI * 2)) / 2;
  return { x: patrol.left + (patrol.right - patrol.left) * wave, y: patrol.footY - patrol.radius };
}

/** Squared minimum distance between a moving point and an axis-aligned box. */
function sweptDistance(ax: number, ay: number, bx: number, by: number,
  halfWidth: number, halfHeight: number): number {
  const dx = bx - ax, dy = by - ay;
  const cuts = [0, 1];
  for (const [a, delta, half] of [[ax, dx, halfWidth], [ay, dy, halfHeight]]) {
    if (!delta) continue;
    for (const edge of [-half!, half!]) {
      const t = (edge - a!) / delta;
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  const distance = (t: number): number =>
    Math.max(0, Math.abs(ax + dx * t) - halfWidth) ** 2 +
    Math.max(0, Math.abs(ay + dy * t) - halfHeight) ** 2;
  let minimum = Infinity;
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1]!, to = cuts[i]!;
    const middle = (from + to) / 2;
    const x = ax + dx * middle, y = ay + dy * middle;
    const px = Math.abs(x) > halfWidth ? ax - Math.sign(x) * halfWidth : 0;
    const py = Math.abs(y) > halfHeight ? ay - Math.sign(y) * halfHeight : 0;
    const vx = Math.abs(x) > halfWidth ? dx : 0;
    const vy = Math.abs(y) > halfHeight ? dy : 0;
    const speed = vx * vx + vy * vy;
    const closest = speed ? Math.max(from, Math.min(to, -(px * vx + py * vy) / speed)) : from;
    minimum = Math.min(minimum, distance(from), distance(to), distance(closest));
  }
  return minimum;
}

/** Runtime and route replay share the same relative-motion sweep. */
export function hitsPatrol(previous: Player, next: Player, world: World,
  patrols: readonly Patrol[], fromTime: number, toTime: number): boolean {
  const height = Math.max(bodyHeight(world, previous.crouching), bodyHeight(world, next.crouching));
  for (const patrol of patrols) {
    const a = patrolPosition(patrol, fromTime), b = patrolPosition(patrol, toTime);
    if (sweptDistance(a.x - previous.x, a.y - previous.footY + height / 2,
      b.x - next.x, b.y - next.footY + height / 2,
      playerWidth(world) / 2, height / 2) <= patrol.radius ** 2) return true;
  }
  return false;
}

export function safeFromPatrols(world: World, patrols: readonly Patrol[],
  x: number, footY: number): boolean {
  return patrols.every(patrol => Math.abs(footY - patrol.footY) > world.characterHeight * 1.5 ||
    x < patrol.left - world.characterHeight * 1.5 || x > patrol.right + world.characterHeight * 1.5);
}

/** Only broad, flat surfaces with clear jump space get a small patrol. */
export function createPatrols(world: World, protectedPoints: readonly { x: number; footY: number }[],
  preferredIds: readonly number[] = [], random = randomUnit): Patrol[] {
  const size = world.characterHeight;
  const platforms = [...world.platforms].filter(platform => platform.kind !== 'helper' &&
    platform.right - platform.left >= size * 16)
    .sort((a, b) => Number(preferredIds.includes(b.id)) - Number(preferredIds.includes(a.id)) ||
      (b.right - b.left) - (a.right - a.left));
  const patrols: Patrol[] = [];
  for (const platform of platforms) {
    for (const fraction of [.5, .3, .7]) {
      const center = platform.left + (platform.right - platform.left) * fraction;
      const left = center - size, right = center + size;
      const footY = surfaceY(platform, center, world);
      const patrol: Patrol = { id: patrols.length, platformId: platform.id, left, right, footY,
        radius: size * .25, period: 3.2 + random() * .8, phase: random() };
      if (protectedPoints.some(point => !safeFromPatrols(world, [patrol], point.x, point.footY))) continue;
      if (patrols.some(old => Math.hypot(center - (old.left + old.right) / 2, footY - old.footY) < size * 8)) continue;
      if (center > world.width - 420 && footY < 180) continue;
      let clear = true;
      // Reserve landing/waiting space and the whole jump envelope, not just the circle.
      for (let x = left - size * 3; x <= right + size * 3 && clear; x += size * .5) {
        if (x < platform.left + size || x > platform.right - size ||
          Math.abs(surfaceY(platform, x, world) - footY) > .5) { clear = false; break; }
        for (let lift = 0; lift <= size * 4; lift += size * .5) {
          if (!canOccupy(world, x, footY - lift, false, lift === 0 ? platform.id : null)) { clear = false; break; }
        }
      }
      if (!clear) continue;
      patrols.push(patrol);
      break;
    }
    if (patrols.length === 2) break;
  }
  return patrols;
}
