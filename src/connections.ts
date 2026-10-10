import { canOccupy, movementSpeed, playerWidth, spawnPlayer, stepPlayer, STEP_SECONDS } from './physics.js';
import { surfaceY } from './geometry.js';
import { clonePlatformWorld, temporary } from './platform-state.js';
import { regionId, regionPoints, reservedPoint } from './regions.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';
import type { Controls, JumpRecipe, Platform, World } from './types.js';

export function helperLimit(world: World): number { return world.width >= 1600 ? 6 : 4; }

function walkClear(world: World, platform: Platform, from: number, to: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / (world.characterHeight * .25)));
  for (let i = 0; i <= steps; i++) {
    const x = from + (to - from) * i / steps;
    if (!canOccupy(world, x, surfaceY(platform, x, world), true, platform.id)) return false;
  }
  return true;
}

/** Real ordinary jump/drop connection. Yields within attempts, not only between them. */
export function* findConnection(world: World, source: Platform, target: Platform): Generator<void, JumpRecipe | null> {
  const margin = playerWidth(world) / 2 + 1;
  const left = source.left + margin, right = source.right - margin;
  if (right < left) return null;
  const targetX = Math.max(target.left + margin, Math.min(target.right - margin, (source.left + source.right) / 2));
  const nearest = Math.max(left, Math.min(right, targetX));
  // Raised solid ledges must be approached from outside their underside.
  const approaches = [2, 3, 4].flatMap(h => [target.left - world.characterHeight * h,
    target.right + world.characterHeight * h]).map(x => Math.max(left, Math.min(right, x)));
  for (const x of [...new Set([nearest, ...approaches, left, right, (left + right) / 2])]) {
    if (!canOccupy(world, x, surfaceY(source, x, world), false, source.id)) continue;
    const direction = targetX >= x ? 1 : -1;
    const duration = Math.round(Math.abs(targetX - x) / (movementSpeed(world) * STEP_SECONDS));
    for (const moveFrames of [duration, duration - 5, duration + 5, duration + 12, duration + 24]) {
      if (moveFrames < 0 || moveFrames > 80) continue;
      for (const jump of target.top > source.top ? [true, false] : [true]) {
        const trial = clonePlatformWorld(world), steps: Controls[] = [];
        let body = spawnPlayer(source, trial, x);
        const half = playerWidth(world) / 2;
        const bounds = { left: body.x - half, right: body.x + half, top: body.footY - world.characterHeight, bottom: body.footY };
        for (let frame = 0; frame < 110; frame++) {
          const input: Controls = { horizontal: frame < moveFrames ? direction : 0, jump: frame === 0 && jump };
          steps.push(input); body = stepPlayer(body, input, trial, STEP_SECONDS, frame * STEP_SECONDS);
          bounds.left = Math.min(bounds.left, body.x - half); bounds.right = Math.max(bounds.right, body.x + half);
          bounds.top = Math.min(bounds.top, body.footY - world.characterHeight); bounds.bottom = Math.max(bounds.bottom, body.footY);
          if (body.groundedOn !== null && body.groundedOn !== source.id) {
            if (body.groundedOn === target.id && canOccupy(trial, body.x, body.footY, false, target.id))
              return { takeoffX: x, horizontal: direction, moveFrames, landedOn: target.id,
                landingX: body.x, kind: jump ? 'jump' : 'walk', steps, bounds };
            break;
          }
          if ((frame > 1 && body.groundedOn === source.id && jump) || body.footY > trial.height) break;
          if (frame % 24 === 23) yield;
        }
        yield;
      }
    }
  }
  return null;
}

function* twoWay(world: World, a: Platform, b: Platform): Generator<void, [JumpRecipe, JumpRecipe] | null> {
  const forward = yield* findConnection(world, a, b);
  if (!forward) return null;
  const back = yield* findConnection(world, b, a);
  return back && walkClear(world, b, forward.landingX, back.takeoffX) &&
    walkClear(world, a, back.landingX, forward.takeoffX) ? [forward, back] : null;
}

export function permanentComponent(graph: Map<number, JumpRecipe[]>, root: number, world: World): Set<number> {
  const permanent = new Set(world.platforms.filter(platform => !temporary(platform)).map(platform => platform.id));
  const visit = (reverse: boolean): Set<number> => {
    const seen = new Set([root]), queue = [root];
    const edges = new Map<number, number[]>();
    for (const [from, recipes] of graph) for (const recipe of recipes) {
      if (!permanent.has(from) || !permanent.has(recipe.landedOn)) continue;
      const a = reverse ? recipe.landedOn : from, b = reverse ? from : recipe.landedOn;
      const links = edges.get(a) ?? []; links.push(b); edges.set(a, links);
    }
    for (let i = 0; i < queue.length; i++) for (const next of edges.get(queue[i]!) ?? [])
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    return seen;
  };
  const forward = visit(false), back = visit(true);
  return new Set([...forward].filter(id => back.has(id)));
}

/** Landing clearance, not an empty 4.5H rectangle around an entire jump. */
export function vacantLedge(world: World, ledge: Platform): boolean {
  const size = world.characterHeight;
  if (ledge.left < 8 || ledge.right > world.width - 8 || ledge.top < size * 1.2 || ledge.top > world.height - size) return false;
  const center = (ledge.left + ledge.right) / 2;
  if (reservedPoint(world, center, ledge.top)) return false;
  if (world.platforms.some(other => Math.abs(other.top - ledge.top) < size * .7 &&
    other.right > ledge.left - size * .4 && other.left < ledge.right + size * .4)) return false;
  return [ledge.left + playerWidth(world), center, ledge.right - playerWidth(world)].every(x =>
    canOccupy(world, x, ledge.top - .1, false) && canOccupy(world, x, ledge.top + size * .2, true));
}

/** Expand the permanent region backbone before spending the budget on local challenges. */
function* repair(source: World, inputGraph: Map<number, JumpRecipe[]>): Generator<void, { world: World; graph: Map<number, JumpRecipe[]> }> {
  let world = source;
  const graph = new Map([...inputGraph].map(([id, links]) => [id, [...links]]));
  const points = regionPoints(world, () => .5, 16);
  if (!points.length) return { world, graph };
  let root = points[0]!.platform.id, best = -1;
  for (const id of [...new Set(points.map(point => point.platform.id))]) {
    const connected = permanentComponent(graph, id, world);
    const score = new Set(points.filter(point => connected.has(point.platform.id)).map(point => point.regionId)).size * 100 + connected.size;
    if (score > best) { root = id; best = score; }
  }
  let attempts = 0;
  while (attempts < 36) {
    const main = permanentComponent(graph, root, world);
    const covered = new Set(points.filter(point => main.has(point.platform.id)).map(point => point.regionId));
    const pairs = points.filter(point => main.has(point.platform.id)).flatMap(a =>
      points.filter(b => !covered.has(b.regionId) && !main.has(b.platform.id)).map(b => ({ a, b,
        cost: Math.abs(a.x - b.x) / (world.characterHeight * 4.5) + Math.abs(a.footY - b.footY) / (world.characterHeight * 2.5) })))
      .sort((a, b) => a.cost - b.cost);
    if (!pairs.length) break;
    let improved = false;
    const tried = new Set<string>();
    for (const { a, b } of pairs) {
      const key = `${a.platform.id}:${b.platform.id}`;
      if (tried.has(key)) continue; tried.add(key);
      if (++attempts > 36) break;
      const direct = yield* twoWay(world, a.platform, b.platform);
      if (direct) {
        graph.set(a.platform.id, [...graph.get(a.platform.id) ?? [], direct[0]]);
        graph.set(b.platform.id, [...graph.get(b.platform.id) ?? [], direct[1]]);
        improved = true; break;
      }
      const margin = playerWidth(world) / 2 + 2;
      let ax = Math.max(a.platform.left + margin, Math.min(a.platform.right - margin, b.x));
      let bx = Math.max(b.platform.left + margin, Math.min(b.platform.right - margin, ax));
      if (Math.abs(bx - ax) < world.characterHeight * 3) {
        // Use the outside edge of the higher surface, not the middle of its underside.
        const higher = a.platform.top < b.platform.top ? a.platform : b.platform;
        const low = Math.max(a.platform.left, b.platform.left) + margin;
        const high = Math.min(a.platform.right, b.platform.right) - margin;
        if (low <= high) {
          const sides = [higher.left + margin, higher.right - margin].map(x => Math.max(low, Math.min(high, x)));
          const edge = sides.sort((x, y) => Math.min(x - higher.left, higher.right - x) -
            Math.min(y - higher.left, higher.right - y))[0]!;
          ax = edge; bx = edge;
        }
      }
      const ay = surfaceY(a.platform, ax, world), by = surfaceY(b.platform, bx, world);
      const parts = Math.ceil(Math.max(Math.abs(bx - ax) / (world.characterHeight * 4.5), Math.abs(by - ay) / (world.characterHeight * 2.5)));
      const count = Math.max(1, parts - 1);
      if (count > 3 || world.platforms.filter(platform => platform.generated === 'gap').length + count > helperLimit(world)) continue;
      const size = world.characterHeight;
      const patterns = Math.abs(bx - ax) < size * 3 ? [0, -1, 1, -2, 2] : [0];
      for (const { pattern, offset } of patterns.flatMap(pattern => [0, -size, size].map(offset => ({ pattern, offset })))) {
        const ledges: Platform[] = [];
        let nextId = Math.min(-1, ...world.platforms.map(platform => platform.id)) - 1;
        for (let i = 1; i <= count; i++) {
          const t = i / (count + 1);
          const stagger = pattern === 0 ? 0 : Math.sign(pattern) * size *
            (Math.abs(pattern) === 1 ? (i % 2 ? 2 : 4) : (i % 2 ? 4 : 2));
          const x = ax + (bx - ax) * t + stagger;
          const ledge: Platform = { id: nextId--, left: x - world.characterHeight * 1.3,
            right: x + world.characterHeight * 1.3, top: ay + (by - ay) * t + offset,
            kind: 'helper', tier: 'visual', generated: 'gap', bridge: true,
            anchorKeys: [a.platform.key ?? String(a.platform.id), b.platform.key ?? String(b.platform.id)], anchorMix: t,
            key: `bridge:${a.platform.key ?? a.platform.id}:${b.platform.key ?? b.platform.id}:${i}` };
          if (!vacantLedge({ ...world, platforms: [...world.platforms, ...ledges] }, ledge)) break;
          ledges.push(ledge);
        }
        if (ledges.length !== count) continue;
        const candidate: World = { ...world, platforms: [...world.platforms, ...ledges] };
        const chain = [a.platform, ...ledges, b.platform], recipes: [number, JumpRecipe][] = [];
        let valid = true;
        for (let i = 1; i < chain.length; i++) {
          const links = yield* twoWay(candidate, chain[i - 1]!, chain[i]!);
          if (!links) { valid = false; break; }
          recipes.push([chain[i - 1]!.id, links[0]], [chain[i]!.id, links[1]]);
        }
        if (!valid) continue;
        // Landing and next takeoff on every intermediate must also be walkable.
        for (let i = 1; i < chain.length - 1; i++) {
          const incoming = recipes[(i - 1) * 2]![1], outgoing = recipes[i * 2]![1];
          const returnIn = recipes[i * 2 + 1]![1], returnOut = recipes[(i - 1) * 2 + 1]![1];
          if (!walkClear(candidate, chain[i]!, incoming.landingX, outgoing.takeoffX) ||
            !walkClear(candidate, chain[i]!, returnIn.landingX, returnOut.takeoffX)) valid = false;
        }
        if (!valid) continue;
        world = candidate;
        for (const [id, recipe] of recipes) graph.set(id, [...graph.get(id) ?? [], recipe]);
        improved = true; break;
      }
      if (improved) break;
      yield;
    }
    if (!improved) break;
  }
  return { world, graph };
}

export function connectRegions(world: World, graph: Map<number, JumpRecipe[]>): { world: World; graph: Map<number, JumpRecipe[]> } {
  const iterator = repair(world, graph); let next = iterator.next();
  while (!next.done) next = iterator.next(); return next.value;
}
export async function connectRegionsAsync(world: World, graph: Map<number, JumpRecipe[]>, signal?: AbortSignal): Promise<{ world: World; graph: Map<number, JumpRecipe[]> }> {
  throwIfAborted(signal);
  const iterator = repair(world, graph); let next = iterator.next(), batch = performance.now();
  while (!next.done) {
    throwIfAborted(signal);
    if (performance.now() - batch >= 4) { await yieldToBrowser(signal); batch = performance.now(); }
    next = iterator.next();
  }
  return next.value;
}
