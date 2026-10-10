import { getPageSnapshot, potentialSurface, surfaceSignature } from './scanner.js';
import type { World } from './types.js';

export interface PageChange { removedSourceIds: number[] }

/** Events are coalesced; the watcher stays live while a background scan runs. */
export function watchPage(root: HTMLElement, world: World, invalidated: (change: PageChange) => void): () => void {
  const tracked = getPageSnapshot(world);
  let timer = 0, disposed = false;
  const changedElements = new Set<Element>();
  const ignored = (element: Element): boolean => Boolean(element.closest('[data-edgekin-ignore]'));
  const seen = new Map(tracked.map(snapshot => [snapshot.element, { ...snapshot }]));
  function schedule(): void {
    if (timer || disposed) return;
    timer = window.setTimeout(check, 120);
  }
  function check(): void {
    timer = 0;
    if (disposed) return;
    let changed = false;
    const removed: number[] = [];
    for (const [element, snapshot] of seen) {
      if (!element.isConnected || !root.contains(element)) {
        removed.push(snapshot.sourceId); seen.delete(element); changed = true; continue;
      }
      const box = element.getBoundingClientRect();
      const signature = changedElements.has(element) ? surfaceSignature(element) : snapshot.signature;
      if (box.width < .01 || box.height < .01 || (changedElements.has(element) &&
        (getComputedStyle(element).visibility !== 'visible' || Number(getComputedStyle(element).opacity) === 0))) {
        removed.push(snapshot.sourceId); seen.delete(element); changed = true; continue;
      }
      if (Math.abs(box.left - snapshot.left) > 1 || Math.abs(box.top - snapshot.top) > 1 ||
        Math.abs(box.width - snapshot.width) > 1 || Math.abs(box.height - snapshot.height) > 1 || signature !== snapshot.signature) {
        changed = true;
        Object.assign(snapshot, { left: box.left, top: box.top, width: box.width, height: box.height, signature });
      }
    }
    for (const element of changedElements) {
      if (!element.isConnected || ignored(element) || seen.has(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.width >= 8 && box.height >= 8 && box.right > 0 && box.left < world.width &&
        box.bottom > 0 && box.top < world.height && potentialSurface(element)) { changed = true; break; }
    }
    changedElements.clear();
    if (changed) invalidated({ removedSourceIds: removed });
  }
  const mutations = new MutationObserver(records => {
    let relevant = false;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || ignored(target)) continue;
      relevant = true;
      changedElements.add(target);
      for (const element of seen.keys()) if (element.contains(target)) changedElements.add(element);
      if (record.type === 'attributes') {
        changedElements.add(target);
        for (const element of seen.keys()) if (target.contains(element)) changedElements.add(element);
      }
      for (const node of record.addedNodes) if (node instanceof Element && !ignored(node)) {
        changedElements.add(node);
        for (const element of node.querySelectorAll('*')) if (!ignored(element)) changedElements.add(element);
      }
    }
    if (relevant) schedule();
  });
  mutations.observe(root, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['style', 'class', 'hidden', 'src', 'width', 'height'] });
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  for (const snapshot of tracked) resize.observe(snapshot.element);
  function dispose(): void {
    disposed = true;
    window.clearTimeout(timer);
    mutations.disconnect();
    resize.disconnect();
    changedElements.clear();
  }
  schedule();
  return dispose;
}
