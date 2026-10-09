import { mountEdgekin } from './index.js';

const marker = 'data-edgekin-extension-marker';
const existing = document.querySelector<HTMLElement>(`[${marker}]`);

if (existing) {
  existing.dispatchEvent(new Event('edgekin:toggle'));
} else if (document.body) {
  const node = document.createElement('span');
  node.setAttribute(marker, '');
  node.setAttribute('data-edgekin-ignore', '');
  node.hidden = true;
  document.documentElement.append(node);
  try {
    const game = mountEdgekin({ root: document.body });
    node.addEventListener('edgekin:toggle', () => {
      game.destroy();
      node.remove();
    }, { once: true });
  } catch (error) {
    node.remove();
    throw error;
  }
}
