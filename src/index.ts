import { assessRouteAsync, chooseLevel, endpointPair, reachableJumpsAsync, type EndpointPair } from './planner.js';
import { createFallbackLevelAsync } from './fallback.js';
import { canOccupy, spawnPlayer, stepPlayer, STEP_SECONDS } from './physics.js';
import { Renderer } from './renderer.js';
import { CONTOUR_BUDGET, getPageSnapshot, scanPageAsync, surfaceSignature } from './scanner.js';
import { openingCount } from './contours.js';
import type { Level, Platform, Player, ScanTiming, World } from './types.js';
import { watchPage, type PageChange } from './page-watch.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';
import { CollectionSession, chooseRewardAsync, chooseRewardWithDiscoveryAsync } from './rewards.js';
import { createPatrols, hitsPatrol, patrolPosition } from './hazards.js';
import { surfaceY } from './geometry.js';
import type { JumpRecipe, Patrol, RewardTarget } from './types.js';
import { addGapPlatformsAsync } from './playground.js';
import { connectRegionsAsync } from './connections.js';
import { distributedSources, regionId, regionPoints } from './regions.js';
import { matchingPlatform, migrateBody, migrateTarget, removeSources, retainHelpers, reuseGraph, safeBody, sameSurface } from './map-update.js';

export interface EdgekinOptions {
  root?: HTMLElement;
  onComplete?: () => void;
  mode?: 'collect' | 'course';
  hazards?: boolean;
  onCollect?: (score: number) => void;
  onScoreChange?: (score: number, reason: 'collect' | 'respawn' | 'reset') => void;
}

export interface EdgekinInstance {
  start(): Promise<void>;
  pause(): void;
  regenerate(): Promise<void>;
  restart(): void;
  destroy(): void;
  getMapStats(): MapStats | null;
  getSessionStats(): SessionStats;
}

export interface SessionStats {
  mode: 'collect' | 'course';
  state: State;
  score: number;
  elapsedSeconds: number;
  targetSelectionMs: number;
  invulnerableSeconds: number;
  checkpoint: { platformId: number | null; x: number; footY: number } | null;
  target: { platformId: number; x: number; footY: number } | null;
  player: { x: number; footY: number; groundedOn: number | null } | null;
  patrols: { x: number; y: number; radius: number }[];
  mapUpdating: boolean;
  targetPending: boolean;
  worldVersion: number;
}

export interface MapStats {
  outlineCount: number;
  smallIconCount: number;
  openedContainerCount: number;
  openingCount: number;
  standingSurfaceCount: number;
  gapPlatformCount: number;
  contourBudget: number;
  eligibleOutlineCount: number;
  omittedOutlineCount: number;
  complexityPercent: number | null;
  routeJumpCount: number | null;
  routePlatformCount: number | null;
  endpointDistance: number | null;
  routeWallJumpCount: number | null;
  routeCrouchCount: number | null;
  routeBranchCount: number | null;
  routeToleranceRatio: number | null;
  minLandingMargin: number | null;
  estimatedRouteSeconds: number | null;
  scanTiming: ScanTiming | null;
  planningMs: number;
  generationMs: number;
  retries: number;
  frameSamples: number;
  averageFps: number | null;
  frameP95Ms: number | null;
  updateAverageMs: number | null;
  drawAverageMs: number | null;
  eligibleRegionCount: number;
  verifiedRegionCount: number;
  visitedRegionCount: number;
  pageUpdateCount: number;
  lastPageUpdateMs: number;
  systemRelocations: number;
}

type State = 'idle' | 'generating' | 'transitioning' | 'selecting' | 'playing' | 'paused' | 'complete' | 'unavailable' | 'destroyed';

const STYLE = `
.edgekin-controls{position:fixed;right:22px;top:22px;z-index:1;display:flex;flex-wrap:nowrap;align-items:center;gap:8px;box-sizing:border-box;max-width:min(620px,calc(100vw - 44px));padding:10px 12px;border:1px solid #d9d9d5;border-radius:14px;background:rgba(255,255,255,.95);box-shadow:0 8px 28px rgba(0,0,0,.12);font:13px/1.35 system-ui,sans-serif;color:#242424;pointer-events:auto}
.edgekin-controls button{flex:none;border:0;border-radius:9px;background:#1b1b1b;color:white;font:600 13px system-ui,sans-serif;padding:8px 12px;cursor:pointer;white-space:nowrap}
.edgekin-controls button:focus-visible{outline:3px solid #f4a46f;outline-offset:2px}
.edgekin-controls span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.edgekin-controls button:disabled{opacity:.55;cursor:wait}
.edgekin-controls button[hidden]{display:none}
.edgekin-score{position:relative;flex:none;width:96px;display:grid;gap:4px}
.edgekin-score[hidden]{display:none}
.edgekin-score span{font-weight:750;color:#835900}
.edgekin-score progress{width:96px;height:7px;appearance:none;border:0;border-radius:9px;background:#e9e5dc;overflow:hidden}
.edgekin-score progress::-webkit-progress-bar{background:#e9e5dc;border-radius:9px}
.edgekin-score progress::-webkit-progress-value{background:linear-gradient(90deg,#e9a716,#ffd454);border-radius:9px}
.edgekin-score progress::-moz-progress-bar{background:#e9a716;border-radius:9px}
.edgekin-score .edgekin-score-delta{position:absolute;right:0;top:-4px;overflow:visible;font-weight:850;font-size:16px;color:#bd8100;text-shadow:0 1px 3px white;pointer-events:none;animation:edgekin-score-rise .6s ease-out forwards}
.edgekin-score .edgekin-score-delta.loss{color:#ce352b}
@keyframes edgekin-score-rise{0%{opacity:1;transform:translateY(0) scale(.85)}25%{opacity:1;transform:translateY(-5px) scale(1.1)}100%{opacity:0;transform:translateY(-24px) scale(1)}}
@media(prefers-reduced-motion:reduce){.edgekin-score .edgekin-score-delta{animation:none}}
`;

export function mountEdgekin(options: EdgekinOptions = {}): EdgekinInstance {
  const mode = options.mode ?? 'collect';
  if (mode !== 'collect' && mode !== 'course') throw new TypeError('Edgekin mode must be collect or course.');
  const root = options.root ?? document.body;
  if (!(root instanceof HTMLElement)) throw new TypeError('Edgekin root must be an HTMLElement.');
  const host = document.createElement('div');
  host.dataset.edgekinOverlay = '';
  host.dataset.edgekinIgnore = '';
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position: 'fixed', left: '0', top: '0', pointerEvents: 'none',
  });
  const controls = document.createElement('div');
  controls.className = 'edgekin-controls';
  controls.title = mode === 'collect' ? '硬币 +1；碰红球或掉落 −1（最低 0），回到绿色返回点。空中 ↓ 快速下落；琥珀平台触碰后约 0.3 秒消失，3 秒后重现，变红时请离开。' :
    '用方向键抵达终点；掉落回原起点，通关后可以重开。';
  const label = document.createElement('span');
  label.setAttribute('role', 'status');
  const scoreBox = document.createElement('div');
  scoreBox.className = 'edgekin-score';
  scoreBox.hidden = mode !== 'collect';
  const scoreLabel = document.createElement('span');
  scoreLabel.setAttribute('aria-live', 'polite');
  const scoreProgress = document.createElement('progress');
  scoreProgress.max = 10;
  scoreBox.append(scoreLabel, scoreProgress);
  const button = document.createElement('button');
  button.type = 'button';
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = mode === 'collect' ? '重新计分' : '回起点';
  const newButton = document.createElement('button');
  newButton.type = 'button';
  newButton.textContent = '换一关';
  controls.append(scoreBox, label, button, retryButton, newButton);
  shadow.append(style, canvas, controls);
  document.body.append(host);

  const renderer = new Renderer(canvas);
  const pressed = new Set<string>();
  let state: State = 'idle';
  let level: Level | null = null;
  let player: Player | null = null;
  let mapStats: MapStats | null = null;
  let frameId = 0;
  let lastFrame = 0;
  let accumulator = 0;
  let jumpQueued = false;
  let resizeTimer = 0;
  let downHoldTimer = 0;
  const recent: EndpointPair[] = [];
  let generation = new AbortController();
  let pending: Promise<void> = Promise.resolve();
  let resumeRequested = false;
  let stopWatching: (() => void) | null = null;
  const collection = new CollectionSession();
  let graph = new Map<number, JumpRecipe[]>();
  let patrols: Patrol[] = [];
  let gameTime = 0;
  let invulnerable = 0;
  let targetSelectionMs = 0;
  let targetPending: Promise<void> = Promise.resolve();
  let targetGeneration = new AbortController();
  let preparation = new AbortController();
  let prepared: { parent: RewardTarget; candidate: RewardTarget; version: number } | null = null;
  let targetBusy = false;
  let lastSearch: Player | null = null;
  let mapUpdating = false;
  let updateQueued = false;
  let resumeAfterUpdate = false;
  let worldVersion = 0;
  const verifiedRegions = new Set<number>();
  const scoreEffects: { node: HTMLSpanElement; timer: number }[] = [];
  let lastNotifiedScore = 0;
  const frameSamples: { interval: number; update: number; draw: number }[] = [];

  function notifyScore(reason: 'collect' | 'respawn' | 'reset'): void {
    const delta = collection.score - lastNotifiedScore;
    lastNotifiedScore = collection.score;
    if (reason !== 'reset' && delta) {
      if (scoreEffects.length >= 3) { const old = scoreEffects.shift()!; old.node.remove(); window.clearTimeout(old.timer); }
      const node = document.createElement('span');
      node.className = `edgekin-score-delta${delta < 0 ? ' loss' : ''}`;
      node.textContent = delta > 0 ? `+${delta}` : `−${-delta}`;
      node.setAttribute('aria-hidden', 'true');
      scoreBox.append(node);
      const effect = { node, timer: window.setTimeout(() => {
        node.remove(); const index = scoreEffects.indexOf(effect); if (index >= 0) scoreEffects.splice(index, 1);
      }, 600) };
      scoreEffects.push(effect);
    }
    try { options.onScoreChange?.(collection.score, reason); }
    catch (error) { console.error('Edgekin onScoreChange callback failed', error); }
  }

  function updateControls(): void {
    const descriptions: Record<Exclude<State, 'destroyed'>, [string, string]> = {
      idle: [mode === 'collect' ? '收集金色硬币，避开红球。' : '网页边缘，随手一跳。', '开始'],
      generating: ['正在根据当前网页生成关卡…', '生成中'],
      transitioning: ['页面更新中，正在寻找安全落脚点…', '暂停'],
      selecting: ['寻找下一枚硬币…', '暂停'],
      playing: ['←/→ 移动 · ↑ 跳跃/借墙 · ↓ 蹲/速降', '暂停'],
      paused: ['已暂停', '继续'],
      complete: [mode === 'collect' ? '暂无合格目标，长按 ↓ 换一关继续' : '通关！长按 ↓ 约 0.8 秒生成新关卡', '新关卡'],
      unavailable: ['当前可见页面缺少可用边缘，请滚动页面或调整窗口。', '重试'],
    };
    if (state === 'destroyed') return;
    const [description, action] = descriptions[state];
    label.textContent = state === 'playing' && targetBusy ? '寻找下一枚硬币… · 可继续移动' :
      state === 'playing' && mapUpdating ? '地图更新中 · 可继续移动' : description;
    label.title = description;
    scoreLabel.textContent = `积分 ${collection.score}`;
    const base = Math.floor(Math.max(0, collection.score - 1) / 10) * 10;
    scoreProgress.value = collection.score - base;
    scoreProgress.setAttribute('aria-label', `积分 ${collection.score}，本段 ${base} 至 ${base + 10} 分`);
    scoreBox.title = `每 10 分一个里程碑，当前 ${collection.score} 分，本段目标 ${base + 10} 分`;
    button.textContent = action;
    button.disabled = state === 'generating';
    retryButton.hidden = !level || (state !== 'paused' && state !== 'complete');
    newButton.hidden = state !== 'paused';
  }

  function draw(time = performance.now()): void {
    renderer.draw(level, player, state === 'playing' &&
      (pressed.has('ArrowLeft') || pressed.has('ArrowRight')), time, pressed.has('ArrowDown'),
      { mode, target: collection.target, checkpoint: collection.checkpoint,
        patrols, seconds: gameTime, invulnerable: invulnerable > 0 });
  }

  function respawn(penalize = false): void {
    if (!level) return;
    const start = level.world.platforms.find(platform => platform.id === level?.startId);
    if (mode === 'collect') player = collection.respawn();
    else if (start) player = spawnPlayer(start, level.world, level.startX);
    invulnerable = .9;
    jumpQueued = false;
    if (mapStats) mapStats.retries++;
    renderer.clearFeedback();
    const scoreChanged = mode === 'collect' && penalize && collection.penalize() > 0;
    if (scoreChanged) {
      if (player) renderer.feedback('penalty', player.x, player.footY);
    }
    if (player) renderer.feedback('respawn', player.x, player.footY);
    updateControls();
    draw();
    if (scoreChanged) notifyScore('respawn');
  }

  function restart(): void {
    if (!level || state === 'destroyed' || state === 'generating') return;
    pause();
    preparation.abort(); prepared = null; lastSearch = null;
    for (const effect of scoreEffects) { window.clearTimeout(effect.timer); effect.node.remove(); }
    scoreEffects.length = 0;
    let scoreChanged = false;
    if (mode === 'collect') {
      const start = level.world.platforms.find(platform => platform.id === level?.startId);
      if (!start) return;
      const previousScore = collection.score;
      collection.score = 0;
      scoreChanged = previousScore > 0;
      collection.begin(level.world, start, level.startX);
      gameTime = 0;
      level.world.platformStates?.clear();
    }
    respawn();
    state = 'paused';
    if (mode === 'collect') void refreshTarget(false);
    updateControls();
    if (scoreChanged) notifyScore('reset');
  }

  function applyTarget(target: RewardTarget, from: Player): void {
    if (!level) return;
    collection.target = target;
    level.goalId = target.platformId;
    level.goalX = target.x;
    verifiedRegions.add(regionId(level.world, target.x, target.footY));
    if (mapStats) {
      mapStats.routePlatformCount = target.route.length;
      mapStats.endpointDistance = Math.hypot(target.x - from.x, target.footY - from.footY);
      mapStats.estimatedRouteSeconds = target.actions.length * STEP_SECONDS;
      mapStats.routeJumpCount = target.jumpCount;
      mapStats.routeWallJumpCount = target.wallJumpCount;
      mapStats.routeCrouchCount = target.crouchCount;
      mapStats.routeBranchCount = target.route.filter(id => (graph.get(id)?.length ?? 0) > 1).length;
      mapStats.routeToleranceRatio = null;
      mapStats.minLandingMargin = null;
    }
    prepareNext(target);
  }

  function prepareNext(parent: RewardTarget): void {
    preparation.abort(); preparation = new AbortController(); prepared = null;
    if (!level || mode !== 'collect') return;
    const activeLevel = level, version = worldVersion, signal = preparation.signal;
    const surface = activeLevel.world.platforms.find(platform => platform.id === parent.platformId);
    if (!surface) return;
    const from = spawnPlayer(surface, activeLevel.world, parent.x,
      !canOccupy(activeLevel.world, parent.x, parent.footY, false, surface.id, gameTime));
    const rotation = collection.rotation.clone(); rotation.commit(parent.regionId ?? regionId(activeLevel.world, parent.x, parent.footY));
    void (async () => {
      await yieldToBrowser(signal);
      const candidate = await chooseRewardWithDiscoveryAsync(activeLevel.world, from, graph,
        { time: gameTime + parent.actions.length * STEP_SECONDS, patrols, recent: [...collection.recent, parent], rotation }, signal);
      throwIfAborted(signal);
      if (level === activeLevel && version === worldVersion && collection.target === parent && candidate)
        prepared = { parent, candidate, version };
    })().catch(error => { if (!signal.aborted) console.error('Edgekin reward preparation failed', error); });
  }

  function refreshTarget(_autoResume = false, preferred?: RewardTarget): Promise<void> {
    if (!level || !player) return Promise.resolve();
    targetGeneration.abort();
    targetGeneration = new AbortController();
    const source = { ...player }, activeLevel = level, signal = targetGeneration.signal, version = worldVersion;
    lastSearch = source; targetBusy = true;
    updateControls();
    const started = performance.now();
    targetPending = (async () => {
      await yieldToBrowser(signal);
      if (source.groundedOn !== null && !graph.has(source.groundedOn)) {
        const extra = await reachableJumpsAsync(activeLevel.world, [source.groundedOn], signal);
        for (const [id, recipes] of extra) graph.set(id, recipes);
      }
      let target = preferred ? await chooseRewardAsync(activeLevel.world, source, graph,
        { patrols, time: gameTime, preferred, rotation: collection.rotation }, signal) : null;
      if (!target) target = await chooseRewardWithDiscoveryAsync(activeLevel.world, source, graph,
        { patrols, time: gameTime, recent: collection.recent, rotation: collection.rotation }, signal);
      throwIfAborted(signal);
      if (level !== activeLevel || version !== worldVersion || !player) return;
      // The player can keep moving while planning. Recheck from the actual new pose.
      let validatedFrom = source;
      if (target && (player.groundedOn !== source.groundedOn || Math.abs(player.x - source.x) > activeLevel.world.characterHeight * .5 ||
        gameTime - target.startTime > .1)) {
        validatedFrom = { ...player };
        lastSearch = validatedFrom;
        target = await chooseRewardAsync(activeLevel.world, validatedFrom, graph,
          { patrols, time: gameTime, preferred: target, rotation: collection.rotation }, signal);
        throwIfAborted(signal);
        if (level !== activeLevel || version !== worldVersion) return;
      }
      // A second asynchronous validation can also finish after the player has moved.
      if (target && (player.groundedOn !== validatedFrom.groundedOn ||
        Math.abs(player.x - validatedFrom.x) > activeLevel.world.characterHeight * .5)) target = null;
      targetSelectionMs = performance.now() - started;
      if (target) {
        applyTarget(target, player);
      }
      targetBusy = false;
      updateControls();
      draw();
    })().catch(error => {
      if (signal.aborted) return;
      targetBusy = false;
      updateControls();
      console.error('Edgekin reward selection failed', error);
    });
    return targetPending;
  }

  function tick(time: number): void {
    if ((state !== 'playing' && state !== 'selecting') || !level || !player) return;
    const interval = time - lastFrame;
    const updateStart = performance.now();
    accumulator = state === 'playing' ? accumulator + Math.min((time - lastFrame) / 1000, 0.05) : 0;
    lastFrame = time;
    while (accumulator >= STEP_SECONDS && state === 'playing' && player) {
      const horizontal = Number(pressed.has('ArrowRight')) - Number(pressed.has('ArrowLeft'));
      const previous = player;
      player = stepPlayer(player, {
        horizontal: horizontal as -1 | 0 | 1,
        jump: jumpQueued,
        crouch: pressed.has('ArrowDown') && player.groundedOn !== null,
        fastFall: pressed.has('ArrowDown') && player.groundedOn === null,
      }, level.world, STEP_SECONDS, gameTime);
      const nextTime = gameTime + STEP_SECONDS;
      const hit = invulnerable <= 0 && hitsPatrol(previous, player, level.world, patrols, gameTime, nextTime);
      gameTime = nextTime;
      invulnerable = Math.max(0, invulnerable - STEP_SECONDS);
      if (player.event) renderer.feedback(player.event, player.x, player.footY);
      jumpQueued = false;
      accumulator -= STEP_SECONDS;
      if (hit || player.footY > level.world.height + level.world.characterHeight) {
        const hitPosition = player;
        respawn(true);
        if (hit) renderer.feedback('hit', hitPosition.x, hitPosition.footY);
        continue;
      }
      if (mode === 'collect' && collection.collect(player, level.world, gameTime)) {
        player = { ...player, jumpBufferTime: 0, wallJumpTime: 0 };
        renderer.feedback('collect', player.x, player.footY);
        jumpQueued = false;
        const cached = prepared?.version === worldVersion ? prepared.candidate : undefined;
        prepared = null;
        void refreshTarget(true, cached);
        notifyScore('collect');
        try { options.onCollect?.(collection.score); } catch (error) { console.error('Edgekin onCollect callback failed', error); }
      } else if (mode === 'course' && player.groundedOn === level.goalId &&
        Math.abs(player.x - level.goalX) <= level.world.characterHeight * 0.65) {
        state = 'complete';
        pressed.clear();
        updateControls();
        renderer.feedback('complete', player.x, player.footY);
        try { options.onComplete?.(); } catch (error) { console.error('Edgekin onComplete callback failed', error); }
      }
    }
    if (mode === 'collect' && !collection.target && !targetBusy && !mapUpdating && player?.groundedOn !== null && player &&
      (!lastSearch || player.groundedOn !== lastSearch.groundedOn || Math.abs(player.x - lastSearch.x) > level.world.characterHeight * 2))
      void refreshTarget();
    const update = performance.now() - updateStart;
    const drawStart = performance.now();
    draw(time);
    if (interval > 0) frameSamples.push({ interval, update, draw: performance.now() - drawStart });
    if (frameSamples.length > 120) frameSamples.shift();
    if (state === 'playing' || state === 'selecting') frameId = requestAnimationFrame(tick);
  }

  function pause(): void {
    resumeRequested = false;
    resumeAfterUpdate = false;
    window.clearTimeout(downHoldTimer);
    downHoldTimer = 0;
    if (state !== 'playing' && state !== 'selecting' && state !== 'transitioning') return;
    state = 'paused';
    cancelAnimationFrame(frameId);
    pressed.clear();
    jumpQueued = false;
    updateControls();
    draw();
  }

  function regenerate(): Promise<void> {
    if (state === 'destroyed') return Promise.resolve();
    generation.abort();
    targetGeneration.abort();
    preparation.abort(); prepared = null; targetBusy = false; lastSearch = null;
    worldVersion++; verifiedRegions.clear(); mapUpdating = false; updateQueued = false; resumeAfterUpdate = false;
    generation = new AbortController();
    const signal = generation.signal;
    resumeRequested = false;
    stopWatching?.();
    stopWatching = null;
    cancelAnimationFrame(frameId);
    pressed.clear();
    jumpQueued = false;
    window.clearTimeout(downHoldTimer);
    downHoldTimer = 0;
    state = 'generating';
    level = null;
    player = null;
    mapStats = null;
    collection.target = null;
    collection.checkpoint = null;
    patrols = [];
    graph = new Map();
    gameTime = 0;
    invulnerable = 0;
    targetSelectionMs = 0;
    frameSamples.length = 0;
    renderer.clearFeedback();
    renderer.resize(innerWidth, innerHeight);
    updateControls();
    draw();
    pending = (async () => {
      const totalStart = performance.now();
      await yieldToBrowser(signal);
      const scanned = await scanPageAsync(root, innerWidth, innerHeight, signal);
      scanned.reserved = [controls.getBoundingClientRect()];
      const shapes = scanned.shapes ?? [];
      mapStats = {
        outlineCount: shapes.length,
        smallIconCount: shapes.filter(shape => shape.detail === 'icon' &&
          Math.max(shape.right - shape.left, shape.bottom - shape.top) <= 32).length,
        openedContainerCount: shapes.filter(shape => shape.openings?.length).length,
        openingCount: shapes.reduce((n, shape) => n + openingCount(shape), 0),
        standingSurfaceCount: scanned.platforms.length,
        gapPlatformCount: 0,
        contourBudget: CONTOUR_BUDGET,
        eligibleOutlineCount: scanned.contourStats?.eligibleCount ?? shapes.length,
        omittedOutlineCount: scanned.contourStats?.omittedCount ?? 0,
        complexityPercent: scanned.contourStats?.complexityPercent ?? null,
        routeJumpCount: null,
        routePlatformCount: null,
        endpointDistance: null,
        routeWallJumpCount: null, routeCrouchCount: null, routeBranchCount: null,
        routeToleranceRatio: null, minLandingMargin: null, estimatedRouteSeconds: null,
        scanTiming: scanned.scanTiming ?? null, planningMs: 0, generationMs: 0, retries: 0,
        frameSamples: 0, averageFps: null, frameP95Ms: null, updateAverageMs: null, drawAverageMs: null,
        eligibleRegionCount: 0, verifiedRegionCount: 0, visitedRegionCount: 0,
        pageUpdateCount: 0, lastPageUpdateMs: 0, systemRelocations: 0,
      };
      const planningStart = performance.now();
      let enriched = scanned;
      if (mode === 'collect') {
        const visualSource = { ...scanned, platforms: scanned.platforms.filter(platform => platform.tier !== 'text') };
        const firstGraph = await reachableJumpsAsync(visualSource, undefined, signal);
        const repaired = await connectRegionsAsync(visualSource, firstGraph, signal);
        enriched = await addGapPlatformsAsync(repaired.world, signal);
      }
      mapStats.gapPlatformCount = enriched.platforms.filter(platform => platform.generated === 'gap').length;
      const visual = { ...enriched, platforms: enriched.platforms.filter(platform => platform.tier !== 'text') };
      graph = await reachableJumpsAsync(visual, undefined, signal);
      await yieldToBrowser(signal);
      level = chooseLevel(visual, { recent, graph, relaxed: mode === 'collect' });
      if (!level && scanned.platforms.some(platform => platform.tier === 'text')) {
        const textGraph = await reachableJumpsAsync(enriched, undefined, signal);
        level = chooseLevel(enriched, { recent, graph: textGraph, relaxed: mode === 'collect' });
        graph = textGraph;
      }
      if (!level) { level = await createFallbackLevelAsync(enriched, { recent, relaxed: mode === 'collect' }, signal); }
      throwIfAborted(signal);
      if (level) {
        level.metrics ??= await assessRouteAsync(level, graph, signal);
        throwIfAborted(signal);
        const pair = endpointPair(level);
        mapStats.routeJumpCount = level.metrics.jumpCount;
        mapStats.routeWallJumpCount = level.metrics.wallJumpCount;
        mapStats.routeCrouchCount = level.metrics.crouchCount;
        mapStats.routeBranchCount = level.metrics.branchCount;
        mapStats.routeToleranceRatio = level.metrics.toleranceRatio;
        mapStats.minLandingMargin = level.metrics.minLandingMargin;
        mapStats.estimatedRouteSeconds = level.metrics.estimatedSeconds;
        mapStats.routePlatformCount = level.route.length;
        mapStats.endpointDistance = Math.hypot(pair.startX - pair.goalX, pair.startY - pair.goalY);
        recent.push(pair);
        if (recent.length > 24) recent.shift();
        const start = level.world.platforms.find(platform => platform.id === level?.startId);
        player = start ? spawnPlayer(start, level.world, level.startX) : null;
        if (start && player && mode === 'collect') {
          collection.begin(level.world, start, level.startX);
          if (level.usedFallback) graph = await reachableJumpsAsync(level.world, undefined, signal);
          if (!graph.has(start.id)) {
            const extra = await reachableJumpsAsync(level.world, [start.id], signal);
            for (const [id, recipes] of extra) graph.set(id, recipes);
          }
          const goal = level.world.platforms.find(platform => platform.id === level?.goalId)!;
          patrols = options.hazards === false ? [] : createPatrols(level.world,
            [player, { x: level.goalX, footY: surfaceY(goal, level.goalX, level.world) }], level.route);
          let target = await chooseRewardWithDiscoveryAsync(level.world, player, graph,
            { patrols, rotation: collection.rotation }, signal);
          if (!target && patrols.length) {
            patrols = [];
            target = await chooseRewardWithDiscoveryAsync(level.world, player, graph, { rotation: collection.rotation }, signal);
          }
          throwIfAborted(signal);
          if (target) applyTarget(target, player);
          else { level = null; player = null; collection.checkpoint = null; patrols = []; }
        }
        state = level ? 'paused' : 'unavailable';
      } else {
        player = null;
        state = 'unavailable';
      }
      mapStats.planningMs = performance.now() - planningStart;
      mapStats.generationMs = performance.now() - totalStart;
      stopWatching = watchPage(root, scanned, onPageChange);
      updateControls();
      draw();
    })().catch(error => {
      if (signal.aborted) return;
      state = 'unavailable';
      level = null;
      player = null;
      collection.target = null;
      collection.checkpoint = null;
      patrols = [];
      updateControls();
      draw();
      console.error('Edgekin generation failed', error);
    });
    return pending;
  }

  async function start(): Promise<void> {
    if (state === 'destroyed' || state === 'playing') return;
    if (state !== 'generating' && (!level || state === 'unavailable' || state === 'complete')) regenerate();
    const signal = generation.signal;
    resumeRequested = true;
    await pending;
    await targetPending;
    if (signal.aborted || !resumeRequested) return;
    if ((state as State) === 'playing') return;
    if (!level || !player) return;
    if (mode === 'collect' && !restoreBodies(level.world, level.world)) {
      state = 'transitioning'; resumeAfterUpdate = true; updateControls(); return;
    }
    state = 'playing';
    pressed.clear();
    jumpQueued = false;
    lastFrame = performance.now();
    accumulator = 0;
    frameSamples.length = 0;
    updateControls();
    frameId = requestAnimationFrame(tick);
    if (mode === 'collect' && !collection.target && !targetBusy) void refreshTarget();
    button.blur();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.composedPath().some(target => target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))) {
      pause();
      return;
    }
    if (state === 'complete' && event.code === 'ArrowDown') {
      if (!downHoldTimer && !event.repeat) {
        downHoldTimer = window.setTimeout(() => {
          downHoldTimer = 0;
          if (state === 'complete') start();
        }, 800);
      }
      event.preventDefault();
      return;
    }
    if (state !== 'playing' && state !== 'selecting') return;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) {
      if (event.code === 'ArrowUp' && !event.repeat && !pressed.has('ArrowUp') &&
        !pressed.has('ArrowDown')) jumpQueued = true;
      pressed.add(event.code);
      event.preventDefault();
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    pressed.delete(event.code);
    if (event.code === 'ArrowDown' && downHoldTimer) {
      window.clearTimeout(downHoldTimer);
      downHoldTimer = 0;
    }
    if ((state === 'playing' || state === 'selecting' || state === 'complete') &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) event.preventDefault();
  }

  function onResize(): void {
    scheduleRegeneration();
  }

  function onScroll(): void {
    scheduleRegeneration();
  }

  function scheduleRegeneration(): void {
    if (state === 'idle') { renderer.resize(innerWidth, innerHeight); return; }
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => onPageChange({ removedSourceIds: [] }), 120);
  }

  function restoreBodies(before: World, after: World): boolean {
    if (!player) return false;
    const checkpoint = collection.checkpoint && migrateBody(collection.checkpoint, before, after, gameTime);
    const carried = migrateBody(player, before, after, gameTime);
    const fallback = checkpoint ?? safeBody(after, player, gameTime);
    collection.checkpoint = checkpoint ?? fallback;
    // An airborne body is not a safe continuation if the entire map has disappeared.
    if (!fallback) return false;
    if (carried) { player = carried; return true; }
    if (fallback) {
      player = { ...fallback }; invulnerable = .9; jumpQueued = false;
      if (mapStats) mapStats.systemRelocations++;
      return true;
    }
    return false;
  }

  function onPageChange(change: PageChange): void {
    if (state === 'destroyed' || state === 'idle') return;
    // Course endpoints define one fixed route; retain its explicit rebuild behaviour.
    if (mode === 'course') { pause(); void regenerate(); return; }
    if (!level) {
      if (state === 'unavailable') { const wanted = resumeRequested; void regenerate().then(() => { if (wanted) void start(); }); }
      return;
    }
    if (change.removedSourceIds.length) {
      const before = level.world, pruned = removeSources(before, change.removedSourceIds);
      targetGeneration.abort(); preparation.abort(); targetBusy = false; prepared = null; worldVersion++;
      const safe = restoreBodies(before, pruned);
      if (collection.target) collection.target = migrateTarget(collection.target, before, pruned, gameTime);
      graph = reuseGraph(before, pruned, graph);
      level = { ...level, world: pruned };
      if (!safe && state === 'playing') {
        resumeAfterUpdate = true; state = 'transitioning'; cancelAnimationFrame(frameId); pressed.clear(); jumpQueued = false;
      }
      draw();
    }
    updateQueued = true;
    void updateMap();
  }

  async function updateMap(): Promise<void> {
    if (mapUpdating || !level) return;
    const signal = generation.signal;
    mapUpdating = true; updateControls();
    try {
      while (updateQueued && level && !signal.aborted) {
        updateQueued = false;
        const started = performance.now(), before = level.world;
        const scanned = await scanPageAsync(root, innerWidth, innerHeight, signal, before);
        scanned.reserved = [controls.getBoundingClientRect()];
        let next = retainHelpers(before, scanned);
        let nextGraph = reuseGraph(before, next, graph);
        const missing = distributedSources(next, next.platforms.filter(platform => !nextGraph.has(platform.id))).slice(0, 12);
        if (missing.length) {
          const extra = await reachableJumpsAsync(next, missing.map(platform => platform.id), signal);
          for (const [id, links] of extra) nextGraph.set(id, links);
        }
        if (mode === 'collect') {
          const repaired = await connectRegionsAsync(next, nextGraph, signal);
          next = repaired.world; nextGraph = repaired.graph;
        }
        throwIfAborted(signal);
        if (!level) break;
        const stale = getPageSnapshot(scanned).filter(snapshot => {
          if (!snapshot.element.isConnected || !root.contains(snapshot.element)) return true;
          const box = snapshot.element.getBoundingClientRect();
          return Math.abs(box.left - snapshot.left) > 1 || Math.abs(box.top - snapshot.top) > 1 ||
            Math.abs(box.width - snapshot.width) > 1 || Math.abs(box.height - snapshot.height) > 1 ||
            surfaceSignature(snapshot.element) !== snapshot.signature;
        });
        if (stale.length) {
          const fresh = removeSources(next, stale.map(snapshot => snapshot.sourceId));
          nextGraph = reuseGraph(next, fresh, nextGraph); next = fresh; updateQueued = true;
        }
        const current: World = level.world;
        // Physics kept running during the scan; carry its latest temporary-platform timers.
        next.platformStates = new Map();
        for (const platform of next.platforms) {
          const old = matchingPlatform(platform, current), timer = old && current.platformStates?.get(old.id);
          if (platform.crumble && timer) next.platformStates.set(platform.id, { ...timer });
        }
        targetGeneration.abort(); preparation.abort(); prepared = null; targetBusy = false; lastSearch = null;
        worldVersion++;
        const safe = restoreBodies(current, next);
        const target = collection.target && migrateTarget(collection.target, current, next, gameTime);
        const start = matchingPlatform(current.platforms.find(platform => platform.id === level!.startId), next);
        const oldStart: Platform | undefined = current.platforms.find(platform => platform.id === level!.startId);
        const startX: number = start && oldStart ? start.left + (level.startX - oldStart.left) /
          Math.max(.001, oldStart.right - oldStart.left) * (start.right - start.left) : player?.x ?? level.startX;
        const migratedPatrols: Patrol[] = [];
        for (const patrol of patrols) {
          const old = current.platforms.find(platform => platform.id === patrol.platformId), after = matchingPlatform(old, next);
          if (old && after && sameSurface(old, after, current, next)) migratedPatrols.push({ ...patrol, platformId: after.id });
        }
        patrols = migratedPatrols;
        graph = nextGraph;
        level = { ...level, world: next, startId: start?.id ?? player?.groundedOn ?? level.startId, startX };
        collection.target = target;
        verifiedRegions.clear();
        if (player?.groundedOn !== null && player) verifiedRegions.add(regionId(next, player.x, player.footY));
        if (mapStats) {
          const shapes = next.shapes ?? [];
          mapStats.outlineCount = shapes.length; mapStats.standingSurfaceCount = next.platforms.length;
          mapStats.smallIconCount = shapes.filter(shape => shape.detail === 'icon' && Math.max(shape.right - shape.left, shape.bottom - shape.top) <= 32).length;
          mapStats.openedContainerCount = shapes.filter(shape => shape.openings?.length).length;
          mapStats.openingCount = shapes.reduce((sum, shape) => sum + openingCount(shape), 0);
          mapStats.gapPlatformCount = next.platforms.filter(platform => platform.generated === 'gap').length;
          mapStats.scanTiming = scanned.scanTiming ?? null;
          mapStats.eligibleOutlineCount = scanned.contourStats?.eligibleCount ?? shapes.length;
          mapStats.omittedOutlineCount = scanned.contourStats?.omittedCount ?? 0;
          mapStats.complexityPercent = scanned.contourStats?.complexityPercent ?? null;
          mapStats.pageUpdateCount++; mapStats.lastPageUpdateMs = performance.now() - started;
        }
        stopWatching?.(); stopWatching = watchPage(root, scanned, onPageChange);
        renderer.resize(innerWidth, innerHeight);
        if (!safe && state === 'playing') {
          resumeAfterUpdate = true; state = 'transitioning'; cancelAnimationFrame(frameId); pressed.clear(); jumpQueued = false;
        } else if (safe && state === 'transitioning' && resumeAfterUpdate) {
          resumeAfterUpdate = false; state = 'playing'; lastFrame = performance.now(); accumulator = 0;
          frameId = requestAnimationFrame(tick);
        }
        if (safe && mode === 'collect') void refreshTarget(false, target ?? undefined);
        updateControls(); draw();
      }
    } catch (error) {
      if (!signal.aborted) console.error('Edgekin background map update failed', error);
    } finally {
      if (!signal.aborted) { mapUpdating = false; updateControls(); }
    }
  }

  function onFocusIn(event: FocusEvent): void {
    if (event.composedPath().some(target => target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))) pause();
  }

  function destroy(): void {
    if (state === 'destroyed') return;
    state = 'destroyed';
    generation.abort();
    targetGeneration.abort();
    preparation.abort(); prepared = null; targetBusy = false; mapUpdating = false; updateQueued = false;
    stopWatching?.();
    cancelAnimationFrame(frameId);
    window.clearTimeout(resizeTimer);
    window.clearTimeout(downHoldTimer);
    for (const effect of scoreEffects) { window.clearTimeout(effect.timer); effect.node.remove(); }
    scoreEffects.length = 0;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', pause);
    document.removeEventListener('focusin', onFocusIn);
    button.removeEventListener('click', onButtonClick);
    retryButton.removeEventListener('click', onRetryClick);
    newButton.removeEventListener('click', onNewClick);
    host.remove();
    mapStats = null;
    level = null;
    player = null;
    collection.target = null;
    collection.checkpoint = null;
    patrols = [];
  }

  function onButtonClick(): void {
    if (state === 'playing' || state === 'selecting' || state === 'transitioning') pause();
    else start();
  }

  function onRetryClick(): void { restart(); void start(); }
  function onNewClick(): void { void regenerate(); void start(); }

  function getMapStats(): MapStats | null {
    if (!mapStats) return null;
    const count = frameSamples.length;
    const average = (key: 'interval' | 'update' | 'draw'): number =>
      frameSamples.reduce((sum, sample) => sum + sample[key], 0) / count;
    const sorted = frameSamples.map(sample => sample.interval).sort((a, b) => a - b);
    const regions = new Set(level ? regionPoints(level.world, () => .5).map(point => point.regionId) : []);
    return { ...mapStats, scanTiming: mapStats.scanTiming ? { ...mapStats.scanTiming } : null,
      eligibleRegionCount: regions.size, verifiedRegionCount: [...verifiedRegions].filter(id => regions.has(id)).length,
      visitedRegionCount: [...collection.rotation.visited].filter(id => regions.has(id)).length,
      frameSamples: count, averageFps: count ? 1000 / average('interval') : null,
      frameP95Ms: count ? sorted[Math.ceil(count * .95) - 1]! : null,
      updateAverageMs: count ? average('update') : null, drawAverageMs: count ? average('draw') : null };
  }

  function getSessionStats(): SessionStats {
    const checkpoint = collection.checkpoint;
    const target = collection.target;
    const goal = mode === 'course' ? level?.world.platforms.find(platform => platform.id === level?.goalId) : null;
    return { mode, state, score: collection.score, elapsedSeconds: gameTime, targetSelectionMs,
      mapUpdating, targetPending: targetBusy, worldVersion,
      invulnerableSeconds: invulnerable,
      checkpoint: checkpoint ? { platformId: checkpoint.groundedOn, x: checkpoint.x, footY: checkpoint.footY } : null,
      target: target ? { platformId: target.platformId, x: target.x, footY: target.footY } :
        goal && level ? { platformId: goal.id, x: level.goalX, footY: surfaceY(goal, level.goalX, level.world) } : null,
      player: player ? { x: player.x, footY: player.footY, groundedOn: player.groundedOn } : null,
      patrols: patrols.map(patrol => ({ ...patrolPosition(patrol, gameTime), radius: patrol.radius })) };
  }

  button.addEventListener('click', onButtonClick);
  retryButton.addEventListener('click', onRetryClick);
  newButton.addEventListener('click', onNewClick);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', pause);
  document.addEventListener('focusin', onFocusIn);
  renderer.resize(innerWidth, innerHeight);
  updateControls();
  return { start, pause, regenerate, restart, destroy, getMapStats, getSessionStats };
}

export type { Level, Platform, Player, Shape, World } from './types.js';
