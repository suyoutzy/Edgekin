import { canOccupy, movementSpeed, playerWidth, spawnPlayer, stepPlayer, STEP_SECONDS } from './physics.js';
import type { Controls, JumpRecipe, Level, Platform, RouteMetrics, World } from './types.js';
import { surfaceY } from './geometry.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';

export interface EndpointPair { startX: number; startY: number; goalX: number; goalY: number }
export interface SelectionOptions {
  random?: () => number;
  recent?: EndpointPair[];
  /** Restrict graph sampling when testing a newly added helper ledge. */
  jumpSources?: readonly number[];
  requiredPlatform?: number;
  graph?: Map<number, JumpRecipe[]>;
  relaxed?: boolean;
}
export function randomUnit(): number {
  if (typeof crypto !== 'undefined') return crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296;
  return Math.random();
}
export function endpointPair(level: Level): EndpointPair {
  const start = level.world.platforms.find(platform => platform.id === level.startId)!;
  const goal = level.world.platforms.find(platform => platform.id === level.goalId)!;
  return { startX: level.startX, startY: surfaceY(start, level.startX, level.world),
    goalX: level.goalX, goalY: surfaceY(goal, level.goalX, level.world) };
}

export function recipeControl(recipe: JumpRecipe, frame: number, timingOffset = 0): Controls {
  if (recipe.steps) {
    const original = recipe.steps[frame] ?? { horizontal: 0, jump: false };
    return { ...original, jump: frame === 0 ? original.jump :
      (frame - timingOffset > 0 && recipe.steps[frame - timingOffset]?.jump) || false };
  }
  return { horizontal: frame < recipe.moveFrames + timingOffset ? recipe.horizontal : 0,
    jump: frame === 0 };
}

interface SampleBudget { remaining: number }
function sampleAction(world: World, source: Platform, takeoffX: number,
  horizontal: -1 | 1, moveFrames: number, kind: NonNullable<JumpRecipe['kind']>,
  budget: SampleBudget): JumpRecipe | null {
  const crouch = kind === 'crouch';
  let player = spawnPlayer(source, world, takeoffX, crouch);
  const steps: Controls[] = [];
  let wallJumps = 0;
  let lastJump = -10;
  const limit = kind === 'wall-jump' ? 180 : 110;
  for (let frame = 0; frame < limit && budget.remaining > 0; frame += 1) {
    budget.remaining--;
    const jump = (kind === 'jump' || kind === 'wall-jump') && (frame === 0 ||
      (kind === 'wall-jump' && player.wallSide && frame - lastJump >= 9 && wallJumps < 4));
    const input: Controls = { horizontal: frame < moveFrames ? horizontal : 0,
      jump: Boolean(jump), ...(crouch ? { crouch: true } : {}) };
    steps.push(input);
    if (jump) lastJump = frame;
    player = stepPlayer(player, input, world, STEP_SECONDS);
    if (player.event === 'wall-jump') wallJumps++;
    if (frame === 0 && (kind === 'jump' || kind === 'wall-jump') && player.velocityY >= 0) return null;
    if (player.groundedOn !== null) {
      if (player.groundedOn === source.id) {
        if (kind === 'walk' || kind === 'crouch') continue;
        return null;
      }
      if (kind === 'wall-jump' && !wallJumps) return null;
      return { takeoffX, horizontal, moveFrames, landedOn: player.groundedOn, landingX: player.x,
        kind, takeoffCrouch: crouch, landingCrouch: player.crouching,
        ...(kind === 'jump' ? {} : { steps }), ...(wallJumps ? { wallJumps } : {}) };
    }
    if (player.footY > world.height + world.characterHeight) return null;
  }
  return null;
}

function clearAt(world: World, platform: Platform, x: number, crouch = false): boolean {
  return canOccupy(world, x, surfaceY(platform, x, world), crouch, platform.id);
}

function* buildJumpGraph(world: World, sourceIds?: readonly number[]): Generator<void, Map<number, JumpRecipe[]>> {
  const graph = new Map<number, JumpRecipe[]>();
  const margin = playerWidth(world) / 2 + 1;
  const selected = sourceIds ? new Set(sourceIds) : null;
  const eligible = world.platforms.filter(platform => (!selected || selected.has(platform.id)) &&
    platform.right - platform.left >= playerWidth(world) + 2)
    .sort((a, b) => (b.right - b.left) - (a.right - a.left));
  const wide = eligible.filter(platform => platform.right - platform.left >= world.characterHeight * 1.5);
  const small = eligible.filter(platform => platform.right - platform.left < world.characterHeight * 1.5);
  const spread = (items: Platform[], count: number): Platform[] => items.length <= count ? items :
    Array.from({ length: count }, (_, i) => items[Math.floor(i * items.length / count)]!);
  const chosen = selected ? eligible.slice(0, 48) :
    [...wide.filter(platform => platform.generated === 'gap'), ...wide.slice(0, 32), ...spread(small, 16)];
  const sources = [...new Set([...chosen, ...eligible])].slice(0, 48);
  const budget = { remaining: 600000 };
  for (const source of sources) {
    if (budget.remaining <= 0) break;
    const reach = movementSpeed(world) * 3;
    // A jump's head rises by less than 5 character heights. Keep a conservative
    // extra height so nearby curved outlines remain in the simulation.
    const minY = source.top - world.characterHeight * 20;
    const nearby = (item: { left: number; right: number }): boolean =>
      item.right > source.left - reach && item.left < source.right + reach;
    const relevantShapes = world.shapes?.filter(shape => nearby(shape) && shape.bottom >= minY);
    const shapeIds = new Set(relevantShapes?.map(shape => shape.id));
    const relevantSegments = world.segments?.filter(segment =>
      Math.max(segment.x1, segment.x2) > source.left - reach &&
      Math.min(segment.x1, segment.x2) < source.right + reach && Math.max(segment.y1, segment.y2) >= minY);
    const segmentIds = new Set(relevantSegments?.map(segment => segment.id));
    const local: World = { ...world,
      platforms: world.platforms.filter(platform => nearby(platform) &&
        (platform.segmentId !== undefined ? segmentIds.has(platform.segmentId) :
          platform.shapeId !== undefined ? shapeIds.has(platform.shapeId) : platform.top >= minY)),
      shapes: relevantShapes, segments: relevantSegments,
      walls: world.walls?.filter(wall => wall.x > source.left - reach &&
        wall.x < source.right + reach && wall.bottom >= minY) };
    const ordinaryReach = movementSpeed(world) * 1.15;
    const ordinaryMinY = source.top - world.characterHeight * 6;
    const ordinaryShapes = local.shapes?.filter(shape => shape.right > source.left - ordinaryReach &&
      shape.left < source.right + ordinaryReach && shape.bottom >= ordinaryMinY);
    const ordinaryShapeIds = new Set(ordinaryShapes?.map(shape => shape.id));
    const ordinarySegments = local.segments?.filter(edge => Math.max(edge.x1, edge.x2) > source.left - ordinaryReach &&
      Math.min(edge.x1, edge.x2) < source.right + ordinaryReach && Math.max(edge.y1, edge.y2) >= ordinaryMinY);
    const ordinarySegmentIds = new Set(ordinarySegments?.map(edge => edge.id));
    const ordinary: World = { ...local, shapes: ordinaryShapes, segments: ordinarySegments,
      platforms: local.platforms.filter(platform => platform.right > source.left - ordinaryReach &&
        platform.left < source.right + ordinaryReach && (platform.segmentId !== undefined ?
          ordinarySegmentIds.has(platform.segmentId) : platform.shapeId !== undefined ?
          ordinaryShapeIds.has(platform.shapeId) : platform.top >= ordinaryMinY)),
      walls: local.walls?.filter(wall => wall.x > source.left - ordinaryReach &&
        wall.x < source.right + ordinaryReach && wall.bottom >= ordinaryMinY) };
    const found = new Map<number, JumpRecipe>();
    const quality = (recipe: JumpRecipe): number => {
      const target = world.platforms.find(platform => platform.id === recipe.landedOn)!;
      const landingMargin = Math.min(recipe.landingX - target.left, target.right - recipe.landingX);
      const launchMargin = Math.min(recipe.takeoffX - source.left, source.right - recipe.takeoffX);
      return landingMargin * 2 + launchMargin * .1 - (recipe.wallJumps ?? 0) * world.characterHeight;
    };
    const retain = (recipe: JumpRecipe | null): void => {
      if (!recipe) return;
      const previous = found.get(recipe.landedOn);
      if (previous?.kind !== 'wall-jump' && recipe.kind === 'wall-jump' && previous) return;
      if (!previous || (previous.kind === 'wall-jump' && recipe.kind !== 'wall-jump') ||
        quality(recipe) > quality(previous)) found.set(recipe.landedOn, recipe);
    };
    const left = source.left + margin;
    const right = source.right - margin;
    if (right < left) continue;
    const samples = source.right - source.left >= world.characterHeight * 1.5 ? 6 : 2;
    for (let sample = 0; sample <= samples && budget.remaining > 0; sample += 1) {
      const x = left + (right - left) * sample / samples;
      const standing = clearAt(world, source, x);
      for (const direction of [-1, 1] as const) {
        if (standing) for (let moveFrames = 3; moveFrames <= 65 && budget.remaining > 0; moveFrames += 6) {
          const recipe = sampleAction(ordinary, source, x, direction, moveFrames, 'jump', budget);
          retain(recipe);
        }
        if (standing && (local.shapes?.length || local.segments?.some(edge =>
          Math.abs(edge.y2 - edge.y1) > Math.abs(edge.x2 - edge.x1) * 2) || local.walls?.length)) {
          const recipe = sampleAction(local, source, x, direction, 180, 'wall-jump', budget);
          retain(recipe);
        }
        for (const kind of ['walk', 'crouch'] as const) {
          if (!clearAt(world, source, x, kind === 'crouch')) continue;
          const recipe = sampleAction(local, source, x, direction, 110, kind, budget);
          retain(recipe);
        }
      }
      yield;
    }
    graph.set(source.id, [...found.values()]);
  }
  return graph;
}

export function reachableJumps(world: World, sourceIds?: readonly number[]): Map<number, JumpRecipe[]> {
  const iterator = buildJumpGraph(world, sourceIds);
  let next = iterator.next();
  while (!next.done) next = iterator.next();
  return next.value;
}

export async function reachableJumpsAsync(world: World, sourceIds?: readonly number[],
  signal?: AbortSignal): Promise<Map<number, JumpRecipe[]>> {
  throwIfAborted(signal);
  const iterator = buildJumpGraph(world, sourceIds);
  let batchStart = performance.now();
  let next = iterator.next();
  while (!next.done) {
    throwIfAborted(signal);
    if (performance.now() - batchStart >= 8) { await yieldToBrowser(signal); batchStart = performance.now(); }
    next = iterator.next();
  }
  return next.value;
}

export function chooseLevel(world: World, options: SelectionOptions | number = {}): Level | null {
  if (world.width < 640 || world.height < 480 || world.platforms.length === 0) return null;
  const settings = typeof options === 'number' ? {} : options;
  const graph = settings.graph ?? reachableJumps(world, settings.jumpSources);
  const byId = new Map(world.platforms.map(platform => [platform.id, platform]));
  const candidates: { level: Level; score: number }[] = [];

  const pointOn = (platform: Platform, position: number): number => {
    const width = platform.right - platform.left;
    const inset = Math.min(width / 2, Math.max(playerWidth(world) / 2,
      Math.min(world.characterHeight, width / 4)));
    return platform.left + inset + (platform.right - platform.left - inset * 2) * position;
  };

  const walkClear = (platform: Platform, from: number, to: number): boolean => {
    const steps = Math.ceil(Math.abs(to - from) / (world.characterHeight * .25));
    for (let i = 0; i <= steps; i++) {
      if (!clearAt(world, platform, from + (to - from) * i / Math.max(1, steps), true)) return false;
    }
    return true;
  };
  let expanded = 0;
  for (const startId of graph.keys()) {
    const start = byId.get(startId)!;
    const paths = new Map<number, { route: number[]; recipes: JumpRecipe[] }>([[start.id, { route: [start.id], recipes: [] }]]);
    const queue = [start.id];
    for (let cursor = 0; cursor < queue.length && expanded < 4000; cursor++) {
      expanded++;
      const from = byId.get(queue[cursor]!)!;
      const path = paths.get(from.id)!;
      for (const recipe of graph.get(from.id) ?? []) {
        const goal = byId.get(recipe.landedOn);
        if (!goal || path.route.includes(goal.id) || !clearAt(world, from, recipe.takeoffX, recipe.takeoffCrouch) ||
          !clearAt(world, goal, recipe.landingX, recipe.landingCrouch)) continue;
        if (path.recipes.length && !walkClear(from, path.recipes.at(-1)!.landingX, recipe.takeoffX)) continue;
        const existing = paths.get(goal.id);
        if (!existing || path.recipes.length + 1 > existing.recipes.length) {
          paths.set(goal.id, {
            route: [...path.route, goal.id],
            recipes: [...path.recipes, recipe],
          });
          queue.push(goal.id);
        }
      }
    }
    for (const [goalId, path] of paths) {
      if (path.recipes.length === 0) continue;
      const goal = byId.get(goalId)!;
      const horizontalProgress = Math.abs((goal.left + goal.right - start.left - start.right) / 2);
      const safeMargin = Math.min(...path.recipes.map(recipe => {
        const target = byId.get(recipe.landedOn)!;
        return Math.max(0, Math.min(recipe.landingX - target.left, target.right - recipe.landingX) - playerWidth(world) / 2);
      }));
      const score = path.recipes.reduce((n, recipe) => n +
        (recipe.kind === 'walk' ? 1000 : recipe.kind === 'crouch' ? 6000 : 10000), 0) + horizontalProgress * 1.5 +
        Math.min(2500, safeMargin * 20) + (start.top - goal.top) * 0.15 -
        Math.abs(start.top - world.height * 0.68) * 1.5 -
        (start.tier === 'text' ? 200 : 0) - (goal.tier === 'text' ? 100 : 0);
      candidates.push({
        level: {
          world, startId: start.id, goalId, route: path.route, recipes: path.recipes,
          startX: pointOn(start, 0.5), goalX: pointOn(goal, 0.5),
        },
        score,
      });
    }
  }

  // A broad page surface is still a real, fully playable walking route.
  for (const platform of world.platforms) {
    if (platform.kind === 'helper') continue;
    if (platform.right - platform.left < Math.max(110, world.characterHeight * 5)) continue;
    candidates.push({
      level: {
        world, startId: platform.id, goalId: platform.id,
        startX: pointOn(platform, 0.12), goalX: pointOn(platform, 0.88),
        route: [platform.id], recipes: [],
      },
      score: 1000 + (platform.right - platform.left) -
        Math.abs(platform.top - world.height * 0.68) * 1.5 -
        (platform.tier === 'text' ? 200 : 0),
    });
  }

  const eligible = settings.requiredPlatform === undefined ? candidates :
    candidates.filter(candidate => candidate.level.route.includes(settings.requiredPlatform!) &&
      candidate.level.recipes.length > 0);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.score - a.score);
  const random = settings.random ?? randomUnit;
  const recent = settings.recent ?? [];
  const minDistance = settings.relaxed ? world.characterHeight * 2 :
    Math.max(world.characterHeight * 7, Math.min(260, world.width * .2));
  let best: Level | null = null;
  let bestNovelty = -Infinity;
  // Validate the fixed walks between consecutive jump recipes once. A longer
  // path may contain a wall on an intermediate platform, so endpoint sampling
  // cannot rescue it and must be allowed to try shorter page-only routes.
  const viable = eligible.filter(({ level }) => {
    const start = byId.get(level.startId)!;
    const goal = byId.get(level.goalId)!;
    if (start.blink || goal.blink) return false;
    const possibleSeparation = Math.max(...[0, 1].flatMap(a => [0, 1].map(b =>
      Math.hypot(pointOn(start, a) - pointOn(goal, b),
        surfaceY(start, pointOn(start, a), world) - surfaceY(goal, pointOn(goal, b), world)))));
    if (possibleSeparation < minDistance) return false;
    if (!level.recipes.length) {
      const platform = byId.get(level.startId)!;
      const inset = Math.min(world.characterHeight, (platform.right - platform.left) / 4);
      return platform.right - platform.left - inset * 2 >= minDistance;
    }
    for (let i = 0; i < level.recipes.length; i++) {
      const recipe = level.recipes[i]!;
      const from = byId.get(level.route[i]!)!;
      const to = byId.get(recipe.landedOn)!;
      if (!clearAt(world, from, recipe.takeoffX, recipe.takeoffCrouch) ||
        !clearAt(world, to, recipe.landingX, recipe.landingCrouch)) return false;
      if (i && !walkClear(from, level.recipes[i - 1]!.landingX, recipe.takeoffX)) return false;
    }
    return true;
  });
  if (!viable.length) return null;
  const topScore = viable[0]!.score;
  const pools = [
    viable.filter(candidate => candidate.score >= topScore - 2500),
    viable.filter(candidate => candidate.score < topScore - 2500 && candidate.level.recipes.length > 0),
    viable.filter(candidate => candidate.score < topScore - 2500 && candidate.level.recipes.length === 0),
  ];
  for (const pool of pools) {
    if (!pool.length) continue;
    // Each stage has a bounded budget; the last stage can select a valid broad
    // page surface even when every more complex route fails its endpoint walk.
    const offset = Math.min(pool.length - 1, Math.floor(random() ** 1.6 * pool.length));
    const attempts = Math.min(160, Math.max(48, pool.length * 2));
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidate = pool[(offset + attempt) % pool.length]!.level;
      const start = byId.get(candidate.startId)!;
      const goal = byId.get(candidate.goalId)!;
      const selected = { ...candidate, startX: pointOn(start, random()), goalX: pointOn(goal, random()) };
      if (!clearAt(world, start, selected.startX) || !clearAt(world, goal, selected.goalX)) continue;
      const underControls = (platform: Platform, x: number): boolean =>
        x > world.width - 520 && surfaceY(platform, x, world) < 145;
      if (underControls(start, selected.startX) || underControls(goal, selected.goalX)) continue;
      const firstJump = selected.recipes[0];
      if (firstJump && !walkClear(start, selected.startX, firstJump.takeoffX)) continue;
      const finalX = selected.recipes.at(-1)?.landingX ?? selected.startX;
      if (!walkClear(goal, finalX, selected.goalX)) continue;
      const pair = endpointPair(selected);
      if (Math.hypot(pair.startX - pair.goalX, pair.startY - pair.goalY) < minDistance) continue;
      const novelty = recent.length ? Math.min(...recent.map(old =>
        Math.hypot(pair.startX - old.startX, pair.startY - old.startY) +
        Math.hypot(pair.goalX - old.goalX, pair.goalY - old.goalY))) : Infinity;
      if (novelty > bestNovelty) { best = selected; bestNovelty = novelty; }
      if (novelty >= world.characterHeight * 3) return selected;
    }
  }
  return bestNovelty > 2 ? best : null;
}

function* routeMeasurements(level: Level, graph?: Map<number, JumpRecipe[]>): Generator<void, RouteMetrics> {
  const world = level.world;
  const metrics: RouteMetrics = {
    jumpCount: level.recipes.filter(recipe => !recipe.kind || recipe.kind === 'jump' || recipe.kind === 'wall-jump').length,
    wallJumpCount: level.recipes.reduce((n, recipe) => n + (recipe.wallJumps ?? 0), 0),
    crouchCount: level.recipes.filter(recipe => recipe.kind === 'crouch').length,
    branchCount: level.route.filter(id => (graph?.get(id)?.length ?? 0) > 1).length,
    minLandingMargin: null, toleranceRatio: null, testedVariants: 0, successfulVariants: 0,
    estimatedSeconds: 0,
  };
  let fromX = level.startX;
  for (let index = 0; index < level.recipes.length; index++) {
    const recipe = level.recipes[index]!;
    const source = world.platforms.find(platform => platform.id === level.route[index])!;
    const target = world.platforms.find(platform => platform.id === recipe.landedOn)!;
    const margin = Math.max(0, Math.min(recipe.landingX - target.left,
      target.right - recipe.landingX) - playerWidth(world) / 2);
    metrics.minLandingMargin = Math.min(metrics.minLandingMargin ?? Infinity, margin);
    metrics.estimatedSeconds += Math.abs(fromX - recipe.takeoffX) / (movementSpeed(world) * .5);
    let baselineFrames = recipe.steps?.length ?? 110;
    for (const dx of [-world.characterHeight * .12, 0, world.characterHeight * .12]) {
      for (const timing of [-2, 0, 2]) {
        metrics.testedVariants++;
        const x = recipe.takeoffX + dx;
        if (x < source.left + playerWidth(world) / 2 || x > source.right - playerWidth(world) / 2 ||
          !clearAt(world, source, x, recipe.takeoffCrouch)) continue;
        let player = spawnPlayer(source, world, x, recipe.takeoffCrouch);
        for (let frame = 0; frame < (recipe.steps?.length ?? 110) + 8; frame++) {
          player = stepPlayer(player, recipeControl(recipe, frame, timing), world);
          if (player.groundedOn !== null && player.groundedOn !== source.id) {
            if (player.groundedOn === recipe.landedOn) metrics.successfulVariants++;
            if (!dx && !timing) baselineFrames = frame + 1;
            break;
          }
          if (player.footY > world.height + world.characterHeight) break;
        }
      }
      yield;
    }
    metrics.estimatedSeconds += baselineFrames * STEP_SECONDS;
    fromX = recipe.landingX;
  }
  metrics.estimatedSeconds += Math.abs(level.goalX - fromX) / (movementSpeed(world) * .5);
  metrics.toleranceRatio = metrics.testedVariants ? metrics.successfulVariants / metrics.testedVariants : null;
  return metrics;
}

export function assessRoute(level: Level, graph?: Map<number, JumpRecipe[]>): RouteMetrics {
  const iterator = routeMeasurements(level, graph);
  let next = iterator.next();
  while (!next.done) next = iterator.next();
  return next.value;
}

export async function assessRouteAsync(level: Level, graph?: Map<number, JumpRecipe[]>,
  signal?: AbortSignal): Promise<RouteMetrics> {
  throwIfAborted(signal);
  const iterator = routeMeasurements(level, graph);
  let batch = performance.now();
  let next = iterator.next();
  while (!next.done) {
    throwIfAborted(signal);
    if (performance.now() - batch >= 8) { await yieldToBrowser(signal); batch = performance.now(); }
    next = iterator.next();
  }
  return next.value;
}
