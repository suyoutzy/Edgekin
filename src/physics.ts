import type { Controls, Platform, Player, World } from './types.js';
import { horizontalSlice, surfaceY, verticalSlice } from './geometry.js';
import { segmentSlice } from './contours.js';
import { bodyHeight, playerWidth } from './dimensions.js';
import { platformIsActive } from './platform-state.js';
export { bodyHeight, characterHeight, CROUCH_RATIO, playerWidth } from './dimensions.js';

export const STEP_SECONDS = 1 / 60;
export const JUMP_BUFFER_SECONDS = .1;
export const COYOTE_SECONDS = .02;
export const WALL_KICK_SECONDS = .12;
const platformCaches = new WeakMap<World, { count: number; source: Platform[];
  byId: Map<number, Platform>; lines: Platform[] }>();
function platformsOf(world: World): { byId: Map<number, Platform>; lines: Platform[] } {
  let cache = platformCaches.get(world);
  if (!cache || cache.source !== world.platforms || cache.count !== world.platforms.length) {
    cache = { count: world.platforms.length, source: world.platforms,
      byId: new Map(world.platforms.map(platform => [platform.id, platform])),
      lines: world.platforms.filter(platform => platform.shapeId === undefined) };
    platformCaches.set(world, cache);
  }
  return cache;
}

export function movementSpeed(world: World): number {
  return world.characterHeight * 8.7;
}

export function jumpSpeed(world: World): number {
  return world.characterHeight * 18;
}

export function gravity(world: World): number {
  return world.characterHeight * 43;
}

/** Shared by stance changes, endpoint validation and route connections. */
export function canOccupy(world: World, x: number, footY: number, crouching = false,
  supportId?: number | null, seconds = 0): boolean {
  const half = playerWidth(world) / 2;
  const top = footY - bodyHeight(world, crouching);
  if (x - half < 0 || x + half > world.width || top < 0 || footY > world.height) return false;
  const surfaces = platformsOf(world);
  const support = supportId == null ? undefined : surfaces.byId.get(supportId);
  for (const shape of world.shapes ?? []) {
    if (shape.hollow || shape.id === support?.shapeId || shape.bottom <= top + .01 || shape.top >= footY - .01) continue;
    const slice = verticalSlice(shape, x - half + .001, x + half - .001);
    if (slice && footY > slice[0] + .01 && top < slice[1] - .01) return false;
  }
  for (const segment of world.segments ?? []) {
    if (segment.id === support?.segmentId) continue;
    const slice = segmentSlice(segment, x - half + .001, x + half - .001, 'x');
    if (slice && footY > slice[0] + .01 && top < slice[1] - .01) return false;
  }
  for (const wall of world.walls ?? []) {
    if (Math.abs(wall.x - x) < half - .001 && wall.top < footY - .01 && wall.bottom > top + .01) return false;
  }
  return !surfaces.lines.some(platform => platformIsActive(platform, seconds) && platform.id !== supportId &&
    x + half > platform.left && x - half < platform.right && platform.top > top + .01 && platform.top < footY - .01);
}

/** Only actual steep boundaries count as walls; viewport edges cannot be kicked. */
function touchingWall(world: World, x: number, footY: number, height: number): -1 | 0 | 1 {
  const half = playerWidth(world) / 2;
  const top = footY - height;
  const sideAt = (left: number, right: number): -1 | 0 | 1 => {
    if (Math.abs(x + half - left) < 1.5) return 1;
    if (Math.abs(x - half - right) < 1.5) return -1;
    return 0;
  };
  for (const shape of world.shapes ?? []) {
    if (shape.hollow || Math.min(footY, shape.bottom) - Math.max(top, shape.top) < height * .25) continue;
    const slice = horizontalSlice(shape, top + height * .2, footY - height * .2);
    if (slice) { const side = sideAt(slice[0], slice[1]); if (side) return side; }
  }
  for (const segment of world.segments ?? []) {
    if (Math.abs(segment.y2 - segment.y1) <= Math.abs(segment.x2 - segment.x1) * 2 ||
      Math.min(footY, Math.max(segment.y1, segment.y2)) - Math.max(top, Math.min(segment.y1, segment.y2)) < height * .25) continue;
    const slice = segmentSlice(segment, top + .001, footY - .001, 'y');
    if (slice) { const side = sideAt(slice[0], slice[1]); if (side) return side; }
  }
  for (const wall of world.walls ?? []) {
    if (Math.min(footY, wall.bottom) - Math.max(top, wall.top) < height * .25) continue;
    const side = sideAt(wall.x, wall.x); if (side) return side;
  }
  return 0;
}

export function spawnPlayer(platform: Platform, world: World, x = (platform.left + platform.right) / 2,
  crouching = false): Player {
  const half = playerWidth(world) / 2;
  x = platform.right - platform.left < half * 2 ? (platform.left + platform.right) / 2 :
    Math.max(platform.left + half, Math.min(platform.right - half, x));
  return {
    x,
    footY: surfaceY(platform, x, world),
    velocityY: 0,
    groundedOn: platform.id,
    crouching, coyoteTime: 0, jumpBufferTime: 0, wallSide: 0,
    wallJumpTime: 0, wallJumpDirection: 0,
  };
}

export function stepPlayer(player: Player, controls: Controls, world: World, dt = STEP_SECONDS, seconds = 0): Player {
  const halfWidth = playerWidth(world) / 2;
  const crouching = Boolean(controls.crouch || (player.crouching &&
    !canOccupy(world, player.x, player.footY, false, player.groundedOn, seconds)));
  const height = bodyHeight(world, crouching);
  let wallJumpTime = Math.max(0, (player.wallJumpTime ?? 0) - dt);
  let wallJumpDirection = player.wallJumpDirection ?? 0;
  const horizontal = wallJumpTime > 0 ? wallJumpDirection : controls.horizontal;
  let x = Math.max(halfWidth, Math.min(world.width - halfWidth,
    player.x + horizontal * movementSpeed(world) * (crouching ? 0.5 : 1) * dt));
  const bodyTop = player.footY - height;
  const surfaces = platformsOf(world);
  const ground = player.groundedOn === null ? undefined : surfaces.byId.get(player.groundedOn);
  for (const shape of world.shapes ?? []) {
    if (shape.hollow) continue;
    if (shape.id === ground?.shapeId) continue;
    const slice = horizontalSlice(shape, bodyTop + .001, player.footY - .001);
    if (!slice) continue;
    if (x > player.x && player.x + halfWidth <= slice[0] + .001 && x + halfWidth > slice[0]) {
      x = Math.min(x, slice[0] - halfWidth);
    } else if (x < player.x && player.x - halfWidth >= slice[1] - .001 && x - halfWidth < slice[1]) {
      x = Math.max(x, slice[1] + halfWidth);
    }
  }
  for (const segment of world.segments ?? []) {
    if (segment.id === ground?.segmentId) continue;
    const slice = segmentSlice(segment, bodyTop + .001, player.footY - .001, 'y');
    if (!slice) continue;
    if (x > player.x && player.x + halfWidth <= slice[0] + .001 && x + halfWidth > slice[0]) {
      x = Math.min(x, slice[0] - halfWidth);
    } else if (x < player.x && player.x - halfWidth >= slice[1] - .001 && x - halfWidth < slice[1]) {
      x = Math.max(x, slice[1] + halfWidth);
    }
  }
  for (const platform of surfaces.lines) {
    if (!platformIsActive(platform, seconds)) continue;
    if (bodyTop >= platform.top || player.footY <= platform.top) continue;
    if (x > player.x && player.x + halfWidth <= platform.left && x + halfWidth >= platform.left) {
      x = Math.min(x, platform.left - halfWidth);
    } else if (x < player.x && player.x - halfWidth >= platform.right && x - halfWidth <= platform.right) {
      x = Math.max(x, platform.right + halfWidth);
    }
  }
  for (const wall of world.walls ?? []) {
    if (player.footY <= wall.top || bodyTop >= wall.bottom) continue;
    if (x > player.x && player.x + halfWidth <= wall.x && x + halfWidth >= wall.x) {
      x = Math.min(x, wall.x - halfWidth);
    } else if (x < player.x && player.x - halfWidth >= wall.x && x - halfWidth <= wall.x) {
      x = Math.max(x, wall.x + halfWidth);
    }
  }
  let groundedOn = player.groundedOn;
  let velocityY = player.velocityY;
  let footY = player.footY;
  let event: Player['event'];
  let coyoteTime = Math.max(0, (player.coyoteTime ?? 0) - dt);
  let jumpBufferTime = crouching ? 0 : controls.jump ? JUMP_BUFFER_SECONDS :
    Math.max(0, (player.jumpBufferTime ?? 0) - dt);

  if (groundedOn !== null) {
    const surface = surfaces.byId.get(groundedOn);
    if (!surface || !platformIsActive(surface, seconds) || x + halfWidth <= surface.left || x - halfWidth >= surface.right) {
      groundedOn = null;
      coyoteTime = surface && platformIsActive(surface, seconds) ? COYOTE_SECONDS : 0;
    } else {
      footY = surfaceY(surface, x, world);
    }
  }

  const wallSide = groundedOn === null && jumpBufferTime > 0 ? touchingWall(world, x, footY, height) : 0;
  if (jumpBufferTime > 0 && !crouching && (groundedOn !== null || coyoteTime > 0 || wallSide)) {
    const wallJump = groundedOn === null && coyoteTime <= 0 && wallSide !== 0;
    groundedOn = null;
    velocityY = -jumpSpeed(world);
    coyoteTime = 0;
    jumpBufferTime = 0;
    event = wallJump ? 'wall-jump' : 'jump';
    if (wallJump) {
      wallJumpDirection = -wallSide as -1 | 1;
      wallJumpTime = WALL_KICK_SECONDS;
    }
  }

  if (groundedOn === null) {
    const previousFootY = footY;
    if (controls.fastFall) {
      if (velocityY < world.characterHeight * 22) event = 'fast-fall';
      velocityY = Math.max(velocityY, world.characterHeight * 22);
      jumpBufferTime = 0;
      coyoteTime = 0;
    }
    velocityY += gravity(world) * dt;
    footY += velocityY * dt;

    if (velocityY < 0) {
      let ceiling: Platform | undefined;
      const previousTop = previousFootY - height;
      const nextTop = footY - height;
      for (const shape of world.shapes ?? []) {
        if (shape.hollow) continue;
        const slice = verticalSlice(shape, x - halfWidth, x + halfWidth);
        if (slice && previousTop >= slice[1] - .001 && nextTop <= slice[1]) {
          footY = Math.max(footY, slice[1] + height);
          velocityY = 0;
          event = 'ceiling';
        }
      }
      for (const segment of world.segments ?? []) {
        const slice = segmentSlice(segment, x - halfWidth, x + halfWidth, 'x');
        if (slice && previousTop >= slice[1] - .001 && nextTop <= slice[1]) {
          footY = Math.max(footY, slice[1] + height);
          velocityY = 0;
          event = 'ceiling';
        }
      }
      for (const platform of surfaces.lines) {
        if (!platformIsActive(platform, seconds)) continue;
        if (previousTop >= platform.top - 0.001 && nextTop <= platform.top &&
          x + halfWidth > platform.left && x - halfWidth < platform.right &&
          (!ceiling || platform.top > ceiling.top)) ceiling = platform;
      }
      if (ceiling) {
        footY = Math.max(footY, ceiling.top + height);
        velocityY = 0;
        event = 'ceiling';
      }
    } else {
      let landing: Platform | undefined;
      for (const platform of world.platforms) {
        if (!platformIsActive(platform, seconds)) continue;
        if (x + halfWidth <= platform.left || x - halfWidth >= platform.right) continue;
        const y = surfaceY(platform, x, world);
        if (previousFootY <= y + 0.001 && footY >= y &&
          (!landing || y < surfaceY(landing, x, world))) {
          landing = platform;
        }
      }
      if (landing) {
        footY = surfaceY(landing, x, world);
        velocityY = 0;
        groundedOn = landing.id;
        coyoteTime = 0;
        wallJumpTime = 0;
        event = 'land';
      }
    }
  }

  const contact = groundedOn === null ? touchingWall(world, x, footY, height) : 0;
  return { x, footY, velocityY, groundedOn, crouching, coyoteTime, jumpBufferTime,
    wallSide: contact, wallJumpTime, wallJumpDirection, ...(event ? { event } : {}) };
}
