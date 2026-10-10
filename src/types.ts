export interface Platform {
  id: number;
  left: number;
  right: number;
  top: number;
  kind?: 'page' | 'helper';
  tier?: 'visual' | 'text';
  shapeId?: number;
  segmentId?: number;
  generated?: 'gap';
  blink?: { period: number; visibleSeconds: number; phase: number };
}

export interface Shape {
  id: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  radius: number;
  kind: 'rect' | 'ellipse' | 'polygon';
  points?: [number, number][];
  hollow?: boolean;
  openings?: { from: number; to: number }[];
  detail?: 'icon';
  control?: boolean;
  media?: boolean;
}

export interface BoundarySegment {
  id: number;
  shapeId: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface World {
  width: number;
  height: number;
  characterHeight: number;
  platforms: Platform[];
  walls?: { x: number; top: number; bottom: number }[];
  shapes?: Shape[];
  segments?: BoundarySegment[];
  contourStats?: ContourStats;
  scanTiming?: ScanTiming;
}

export interface ScanTiming {
  domMs: number;
  normalizeMs: number;
  openingsMs: number;
  surfacesMs: number;
  totalMs: number;
  elementsVisited: number;
}

export interface ContourStats {
  eligibleCount: number;
  renderedCount: number;
  omittedCount: number;
  complexityPercent: number | null;
}

export interface Player {
  x: number;
  footY: number;
  velocityY: number;
  groundedOn: number | null;
  crouching?: boolean;
  coyoteTime?: number;
  jumpBufferTime?: number;
  wallSide?: -1 | 0 | 1;
  wallJumpTime?: number;
  wallJumpDirection?: -1 | 0 | 1;
  event?: 'jump' | 'wall-jump' | 'land' | 'ceiling' | 'fast-fall';
}

export interface Controls {
  horizontal: -1 | 0 | 1;
  jump: boolean;
  crouch?: boolean;
  fastFall?: boolean;
}

export interface JumpRecipe {
  takeoffX: number;
  horizontal: -1 | 1;
  moveFrames: number;
  landedOn: number;
  landingX: number;
  kind?: 'jump' | 'wall-jump' | 'crouch' | 'walk';
  steps?: Controls[];
  takeoffCrouch?: boolean;
  landingCrouch?: boolean;
  wallJumps?: number;
}

export interface RouteMetrics {
  jumpCount: number;
  wallJumpCount: number;
  crouchCount: number;
  branchCount: number;
  minLandingMargin: number | null;
  toleranceRatio: number | null;
  testedVariants: number;
  successfulVariants: number;
  estimatedSeconds: number;
}

export interface Level {
  world: World;
  startId: number;
  goalId: number;
  startX: number;
  goalX: number;
  route: number[];
  recipes: JumpRecipe[];
  usedFallback?: boolean;
  metrics?: RouteMetrics;
}

export interface Patrol {
  id: number;
  platformId: number;
  left: number;
  right: number;
  footY: number;
  radius: number;
  period: number;
  phase: number;
}

export interface RewardTarget {
  platformId: number;
  x: number;
  footY: number;
  route: number[];
  /** A witness replayed against the full world and patrol clock. */
  actions: Controls[];
  startTime: number;
  jumpCount: number;
  wallJumpCount: number;
  crouchCount: number;
}
