import { canOccupy, movementSpeed, playerWidth, spawnPlayer, stepPlayer, STEP_SECONDS } from './physics.js';
import { surfaceY } from './geometry.js';
import { recipeControl, randomUnit, reachableJumpsAsync } from './planner.js';
import { hitsPatrol, patrolPosition } from './hazards.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';
import type { Controls, JumpRecipe, Patrol, Platform, Player, RewardTarget, World } from './types.js';
import { platformIsActive } from './platform-state.js';

interface RewardOptions {
  patrols?: readonly Patrol[];
  time?: number;
  recent?: readonly { x: number; footY: number; platformId?: number }[];
  random?: () => number;
}
interface Trial { player: Player; actions: Controls[]; time: number;
  jumpCount: number; wallJumpCount: number; crouchCount: number; hazardHit: boolean }
interface Budget { remaining: number }

export function rewardDistance(world: World): number {
  return Math.max(world.characterHeight * 4, Math.min(180, world.width * .15));
}

function advance(trial: Trial, input: Controls, world: World,
  patrols: readonly Patrol[], budget: Budget): boolean {
  if (--budget.remaining < 0) return false;
  const next = stepPlayer(trial.player, input, world, STEP_SECONDS, trial.time);
  if (hitsPatrol(trial.player, next, world, patrols, trial.time, trial.time + STEP_SECONDS)) {
    trial.hazardHit = true;
    return false;
  }
  if (next.event === 'jump') trial.jumpCount++;
  if (next.event === 'wall-jump') trial.wallJumpCount++;
  if (next.crouching && !trial.player.crouching) trial.crouchCount++;
  trial.player = next;
  trial.actions.push(input);
  trial.time += STEP_SECONDS;
  return next.footY <= world.height + world.characterHeight;
}

function* walkTo(trial: Trial, platform: Platform, targetX: number, world: World,
  patrols: readonly Patrol[], budget: Budget): Generator<void, boolean> {
  const size = world.characterHeight;
  const maxFrames = Math.ceil(world.width / (movementSpeed(world) * .5 * STEP_SECONDS)) + 120;
  let stuck = 0;
  for (let frame = 0; frame < maxFrames; frame++) {
    const delta = targetX - trial.player.x;
    const precise = Math.abs(delta) < size;
    if (trial.player.groundedOn === platform.id &&
      Math.abs(delta) <= movementSpeed(world) * .5 * STEP_SECONDS * .55) return true;
    const horizontal: -1 | 0 | 1 = Math.abs(delta) <= movementSpeed(world) * .5 * STEP_SECONDS * .55 ? 0 : delta > 0 ? 1 : -1;
    const proposed = trial.player.x + horizontal * movementSpeed(world) * STEP_SECONDS;
    let crouch = precise || !canOccupy(world, proposed, surfaceY(platform, proposed, world), false, platform.id, trial.time);
    let jump = false;
    if (trial.player.groundedOn !== null) {
      jump = patrols.some(patrol => {
        const point = patrolPosition(patrol, trial.time + STEP_SECONDS);
        const future = patrolPosition(patrol, trial.time + .2);
        const ahead = point.x - trial.player.x;
        const approaching = (future.x - trial.player.x - horizontal * movementSpeed(world) * .2) * Math.sign(ahead);
        return Math.abs(point.y + patrol.radius - trial.player.footY) < size &&
          (Math.abs(ahead) < size * 2.4 || approaching < size * 1.5);
      });
      if (jump) crouch = false;
    }
    if (trial.player.groundedOn === null) crouch = false;
    const previousX = trial.player.x;
    if (!advance(trial, { horizontal, jump, crouch }, world, patrols, budget)) return false;
    stuck = horizontal && Math.abs(trial.player.x - previousX) < .01 ? stuck + 1 : 0;
    if (stuck > 12) return false;
    if (trial.player.groundedOn !== null && trial.player.groundedOn !== platform.id) return false;
    if (frame % 30 === 29) yield;
  }
  return false;
}

function* replay(trial: Trial, recipe: JumpRecipe, world: World,
  patrols: readonly Patrol[], budget: Budget): Generator<void, boolean> {
  const source = trial.player.groundedOn;
  for (let frame = 0; frame < (recipe.steps?.length ?? 110) + 8; frame++) {
    if (!advance(trial, recipeControl(recipe, frame), world, patrols, budget)) return false;
    if (trial.player.groundedOn !== null && trial.player.groundedOn !== source) {
      return trial.player.groundedOn === recipe.landedOn;
    }
    if (frame % 30 === 29) yield;
  }
  return false;
}

function* timedReplay(trial: Trial, recipe: JumpRecipe, world: World,
  patrols: readonly Patrol[], budget: Budget): Generator<void, boolean> {
  const timed = world.platforms.some(platform => platform.blink);
  for (const delay of patrols.length || timed ? [0, 15, 30, 60, 90, 120] : [0]) {
    const attempt: Trial = { player: { ...trial.player }, actions: [], time: trial.time,
      jumpCount: 0, wallJumpCount: 0, crouchCount: 0, hazardHit: false };
    let safe = true;
    for (let frame = 0; frame < delay; frame++) {
      if (!advance(attempt, { horizontal: 0, jump: false, crouch: Boolean(attempt.player.crouching) },
        world, patrols, budget)) { safe = false; break; }
      if (frame % 30 === 29) yield;
    }
    if (safe && (yield* replay(attempt, recipe, world, patrols, budget))) {
      trial.player = attempt.player;
      trial.actions.push(...attempt.actions);
      trial.time = attempt.time;
      trial.jumpCount += attempt.jumpCount;
      trial.wallJumpCount += attempt.wallJumpCount;
      trial.crouchCount += attempt.crouchCount;
      return true;
    }
    if (!attempt.hazardHit && !timed) return false;
    yield;
  }
  return false;
}

function* selectReward(world: World, from: Player, graph: Map<number, JumpRecipe[]>,
  options: RewardOptions): Generator<void, RewardTarget | null> {
  if (from.groundedOn === null) return null;
  const byId = new Map(world.platforms.map(platform => [platform.id, platform]));
  const start = byId.get(from.groundedOn);
  if (!start) return null;
  const random = options.random ?? randomUnit, patrols = options.patrols ?? [];
  const paths: { route: number[]; recipes: JumpRecipe[] }[] = [{ route: [start.id], recipes: [] }];
  const visits = new Map<number, number>([[start.id, 1]]);
  for (let cursor = 0; cursor < paths.length && cursor < 128 && paths.length < 256; cursor++) {
    const path = paths[cursor]!;
    for (const recipe of graph.get(path.route.at(-1)!) ?? []) {
      if (!byId.has(recipe.landedOn) || path.route.includes(recipe.landedOn)) continue;
      if ((visits.get(recipe.landedOn) ?? 0) >= 3) continue;
      visits.set(recipe.landedOn, (visits.get(recipe.landedOn) ?? 0) + 1);
      paths.push({ route: [...path.route, recipe.landedOn], recipes: [...path.recipes, recipe] });
    }
  }
  const candidates: { path: typeof paths[number]; platform: Platform; x: number; footY: number;
    score: number; stale: number }[] = [];
  const size = world.characterHeight;
  const history = options.recent ?? [];
  for (const path of paths) {
    const platform = byId.get(path.route.at(-1)!)!;
    if (platform.blink) continue; // Temporary surfaces never hold a coin or a checkpoint.
    const margin = playerWidth(world) / 2 + 1;
    const width = platform.right - platform.left - margin * 2;
    if (width < 0) continue;
    for (const fraction of [.01 + random() * .04, .08 + random() * .08, .42 + random() * .16,
      .84 + random() * .08, .95 + random() * .04, random(), random(), random()]) {
      const x = platform.left + margin + width * fraction, footY = surfaceY(platform, x, world);
      const distance = Math.hypot(x - from.x, footY - from.footY);
      if (distance < world.characterHeight * 2 ||
        (!canOccupy(world, x, footY, false, platform.id, options.time ?? 0) &&
          !canOccupy(world, x, footY, true, platform.id, options.time ?? 0)) ||
        (x > world.width - 520 && footY < 145)) continue;
      const regionRadius = Math.max(size * 3, Math.min(size * 6, width / 4));
      const visitedRegion = history.slice(-4).some(old => Math.hypot(x - old.x, footY - old.footY) < regionRadius);
      const visitedPlatform = platform.id !== start.id && history.slice(-2).some(old => old.platformId === platform.id);
      const stale = Number(visitedRegion) * 2 + Number(visitedPlatform);
      const oldVisits = history.filter(old => Math.hypot(x - old.x, footY - old.footY) < regionRadius).length;
      const actions = path.recipes.reduce((sum, recipe) => sum +
        (recipe.kind === 'walk' ? .1 : recipe.kind === 'crouch' ? 1.5 : recipe.kind === 'wall-jump' ? 2.5 : 1), 0);
      const edge = 1 - Math.min(1, Math.min(x - platform.left, platform.right - x) / (size * 2));
      const confined = !canOccupy(world, x, footY, false, platform.id, options.time ?? 0) ? 2 : width < size * 3 ? 1 : 0;
      const continuation = (graph.get(platform.id)?.length ?? 0) > 0 || width >= size * 6;
      candidates.push({ path, platform, x, footY, stale,
        score: Math.min(actions, 5) * 4 + edge * 3 + confined * 3 +
          (continuation ? 2 : 0) - oldVisits * 4 + random() * 6 });
    }
  }
  candidates.sort((a, b) => a.stale - b.stale || b.score - a.score);
  // Interleave destinations so one inaccessible branch cannot occupy the whole budget.
  const spread = (items: typeof candidates, limit: number): typeof candidates => {
    const groups = new Map<number, typeof candidates>();
    for (const item of items) {
      const group = groups.get(item.platform.id) ?? [];
      group.push(item); groups.set(item.platform.id, group);
    }
    const result: typeof candidates = [];
    for (let round = 0; result.length < limit; round++) {
      let added = false;
      for (const group of groups.values()) if (group[round] && result.length < limit) {
        result.push(group[round]!); added = true;
      }
      if (!added) break;
    }
    return result;
  };
  const ordered = [0, 1, 2, 3].flatMap(stale => spread(candidates.filter(candidate => candidate.stale === stale), stale ? 24 : 48));
  const freshBudget = { remaining: 40000 }, repeatBudget = { remaining: 16000 };
  for (const candidate of ordered) {
    const budget = candidate.stale ? repeatBudget : freshBudget;
    if (budget.remaining <= 0) continue;
    const trial: Trial = { player: { ...from, jumpBufferTime: 0, wallJumpTime: 0 },
      actions: [], time: options.time ?? 0, jumpCount: 0, wallJumpCount: 0, crouchCount: 0, hazardHit: false };
    let valid = true;
    for (let i = 0; i < candidate.path.recipes.length; i++) {
      const recipe = candidate.path.recipes[i]!;
      const platform = byId.get(candidate.path.route[i]!)!;
      if (!(yield* walkTo(trial, platform, recipe.takeoffX, world, patrols, budget)) ||
        !(yield* timedReplay(trial, recipe, world, patrols, budget))) { valid = false; break; }
    }
    if (valid && (yield* walkTo(trial, candidate.platform, candidate.x, world, patrols, budget)) &&
      platformIsActive(candidate.platform, trial.time)) {
      return { platformId: candidate.platform.id, x: candidate.x, footY: candidate.footY,
        route: candidate.path.route, actions: trial.actions, startTime: options.time ?? 0,
        jumpCount: trial.jumpCount + trial.wallJumpCount, wallJumpCount: trial.wallJumpCount,
        crouchCount: trial.crouchCount };
    }
    yield;
  }
  return null;
}

export function chooseReward(world: World, from: Player, graph: Map<number, JumpRecipe[]>,
  options: RewardOptions = {}): RewardTarget | null {
  const iterator = selectReward(world, from, graph, options);
  let next = iterator.next();
  while (!next.done) next = iterator.next();
  return next.value;
}

export async function chooseRewardAsync(world: World, from: Player, graph: Map<number, JumpRecipe[]>,
  options: RewardOptions = {}, signal?: AbortSignal): Promise<RewardTarget | null> {
  throwIfAborted(signal);
  const iterator = selectReward(world, from, graph, options);
  let next = iterator.next(), batch = performance.now();
  while (!next.done) {
    throwIfAborted(signal);
    if (performance.now() - batch >= 6) { await yieldToBrowser(signal); batch = performance.now(); }
    next = iterator.next();
  }
  return next.value;
}

/** Retry omitted connected sources before declaring the current region exhausted. */
export async function chooseRewardWithDiscoveryAsync(world: World, from: Player,
  graph: Map<number, JumpRecipe[]>, options: RewardOptions = {}, signal?: AbortSignal): Promise<RewardTarget | null> {
  let target = await chooseRewardAsync(world, from, graph, options, signal);
  for (let pass = 0; !target && pass < 3 && from.groundedOn !== null; pass++) {
    const visited = new Set<number>([from.groundedOn]), queue = [from.groundedOn];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (const recipe of graph.get(queue[cursor]!) ?? []) if (!visited.has(recipe.landedOn)) {
        visited.add(recipe.landedOn); queue.push(recipe.landedOn);
      }
    }
    const missing = world.platforms.filter(platform => visited.has(platform.id) && !graph.has(platform.id))
      .sort((a, b) => Math.hypot((a.left + a.right) / 2 - from.x, a.top - from.footY) -
        Math.hypot((b.left + b.right) / 2 - from.x, b.top - from.footY)).slice(0, 4);
    if (!missing.length) break;
    const extra = await reachableJumpsAsync(world, missing.map(platform => platform.id), signal);
    throwIfAborted(signal);
    if (!extra.size) break;
    for (const [id, recipes] of extra) graph.set(id, recipes);
    target = await chooseRewardAsync(world, from, graph, options, signal);
  }
  return target;
}

export class CollectionSession {
  score = 0;
  target: RewardTarget | null = null;
  checkpoint: Player | null = null;
  readonly recent: { x: number; footY: number; platformId: number }[] = [];

  begin(world: World, start: Platform, x: number): void {
    this.checkpoint = spawnPlayer(start, world, x);
    this.target = null;
    this.recent.length = 0;
  }

  collect(player: Player, world: World, seconds = 0): boolean {
    const target = this.target;
    if (!target || player.groundedOn !== target.platformId ||
      Math.abs(player.x - target.x) > world.characterHeight * .65) return false;
    const platform = world.platforms.find(item => item.id === target.platformId);
    if (!platform || platform.blink || !canOccupy(world, player.x, player.footY, Boolean(player.crouching), platform.id, seconds)) return false;
    this.score++;
    // Preserve the actual supported position; clamping it on a tiny icon can
    // move the checkpoint to the other side of nearby geometry.
    this.checkpoint = { ...player, velocityY: 0, coyoteTime: 0, jumpBufferTime: 0,
      wallSide: 0, wallJumpTime: 0, wallJumpDirection: 0, event: undefined };
    this.recent.push({ x: target.x, footY: target.footY, platformId: target.platformId });
    if (this.recent.length > 12) this.recent.shift();
    this.target = null;
    return true;
  }

  respawn(): Player | null { return this.checkpoint ? { ...this.checkpoint } : null; }

  penalize(): number {
    const previous = this.score;
    this.score = Math.max(0, this.score - 1);
    return previous - this.score;
  }
}
