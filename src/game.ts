// MURMUR game loop: hands -> forces -> flock, plus gates, levels, HUD and sound.
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  createSystem,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  TorusGeometry,
  Vector3,
  VisibilityState,
  XRPlane,
} from '@iwsdk/core';
import { Flock, type Force } from './flock.js';
import { HandReader, type HandState } from './hands.js';
import { MurmurAudio } from './audio.js';

interface Gate {
  mesh: Mesh;
  pos: Vector3;
  normal: Vector3;
  radius: number;
  passed: Uint8Array;
  passedCount: number;
  done: boolean;
  drift?: (t: number, out: Vector3) => void;
  funnel: Force;
}

interface Level {
  title: string;
  hint: string;
  goal: number; // fraction of the flock that must fly through each gate
  gates: Array<{ at: [number, number, number]; drift?: Gate['drift'] }>;
  hawk?: boolean;
  wind?: [number, number, number];
}

// Positions are relative to where the player sits when the level starts.
const LEVELS: Level[] = [
  {
    title: 'I. Call',
    hint: 'Hold out an open palm. The flock follows your hand.',
    goal: 0.5,
    gates: [{ at: [0.55, 1.3, -1.0] }],
  },
  {
    title: 'II. Scatter',
    hint: 'Close a fist to become the hawk. Split the flock between gates.',
    goal: 0.4,
    gates: [{ at: [-0.7, 1.15, -1.4] }, { at: [0.7, 1.45, -1.4] }],
  },
  {
    title: 'III. Draw',
    hint: 'Pinch and draw a path in the air. Release, and the flock flies it.',
    goal: 0.45,
    gates: [{ at: [-0.95, 1.5, -0.8] }, { at: [0.95, 1.1, -0.9] }],
  },
  {
    title: 'IV. Drift',
    hint: 'The gate is moving. Lead the flock to where it will be.',
    goal: 0.45,
    gates: [
      {
        at: [0, 1.3, -1.2],
        drift: (t, out) => out.set(Math.sin(t * 0.45) * 0.9, 1.3 + Math.sin(t * 0.7) * 0.25, -1.2),
      },
    ],
    wind: [0.25, 0, 0],
  },
  {
    title: 'V. Hawk',
    hint: 'A wild hawk is hunting. Shield your flock with an open palm.',
    goal: 0.4,
    gates: [{ at: [-0.6, 1.5, -1.3] }, { at: [0.65, 1.15, -1.0] }, { at: [0, 1.75, -1.1] }],
    hawk: true,
  },
];

const FLOCK_SIZE = 900;

export class MurmurSystem extends createSystem({
  planes: { required: [XRPlane] },
}) {
  private flock!: Flock;
  private hands = new HandReader();
  private audio = new MurmurAudio();
  private forces: Force[] = [];
  private pool: Force[] = [];
  private wind = new Vector3();
  private gates: Gate[] = [];
  private levelIndex = -1;
  private levelTime = 0;
  private hud!: { mesh: Mesh; ctx: CanvasRenderingContext2D; tex: CanvasTexture; last: string };
  private origin = new Vector3();

  // Pinch-drawn path that the flock then follows.
  private drawing: Vector3[] = [];
  private path: Vector3[] = [];
  private pathT = 0;
  private pathLine!: Line;
  private lure = new Vector3();

  private hawk = new Vector3(2, 2, -2);
  private hawkVel = new Vector3(-0.6, 0, 0.2);
  private hawkMesh!: Mesh;
  private cues: Mesh[] = [];
  private tmpDir = new Vector3();
  private levelTimes: number[] = [];
  private slowFrames = 0;
  private finished = false;
  private startDelay = -1;
  private lastLog = -1;

  init() {
    this.flock = new Flock(FLOCK_SIZE);
    this.scene.add(this.flock.mesh);

    for (let i = 0; i < 7; i++) {
      this.pool.push({ kind: 'attract', point: new Vector3(), radius: 0, strength: 0 });
    }

    const lineGeo = new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]);
    this.pathLine = new Line(
      lineGeo,
      new LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.8 }),
    );
    this.pathLine.frustumCulled = false;
    this.scene.add(this.pathLine);

    const hawkGeo = new BufferGeometry().setFromPoints([
      new Vector3(0, 0, 0.09), new Vector3(-0.16, 0.02, -0.02), new Vector3(0, 0, -0.03),
      new Vector3(0, 0, 0.09), new Vector3(0, 0, -0.03), new Vector3(0.16, 0.02, -0.02),
      new Vector3(0, 0, -0.03), new Vector3(-0.035, 0, -0.1), new Vector3(0.035, 0, -0.1),
    ]);
    this.hawkMesh = new Mesh(hawkGeo, new MeshBasicMaterial({ color: 0x8a1c12, side: 2 }));
    this.hawkMesh.visible = false;
    this.scene.add(this.hawkMesh);

    this.hud = this.makeHud();

    // A soft ring under each palm shows which gesture the game is reading.
    for (let i = 0; i < 2; i++) {
      const cue = new Mesh(
        new TorusGeometry(0.06, 0.006, 8, 40),
        new MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0, depthWrite: false }),
      );
      cue.renderOrder = 5;
      this.scene.add(cue);
      this.cues.push(cue);
    }

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (state === VisibilityState.Visible && this.levelIndex < 0) {
          this.audio.start();
          // Wait for the headset pose to settle before placing gates around the player.
          this.startDelay = 1.0;
        }
      }),
    );
    this.setHud('MURMUR', 'Enter mixed reality to begin.');
  }

  private makeHud() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const tex = new CanvasTexture(canvas);
    const mesh = new Mesh(
      new PlaneGeometry(0.44, 0.11),
      new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    mesh.renderOrder = 10;
    this.scene.add(mesh);
    return { mesh, ctx, tex, last: '' };
  }

  private setHud(title: string, line: string, progress = -1) {
    const key = title + '|' + line + '|' + progress;
    if (this.hud.last === key) return;
    this.hud.last = key;
    const { ctx, tex } = this.hud;
    ctx.clearRect(0, 0, 1024, 256);
    ctx.fillStyle = 'rgba(12,10,18,0.62)';
    ctx.beginPath();
    ctx.roundRect(8, 8, 1008, 240, 40);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd27a';
    ctx.font = '600 58px system-ui, sans-serif';
    ctx.fillText(title, 512, 78);
    ctx.fillStyle = '#f2eee8';
    ctx.font = '400 36px system-ui, sans-serif';
    const words = line.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (ctx.measureText(next).width > 920 && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, 512, 135 + i * 44));
    if (progress >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(112, 222, 800, 10);
      ctx.fillStyle = '#8fd3ff';
      ctx.fillRect(112, 222, 800 * Math.min(1, progress), 10);
    }
    tex.needsUpdate = true;
  }

  private startLevel(i: number) {
    for (const g of this.gates) {
      this.scene.remove(g.mesh);
      g.mesh.geometry.dispose();
    }
    this.gates = [];
    this.path = [];
    this.levelIndex = i;
    if (i > 0) this.levelTimes.push(this.levelTime);
    this.levelTime = 0;
    if (i >= LEVELS.length) {
      this.finished = true;
      if (import.meta.env.DEV) console.log(`[lvl] ${i} 100% t=0 birds=${this.flock.active}`);
      this.hawkMesh.visible = false;
      this.wind.set(0, 0, 0);
      // Bring the roost down in front of the player for the finale.
      const h = this.viewCam().getWorldPosition(new Vector3());
      // Straight ahead of where the player sits (the level origin), not wherever they happen to look.
      this.flock.center.set(this.origin.x, h.y - 0.05, this.origin.z - 1.5);
      this.flock.radius = 0.9;
      const total = this.levelTimes.reduce((a, b) => a + b, 0);
      const m = Math.floor(total / 60);
      const sec = Math.round(total % 60).toString().padStart(2, '0');
      this.setHud(
        `Murmuration complete  ${m}:${sec}`,
        'Free Flight: the sky is yours. Lower your hands and the flock comes to rest.',
      );
      this.audio.fanfare();
      return;
    }

    const head = this.viewCam().getWorldPosition(new Vector3());
    this.origin.set(head.x, 0, head.z);
    // The flock roosts high and far until you call it, so gates need deliberate play.
    const prev = this.flock.center.clone();
    this.flock.center.set(head.x, head.y + 0.3, head.z - 1.6);
    if (i === 0) this.flock.gatherAt(this.flock.center, 0.35);
    void prev;
    this.flock.radius = 0.6;

    const level = LEVELS[i];
    this.wind.set(...(level.wind ?? [0, 0, 0]));
    this.hawkMesh.visible = !!level.hawk;
    this.hawk.set(this.origin.x + 2, 1.8, this.origin.z - 2);

    for (const spec of level.gates) {
      const pos = this.placeOnRoom(new Vector3(...spec.at).add(this.origin), head);
      const mesh = new Mesh(
        new TorusGeometry(0.22, 0.016, 12, 64),
        new MeshBasicMaterial({ color: new Color(0x7fd8ff), transparent: true, opacity: 0.95 }),
      );
      const halo = new Mesh(
        new TorusGeometry(0.22, 0.045, 8, 64),
        new MeshBasicMaterial({
          color: new Color(0x7fd8ff),
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      );
      mesh.add(halo);
      mesh.position.copy(pos);
      mesh.lookAt(head);
      this.scene.add(mesh);
      this.gates.push({
        mesh,
        pos,
        normal: head.clone().sub(pos).normalize(),
        radius: 0.32, // forgiving capture sphere around the 22 cm ring
        passed: new Uint8Array(FLOCK_SIZE),
        passedCount: 0,
        done: false,
        drift: spec.drift,
        // Birds that come close get drawn gently through the ring.
        funnel: { kind: 'attract', point: pos, radius: 0.42, strength: 1.4 },
      });
    }
    this.setHud(level.title, level.hint);
    this.audio.chime(0.5);
  }

  /**
   * Room-aware placement: if the headset has mapped a real wall between you and a
   * gate, pull the gate in so it floats 40 cm in front of that wall instead of
   * disappearing into it. Works for a small dorm room or a big living room.
   */
  private placeOnRoom(p: Vector3, head: Vector3): Vector3 {
    const dir = p.clone().sub(head).setY(0);
    const want = dir.length();
    dir.normalize();
    let limit = Infinity;
    for (const w of this.wallPlanes()) {
      // Distance along `dir` to the wall plane (infinite plane through its centre).
      const denom = w.normal.dot(dir);
      if (Math.abs(denom) < 0.2) continue;
      const t = w.point.clone().sub(head).dot(w.normal) / denom;
      if (t > 0 && t < limit) limit = t;
    }
    if (!isFinite(limit) || limit - 0.4 >= want) return p;
    const dist = Math.max(0.6, limit - 0.4);
    return head.clone().setY(p.y).addScaledVector(dir, dist);
  }

  private wallPlanes(): Array<{ point: Vector3; normal: Vector3 }> {
    const out: Array<{ point: Vector3; normal: Vector3 }> = [];
    for (const e of this.queries.planes.entities) {
      const plane = e.getValue(XRPlane, '_plane') as { orientation?: string } | undefined;
      if (!plane || plane.orientation !== 'vertical' || !e.object3D) continue;
      // WebXR plane space: the plane lies in local XZ, its normal is local +Y.
      const normal = new Vector3(0, 1, 0).applyQuaternion(e.object3D.getWorldQuaternion(new Quaternion()));
      out.push({ point: e.object3D.getWorldPosition(new Vector3()), normal });
    }
    return out;
  }

  /** Centre of the highest real horizontal surface below eye level (a table or desk). */
  private perch(head: Vector3): Vector3 | null {
    let best: Vector3 | null = null;
    for (const e of this.queries.planes.entities) {
      const plane = e.getValue(XRPlane, '_plane') as { orientation?: string } | undefined;
      if (!plane || plane.orientation !== 'horizontal' || !e.object3D) continue;
      const c = e.object3D.getWorldPosition(new Vector3());
      if (c.y < 0.3 || c.y > head.y - 0.2) continue;
      if (c.distanceTo(head) > 2.5) continue;
      if (!best || c.y > best.y) best = c;
    }
    return best;
  }

  /** The camera the headset is actually rendering from (the 2D camera outside XR). */
  private viewCam() {
    const xr = this.world.renderer.xr;
    return xr.isPresenting ? xr.getCamera() : this.world.camera;
  }

  /** How squarely a palm is held up toward the room: 1 = facing straight out, low for hands resting palm-down. */
  private facing(h: HandState, head: Vector3) {
    const out = this.tmpDir.copy(h.palm).sub(head).setY(0).normalize();
    if (h.normal.y < -0.6) return 0;
    return h.normal.x * out.x + h.normal.z * out.z;
  }

  private handForces(hand: HandState, head: Vector3) {
    if (!hand.tracked) return;
    // An open hand only calls the flock when the palm is held up toward it,
    // so relaxed hands resting in your lap do nothing.
    const facing = this.facing(hand, head);
    if (hand.gesture === 'open' && facing > 0.55) {
      const f = this.pool[this.forces.length];
      f.kind = 'attract';
      f.radius = 0;
      // The swirl sits ~75 cm beyond the palm, so a seated arm can reach gates across the room.
      f.point.copy(hand.palm).sub(head).setLength(0.75).add(hand.palm);
      f.strength = 2.4;
      this.forces.push(f);
    } else if (hand.gesture === 'fist') {
      const f = this.pool[this.forces.length];
      f.kind = 'repel';
      f.point.copy(hand.palm);
      f.radius = 0.7;
      f.strength = 14;
      this.forces.push(f);
    }
  }

  private updateDrawing(hand: HandState, dt: number) {
    if (hand.tracked && hand.gesture === 'pinch') {
      const last = this.drawing[this.drawing.length - 1];
      if (!last || last.distanceTo(hand.pinchPoint) > 0.03) {
        if (this.drawing.length < 80) this.drawing.push(hand.pinchPoint.clone());
      }
      return true;
    }
    if (this.drawing.length > 4) {
      // Scale the small hand-drawn stroke up into the room, around the stroke start.
      const anchor = this.drawing[0];
      const head = this.viewCam().getWorldPosition(new Vector3());
      this.path = this.drawing.map((p) => {
        const out = p.clone().sub(anchor).multiplyScalar(3).add(anchor);
        // push the whole path out away from the viewer a little
        return out.add(anchor.clone().sub(head).setY(0).setLength(0.4));
      });
      this.pathT = 0;
      this.audio.chime(0.8);
    }
    this.drawing.length = 0;
    void dt;
    return false;
  }

  private updatePathLine() {
    const pts = this.drawing.length > 1 ? this.drawing : this.path;
    if (pts.length > 1) {
      this.pathLine.geometry.setFromPoints(pts);
      this.pathLine.visible = true;
    } else {
      this.pathLine.visible = false;
    }
  }

  update(delta: number, time: number) {
    if (this.world.visibilityState.value === VisibilityState.VisibleBlurred) return;
    const xr = this.world.renderer.xr;
    this.hands.update(xr.getFrame?.(), xr.getReferenceSpace?.());

    const head = this.viewCam().getWorldPosition(new Vector3());
    if (this.startDelay > 0) {
      this.startDelay -= delta;
      if (this.startDelay <= 0) this.startLevel(0);
    }
    this.forces.length = 0;
    const bubble = this.pool[this.pool.length - 1];
    bubble.kind = 'repel';
    bubble.point.copy(head);
    bubble.radius = 0.55;
    bubble.strength = 18;
    this.forces.push(bubble);
    this.handForces(this.hands.left, head);
    this.handForces(this.hands.right, head);

    const drawingL = this.updateDrawing(this.hands.left, delta);
    const drawingR = !drawingL && this.updateDrawing(this.hands.right, delta);
    void drawingR;

    // Flock follows a released path as a moving lure.
    if (this.path.length > 1 && this.forces.length < this.pool.length) {
      this.pathT += delta * 3.2;
      const idx = Math.floor(this.pathT) % this.path.length;
      const next = (idx + 1) % this.path.length;
      this.lure.lerpVectors(this.path[idx], this.path[next], this.pathT % 1);
      const f = this.pool[this.forces.length];
      f.kind = 'attract';
      f.radius = 0;
      f.point.copy(this.lure);
      f.strength = 2.2;
      this.forces.push(f);
    }
    this.updatePathLine();

    const level = LEVELS[this.levelIndex];
    if (level?.hawk && this.forces.length < this.pool.length) {
      // The hawk dives at the flock centroid; an open palm nearby drives it off.
      const target = this.centroid();
      const toward = target.sub(this.hawk).setLength(1.2);
      this.hawkVel.lerp(toward, delta * 0.8);
      for (const h of [this.hands.left, this.hands.right]) {
        if (h.tracked && h.gesture === 'open' && h.palm.distanceTo(this.hawk) < 0.45) {
          this.hawkVel.add(this.hawk.clone().sub(h.palm).setLength(4 * delta * 10));
        }
      }
      this.hawk.addScaledVector(this.hawkVel, delta);
      this.hawk.y = Math.min(2.4, Math.max(0.5, this.hawk.y));
      this.hawkMesh.position.copy(this.hawk);
      this.hawkMesh.lookAt(this.hawk.clone().add(this.hawkVel));
      this.hawkMesh.rotation.z = Math.sin(time * 5) * 0.25;
      const f = this.pool[this.forces.length];
      f.kind = 'repel';
      f.point.copy(this.hawk);
      f.radius = 0.45;
      f.strength = 7;
      this.forces.push(f);
    }

    if (this.finished && this.forces.length === 1 && this.forces.length < this.pool.length) {
      // No hands raised in Free Flight: the flock drifts down to rest above your real table.
      const spot = this.perch(head);
      const view = this.viewCam().getWorldDirection(new Vector3());
      // Only settle on a surface the player can see, so the moment isn't missed.
      if (spot && spot.clone().sub(head).normalize().dot(view) > 0.6) {
        const f = this.pool[this.forces.length];
        f.kind = 'attract';
      f.radius = 0;
        f.point.copy(spot).setY(spot.y + 0.15);
        f.strength = 0.9;
        this.forces.push(f);
      }
    }
    // Gate funnels only help a flock you are actively leading.
    if (this.flock.leash < 0.6) for (const g of this.gates) if (!g.done) this.forces.push(g.funnel);
    this.updateCues(head, time);

    // Keep Quest 3 at frame rate: if frames stay slow, simulate fewer birds.
    if (delta > 1 / 55) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    // (The desktop emulator stutters while screen-recording, so the reducer only runs on real devices.)
    if (!import.meta.env.DEV && this.slowFrames > 90 && this.flock.active > 400) {
      this.flock.active = Math.floor(this.flock.active * 0.85);
      this.slowFrames = 0;
    }

    const steering = this.forces.some((f) => f !== this.pool[this.pool.length - 1] && f.radius === 0 && f.kind === 'attract') || this.forces.some((f) => f.kind === 'repel' && f.radius === 0.7);
    this.flock.leash += ((steering ? 0.12 : 1) - this.flock.leash) * Math.min(1, delta * 3);
    this.flock.calm = this.finished ? Math.min(1, this.flock.calm + delta * 0.2) : 0;
    this.flock.update(delta, time, this.forces, this.wind);
    this.audio.setIntensity(this.flock.averageSpeed() / 1.7, this.forces.length > 1);

    this.levelTime += delta;
    this.updateGates(time, delta);
    this.placeHud(head, delta);
  }

  private updateCues(head: Vector3, time: number) {
    const hands = [this.hands.left, this.hands.right];
    for (let i = 0; i < 2; i++) {
      const h = hands[i];
      const cue = this.cues[i];
      const mat = cue.material as MeshBasicMaterial;
      const facing = this.facing(h, head);
      if (!h.tracked || h.gesture === 'none' || (h.gesture === 'open' && facing <= 0.55)) {
        mat.opacity = Math.max(0, mat.opacity - 0.08);
        continue;
      }
      const at = h.gesture === 'pinch' ? h.pinchPoint : h.palm;
      cue.position.copy(at);
      cue.lookAt(head);
      if (h.gesture === 'open') {
        mat.color.set(0x8fd3ff);
        cue.scale.setScalar(1 + Math.sin(time * 4) * 0.15);
      } else if (h.gesture === 'fist') {
        mat.color.set(0xff5a3c);
        cue.scale.setScalar(1.6 + Math.sin(time * 10) * 0.2);
      } else {
        mat.color.set(0xffd27a);
        cue.scale.setScalar(0.4);
      }
      mat.opacity = Math.min(0.85, mat.opacity + 0.12);
    }
  }

  private centroid() {
    const c = new Vector3();
    const p = this.flock.pos;
    for (let i = 0; i < this.flock.count; i += 6) {
      c.x += p[i * 3];
      c.y += p[i * 3 + 1];
      c.z += p[i * 3 + 2];
    }
    return c.multiplyScalar(6 / this.flock.count);
  }

  private updateGates(time: number, delta: number) {
    if (this.levelIndex < 0 || this.finished) return;
    const level = LEVELS[this.levelIndex];
    const need = Math.ceil(level.goal * this.flock.active * 2.2);
    const p = this.flock.pos;
    let allDone = true;
    let progress = 0;
    for (const g of this.gates) {
      if (g.drift && !g.done) {
        g.drift(this.levelTime, g.pos);
        g.pos.x += this.origin.x;
        g.pos.z += this.origin.z;
        g.mesh.position.copy(g.pos);
      }
      if (!g.done) {
        // Count fly-throughs: a bird scores when it enters the ring, and can score
        // again once it has left and come back, so steering a stream through pays off.
        const r2 = g.radius * g.radius;
        const out2 = r2 * 2.6;
        const leading = this.flock.leash < 0.6;
        for (let i = 0; i < this.flock.active; i++) {
          const dx = p[i * 3] - g.pos.x, dy = p[i * 3 + 1] - g.pos.y, dz = p[i * 3 + 2] - g.pos.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (!g.passed[i] && d2 < r2) {
            g.passed[i] = 1;
            // Only birds you are actively leading score; a drifting flock doesn't.
            if (leading) g.passedCount++;
          } else if (g.passed[i] && d2 < r2) {
            // Birds you hold inside the ring keep filling it, more slowly.
            if (leading) g.passedCount += delta * 1.5;
          } else if (g.passed[i] && d2 > out2) {
            g.passed[i] = 0;
          }
        }
        if (g.passedCount >= need) {
          g.done = true;
          (g.mesh.material as MeshBasicMaterial).color.set(0xffd27a);
          (g.mesh.material as MeshBasicMaterial).opacity = 0.45; // completed gates step back visually
          this.audio.chime(1.2);
        }
      }
      const pulse = 1 + Math.sin(time * 3) * 0.04;
      g.mesh.scale.setScalar(g.done ? 1.25 : pulse);
      progress += Math.min(1, g.passedCount / need);
      if (!g.done) allDone = false;
    }
    if (this.gates.length) {
      const pct = Math.round((progress / this.gates.length) * 100);
      if (import.meta.env.DEV && Math.floor(time / 2) !== this.lastLog) {
        this.lastLog = Math.floor(time / 2);
        console.log(`[lvl] ${this.levelIndex} ${pct}% t=${this.levelTime.toFixed(1)} birds=${this.flock.active}`);
      }
      this.setHud(level.title, level.hint, pct / 100);
    }
    if (allDone && this.gates.length) this.startLevel(this.levelIndex + 1);
  }

  private hudTarget = new Vector3();
  private placeHud(head: Vector3, delta: number) {
    // Float low in the field of view and lag behind head motion.
    const dir = this.viewCam().getWorldDirection(new Vector3()).setY(0).normalize();
    this.hudTarget.copy(head).addScaledVector(dir, 0.75);
    this.hudTarget.y = head.y - 0.4;
    this.hud.mesh.position.lerp(this.hudTarget, Math.min(1, delta * 2.5));
    this.hud.mesh.lookAt(head);
  }
}
