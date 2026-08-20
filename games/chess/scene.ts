// ============================================================================
// Astral Chess — 3D board.
//
// A liquid-glass chess set built entirely from procedural geometry:
//
//  • Board: 64 glass tiles (dark smoked / frosted light) sunk into an extruded
//    glass frame with a neon outline, floating over a galaxy particle disc.
//  • Pieces: Staunton-inspired silhouettes revolved from hand-authored
//    LatheGeometry profiles, with battlements (rook), an extruded horse-head
//    sweep (knight), a mitre notch (bishop), a coronet of pearls (queen) and a
//    cross finial (king). One geometry set per kind, shared across all 32
//    pieces; two materials per side (warm frosted glass vs dark smoked glass,
//    each tinted by the player's profile colour).
//  • Interaction: tap a piece to select (it lifts and glows, legal quiet
//    squares get soft dots and captures get rings), tap a target to move.
//  • Update: incremental — the moved piece glides (knights hop), captures
//    shrink and fade, castling walks the rook, en passant fades the bypassed
//    pawn, promotion swaps in a queen with a sparkle pop. A full resync only
//    happens on rematch or an out-of-band board change.
//
// Board indexing follows games/chess/logic.ts: a1 = 0 … h8 = 63, index =
// rank * 8 + file. White (slot 0) sits on rank 0, nearest the default camera.
// ============================================================================

import * as THREE from 'three';
import type { GameScene, SceneContext } from '../../engine/sceneTypes';
import type { GameCore, Move, PlayerSlot } from '../../types';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chessLogic, FILE, RANK, SQ, type ChessBoard, type PieceCode } from './logic';
import { sound } from '../../services/sound';

// -- tuning -----------------------------------------------------------------

const MOVE_MS = 430;
const CASTLE_ROOK_MS = 480;
const CAPTURE_MS = 360;
const SPAWN_MS = 520;
const FLASH_MS = 640;
const TOPPLE_MS = 1600;
const TOPPLE_ANGLE = (80 * Math.PI) / 180;

const CHECK_RED = 0xff4d61;
const GOLD = 0xfcd34d;

const MAX_DOTS = 32;
const MAX_RINGS = 12;

type Kind = 'P' | 'N' | 'B' | 'R' | 'Q' | 'K';

/** Piece height as a multiple of one tile. */
const HEIGHT: Record<Kind, number> = { P: 0.72, N: 0.88, B: 0.94, R: 0.80, Q: 1.06, K: 1.20 };

// -- easing -----------------------------------------------------------------

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c = 1.9;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

// ---------------------------------------------------------------------------
// Lathe profile authoring
//
// Profiles are lists of [radius, height] pairs; radius is in tile units and
// height is normalised 0…1 (scaled by the piece's HEIGHT entry at build time).
// `curve` runs are resampled through a Catmull-Rom spline so the silhouettes
// read as turned wood rather than a stack of cones.
// ---------------------------------------------------------------------------

type P2 = [number, number];
type Seg = P2 | { c: P2[]; n: number };

const smoothRun = (pts: P2[], steps: number): P2[] => {
  const curve = new THREE.CatmullRomCurve3(
    pts.map(([r, y]) => new THREE.Vector3(r, y, 0)),
    false,
    'catmullrom',
    0.5,
  );
  return curve.getPoints(steps).map((v) => [Math.max(0, v.x), v.y] as P2);
};

/** Flatten authored segments into a deduplicated bottom-to-top profile. */
const profile = (segs: Seg[]): P2[] => {
  const out: P2[] = [];
  const push = (p: P2) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) return;
    out.push(p);
  };
  for (const s of segs) {
    if (Array.isArray(s)) push(s);
    else for (const p of smoothRun(s.c, s.n)) push(p);
  }
  return out;
};

const PROFILES: Record<Kind, P2[]> = {
  P: profile([
    [0, 0],
    [0.34, 0],
    [0.34, 0.048],
    { c: [[0.34, 0.048], [0.312, 0.082], [0.238, 0.112], [0.188, 0.152], [0.162, 0.215]], n: 9 },
    { c: [[0.162, 0.215], [0.14, 0.3], [0.126, 0.4], [0.122, 0.472]], n: 8 },
    { c: [[0.122, 0.472], [0.176, 0.504], [0.166, 0.544], [0.116, 0.566]], n: 7 },
    { c: [[0.116, 0.566], [0.156, 0.612], [0.19, 0.7], [0.186, 0.8], [0.15, 0.886], [0.09, 0.955]], n: 14 },
    [0, 0.99],
  ]),
  R: profile([
    [0, 0],
    [0.365, 0],
    [0.365, 0.055],
    { c: [[0.365, 0.055], [0.336, 0.09], [0.268, 0.124], [0.244, 0.19]], n: 8 },
    { c: [[0.244, 0.19], [0.231, 0.3], [0.231, 0.45], [0.246, 0.552]], n: 9 },
    { c: [[0.246, 0.552], [0.286, 0.6], [0.324, 0.632]], n: 6 },
    [0.336, 0.662],
    [0.336, 0.762],
    [0.238, 0.762],
    [0.238, 0.702],
    { c: [[0.238, 0.702], [0.15, 0.686], [0, 0.68]], n: 5 },
  ]),
  N: profile([
    [0, 0],
    [0.355, 0],
    [0.355, 0.05],
    { c: [[0.355, 0.05], [0.326, 0.086], [0.252, 0.116], [0.206, 0.16], [0.184, 0.226]], n: 9 },
    { c: [[0.184, 0.226], [0.174, 0.292], [0.198, 0.346], [0.216, 0.398]], n: 7 },
    [0.14, 0.418],
    [0, 0.418],
  ]),
  B: profile([
    [0, 0],
    [0.35, 0],
    [0.35, 0.05],
    { c: [[0.35, 0.05], [0.32, 0.082], [0.246, 0.11], [0.2, 0.15], [0.175, 0.21]], n: 9 },
    { c: [[0.175, 0.21], [0.15, 0.29], [0.136, 0.38], [0.13, 0.438]], n: 8 },
    { c: [[0.13, 0.438], [0.186, 0.474], [0.176, 0.514], [0.121, 0.536]], n: 7 },
    {
      c: [[0.121, 0.536], [0.166, 0.586], [0.201, 0.666], [0.206, 0.746], [0.176, 0.836], [0.116, 0.906], [0.05, 0.95]],
      n: 16,
    },
    [0, 0.962],
  ]),
  Q: profile([
    [0, 0],
    [0.375, 0],
    [0.375, 0.052],
    { c: [[0.375, 0.052], [0.346, 0.086], [0.262, 0.118], [0.212, 0.155], [0.186, 0.215]], n: 9 },
    { c: [[0.186, 0.215], [0.161, 0.3], [0.143, 0.4], [0.133, 0.49], [0.133, 0.542]], n: 10 },
    { c: [[0.133, 0.542], [0.196, 0.578], [0.186, 0.618], [0.126, 0.644]], n: 7 },
    { c: [[0.126, 0.644], [0.176, 0.7], [0.226, 0.775], [0.256, 0.844]], n: 8 },
    [0.256, 0.876],
    [0.202, 0.876],
    [0.202, 0.802],
    { c: [[0.202, 0.802], [0.13, 0.782], [0, 0.772]], n: 6 },
  ]),
  K: profile([
    [0, 0],
    [0.385, 0],
    [0.385, 0.052],
    { c: [[0.385, 0.052], [0.356, 0.086], [0.272, 0.118], [0.216, 0.152], [0.19, 0.208]], n: 9 },
    { c: [[0.19, 0.208], [0.166, 0.29], [0.149, 0.39], [0.139, 0.474], [0.139, 0.528]], n: 10 },
    { c: [[0.139, 0.528], [0.201, 0.563], [0.191, 0.603], [0.131, 0.626]], n: 7 },
    { c: [[0.131, 0.626], [0.176, 0.68], [0.222, 0.744], [0.246, 0.798]], n: 8 },
    [0.253, 0.814],
    [0.253, 0.854],
    { c: [[0.253, 0.854], [0.222, 0.868], [0.188, 0.861]], n: 5 },
    [0.188, 0.8],
    { c: [[0.188, 0.8], [0.122, 0.782], [0, 0.772]], n: 6 },
  ]),
};

/** Horse-head silhouette for the knight, in tile units (+x = facing). */
const KNIGHT_HEAD: P2[] = [
  [-0.17, 0.0],
  [-0.214, 0.14],
  [-0.226, 0.3],
  [-0.16, 0.44],
  [-0.07, 0.52],
  [0.0, 0.536],
  [0.056, 0.47],
  [0.136, 0.436],
  [0.236, 0.346],
  [0.286, 0.264],
  [0.246, 0.214],
  [0.156, 0.236],
  [0.09, 0.2],
  [0.046, 0.13],
  [0.02, 0.05],
  [0.0, 0.0],
];

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

interface Anim {
  kind: 'move' | 'capture' | 'spawn';
  /** -1 until the first animate() frame stamps the clock. */
  t0: number;
  dur: number;
  delay: number;
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  arc: number;
  /** promotions add an overshooting scale pop on arrival */
  pop: boolean;
}

interface PieceRec {
  code: PieceCode;
  kind: Kind;
  side: PlayerSlot;
  obj: THREE.Group;
  sq: number;
  anim: Anim | null;
}

export function createChessScene(): GameScene {
  let ctx: SceneContext | null = null;
  let group: THREE.Group | null = null;
  let pieceRoot: THREE.Group | null = null;

  const geoCache = new Map<string, THREE.BufferGeometry>();
  const matCache = new Map<string, THREE.Material>();
  let glowTex: THREE.Texture | null = null;

  // -- board metrics --------------------------------------------------------
  let S = 0.56;
  let tile = S / 8;
  let tileH = tile * 0.16;

  // -- board objects -------------------------------------------------------
  let boardPick: THREE.Mesh | null = null;
  let galaxy: THREE.Points | null = null;
  let neonA: THREE.LineLoop | null = null;
  let neonB: THREE.LineLoop | null = null;
  let turnLight: THREE.PointLight | null = null;
  const tileMeshes: THREE.Mesh[] = [];

  // -- highlight objects ---------------------------------------------------
  let selGlow: THREE.Mesh | null = null;
  let hoverGlow: THREE.Mesh | null = null;
  let checkGlow: THREE.Mesh | null = null;
  let flashGlow: THREE.Mesh | null = null;
  const lastGlow: THREE.Mesh[] = [];
  const dots: THREE.Mesh[] = [];
  const rings: THREE.Mesh[] = [];

  // -- piece bookkeeping ---------------------------------------------------
  const bySquare = new Map<number, PieceRec>();
  const dying: PieceRec[] = [];
  const pool = new Map<string, THREE.Group[]>();

  // -- interaction / state -------------------------------------------------
  let selected: number | null = null;
  let legalCore: GameCore | null = null;
  let legalCache: Move[] = [];
  let checkSq: number | null = null;
  let mateSq: number | null = null;
  let winnerSlot: PlayerSlot | null = null;
  let toppleT0 = -1;
  let flashT0 = -1;
  let hoverSq: number | null = null;
  let lastTime = 0;

  // -- scratch (kept out of the render loop's allocation path) --------------
  const tmpColor = new THREE.Color();
  const tmpVec = new THREE.Vector3();
  const p0Color = new THREE.Color('#e2e8f5');
  const p1Color = new THREE.Color('#7c3aed');

  // -- caches --------------------------------------------------------------

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

  // -- helpers -------------------------------------------------------------

  const sqX = (sq: number) => (FILE(sq) - 3.5) * tile;
  const sqZ = (sq: number) => (3.5 - RANK(sq)) * tile;

  /** A soft radial falloff sprite, used for every glow patch on the board. */
  const makeGlowTexture = (): THREE.Texture => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g2d = canvas.getContext('2d');
    if (g2d) {
      const grad = g2d.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
      grad.addColorStop(0.78, 'rgba(255,255,255,0.12)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g2d.fillStyle = grad;
      g2d.fillRect(0, 0, size, size);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  const glowPatch = (key: string, span: number, color: number, opacity: number): THREE.Mesh => {
    const m = new THREE.Mesh(
      geo(`glow-${key}`, () => new THREE.PlaneGeometry(span, span).rotateX(-Math.PI / 2)),
      mat(
        `glowmat-${key}`,
        () =>
          new THREE.MeshBasicMaterial({
            color,
            map: glowTex,
            transparent: true,
            opacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
      ),
    );
    m.position.y = tile * 0.012;
    m.visible = false;
    m.renderOrder = 2;
    return m;
  };

  /** Rounded-rect path used for the frame and its neon outline. */
  const roundedRect = (half: number, r: number): THREE.Path => {
    const p = new THREE.Path();
    p.moveTo(-half + r, -half);
    p.lineTo(half - r, -half);
    p.quadraticCurveTo(half, -half, half, -half + r);
    p.lineTo(half, half - r);
    p.quadraticCurveTo(half, half, half - r, half);
    p.lineTo(-half + r, half);
    p.quadraticCurveTo(-half, half, -half, half - r);
    p.lineTo(-half, -half + r);
    p.quadraticCurveTo(-half, -half, -half + r, -half);
    return p;
  };

  const createGalaxy = (): THREE.Points => {
    const count = 1500;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const inside = new THREE.Color(0x22d3ee);
    const outside = new THREE.Color(0xe879f9);
    const maxR = S * 2.3;
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const radius = Math.random() * maxR;
      const spin = radius * 4;
      const branch = (i % 3) * ((Math.PI * 2) / 3);
      pos[i3] = Math.cos(branch + spin) * radius + (Math.random() - 0.5) * 0.02;
      pos[i3 + 1] = (Math.random() - 0.5) * 0.14;
      pos[i3 + 2] = Math.sin(branch + spin) * radius + (Math.random() - 0.5) * 0.02;
      c.copy(inside).lerp(outside, radius / maxR);
      col[i3] = c.r;
      col[i3 + 1] = c.g;
      col[i3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geoCache.set('galaxy', g);
    const m = new THREE.PointsMaterial({
      size: 0.008,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.7,
    });
    matCache.set('galaxy', m);
    return new THREE.Points(g, m);
  };

  // -- materials -----------------------------------------------------------

  /**
   * The side tint is applied in sRGB HSL so the profile colour only ever
   * borrows its *hue*: white stays ivory-bright and black stays near-black no
   * matter how saturated or light the player picked their colour.
   */
  const tintedSide = (base: THREE.Color, hueFrom: THREE.Color, sat: number, light: number) => {
    const hsl = { h: 0, s: 0, l: 0 };
    hueFrom.getHSL(hsl, THREE.SRGBColorSpace);
    const c = new THREE.Color().setHSL(hsl.h, sat, light, THREE.SRGBColorSpace);
    return base.clone().lerp(c, 0.55);
  };

  const pieceMat = (side: PlayerSlot): THREE.MeshPhysicalMaterial =>
    mat(`piece-${side}`, () => {
      if (side === 0) {
        // Warm frosted glass, barely tinted by the player's colour.
        const c = tintedSide(new THREE.Color(0xfbf7ef), p0Color, 0.22, 0.9);
        return new THREE.MeshPhysicalMaterial({
          color: c,
          roughness: 0.3,
          metalness: 0.0,
          transmission: 0.34,
          thickness: tile * 0.85,
          ior: 1.46,
          clearcoat: 1,
          clearcoatRoughness: 0.14,
          sheen: 0.7,
          sheenColor: new THREE.Color(0xfff1d6),
          sheenRoughness: 0.5,
          emissive: c,
          emissiveIntensity: 0.06,
          envMapIntensity: 1.35,
        });
      }
      // Dark smoked glass — near-black with the player's hue in the highlights.
      const c = tintedSide(new THREE.Color(0x0a0d1a), p1Color, 0.5, 0.1);
      return new THREE.MeshPhysicalMaterial({
        color: c,
        roughness: 0.16,
        metalness: 0.25,
        transmission: 0.1,
        thickness: tile * 1.1,
        ior: 1.55,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        emissive: c,
        emissiveIntensity: 0.5,
        envMapIntensity: 0.75,
      });
    });

  /** Additive halo on the tile under every piece — carries player identity. */
  const ringMatFor = (side: PlayerSlot): THREE.MeshBasicMaterial =>
    mat(
      `piece-ring-${side}`,
      () =>
        new THREE.MeshBasicMaterial({
          color: side === 0 ? p0Color.clone() : p1Color.clone(),
          transparent: true,
          opacity: 0.4,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
    );

  /** Fade material for a captured piece (shared per side, opacity animated). */
  const fadeMat = (side: PlayerSlot): THREE.MeshStandardMaterial =>
    mat(
      `fade-${side}`,
      () =>
        new THREE.MeshStandardMaterial({
          color: side === 0 ? 0xf2ece0 : 0x1b2340,
          roughness: 0.35,
          metalness: 0.2,
          emissive: side === 0 ? 0xffd9a0 : 0x5b4bd6,
          emissiveIntensity: 0.55,
          transparent: true,
          opacity: 1,
          depthWrite: false,
        }),
    );

  const accentMat = (side: PlayerSlot): THREE.MeshStandardMaterial =>
    mat(
      `accent-${side}`,
      () =>
        new THREE.MeshStandardMaterial({
          color: side === 0 ? 0x2c3654 : 0xaebfe4,
          roughness: 0.35,
          metalness: 0.55,
          emissive: side === 0 ? 0x0b1020 : 0x8ea6d8,
          emissiveIntensity: side === 0 ? 0.0 : 0.25,
        }),
    );

  // -- piece templates -----------------------------------------------------

  const latheGeo = (kind: Kind): THREE.BufferGeometry => {
    const h = HEIGHT[kind] * tile;
    const pts = PROFILES[kind].map(([r, y]) => new THREE.Vector2(r * tile, y * h));
    const g = new THREE.LatheGeometry(pts, 40);
    g.computeVertexNormals();
    return g;
  };

  const knightHeadGeo = (): THREE.BufferGeometry => {
    // A closed Catmull-Rom loop keeps the outline smooth without the tangent
    // blow-up an appended duplicate start point would cause.
    const curve = new THREE.CatmullRomCurve3(
      KNIGHT_HEAD.map(([x, y]) => new THREE.Vector3(x * tile, y * tile, 0)),
      true,
      'catmullrom',
      0.5,
    );
    const shape = new THREE.Shape(curve.getPoints(72).map((v) => new THREE.Vector2(v.x, v.y)));
    const depth = tile * 0.19;
    const g = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: tile * 0.018,
      bevelSize: tile * 0.018,
      bevelSegments: 3,
      curveSegments: 1,
    });
    g.translate(0, 0, -depth / 2);
    g.rotateY(Math.PI / 2); // +x (the muzzle) becomes -z
    g.translate(0, HEIGHT.N * tile * 0.4, 0);
    g.computeVertexNormals();
    return g;
  };

  /**
   * Bake a pile of positioned parts into one buffer. Every piece then costs a
   * single draw call per material role instead of one per bolt-on detail — a
   * queen drops from eleven meshes to two.
   */
  const bake = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    if (parts.length === 1) return parts[0];
    const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(flat, false);
    // mergeGeometries only returns null on mismatched attributes; every part
    // here is position/normal/uv, but degrade to the main body rather than crash.
    if (!merged) return flat[0];
    for (let i = 0; i < parts.length; i++) {
      parts[i].dispose();
      if (flat[i] !== parts[i]) flat[i].dispose();
    }
    return merged;
  };

  /** A part positioned into the piece's local space. */
  const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, yaw = 0, pitch = 0) => {
    if (pitch) g.rotateX(pitch);
    if (yaw) g.rotateY(yaw);
    g.translate(x, y, z);
    return g;
  };

  /**
   * Build the template group for one piece kind: one baked mesh per material
   * role plus the identity halo. Meshes carry a `role` so the per-side material
   * swap on clone knows what to assign.
   */
  const buildTemplate = (kind: Kind): THREE.Group => {
    const g = new THREE.Group();
    const h = HEIGHT[kind] * tile;
    // Templates hold a shared placeholder; applyMaterials() swaps in the real
    // per-side materials on every clone (and keeps three from minting a default
    // MeshBasicMaterial per mesh, which nothing would ever dispose).
    const ph = mat('placeholder', () => new THREE.MeshBasicMaterial());

    const bodyParts: THREE.BufferGeometry[] = [latheGeo(kind)];
    const accentParts: THREE.BufferGeometry[] = [];

    if (kind === 'R') {
      // Six merlons around the crown rim.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        bodyParts.push(
          at(
            new THREE.BoxGeometry(tile * 0.112, h * 0.2, tile * 0.09),
            Math.sin(a) * tile * 0.286,
            h * 0.855,
            Math.cos(a) * tile * 0.286,
            a,
          ),
        );
      }
    }

    if (kind === 'N') {
      bodyParts.push(knightHeadGeo());
      for (const sx of [-1, 1]) {
        accentParts.push(
          at(
            new THREE.SphereGeometry(tile * 0.024, 10, 8),
            sx * tile * 0.098,
            HEIGHT.N * tile * 0.4 + tile * 0.42,
            -tile * 0.055,
          ),
        );
      }
    }

    if (kind === 'B') {
      bodyParts.push(at(new THREE.SphereGeometry(tile * 0.056, 18, 14), 0, h * 0.978, 0));
      // The mitre slit: a thin angled slab cutting the front of the teardrop.
      accentParts.push(
        at(
          new THREE.BoxGeometry(tile * 0.13, tile * 0.03, tile * 0.34),
          0,
          h * 0.73,
          -tile * 0.04,
          0,
          -0.6,
        ),
      );
    }

    if (kind === 'Q') {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        bodyParts.push(
          at(
            new THREE.SphereGeometry(tile * 0.052, 16, 12),
            Math.sin(a) * tile * 0.246,
            h * 0.888,
            Math.cos(a) * tile * 0.246,
          ),
        );
      }
      bodyParts.push(at(new THREE.SphereGeometry(tile * 0.076, 20, 14), 0, h * 0.845, 0));
    }

    if (kind === 'K') {
      bodyParts.push(
        at(new THREE.BoxGeometry(tile * 0.052, h * 0.16, tile * 0.052), 0, h * 0.925, 0),
      );
      bodyParts.push(
        at(new THREE.BoxGeometry(tile * 0.152, tile * 0.05, tile * 0.05), 0, h * 0.945, 0),
      );
    }

    const body = new THREE.Mesh(geo(`body-${kind}`, () => bake(bodyParts)), ph);
    body.userData.role = 'body';
    g.add(body);

    if (accentParts.length) {
      const accent = new THREE.Mesh(geo(`accent-${kind}`, () => bake(accentParts)), ph);
      accent.userData.role = 'accent';
      g.add(accent);
    }

    // Identity halo on the tile beneath the piece.
    const ring = new THREE.Mesh(
      geo('piece-ring', () =>
        new THREE.RingGeometry(tile * 0.405, tile * 0.442, 44).rotateX(-Math.PI / 2),
      ),
      ph,
    );
    ring.userData.role = 'ring';
    ring.position.y = tile * 0.004;
    ring.renderOrder = 1;
    g.add(ring);

    return g;
  };

  const templates = new Map<Kind, THREE.Group>();
  const templateOf = (kind: Kind): THREE.Group => {
    let t = templates.get(kind);
    if (!t) {
      t = buildTemplate(kind);
      templates.set(kind, t);
    }
    return t;
  };

  /** Halos are decoration only — they must not intercept taps. */
  const noRaycast = () => {};

  const applyMaterials = (obj: THREE.Object3D, side: PlayerSlot, fading: boolean) => {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const role = m.userData.role as string | undefined;
      if (role === 'ring') {
        m.material = ringMatFor(side);
        m.raycast = noRaycast;
        m.visible = !fading;
      } else if (fading) {
        m.material = fadeMat(side);
      } else {
        m.material = role === 'accent' ? accentMat(side) : pieceMat(side);
      }
    });
  };

  /**
   * Resting yaw. Knights get a quarter turn so their horse-head silhouette
   * reads in profile from the table camera instead of edge-on; the two sides
   * face opposite ways, which keeps them telling each other apart.
   */
  const baseYaw = (kind: Kind, side: PlayerSlot): number =>
    (kind === 'N' ? -Math.PI / 2 : 0) + (side === 0 ? 0 : Math.PI);

  const buildPieceObject = (kind: Kind, side: PlayerSlot): THREE.Group => {
    const obj = templateOf(kind).clone(true);
    applyMaterials(obj, side, false);
    obj.rotation.y = baseYaw(kind, side);
    return obj;
  };

  const acquire = (code: PieceCode): PieceRec => {
    const side: PlayerSlot = code[0] === 'w' ? 0 : 1;
    const kind = code[1] as Kind;
    const key = `${kind}${side}`;
    const bucket = pool.get(key);
    let obj = bucket?.pop();
    if (obj) {
      applyMaterials(obj, side, false);
    } else {
      obj = buildPieceObject(kind, side);
    }
    obj.visible = true;
    obj.scale.setScalar(1);
    obj.rotation.set(0, baseYaw(kind, side), 0);
    pieceRoot?.add(obj);
    return { code, kind, side, obj, sq: -1, anim: null };
  };

  const release = (rec: PieceRec) => {
    pieceRoot?.remove(rec.obj);
    rec.obj.visible = false;
    const key = `${rec.kind}${rec.side}`;
    let bucket = pool.get(key);
    if (!bucket) {
      bucket = [];
      pool.set(key, bucket);
    }
    if (bucket.length < 10) bucket.push(rec.obj);
  };

  const placeAt = (rec: PieceRec, sq: number) => {
    rec.obj.position.set(sqX(sq), 0, sqZ(sq));
  };

  const startMove = (
    rec: PieceRec,
    from: number,
    to: number,
    arc: number,
    dur: number,
    pop = false,
  ) => {
    rec.anim = {
      kind: 'move',
      t0: -1,
      dur,
      delay: 0,
      fx: sqX(from),
      fz: sqZ(from),
      tx: sqX(to),
      tz: sqZ(to),
      arc,
      pop,
    };
    rec.obj.position.set(sqX(from), 0, sqZ(from));
  };

  const kill = (rec: PieceRec) => {
    bySquare.delete(rec.sq);
    applyMaterials(rec.obj, rec.side, true);
    rec.anim = {
      kind: 'capture',
      t0: -1,
      dur: CAPTURE_MS,
      delay: 0,
      fx: rec.obj.position.x,
      fz: rec.obj.position.z,
      tx: rec.obj.position.x,
      tz: rec.obj.position.z,
      arc: 0,
      pop: false,
    };
    dying.push(rec);
  };

  // -- highlight plumbing --------------------------------------------------

  const clearMarkers = () => {
    for (const d of dots) d.visible = false;
    for (const r of rings) r.visible = false;
    if (selGlow) selGlow.visible = false;
  };

  const buildMarkers = (core: GameCore, from: number) => {
    clearMarkers();
    const board = core.board as ChessBoard;
    const legal = getLegal(core);
    let di = 0;
    let ri = 0;
    const seen = new Set<number>();
    for (const m of legal) {
      if (m.from !== from || typeof m.to !== 'number') continue;
      if (seen.has(m.to)) continue;
      seen.add(m.to);
      const capture = !!board.squares[m.to] || (board.ep === m.to && board.squares[from]?.[1] === 'P');
      if (capture) {
        if (ri < rings.length) {
          const r = rings[ri++];
          r.position.set(sqX(m.to), tile * 0.016, sqZ(m.to));
          r.visible = true;
        }
      } else if (di < dots.length) {
        const d = dots[di++];
        d.position.set(sqX(m.to), tile * 0.014, sqZ(m.to));
        d.visible = true;
      }
    }
    if (selGlow) {
      selGlow.position.set(sqX(from), tile * 0.01, sqZ(from));
      selGlow.visible = true;
    }
  };

  const getLegal = (core: GameCore): Move[] => {
    if (legalCore !== core) {
      legalCore = core;
      legalCache = chessLogic.legalMoves(core);
    }
    return legalCache;
  };

  const deselect = () => {
    selected = null;
    clearMarkers();
  };

  // -- board sync ----------------------------------------------------------

  const wipePieces = () => {
    bySquare.forEach((rec) => release(rec));
    bySquare.clear();
    for (const rec of dying) release(rec);
    dying.length = 0;
  };

  const hardResync = (board: ChessBoard, spawn: boolean) => {
    wipePieces();
    for (let sq = 0; sq < 64; sq++) {
      const code = board.squares[sq];
      if (!code) continue;
      const rec = acquire(code);
      rec.sq = sq;
      bySquare.set(sq, rec);
      placeAt(rec, sq);
      if (spawn) {
        rec.obj.scale.setScalar(0.0001);
        rec.anim = {
          kind: 'spawn',
          t0: -1,
          dur: SPAWN_MS,
          // Back ranks land first and the pawns follow, sweeping a-file to h,
          // so the set assembles itself rather than popping in all at once.
          delay: (RANK(sq) < 4 ? RANK(sq) : 7 - RANK(sq)) * 55 + FILE(sq) * 18,
          fx: sqX(sq),
          fz: sqZ(sq),
          tx: sqX(sq),
          tz: sqZ(sq),
          arc: 0,
          pop: false,
        };
      }
    }
  };

  /** True when bookkeeping matches the authoritative board exactly. */
  const consistent = (board: ChessBoard): boolean => {
    let n = 0;
    for (let sq = 0; sq < 64; sq++) {
      const code = board.squares[sq];
      const rec = bySquare.get(sq);
      if (code) {
        if (!rec || rec.code !== code) return false;
        n++;
      } else if (rec) return false;
    }
    return n === bySquare.size;
  };

  /** Animate a single ply. Returns false when the diff can't be trusted. */
  const applyPly = (prevBoard: ChessBoard, board: ChessBoard): boolean => {
    const lm = board.lastMove;
    if (!lm) return false;
    const { from, to } = lm;
    const rec = bySquare.get(from);
    const landed = board.squares[to];
    if (!rec || !landed) return false;

    // 1. direct capture
    const victim = bySquare.get(to);
    if (victim) kill(victim);

    // 2. en passant — a diagonal pawn move onto an empty square
    const hop = rec.kind === 'N';
    if (rec.kind === 'P' && FILE(from) !== FILE(to) && !prevBoard.squares[to]) {
      const epSq = SQ(RANK(from), FILE(to));
      const bypassed = bySquare.get(epSq);
      if (bypassed) kill(bypassed);
    }

    // 3. castling — the rook walks with the king
    if (rec.kind === 'K' && Math.abs(FILE(to) - FILE(from)) === 2) {
      const home = RANK(from);
      const kingSide = FILE(to) > FILE(from);
      const rf = SQ(home, kingSide ? 7 : 0);
      const rt = SQ(home, kingSide ? 5 : 3);
      const rook = bySquare.get(rf);
      if (rook) {
        bySquare.delete(rf);
        rook.sq = rt;
        bySquare.set(rt, rook);
        startMove(rook, rf, rt, tile * 0.16, CASTLE_ROOK_MS);
      }
    }

    bySquare.delete(from);

    // 4. promotion — swap the pawn for the promoted piece
    if (landed[1] !== rec.code[1]) {
      release(rec);
      const promoted = acquire(landed);
      promoted.sq = to;
      bySquare.set(to, promoted);
      startMove(promoted, from, to, tile * 0.24, MOVE_MS, true);
      flashT0 = -1;
      if (flashGlow) {
        flashGlow.position.set(sqX(to), tile * 0.02, sqZ(to));
        flashGlow.visible = true;
      }
    } else {
      rec.sq = to;
      bySquare.set(to, rec);
      const arc = hop ? tile * 0.42 : victim ? tile * 0.12 : tile * 0.03;
      startMove(rec, from, to, arc, MOVE_MS);
    }
    return true;
  };

  const refreshHighlights = (core: GameCore, board: ChessBoard) => {
    checkSq = board.checkSquare;
    winnerSlot = core.winner === 0 || core.winner === 1 ? core.winner : null;
    const mate =
      winnerSlot !== null && core.winningCells && core.winningCells.length > 0
        ? core.winningCells[0]
        : null;
    if (mate !== mateSq) {
      mateSq = mate;
      toppleT0 = -1;
    }

    const lm = board.lastMove;
    for (let i = 0; i < lastGlow.length; i++) {
      const g = lastGlow[i];
      const sq = lm ? (i === 0 ? lm.from : lm.to) : -1;
      if (sq < 0) {
        g.visible = false;
      } else {
        g.position.set(sqX(sq), tile * 0.008, sqZ(sq));
        g.visible = true;
      }
    }

    if (checkGlow) {
      if (checkSq !== null) {
        checkGlow.position.set(sqX(checkSq), tile * 0.018, sqZ(checkSq));
        checkGlow.visible = true;
      } else {
        checkGlow.visible = false;
      }
    }
  };

  // -- picking -------------------------------------------------------------

  /** Reused between taps so picking allocates nothing per interaction. */
  const candidates: number[] = [];

  /**
   * Every square the ray plausibly means, nearest first: the pieces it passes
   * through, then the board square under it. Callers walk the list and take the
   * first *actionable* entry — from a low camera the ray to an empty square
   * often grazes the tall piece standing in front of it, and silently eating
   * that tap would feel broken.
   */
  const pickCandidates = (raycaster: THREE.Raycaster): number[] => {
    candidates.length = 0;
    if (pieceRoot && pieceRoot.children.length) {
      const hits = raycaster.intersectObjects(pieceRoot.children, true);
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object;
        while (o && o.parent !== pieceRoot) o = o.parent;
        if (!o) continue;
        for (const [sq, rec] of bySquare) {
          if (rec.obj === o && !candidates.includes(sq)) candidates.push(sq);
        }
      }
    }
    if (boardPick && group) {
      const hits = raycaster.intersectObject(boardPick, false);
      if (hits.length) {
        tmpVec.copy(hits[0].point);
        group.worldToLocal(tmpVec);
        const f = Math.floor(tmpVec.x / tile + 4);
        const r = Math.floor(4 - tmpVec.z / tile);
        if (f >= 0 && f < 8 && r >= 0 && r < 8) {
          const sq = SQ(r, f);
          if (!candidates.includes(sq)) candidates.push(sq);
        }
      }
    }
    return candidates;
  };

  // ========================================================================
  // GameScene
  // ========================================================================

  return {
    init(c) {
      ctx = c;
      S = c.boardSize;
      tile = S / 8;
      tileH = tile * 0.16;
      p0Color.set(c.profiles[0]?.color ?? '#e2e8f5');
      p1Color.set(c.profiles[1]?.color ?? '#7c3aed');
      glowTex = makeGlowTexture();

      group = new THREE.Group();
      c.root.add(group);

      // --- galaxy disc + halo ------------------------------------------
      galaxy = createGalaxy();
      galaxy.position.y = -S * 0.55;
      group.add(galaxy);

      const halo = new THREE.Mesh(
        geo('halo', () => new THREE.TorusGeometry(S * 0.72, S * 0.005, 8, 90).rotateX(-Math.PI / 2)),
        mat(
          'halo',
          () =>
            new THREE.MeshBasicMaterial({
              color: 0x38bdf8,
              transparent: true,
              opacity: 0.22,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
        ),
      );
      halo.position.y = -tileH * 2.2;
      group.add(halo);

      // --- glass frame --------------------------------------------------
      const frameW = tile * 0.34;
      const outerHalf = S / 2 + frameW;
      const frameH = tile * 0.26;
      const frameBase = -tileH - tile * 0.02;
      // The frame is deeper than the tiles, so its top face stands slightly
      // proud of the playing surface as a lip.
      const frameTop = frameBase + frameH;
      const frameGeo = geo('frame', () => {
        const shape = new THREE.Shape(roundedRect(outerHalf, tile * 0.3).getPoints(48));
        shape.holes.push(new THREE.Path(roundedRect(S / 2 + tile * 0.01, tile * 0.06).getPoints(40)));
        const g = new THREE.ExtrudeGeometry(shape, {
          depth: frameH,
          bevelEnabled: true,
          bevelThickness: tile * 0.03,
          bevelSize: tile * 0.035,
          bevelSegments: 2,
          curveSegments: 2,
        });
        g.rotateX(-Math.PI / 2);
        return g;
      });
      const frame = new THREE.Mesh(
        frameGeo,
        mat(
          'frame',
          () =>
            new THREE.MeshPhysicalMaterial({
              color: 0x0a1024,
              roughness: 0.14,
              metalness: 0.35,
              transmission: 0.35,
              thickness: tile * 0.6,
              ior: 1.5,
              clearcoat: 1,
              clearcoatRoughness: 0.05,
              transparent: true,
              opacity: 0.95,
              envMapIntensity: 1.2,
            }),
        ),
      );
      frame.position.y = frameBase;
      group.add(frame);

      // --- base slab ----------------------------------------------------
      const base = new THREE.Mesh(
        geo('base', () => new THREE.BoxGeometry(S + frameW * 1.4, tile * 0.1, S + frameW * 1.4)),
        mat(
          'base',
          () =>
            new THREE.MeshPhysicalMaterial({
              color: 0x060a18,
              roughness: 0.22,
              metalness: 0.5,
              clearcoat: 0.8,
              clearcoatRoughness: 0.2,
              transparent: true,
              opacity: 0.92,
            }),
        ),
      );
      base.position.y = -tileH - tile * 0.07;
      group.add(base);

      // --- neon outlines (tinted to the player on the move) ------------
      const outlineMat = mat(
        'outline',
        () =>
          new THREE.LineBasicMaterial({
            color: 0x22d3ee,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
      );
      const outlineGeoFor = (half: number, key: string) =>
        geo(key, () =>
          new THREE.BufferGeometry().setFromPoints(
            roundedRect(half, tile * 0.16)
              .getPoints(70)
              .map((p) => new THREE.Vector3(p.x, 0, p.y)),
          ),
        );
      neonA = new THREE.LineLoop(outlineGeoFor(outerHalf - tile * 0.05, 'outline-a'), outlineMat);
      neonA.position.y = frameTop - tile * 0.03;
      neonA.renderOrder = 3;
      group.add(neonA);
      neonB = new THREE.LineLoop(outlineGeoFor(S / 2 + tile * 0.03, 'outline-b'), outlineMat);
      neonB.position.y = tile * 0.006;
      neonB.renderOrder = 3;
      group.add(neonB);

      // --- tiles ---------------------------------------------------------
      const tileGeo = geo('tile', () => new THREE.BoxGeometry(tile * 0.975, tileH, tile * 0.975));
      const darkMat = mat(
        'tile-dark',
        () =>
          new THREE.MeshPhysicalMaterial({
            color: 0x080e1e,
            roughness: 0.3,
            metalness: 0.06,
            transmission: 0.12,
            thickness: tile * 0.14,
            ior: 1.42,
            clearcoat: 0.75,
            clearcoatRoughness: 0.3,
            transparent: true,
            opacity: 0.96,
            envMapIntensity: 0.16,
          }),
      );
      const lightMat = mat(
        'tile-light',
        () =>
          new THREE.MeshPhysicalMaterial({
            color: 0x93aacf,
            roughness: 0.62,
            metalness: 0.0,
            transmission: 0.14,
            thickness: tile * 0.14,
            ior: 1.34,
            clearcoat: 0.4,
            clearcoatRoughness: 0.6,
            transparent: true,
            opacity: 0.95,
            envMapIntensity: 0.14,
          }),
      );
      tileMeshes.length = 0;
      for (let sq = 0; sq < 64; sq++) {
        const dark = (RANK(sq) + FILE(sq)) % 2 === 0; // a1 is dark
        const m = new THREE.Mesh(tileGeo, dark ? darkMat : lightMat);
        m.position.set(sqX(sq), -tileH / 2, sqZ(sq));
        m.userData.square = sq;
        group.add(m);
        tileMeshes.push(m);
      }

      // --- coordinate pips on the frame lip ----------------------------
      const pipGeo = geo('pip', () => new THREE.SphereGeometry(tile * 0.019, 8, 6));
      const pipMat = mat(
        'pip',
        () =>
          new THREE.MeshBasicMaterial({
            color: 0x9fd8ff,
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
      );
      const pips = new THREE.InstancedMesh(pipGeo, pipMat, 16);
      const m4 = new THREE.Matrix4();
      const edge = S / 2 + frameW * 0.5;
      // Just proud of the frame's top face, which sits a little above the tiles.
      const pipY = frameTop + tile * 0.008;
      for (let i = 0; i < 8; i++) {
        m4.makeTranslation((i - 3.5) * tile, pipY, edge);
        pips.setMatrixAt(i, m4);
        m4.makeTranslation(edge, pipY, (3.5 - i) * tile);
        pips.setMatrixAt(8 + i, m4);
      }
      pips.instanceMatrix.needsUpdate = true;
      group.add(pips);

      // --- flat pick plane ----------------------------------------------
      boardPick = new THREE.Mesh(
        geo('pick', () => new THREE.PlaneGeometry(S, S).rotateX(-Math.PI / 2)),
        mat('pick', () => new THREE.MeshBasicMaterial({ visible: false, depthWrite: false })),
      );
      boardPick.position.y = tile * 0.002;
      group.add(boardPick);

      // --- highlight patches --------------------------------------------
      lastGlow.length = 0;
      for (let i = 0; i < 2; i++) {
        const g = glowPatch('last', tile * 0.98, GOLD, 0.14);
        group.add(g);
        lastGlow.push(g);
      }
      selGlow = glowPatch('sel', tile * 1.5, 0x67e8f9, 0.55);
      group.add(selGlow);
      hoverGlow = glowPatch('hover', tile * 1.1, 0xffffff, 0.2);
      group.add(hoverGlow);
      checkGlow = glowPatch('check', tile * 1.9, CHECK_RED, 0.6);
      group.add(checkGlow);
      flashGlow = glowPatch('flash', tile * 2.4, 0xfff3c4, 0.9);
      group.add(flashGlow);

      dots.length = 0;
      for (let i = 0; i < MAX_DOTS; i++) {
        const d = glowPatch('dot', tile * 0.58, 0x1fd8ff, 0.9);
        group.add(d);
        dots.push(d);
      }
      rings.length = 0;
      const ringGeo = geo('ring', () =>
        new THREE.RingGeometry(tile * 0.33, tile * 0.44, 40).rotateX(-Math.PI / 2),
      );
      const ringMat = mat(
        'ring',
        () =>
          new THREE.MeshBasicMaterial({
            color: 0xff5d7a,
            transparent: true,
            opacity: 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
      );
      for (let i = 0; i < MAX_RINGS; i++) {
        const r = new THREE.Mesh(ringGeo, ringMat);
        r.visible = false;
        r.renderOrder = 2;
        group.add(r);
        rings.push(r);
      }

      // --- pieces + turn light ------------------------------------------
      pieceRoot = new THREE.Group();
      // A hair above the tile tops: the lathe base caps sit at local y = 0 and
      // would z-fight with the tile surface otherwise.
      pieceRoot.position.y = tile * 0.006;
      group.add(pieceRoot);

      turnLight = new THREE.PointLight(0xffffff, 0.8, S * 5);
      turnLight.position.set(0, S * 1.25, S * 0.25);
      group.add(turnLight);
    },

    update(core, prev) {
      if (!ctx || !group) return;
      const board = core.board as ChessBoard;
      deselect();
      if (hoverGlow) hoverGlow.visible = false;
      hoverSq = null;

      const reset = prev === null || core.moveCount < prev.moveCount;
      if (reset) {
        hardResync(board, true);
      } else if (core.moveCount === prev.moveCount + 1) {
        const prevBoard = prev.board as ChessBoard;
        if (!applyPly(prevBoard, board) || !consistent(board)) hardResync(board, false);
      } else if (core.moveCount !== prev.moveCount || !consistent(board)) {
        hardResync(board, false);
      }

      refreshHighlights(core, board);
    },

    animate(t, currentSlot, winner) {
      const dt = lastTime ? Math.min(0.05, (t - lastTime) / 1000) : 0.016;
      lastTime = t;

      if (galaxy) galaxy.rotation.y += dt * 0.07;

      // --- turn tint / idle glow ---------------------------------------
      tmpColor.copy(currentSlot === 0 ? p0Color : p1Color);
      if (turnLight) {
        turnLight.intensity = winner !== null ? 0.7 : 0.7 + Math.sin(t / 420) * 0.3;
        turnLight.color.lerp(tmpColor, 0.05);
      }
      const outline = matCache.get('outline') as THREE.LineBasicMaterial | undefined;
      if (outline) {
        outline.color.lerp(tmpColor, 0.05);
        outline.opacity = winner !== null ? 0.45 : 0.6 + Math.sin(t / 760) * 0.25;
      }

      // --- last-move + check + markers ---------------------------------
      const lastMat = matCache.get('glowmat-last') as THREE.MeshBasicMaterial | undefined;
      if (lastMat) lastMat.opacity = 0.11 + Math.sin(t / 900) * 0.04;
      const checkMat = matCache.get('glowmat-check') as THREE.MeshBasicMaterial | undefined;
      if (checkMat) checkMat.opacity = 0.4 + Math.sin(t / 190) * 0.3;
      if (checkGlow && checkGlow.visible) {
        const s = 1 + Math.sin(t / 190) * 0.1;
        checkGlow.scale.set(s, 1, s);
      }
      const dotMat = matCache.get('glowmat-dot') as THREE.MeshBasicMaterial | undefined;
      if (dotMat) dotMat.opacity = 0.78 + Math.sin(t / 260) * 0.22;
      const ringMat = matCache.get('ring') as THREE.MeshBasicMaterial | undefined;
      if (ringMat) ringMat.opacity = 0.7 + Math.sin(t / 220) * 0.3;
      const selMat = matCache.get('glowmat-sel') as THREE.MeshBasicMaterial | undefined;
      if (selMat) {
        selMat.opacity = 0.4 + Math.sin(t / 300) * 0.2;
        selMat.color.lerp(tmpColor, 0.06);
      }

      // --- promotion sparkle -------------------------------------------
      if (flashGlow && flashGlow.visible) {
        if (flashT0 < 0) flashT0 = t;
        const p = (t - flashT0) / FLASH_MS;
        if (p >= 1) {
          flashGlow.visible = false;
          flashT0 = -1;
        } else {
          const e = easeOut(p);
          const s = 0.4 + e * 1.5;
          flashGlow.scale.set(s, 1, s);
          (flashGlow.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.95;
        }
      }

      // --- victor shimmer ----------------------------------------------
      if (winnerSlot !== null) {
        const win = pieceMat(winnerSlot);
        win.emissiveIntensity = (winnerSlot === 0 ? 0.22 : 1.1) + Math.sin(t / 240) * 0.3;
      } else {
        pieceMat(0).emissiveIntensity = 0.06;
        pieceMat(1).emissiveIntensity = 0.5;
      }

      // Identity halos: the side to move breathes, the other rests dim.
      const pulse = 0.34 + Math.sin(t / 480) * 0.18;
      for (const s of [0, 1] as PlayerSlot[]) {
        const rm = matCache.get(`piece-ring-${s}`) as THREE.MeshBasicMaterial | undefined;
        if (rm) rm.opacity = winner !== null ? 0.16 : s === currentSlot ? pulse : 0.12;
      }

      // --- live pieces --------------------------------------------------
      bySquare.forEach((rec, sq) => {
        const a = rec.anim;
        if (a) {
          if (a.t0 < 0) a.t0 = t;
          const raw = (t - a.t0 - a.delay) / a.dur;
          if (raw < 0) {
            if (a.kind === 'spawn') rec.obj.scale.setScalar(0.0001);
            return;
          }
          const p = clamp01(raw);
          if (a.kind === 'spawn') {
            const s = easeOutBack(p);
            rec.obj.scale.setScalar(Math.max(0.0001, s));
            rec.obj.position.y = (1 - easeOut(p)) * tile * 0.5;
          } else {
            const e = easeInOut(p);
            rec.obj.position.x = a.fx + (a.tx - a.fx) * e;
            rec.obj.position.z = a.fz + (a.tz - a.fz) * e;
            rec.obj.position.y = Math.sin(p * Math.PI) * a.arc;
            if (a.pop) {
              const s = p < 0.55 ? 0.55 + p * 0.6 : easeOutBack(Math.min(1, (p - 0.4) / 0.6));
              rec.obj.scale.setScalar(Math.max(0.0001, s));
            }
          }
          if (p >= 1) {
            rec.anim = null;
            rec.obj.position.set(a.tx, 0, a.tz);
            rec.obj.scale.setScalar(1);
          }
          return;
        }

        // Idle: selected piece lifts and bobs; everyone else rests flat.
        if (selected === sq) {
          rec.obj.position.y = tile * 0.16 + Math.sin(t / 340) * tile * 0.035;
          rec.obj.rotation.y = baseYaw(rec.kind, rec.side) + Math.sin(t / 900) * 0.14;
        } else if (rec.obj.position.y !== 0) {
          rec.obj.position.y = 0;
          rec.obj.rotation.y = baseYaw(rec.kind, rec.side);
        }

        // Mated king topples.
        if (mateSq === sq && winnerSlot !== null) {
          if (toppleT0 < 0) toppleT0 = t;
          const p = clamp01((t - toppleT0) / TOPPLE_MS);
          const e = easeInOut(p);
          rec.obj.rotation.x = -TOPPLE_ANGLE * e;
          rec.obj.position.z = sqZ(sq) + Math.sin(TOPPLE_ANGLE * e) * tile * 0.24;
          rec.obj.position.y = (1 - Math.cos(TOPPLE_ANGLE * e)) * tile * 0.06;
        } else if (rec.obj.rotation.x !== 0) {
          rec.obj.rotation.x = 0;
        }
      });

      // --- captured pieces ---------------------------------------------
      for (let i = dying.length - 1; i >= 0; i--) {
        const rec = dying[i];
        const a = rec.anim;
        if (!a) {
          release(rec);
          dying.splice(i, 1);
          continue;
        }
        if (a.t0 < 0) a.t0 = t;
        const p = clamp01((t - a.t0) / a.dur);
        const s = 1 - easeOut(p);
        rec.obj.scale.setScalar(Math.max(0.0001, s));
        rec.obj.position.y = -p * tile * 0.22;
        rec.obj.rotation.y += dt * 5.5;
        const fm = fadeMat(rec.side);
        fm.opacity = 1 - p;
        if (p >= 1) {
          rec.anim = null;
          rec.obj.rotation.set(0, 0, 0);
          release(rec);
          dying.splice(i, 1);
        }
      }
      if (dying.length === 0) {
        // Shared per side, so reset it once the last capture has finished —
        // but never mint the material just to reset it.
        for (const s of [0, 1]) {
          const fm = matCache.get(`fade-${s}`) as THREE.MeshStandardMaterial | undefined;
          if (fm && fm.opacity !== 1) fm.opacity = 1;
        }
      }
    },

    pickMove(raycaster, core) {
      if (core.winner !== null) {
        deselect();
        return null;
      }
      const cands = pickCandidates(raycaster);
      if (cands.length === 0) {
        deselect();
        return null;
      }
      const legal = getLegal(core);

      // 1. completing a move wins over anything else the ray touched
      if (selected !== null) {
        for (const sq of cands) {
          if (sq === selected) continue;
          const m = legal.find((x) => x.from === selected && x.to === sq);
          if (m) {
            deselect();
            return m.promotion ? { ...m, promotion: 'q' } : { from: m.from, to: m.to };
          }
        }
      }
      // 2. otherwise select (or toggle off) the nearest actionable piece
      for (const sq of cands) {
        if (sq === selected) {
          deselect();
          return null;
        }
        if (legal.some((m) => m.from === sq)) {
          selected = sq;
          buildMarkers(core, sq);
          sound.playClick();
          return null;
        }
      }
      deselect();
      return null;
    },

    hover(raycaster, core) {
      if (!hoverGlow) return;
      if (!raycaster || core.winner !== null) {
        hoverGlow.visible = false;
        hoverSq = null;
        return;
      }
      const cands = pickCandidates(raycaster);
      const legal = getLegal(core);
      let sq: number | null = null;
      for (const c of cands) {
        const actionable =
          (selected !== null && legal.some((m) => m.from === selected && m.to === c)) ||
          legal.some((m) => m.from === c);
        if (actionable) {
          sq = c;
          break;
        }
      }
      if (sq === hoverSq) return;
      hoverSq = sq;
      if (sq === null) {
        hoverGlow.visible = false;
        return;
      }
      hoverGlow.position.set(sqX(sq), tile * 0.006, sqZ(sq));
      hoverGlow.visible = true;
    },

    dispose() {
      wipePieces();
      pool.clear();
      templates.clear();
      if (ctx && group) ctx.root.remove(group);
      geoCache.forEach((g) => g.dispose());
      matCache.forEach((m) => m.dispose());
      geoCache.clear();
      matCache.clear();
      glowTex?.dispose();
      glowTex = null;
      tileMeshes.length = 0;
      dots.length = 0;
      rings.length = 0;
      lastGlow.length = 0;
      bySquare.clear();
      dying.length = 0;
      selected = null;
      legalCore = null;
      legalCache = [];
      checkSq = null;
      mateSq = null;
      winnerSlot = null;
      toppleT0 = -1;
      flashT0 = -1;
      hoverSq = null;
      lastTime = 0;
      boardPick = null;
      galaxy = null;
      neonA = null;
      neonB = null;
      turnLight = null;
      selGlow = null;
      hoverGlow = null;
      checkGlow = null;
      flashGlow = null;
      pieceRoot = null;
      group = null;
      ctx = null;
    },
  } satisfies GameScene;
}

export default createChessScene;
