export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Generation cancelled', 'AbortError');
}

/** Give controls and the browser a chance to paint between generation batches. */
export async function yieldToBrowser(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  throwIfAborted(signal);
}
