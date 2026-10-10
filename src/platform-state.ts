import type { Platform } from './types.js';

/** Uses simulation time, so pause/selection freezes both rendering and collision. */
export function platformPhase(platform: Platform, seconds: number): number {
  const cycle = platform.blink;
  return cycle ? ((seconds + cycle.phase) % cycle.period + cycle.period) % cycle.period : 0;
}

export function platformIsActive(platform: Platform, seconds = 0): boolean {
  return !platform.blink || platformPhase(platform, seconds) < platform.blink.visibleSeconds;
}
