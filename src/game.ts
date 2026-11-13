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
  CylinderGeometry,
  SphereGeometry,
  BackSide,
  SRGBColorSpace,
  Texture,
  TextureLoader,
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
  flow: number;
}

type Skyline = 'farm' | 'marsh' | 'pier' | 'rome';

interface Level {
  name?: string; // place name on the map
  title: string;
  hint: string;
  note?: string; // the field note you earn here (a real fact about starlings)
  goal: number; // seconds-ish of strong flow each ring needs (x15)
  gates: Array<{ at: [number, number, number]; drift?: Gate['drift'] }>;
  hawk?: boolean;
  wind?: [number, number, number];
  sky: [number, number, number, number]; // dusk tint r,g,b,opacity
  skyline?: Skyline;
  color?: number; // map light colour
  grade?: number; // how much dusk tint to lay over the 360 photo (daytime photos need more)
}

// The story: at dusk one lost starling finds your room. You then choose, in any order, four real
// places where starlings gather. Each visit brings more of the flock home (1 -> 40 -> 250 -> 600 ->
// 900) and earns a field note. At nightfall the whole murmuration settles to sleep around you.
// LEVELS[0] is the opening; LEVELS[1..4] are the places on the map.
const LEVELS: Level[] = [
  {
    title: 'One lost bird',
    hint: 'A starling has lost its flock. Hold up an open palm and guide it through the ring.',
    goal: 0.2,
    gates: [{ at: [0.55, 1.3, -1.0] }],
    sky: [1.0, 0.7, 0.3, 0.1],
  },
  {
    name: 'Open farmland',
    title: 'Open farmland',
    hint: 'They are feeding in the fields. Lead them through both rings before the light goes.',
    note: 'Starlings feed by pushing a closed beak into the soil and prying it open to find grubs.',
    goal: 0.3,
    gates: [{ at: [-0.7, 1.15, -1.4] }, { at: [0.7, 1.45, -1.4] }],
    sky: [1.0, 0.6, 0.22, 0.16],
    skyline: 'farm',
    color: 0xffc35a,
  },
  {
    name: 'Danish marshes',
    title: 'The Danish marshes',
    hint: 'Over the reeds the flock moves as one. Pinch and draw a path in the air, and they will fly it.',
    note: "In Denmark this is called sort sol, 'black sun': flocks over the marshes so dense they darken the evening sky.",
    goal: 0.4,
    gates: [{ at: [-0.95, 1.5, -0.8] }, { at: [0.95, 1.1, -0.9] }],
    sky: [0.95, 0.42, 0.3, 0.18],
    skyline: 'marsh',
    grade: 1.5,
    color: 0xff8f6b,
  },
  {
    name: 'Seaside pier',
    title: 'The seaside pier',
    hint: 'Sea wind pushes the ring along the pier. Lead the flock to where it will be.',
    note: 'Each bird follows only about seven neighbours. That one rule lets thousands turn as one, and it runs this flock too.',
    goal: 0.4,
    gates: [
      {
        at: [0, 1.3, -1.2],
        drift: (t, out) => out.set(Math.sin(t * 0.45) * 0.9, 1.3 + Math.sin(t * 0.7) * 0.25, -1.2),
      },
    ],
    wind: [0.25, 0, 0],
    sky: [0.5, 0.36, 0.6, 0.22],
    skyline: 'pier',
    color: 0x9fb6ff,
  },
  {
    name: 'Rooftops of Rome',
    title: 'The rooftops of Rome',
    hint: 'A falcon hunts over the rooftops. Clench a fist at it to drive it off, then bring them through.',
    note: 'When a falcon dives, a dark wave ripples across the flock, faster than any single bird can fly.',
    goal: 0.4,
    gates: [{ at: [-0.6, 1.5, -1.3] }, { at: [0.65, 1.15, -1.0] }],
    hawk: true,
    sky: [0.75, 0.32, 0.42, 0.22],
    skyline: 'rome',
    grade: 1.4,
    color: 0xff7aa8,
  },
];
const BIRDS = [1, 40, 250, 600, 900]; // flock size by number of places visited
const SCALE = [3.6, 2.3, 1.5, 1.2, 1.0]; // few birds are drawn larger so each one matters

/** A distant skyline for each place, drawn once onto a strip that wraps around the room. */
function drawSkyline(ctx: CanvasRenderingContext2D, kind: Skyline) {
  // Drawn in a 2048x256 design space onto a 1024x128 canvas (small, power-of-two texture).
  const W = 2048, H = 256;
  ctx.setTransform(0.5, 0, 0, 0.5, 0, 0);
  let seed = kind.length * 7919;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0a14';
  ctx.strokeStyle = '#0b0a14';
  if (kind === 'farm') {
    const hill = (x: number) => 175 + 22 * Math.sin((x / W) * Math.PI * 8) + 10 * Math.sin((x / W) * Math.PI * 26);
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, hill(x));
    ctx.lineTo(W, H); ctx.fill();
    for (let x = 60; x < W; x += 120 + rnd() * 160) {
      const y = hill(x), r = 16 + rnd() * 14;
      ctx.fillRect(x - 2, y - r, 4, r);
      ctx.beginPath(); ctx.arc(x, y - r - 8, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + r * 0.7, y - r, r * 0.7, 0, Math.PI * 2); ctx.fill();
    }
  } else if (kind === 'marsh') {
    ctx.fillRect(0, 205, W, H);
    ctx.lineWidth = 2;
    for (let x = 0; x < W; x += 5) {
      const h = 25 + rnd() * 75, lean = (rnd() - 0.5) * 14;
      ctx.beginPath(); ctx.moveTo(x, 206); ctx.lineTo(x + lean, 206 - h); ctx.stroke();
      if (rnd() > 0.82) { ctx.beginPath(); ctx.ellipse(x + lean, 200 - h, 2.5, 9, 0, 0, Math.PI * 2); ctx.fill(); }
    }
  } else if (kind === 'pier') {
    ctx.fillRect(0, 212, W, H);
    for (let rpt = 0; rpt < 2; rpt++) {
      const x0 = 180 + rpt * 1024;
      ctx.fillRect(x0, 168, 620, 7);
      for (let x = x0; x <= x0 + 620; x += 44) ctx.fillRect(x, 170, 4, 44);
      ctx.fillRect(x0 + 430, 128, 120, 42);
      ctx.beginPath(); ctx.arc(x0 + 490, 128, 44, Math.PI, 0); ctx.fill();
      ctx.fillRect(x0 + 487, 66, 6, 22);
      for (let x = x0 + 30; x < x0 + 420; x += 90) { ctx.fillRect(x, 140, 3, 30); ctx.beginPath(); ctx.arc(x + 1.5, 138, 5, 0, Math.PI * 2); ctx.fill(); }
    }
  } else {
    let x = 0;
    while (x < W) {
      const w = 50 + rnd() * 90, h = 35 + rnd() * 70;
      ctx.fillRect(x, 212 - h, w + 1, h + 50);
      const pick = rnd();
      if (pick > 0.78) { // a dome with a lantern
        const r = w * 0.36;
        ctx.beginPath(); ctx.arc(x + w / 2, 212 - h, r, Math.PI, 0); ctx.fill();
        ctx.fillRect(x + w / 2 - 3, 212 - h - r - 12, 6, 14);
      } else if (pick < 0.2) { // an umbrella pine
        ctx.fillRect(x + w / 2 - 2, 212 - h - 34, 4, 36);
        ctx.beginPath(); ctx.ellipse(x + w / 2, 212 - h - 38, 26, 10, 0, 0, Math.PI * 2); ctx.fill();
      }
      x += w;
    }
  }
  // Fade the ground out towards the bottom so the strip has no hard lower edge.
  const g = ctx.createLinearGradient(0, 205, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = g; ctx.fillRect(0, 205, W, H - 205);
  ctx.globalCompositeOperation = 'source-over';
}

interface Orb { level: number; mesh: Mesh; label: Mesh; dwell: number }

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
  private lastSnd = -1;
  private dusk!: Mesh; // a soft tinted dome that takes the room from golden hour to night
  private duskTarget = { color: new Color(1.0, 0.62, 0.25), opacity: 0 };
  private night = 0;
  private targetScale = 1;
  private hawkFlee = 0;
  private mode: 'play' | 'map' = 'play';
  private visited = new Set<number>();
  private orbs: Orb[] = [];
  private skyline!: { mesh: Mesh; ctx: CanvasRenderingContext2D; tex: CanvasTexture; target: number };
  // The world you step into at each place: a real 360 photo that replaces the room ('vr'),
  // or stay in your own room and let the place come to you ('ar').
  private worldMode: 'vr' | 'ar' = new URLSearchParams(location.search).get('world') === 'ar' ? 'ar' : 'vr';
  private worldSphere!: Mesh;
  private worldTarget = 0;
  private worldWant = '';
  private worldHave = '';
  private worldCache = new Map<string, Texture>();
  private worldLoader = new TextureLoader();
  private toggle!: { mesh: Mesh; label: Mesh; ctx: CanvasRenderingContext2D; tex: CanvasTexture; dwell: number; cool: number };

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

    this.dusk = new Mesh(
      new SphereGeometry(7, 24, 16),
      new MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0, side: BackSide, depthWrite: false }),
    );
    this.dusk.renderOrder = -10;
    this.dusk.frustumCulled = false;
    this.scene.add(this.dusk);
    this.flock.active = 1;

    // The skyline strip that wraps around the room at each place.
    const sc = document.createElement('canvas');
    sc.width = 1024; sc.height = 128;
    const stex = new CanvasTexture(sc);
    const smesh = new Mesh(
      new CylinderGeometry(6, 6, 1.5, 64, 1, true),
      new MeshBasicMaterial({ map: stex, transparent: true, opacity: 0, side: BackSide, depthWrite: false }),
    );
    smesh.renderOrder = -9;
    smesh.frustumCulled = false;
    this.scene.add(smesh);
    this.skyline = { mesh: smesh, ctx: sc.getContext('2d')!, tex: stex, target: 0 };

    // The world sphere: a 360 photo of the place, drawn behind everything and over the passthrough.
    this.worldSphere = new Mesh(
      new SphereGeometry(40, 64, 32),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: BackSide, depthWrite: false, depthTest: false }),
    );
    this.worldSphere.scale.x = -1; // viewed from inside, so un-mirror the photo
    this.worldSphere.renderOrder = -20;
    this.worldSphere.frustumCulled = false;
    this.worldSphere.visible = false;
    this.scene.add(this.worldSphere);

    // The switch on the map between stepping into the world and staying in your room.
    const tc = document.createElement('canvas');
    tc.width = 512; tc.height = 96;
    const ttex = new CanvasTexture(tc);
    const tmesh = new Mesh(
      new SphereGeometry(0.02, 16, 12),
      new MeshBasicMaterial({ color: 0xe8e4ff, transparent: true, opacity: 0.9 }),
    );
    const tlabel = new Mesh(
      new PlaneGeometry(0.15, 0.028),
      new MeshBasicMaterial({ map: ttex, transparent: true, depthWrite: false }),
    );
    tlabel.renderOrder = 9;
    tmesh.visible = tlabel.visible = false;
    this.scene.add(tmesh, tlabel);
    this.toggle = { mesh: tmesh, label: tlabel, ctx: tc.getContext('2d')!, tex: ttex, dwell: 0, cool: 0 };
    this.drawToggle();

    // The map: one small light per place, floating within arm's reach.
    for (let li = 1; li < LEVELS.length; li++) {
      const mesh = new Mesh(
        new SphereGeometry(0.028, 20, 14),
        new MeshBasicMaterial({ color: LEVELS[li].color, transparent: true, opacity: 0.95 }),
      );
      const lc = document.createElement('canvas');
      lc.width = 512; lc.height = 96;
      const lx = lc.getContext('2d')!;
      lx.fillStyle = 'rgba(12,10,18,0.6)';
      lx.beginPath(); lx.roundRect(4, 4, 504, 88, 30); lx.fill();
      lx.fillStyle = '#f2eee8'; lx.font = '600 44px system-ui, sans-serif'; lx.textAlign = 'center';
      lx.fillText(LEVELS[li].name ?? '', 256, 63);
      const label = new Mesh(
        new PlaneGeometry(0.15, 0.028),
        new MeshBasicMaterial({ map: new CanvasTexture(lc), transparent: true, depthWrite: false }),
      );
      label.renderOrder = 9;
      mesh.visible = label.visible = false;
      this.scene.add(mesh, label);
      this.orbs.push({ level: li, mesh, label, dwell: 0 });
    }

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
    this.setHud('MURMUR', 'One evening, four roosts, nine hundred starlings. Bring them home.');
  }

  private makeHud() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 320;
    const ctx = canvas.getContext('2d')!;
    const tex = new CanvasTexture(canvas);
    const mesh = new Mesh(
      new PlaneGeometry(0.46, 0.144),
      new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    mesh.renderOrder = 10;
    this.scene.add(mesh);
    return { mesh, ctx, tex, last: '' };
  }

  private setHud(title: string, line: string, progress = -1, birds = 0) {
    const key = title + '|' + line + '|' + progress + '|' + birds;
    if (this.hud.last === key) return;
    this.hud.last = key;
    const { ctx, tex } = this.hud;
    ctx.clearRect(0, 0, 1024, 320);
    ctx.fillStyle = 'rgba(12,10,18,0.62)';
    ctx.beginPath();
    ctx.roundRect(8, 8, 1008, 304, 40);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd27a';
    ctx.font = '600 54px system-ui, sans-serif';
    ctx.fillText(title, 512, 78);
    ctx.fillStyle = '#f2eee8';
    ctx.font = '400 33px system-ui, sans-serif';
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
    lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, 512, 132 + i * 42));
    const barW = birds > 0 ? 600 : 800;
    if (progress >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(112, 274, barW, 10);
      ctx.fillStyle = '#8fd3ff';
      ctx.fillRect(112, 274, barW * Math.min(1, progress), 10);
    }
    if (birds > 0) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffd27a';
      ctx.font = '600 28px system-ui, sans-serif';
      ctx.fillText(birds === 1 ? '1 starling' : `${birds} starlings`, 930, 289);
    }
    tex.needsUpdate = true;
  }

  private drawToggle() {
    const { ctx, tex } = this.toggle;
    ctx.clearRect(0, 0, 512, 96);
    ctx.fillStyle = 'rgba(12,10,18,0.6)';
    ctx.beginPath(); ctx.roundRect(4, 4, 504, 88, 30); ctx.fill();
    ctx.fillStyle = '#cfd6ff'; ctx.font = '500 36px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(this.worldMode === 'vr' ? 'Stay in my room instead' : 'Step into the places', 256, 60);
    tex.needsUpdate = true;
  }

  /** Fade to the 360 world of a place (or back to the room when name is empty). */
  private showWorld(name: string) {
    this.worldWant = name;
    if (!name) { this.worldTarget = 0; return; }
    if (!this.worldCache.has(name)) {
      this.worldLoader.load(`./worlds/${name}.jpg`, (t) => {
        t.colorSpace = SRGBColorSpace;
        this.worldCache.set(name, t);
      });
    }
  }

  private updateWorld(head: Vector3, delta: number) {
    const m = this.worldSphere.material as MeshBasicMaterial;
    const ready = this.worldWant && this.worldCache.has(this.worldWant);
    // Fade out before swapping photos, so one place never pops into another.
    const target = this.worldWant && this.worldWant === this.worldHave ? 1 : 0;
    m.opacity += (target - m.opacity) * Math.min(1, delta * 1.4);
    if (this.worldWant !== this.worldHave && m.opacity < 0.02 && (ready || !this.worldWant)) {
      this.worldHave = this.worldWant;
      m.map = this.worldHave ? this.worldCache.get(this.worldHave)! : null;
      m.needsUpdate = true;
    }
    this.worldSphere.visible = m.opacity > 0.005;
    // Sit the horizon a little below eye level so the flock flies against open sky.
    this.worldSphere.position.set(head.x, head.y - 5, head.z);
    this.worldTarget = target;
  }

  private clearGates() {
    for (const g of this.gates) {
      this.scene.remove(g.mesh);
      g.mesh.geometry.dispose();
    }
    this.gates = [];
    this.path = [];
    this.drawing.length = 0;
  }

  /** How far the journey has come: 0 = the lost bird, 1..4 = places, 5 = nightfall. */
  private stage() {
    if (this.finished) return 5;
    return this.levelIndex <= 0 ? 0 : Math.min(4, this.visited.size + (this.mode === 'play' ? 1 : 0));
  }

  /** A chapter is done: earn its field note, then choose where to fly next (or night falls). */
  private completeLevel() {
    const level = LEVELS[this.levelIndex];
    if (this.levelIndex > 0) this.visited.add(this.levelIndex);
    if (this.visited.size >= LEVELS.length - 1) {
      this.startLevel(LEVELS.length);
      return;
    }
    this.clearGates();
    this.mode = 'map';
    this.levelTimes.push(this.levelTime);
    this.levelTime = 0;
    this.hawkMesh.visible = false;
    this.wind.set(0, 0, 0);
    this.skyline.target = 0;
    const pick = 'Touch a light to choose where they fly next.';
    if (level.note) this.setHud(`Field note ${this.visited.size} of ${LEVELS.length - 1}`, `${level.note} ${pick}`);
    else this.setHud('It knows the way now', `Its flock is scattered across four roosts. ${pick}`);
    // Lay the lights out in an arc in front of the player, within easy reach.
    const head = this.viewCam().getWorldPosition(new Vector3());
    const fwd = this.viewCam().getWorldDirection(new Vector3()).setY(0).normalize();
    const right = new Vector3(-fwd.z, 0, fwd.x);
    this.orbs.forEach((o, k) => {
      const t = k - (this.orbs.length - 1) / 2;
      o.mesh.position.copy(head).addScaledVector(fwd, 0.42 - Math.abs(t) * 0.03).addScaledVector(right, t * 0.17);
      o.mesh.position.y = head.y - 0.28;
      o.label.position.copy(o.mesh.position).setY(o.mesh.position.y + 0.06);
      o.label.lookAt(head);
      const done = this.visited.has(o.level);
      (o.mesh.material as MeshBasicMaterial).opacity = done ? 0.25 : 0.95;
      (o.label.material as MeshBasicMaterial).opacity = done ? 0.35 : 1;
      o.mesh.visible = o.label.visible = true;
      o.dwell = 0;
    });
    this.toggle.mesh.position.copy(head).addScaledVector(fwd, 0.36).addScaledVector(right, -0.02);
    this.toggle.mesh.position.y = head.y - 0.4;
    this.toggle.label.position.copy(this.toggle.mesh.position).setY(this.toggle.mesh.position.y - 0.045);
    this.toggle.label.lookAt(head);
    this.toggle.mesh.visible = this.toggle.label.visible = true;
    this.toggle.dwell = 0;
    this.audio.chime(0.9);
  }

  /** In map mode: touching (or pinching at) a light sends the flock to that place. */
  private updateMap(delta: number, time: number) {
    for (const o of this.orbs) {
      if (this.visited.has(o.level)) continue;
      o.mesh.scale.setScalar(1 + Math.sin(time * 3 + o.level) * 0.12 + o.dwell * 1.2);
      let near = false;
      for (const h of [this.hands.left, this.hands.right]) {
        if (!h.tracked) continue;
        const d = h.pinchPoint.distanceTo(o.mesh.position);
        if ((h.gesture === 'pinch' && d < 0.12) || d < 0.065) near = true;
        if (h.gesture === 'pinch' && d < 0.12) o.dwell += delta * 3;
      }
      o.dwell = near ? o.dwell + delta : Math.max(0, o.dwell - delta * 2);
      if (o.dwell > 0.5) {
        this.startLevel(o.level);
        return;
      }
    }
    // The world switch: touch or pinch it to flip between stepping inside and staying in the room.
    const tg = this.toggle;
    tg.cool = Math.max(0, tg.cool - delta);
    let nearT = false;
    for (const h of [this.hands.left, this.hands.right]) {
      if (!h.tracked) continue;
      const d = h.pinchPoint.distanceTo(tg.mesh.position);
      if ((h.gesture === 'pinch' && d < 0.09) || d < 0.05) nearT = true;
    }
    tg.dwell = nearT && tg.cool <= 0 ? tg.dwell + delta : Math.max(0, tg.dwell - delta * 2);
    tg.mesh.scale.setScalar(1 + tg.dwell * 1.5);
    if (tg.dwell > 0.5) {
      this.worldMode = this.worldMode === 'vr' ? 'ar' : 'vr';
      tg.dwell = 0; tg.cool = 1.5;
      this.drawToggle();
      this.audio.chime(1.2);
      if (this.worldMode === 'ar') this.showWorld('');
    }
    if (import.meta.env.DEV && Math.floor(time / 2) !== this.lastLog) {
      this.lastLog = Math.floor(time / 2);
      console.log(`[map] ${this.visited.size} world=${this.worldMode} toggle=${tg.mesh.position.toArray().map((v) => v.toFixed(3)).join(',')} open=${this.orbs.filter((o) => !this.visited.has(o.level)).map((o) => o.mesh.position.toArray().map((v) => v.toFixed(3)).join(',')).join(';')}`);
    }
  }

  private startLevel(i: number) {
    this.clearGates();
    this.mode = 'play';
    for (const o of this.orbs) o.mesh.visible = o.label.visible = false;
    this.toggle.mesh.visible = this.toggle.label.visible = false;
    this.levelIndex = i;
    this.levelTime = 0;
    if (i >= LEVELS.length) {
      this.finished = true;
      this.skyline.target = 0;
      // Night falls back home: the last place fades away and the flock settles in your own room.
      this.showWorld('');
      if (import.meta.env.DEV) console.log(`[lvl] 5 100% t=0 birds=${this.flock.active}`);
      this.hawkMesh.visible = false;
      this.wind.set(0, 0, 0);
      // Bring the roost down in front of the player for the finale.
      const h = this.viewCam().getWorldPosition(new Vector3());
      // Straight ahead of where the player sits (the level origin), not wherever they happen to look.
      this.flock.center.set(this.origin.x, h.y - 0.05, this.origin.z - 1.5);
      this.flock.radius = 0.9;
      this.flock.radius = 0.7;
      this.duskTarget.color.setRGB(0.03, 0.05, 0.16);
      this.duskTarget.opacity = 0.62;
      this.setHud('Nightfall', `All ${this.flock.active} are home, and you carry ${this.visited.size} field notes. Lower your hands and let them rest.`);
      this.audio.fanfare();
      return;
    }

    const head = this.viewCam().getWorldPosition(new Vector3());
    this.origin.set(head.x, 0, head.z);
    // The flock roosts high and far until you call it, so gates need deliberate play.
    const prev = this.flock.center.clone();
    this.flock.center.set(head.x, head.y + 0.3, head.z - 1.6);
    void prev;
    this.flock.radius = 0.6;

    const level = LEVELS[i];
    const step = i === 0 ? 0 : Math.min(4, this.visited.size + 1);
    const birds = BIRDS[step], scale = SCALE[step];
    // The flock grows: newcomers stream in from high beyond the roost, as if through the wall.
    const before = i === 0 ? 0 : this.flock.active;
    if (birds > before) {
      const from = this.flock.center.clone().add(new Vector3(-2.6, 0.9, -2.2));
      if (i === 0) this.flock.arrive(0, 1, this.flock.center.clone().add(new Vector3(-1.2, 0.2, -0.6)), this.flock.center, 0.1);
      else this.flock.arrive(before, birds, from, this.flock.center, 0.9);
      this.flock.active = birds;
    }
    this.targetScale = scale;
    if (i === 0) this.flock.scale = scale;
    // A lone bird flies straight to your call; a big flock spreads into a cloud around it.
    this.flock.spread = 0.38 * Math.min(1, birds / 300);
    // Each place has its own evening light and its own skyline around the room.
    this.duskTarget.color.setRGB(level.sky[0], level.sky[1], level.sky[2]);
    this.duskTarget.opacity = level.sky[3];
    const inside = this.worldMode === 'vr' && !!level.skyline;
    this.showWorld(inside ? level.skyline! : '');
    if (inside) {
      // Inside the photo the light is already there; keep only a light dusk grade.
      this.duskTarget.opacity = level.sky[3] * (level.grade ?? 0.6);
      this.skyline.target = 0;
    } else if (level.skyline) {
      drawSkyline(this.skyline.ctx, level.skyline);
      this.skyline.tex.needsUpdate = true;
      this.skyline.mesh.position.set(head.x, head.y - 0.1, head.z);
      this.skyline.target = 0.36;
    } else this.skyline.target = 0;
    this.hawkFlee = 0;
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
        flow: 0,
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
      // Aim assist: a call aimed near an open gate is drawn onto it, so the stream threads the ring.
      for (const g of this.gates) {
        if (!g.done && f.point.distanceTo(g.pos) < 0.75) {
          f.point.lerp(g.pos, 0.7);
          break;
        }
      }
      f.strength = 2.4;
      this.forces.push(f);
    } else if (hand.gesture === 'fist' && !LEVELS[this.levelIndex]?.hawk) {
      // (In the hawk chapter a fist is aimed at the hawk, not at your own flock.)
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
      if (this.startDelay <= 0) {
        // Dev only: ?chapter=N jumps straight to a chapter (5 = nightfall) for testing and capture.
        const jump = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('chapter') ?? 0) : 0;
        if (jump > 0) {
          this.origin.set(head.x, 0, head.z);
          this.flock.active = 900;
          this.flock.gatherAt(new Vector3(head.x, head.y + 0.3, head.z - 1.6), 0.5);
          this.targetScale = this.flock.scale = 1;
          for (let li = 1; li < LEVELS.length; li++) this.visited.add(li);
        }
        this.startLevel(jump > 0 ? LEVELS.length : 0);
      }
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

    const drawingL = this.mode === 'play' && this.updateDrawing(this.hands.left, delta);
    const drawingR = this.mode === 'play' && !drawingL && this.updateDrawing(this.hands.right, delta);
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

    const level = this.mode === 'play' ? LEVELS[this.levelIndex] : undefined;
    if (level?.hawk && this.forces.length < this.pool.length) {
      // The falcon dives at the flock.
      // A fist clenched at it drives it off for a few seconds.
      for (const h of [this.hands.left, this.hands.right]) {
        if (!h.tracked || h.gesture !== 'fist') continue;
        const toHawk = this.hawk.clone().sub(head).normalize();
        const toFist = h.palm.clone().sub(head).normalize();
        if (toHawk.dot(toFist) > 0.8 || h.palm.distanceTo(this.hawk) < 0.9) {
          if (this.hawkFlee <= 0) this.audio.chime(0.6);
          this.hawkFlee = 6;
        }
      }
      this.hawkFlee -= delta;
      const target = this.hawkFlee > 0
        ? new Vector3(this.origin.x + 2.5, 2.3, this.origin.z - 2.8)
        : this.centroid();
      const toward = target.sub(this.hawk).setLength(this.hawkFlee > 0 ? 2.2 : 1.2);
      this.hawkVel.lerp(toward, delta * (this.hawkFlee > 0 ? 2.5 : 0.8));
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
    // Smooth story transitions: bird size, the dusk light, and starlight at nightfall.
    this.flock.scale += (this.targetScale - this.flock.scale) * Math.min(1, delta * 1.5);
    const dm = this.dusk.material as MeshBasicMaterial;
    dm.color.lerp(this.duskTarget.color, Math.min(1, delta * 0.6));
    dm.opacity += (this.duskTarget.opacity - dm.opacity) * Math.min(1, delta * 0.6);
    this.dusk.position.copy(head);
    this.night += ((this.finished ? 1 : 0) - this.night) * Math.min(1, delta * 0.5);
    this.flock.setNight(this.night);
    this.flock.update(delta, time, this.forces, this.wind);
    this.audio.setIntensity(this.flock.averageSpeed() / 1.7, this.forces.length > 1);
    if (import.meta.env.DEV && Math.floor(time * 4) !== this.lastSnd) {
      this.lastSnd = Math.floor(time * 4);
      console.log(`[snd] spd ${(this.flock.averageSpeed() / 1.7).toFixed(2)} ${this.forces.length > 1 ? 1 : 0} c=${this.centroid().toArray().map((v) => v.toFixed(2)).join(",")}`);
    }

    this.levelTime += delta;
    // Free Flight: the summary card bows out after a few seconds and leaves just you and the flock.
    if (this.finished) this.hud.mesh.visible = this.levelTime < 10;
    if (this.mode === 'map') this.updateMap(delta, time);
    else this.updateGates(time, delta);
    const sm = this.skyline.mesh.material as MeshBasicMaterial;
    sm.opacity += (this.skyline.target - sm.opacity) * Math.min(1, delta * 0.8);
    this.updateWorld(head, delta);
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
    const n = this.flock.active;
    const step = n > 60 ? 6 : 1;
    let k = 0;
    for (let i = 0; i < n; i += step) {
      c.x += p[i * 3];
      c.y += p[i * 3 + 1];
      c.z += p[i * 3 + 2];
      k++;
    }
    return c.multiplyScalar(1 / Math.max(1, k));
  }

  private updateGates(time: number, delta: number) {
    if (this.levelIndex < 0 || this.finished) return;
    const level = LEVELS[this.levelIndex];
    // Each gate needs this many seconds of strong flow through it (goal 0.4 -> 6 s).
    const need = level.goal * 15;
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
        // You score a gate only while you are leading the flock to *that* gate: one of your hand
        // calls (or a drawn path) has to be pulling toward it, not just anywhere in the room.
        const leading = this.flock.leash < 0.6 && this.forces.some((f) => f.kind === 'attract' && f.radius === 0 && f.point.distanceTo(g.pos) < 0.75);
        let entered = 0;
        for (let i = 0; i < this.flock.active; i++) {
          const dx = p[i * 3] - g.pos.x, dy = p[i * 3 + 1] - g.pos.y, dz = p[i * 3 + 2] - g.pos.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r2) entered++; // birds inside the ring right now
          if (!g.passed[i] && d2 < r2) {
            g.passed[i] = 1;
          } else if (g.passed[i] && d2 > out2) {
            g.passed[i] = 0;
          }
        }
        // Flow = how many birds are in the ring right now (smoothed). A thick stream you are leading
        // fills the gate at one second per second; a trickle fills it slowly; a drifting flock not at all.
        g.flow += (entered - g.flow) * Math.min(1, delta * 4);
        // "Thick" is relative to how many birds you have: one bird in the ring is enough in chapter I.
        const thick = Math.min(80, Math.max(0.6, this.flock.active * 0.2));
        if (leading) g.passedCount += delta * Math.min(1, g.flow / thick);
        if (g.passedCount >= need) {
          g.done = true;
          (g.mesh.material as MeshBasicMaterial).color.set(0xffd27a);
          (g.mesh.material as MeshBasicMaterial).opacity = 0.45; // completed gates step back visually
          this.audio.chime(1.2);
          if (import.meta.env.DEV) console.log('[snd] gate');
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
        console.log(`[lvl] ${this.stage()} ${pct}% t=${this.levelTime.toFixed(1)} birds=${this.flock.active} open=${this.gates.filter((g) => !g.done).map((g) => g.pos.toArray().map((v) => v.toFixed(2)).join(",")).join(";")}`);
      }
      this.setHud(level.title, level.hint, pct / 100, this.flock.active);
    }
    if (allDone && this.gates.length) this.completeLevel();
  }

  private hudTarget = new Vector3();
  private placeHud(head: Vector3, delta: number) {
    // Float low in the field of view and lag behind head motion.
    const dir = this.viewCam().getWorldDirection(new Vector3()).setY(0).normalize();
    // On the map the card sits further back and higher, clear of the lights in front of you.
    const far = this.mode === 'map';
    this.hudTarget.copy(head).addScaledVector(dir, far ? 1.0 : 0.75);
    this.hudTarget.y = head.y - (far ? 0.1 : 0.4);
    this.hud.mesh.position.lerp(this.hudTarget, Math.min(1, delta * 2.5));
    this.hud.mesh.lookAt(head);
  }
}
