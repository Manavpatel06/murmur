// Starling murmuration: CPU boids with a spatial hash, drawn as one InstancedMesh
// whose wings flap in the vertex shader.
import {
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from '@iwsdk/core';

export interface Force {
  kind: 'attract' | 'repel';
  point: Vector3;
  radius: number;
  strength: number;
}

const UP = new Vector3(0, 1, 0);

function birdGeometry(): BufferGeometry {
  // A flat chevron: body along +z, wings along ±x. 4.5 cm wingspan.
  const s = 0.013;
  const v = [
    // left wing
    0, 0, s * 0.9, -s, 0, -s * 0.2, 0, 0, -s * 0.5,
    // right wing
    0, 0, s * 0.9, 0, 0, -s * 0.5, s, 0, -s * 0.2,
  ];
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(v, 3));
  return g;
}

export class Flock {
  readonly count: number;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly mesh: InstancedMesh;
  center = new Vector3(0, 1.25, -1.1);
  radius = 1.5;
  minSpeed = 0.55;
  maxSpeed = 1.7;
  calm = 0; // 0..1, lowers speed for the ending
  leash = 1; // 1 = flock stays near its roost; lower while the player steers
  spread = 0.38; // radius of each bird's personal offset around a call point
  readonly phase: Float32Array;
  active: number; // birds currently simulated and drawn (lowered on slow devices)

  private cell = 0.22;
  private grid = new Map<number, number[]>();
  private m = new Matrix4();
  private q = new Quaternion();
  private v = new Vector3();
  private p = new Vector3();
  private s = new Vector3(1, 1, 1);
  private uTime = { value: 0 };

  constructor(count: number) {
    this.count = count;
    this.active = count;
    this.phase = new Float32Array(count);
    for (let i = 0; i < count; i++) this.phase[i] = Math.random() * 100;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = Math.cbrt(Math.random()) * 0.6;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      this.pos[i * 3] = this.center.x + r * Math.sin(ph) * Math.cos(th);
      this.pos[i * 3 + 1] = this.center.y + r * Math.cos(ph) * 0.5;
      this.pos[i * 3 + 2] = this.center.z + r * Math.sin(ph) * Math.sin(th);
      this.vel[i * 3] = Math.cos(th) * 0.8;
      this.vel[i * 3 + 1] = 0;
      this.vel[i * 3 + 2] = Math.sin(th) * 0.8;
    }

    const geo = birdGeometry();
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) phase[i] = Math.random() * 6.283;
    geo.setAttribute('aPhase', new InstancedBufferAttribute(phase, 1));

    const mat = new MeshBasicMaterial({ color: new Color(0x16131a), side: 2 });
    const uTime = this.uTime;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aPhase;\nuniform float uTime;',
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float flap = sin(uTime * 15.0 + aPhase) * abs(position.x) * 0.9;
           transformed.y += flap;`,
        );
    };

    this.mesh = new InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    const tint = new Color();
    for (let i = 0; i < count; i++) {
      tint.setHSL(0.72 + Math.random() * 0.06, 0.15, 0.06 + Math.random() * 0.08);
      this.mesh.setColorAt(i, tint);
    }
  }

  private key(x: number, y: number, z: number) {
    const c = this.cell;
    return (
      ((Math.floor(x / c) + 512) * 1048576) +
      ((Math.floor(y / c) + 512) * 1024) +
      (Math.floor(z / c) + 512)
    );
  }

  update(dt: number, time: number, forces: Force[], wind: Vector3) {
    dt = Math.min(dt, 0.05);
    this.uTime.value = time;
    const { pos, vel } = this;
    const count = this.active;
    this.mesh.count = count;

    // Rebuild the spatial hash.
    for (const list of this.grid.values()) list.length = 0;
    for (let i = 0; i < count; i++) {
      const k = this.key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      let list = this.grid.get(k);
      if (!list) this.grid.set(k, (list = []));
      list.push(i);
    }

    const nr = 0.3;
    const nr2 = nr * nr;
    const sep2 = 0.085 * 0.085;
    const maxSpeed = this.maxSpeed * (1 - 0.5 * this.calm);
    const minSpeed = this.minSpeed * (1 - 0.4 * this.calm);
    const c = this.cell;

    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      const px = pos[ix], py = pos[ix + 1], pz = pos[ix + 2];
      let ax = 0, ay = 0, az = 0; // alignment
      let cx = 0, cy = 0, cz = 0; // cohesion
      let sx = 0, sy = 0, sz = 0; // separation
      let n = 0;
      const gx = Math.floor(px / c), gy = Math.floor(py / c), gz = Math.floor(pz / c);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (let oz = -1; oz <= 1; oz++) {
            const list = this.grid.get(
              (gx + ox + 512) * 1048576 + (gy + oy + 512) * 1024 + (gz + oz + 512),
            );
            if (!list) continue;
            for (let li = 0; li < list.length && n < 7; li++) {
              const j = list[li];
              if (j === i) continue;
              const jx = j * 3;
              const dx = pos[jx] - px, dy = pos[jx + 1] - py, dz = pos[jx + 2] - pz;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > nr2) continue;
              n++;
              ax += vel[jx]; ay += vel[jx + 1]; az += vel[jx + 2];
              cx += dx; cy += dy; cz += dz;
              if (d2 < sep2) {
                const inv = 1 / (d2 + 1e-4);
                sx -= dx * inv * 0.009; sy -= dy * inv * 0.009; sz -= dz * inv * 0.009;
              }
            }
          }

      let fx = 0, fy = 0, fz = 0;
      if (n > 0) {
        fx += (ax / n - vel[ix]) * 1.6 + (cx / n) * 0.8 + sx;
        fy += (ay / n - vel[ix + 1]) * 1.6 + (cy / n) * 0.8 + sy;
        fz += (az / n - vel[ix + 2]) * 1.6 + (cz / n) * 0.8 + sz;
      }

      // Soft boundary around the play volume, flattened vertically.
      const bx = px - this.center.x, by = (py - this.center.y) * 1.6, bz = pz - this.center.z;
      const bd = Math.sqrt(bx * bx + by * by + bz * bz);
      if (bd > this.radius) {
        // The leash relaxes while the player is steering, so a called flock can leave its roost.
        const over = bd - this.radius;
        const k = (over * 4 * this.leash + Math.max(0, over - 1.4) * 6) / bd;
        fx -= bx * k; fy -= by * k; fz -= bz * k;
      }
      if (py < 0.35) fy += (0.35 - py) * 12;

      // Each bird aims at its own slowly drifting spot around a call, so a called flock forms a
      // breathing cloud rather than collapsing into one ball.
      const ph = this.phase[i];
      const ox = Math.sin(time * 0.7 + ph) * this.spread, oy = Math.sin(time * 0.9 + ph * 1.7) * this.spread * 0.6, oz = Math.cos(time * 0.6 + ph * 2.3) * this.spread;
      for (const f of forces) {
        const own = f.kind === 'attract' && f.radius === 0;
        const dx = f.point.x + (own ? ox : 0) - px, dy = f.point.y + (own ? oy : 0) - py, dz = f.point.z + (own ? oz : 0) - pz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
        if (f.kind === 'attract') {
          if (f.radius > 0 && d > f.radius) continue; // local funnel, e.g. around a gate
          // Seek: steer the velocity toward the point (not just accelerate), so birds fly
          // *through* it instead of orbiting wide around it. A little sideways swirl keeps
          // the stream alive once it arrives.
          const g = f.strength * 1.1;
          const ux = dx / d, uy = dy / d, uz = dz / d;
          const swirl = f.radius > 0 ? 0 : 0.35;
          fx += (ux * this.maxSpeed - vel[ix]) * g - uz * swirl * f.strength;
          fy += (uy * this.maxSpeed - vel[ix + 1]) * g;
          fz += (uz * this.maxSpeed - vel[ix + 2]) * g + ux * swirl * f.strength;
        } else if (d < f.radius) {
          const k = -f.strength * (1 - d / f.radius) / d;
          fx += dx * k; fy += dy * k; fz += dz * k;
        }
      }

      fx += wind.x; fy += wind.y; fz += wind.z;

      let vx = vel[ix] + fx * dt, vy = vel[ix + 1] + fy * dt, vz = vel[ix + 2] + fz * dt;
      let sp = Math.sqrt(vx * vx + vy * vy + vz * vz) + 1e-6;
      const clamped = Math.min(maxSpeed, Math.max(minSpeed, sp));
      vx *= clamped / sp; vy *= clamped / sp; vz *= clamped / sp;
      vel[ix] = vx; vel[ix + 1] = vy; vel[ix + 2] = vz;
      pos[ix] = px + vx * dt; pos[ix + 1] = py + vy * dt; pos[ix + 2] = pz + vz * dt;
    }

    for (let i = 0; i < count; i++) {
      const ix = i * 3;
      this.p.set(pos[ix], pos[ix + 1], pos[ix + 2]);
      this.v.set(vel[ix], vel[ix + 1], vel[ix + 2]).normalize();
      this.q.setFromUnitVectors(FORWARD, this.v);
      // Bank slightly into turns by keeping wings roughly level to world up.
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Regroup the whole flock in a small ball (used once, so it starts at its roost). */
  gatherAt(c: Vector3, r: number) {
    for (let i = 0; i < this.count; i++) {
      const u = Math.cbrt(Math.random()) * r;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      this.pos[i * 3] = c.x + u * Math.sin(ph) * Math.cos(th);
      this.pos[i * 3 + 1] = c.y + u * Math.cos(ph) * 0.6;
      this.pos[i * 3 + 2] = c.z + u * Math.sin(ph) * Math.sin(th);
    }
  }

  averageSpeed(): number {
    let s = 0;
    const step = 8;
    let n = 0;
    for (let i = 0; i < this.count; i += step) {
      const ix = i * 3;
      s += Math.hypot(this.vel[ix], this.vel[ix + 1], this.vel[ix + 2]);
      n++;
    }
    return n ? s / n : 0;
  }
}

const FORWARD = new Vector3(0, 0, 1);
void UP;
