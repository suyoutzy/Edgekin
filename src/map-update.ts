import { canOccupy, playerWidth, spawnPlayer } from './physics.js';
import { surfaceY } from './geometry.js';
import { vacantLedge } from './connections.js';
import { platformIsActive, temporary } from './platform-state.js';
import type { JumpRecipe, Platform, Player, RewardTarget, Shape, World } from './types.js';

function shapeSignature(shape: Shape): string {
  return [shape.left, shape.right, shape.top, shape.bottom, shape.radius, shape.kind, shape.hollow,
    JSON.stringify(shape.points), JSON.stringify(shape.openings)].join('|');
}
export function sameSurface(a: Platform, b: Platform, old: World, next: World): boolean {
  if (a.left !== b.left || a.right !== b.right || a.top !== b.top) return false;
  if (a.shapeId !== undefined || b.shapeId !== undefined) {
    const sa = old.shapes?.find(shape => shape.id === a.shapeId), sb = next.shapes?.find(shape => shape.id === b.shapeId);
    if (!sa || !sb || shapeSignature(sa) !== shapeSignature(sb)) return false;
  }
  return true;
}

export function retainHelpers(old: World, next: World): World {
  let world = next;
  for (const helper of old.platforms.filter(platform => platform.generated === 'gap')) {
    const anchors = (helper.anchorKeys ?? []).map(key => ({
      old: old.platforms.find(platform => (platform.key ?? String(platform.id)) === key),
      next: next.platforms.find(platform => (platform.key ?? String(platform.id)) === key),
    }));
    if (!anchors.length || anchors.some(anchor => !anchor.old || !anchor.next)) continue;
    const mix = helper.anchorMix ?? 0;
    const shift = (axis: 'left' | 'top'): number => anchors.reduce((n, anchor, i) =>
      n + (anchor.next![axis] - anchor.old![axis]) * (anchors.length === 1 ? 1 : i === 0 ? 1 - mix : mix), 0);
    const dx = shift('left'), dy = shift('top');
    const platform = { ...helper, left: helper.left + dx, right: helper.right + dx, top: helper.top + dy };
    if (vacantLedge(world, platform)) world = { ...world, platforms: [...world.platforms, platform] };
  }
  world = { ...world, platformStates: new Map() };
  for (const platform of world.platforms) {
    const before = old.platforms.find(item => item.key === platform.key && item.crumble);
    const state = before && old.platformStates?.get(before.id);
    if (state) world.platformStates!.set(platform.id, { ...state });
  }
  return world;
}

export function reuseGraph(old: World, next: World, graph: Map<number, JumpRecipe[]>): Map<number, JumpRecipe[]> {
  if (old.characterHeight !== next.characterHeight) return new Map();
  const nextByKey = new Map(next.platforms.filter(item => item.key).map(item => [item.key!, item]));
  const mapping = new Map<number, Platform>();
  for (const before of old.platforms) {
    const after = before.key ? nextByKey.get(before.key) : next.platforms.find(item => item.id === before.id);
    if (after && sameSurface(before, after, old, next)) mapping.set(before.id, after);
  }
  const oldShapes = new Map(old.shapes?.map(shape => [shape.key ?? String(shape.id), shape]));
  const newShapes = new Map(next.shapes?.map(shape => [shape.key ?? String(shape.id), shape]));
  const dirty: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const key of new Set([...oldShapes.keys(), ...newShapes.keys()])) {
    const a = oldShapes.get(key), b = newShapes.get(key);
    if (!a || !b || shapeSignature(a) !== shapeSignature(b)) { if (a) dirty.push(a); if (b) dirty.push(b); }
  }
  for (const before of old.platforms) if (!mapping.has(before.id)) dirty.push({ ...before, bottom: before.top });
  for (const after of next.platforms) if (![...mapping.values()].some(item => item.id === after.id)) dirty.push({ ...after, bottom: after.top });
  const result = new Map<number, JumpRecipe[]>();
  for (const [id, recipes] of graph) {
    const source = mapping.get(id); if (!source) continue;
    const kept = recipes.filter(recipe => mapping.has(recipe.landedOn) && (!dirty.length || recipe.bounds && !dirty.some(box =>
      recipe.bounds!.left - 1 <= box.right && recipe.bounds!.right + 1 >= box.left &&
      recipe.bounds!.top - 1 <= box.bottom && recipe.bounds!.bottom + 1 >= box.top)))
      .map(recipe => ({ ...recipe, landedOn: mapping.get(recipe.landedOn)!.id }));
    // If an edge was invalidated, this source must be sampled again.
    if (kept.length === recipes.length) result.set(source.id, kept);
  }
  return result;
}

export function matchingPlatform(old: Platform | undefined, next: World): Platform | undefined {
  if (!old) return undefined;
  return old.key ? next.platforms.find(platform => platform.key === old.key) : next.platforms.find(platform => platform.id === old.id);
}
export function migrateBody(body: Player, old: World, next: World, seconds = 0): Player | null {
  if (body.groundedOn === null) {
    return canOccupy(next, body.x, body.footY, Boolean(body.crouching), null, seconds) ||
      !canOccupy(old, body.x, body.footY, Boolean(body.crouching), null, seconds) ? { ...body } : null;
  }
  const before = old.platforms.find(platform => platform.id === body.groundedOn), after = matchingPlatform(before, next);
  if (!before || !after) return null;
  const fraction = (body.x - before.left) / Math.max(.001, before.right - before.left);
  const x = after.left + fraction * (after.right - after.left), footY = surfaceY(after, x, next);
  if (!canOccupy(next, x, footY, Boolean(body.crouching), after.id, seconds)) return null;
  const active = platformIsActive(after, seconds, next.platformStates);
  return { ...body, x, footY, groundedOn: active ? after.id : null,
    ...(active ? { velocityY: 0 } : { coyoteTime: 0, jumpBufferTime: 0 }) };
}
export function safeBody(world: World, near: { x: number; footY: number }, seconds = 0): Player | null {
  const margin = playerWidth(world) / 2 + 1;
  const candidates: Player[] = [];
  for (const platform of world.platforms) {
    if (temporary(platform) || platform.right - platform.left < margin * 2) continue;
    const x = Math.max(platform.left + margin, Math.min(platform.right - margin, near.x));
    for (const point of [x, (platform.left + platform.right) / 2, platform.left + margin, platform.right - margin]) {
      const y = surfaceY(platform, point, world);
      for (const crouch of [false, true]) if (canOccupy(world, point, y, crouch, platform.id, seconds)) {
        candidates.push(spawnPlayer(platform, world, point, crouch)); break;
      }
    }
  }
  candidates.sort((a, b) => Math.hypot(a.x - near.x, a.footY - near.footY) - Math.hypot(b.x - near.x, b.footY - near.footY));
  return candidates[0] ?? null;
}
export function migrateTarget(target: RewardTarget, old: World, next: World, seconds = 0): RewardTarget | null {
  const before = old.platforms.find(platform => platform.id === target.platformId), after = matchingPlatform(before, next);
  if (!before || !after || temporary(after)) return null;
  const x = after.left + (target.x - before.left) / Math.max(.001, before.right - before.left) * (after.right - after.left);
  const footY = surfaceY(after, x, next);
  if (!canOccupy(next, x, footY, false, after.id, seconds) && !canOccupy(next, x, footY, true, after.id, seconds)) return null;
  return { ...target, platformId: after.id, x, footY };
}
export function removeSources(world: World, removed: readonly number[]): World {
  const ids = new Set(removed);
  const shapes = world.shapes?.filter(shape => !shape.sourceIds?.some(id => ids.has(id)));
  const shapeIds = new Set(shapes?.map(shape => shape.id));
  const page = world.platforms.filter(platform => !(platform.sourceId !== undefined && ids.has(platform.sourceId)) &&
    (platform.shapeId === undefined || shapeIds.has(platform.shapeId)));
  const keys = new Set(page.map(platform => platform.key ?? String(platform.id)));
  return { ...world, shapes, segments: world.segments?.filter(segment => shapeIds.has(segment.shapeId)),
    platforms: page.filter(platform => !platform.anchorKeys?.some(key => !keys.has(key))) };
}
