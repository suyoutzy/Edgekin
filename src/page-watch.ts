import { getPageSnapshot } from './scanner.js';
import type { World } from './types.js';

/** Event-driven invalidation: no DOM scan or polling while a page is unchanged. */
export function watchPage(root: HTMLElement, world: World, invalidated: () => void): () => void {
  const tracked = getPageSnapshot(world);
  let timer = 0, disposed = false;
  const added = new Set<Element>();
  const ignored = (element: Element): boolean => Boolean(element.closest('[data-edgekin-ignore]'));
  function schedule(): void {
    if (timer || disposed) return;
    timer = window.setTimeout(check, 120);
  }
  function check(): void {
    timer = 0;
    if (disposed) return;
    const changed = tracked.some(snapshot => {
      if (!snapshot.element.isConnected) return true;
      const box = snapshot.element.getBoundingClientRect();
      return Math.abs(box.left - snapshot.left) > 1 || Math.abs(box.top - snapshot.top) > 1 ||
        Math.abs(box.width - snapshot.width) > 1 || Math.abs(box.height - snapshot.height) > 1;
    }) || [...added].some(element => {
      if (!element.isConnected || ignored(element)) return false;
      const box = element.getBoundingClientRect();
      return box.width >= 8 && box.height >= 8 && box.right > 0 && box.left < world.width &&
        box.bottom > 0 && box.top < world.height;
    });
    added.clear();
    if (changed) { dispose(); invalidated(); }
  }
  const mutations = new MutationObserver(records => {
    let relevant = false;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || ignored(target)) continue;
      relevant = true;
      for (const node of record.addedNodes) if (node instanceof Element && !ignored(node)) added.add(node);
    }
    if (relevant) schedule();
  });
  mutations.observe(root, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  for (const snapshot of tracked) resize.observe(snapshot.element);
  function dispose(): void {
    disposed = true;
    window.clearTimeout(timer);
    mutations.disconnect();
    resize.disconnect();
    added.clear();
  }
  schedule();
  return dispose;
}
