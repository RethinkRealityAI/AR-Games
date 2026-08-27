// ============================================================================
// Quantum Pairs — 3D board.
//
// The tile language is Cosmic Tac-Toe's: smoked glass slabs with a neon
// rounded-rect outline that tints to the player on the move, a soft inner glow
// on the face, and a galaxy particle disc underneath. Everything else is built
// around ONE physical idea:
//
//   A tile is a closed portal. Tapping it does not flip it — the face sinks and
//   dims, an energy ring blooms at the surface, and the artifact MATERIALISES
//   out of the tile: rising, scaling past its size and settling back, with a
//   scan ring travelling up it as it forms. Sending it back down plays exactly
//   the same process in reverse. That is literal here rather than approximate:
//   every formation cue is a pure function of one scalar, `rec.form`, so
//   running `form` backwards *is* the dissolve.
//
// On top of that single primitive:
//
//  • MISMATCH (`pendingClear`) — both artifacts stay materialised so the
//    incoming player can study them, but they go inert: desaturated toward
//    grey, dim emissive, spin slowed to a crawl. An active pick stays bright
//    and turning.
//  • MATCH (`lastMatch`) — the pair rises, rushes into each other, orbits the
//    midpoint once, detonates a shockwave across the grid, and settles back
//    onto its own tiles as small claimed trophies. The tiles close, take the
//    claimant's colour and keep a persistent glow.
//  • CONSTELLATION — every claimed pair strings a luminous line in the owner's
//    colour between its two tiles, so each player's captures draw a growing
//    figure across the board. On the final whistle the winner's lines ignite:
//    they brighten, a bead of light runs along each one, and their trophies
//    flare.
//  • NOVA PULSE (`board.pulse`) — the spectacle. Every unclaimed artifact
//    materialises at once in a wave radiating out from the board centre, tinted
//    by the caster's colour, with a shockwave sweeping ahead of it. When the
//    pulse clears they de-materialise outside-in, the wave running backwards.
//
// MASKING — in online play `deck[t]` is HIDDEN for tiles this client has never
// been shown. A tile with an unknown kind simply never opens; `buildArtifact`
// is never called with HIDDEN.
//
// BUDGET — worst case is Odyssey (30 tiles) mid-Nova-Pulse: 30 artifacts up at
// once. Tiles, rings and constellation lines are all built once per layout and
// then only mutated; artifacts are pooled per kind; `animate()` allocates
// nothing.
// ============================================================================

import * as THREE from 'three';
import type { GameScene, SceneContext } from '../../engine/sceneTypes';
import type { GameCore, Move, PlayerSlot } from '../../types';
import { HIDDEN, type MemoryBoard } from './logic';
import { buildArtifact, disposeArtifactCache } from './artifacts';

// -- tuning -----------------------------------------------------------------

/** Materialise / de-materialise durations (ms). */
const FORM_MS = 640;
const UNFORM_MS = 470;

/** Nova Pulse wave: extra delay from the board centre to the far corner. */
const NOVA_SPREAD_MS = 460;
const NOVA_COLLAPSE_MS = 340;

const CELEBRATE_MS = 2000;
/** Fraction of the celebration at which the pair detonates and is claimed. */
const CLAIM_AT = 0.62;

const SHOCK_MS = 950;
const LINE_GROW_MS = 620;

const IDLE_TINT = 0x2ad4ff;

// -- easing -----------------------------------------------------------------

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** Overshoots past 1 and settles — the "pop" as an artifact finishes forming. */
const easeOutBack = (t: number) => {
  const c = 1.7;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

type TileMode = 'idle' | 'pick' | 'cool' | 'nova' | 'trophy';

/** Everything one board square owns. Built once per layout, then mutated. */
interface TileRec {
  index: number;
  x: number;
  z: number;
  /** Distance from the board centre, normalised 0…1 — drives the Nova wave. */
  radial: number;

  slab: THREE.Mesh;
  border: THREE.LineLoop;
  face: THREE.Mesh;
  faceMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  scan: THREE.Mesh;
  fxMat: THREE.MeshBasicMaterial;

  owner: PlayerSlot | null;
  /** Owner the tile is *showing*; lags `owner` until the celebration flash. */
  shownOwner: PlayerSlot | null;
  kind: number;
  mode: TileMode;

  art: THREE.Group | null;
  artKind: number;
  artMats: THREE.Material[];

  /** 0 = face down, 1 = fully materialised. The one number the effect runs on. */
  form: number;
  formTarget: number;
  /** ms still to wait before `form` starts moving (the Nova wave). */
  delay: number;
  /** How far the portal is open — 1 while showing, 0 once claimed as a trophy. */
  open: number;
  openTarget: number;

  lift: number;
  liftTarget: number;
  scale: number;
  scaleTarget: number;
  spinRate: number;
  spinTarget: number;
  spin: number;

  chill: number;
  chillTarget: number;
  tint: number;
  tintTarget: number;
  tintCol: THREE.Color;
  flare: number;

  hover: number;
  glowCol: THREE.Color;
  glowTargetCol: THREE.Color;
  glowBase: number;
}

interface LineRec {
  a: number;
  b: number;
  slot: PlayerSlot;
  kind: number;
  mesh: THREE.Mesh;
  bead: THREE.Mesh;
  grow: number;
  /** Held back until the match celebration detonates. */
  hold: boolean;
}

interface Shock {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t0: number;
  maxR: number;
}

export function createMemoryScene(): GameScene {
  let ctx: SceneContext | null = null;

  // -- shared caches --------------------------------------------------------
  const geoCache = new Map<string, THREE.BufferGeometry>();
  const matCache = new Map<string, THREE.Material>();
  /** Per-tile materials (one glow + one fx each) — owned and disposed here. */
  const ownMats: THREE.Material[] = [];

  const geo = <T extends THREE.BufferGeometry>(key: string, make: () => T): T => {
    const hit = geoCache.get(key);
    if (hit) return hit as T;
    const g = make();
    geoCache.set(key, g);
    return g;
  };

  const mat = <T extends THREE.Material>(key: string, make: () => T): T => {
    const hit = matCache.get(key);
    if (hit) return hit as T;
    const m = make();
    matCache.set(key, m);
    return m;
  };

  // -- scene graph ----------------------------------------------------------
  let group: THREE.Group | null = null;
  let tileLayer: THREE.Group | null = null;
  let artLayer: THREE.Group | null = null;
  let fxLayer: THREE.Group | null = null;
  let galaxy: THREE.Points | null = null;
  let turnLight: THREE.PointLight | null = null;
  let glowTex: THREE.Texture | null = null;

  const tiles: TileRec[] = [];
  const slabs: THREE.Mesh[] = [];
  const lines: LineRec[] = [];
  const shocks: Shock[] = [];

  /** Idle artifact instances, keyed by kind. Materials travel with the body. */
  const pool = new Map<number, { obj: THREE.Group; mats: THREE.Material[] }[]>();

  // -- layout ---------------------------------------------------------------
  let S = 0.58;
  let cols = 6;
  let rows = 3;
  let step = 0.1;
  let tile = 0.09;
  let slabH = 0.018;
  let artSize = 0.065;
  let boardR = 0.3;
  let layoutSig = '';
  let theme: MemoryBoard['theme'] = 'cosmos';

  // -- state ----------------------------------------------------------------
  let lastTime = 0;
  let hoverTile = -1;
  let winnerSlot: PlayerSlot | null = null;
  const winnerTiles = new Set<number>();
  let igniteT0 = -1;
  let novaActive = false;
  let novaSlot: PlayerSlot | null = null;

  let celebT0 = -1;
  let celebKey = -1;
  let celebA = -1;
  let celebB = -1;
  let celebSlot: PlayerSlot = 0;
  let celebClaimed = false;
  /** A Nova shockwave asked for by update(), fired on the next real frame. */
  let novaShockPending = false;

  // -- scratch (animate() must allocate nothing) ----------------------------
  const tmpColor = new THREE.Color();
  const p0Color = new THREE.Color('#22d3ee');
  const p1Color = new THREE.Color('#fbbf24');
  const idleColor = new THREE.Color(IDLE_TINT);

  const slotColor = (slot: PlayerSlot): THREE.Color => (slot === 0 ? p0Color : p1Color);

  // ==========================================================================
  // Geometry helpers
  // ==========================================================================

  const roundedRect = (halfW: number, halfH: number, r: number): THREE.Shape => {
    const s = new THREE.Shape();
    s.moveTo(-halfW + r, -halfH);
    s.lineTo(halfW - r, -halfH);
    s.quadraticCurveTo(halfW, -halfH, halfW, -halfH + r);
    s.lineTo(halfW, halfH - r);
    s.quadraticCurveTo(halfW, halfH, halfW - r, halfH);
    s.lineTo(-halfW + r, halfH);
    s.quadraticCurveTo(-halfW, halfH, -halfW, halfH - r);
    s.lineTo(-halfW, -halfH + r);
    s.quadraticCurveTo(-halfW, -halfH, -halfW, -halfH + r);
    s.closePath();
    return s;
  };

  /** Soft radial falloff used for every glow patch on the board. */
  const makeGlowTexture = (): THREE.Texture => {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    grad.addColorStop(0.78, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  /** Three-branch spiral of additive points, as under the other boards. */
  const createGalaxy = (): THREE.Points => {
    const count = 1200;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const inside = new THREE.Color(0x22d3ee);
    const outside = new THREE.Color(0xe879f9);
    const maxR = S * 2.3;
    const mix = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const radius = Math.random() * maxR;
      const swirl = radius * 4;
      const branch = (i % 3) * ((Math.PI * 2) / 3);
      pos[i3] = Math.cos(branch + swirl) * radius + (Math.random() - 0.5) * 0.02;
      pos[i3 + 1] = (Math.random() - 0.5) * 0.14;
      pos[i3 + 2] = Math.sin(branch + swirl) * radius + (Math.random() - 0.5) * 0.02;
      mix.copy(inside).lerp(outside, radius / maxR);
      col[i3] = mix.r;
      col[i3 + 1] = mix.g;
      col[i3 + 2] = mix.b;
    }

    const g = geo('galaxy', () => {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      bg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return bg;
    });
    const m = mat(
      'galaxy',
      () =>
        new THREE.PointsMaterial({
          size: 0.007,
          vertexColors: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          opacity: 0.7,
        }),
    );
    return new THREE.Points(g, m);
  };

  // ==========================================================================
  // Artifact instances
  // ==========================================================================

  /**
   * `buildArtifact` shares its materials between every instance of a kind, so
   * the scene swaps in private clones: opacity, desaturation and the Nova tint
   * are all per-instance here. The originals are never touched and never
   * disposed; the clones are ours, and their pre-computed rest values ride
   * along in `userData` so the per-frame look is a few lerps with no maths.
   */
  const cloneMaterials = (obj: THREE.Group): THREE.Material[] => {
    const out: THREE.Material[] = [];
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material;
      const list = Array.isArray(src) ? src : [src];
      const cloned = list.map((m) => {
        const c = m.clone();
        c.transparent = true;
        const std = c as THREE.MeshStandardMaterial;
        const u = c.userData as Record<string, unknown>;
        if (std.color) {
          const base = std.color.clone();
          const lum = base.r * 0.3 + base.g * 0.55 + base.b * 0.15;
          u.c0 = base;
          u.cChill = new THREE.Color(lum * 0.62, lum * 0.66, lum * 0.78);
        }
        if (std.emissive) {
          u.e0 = std.emissive.clone();
          u.ei0 = std.emissiveIntensity ?? 1;
        }
        u.o0 = c.opacity;
        out.push(c);
        return c;
      });
      mesh.material = Array.isArray(src) ? cloned : cloned[0];
    });
    return out;
  };

  const acquireArt = (kind: number): { obj: THREE.Group; mats: THREE.Material[] } => {
    const bucket = pool.get(kind);
    const hit = bucket?.pop();
    if (hit) return hit;
    const obj = buildArtifact(theme, kind, artSize);
    return { obj, mats: cloneMaterials(obj) };
  };

  const releaseArt = (rec: TileRec) => {
    if (!rec.art) return;
    artLayer?.remove(rec.art);
    rec.art.visible = false;
    let bucket = pool.get(rec.artKind);
    if (!bucket) {
      bucket = [];
      pool.set(rec.artKind, bucket);
    }
    // Two of every kind exist at most, plus a little slack for re-deals.
    if (bucket.length < 4) bucket.push({ obj: rec.art, mats: rec.artMats });
    else for (const m of rec.artMats) m.dispose();
    rec.art = null;
    rec.artKind = HIDDEN;
    rec.artMats = [];
  };

  /** Drop every artifact instance and clone — used on re-layout and teardown. */
  const clearArtifacts = () => {
    for (const rec of tiles) releaseArt(rec);
    pool.forEach((bucket) => {
      for (const e of bucket) for (const m of e.mats) m.dispose();
    });
    pool.clear();
  };

  // ==========================================================================
  // Board construction
  // ==========================================================================

  const teardown = () => {
    clearArtifacts();
    if (group && ctx) ctx.root.remove(group);
    if (group) group.clear();
    for (const m of ownMats) m.dispose();
    ownMats.length = 0;
    geoCache.forEach((g) => g.dispose());
    matCache.forEach((m) => m.dispose());
    geoCache.clear();
    matCache.clear();
    tiles.length = 0;
    slabs.length = 0;
    lines.length = 0;
    shocks.length = 0;
    group = null;
    tileLayer = null;
    artLayer = null;
    fxLayer = null;
    galaxy = null;
    turnLight = null;
  };

  const own = <T extends THREE.Material>(m: T): T => {
    ownMats.push(m);
    return m;
  };

  const buildBoard = (b: MemoryBoard) => {
    if (!ctx) return;
    teardown();

    cols = b.cols;
    rows = b.rows;
    theme = b.theme;
    // Largest square pitch that keeps the whole grid inside the footprint.
    step = Math.min(S / cols, S / rows);
    tile = step * 0.9;
    slabH = tile * 0.17;
    // buildArtifact fits a `size` cube, so this is the artifact's full height:
    // just under a tile, which reads at the scale of a chess piece.
    artSize = tile * 0.95;
    const gridW = (cols - 1) * step;
    const gridD = (rows - 1) * step;
    boardR = Math.max(0.0001, Math.hypot(gridW, gridD) * 0.5);
    layoutSig = `${cols}x${rows}:${b.theme}`;

    group = new THREE.Group();
    ctx.root.add(group);
    tileLayer = new THREE.Group();
    artLayer = new THREE.Group();
    fxLayer = new THREE.Group();
    group.add(tileLayer, artLayer, fxLayer);

    glowTex = glowTex ?? makeGlowTexture();

    // --- galaxy disc + grounding halo ------------------------------------
    galaxy = createGalaxy();
    galaxy.position.y = -S * 0.55;
    group.add(galaxy);

    const halo = new THREE.Mesh(
      geo('halo', () =>
        new THREE.TorusGeometry(Math.max(gridW, gridD) * 0.62 + tile, S * 0.004, 8, 96).rotateX(
          -Math.PI / 2,
        ),
      ),
      mat(
        'halo',
        () =>
          new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.2,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
      ),
    );
    halo.position.y = -slabH * 1.4;
    group.add(halo);

    turnLight = new THREE.PointLight(0xffffff, 1.1, S * 4);
    turnLight.position.set(0, S * 0.9, 0);
    group.add(turnLight);

    // --- shared tile resources -------------------------------------------
    const corner = tile * 0.18;
    // Bevelled glass slab whose top face lands exactly on y = 0.
    const slabGeo = geo('slab', () => {
      const shape = roundedRect(tile / 2, tile / 2, corner);
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: slabH * 0.7,
        bevelEnabled: true,
        bevelThickness: slabH * 0.15,
        bevelSize: tile * 0.03,
        bevelSegments: 2,
        curveSegments: 3,
      });
      g.rotateX(-Math.PI / 2);
      g.translate(0, -slabH * 0.7 - slabH * 0.15, 0);
      return g;
    });

    // The Cosmic Tac-Toe glass recipe, pulled darker: this board is a field of
    // eighteen to thirty tiles rather than nine, so the environment reflection
    // is dialled back to stop the far half reading as frosted white.
    const downMat = mat(
      'slab-down',
      () =>
        new THREE.MeshPhysicalMaterial({
          color: 0x101c33,
          metalness: 0.05,
          roughness: 0.3,
          transmission: 0.5,
          thickness: tile * 0.42,
          ior: 1.35,
          transparent: true,
          opacity: 0.92,
          clearcoat: 0.75,
          clearcoatRoughness: 0.28,
          envMapIntensity: 0.3,
          side: THREE.DoubleSide,
        }),
    );
    for (const s of [0, 1] as PlayerSlot[]) {
      mat(
        `slab-own-${s}`,
        () =>
          new THREE.MeshPhysicalMaterial({
            color: slotColor(s).clone().multiplyScalar(0.34),
            metalness: 0.1,
            roughness: 0.2,
            transmission: 0.45,
            thickness: tile * 0.42,
            ior: 1.4,
            transparent: true,
            opacity: 0.94,
            clearcoat: 1,
            clearcoatRoughness: 0.16,
            emissive: slotColor(s),
            emissiveIntensity: 0.3,
            envMapIntensity: 0.4,
            side: THREE.DoubleSide,
          }),
      );
    }

    const borderGeo = geo('border', () => {
      const pts = roundedRect(tile / 2, tile / 2, corner).getPoints(56);
      const v: THREE.Vector3[] = [];
      for (const p of pts) v.push(new THREE.Vector3(p.x, 0, p.y));
      return new THREE.BufferGeometry().setFromPoints(v);
    });
    const borderMat = mat(
      'border',
      () =>
        new THREE.LineBasicMaterial({
          color: IDLE_TINT,
          transparent: true,
          opacity: 0.75,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
    );
    for (const s of [0, 1] as PlayerSlot[]) {
      mat(
        `border-own-${s}`,
        () =>
          new THREE.LineBasicMaterial({
            color: slotColor(s),
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
      );
    }

    const faceGeo = geo('face', () =>
      new THREE.PlaneGeometry(tile * 1.02, tile * 1.02).rotateX(-Math.PI / 2),
    );
    const ringGeo = geo('ring', () =>
      new THREE.RingGeometry(tile * 0.34, tile * 0.41, 48).rotateX(-Math.PI / 2),
    );
    const scanGeo = geo('scan', () =>
      new THREE.TorusGeometry(artSize * 0.36, artSize * 0.022, 6, 40).rotateX(-Math.PI / 2),
    );

    // --- tiles -------------------------------------------------------------
    for (let t = 0; t < cols * rows; t++) {
      const c = t % cols;
      const r = Math.floor(t / cols);
      const x = (c - (cols - 1) / 2) * step;
      const z = (r - (rows - 1) / 2) * step;

      const slab = new THREE.Mesh(slabGeo, downMat);
      slab.position.set(x, 0, z);
      slab.userData.tile = t;
      tileLayer.add(slab);
      slabs.push(slab);

      const border = new THREE.LineLoop(borderGeo, borderMat);
      border.position.set(x, tile * 0.004, z);
      border.renderOrder = 3;
      tileLayer.add(border);

      const faceMat = own(
        new THREE.MeshBasicMaterial({
          color: IDLE_TINT,
          map: glowTex,
          transparent: true,
          opacity: 0.14,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.set(x, tile * 0.006, z);
      face.renderOrder = 2;
      tileLayer.add(face);

      const fxMat = own(
        new THREE.MeshBasicMaterial({
          color: 0xbdf3ff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      const ring = new THREE.Mesh(ringGeo, fxMat);
      ring.position.set(x, tile * 0.012, z);
      ring.visible = false;
      ring.renderOrder = 4;
      fxLayer.add(ring);

      const scan = new THREE.Mesh(scanGeo, fxMat);
      scan.position.set(x, 0, z);
      scan.visible = false;
      scan.renderOrder = 4;
      fxLayer.add(scan);

      tiles.push({
        index: t,
        x,
        z,
        radial: clamp01(Math.hypot(x, z) / boardR),
        slab,
        border,
        face,
        faceMat,
        ring,
        scan,
        fxMat,
        owner: null,
        shownOwner: null,
        kind: HIDDEN,
        mode: 'idle',
        art: null,
        artKind: HIDDEN,
        artMats: [],
        form: 0,
        formTarget: 0,
        delay: 0,
        open: 0,
        openTarget: 0,
        lift: 0,
        liftTarget: 0,
        scale: 1,
        scaleTarget: 1,
        spinRate: 0,
        spinTarget: 0,
        spin: (t * 137.5 * Math.PI) / 180,
        chill: 0,
        chillTarget: 0,
        tint: 0,
        tintTarget: 0,
        tintCol: new THREE.Color(0xffffff),
        flare: 0,
        hover: 0,
        glowCol: new THREE.Color(IDLE_TINT),
        glowTargetCol: new THREE.Color(IDLE_TINT),
        glowBase: 0.14,
      });
    }

    // --- constellation lines (one per pair, revealed as they are claimed) --
    const lineGeo = geo('line', () =>
      new THREE.CylinderGeometry(1, 1, 1, 7, 1, true).rotateX(Math.PI / 2),
    );
    const beadGeo = geo('bead', () => new THREE.SphereGeometry(1, 10, 8));
    for (const s of [0, 1] as PlayerSlot[]) {
      mat(
        `line-${s}`,
        () =>
          new THREE.MeshBasicMaterial({
            color: slotColor(s),
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
      );
    }
    for (let i = 0; i < b.pairs; i++) {
      const mesh = new THREE.Mesh(lineGeo, matCache.get('line-0')!);
      mesh.visible = false;
      mesh.renderOrder = 3;
      fxLayer.add(mesh);
      const bead = new THREE.Mesh(beadGeo, matCache.get('line-0')!);
      bead.visible = false;
      bead.renderOrder = 5;
      fxLayer.add(bead);
      lines.push({ a: -1, b: -1, slot: 0, kind: -1, mesh, bead, grow: 0, hold: false });
    }

    // --- shockwave pool ----------------------------------------------------
    const shockGeo = geo('shock', () => new THREE.RingGeometry(0.86, 1, 96).rotateX(-Math.PI / 2));
    for (let i = 0; i < 3; i++) {
      const m = own(
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      const mesh = new THREE.Mesh(shockGeo, m);
      mesh.visible = false;
      mesh.renderOrder = 6;
      mesh.position.y = tile * 0.02;
      fxLayer.add(mesh);
      shocks.push({ mesh, mat: m, t0: -1, maxR: 1 });
    }
  };

  const fireShock = (x: number, z: number, color: THREE.Color, maxR: number, t: number) => {
    let best: Shock | null = null;
    for (const s of shocks) {
      if (s.t0 < 0) {
        best = s;
        break;
      }
      if (!best || s.t0 < best.t0) best = s;
    }
    if (!best) return;
    best.t0 = t;
    best.maxR = maxR;
    best.mesh.position.set(x, tile * 0.02, z);
    best.mat.color.copy(color);
    best.mesh.visible = true;
  };

  // ==========================================================================
  // Sync
  // ==========================================================================

  const setSlabLook = (rec: TileRec, owner: PlayerSlot | null) => {
    rec.shownOwner = owner;
    if (owner === null) {
      rec.slab.material = matCache.get('slab-down')!;
      rec.border.material = matCache.get('border')!;
      rec.glowTargetCol.copy(idleColor);
      rec.glowBase = 0.14;
    } else {
      rec.slab.material = matCache.get(`slab-own-${owner}`)!;
      rec.border.material = matCache.get(`border-own-${owner}`)!;
      rec.glowTargetCol.copy(slotColor(owner));
      rec.glowBase = 0.34;
    }
  };

  const applyMode = (rec: TileRec, mode: TileMode) => {
    rec.mode = mode;
    switch (mode) {
      case 'pick':
        rec.liftTarget = tile * 0.3;
        rec.scaleTarget = 1;
        rec.spinTarget = 0.85;
        rec.chillTarget = 0;
        rec.tintTarget = 0;
        rec.openTarget = 1;
        rec.fxMat.color.setHex(0xbdf3ff);
        break;
      case 'cool':
        // Inert: the pair is left on the table for the next player to study.
        rec.liftTarget = tile * 0.24;
        rec.scaleTarget = 0.92;
        rec.spinTarget = 0.1;
        rec.chillTarget = 1;
        rec.tintTarget = 0;
        rec.openTarget = 1;
        break;
      case 'nova':
        rec.liftTarget = tile * 0.26;
        rec.scaleTarget = 0.9;
        rec.spinTarget = 0.55;
        rec.chillTarget = 0;
        rec.tintTarget = 1;
        rec.openTarget = 1;
        if (novaSlot !== null) {
          rec.tintCol.copy(slotColor(novaSlot));
          rec.fxMat.color.copy(slotColor(novaSlot));
        }
        break;
      case 'trophy':
        rec.liftTarget = tile * 0.03;
        rec.scaleTarget = 0.55;
        rec.spinTarget = 0.32;
        rec.chillTarget = 0;
        rec.tintTarget = 0.55;
        rec.openTarget = 0;
        if (rec.owner !== null) {
          rec.tintCol.copy(slotColor(rec.owner));
          rec.fxMat.color.copy(slotColor(rec.owner));
        }
        break;
      default:
        rec.liftTarget = 0;
        rec.scaleTarget = 1;
        rec.spinTarget = 0;
        rec.chillTarget = 0;
        rec.tintTarget = 0;
        rec.openTarget = 0;
        break;
    }
  };

  const startForm = (rec: TileRec, kind: number, delay: number) => {
    if (rec.art && rec.artKind !== kind) releaseArt(rec);
    if (!rec.art && artLayer) {
      const e = acquireArt(kind);
      rec.art = e.obj;
      rec.artMats = e.mats;
      rec.artKind = kind;
      rec.art.visible = true;
      rec.art.position.set(rec.x, 0, rec.z);
      rec.art.scale.setScalar(0.0001);
      artLayer.add(rec.art);
    }
    rec.formTarget = 1;
    rec.delay = delay;
  };

  const startUnform = (rec: TileRec, delay: number) => {
    rec.formTarget = 0;
    rec.delay = delay;
  };

  /** Re-derive the constellation from `owners` + `deck`, pairing by kind. */
  const syncLines = (b: MemoryBoard) => {
    let n = 0;
    const seen = new Map<string, number>();
    for (let t = 0; t < b.owners.length; t++) {
      const owner = b.owners[t];
      const kind = b.deck[t];
      if (owner === null || kind === HIDDEN) continue;
      const key = `${owner}:${kind}`;
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, t);
        continue;
      }
      if (n >= lines.length) break;
      const rec = lines[n++];
      const fresh = rec.a !== first || rec.b !== t || rec.slot !== owner;
      rec.a = first;
      rec.b = t;
      rec.slot = owner;
      rec.kind = kind;
      if (fresh) {
        rec.grow = 0;
        // Hold the newest line back until the celebration actually detonates.
        rec.hold =
          celebA >= 0 &&
          !celebClaimed &&
          (first === celebA || first === celebB || t === celebA || t === celebB);
        const ta = tiles[first];
        const tb = tiles[t];
        const dx = tb.x - ta.x;
        const dz = tb.z - ta.z;
        const len = Math.hypot(dx, dz);
        rec.mesh.position.set((ta.x + tb.x) / 2, tile * 0.09, (ta.z + tb.z) / 2);
        rec.mesh.rotation.y = Math.atan2(dx, dz);
        rec.mesh.scale.set(tile * 0.022, tile * 0.022, len);
      }
      rec.mesh.material = matCache.get(`line-${owner}`)!;
      rec.bead.material = matCache.get(`line-${owner}`)!;
      rec.bead.scale.setScalar(tile * 0.06);
    }
    for (let i = n; i < lines.length; i++) {
      const rec = lines[i];
      rec.a = -1;
      rec.b = -1;
      rec.grow = 0;
      rec.hold = false;
      rec.mesh.visible = false;
      rec.bead.visible = false;
    }
  };

  const hardReset = () => {
    for (const rec of tiles) {
      releaseArt(rec);
      rec.owner = null;
      rec.kind = HIDDEN;
      rec.form = 0;
      rec.formTarget = 0;
      rec.delay = 0;
      rec.open = 0;
      rec.lift = 0;
      rec.chill = 0;
      rec.tint = 0;
      rec.flare = 0;
      rec.hover = 0;
      setSlabLook(rec, null);
      applyMode(rec, 'idle');
      rec.glowCol.copy(idleColor);
      rec.slab.position.y = 0;
    }
    for (const rec of lines) {
      rec.a = -1;
      rec.b = -1;
      rec.grow = 0;
      rec.hold = false;
      rec.mesh.visible = false;
      rec.bead.visible = false;
    }
    for (const s of shocks) {
      s.t0 = -1;
      s.mesh.visible = false;
    }
    celebT0 = -1;
    celebKey = -1;
    celebA = -1;
    celebB = -1;
    celebClaimed = false;
    igniteT0 = -1;
    novaActive = false;
    novaSlot = null;
    winnerSlot = null;
    winnerTiles.clear();
    hoverTile = -1;
  };

  // ==========================================================================
  // GameScene
  // ==========================================================================

  return {
    init(c) {
      ctx = c;
      S = c.boardSize;
      p0Color.set(c.profiles[0]?.color ?? '#22d3ee');
      p1Color.set(c.profiles[1]?.color ?? '#fbbf24');
      lastTime = 0;
    },

    update(core, prev) {
      if (!ctx) return;
      const b = core.board as MemoryBoard;
      if (`${b.cols}x${b.rows}:${b.theme}` !== layoutSig) buildBoard(b);
      if (!tileLayer) return;

      const reset = prev === null || core.moveCount < prev.moveCount;
      if (reset) hardReset();

      const prevBoard = prev && !reset ? (prev.board as MemoryBoard) : null;

      // --- Nova Pulse edges -------------------------------------------------
      const pulse = b.pulse ?? null;
      const hadPulse = novaActive;
      const nowPulse = pulse !== null && pulse.length > 0;
      novaSlot = b.pulseBy;
      const novaStarting = nowPulse && !hadPulse;
      const novaEnding = !nowPulse && hadPulse;
      novaActive = nowPulse;

      // --- match celebration ------------------------------------------------
      if (b.lastMatch && core.moveCount !== celebKey) {
        celebKey = core.moveCount;
        celebT0 = -1; // stamped on the next frame
        celebA = b.lastMatch.tiles[0];
        celebB = b.lastMatch.tiles[1];
        celebSlot = b.lastMatch.slot;
        celebClaimed = false;
      } else if (!b.lastMatch && celebT0 >= 0 && celebClaimed) {
        celebT0 = -1;
        celebA = -1;
        celebB = -1;
      }
      const celebrating = celebA >= 0 && !celebClaimed;

      // --- winner -----------------------------------------------------------
      const w = core.winner;
      const nextWinner: PlayerSlot | null = w === 0 || w === 1 ? w : null;
      if (nextWinner !== winnerSlot) igniteT0 = -1;
      winnerSlot = nextWinner;
      winnerTiles.clear();
      if (core.winningCells) for (const t of core.winningCells) winnerTiles.add(t);

      // --- per-tile targets --------------------------------------------------
      for (const rec of tiles) {
        const t = rec.index;
        const owner = b.owners[t];
        const kind = b.deck[t];
        rec.owner = owner;
        rec.kind = kind;

        let mode: TileMode = 'idle';
        if (owner !== null) mode = 'trophy';
        // A pulse always wins the look: the only tiles that can be both up and
        // pulsing are a settled mismatch, and they belong to the wave too.
        else if (nowPulse && pulse.includes(t)) mode = 'nova';
        else if (b.up.includes(t)) mode = b.pendingClear ? 'cool' : 'pick';
        // A kind this client has never been shown simply stays face down.
        if (kind === HIDDEN) mode = 'idle';

        // The claimed pair keeps its "picked" pose through the celebration —
        // the trophy pose is applied at the detonation, so the arc has real
        // magnitudes to settle *from* instead of collapsing on the first frame.
        const inCeleb = celebrating && (t === celebA || t === celebB);
        if (mode !== rec.mode && !(inCeleb && mode === 'trophy')) applyMode(rec, mode);

        // Claimed tiles only take the owner's colour once the pair detonates.
        const showOwner = inCeleb ? null : owner;
        if (showOwner !== rec.shownOwner) setSlabLook(rec, showOwner);

        if (mode === 'idle') {
          if (rec.art) {
            const delay = novaEnding && prevBoard?.pulse?.includes(t)
              ? (1 - rec.radial) * NOVA_COLLAPSE_MS
              : 0;
            startUnform(rec, delay);
          }
        } else {
          const delay = novaStarting && mode === 'nova' ? rec.radial * NOVA_SPREAD_MS : 0;
          if (!rec.art || rec.artKind !== kind || rec.formTarget === 0) startForm(rec, kind, delay);
        }
      }

      if (novaStarting && novaSlot !== null) novaShockPending = true;

      syncLines(b);
    },

    animate(t, currentSlot, winner) {
      if (!tileLayer) return;
      const dtMs = lastTime ? Math.min(60, t - lastTime) : 16;
      lastTime = t;
      const dt = dtMs / 1000;
      // Frame-rate independent smoothing factor.
      const k = 1 - Math.exp(-dt * 7);

      if (galaxy) galaxy.rotation.y += dt * 0.08;

      if (novaShockPending) {
        novaShockPending = false;
        fireShock(0, 0, slotColor(novaSlot ?? currentSlot), boardR + tile * 1.8, t);
      }

      // --- turn tint --------------------------------------------------------
      tmpColor.copy(slotColor(currentSlot));
      if (turnLight) {
        turnLight.intensity = winner !== null ? 1.0 : 1.0 + Math.sin(t / 400) * 0.4;
        turnLight.color.lerp(tmpColor, 0.05);
      }
      const bm = matCache.get('border') as THREE.LineBasicMaterial | undefined;
      if (bm) {
        bm.color.lerp(tmpColor, 0.05);
        bm.opacity = winner !== null ? 0.4 : 0.62 + Math.sin(t / 820) * 0.18;
      }

      // --- match celebration timeline ---------------------------------------
      let celebP = -1;
      if (celebA >= 0) {
        if (celebT0 < 0) celebT0 = t;
        celebP = (t - celebT0) / CELEBRATE_MS;
        if (!celebClaimed && celebP >= CLAIM_AT) {
          celebClaimed = true;
          const ta = tiles[celebA];
          const tb = tiles[celebB];
          setSlabLook(ta, celebSlot);
          setSlabLook(tb, celebSlot);
          applyMode(ta, 'trophy');
          applyMode(tb, 'trophy');
          fireShock(
            (ta.x + tb.x) / 2,
            (ta.z + tb.z) / 2,
            slotColor(celebSlot),
            boardR + tile * 2,
            t,
          );
          for (const l of lines) if (l.hold) l.hold = false;
        }
        if (celebP >= 1) {
          celebP = -1;
          celebA = -1;
          celebB = -1;
        }
      }

      // --- winner ignite ----------------------------------------------------
      if (winnerSlot !== null && igniteT0 < 0) igniteT0 = t;
      const ignite = igniteT0 >= 0 ? clamp01((t - igniteT0) / 900) : 0;

      // --- tiles -------------------------------------------------------------
      for (let i = 0; i < tiles.length; i++) {
        const rec = tiles[i];

        // form / delay
        if (rec.delay > 0) rec.delay -= dtMs;
        if (rec.delay <= 0) {
          if (rec.formTarget > rec.form) rec.form = Math.min(1, rec.form + dtMs / FORM_MS);
          else if (rec.formTarget < rec.form) rec.form = Math.max(0, rec.form - dtMs / UNFORM_MS);
        }
        if (rec.form === 0 && rec.formTarget === 0 && rec.art) releaseArt(rec);

        const p = rec.form;
        // The formation cue: one hump, identical forwards and backwards.
        const fx = Math.sin(Math.PI * p);

        // smoothed channels
        const openWant = rec.openTarget > 0 && rec.mode !== 'trophy' ? p : 0;
        rec.open += (openWant - rec.open) * k;
        rec.lift += (rec.liftTarget - rec.lift) * k;
        rec.scale += (rec.scaleTarget - rec.scale) * k;
        rec.spinRate += (rec.spinTarget - rec.spinRate) * k;
        rec.chill += (rec.chillTarget - rec.chill) * k;
        rec.tint += (rec.tintTarget - rec.tint) * k;
        rec.glowCol.lerp(rec.glowTargetCol, k);

        // the portal opens: the frosted slab sinks away and the light beneath
        // it comes up through the gap
        rec.slab.position.y = -slabH * 0.6 * rec.open + rec.hover * tile * 0.03;

        // idle shimmer travels across the grid, wave-front on the diagonal
        const col = i % cols;
        const row = (i / cols) | 0;
        const wave = Math.sin(t * 0.0013 - (col + row) * 0.62);
        const shimmer = wave > 0 ? wave * wave * wave * 0.13 : 0;
        const claimed = rec.shownOwner !== null;
        const winFlare =
          claimed && winnerSlot === rec.shownOwner && winnerTiles.has(rec.index)
            ? (0.22 + Math.sin(t / 190) * 0.16) * ignite
            : 0;
        rec.faceMat.color.copy(rec.glowCol);
        rec.faceMat.opacity = Math.min(
          1,
          rec.glowBase +
            rec.open * 0.34 +
            (claimed ? 0 : shimmer) +
            rec.hover * 0.28 +
            fx * 0.35 +
            winFlare,
        );

        // formation ring at the surface + a scan ring riding up the artifact
        const showFx = fx > 0.012;
        rec.ring.visible = showFx;
        rec.scan.visible = showFx;
        if (showFx) {
          rec.fxMat.opacity = fx * 0.62;
          const rs = 0.4 + p * 0.85;
          rec.ring.scale.set(rs, 1, rs);
          rec.scan.position.y = p * artSize * rec.scale * 0.9 + tile * 0.02;
          const ss = 1.15 - p * 0.55;
          rec.scan.scale.set(ss, ss, ss);
        }

        // hover falls back to 0 unless hover() renewed it this frame
        rec.hover += ((hoverTile === rec.index ? 1 : 0) - rec.hover) * k;

        const art = rec.art;
        if (!art) continue;

        rec.spin += rec.spinRate * dt;

        const grow = easeOutBack(p);
        const rise = easeOut(p);
        let ax = rec.x;
        let az = rec.z;
        let ay = rec.lift * rise;
        let scl = rec.scale;
        rec.flare = winFlare > 0 ? 0.5 + Math.sin(t / 170) * 0.5 : 0;

        // --- celebration override: rise, rush, orbit, detonate, settle -----
        // Magnitudes here are absolute rather than multiples of the resting
        // pose, so the arc keeps its shape while the trophy targets take over
        // underneath it; the final phase blends back onto the resting pose.
        if (celebP >= 0 && (rec.index === celebA || rec.index === celebB)) {
          const partner = tiles[rec.index === celebA ? celebB : celebA];
          const mx = (rec.x + partner.x) / 2;
          const mz = (rec.z + partner.z) / 2;
          const d0 = Math.hypot(rec.x - mx, rec.z - mz);
          const a0 = Math.atan2(rec.z - mz, rec.x - mx);
          const peak = tile * 0.72;

          if (celebP < 0.2) {
            const u = easeOut(celebP / 0.2);
            ay = rec.lift * rise * (1 - u) + peak * u;
            scl = 1 + u * 0.2;
            rec.spin += dt * 2.4 * u;
          } else if (celebP < CLAIM_AT) {
            // In toward each other, one full turn about the midpoint, back out:
            // radius and angle both land exactly on the tile they started over.
            const u = (celebP - 0.2) / (CLAIM_AT - 0.2);
            const e = easeInOut(u);
            const rr = d0 * (1 - 0.68 * Math.sin(u * Math.PI));
            const ang = a0 + Math.PI * 2 * e;
            ax = mx + Math.cos(ang) * rr;
            az = mz + Math.sin(ang) * rr;
            ay = peak + Math.sin(u * Math.PI) * tile * 0.34;
            scl = 1.2 + Math.sin(u * Math.PI) * 0.25;
            rec.spin += dt * (3.6 + u * 3);
            rec.flare = 0.35 + u * 0.55;
          } else {
            const u = clamp01((celebP - CLAIM_AT) / (1 - CLAIM_AT));
            const e = easeInOut(u);
            ay = peak * (1 - e) + rec.lift * rise * e;
            scl = 1.2 * (1 - e) + rec.scale * e;
            rec.spin += dt * (3.6 * (1 - e) + 0.4);
            rec.flare = (1 - u) * 1.1;
          }
          rec.tintCol.copy(slotColor(celebSlot));
          rec.tint = Math.max(rec.tint, 0.6);
        } else {
          // resting bob, scaled by how materialised the artifact is
          ay += Math.sin(t / 640 + i * 0.9) * tile * 0.016 * p;
        }

        art.position.set(ax, ay, az);
        art.rotation.y = rec.spin;
        art.scale.setScalar(Math.max(0.0001, grow * scl));

        // --- per-instance look: fade, chill, tint, flare -------------------
        const fade = clamp01(p * 1.7);
        for (let m = 0; m < rec.artMats.length; m++) {
          const mm = rec.artMats[m] as THREE.MeshStandardMaterial;
          const u = mm.userData as {
            c0?: THREE.Color;
            cChill?: THREE.Color;
            e0?: THREE.Color;
            ei0?: number;
            o0?: number;
          };
          if (u.c0 && u.cChill) {
            mm.color.copy(u.c0).lerp(u.cChill, rec.chill).lerp(rec.tintCol, rec.tint * 0.45);
          }
          if (u.e0) {
            mm.emissive.copy(u.e0).lerp(rec.tintCol, Math.max(rec.tint, rec.flare * 0.6));
            mm.emissiveIntensity =
              (u.ei0 ?? 1) * (1 - 0.8 * rec.chill) + rec.tint * 0.4 + rec.flare * 1.1 + fx * 0.45;
          }
          mm.opacity = (u.o0 ?? 1) * fade;
        }
      }

      // --- constellation ------------------------------------------------------
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.a < 0) continue;
        if (l.hold) {
          l.mesh.visible = false;
          l.bead.visible = false;
          continue;
        }
        if (l.grow < 1) l.grow = Math.min(1, l.grow + dtMs / LINE_GROW_MS);
        const g = easeOut(l.grow);
        const ta = tiles[l.a];
        const tb = tiles[l.b];
        const len = Math.hypot(tb.x - ta.x, tb.z - ta.z) * g;
        l.mesh.visible = true;
        l.mesh.scale.set(tile * 0.022, tile * 0.022, Math.max(0.0001, len));
        l.mesh.position.set(
          ta.x + (tb.x - ta.x) * g * 0.5,
          tile * 0.09,
          ta.z + (tb.z - ta.z) * g * 0.5,
        );

        const isWinner = winnerSlot === l.slot;
        const lm = l.mesh.material as THREE.MeshBasicMaterial;
        lm.opacity = isWinner
          ? 0.45 + ignite * (0.45 + Math.sin(t / 210) * 0.2)
          : 0.34 + Math.sin(t / 1100 + i) * 0.08;

        // a bead of light runs the winner's lines when the game is decided
        if (isWinner && ignite > 0.05) {
          const u = ((t / 1500 + i * 0.17) % 1) * g;
          l.bead.visible = true;
          l.bead.position.set(
            ta.x + (tb.x - ta.x) * u,
            tile * 0.09,
            ta.z + (tb.z - ta.z) * u,
          );
          const bs = tile * 0.055 * (0.7 + Math.sin(t / 150) * 0.3);
          l.bead.scale.setScalar(bs);
        } else if (l.bead.visible) {
          l.bead.visible = false;
        }
      }

      // --- shockwaves ---------------------------------------------------------
      for (const s of shocks) {
        if (s.t0 < 0) continue;
        const u = (t - s.t0) / SHOCK_MS;
        if (u >= 1) {
          s.t0 = -1;
          s.mesh.visible = false;
          continue;
        }
        const e = easeOut(u);
        const r = Math.max(0.0001, s.maxR * e);
        s.mesh.scale.set(r, 1, r);
        s.mat.opacity = (1 - u) * (1 - u) * 0.95;
      }
    },

    pickMove(raycaster, core) {
      if (core.winner !== null) return null;
      const b = core.board as MemoryBoard;
      // The rock-paper-scissors opener is played entirely in the HUD.
      if (b.phase !== 'play') return null;
      if (slabs.length === 0) return null;

      const hits = raycaster.intersectObjects(slabs, false);
      if (hits.length === 0) return null;
      const t = hits[0].object.userData.tile as number | undefined;
      if (typeof t !== 'number') return null;

      if (b.owners[t] !== null) return null;
      // A settled mismatch is selectable again; this turn's own picks are not.
      if (!b.pendingClear && b.up.includes(t)) return null;
      return { tile: t };
    },

    hover(raycaster, core) {
      if (!raycaster || core.winner !== null) {
        hoverTile = -1;
        return;
      }
      const b = core.board as MemoryBoard;
      if (b.phase !== 'play' || slabs.length === 0) {
        hoverTile = -1;
        return;
      }
      const hits = raycaster.intersectObjects(slabs, false);
      const t = hits.length ? (hits[0].object.userData.tile as number) : -1;
      const legal =
        t >= 0 && b.owners[t] === null && (b.pendingClear || !b.up.includes(t));
      hoverTile = legal ? t : -1;
    },

    dispose() {
      teardown();
      glowTex?.dispose();
      glowTex = null;
      disposeArtifactCache();
      layoutSig = '';
      lastTime = 0;
      hoverTile = -1;
      winnerSlot = null;
      winnerTiles.clear();
      igniteT0 = -1;
      novaActive = false;
      novaSlot = null;
      celebT0 = -1;
      celebKey = -1;
      celebA = -1;
      celebB = -1;
      celebClaimed = false;
      ctx = null;
    },
  } satisfies GameScene;
}

export default createMemoryScene;
