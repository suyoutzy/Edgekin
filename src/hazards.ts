import { bodyHeight, playerWidth } from './dimensions.js';
import { canOccupy, movementSpeed } from './physics.js';
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

/** Patrol spans scale with the actual clear part of a long surface. */
export function createPatrols(world: World, protectedPoints: readonly { x: number; footY: number }[],
  preferredIds: readonly number[] = [], random = randomUnit): Patrol[] {
  const size = world.characterHeight;
  const platforms = [...world.platforms].filter(platform => platform.kind !== 'helper' &&
    platform.right - platform.left >= size * 16)
    .sort((a, b) => Number(preferredIds.includes(b.id)) - Number(preferredIds.includes(a.id)) ||
      (b.right - b.left) - (a.right - a.left));
  const patrols: Patrol[] = [];
  for (const platform of platforms) {
    const runs: { left: number; right: number; footY: number }[] = [];
    let run: typeof runs[number] | null = null;
    const step = size * .5;
    for (let x = platform.left + size * 2; x <= platform.right - size * 2; x += step) {
      const footY = surfaceY(platform, x, world);
      let clear = !(x > world.width - 520 && footY < 180) &&
        !protectedPoints.some(point => Math.abs(point.footY - footY) < size * 1.5 && Math.abs(point.x - x) < size * 2.5);
      for (let lift = 0; lift <= size * 4 && clear; lift += size * .5) {
        clear = canOccupy(world, x, footY - lift, false, lift === 0 ? platform.id : null);
      }
      if (!clear || (run && Math.abs(run.footY - footY) > .5)) { run = null; continue; }
      if (!run) { run = { left: x, right: x, footY }; runs.push(run); }
      else run.right = x;
    }
    runs.sort((a, b) => b.right - b.left - (a.right - a.left));
    for (const clear of runs) {
      const width = clear.right - clear.left - size * 2;
      const span = Math.min((platform.right - platform.left) * .65, width);
      if (span < size * 4) continue;
      const center = (clear.left + clear.right) / 2;
      const left = center - span / 2, right = center + span / 2, footY = clear.footY;
      if (patrols.some(old => Math.abs(footY - old.footY) < size * 1.5 &&
        right + size * 3 > old.left && left - size * 3 < old.right)) continue;
      const peakSpeed = movementSpeed(world) * (.95 + random() * .2);
      const patrol: Patrol = { id: patrols.length, platformId: platform.id, left, right, footY,
        radius: size * .25, period: Math.max(2.4, span * Math.PI / peakSpeed), phase: random() };
      patrols.push(patrol);
      break;
    }
    if (patrols.length === 2) break;
  }
  return patrols;
}
