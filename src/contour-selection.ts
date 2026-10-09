import type { ContourStats, Shape } from './types.js';

/** Candidates must already satisfy all contour rules, including normalization. */
export function selectContours(candidates: Shape[], budget: number): { shapes: Shape[]; stats: ContourStats } {
  const shapes = candidates.slice(0, Math.max(0, Math.floor(budget)));
  const eligibleCount = candidates.length;
  const renderedCount = shapes.length;
  return { shapes, stats: {
    eligibleCount, renderedCount, omittedCount: eligibleCount - renderedCount,
    complexityPercent: eligibleCount ? renderedCount / eligibleCount * 100 : null,
  } };
}
