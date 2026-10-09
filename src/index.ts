import { assessRouteAsync, chooseLevel, endpointPair, reachableJumpsAsync, type EndpointPair } from './planner.js';
import { createFallbackLevelAsync } from './fallback.js';
import { spawnPlayer, stepPlayer, STEP_SECONDS } from './physics.js';
import { Renderer } from './renderer.js';
import { CONTOUR_BUDGET, scanPageAsync } from './scanner.js';
import { openingCount } from './contours.js';
import type { Level, Player, ScanTiming } from './types.js';
import { watchPage } from './page-watch.js';
import { throwIfAborted, yieldToBrowser } from './scheduling.js';

export interface EdgekinOptions {
  root?: HTMLElement;
  onComplete?: () => void;
}

export interface EdgekinInstance {
  start(): Promise<void>;
  pause(): void;
  regenerate(): Promise<void>;
  restart(): void;
  destroy(): void;
  getMapStats(): MapStats | null;
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

type State = 'idle' | 'generating' | 'playing' | 'paused' | 'complete' | 'unavailable' | 'destroyed';

const STYLE = `
.edgekin-controls{position:fixed;right:22px;top:22px;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:10px;max-width:min(380px,calc(100vw - 44px));padding:10px 12px;border:1px solid #d9d9d5;border-radius:14px;background:rgba(255,255,255,.95);box-shadow:0 8px 28px rgba(0,0,0,.12);font:13px/1.35 system-ui,sans-serif;color:#242424;pointer-events:auto}
.edgekin-controls button{border:0;border-radius:9px;background:#1b1b1b;color:white;font:600 13px system-ui,sans-serif;padding:8px 12px;cursor:pointer;white-space:nowrap}
.edgekin-controls button:focus-visible{outline:3px solid #f4a46f;outline-offset:2px}
.edgekin-controls span{min-width:0}
.edgekin-controls button:disabled{opacity:.55;cursor:wait}
.edgekin-controls button[hidden]{display:none}
`;

export function mountEdgekin(options: EdgekinOptions = {}): EdgekinInstance {
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
  const label = document.createElement('span');
  label.setAttribute('role', 'status');
  const button = document.createElement('button');
  button.type = 'button';
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.textContent = '回起点';
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
  const frameSamples: { interval: number; update: number; draw: number }[] = [];

  function updateControls(): void {
    const descriptions: Record<Exclude<State, 'destroyed'>, [string, string]> = {
      idle: ['网页边缘，随手一跳。', '开始'],
      generating: ['正在根据当前网页生成关卡…', '生成中'],
      playing: ['←/→ 移动 · ↑ 跳跃/借墙 · ↓ 下蹲', '暂停'],
      paused: [`已暂停 · ${mapStats?.outlineCount ?? 0}/${mapStats?.eligibleOutlineCount ?? 0} 个轮廓 · 复杂度 ${mapStats?.complexityPercent?.toFixed(1) ?? '—'}%`, '继续'],
      complete: ['通关！长按 ↓ 约 0.8 秒生成新关卡', '新关卡'],
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
      (pressed.has('ArrowLeft') || pressed.has('ArrowRight')), time, pressed.has('ArrowDown'));
  }

  function respawn(): void {
    if (!level) return;
    const start = level.world.platforms.find(platform => platform.id === level?.startId);
    if (start) player = spawnPlayer(start, level.world, level.startX);
    jumpQueued = false;
    if (mapStats) mapStats.retries++;
    renderer.clearFeedback();
    if (player) renderer.feedback('respawn', player.x, player.footY);
    draw();
  }

  function restart(): void {
    if (!level || state === 'destroyed' || state === 'generating') return;
    pause();
    respawn();
    state = 'paused';
    updateControls();
  }

  function tick(time: number): void {
    if (state !== 'playing' || !level || !player) return;
    const interval = time - lastFrame;
    const updateStart = performance.now();
    accumulator += Math.min((time - lastFrame) / 1000, 0.05);
    lastFrame = time;
    while (accumulator >= STEP_SECONDS && state === 'playing' && player) {
      const horizontal = Number(pressed.has('ArrowRight')) - Number(pressed.has('ArrowLeft'));
      player = stepPlayer(player, {
        horizontal: horizontal as -1 | 0 | 1,
        jump: jumpQueued,
        crouch: pressed.has('ArrowDown'),
      }, level.world);
      if (player.event) renderer.feedback(player.event, player.x, player.footY);
      jumpQueued = false;
      accumulator -= STEP_SECONDS;
      if (player.footY > level.world.height + level.world.characterHeight) respawn();
      if (player.groundedOn === level.goalId &&
        Math.abs(player.x - level.goalX) <= level.world.characterHeight * 0.65) {
        state = 'complete';
        pressed.clear();
        updateControls();
        renderer.feedback('complete', player.x, player.footY);
        options.onComplete?.();
      }
    }
    const update = performance.now() - updateStart;
    const drawStart = performance.now();
    draw(time);
    if (interval > 0) frameSamples.push({ interval, update, draw: performance.now() - drawStart });
    if (frameSamples.length > 120) frameSamples.shift();
    if (state === 'playing') frameId = requestAnimationFrame(tick);
  }

  function pause(): void {
    resumeRequested = false;
    window.clearTimeout(downHoldTimer);
    downHoldTimer = 0;
    if (state !== 'playing') return;
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
      let graph = await reachableJumpsAsync(visual, undefined, signal);
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
        state = 'paused';
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
    if (signal.aborted || !resumeRequested) return;
    if (!level || !player) return;
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
    if (state !== 'playing') return;
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
    if ((state === 'playing' || state === 'complete') &&
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
    stopWatching?.();
    stopWatching = null;
    level = null;
    player = null;
    mapStats = null;
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
  }

  function onButtonClick(): void {
    if (state === 'playing') pause();
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
  return { start, pause, regenerate, restart, destroy, getMapStats };
}

export type { Level, Platform, Player, Shape, World } from './types.js';
