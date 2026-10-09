import type { World } from './types.js';

export const CROUCH_RATIO = .58;
type BodyScale = Pick<World, 'characterHeight'>;

export function characterHeight(viewportHeight: number): number {
  return Math.max(24, Math.min(36, viewportHeight * .03));
}

export function playerWidth(world: BodyScale): number { return world.characterHeight * .42; }

export function bodyHeight(world: BodyScale, crouching = false): number {
  return world.characterHeight * (crouching ? CROUCH_RATIO : 1);
}
