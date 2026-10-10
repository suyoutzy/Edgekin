import type { Level, Patrol, Player, RewardTarget } from './types.js';
import { surfaceY } from './geometry.js';
import { bodyHeight } from './physics.js';
import { patrolPosition } from './hazards.js';

type FeedbackType = NonNullable<Player['event']> | 'respawn' | 'complete' | 'collect' | 'hit';

interface RunView {
  mode: 'collect' | 'course';
  target: RewardTarget | null;
  checkpoint: Player | null;
  patrols: readonly Patrol[];
  seconds: number;
  invulnerable: boolean;
}

export class Renderer {
  private readonly context: CanvasRenderingContext2D;
  private effects: { type: FeedbackType; x: number; y: number; time: number }[] = [];

  clearFeedback(): void { this.effects.length = 0; }

  feedback(type: FeedbackType, x: number, y: number): void {
    this.effects.push({ type, x, y, time: performance.now() });
    if (this.effects.length > 8) this.effects.shift();
  }

  constructor(readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Edgekin needs Canvas 2D support.');
    this.context = context;
  }

  resize(width: number, height: number): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  draw(level: Level | null, player: Player | null, moving: boolean, time: number,
    crouching = false, run?: RunView): void {
    const context = this.context;
    context.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    if (!level || !player) return;
    const { world } = level;
    const size = world.characterHeight;

    context.strokeStyle = '#1376b5';
    context.lineWidth = 2.5;
    context.shadowColor = 'rgba(255,255,255,.85)';
    context.shadowBlur = 3;
    context.setLineDash([]);
    context.lineCap = 'butt';
    context.lineJoin = 'round';
    context.beginPath();
    for (const shape of world.shapes ?? []) {
      if (shape.hollow) continue;
      if (shape.kind === 'ellipse') {
        context.moveTo(shape.right, (shape.top + shape.bottom) / 2);
        context.ellipse((shape.left + shape.right) / 2, (shape.top + shape.bottom) / 2,
          (shape.right - shape.left) / 2, (shape.bottom - shape.top) / 2, 0, 0, Math.PI * 2);
      } else {
        context.roundRect(shape.left, shape.top, shape.right - shape.left,
          shape.bottom - shape.top, shape.radius);
      }
    }
    for (const segment of world.segments ?? []) {
      context.moveTo(segment.x1, segment.y1);
      context.lineTo(segment.x2, segment.y2);
    }
    context.stroke();

    // Keep every collision edge visible; emphasize the local space without
    // removing distant geometry or drawing a prescribed solution.
    const nearby = (left: number, right: number, top: number, bottom: number): boolean =>
      Math.hypot(Math.max(left - player.x, player.x - right, 0),
        Math.max(top - player.footY, player.footY - bottom, 0)) < size * 5;
    context.strokeStyle = '#0797c9';
    context.lineWidth = 3.5;
    context.beginPath();
    for (const shape of world.shapes ?? []) {
      if (shape.hollow || !nearby(shape.left, shape.right, shape.top, shape.bottom)) continue;
      if (shape.kind === 'ellipse') {
        context.moveTo(shape.right, (shape.top + shape.bottom) / 2);
        context.ellipse((shape.left + shape.right) / 2, (shape.top + shape.bottom) / 2,
          (shape.right - shape.left) / 2, (shape.bottom - shape.top) / 2, 0, 0, Math.PI * 2);
      } else context.roundRect(shape.left, shape.top, shape.right - shape.left,
        shape.bottom - shape.top, shape.radius);
    }
    for (const segment of world.segments ?? []) {
      if (!nearby(Math.min(segment.x1, segment.x2), Math.max(segment.x1, segment.x2),
        Math.min(segment.y1, segment.y2), Math.max(segment.y1, segment.y2))) continue;
      context.moveTo(segment.x1, segment.y1);
      context.lineTo(segment.x2, segment.y2);
    }
    context.stroke();

    for (const platform of world.platforms) {
      if (platform.shapeId !== undefined) continue;
      context.strokeStyle = platform.generated === 'gap' ? '#8554bf' : platform.kind === 'helper' ? '#e85a24' : '#1376b5';
      context.lineWidth = platform.kind === 'helper' ? 3 : 3.5;
      context.shadowColor = 'rgba(255,255,255,.9)';
      context.shadowBlur = 4;
      context.setLineDash(platform.kind === 'helper' && !platform.generated ? [7, 5] : []);
      context.beginPath();
      context.moveTo(platform.left, platform.top - 1);
      context.lineTo(platform.right, platform.top - 1);
      context.stroke();
    }
    context.setLineDash([]);
    for (const wall of world.walls ?? []) {
      context.strokeStyle = '#1376b5';
      context.lineWidth = 3.5;
      context.beginPath();
      context.moveTo(wall.x, wall.top);
      context.lineTo(wall.x, wall.bottom);
      context.stroke();
    }
    context.shadowBlur = 0;

    const start = world.platforms.find(platform => platform.id === level.startId);
    const goal = world.platforms.find(platform => platform.id === level.goalId);
    if (run?.mode === 'collect') {
      if (run.checkpoint) this.drawFlag(run.checkpoint.x, run.checkpoint.footY, '返回点', '#278257', size);
      if (run.target) this.drawCoin(run.target.x, run.target.footY - size * .55, size, run.seconds);
      for (const patrol of run.patrols) this.drawPatrol(patrol, run.seconds);
    } else {
      if (start) this.drawFlag(level.startX, surfaceY(start, level.startX, world), 'START', '#333333', size);
      if (goal) this.drawFlag(level.goalX, surfaceY(goal, level.goalX, world), 'GOAL', '#d94e35', size);
    }

    const x = player.x;
    const pose = bodyHeight(world, player.crouching ?? crouching);
    const top = player.footY - pose;
    const swing = moving ? Math.sin(time / 95) * pose * 0.14 : 0;
    const airborne = player.groundedOn === null;
    context.shadowColor = 'rgba(255,255,255,.95)';
    context.shadowBlur = Math.max(3, size * 0.18);
    context.strokeStyle = '#111111';
    context.fillStyle = '#111111';
    context.lineWidth = Math.max(2.5, size * 0.09);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (run?.invulnerable) context.globalAlpha = Math.sin(run.seconds * 24) > 0 ? .45 : 1;
    context.beginPath();
    context.arc(x, top + pose * 0.16, size * 0.11, 0, Math.PI * 2);
    context.fill();
    const shoulderY = top + pose * 0.34;
    const hipY = top + pose * 0.67;
    context.beginPath();
    context.moveTo(x, shoulderY);
    context.lineTo(x, hipY);
    context.moveTo(x, shoulderY + pose * 0.04);
    context.lineTo(x - pose * 0.17, top + pose * (airborne ? 0.28 : 0.55) + swing * 0.5);
    context.moveTo(x, shoulderY + pose * 0.04);
    context.lineTo(x + pose * 0.17, top + pose * (airborne ? 0.28 : 0.55) - swing * 0.5);
    context.moveTo(x, hipY);
    context.lineTo(x - pose * 0.16, player.footY - (airborne ? pose * 0.16 : 0) - swing);
    context.moveTo(x, hipY);
    context.lineTo(x + pose * 0.16, player.footY - (airborne ? pose * 0.16 : 0) + swing);
    context.stroke();
    context.globalAlpha = 1;
    context.shadowBlur = 0;
    if (player.wallSide && !player.crouching && airborne) {
      context.font = 'bold 14px system-ui';
      context.textAlign = 'center';
      context.fillStyle = '#ffffff';
      context.fillRect(x - player.wallSide * size * .8 - 7, top, 14, 18);
      context.fillStyle = '#1376b5';
      context.fillText('↑', x - player.wallSide * size * .8, top + 14);
    }
    this.effects = this.effects.filter(effect => time - effect.time < 240);
    for (const effect of this.effects) {
      const progress = Math.max(0, Math.min(1, (time - effect.time) / 240));
      context.globalAlpha = 1 - progress;
      context.strokeStyle = effect.type === 'ceiling' || effect.type === 'hit' ? '#d94e35' :
        effect.type === 'collect' ? '#d69b00' : '#0797c9';
      context.lineWidth = 2;
      context.beginPath();
      const radius = size * (.12 + progress * .6);
      context.arc(effect.x, effect.type === 'ceiling' ? effect.y - pose : effect.y,
        radius, effect.type === 'land' ? Math.PI : 0, Math.PI * 2);
      context.stroke();
      if (effect.type === 'collect') {
        context.font = 'bold 16px system-ui';
        context.textAlign = 'center';
        context.fillStyle = '#b67c00';
        context.fillText('+1', effect.x, effect.y - size * (1 + progress));
      }
    }
    context.globalAlpha = 1;
  }

  private drawCoin(x: number, y: number, size: number, seconds: number): void {
    const context = this.context;
    const radius = size * .24;
    context.shadowColor = 'rgba(255,255,255,.95)';
    context.shadowBlur = 5;
    context.fillStyle = '#ffd54a';
    context.strokeStyle = '#a76b00';
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(x, y, radius * (.7 + .3 * Math.cos(seconds * 4) ** 2), radius, 0, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.shadowBlur = 0;
    context.fillStyle = '#825500';
    context.font = `bold ${Math.round(size * .3)}px system-ui`;
    context.textAlign = 'center';
    context.fillText('1', x, y + size * .1);
  }

  private drawPatrol(patrol: Patrol, seconds: number): void {
    const context = this.context;
    const { x, y } = patrolPosition(patrol, seconds);
    context.fillStyle = '#e4443f';
    context.strokeStyle = '#982823';
    context.lineWidth = 2;
    context.shadowColor = 'white';
    context.shadowBlur = 4;
    context.beginPath();
    context.arc(x, y, patrol.radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.shadowBlur = 0;
    context.font = `bold ${Math.round(patrol.radius * 1.6)}px system-ui`;
    context.textAlign = 'center';
    context.fillStyle = '#ffffff';
    context.fillText('!', x, y + patrol.radius * .55);
    context.fillStyle = '#b33d36';
    for (const endpoint of [patrol.left, patrol.right]) {
      context.beginPath();
      context.arc(endpoint, patrol.footY + 4, 2, 0, Math.PI * 2);
      context.fill();
    }
  }

  private drawFlag(x: number, y: number, label: string, color: string, size: number): void {
    const context = this.context;
    const poleTop = y - size * 1.45;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 2;
    context.shadowColor = 'rgba(255,255,255,.95)';
    context.shadowBlur = 5;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x, poleTop);
    context.stroke();
    context.beginPath();
    context.moveTo(x, poleTop);
    context.lineTo(x + size * 0.55, poleTop + size * 0.17);
    context.lineTo(x, poleTop + size * 0.34);
    context.closePath();
    context.fill();
    context.shadowBlur = 0;
    context.font = '600 11px system-ui, sans-serif';
    context.textAlign = 'center';
    const labelWidth = context.measureText(label).width + 12;
    context.fillStyle = 'rgba(255,255,255,.95)';
    context.fillRect(x - labelWidth / 2, poleTop - 22, labelWidth, 16);
    context.fillStyle = color;
    context.fillText(label, x, poleTop - 10);
  }
}
