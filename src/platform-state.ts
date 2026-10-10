import type { Platform, PlatformState, Player, World } from './types.js';
import { bodyHeight, playerWidth } from './dimensions.js';

/** Uses simulation time, so pausing freezes rendering and collision together. */
export function platformPhase(platform: Platform, seconds: number): number {
  const cycle = platform.blink;
  return cycle ? ((seconds + cycle.phase) % cycle.period + cycle.period) % cycle.period : 0;
}

export function platformIsActive(platform: Platform, seconds = 0,
  states?: ReadonlyMap<number, PlatformState>): boolean {
  if (platform.crumble) {
    const state = states?.get(platform.id);
    return !state || state.phase === 'ready' ||
      (state.phase === 'warning' && seconds < state.triggeredAt + platform.crumble.warningSeconds - .000001);
  }
  return !platform.blink || platformPhase(platform, seconds) < platform.blink.visibleSeconds;
}

export function temporary(platform: Platform): boolean { return Boolean(platform.crumble || platform.blink); }

/** Every simulated route owns its state; geometric data can be shared. */
export function clonePlatformWorld(world: World): World {
  return world.platforms.some(platform => platform.crumble) || world.platformStates ?
    { ...world, platformStates: new Map([...world.platformStates ?? []].map(([id, state]) => [id, { ...state }])) } : world;
}

function overlapsBody(world: World, platform: Platform, body: Player): boolean {
  const half = playerWidth(world) / 2;
  return body.x + half > platform.left && body.x - half < platform.right &&
    body.footY > platform.top + .001 && body.footY - bodyHeight(world, Boolean(body.crouching)) < platform.top - .001;
}

export function updatePlatformTimers(world: World, body: Player, seconds: number): void {
  if (!world.platforms.some(platform => platform.crumble)) return;
  const states = world.platformStates ??= new Map();
  for (const platform of world.platforms) {
    if (!platform.crumble) continue;
    const state = states.get(platform.id);
    if (!state) continue;
    const end = state.triggeredAt + platform.crumble.warningSeconds;
    if (state.phase === 'warning' && seconds >= end - .000001) state.phase = 'hidden';
    if (state.phase === 'hidden' && seconds >= end + platform.crumble.hiddenSeconds - .000001 &&
      !overlapsBody(world, platform, body)) {
      const half = playerWidth(world) / 2;
      const top = body.footY - bodyHeight(world, Boolean(body.crouching));
      state.phase = 'ready';
      state.needsExit = (body.x + half > platform.left && body.x - half < platform.right &&
        (Math.abs(body.footY - platform.top) < .01 || Math.abs(top - platform.top) < .01)) ||
        (top < platform.top && body.footY > platform.top &&
          (Math.abs(body.x + half - platform.left) < .01 || Math.abs(body.x - half - platform.right) < .01));
    }
  }
}

/** IDs come from actual collision/support events, including side and underside. */
export function touchPlatforms(world: World, ids: readonly number[], seconds: number): void {
  const touched = new Set(ids);
  for (const platform of world.platforms) {
    if (!platform.crumble) continue;
    const states = world.platformStates ??= new Map();
    const state = states.get(platform.id);
    if (!touched.has(platform.id)) { if (state?.phase === 'ready') state.needsExit = false; continue; }
    if (!state || (state.phase === 'ready' && !state.needsExit))
      states.set(platform.id, { phase: 'warning', triggeredAt: seconds });
  }
}
