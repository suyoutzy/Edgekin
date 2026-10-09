import { assessRouteAsync, chooseLevel, endpointPair, reachableJumpsAsync, type EndpointPair } from './planner.js';
import { createFallbackLevelAsync } from './fallback.js';
import { spawnPlayer, stepPlayer, STEP_SECONDS } from './physics.js';
import { Renderer } from './renderer.js';
import { CONTOUR_BUDGET, scanPageAsync } from './scanner.js';
import { openingCount } from './contours.js';
import type { Level, Player, ScanTiming } from './types.js';
import { watchPage } from './page-watch.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';
import { CollectionSession, chooseRewardAsync } from './rewards.js';
import { createPatrols, hitsPatrol, patrolPosition } from './hazards.js';
import { surfaceY } from './geometry.js';
import type { JumpRecipe, Patrol, RewardTarget } from './types.js';

export interface EdgekinOptions {
  root?: HTMLElement;
  onComplete?: () => void;
  mode?: 'collect' | 'course';
  hazards?: boolean;
  onCollect?: (score: number) => void;
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
}

export interface MapStats {
  outlineCount: number;
  smallIconCount: number;
  openedContainerCount: number;
  openingCount: number;
  standingSurfaceCount: number;
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
}

type State = 'idle' | 'generating' | 'selecting' | 'playing' | 'paused' | 'complete' | 'unavailable' | 'destroyed';

const STYLE = `
.edgekin-controls{position:fixed;right:22px;top:22px;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:10px;max-width:min(380px,calc(100vw - 44px));padding:10px 12px;border:1px solid #d9d9d5;border-radius:14px;background:rgba(255,255,255,.95);box-shadow:0 8px 28px rgba(0,0,0,.12);font:13px/1.35 system-ui,sans-serif;color:#242424;pointer-events:auto}
.edgekin-controls button{border:0;border-radius:9px;background:#1b1b1b;color:white;font:600 13px system-ui,sans-serif;padding:8px 12px;cursor:pointer;white-space:nowrap}
.edgekin-controls button:focus-visible{outline:3px solid #f4a46f;outline-offset:2px}
.edgekin-controls span{min-width:0}
.edgekin-controls button:disabled{opacity:.55;cursor:wait}
.edgekin-controls button[hidden]{display:none}
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
  controls.title = mode === 'collect' ? '金色硬币每枚 +1；触碰红球或掉落会回到绿色返回点，保留分数。' :
    '用方向键抵达终点；掉落回原起点，通关后可以重开。';
  const label = document.createElement('span');
  label.setAttribute('role', 'status');
  const button = document.createElement('button');
  button.type = 'button';
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = mode === 'collect' ? '重新计分' : '回起点';
  const newButton = document.createElement('button');
  newButton.type = 'button';
  newButton.textContent = '换一关';
  controls.append(label, button, retryButton, newButton);
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
  const frameSamples: { interval: number; update: number; draw: number }[] = [];

  function updateControls(): void {
    const descriptions: Record<Exclude<State, 'destroyed'>, [string, string]> = {
      idle: [mode === 'collect' ? '收集金色硬币，避开红球。' : '网页边缘，随手一跳。', '开始'],
      generating: ['正在根据当前网页生成关卡…', '生成中'],
      selecting: [`积分 ${collection.score} · 寻找下一枚硬币…`, '暂停'],
      playing: [mode === 'collect' ? `积分 ${collection.score} · ←/→ 移动 · ↑ 跳跃/借墙 · ↓ 下蹲` : '←/→ 移动 · ↑ 跳跃/借墙 · ↓ 下蹲', '暂停'],
      paused: [`已暂停${mode === 'collect' ? ` · 积分 ${collection.score}` : ''} · ${mapStats?.outlineCount ?? 0}/${mapStats?.eligibleOutlineCount ?? 0} 个轮廓 · 复杂度 ${mapStats?.complexityPercent?.toFixed(1) ?? '—'}%`, '继续'],
      complete: [mode === 'collect' ? `积分 ${collection.score} · 暂无合格目标，长按 ↓ 换一关继续` : '通关！长按 ↓ 约 0.8 秒生成新关卡', '新关卡'],
      unavailable: ['当前可见页面缺少可用边缘，请滚动页面或调整窗口。', '重试'],
    };
    if (state === 'destroyed') return;
    const [description, action] = descriptions[state];
    label.textContent = description;
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

  function respawn(): void {
    if (!level) return;
    const start = level.world.platforms.find(platform => platform.id === level?.startId);
    if (mode === 'collect') player = collection.respawn();
    else if (start) player = spawnPlayer(start, level.world, level.startX);
    invulnerable = .9;
    jumpQueued = false;
    if (mapStats) mapStats.retries++;
    renderer.clearFeedback();
    if (player) renderer.feedback('respawn', player.x, player.footY);
    draw();
  }

  function restart(): void {
    if (!level || state === 'destroyed' || state === 'generating') return;
    pause();
    if (mode === 'collect') {
      const start = level.world.platforms.find(platform => platform.id === level?.startId);
      if (!start) return;
      collection.score = 0;
      collection.begin(level.world, start, level.startX);
      gameTime = 0;
    }
    respawn();
    state = 'paused';
    if (mode === 'collect') void refreshTarget(false);
    updateControls();
  }

  function applyTarget(target: RewardTarget, from: Player): void {
    if (!level) return;
    collection.target = target;
    level.goalId = target.platformId;
    level.goalX = target.x;
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
  }

  function refreshTarget(autoResume: boolean): Promise<void> {
    if (!level || !player) return Promise.resolve();
    targetGeneration.abort();
    targetGeneration = new AbortController();
    const source = { ...player }, activeLevel = level, signal = targetGeneration.signal;
    if (autoResume) state = 'selecting';
    updateControls();
    const started = performance.now();
    targetPending = (async () => {
      await yieldToBrowser(signal);
      if (source.groundedOn !== null && !graph.has(source.groundedOn)) {
        const extra = await reachableJumpsAsync(activeLevel.world, [source.groundedOn], signal);
        for (const [id, recipes] of extra) graph.set(id, recipes);
      }
      const target = await chooseRewardAsync(activeLevel.world, source, graph,
        { patrols, time: gameTime, recent: collection.recent }, signal);
      throwIfAborted(signal);
      if (level !== activeLevel) return;
      targetSelectionMs = performance.now() - started;
      if (target) {
        applyTarget(target, source);
        if (state === 'selecting') state = 'playing';
      } else state = 'complete';
      updateControls();
      draw();
    })().catch(error => {
      if (signal.aborted) return;
      state = 'complete';
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
        crouch: pressed.has('ArrowDown'),
      }, level.world);
      const nextTime = gameTime + STEP_SECONDS;
      const hit = invulnerable <= 0 && hitsPatrol(previous, player, level.world, patrols, gameTime, nextTime);
      gameTime = nextTime;
      invulnerable = Math.max(0, invulnerable - STEP_SECONDS);
      if (player.event) renderer.feedback(player.event, player.x, player.footY);
      jumpQueued = false;
      accumulator -= STEP_SECONDS;
      if (hit || player.footY > level.world.height + level.world.characterHeight) {
        const hitPosition = player;
        respawn();
        if (hit) renderer.feedback('hit', hitPosition.x, hitPosition.footY);
        continue;
      }
      if (mode === 'collect' && collection.collect(player, level.world)) {
        player = { ...player, jumpBufferTime: 0, wallJumpTime: 0 };
        renderer.feedback('collect', player.x, player.footY);
        jumpQueued = false;
        void refreshTarget(true);
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
    const update = performance.now() - updateStart;
    const drawStart = performance.now();
    draw(time);
    if (interval > 0) frameSamples.push({ interval, update, draw: performance.now() - drawStart });
    if (frameSamples.length > 120) frameSamples.shift();
    if (state === 'playing' || state === 'selecting') frameId = requestAnimationFrame(tick);
  }

  function pause(): void {
    resumeRequested = false;
    window.clearTimeout(downHoldTimer);
    downHoldTimer = 0;
    if (state !== 'playing' && state !== 'selecting') return;
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
      const shapes = scanned.shapes ?? [];
      mapStats = {
        outlineCount: shapes.length,
        smallIconCount: shapes.filter(shape => shape.detail === 'icon' &&
          Math.max(shape.right - shape.left, shape.bottom - shape.top) <= 32).length,
        openedContainerCount: shapes.filter(shape => shape.openings?.length).length,
        openingCount: shapes.reduce((n, shape) => n + openingCount(shape), 0),
        standingSurfaceCount: scanned.platforms.length,
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
      };
      const visual = { ...scanned, platforms: scanned.platforms.filter(platform => platform.tier !== 'text') };
      const planningStart = performance.now();
      graph = await reachableJumpsAsync(visual, undefined, signal);
      await yieldToBrowser(signal);
      level = chooseLevel(visual, { recent, graph });
      if (!level && scanned.platforms.some(platform => platform.tier === 'text')) {
        const textGraph = await reachableJumpsAsync(scanned, undefined, signal);
        level = chooseLevel(scanned, { recent, graph: textGraph });
        graph = textGraph;
      }
      if (!level) { level = await createFallbackLevelAsync(scanned, { recent }, signal); }
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
          let target = await chooseRewardAsync(level.world, player, graph, { patrols }, signal);
          if (!target && patrols.length) {
            patrols = [];
            target = await chooseRewardAsync(level.world, player, graph, {}, signal);
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
      stopWatching = watchPage(root, scanned, () => {
        pause();
        window.clearTimeout(resizeTimer);
        void regenerate();
      });
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
    if (mode === 'collect' && !collection.target) return;
    state = 'playing';
    pressed.clear();
    jumpQueued = false;
    lastFrame = performance.now();
    accumulator = 0;
    frameSamples.length = 0;
    updateControls();
    frameId = requestAnimationFrame(tick);
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
    pause();
    generation.abort();
    targetGeneration.abort();
    stopWatching?.();
    stopWatching = null;
    level = null;
    player = null;
    mapStats = null;
    collection.target = null;
    collection.checkpoint = null;
    state = 'generating';
    updateControls();
    draw();
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(regenerate, 180);
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
    stopWatching?.();
    cancelAnimationFrame(frameId);
    window.clearTimeout(resizeTimer);
    window.clearTimeout(downHoldTimer);
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
    if (state === 'playing' || state === 'selecting') pause();
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
    return { ...mapStats, scanTiming: mapStats.scanTiming ? { ...mapStats.scanTiming } : null,
      frameSamples: count, averageFps: count ? 1000 / average('interval') : null,
      frameP95Ms: count ? sorted[Math.ceil(count * .95) - 1]! : null,
      updateAverageMs: count ? average('update') : null, drawAverageMs: count ? average('draw') : null };
  }

  function getSessionStats(): SessionStats {
    const checkpoint = collection.checkpoint;
    const target = collection.target;
    const goal = mode === 'course' ? level?.world.platforms.find(platform => platform.id === level?.goalId) : null;
    return { mode, state, score: collection.score, elapsedSeconds: gameTime, targetSelectionMs,
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
