import { canOccupy, movementSpeed, playerWidth, spawnPlayer, stepPlayer, STEP_SECONDS } from './physics.js';
import { surfaceY } from './geometry.js';
import { recipeControl, randomUnit } from './planner.js';
import { hitsPatrol, patrolPosition, safeFromPatrols } from './hazards.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';
import type { Controls, JumpRecipe, Patrol, Platform, Player, RewardTarget, World } from './types.js';

interface RewardOptions {
  patrols?: readonly Patrol[];
  time?: number;
  recent?: readonly { x: number; footY: number }[];
  random?: () => number;
}
interface Trial { player: Player; actions: Controls[]; time: number;
  jumpCount: number; wallJumpCount: number; crouchCount: number; hazardHit: boolean }
interface Budget { remaining: number }

export function rewardDistance(world: World): number {
  return Math.max(world.characterHeight * 7, Math.min(260, world.width * .2));
}

function advance(trial: Trial, input: Controls, world: World,
  patrols: readonly Patrol[], budget: Budget): boolean {
  if (--budget.remaining < 0) return false;
  const next = stepPlayer(trial.player, input, world);
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
  for (let frame = 0; frame < maxFrames; frame++) {
    const delta = targetX - trial.player.x;
    const precise = Math.abs(delta) < size;
    if (trial.player.groundedOn === platform.id &&
      Math.abs(delta) <= movementSpeed(world) * .5 * STEP_SECONDS * .55) return true;
    const horizontal: -1 | 0 | 1 = Math.abs(delta) <= movementSpeed(world) * .5 * STEP_SECONDS * .55 ? 0 : delta > 0 ? 1 : -1;
    const proposed = trial.player.x + horizontal * movementSpeed(world) * STEP_SECONDS;
    let crouch = precise || !canOccupy(world, proposed, surfaceY(platform, proposed, world), false, platform.id);
    let jump = false;
    if (trial.player.groundedOn !== null) {
      jump = patrols.some(patrol => {
        const point = patrolPosition(patrol, trial.time + STEP_SECONDS);
        return Math.abs(point.y + patrol.radius - trial.player.footY) < size &&
          Math.abs(point.x - trial.player.x) < size * 2 &&
          (horizontal === 0 || (point.x - trial.player.x) * horizontal >= -size * .4);
      });
      if (jump) crouch = false;
    }
    if (trial.player.groundedOn === null) crouch = false;
    if (!advance(trial, { horizontal, jump, crouch }, world, patrols, budget)) return false;
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
  for (const delay of patrols.length ? [0, 15, 30, 60, 90] : [0]) {
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
    if (!attempt.hazardHit) return false;
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
  const bestDepth = new Map<number, number>([[start.id, 0]]);
  for (let cursor = 0; cursor < paths.length && cursor < 128 && paths.length < 256; cursor++) {
    const path = paths[cursor]!;
    for (const recipe of graph.get(path.route.at(-1)!) ?? []) {
      if (!byId.has(recipe.landedOn) || path.route.includes(recipe.landedOn)) continue;
      if ((bestDepth.get(recipe.landedOn) ?? -1) >= path.recipes.length + 1) continue;
      bestDepth.set(recipe.landedOn, path.recipes.length + 1);
      paths.push({ route: [...path.route, recipe.landedOn], recipes: [...path.recipes, recipe] });
    }
  }
  const candidates: { path: typeof paths[number]; platform: Platform; x: number; footY: number; score: number }[] = [];
  for (const path of paths) {
    const platform = byId.get(path.route.at(-1)!)!;
    const margin = playerWidth(world) / 2 + 1;
    const width = platform.right - platform.left - margin * 2;
    if (width < 0) continue;
    for (const fraction of [.08 + random() * .08, .42 + random() * .16,
      .84 + random() * .08, random(), random(), random()]) {
      const x = platform.left + margin + width * fraction, footY = surfaceY(platform, x, world);
      const distance = Math.hypot(x - from.x, footY - from.footY);
      if (distance < rewardDistance(world) || !canOccupy(world, x, footY, false, platform.id) ||
        !safeFromPatrols(world, patrols, x, footY) || (x > world.width - 420 && footY < 145)) continue;
      const novelty = Math.min(world.characterHeight * 12, ...(options.recent ?? []).map(old =>
        Math.hypot(x - old.x, footY - old.footY)));
      const actions = path.recipes.reduce((sum, recipe) => sum +
        (recipe.kind === 'walk' ? .25 : recipe.kind === 'crouch' ? 1.5 : 2), 0);
      const continuation = (graph.get(platform.id)?.length ?? 0) > 0 || width >= rewardDistance(world) * 1.5;
      candidates.push({ path, platform, x, footY,
        score: actions * world.characterHeight * 5 + distance * .3 + novelty * 2 +
          (continuation ? world.characterHeight * 8 : 0) + random() * world.characterHeight * 5 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const complex = candidates.filter(candidate => candidate.path.recipes.length > 0).slice(0, 16);
  const walking = candidates.filter(candidate => candidate.path.recipes.length === 0).slice(0, 16);
  const complexBudget = { remaining: 16000 }, walkingBudget = { remaining: 8000 };
  for (const candidate of [...complex, ...walking]) {
    const budget = candidate.path.recipes.length ? complexBudget : walkingBudget;
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
    if (valid && (yield* walkTo(trial, candidate.platform, candidate.x, world, patrols, budget))) {
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

export class CollectionSession {
  score = 0;
  target: RewardTarget | null = null;
  checkpoint: Player | null = null;
  readonly recent: { x: number; footY: number }[] = [];

  begin(world: World, start: Platform, x: number): void {
    this.checkpoint = spawnPlayer(start, world, x);
    this.target = null;
    this.recent.length = 0;
  }

  collect(player: Player, world: World): boolean {
    const target = this.target;
    if (!target || player.groundedOn !== target.platformId ||
      Math.abs(player.x - target.x) > world.characterHeight * .65) return false;
    const platform = world.platforms.find(item => item.id === target.platformId);
    if (!platform || !canOccupy(world, player.x, player.footY, Boolean(player.crouching), platform.id)) return false;
    this.score++;
    // Preserve the actual supported position; clamping it on a tiny icon can
    // move the checkpoint to the other side of nearby geometry.
    this.checkpoint = { ...player, velocityY: 0, coyoteTime: 0, jumpBufferTime: 0,
      wallSide: 0, wallJumpTime: 0, wallJumpDirection: 0, event: undefined };
    this.recent.push({ x: target.x, footY: target.footY });
    if (this.recent.length > 12) this.recent.shift();
    this.target = null;
    return true;
  }

  respawn(): Player | null { return this.checkpoint ? { ...this.checkpoint } : null; }
}
