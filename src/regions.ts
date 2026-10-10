import { canOccupy, playerWidth } from './physics.js';
import { surfaceY } from './geometry.js';
import { temporary } from './platform-state.js';
import type { Platform, World } from './types.js';

export interface RegionPoint { regionId: number; platform: Platform; x: number; footY: number }
export function regionColumns(world: World): number { return world.width >= 1100 ? 3 : 2; }
export function regionId(world: World, x: number, y: number): number {
  const columns = regionColumns(world);
  return Math.min(1, Math.max(0, Math.floor(y / world.height * 2))) * columns +
    Math.min(columns - 1, Math.max(0, Math.floor(x / world.width * columns)));
}
export function reservedPoint(world: World, x: number, footY: number): boolean {
  const half = playerWidth(world) / 2;
  return (world.reserved ?? []).some(box => x + half + 4 > box.left && x - half - 4 < box.right &&
    footY > box.top - 4 && footY - world.characterHeight < box.bottom + 4);
}

/** Geometry candidates are collected before any reachability filtering. */
export function regionPoints(world: World, random: () => number = Math.random, limit = 8): RegionPoint[] {
  const columns = regionColumns(world), groups = new Map<number, Map<number, RegionPoint[]>>();
  const margin = playerWidth(world) / 2 + 1;
  for (const platform of world.platforms) {
    if (temporary(platform)) continue;
    for (let col = 0; col < columns; col++) {
      const left = Math.max(platform.left + margin, col * world.width / columns + margin);
      const right = Math.min(platform.right - margin, (col + 1) * world.width / columns - margin);
      if (left > right) continue;
      for (const fraction of [.04 + random() * .12, .42 + random() * .16, .84 + random() * .12, random()]) {
        const x = left + (right - left) * fraction, footY = surfaceY(platform, x, world);
        if (reservedPoint(world, x, footY) || (!canOccupy(world, x, footY, false, platform.id) &&
          !canOccupy(world, x, footY, true, platform.id))) continue;
        const id = regionId(world, x, footY), surfaces = groups.get(id) ?? new Map();
        const points = surfaces.get(platform.id) ?? [];
        points.push({ regionId: id, platform, x, footY });
        surfaces.set(platform.id, points); groups.set(id, surfaces);
      }
    }
  }
  const output: RegionPoint[] = [];
  for (const surfaces of groups.values()) {
    let count = 0;
    for (let round = 0; count < limit; round++) {
      let added = false;
      for (const points of surfaces.values()) if (points[round] && count < limit) {
        output.push(points[round]!); count++; added = true;
      }
      if (!added) break;
    }
  }
  return output;
}

/** A shuffled bag gives regions equal turns regardless of their icon count. */
export class RegionRotation {
  private bag: number[] = [];
  private last: number[] = [];
  private counts = new Map<number, number>();
  readonly visited = new Set<number>();
  order(ids: readonly number[], random: () => number): number[] {
    const eligible = [...new Set(ids)];
    this.bag = this.bag.filter(id => eligible.includes(id));
    if (!this.bag.length) {
      this.bag = [...eligible];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.floor(random() * (i + 1)));
        [this.bag[i], this.bag[j]] = [this.bag[j]!, this.bag[i]!];
      }
    }
    // Recently unavailable regions stay in the bag; visited regions are fallback only.
    const remaining = this.bag.filter(id => id !== this.last.at(-1));
    const fresh = remaining.filter(id => !this.last.includes(id));
    const ties = new Map(eligible.map(id => [id, random()]));
    const fallback = eligible.filter(id => !this.bag.includes(id) && id !== this.last.at(-1))
      .sort((a, b) => (this.counts.get(a) ?? 0) - (this.counts.get(b) ?? 0) || ties.get(a)! - ties.get(b)!);
    const order = [...fresh, ...remaining.filter(id => !fresh.includes(id)),
      ...fallback];
    const previous = this.last.at(-1);
    if (previous !== undefined && eligible.includes(previous)) order.push(previous);
    return [...new Set(order)];
  }
  commit(id: number): void {
    this.bag = this.bag.filter(item => item !== id);
    this.last.push(id); if (this.last.length > 2) this.last.shift();
    this.visited.add(id);
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }
  reset(): void { this.bag = []; this.last = []; this.visited.clear(); this.counts.clear(); }
  clone(): RegionRotation {
    const copy = new RegionRotation(); copy.bag = [...this.bag]; copy.last = [...this.last];
    copy.counts = new Map(this.counts);
    for (const id of this.visited) copy.visited.add(id); return copy;
  }
}

/** Source allocation is spatial, before width-based extras. */
export function distributedSources(world: World, eligible: Platform[], limit = 48): Platform[] {
  const groups = new Map<number, Platform[]>();
  for (const platform of eligible) {
    const id = regionId(world, (platform.left + platform.right) / 2, platform.top);
    const group = groups.get(id) ?? []; group.push(platform); groups.set(id, group);
  }
  const result: Platform[] = [];
  for (let round = 0; result.length < limit; round++) {
    let added = false;
    for (const group of groups.values()) if (group[round] && result.length < limit) {
      result.push(group[round]!); added = true;
    }
    if (!added) break;
  }
  return result;
}
