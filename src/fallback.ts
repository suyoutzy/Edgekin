import { assessRouteAsync, chooseLevel, reachableJumpsAsync, type SelectionOptions } from './planner.js';
import type { Level, Platform, World } from './types.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';
import { helperLimit } from './connections.js';

/** Add the fewest visible helper ledges after all page-only routes have failed. */
function* placements(source: World): Generator<{ world: World; helper: Platform; anchor: Platform }> {
  if (source.width < 640 || source.height < 480) return;
  if (source.platforms.filter(platform => platform.generated === 'gap').length >= helperLimit(source)) return;
  const nextId = Math.min(-1, ...source.platforms.map(platform => platform.id)) - 1;
  const helperWidth = Math.max(110, Math.min(155, source.width * 0.13));
  const anchors = source.platforms.filter(platform => platform.right - platform.left >= source.characterHeight * 1.5)
    .sort((a, b) =>
    (a.tier === 'text' ? 100 : 0) - (b.tier === 'text' ? 100 : 0) +
    Math.abs(a.top - source.height * 0.68) - Math.abs(b.top - source.height * 0.68));

  for (const anchor of anchors.slice(0, 16)) {
    for (const direction of [1, -1]) {
      const gap = Math.min(42, source.characterHeight * 1.5);
      const left = direction === 1 ? anchor.right + gap : anchor.left - gap - helperWidth;
      if (left < 12 || left + helperWidth > source.width - 12) continue;
      for (const heightDirection of [-1, 1]) {
        const top = anchor.top + heightDirection * source.characterHeight * 1.25;
        if (top < source.characterHeight * 2 || top > source.height - source.characterHeight * 2) continue;
        const helper: Platform = { id: nextId, left, right: left + helperWidth, top, kind: 'helper',
          generated: 'gap', key: `fallback:${anchor.key ?? anchor.id}:${direction}:${heightDirection}`,
          anchorKeys: [anchor.key ?? String(anchor.id)] };
        const world = { ...source, platforms: [...source.platforms, helper] };
        // Other page surfaces remain in the collision world. Only sample the
        // anchor and the new helper as takeoff sources, rather than rebuilding
        // the entire page graph for each of up to 64 helper placements.
        yield { world, helper, anchor };
      }
    }
  }

}

export function createFallbackLevel(source: World, options: SelectionOptions | number = {}): Level | null {
  const settings = typeof options === 'number' ? {} : options;
  for (const { world, helper, anchor } of placements(source)) {
    const level = chooseLevel(world, { ...settings, graph: undefined,
      jumpSources: [anchor.id, helper.id], requiredPlatform: helper.id });
    if (level && level.route.some(id => id !== helper.id)) return { ...level, usedFallback: true };
  }
  return null;
}

export async function createFallbackLevelAsync(source: World, options: SelectionOptions = {},
  signal?: AbortSignal): Promise<Level | null> {
  throwIfAborted(signal);
  for (const { world, helper, anchor } of placements(source)) {
    await yieldToBrowser(signal);
    const graph = await reachableJumpsAsync(world, [anchor.id, helper.id], signal);
    throwIfAborted(signal);
    const level = chooseLevel(world, { ...options, graph,
      jumpSources: [anchor.id, helper.id], requiredPlatform: helper.id });
    if (level && level.route.some(id => id !== helper.id)) return { ...level, usedFallback: true,
      metrics: await assessRouteAsync(level, graph, signal) };
  }
  return null;
}
