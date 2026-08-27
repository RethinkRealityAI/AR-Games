// ============================================================================
// Quantum Pairs — the artifact library.
//
// Every tile hides one artifact. A theme supplies KINDS_PER_THEME visually
// distinct artifacts, enough for the largest board (Odyssey, 15 pairs).
//
// FROZEN API — the scene depends only on these three exports:
//
//   buildArtifact(theme, kind, size) -> THREE.Group
//       A fresh group, centred on x/z, standing on y = 0, and fitting inside a
//       `size` cube. Callers own the group and may add it anywhere; geometry
//       and materials are cached internally and shared between instances, so
//       DO NOT dispose anything inside the returned group. Call
//       disposeArtifactCache() once when the scene tears down.
//
//   disposeArtifactCache()
//       Frees every cached geometry/material built so far.
//
//   THEME_META
//       Display copy plus the per-kind names used by the HUD and the win recap.
//
// ---------------------------------------------------------------------------
// HOW IT IS BUILT
//
// Each (theme, kind) is authored once, in a nominal 1-unit cube, as a flat list
// of `Part`s — a geometry plus the material it wants. Parts sharing a material
// are merged into a single buffer, so a fifteen-piece rocket costs four draw
// calls, not fifteen. The assembled group is then measured, scaled to fill the
// unit cube, recentred on x/z and dropped onto y = 0, and cached as a
// *template*. `buildArtifact` clones that template (geometry and materials are
// shared by the clone) and scales the clone by `size` — so the returned group's
// own transform stays untouched and callers are free to scale it themselves.
//
// Design rules for the set:
//   • Silhouette first. Every artifact must survive being 40px tall on a phone,
//     so shapes are separated by outline (tall / wide / spiky / round / flat)
//     before they are separated by hue.
//   • Hue second. No two kinds in a theme share a hue family unless their
//     silhouettes are unmistakable.
//   • Everything carries some emissive so it reads against a near-black scene,
//     and clearcoat/transmission so it belongs to the platform's glass language.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MemoryTheme } from './logic';

/** Artifacts available per theme — matches the largest board's pair count. */
export const KINDS_PER_THEME = 15;

export interface ThemeMeta {
  name: string;
  blurb: string;
  /** Display name per kind index, length KINDS_PER_THEME. */
  kinds: string[];
}

export const THEME_META: Record<MemoryTheme, ThemeMeta> = {
  cosmos: {
    name: 'Cosmos',
    blurb: 'Relics adrift in deep space',
    kinds: [
      'Rocket', 'Ringed Planet', 'Comet', 'Helmet', 'Crystal',
      'Satellite', 'Moon', 'Starburst', 'Saucer', 'Black Hole',
      'Galaxy', 'Nebula', 'Asteroid', 'Pulsar', 'Observatory',
    ],
  },
  chess: {
    name: 'Gambit',
    blurb: 'The royal set, cast three ways',
    kinds: [
      'Ivory Pawn', 'Ivory Knight', 'Ivory Bishop', 'Ivory Rook', 'Ivory Queen',
      'Obsidian Pawn', 'Obsidian Knight', 'Obsidian Bishop', 'Obsidian Rook', 'Obsidian Queen',
      'Gilded Pawn', 'Gilded Knight', 'Gilded Bishop', 'Gilded Rook', 'Gilded Queen',
    ],
  },
  gems: {
    name: 'Prism',
    blurb: 'Cut stones that drink the light',
    kinds: [
      'Ruby', 'Sapphire', 'Emerald', 'Topaz', 'Amethyst',
      'Citrine', 'Aquamarine', 'Garnet', 'Peridot', 'Opal',
      'Onyx', 'Rose Quartz', 'Turquoise', 'Moonstone', 'Diamond',
    ],
  },
};

// ===========================================================================
// Cache + resource tracking
// ===========================================================================

const geoBin: THREE.BufferGeometry[] = [];
const matBin: THREE.Material[] = [];
const matCache = new Map<string, THREE.Material>();
const templates = new Map<string, THREE.Group>();

function mat<T extends THREE.Material>(key: string, make: () => T): T {
  const hit = matCache.get(key);
  if (hit) return hit as T;
  const m = make();
  matCache.set(key, m);
  matBin.push(m);
  return m;
}

/** A positioned lump of geometry plus the material role it belongs to. */
interface Part {
  g: THREE.BufferGeometry;
  m: THREE.Material;
}
const P = (g: THREE.BufferGeometry, m: THREE.Material): Part => ({ g, m });

/**
 * Strip a part down to position + normal so anything can merge with anything.
 * Existing normals are preserved (that is how the smooth moon stays smooth and
 * the faceted gems stay faceted through the merge).
 */
function clean(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src;
  if (g !== src) src.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/** Merge parts per material into one mesh each. */
function assemble(parts: Part[]): THREE.Group {
  const group = new THREE.Group();
  const order: THREE.Material[] = [];
  const bins = new Map<THREE.Material, THREE.BufferGeometry[]>();

  for (const p of parts) {
    let list = bins.get(p.m);
    if (!list) {
      list = [];
      bins.set(p.m, list);
      order.push(p.m);
    }
    list.push(clean(p.g));
  }

  for (const m of order) {
    const list = bins.get(m)!;
    let final = list[0];
    if (list.length > 1) {
      const merged = mergeGeometries(list, false);
      if (merged) {
        for (const l of list) l.dispose();
        final = merged;
      }
    }
    geoBin.push(final);
    const mesh = new THREE.Mesh(final, m);
    if ((m as THREE.MeshBasicMaterial).blending === THREE.AdditiveBlending) mesh.renderOrder = 4;
    else if (m.transparent) mesh.renderOrder = 2;
    group.add(mesh);
  }
  return group;
}

/**
 * Fit an authored group into the unit cube: uniformly scaled, centred on x/z,
 * resting on y = 0. `fixed` overrides the fit so a family of artifacts (the
 * chess set) can share one scale and keep their relative heights.
 */
function ground(inner: THREE.Group, fill = 0.98, fixed?: number): THREE.Group {
  const box = new THREE.Box3().setFromObject(inner);
  const dx = box.max.x - box.min.x;
  const dy = box.max.y - box.min.y;
  const dz = box.max.z - box.min.z;
  const s = fixed ?? fill / Math.max(dx, dy, dz, 1e-6);
  inner.scale.setScalar(s);
  inner.position.set(
    -((box.min.x + box.max.x) / 2) * s,
    -box.min.y * s,
    -((box.min.z + box.max.z) / 2) * s,
  );
  const wrap = new THREE.Group();
  wrap.add(inner);
  return wrap;
}

// ===========================================================================
// Geometry helpers
// ===========================================================================

type V2 = [number, number];

interface Xf {
  x?: number; y?: number; z?: number;
  rx?: number; ry?: number; rz?: number;
  sx?: number; sy?: number; sz?: number;
}

/** Scale → rotate (x,y,z) → translate, applied in place. */
function xf(g: THREE.BufferGeometry, t: Xf): THREE.BufferGeometry {
  if (t.sx !== undefined || t.sy !== undefined || t.sz !== undefined) {
    g.scale(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
  }
  if (t.rx) g.rotateX(t.rx);
  if (t.ry) g.rotateY(t.ry);
  if (t.rz) g.rotateZ(t.rz);
  if (t.x || t.y || t.z) g.translate(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  return g;
}

const lathe = (pts: V2[], seg = 34): THREE.BufferGeometry =>
  new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)), seg);

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const ball = (r: number, w = 18, h = 14) => new THREE.SphereGeometry(r, w, h);
const cone = (r: number, h: number, seg = 20, open = false) =>
  new THREE.ConeGeometry(r, h, seg, 1, open);
const tube = (r: number, t: number, seg = 30) =>
  new THREE.TorusGeometry(r, t, 8, seg);
/** Flat ring lying in the x/z plane. */
const disc = (ri: number, ro: number, seg = 48) =>
  new THREE.RingGeometry(ri, ro, seg).rotateX(-Math.PI / 2);
/** Torus lying in the x/z plane. */
const hoop = (r: number, t: number, seg = 36) =>
  new THREE.TorusGeometry(r, t, 8, seg).rotateX(Math.PI / 2);

/** A ring of `n` copies of `make`, spun around y. */
function around(n: number, radius: number, y: number, make: (i: number) => THREE.BufferGeometry, faceOut = false): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(
      xf(make(i), {
        ry: faceOut ? a : 0,
        x: Math.sin(a) * radius,
        y,
        z: Math.cos(a) * radius,
      }),
    );
  }
  return out;
}

/** Deterministic 3-octave value noise on a direction — used for rock surfaces. */
function rockNoise(x: number, y: number, z: number): number {
  return (
    Math.sin(x * 3.7 + 1.1) * Math.sin(y * 4.3 + 2.7) * Math.sin(z * 3.1 + 0.4) * 0.6 +
    Math.sin(x * 8.1 + 4.2) * Math.sin(y * 7.3 + 0.9) * Math.sin(z * 9.4 + 3.3) * 0.28 +
    Math.sin(x * 15.7 + 2.2) * Math.sin(y * 14.1 + 5.1) * Math.sin(z * 16.3 + 1.7) * 0.12
  );
}

interface Crater {
  dir: THREE.Vector3;
  /** angular radius, radians */
  r: number;
  depth: number;
}

/**
 * A sphere pitted with craters. `smooth` welds the icosphere first so normals
 * average across faces (the moon); leaving it non-indexed keeps hard facets
 * (the asteroid).
 */
function pittedSphere(
  radius: number,
  detail: number,
  craters: Crater[],
  smooth: boolean,
  lumps = 0,
): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(radius, detail);
  if (smooth) g = mergeVertices(g, 1e-5);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let d = 0;
    if (lumps) d += rockNoise(v.x * 2.2, v.y * 2.2, v.z * 2.2) * lumps * radius;
    for (const c of craters) {
      const t = Math.acos(THREE.MathUtils.clamp(v.dot(c.dir), -1, 1)) / c.r;
      // Steep-walled bowl with a flat floor, then a sharp raised rim: the two
      // together are what make a dent read as a *crater* at thumbnail size.
      if (t < 1) d -= c.depth * Math.min(1, (1 - t) * 3.2);
      else if (t < 1.3) d += c.depth * 0.5 * Math.sin(((t - 1) / 0.3) * Math.PI);
    }
    v.multiplyScalar(radius + d);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

const dir = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

/** Swing a +y-aligned geometry onto an arbitrary direction. */
function orientTo(g: THREE.BufferGeometry, d: THREE.Vector3): THREE.BufferGeometry {
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
  return g;
}

// ===========================================================================
// Faceted-gem builder
//
// A gem is a girdle outline (in x/z) that is banded, stepped up to a table and
// stepped down to a culet or keel. Every face is emitted as a raw triangle and
// the whole thing gets flat normals, so each facet catches the light on its
// own — which is the entire point of a cut stone.
// ===========================================================================

interface Tier {
  /** girdle scale for this tier; 0 closes the shape (culet / apex). */
  s: number;
  /** height above the girdle top (crown) or below the girdle bottom (pavilion). */
  h: number;
}

interface GemSpec {
  girdle: V2[];
  /** raise every other girdle vertex — the zigzag that makes a brilliant sparkle */
  scallop?: number;
  /** girdle band thickness */
  gh?: number;
  crown: Tier[];
  pav: Tier[];
  /** half-length (along x) of the pavilion keel; 0 = a single culet point */
  keel?: number;
}

/** Force the outline clockwise in (x, z) so up-facing fans wind correctly. */
function orient(pts: V2[]): V2[] {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a < 0 ? pts : pts.slice().reverse();
}

function facetGem(spec: GemSpec): THREE.BufferGeometry {
  const gp = orient(spec.girdle);
  const n = gp.length;
  const gh = spec.gh ?? 0.05;
  const sc = spec.scallop ?? 0;
  const t: number[] = [];
  const V = THREE.Vector3;

  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    t.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
    tri(a, b, c);
    tri(a, c, d);
  };

  const up = gp.map(([x, z], i) => new V(x, gh / 2 + (i % 2 ? sc : 0), z));
  const lo = gp.map(([x, z], i) => new V(x, -gh / 2 - (i % 2 ? sc * 0.5 : 0), z));

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quad(lo[i], lo[j], up[j], up[i]);
  }

  // --- crown ---
  let ring: THREE.Vector3[] = up;
  for (const tier of spec.crown) {
    if (tier.s <= 0) {
      const apex = new V(0, gh / 2 + tier.h, 0);
      for (let i = 0; i < n; i++) tri(ring[i], ring[(i + 1) % n], apex);
      ring = [];
      break;
    }
    const next = gp.map(([x, z]) => new V(x * tier.s, gh / 2 + tier.h, z * tier.s));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      quad(ring[i], ring[j], next[j], next[i]);
    }
    ring = next;
  }
  for (let i = 1; i < ring.length - 1; i++) tri(ring[0], ring[i], ring[i + 1]);

  // --- pavilion ---
  let pring: THREE.Vector3[] = lo;
  for (const tier of spec.pav) {
    if (tier.s <= 0) {
      const y = -gh / 2 - tier.h;
      const k = spec.keel ?? 0;
      const kp = (i: number) => new V(k ? THREE.MathUtils.clamp(pring[i].x, -k, k) : 0, y, 0);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = kp(i);
        const b = kp(j);
        if (a.distanceToSquared(b) < 1e-10) tri(pring[j], pring[i], a);
        else quad(pring[j], pring[i], a, b);
      }
      pring = [];
      break;
    }
    const next = gp.map(([x, z]) => new V(x * tier.s, -gh / 2 - tier.h, z * tier.s));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      quad(pring[j], pring[i], next[i], next[j]);
    }
    pring = next;
  }
  for (let i = 1; i < pring.length - 1; i++) tri(pring[0], pring[i + 1], pring[i]);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(t, 3));
  g.computeVertexNormals();
  return g;
}

// -- girdle outlines --------------------------------------------------------

const ringPts = (n: number, f: (a: number) => V2): V2[] => {
  const out: V2[] = [];
  for (let i = 0; i < n; i++) out.push(f((i / n) * Math.PI * 2));
  return out;
};

const ellipse = (n: number, rx: number, rz: number) =>
  ringPts(n, (a) => [Math.cos(a) * rx, Math.sin(a) * rz]);

/** Rounded square/cushion; `p` 2 = circle, 4+ = increasingly square. */
const cushionPts = (n: number, rx: number, rz: number, p: number) =>
  ringPts(n, (a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      Math.sign(c) * Math.pow(Math.abs(c), 2 / p) * rx,
      Math.sign(s) * Math.pow(Math.abs(s), 2 / p) * rz,
    ];
  });

/** Pointed oval — both ends come to a proper corner. */
const marquisePts = (n: number, rx: number, rz: number) =>
  ringPts(n, (a) => [Math.cos(a) * rx, Math.sin(a) * Math.abs(Math.sin(a)) * rz]);

/** Teardrop: round at −x, pointed at +x. */
const pearPts = (n: number, rx: number, rz: number) =>
  ringPts(n, (a) => {
    const w = (1 - Math.cos(a)) / 2;
    const f = Math.pow(Math.min(1, w * 1.9), 0.7);
    return [Math.cos(a) * rx, Math.sin(a) * rz * f];
  });

/**
 * Rounded triangle for the trillion cut: the radial support function of a real
 * triangle, softened toward a circle just enough to knock the corners off.
 */
const trillionPts = (n: number, d: number, round = 0.2) =>
  ringPts(n, (a) => {
    let best = -1;
    for (let k = 0; k < 3; k++) {
      const c = Math.cos(a - (Math.PI / 2 + (k * 2 * Math.PI) / 3));
      if (c > best) best = c;
    }
    const k = (d / Math.max(best, 0.35)) * (1 - round) + d * 1.45 * round;
    return [Math.cos(a) * k, Math.sin(a) * k];
  });

/** Rectangle with cut corners — emerald, baguette, princess. */
const cutRect = (hx: number, hz: number, c: number): V2[] => [
  [hx, hz - c], [hx - c, hz], [-hx + c, hz], [-hx, hz - c],
  [-hx, -hz + c], [-hx + c, -hz], [hx - c, -hz], [hx, -hz + c],
];

// ===========================================================================
// Materials
// ===========================================================================

const phys = (key: string, p: THREE.MeshPhysicalMaterialParameters) =>
  mat(key, () => new THREE.MeshPhysicalMaterial({ envMapIntensity: 1.35, ...p }));

const glow = (key: string, color: number, opacity = 0.8) =>
  mat(
    key,
    () =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
  );

/** Painted hull / plastic — the workhorse for the cosmos set. */
const paint = (key: string, color: number, emissive = 0.14, extra: THREE.MeshPhysicalMaterialParameters = {}) =>
  phys(key, {
    color,
    roughness: 0.28,
    metalness: 0.12,
    clearcoat: 1,
    clearcoatRoughness: 0.14,
    emissive: new THREE.Color(color),
    emissiveIntensity: emissive,
    ...extra,
  });

const metal = (key: string, color: number, rough = 0.2, emissive = 0.06) =>
  phys(key, {
    color,
    roughness: rough,
    metalness: 1,
    emissive: new THREE.Color(color),
    emissiveIntensity: emissive,
    envMapIntensity: 1.8,
  });

const glassy = (key: string, color: number, transmission: number, emissive: number) =>
  phys(key, {
    color,
    roughness: 0.06,
    metalness: 0,
    transmission,
    thickness: 0.028,
    ior: 1.6,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    transparent: true,
    emissive: new THREE.Color(color),
    emissiveIntensity: emissive,
    envMapIntensity: 1.9,
  });

const darkGlass = () =>
  phys('void-glass', {
    color: 0x080b16,
    roughness: 0.05,
    metalness: 0.75,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    emissive: new THREE.Color(0x101a3a),
    emissiveIntensity: 0.35,
  });

// ===========================================================================
// THEME 1 — COSMOS
// ===========================================================================

// 0 — Rocket: finned retro hull, crimson livery, a plume under the skirt.
function rocket(): Part[] {
  const hull = paint('cos-hull', 0xeef4ff, 0.1, { metalness: 0.3, roughness: 0.2 });
  const red = paint('cos-red', 0xff4d5e, 0.4);
  const port = darkGlass();
  const flame = glow('cos-flame', 0xffb347, 0.85);

  const body = lathe([
    [0, 0.08], [0.155, 0.08], [0.163, 0.15], [0.155, 0.44],
    [0.142, 0.58], [0.108, 0.72], [0.062, 0.84], [0.024, 0.92], [0, 0.955],
  ], 32);

  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0.34);
  finShape.lineTo(0.19, 0.0);
  finShape.lineTo(0.19, 0.075);
  finShape.lineTo(0.028, 0.4);
  finShape.closePath();

  const parts: Part[] = [P(body, hull)];

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.035, bevelEnabled: false });
    fin.translate(0.115, 0.0, -0.0175);
    parts.push(P(xf(fin, { ry: a }), red));
  }

  parts.push(P(xf(cone(0.072, 0.2, 22), { y: 0.855 }), red));
  parts.push(P(xf(hoop(0.162, 0.019), { y: 0.42 }), red));
  parts.push(P(xf(hoop(0.107, 0.014), { y: 0.72 }), red));
  parts.push(P(xf(ball(0.062), { sz: 0.42, x: 0, y: 0.6, z: 0.125 }), port));
  parts.push(P(xf(tube(0.062, 0.014, 20), { y: 0.6, z: 0.128 }), red));
  parts.push(P(xf(hoop(0.168, 0.02), { y: 0.075 }), flame));
  parts.push(P(xf(cone(0.11, 0.2, 20, true), { rx: Math.PI, y: -0.02 }), flame));
  return parts;
}

// 1 — Ringed planet: banded amber globe under a tilted ice ring.
function ringedPlanet(): Part[] {
  const skin = paint('cos-planet', 0xf7a53b, 0.3, { roughness: 0.22 });
  const band = paint('cos-planet-band', 0xffe0a8, 0.35);
  const ringM = phys('cos-ring', {
    color: 0xfff0d2,
    roughness: 0.1,
    metalness: 0.05,
    transmission: 0.35,
    thickness: 0.02,
    transparent: true,
    opacity: 0.92,
    emissive: new THREE.Color(0xffd79a),
    emissiveIntensity: 0.8,
    side: THREE.DoubleSide,
  });

  const R = 0.29;
  const parts: Part[] = [P(ball(R, 34, 24), skin)];
  for (const lat of [-0.42, -0.05, 0.34]) {
    const rr = Math.cos(lat) * R;
    parts.push(P(xf(hoop(rr, 0.017, 34), { y: Math.sin(lat) * R }), band));
  }
  parts.push(P(disc(0.4, 0.63, 72), ringM));
  parts.push(P(disc(0.66, 0.71, 72), ringM));
  parts.push(P(hoop(0.4, 0.007, 64), ringM));

  // tilt the whole system, then lift it clear of the ground plane
  for (const p of parts) xf(p.g, { rz: 0.44, rx: 0.14, y: 0.42 });
  return parts;
}

// 2 — Comet: a hard little ice nucleus trailing tapered ion streaks.
function comet(): Part[] {
  const ice = phys('cos-ice', {
    color: 0xecfeff,
    roughness: 0.04,
    metalness: 0.1,
    clearcoat: 1,
    emissive: new THREE.Color(0x22d3ee),
    emissiveIntensity: 0.85,
  });
  const streak = glow('cos-tail', 0x38d3f5, 0.55);
  const coma = glow('cos-coma', 0x67e8f9, 0.28);

  const hx = 0.3;
  const hy = 0.66;
  const parts: Part[] = [
    P(xf(new THREE.IcosahedronGeometry(0.15, 0), { x: hx, y: hy }), ice),
    P(xf(new THREE.IcosahedronGeometry(0.062, 0), { x: hx - 0.02, y: hy - 0.14, z: 0.1 }), ice),
    P(xf(ball(0.2, 18, 14), { sy: 0.9, x: hx, y: hy }), coma),
  ];

  // Streaks taper to a point AWAY from the nucleus, so the tail reads as
  // motion rather than as a funnel.
  const streaks: [number, number, number, number][] = [
    // base radius, length, fan (rad), lateral z
    [0.062, 0.82, 0.0, 0],
    [0.04, 0.66, 0.2, 0.07],
    [0.038, 0.7, -0.19, -0.08],
    [0.026, 0.5, 0.42, -0.04],
    [0.024, 0.54, -0.4, 0.05],
  ];
  for (const [r, len, fan, dz] of streaks) {
    const c = cone(r, len, 12);
    c.rotateX(Math.PI); // apex now points down; base sits at the nucleus
    c.translate(0, -len / 2, 0);
    xf(c, { rz: -Math.PI / 3 + fan, x: hx, y: hy, z: dz });
    parts.push(P(c, streak));
  }
  return parts;
}

// 3 — Helmet: white shell, huge gold mirror visor, collar ring, antenna.
function helmet(): Part[] {
  const shell = paint('cos-shell', 0xf4f8ff, 0.12, { metalness: 0.15, roughness: 0.24 });
  const gold = metal('cos-visor', 0xffb43c, 0.06, 0.3);
  const trim = paint('cos-helm-trim', 0x8ab4ff, 0.5);

  const R = 0.31;
  const parts: Part[] = [
    P(xf(ball(R, 34, 26), { y: 0.44 }), shell),
    // visor: a broad front patch of the sphere, mirrored gold
    P(
      xf(
        new THREE.SphereGeometry(R * 1.015, 36, 22, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.2, Math.PI * 0.52),
        { y: 0.44 },
      ),
      gold,
    ),
    P(xf(lathe([[0.2, 0], [0.225, 0.02], [0.225, 0.11], [0.2, 0.14], [0.2, 0]], 30), { y: 0.03 }), shell),
    P(xf(hoop(0.222, 0.026, 34), { y: 0.155 }), trim),
    P(xf(hoop(0.196, 0.02, 30), { y: 0.02 }), trim),
  ];
  // ear lugs
  for (const s of [-1, 1]) {
    parts.push(P(xf(new THREE.CylinderGeometry(0.072, 0.072, 0.05, 18), { rz: Math.PI / 2, x: s * 0.3, y: 0.44 }), trim));
  }
  // antenna
  parts.push(P(xf(new THREE.CylinderGeometry(0.014, 0.014, 0.2, 8), { rz: -0.3, x: 0.2, y: 0.75 }), shell));
  parts.push(P(xf(ball(0.038, 14, 10), { x: 0.26, y: 0.84 }), trim));
  return parts;
}

// 4 — Crystal: a violet shard cluster on a dark matrix.
function crystalShard(): Part[] {
  const g1 = glassy('cos-crys', 0xa855f7, 0.62, 0.55);
  const g2 = glassy('cos-crys-2', 0xd8b4fe, 0.6, 0.6);
  const rock = phys('cos-matrix', {
    color: 0x2a2440,
    roughness: 0.7,
    metalness: 0.1,
    emissive: new THREE.Color(0x4c1d95),
    emissiveIntensity: 0.2,
  });

  const shard = (r: number, h: number, tip: number) => {
    const g = new THREE.CylinderGeometry(r, r * 1.06, h, 6, 1, false);
    g.translate(0, h / 2, 0);
    const c = cone(r, tip, 6);
    c.translate(0, h + tip / 2, 0);
    return [g, c];
  };

  const parts: Part[] = [
    P(xf(new THREE.IcosahedronGeometry(0.2, 0), { sy: 0.42, y: 0.06 }), rock),
  ];
  const place = (r: number, h: number, tip: number, m: THREE.Material, t: Xf) => {
    for (const g of shard(r, h, tip)) parts.push(P(xf(g, t), m));
  };
  place(0.155, 0.52, 0.22, g1, { rz: 0.05, x: 0, y: 0.05, z: 0 });
  place(0.098, 0.34, 0.15, g2, { rz: -0.42, x: 0.19, y: 0.03, z: 0.05 });
  place(0.078, 0.24, 0.12, g2, { rz: 0.5, rx: 0.16, x: -0.18, y: 0.03, z: -0.06 });
  place(0.062, 0.16, 0.09, g1, { rz: -0.24, rx: -0.4, x: 0.04, y: 0.02, z: -0.17 });
  return parts;
}

// 5 — Satellite: boxy bus with two blue wings and a dish.
function satellite(): Part[] {
  const steel = phys('cos-steel', {
    color: 0xc3cddf,
    roughness: 0.22,
    metalness: 0.85,
    clearcoat: 0.7,
    emissive: new THREE.Color(0x7b8db3),
    emissiveIntensity: 0.12,
    side: THREE.DoubleSide,
  });
  const panel = paint('cos-panel', 0x2f6bf5, 0.55, { metalness: 0.4, roughness: 0.15 });
  const gold = metal('cos-foil', 0xffc861, 0.24, 0.2);

  const parts: Part[] = [
    P(xf(box(0.27, 0.3, 0.24), { y: 0.5 }), gold),
    P(xf(box(0.29, 0.06, 0.26), { y: 0.63 }), steel),
    P(xf(box(0.29, 0.05, 0.26), { y: 0.37 }), steel),
  ];
  for (const s of [-1, 1]) {
    parts.push(P(xf(new THREE.CylinderGeometry(0.016, 0.016, 0.1, 8), { rz: Math.PI / 2, x: s * 0.185, y: 0.5 }), steel));
    parts.push(P(xf(box(0.3, 0.024, 0.3), { x: s * 0.4, y: 0.5 }), panel));
    parts.push(P(xf(box(0.31, 0.034, 0.032), { x: s * 0.4, y: 0.5 }), steel));
    parts.push(P(xf(box(0.022, 0.034, 0.31), { x: s * 0.4, y: 0.5 }), steel));
  }
  // dish, opening toward +z
  parts.push(
    P(xf(new THREE.SphereGeometry(0.16, 26, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), { rx: -Math.PI / 2 + 0.35, y: 0.52, z: 0.22 }), steel),
  );
  parts.push(P(xf(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 8), { rx: Math.PI / 2 - 0.35, y: 0.52, z: 0.27 }), steel));
  parts.push(P(xf(ball(0.03, 12, 10), { y: 0.53, z: 0.33 }), gold));
  parts.push(P(xf(new THREE.CylinderGeometry(0.01, 0.01, 0.2, 8), { y: 0.75 }), steel));
  parts.push(P(xf(ball(0.032, 12, 10), { y: 0.85 }), panel));
  return parts;
}

// 6 — Moon: pale sphere with dark-floored craters.
//
// Displacement alone is not enough here: with no shadow casting, a dent on a
// diffuse sphere is nearly invisible at thumbnail size. So every crater also
// gets a darker spherical cap dropped into its floor, which reads as a crater
// at any size and from any angle.
function moon(): Part[] {
  const R = 0.4;
  const rock = phys('cos-moon', {
    color: 0xb9c4dc,
    roughness: 1,
    metalness: 0,
    clearcoat: 0,
    emissive: new THREE.Color(0x3d4967),
    emissiveIntensity: 0.5,
    envMapIntensity: 0.6,
  });
  const maria = phys('cos-moon-floor', {
    color: 0x525f7f,
    roughness: 1,
    metalness: 0,
    clearcoat: 0,
    emissive: new THREE.Color(0x1a2137),
    emissiveIntensity: 0.7,
    envMapIntensity: 0.35,
  });
  // Well spaced, so no matter how the artifact spins two or three craters are
  // always facing the camera.
  const craters: Crater[] = [
    { dir: dir(0.34, 0.42, 0.84), r: 0.5, depth: 0.07 },
    { dir: dir(-0.86, 0.2, 0.47), r: 0.42, depth: 0.062 },
    { dir: dir(0.3, -0.82, 0.49), r: 0.34, depth: 0.05 },
    { dir: dir(-0.2, 0.94, -0.28), r: 0.4, depth: 0.058 },
    { dir: dir(0.88, -0.02, -0.47), r: 0.36, depth: 0.052 },
    { dir: dir(-0.44, -0.5, -0.75), r: 0.4, depth: 0.055 },
    { dir: dir(0.14, 0.3, -0.94), r: 0.3, depth: 0.045 },
  ];

  const parts: Part[] = [P(pittedSphere(R, 4, craters, true), rock)];
  for (const c of craters) {
    // Floor sits proud of the pit bottom so overlapping craters cannot bury it.
    const floor = new THREE.SphereGeometry(
      R - c.depth * 0.45, 26, 13, 0, Math.PI * 2, 0, c.r * 0.62,
    );
    parts.push(P(orientTo(floor, c.dir), maria));
    // Bright rim ring: the other half of what makes a dent read as a crater.
    const rim = new THREE.TorusGeometry(R * Math.sin(c.r) * 0.98, 0.016, 6, 30).rotateX(Math.PI / 2);
    orientTo(rim, c.dir);
    rim.translate(
      c.dir.x * R * Math.cos(c.r),
      c.dir.y * R * Math.cos(c.r),
      c.dir.z * R * Math.cos(c.r),
    );
    parts.push(P(rim, rock));
  }
  for (const p of parts) p.g.translate(0, 0.42, 0);
  return parts;
}

// 7 — Starburst: a six-spike gold sparkle with eight short diagonals.
function starburst(): Part[] {
  const core = phys('cos-star', {
    color: 0xfde68a,
    roughness: 0.12,
    metalness: 0.35,
    clearcoat: 1,
    emissive: new THREE.Color(0xfacc15),
    emissiveIntensity: 0.95,
  });
  const halo = glow('cos-star-halo', 0xfff3c4, 0.55);

  const parts: Part[] = [P(new THREE.OctahedronGeometry(0.145, 0), core)];
  const axes: [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  for (const [x, y, z] of axes) {
    const c = cone(0.095, 0.46, 4);
    c.translate(0, 0.23, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(x, y, z),
    );
    c.applyQuaternion(q);
    parts.push(P(c, core));
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const c = cone(0.05, 0.2, 4);
        c.translate(0, 0.1, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          dir(sx, sy, sz),
        );
        c.applyQuaternion(q);
        parts.push(P(c, core));
      }
    }
  }
  parts.push(P(ball(0.2, 18, 14), halo));
  for (const p of parts) p.g.translate(0, 0.5, 0);
  return parts;
}

// 8 — Saucer: lens hull, glass dome, ring of landing lights, tractor beam.
function saucer(): Part[] {
  const hull = phys('cos-saucer', {
    color: 0xd7e2ee,
    roughness: 0.14,
    metalness: 0.9,
    clearcoat: 1,
    emissive: new THREE.Color(0x6fa8c9),
    emissiveIntensity: 0.14,
    envMapIntensity: 1.8,
  });
  const dome = glassy('cos-dome', 0x34d399, 0.7, 0.55);
  const lamp = glow('cos-lamp', 0x5eead4, 0.95);

  const parts: Part[] = [
    P(
      xf(
        lathe([
          [0, 0], [0.1, 0.005], [0.24, 0.035], [0.38, 0.075], [0.48, 0.1],
          [0.5, 0.115], [0.46, 0.155], [0.32, 0.192], [0.17, 0.212], [0, 0.218],
        ], 44),
        { y: 0.16 },
      ),
      hull,
    ),
    P(xf(hoop(0.492, 0.017, 48), { y: 0.275 }), hull),
    P(xf(ball(0.185, 26, 16, ), { y: 0.375 }), dome),
    P(xf(hoop(0.185, 0.018, 30), { y: 0.372 }), hull),
  ];
  for (const g of around(8, 0.36, 0.19, () => ball(0.036, 12, 10))) parts.push(P(g, lamp));
  parts.push(P(xf(cone(0.2, 0.34, 22, true), { rx: Math.PI, y: 0.0 }), lamp));
  parts.push(P(xf(disc(0, 0.24, 28), { y: -0.16 }), lamp));
  return parts;
}

// 9 — Black hole: a true void ringed by a hot accretion disc + lensed arc.
function blackHole(): Part[] {
  const voidM = phys('cos-void', {
    color: 0x000000,
    roughness: 1,
    metalness: 0,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 0,
    envMapIntensity: 0,
  });
  const hot = glow('cos-hot', 0xfff0c2, 0.95);
  const warm = glow('cos-warm', 0xff7a1a, 0.65);

  const parts: Part[] = [P(ball(0.2, 30, 22), voidM)];
  parts.push(P(hoop(0.235, 0.014, 56), hot));
  parts.push(P(disc(0.27, 0.37, 80), hot));
  parts.push(P(disc(0.35, 0.52, 80), warm));
  parts.push(P(disc(0.5, 0.6, 80), hot));
  // lensed arc rising over the top
  const arc = new THREE.TorusGeometry(0.35, 0.03, 8, 40, Math.PI);
  parts.push(P(xf(arc, { ry: -Math.PI / 2 }), warm));
  const arc2 = new THREE.TorusGeometry(0.28, 0.016, 8, 36, Math.PI);
  parts.push(P(xf(arc2, { ry: -Math.PI / 2 }), hot));

  for (const p of parts) xf(p.g, { rz: 0.22, rx: 0.3, y: 0.42 });
  return parts;
}

// 10 — Galaxy: two beaded spiral arms around a bright bulge, on a tilted haze.
function galaxy(): Part[] {
  const core = phys('cos-gal-core', {
    color: 0xfff3d0,
    roughness: 0.2,
    metalness: 0,
    emissive: new THREE.Color(0xffe4a0),
    emissiveIntensity: 1.1,
  });
  const inner = glow('cos-gal-in', 0xff4fa8, 0.85);
  const outer = glow('cos-gal-out', 0x6d7cff, 0.85);
  const haze = glow('cos-gal-haze', 0x7c5cff, 0.3);

  const parts: Part[] = [P(xf(ball(0.13, 22, 16), { sy: 0.62 }), core)];
  parts.push(P(disc(0.06, 0.56, 64), haze));
  parts.push(P(disc(0.04, 0.22, 40), inner));

  const N = 20;
  for (let arm = 0; arm < 2; arm++) {
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const a = arm * Math.PI + t * 2.3;
      const r = 0.12 + t * 0.44;
      const rad = 0.062 * (1 - t * 0.66);
      const g = ball(rad, 8, 6);
      g.translate(Math.cos(a) * r, 0, Math.sin(a) * r);
      parts.push(P(g, t < 0.45 ? inner : outer));
    }
  }
  // Only lightly inclined: the table camera already looks down at ~40°, so a
  // near-horizontal disc reads as a pinwheel from every spin angle.
  for (const p of parts) xf(p.g, { rx: -0.28, rz: 0.16, y: 0.34 });
  return parts;
}

// 11 — Nebula: a wispy rose cloud with bright newborn stars inside.
function nebula(): Part[] {
  const cloud = phys('cos-neb', {
    color: 0xff5fa8,
    roughness: 0.5,
    metalness: 0,
    transmission: 0.55,
    thickness: 0.08,
    ior: 1.2,
    transparent: true,
    opacity: 0.78,
    emissive: new THREE.Color(0xff6fb5),
    emissiveIntensity: 1.05,
  });
  const violet = phys('cos-neb-2', {
    color: 0x7c4dff,
    roughness: 0.55,
    metalness: 0,
    transmission: 0.5,
    thickness: 0.08,
    ior: 1.2,
    transparent: true,
    opacity: 0.76,
    emissive: new THREE.Color(0x8b6bff),
    emissiveIntensity: 1,
  });
  const star = glow('cos-neb-star', 0xfff6ff, 1);

  // A tilted, elongated band of puffs rather than a ball of grapes.
  const puffs: [number, number, number, number, boolean][] = [
    [0.0, 0.44, 0.0, 0.26, false],
    [0.3, 0.58, 0.05, 0.185, true],
    [-0.3, 0.31, -0.04, 0.175, true],
    [0.16, 0.22, -0.1, 0.135, false],
    [-0.14, 0.63, 0.1, 0.15, false],
    [0.45, 0.35, -0.06, 0.1, true],
    [-0.44, 0.55, 0.02, 0.095, false],
  ];
  const parts: Part[] = [];
  for (const [x, y, z, r, v] of puffs) {
    parts.push(P(xf(new THREE.IcosahedronGeometry(r, 2), { sx: 1.25, sy: 0.86, x, y, z }), v ? violet : cloud));
  }
  const stars: [number, number, number, number][] = [
    [0.02, 0.46, 0.06, 0.07],
    [0.28, 0.6, 0.1, 0.04],
    [-0.26, 0.32, 0.0, 0.036],
    [0.12, 0.68, -0.04, 0.03],
    [-0.34, 0.56, 0.06, 0.028],
    [0.44, 0.36, -0.02, 0.026],
  ];
  for (const [x, y, z, r] of stars) parts.push(P(xf(ball(r, 10, 8), { x, y, z }), star));
  return parts;
}

// 12 — Asteroid: a hard-faceted, elongated dark rock with two pebbles.
function asteroid(): Part[] {
  const rock = phys('cos-rock', {
    color: 0x8a755c,
    roughness: 0.72,
    metalness: 0.28,
    clearcoat: 0.2,
    emissive: new THREE.Color(0x4a3a2a),
    emissiveIntensity: 0.3,
  });
  const main = pittedSphere(
    0.34,
    2,
    [
      { dir: dir(0.6, 0.5, 0.6), r: 0.55, depth: 0.06 },
      { dir: dir(-0.8, -0.1, 0.5), r: 0.42, depth: 0.05 },
      { dir: dir(0.1, -0.9, -0.3), r: 0.36, depth: 0.045 },
    ],
    false,
    0.13,
  );
  xf(main, { sx: 1.28, sy: 0.78, sz: 0.95, rz: 0.3, ry: 0.4, y: 0.34 });

  const pebble = (r: number, t: Xf) =>
    xf(pittedSphere(r, 1, [], false, 0.2), t);

  return [
    P(main, rock),
    P(pebble(0.1, { x: 0.44, y: 0.5, z: 0.14, ry: 1.1 }), rock),
    P(pebble(0.062, { x: -0.4, y: 0.16, z: -0.18, ry: 2.2 }), rock),
  ];
}

// 13 — Pulsar: a hot core firing twin beams through an equatorial ring.
function pulsar(): Part[] {
  const core = phys('cos-pulse', {
    color: 0xdbeafe,
    roughness: 0.06,
    metalness: 0.2,
    clearcoat: 1,
    emissive: new THREE.Color(0x93c5fd),
    emissiveIntensity: 1.4,
  });
  const beam = glow('cos-beam', 0x60a5fa, 0.55);
  const ring = glow('cos-ring-glow', 0x22d3ee, 0.9);

  const parts: Part[] = [P(ball(0.115, 24, 18), core)];
  // Twin needle beams — narrow, so the silhouette is an hourglass, not a wedge.
  for (const s of [1, -1]) {
    const c = cone(0.085, 0.62, 18, true);
    c.translate(0, 0.31, 0);
    if (s < 0) c.rotateZ(Math.PI);
    parts.push(P(c, beam));
    const inner = cone(0.03, 0.66, 12, true);
    inner.translate(0, 0.33, 0);
    if (s < 0) inner.rotateZ(Math.PI);
    parts.push(P(inner, ring));
  }
  parts.push(P(hoop(0.34, 0.024, 44), ring));
  parts.push(P(hoop(0.45, 0.01, 44), ring));
  for (const p of parts) xf(p.g, { rz: 0.3, y: 0.5 });
  return parts;
}

// 14 — Observatory: copper dome on a pale drum, shutter open, scope out.
function observatory(): Part[] {
  const wall = paint('cos-wall', 0xe6ecf7, 0.12, { metalness: 0.1, roughness: 0.35 });
  const copper = metal('cos-copper', 0xd98b45, 0.22, 0.22);
  const slit = darkGlass();
  const lens = glow('cos-lens', 0x67e8f9, 0.95);

  const parts: Part[] = [
    P(xf(new THREE.CylinderGeometry(0.42, 0.46, 0.07, 40), { y: 0.035 }), wall),
    P(xf(new THREE.CylinderGeometry(0.34, 0.36, 0.26, 40), { y: 0.2 }), wall),
    P(xf(hoop(0.352, 0.02, 40), { y: 0.33 }), copper),
    P(xf(new THREE.SphereGeometry(0.35, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), { y: 0.34 }), copper),
    P(xf(hoop(0.35, 0.018, 40), { y: 0.345 }), copper),
  ];
  // shutter slit running up the front meridian, with lipped shutter rails
  const slitArc = new THREE.TorusGeometry(0.352, 0.028, 6, 26, Math.PI * 0.5);
  parts.push(P(xf(slitArc, { ry: -Math.PI / 2, y: 0.34 }), slit));
  for (const s of [-1, 1]) {
    const rail = new THREE.TorusGeometry(0.357, 0.012, 6, 26, Math.PI * 0.5);
    parts.push(P(xf(rail, { ry: -Math.PI / 2 + s * 0.11, y: 0.34 }), copper));
  }
  // telescope poking out through the shutter, leaning forward over the rim
  parts.push(P(xf(new THREE.CylinderGeometry(0.055, 0.075, 0.5, 18), { rx: 0.72, y: 0.52, z: 0.14 }), slit));
  parts.push(P(xf(new THREE.CylinderGeometry(0.07, 0.07, 0.035, 18), { rx: 0.72, y: 0.68, z: 0.3 }), lens));
  // drum windows
  for (const g of around(6, 0.352, 0.19, () => box(0.09, 0.1, 0.03), true)) parts.push(P(g, slit));
  return parts;
}

const COSMOS: (() => Part[])[] = [
  rocket, ringedPlanet, comet, helmet, crystalShard,
  satellite, moon, starburst, saucer, blackHole,
  galaxy, nebula, asteroid, pulsar, observatory,
];

// ===========================================================================
// THEME 2 — GAMBIT (the chess set, three finishes)
//
// Staunton silhouettes revolved from hand-authored lathe profiles: radius is in
// "tile" units, height is normalised 0…1 and multiplied by the piece's HEIGHT
// entry. Curved runs are resampled through a Catmull-Rom spline so the turnings
// read as lathed stone rather than stacked cones. Each piece stands on a low
// glass plinth whose glowing rim carries the finish colour — which is what
// makes an obsidian piece readable against a near-black scene.
// ===========================================================================

type ChessKind = 'P' | 'N' | 'B' | 'R' | 'Q';
type Finish = 0 | 1 | 2; // ivory | obsidian | gilded

const HEIGHT: Record<ChessKind, number> = { P: 0.72, N: 0.88, B: 0.94, R: 0.8, Q: 1.06 };

type Seg = V2 | { c: V2[]; n: number };

const smoothRun = (pts: V2[], steps: number): V2[] =>
  new THREE.CatmullRomCurve3(pts.map(([r, y]) => new THREE.Vector3(r, y, 0)), false, 'catmullrom', 0.5)
    .getPoints(steps)
    .map((v) => [Math.max(0, v.x), v.y] as V2);

const profile = (segs: Seg[]): V2[] => {
  const out: V2[] = [];
  const push = (p: V2) => {
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

const PROFILES: Record<ChessKind, V2[]> = {
  P: profile([
    [0, 0], [0.34, 0], [0.34, 0.048],
    { c: [[0.34, 0.048], [0.312, 0.082], [0.238, 0.112], [0.188, 0.152], [0.162, 0.215]], n: 9 },
    { c: [[0.162, 0.215], [0.14, 0.3], [0.126, 0.4], [0.122, 0.472]], n: 8 },
    { c: [[0.122, 0.472], [0.176, 0.504], [0.166, 0.544], [0.116, 0.566]], n: 7 },
    { c: [[0.116, 0.566], [0.156, 0.612], [0.19, 0.7], [0.186, 0.8], [0.15, 0.886], [0.09, 0.955]], n: 14 },
    [0, 0.99],
  ]),
  R: profile([
    [0, 0], [0.365, 0], [0.365, 0.055],
    { c: [[0.365, 0.055], [0.336, 0.09], [0.268, 0.124], [0.244, 0.19]], n: 8 },
    { c: [[0.244, 0.19], [0.231, 0.3], [0.231, 0.45], [0.246, 0.552]], n: 9 },
    { c: [[0.246, 0.552], [0.286, 0.6], [0.324, 0.632]], n: 6 },
    [0.336, 0.662], [0.336, 0.762], [0.238, 0.762], [0.238, 0.702],
    { c: [[0.238, 0.702], [0.15, 0.686], [0, 0.68]], n: 5 },
  ]),
  N: profile([
    [0, 0], [0.355, 0], [0.355, 0.05],
    { c: [[0.355, 0.05], [0.326, 0.086], [0.252, 0.116], [0.206, 0.16], [0.184, 0.226]], n: 9 },
    { c: [[0.184, 0.226], [0.174, 0.292], [0.198, 0.346], [0.216, 0.398]], n: 7 },
    [0.14, 0.418], [0, 0.418],
  ]),
  B: profile([
    [0, 0], [0.35, 0], [0.35, 0.05],
    { c: [[0.35, 0.05], [0.32, 0.082], [0.246, 0.11], [0.2, 0.15], [0.175, 0.21]], n: 9 },
    { c: [[0.175, 0.21], [0.15, 0.29], [0.136, 0.38], [0.13, 0.438]], n: 8 },
    { c: [[0.13, 0.438], [0.186, 0.474], [0.176, 0.514], [0.121, 0.536]], n: 7 },
    { c: [[0.121, 0.536], [0.166, 0.586], [0.201, 0.666], [0.206, 0.746], [0.176, 0.836], [0.116, 0.906], [0.05, 0.95]], n: 16 },
    [0, 0.962],
  ]),
  Q: profile([
    [0, 0], [0.375, 0], [0.375, 0.052],
    { c: [[0.375, 0.052], [0.346, 0.086], [0.262, 0.118], [0.212, 0.155], [0.186, 0.215]], n: 9 },
    { c: [[0.186, 0.215], [0.161, 0.3], [0.143, 0.4], [0.133, 0.49], [0.133, 0.542]], n: 10 },
    { c: [[0.133, 0.542], [0.196, 0.578], [0.186, 0.618], [0.126, 0.644]], n: 7 },
    { c: [[0.126, 0.644], [0.176, 0.7], [0.226, 0.775], [0.256, 0.844]], n: 8 },
    [0.256, 0.876], [0.202, 0.876], [0.202, 0.802],
    { c: [[0.202, 0.802], [0.13, 0.782], [0, 0.772]], n: 6 },
  ]),
};

/** Horse-head silhouette, in tile units (+x = the muzzle). */
const KNIGHT_HEAD: V2[] = [
  [-0.17, 0.0], [-0.214, 0.14], [-0.226, 0.3], [-0.16, 0.44], [-0.07, 0.52],
  [0.0, 0.536], [0.056, 0.47], [0.136, 0.436], [0.236, 0.346], [0.286, 0.264],
  [0.246, 0.214], [0.156, 0.236], [0.09, 0.2], [0.046, 0.13], [0.02, 0.05], [0.0, 0.0],
];

const PLINTH_H = 0.05;

const FINISH_RIM = [0x9ad4ff, 0xf05cff, 0xffb020];

function bodyMat(f: Finish): THREE.Material {
  if (f === 0) {
    return phys('gam-ivory', {
      color: 0xfdf8ec,
      roughness: 0.26,
      metalness: 0,
      transmission: 0.22,
      thickness: 0.03,
      ior: 1.46,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      sheen: 0.8,
      sheenColor: new THREE.Color(0xfff2da),
      sheenRoughness: 0.45,
      transparent: true,
      emissive: new THREE.Color(0xdbeafe),
      emissiveIntensity: 0.16,
      envMapIntensity: 1.5,
    });
  }
  if (f === 1) {
    // Genuinely black glass: the violet only ever shows up as a grazing sheen
    // and in the plinth rim, never as body colour.
    return phys('gam-obsidian', {
      color: 0x05060c,
      roughness: 0.05,
      metalness: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      sheen: 0.6,
      sheenColor: new THREE.Color(0x7c3aed),
      sheenRoughness: 0.6,
      emissive: new THREE.Color(0x16092c),
      emissiveIntensity: 0.4,
      envMapIntensity: 0.5,
    });
  }
  return phys('gam-gilded', {
    color: 0xffd35c,
    roughness: 0.14,
    metalness: 1,
    clearcoat: 0.7,
    clearcoatRoughness: 0.08,
    emissive: new THREE.Color(0x8a5a00),
    emissiveIntensity: 0.3,
    envMapIntensity: 2.2,
  });
}

function trimMat(f: Finish): THREE.Material {
  const c = FINISH_RIM[f];
  return phys(`gam-trim-${f}`, {
    color: c,
    roughness: 0.18,
    metalness: 0.7,
    clearcoat: 1,
    emissive: new THREE.Color(c),
    emissiveIntensity: 0.75,
  });
}

const rimMat = (f: Finish) => glow(`gam-rim-${f}`, FINISH_RIM[f], 0.85);

function plinthMat(f: Finish): THREE.Material {
  const c = FINISH_RIM[f];
  return phys(`gam-plinth-${f}`, {
    color: f === 0 ? 0x1b2a44 : f === 1 ? 0x1a0f2e : 0x2c1c06,
    roughness: 0.12,
    metalness: 0.4,
    clearcoat: 1,
    emissive: new THREE.Color(c),
    emissiveIntensity: 0.22,
  });
}

function chessPiece(kind: ChessKind, f: Finish): Part[] {
  const body = bodyMat(f);
  const trim = trimMat(f);
  const rim = rimMat(f);
  const plinth = plinthMat(f);
  const h = HEIGHT[kind];
  const base = PLINTH_H;

  const parts: Part[] = [
    P(xf(new THREE.CylinderGeometry(0.42, 0.44, PLINTH_H, 44), { y: PLINTH_H / 2 }), plinth),
    P(xf(hoop(0.435, 0.012, 48), { y: PLINTH_H * 0.72 }), rim),
    P(xf(disc(0.2, 0.415, 44), { y: 0.004 }), rim),
    P(xf(lathe(PROFILES[kind].map(([r, y]) => [r, y * h] as V2), 40), { y: base }), body),
  ];

  if (kind === 'R') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      parts.push(
        P(
          xf(box(0.112, h * 0.2, 0.09), {
            ry: a,
            x: Math.sin(a) * 0.286,
            y: base + h * 0.855,
            z: Math.cos(a) * 0.286,
          }),
          body,
        ),
      );
    }
    parts.push(P(xf(hoop(0.244, 0.017, 34), { y: base + h * 0.63 }), trim));
  }

  if (kind === 'N') {
    const curve = new THREE.CatmullRomCurve3(
      KNIGHT_HEAD.map(([x, y]) => new THREE.Vector3(x, y, 0)),
      true,
      'catmullrom',
      0.5,
    );
    const shape = new THREE.Shape(curve.getPoints(72).map((v) => new THREE.Vector2(v.x, v.y)));
    const depth = 0.28;
    const head = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: 0.024,
      bevelSize: 0.024,
      bevelSegments: 3,
      curveSegments: 1,
    });
    head.translate(0, 0, -depth / 2);
    // Muzzle toward +z, then a three-quarter turn: the horse reads as a horse
    // from the resting camera instead of showing the back of its neck.
    head.rotateY(-Math.PI / 2);
    const yaw = -Math.PI / 2 + 0.38;
    parts.push(P(xf(head, { ry: yaw, y: base + h * 0.4 }), body));
    // mane ridge, so the head still has depth when the artifact spins edge-on
    parts.push(
      P(xf(box(0.05, 0.26, 0.08), { rx: 0.42, ry: yaw, y: base + h * 0.4 + 0.36, z: -0.13 }), trim),
    );
    for (const s of [-1, 1]) {
      parts.push(
        P(xf(cone(0.03, 0.1, 8), { ry: yaw, x: s * 0.075, y: base + h * 0.4 + 0.55, z: -0.03 }), trim),
      );
    }
    parts.push(P(xf(hoop(0.2, 0.016, 30), { y: base + h * 0.42 }), trim));
  }

  if (kind === 'B') {
    parts.push(P(xf(ball(0.06, 18, 14), { y: base + h * 0.978 }), body));
    // The mitre slit — a blade that cuts right through the hood and stands
    // proud of it, so a bishop is never mistaken for a tall pawn.
    parts.push(P(xf(tube(0.178, 0.022, 30), { rx: Math.PI / 2 - 0.55, y: base + h * 0.73 }), trim));
    parts.push(P(xf(hoop(0.132, 0.018, 30), { y: base + h * 0.5 }), trim));
  }

  if (kind === 'Q') {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push(
        P(xf(ball(0.052, 14, 12), { x: Math.sin(a) * 0.246, y: base + h * 0.888, z: Math.cos(a) * 0.246 }), trim),
      );
    }
    parts.push(P(xf(ball(0.078, 18, 14), { y: base + h * 0.845 }), body));
    parts.push(P(xf(hoop(0.146, 0.016, 30), { y: base + h * 0.55 }), trim));
  }

  if (kind === 'P') {
    parts.push(P(xf(hoop(0.128, 0.017, 30), { y: base + h * 0.56 }), trim));
  }

  return parts;
}

const CHESS_KINDS: ChessKind[] = ['P', 'N', 'B', 'R', 'Q'];
/** Shared scale so the queen fills the cube and the pawn stays visibly shorter. */
const CHESS_SCALE = 0.97 / (HEIGHT.Q + PLINTH_H);

// ===========================================================================
// THEME 3 — PRISM (fifteen cut stones)
//
// Every stone differs in BOTH cut and colour, so a glance at either the outline
// or the hue is enough. Transmission is kept below 1 and paired with emissive
// so a stone never disappears into a black backdrop.
// ===========================================================================

interface StoneSpec {
  color: number;
  transmission: number;
  ior: number;
  roughness?: number;
  emissive?: number;
  iridescence?: number;
  metalness?: number;
  sheen?: number;
  sheenColor?: number;
  attenuate?: number;
  /** environment reflection strength — dial down so tinted stones keep their hue */
  env?: number;
}

function stoneMat(key: string, s: StoneSpec): THREE.Material {
  const c = new THREE.Color(s.color);
  return phys(`gem-${key}`, {
    color: s.color,
    roughness: s.roughness ?? 0.02,
    metalness: s.metalness ?? 0,
    transmission: s.transmission,
    thickness: 0.035,
    ior: s.ior,
    clearcoat: 1,
    clearcoatRoughness: 0,
    specularIntensity: 1,
    iridescence: s.iridescence ?? 0,
    iridescenceIOR: 1.9,
    iridescenceThicknessRange: [180, 900],
    sheen: s.sheen ?? 0,
    sheenColor: (s.sheenColor ? new THREE.Color(s.sheenColor) : c.clone()),
    attenuationColor: c.clone(),
    attenuationDistance: s.attenuate ?? 0.5,
    // `transparent` is deliberately left off: three routes transmissive
    // materials through their own pass, and flagging them transparent only
    // costs sorting.
    emissive: c.clone(),
    emissiveIntensity: s.emissive ?? 0.12,
    envMapIntensity: s.env ?? 3.2,
  });
}

/** A hexagonal crystal prism with a pyramid termination. */
function prismShard(r: number, h: number, tip: number): THREE.BufferGeometry[] {
  const body = new THREE.CylinderGeometry(r, r * 1.04, h, 6, 1, false);
  body.translate(0, h / 2, 0);
  const cap = cone(r, tip, 6);
  cap.translate(0, h + tip / 2, 0);
  return [body, cap];
}

interface Stone {
  spec: StoneSpec;
  make: () => THREE.BufferGeometry[];
  /** resting tilt, so the table catches the key light */
  tilt?: Xf;
}

const STONES: Stone[] = [
  // 0 Ruby — round brilliant, deep crimson
  {
    spec: { color: 0xe0114a, transmission: 0.88, ior: 1.77, emissive: 0.2 },
    make: () => [
      facetGem({
        girdle: ellipse(16, 0.5, 0.5),
        scallop: 0.038,
        gh: 0.05,
        crown: [{ s: 0.55, h: 0.19 }],
        pav: [{ s: 0, h: 0.5 }],
      }),
    ],
    tilt: { rz: 0.1, rx: 0.5 },
  },
  // 1 Sapphire — emerald (step) cut, royal blue
  {
    spec: { color: 0x2453e6, transmission: 0.86, ior: 1.77, emissive: 0.22 },
    make: () => [
      facetGem({
        girdle: cutRect(0.5, 0.36, 0.13),
        gh: 0.06,
        crown: [{ s: 0.88, h: 0.06 }, { s: 0.6, h: 0.15 }],
        pav: [{ s: 0.74, h: 0.16 }, { s: 0, h: 0.42 }],
        keel: 0.2,
      }),
    ],
    tilt: { rz: 0.08, rx: 0.42 },
  },
  // 2 Emerald — marquise, spring green
  {
    spec: { color: 0x0fd489, transmission: 0.84, ior: 1.58, emissive: 0.16 },
    make: () => [
      facetGem({
        girdle: marquisePts(20, 0.62, 0.26),
        scallop: 0.03,
        gh: 0.045,
        crown: [{ s: 0.44, h: 0.19 }],
        pav: [{ s: 0, h: 0.44 }],
        keel: 0.4,
      }),
    ],
    tilt: { rz: 0.05, rx: 0.55, ry: 0.1 },
  },
  // 3 Topaz — pear, warm gold-orange
  {
    spec: { color: 0xff8410, transmission: 0.88, ior: 1.62, emissive: 0.18 },
    make: () => [
      facetGem({
        girdle: pearPts(20, 0.5, 0.36),
        scallop: 0.03,
        gh: 0.05,
        crown: [{ s: 0.52, h: 0.17 }],
        pav: [{ s: 0, h: 0.46 }],
      }),
    ],
    tilt: { rz: 0.06, rx: 0.5, ry: 0.06 },
  },
  // 4 Amethyst — hexagonal crystal point, violet
  {
    spec: { color: 0x9333ea, transmission: 0.8, ior: 1.55, emissive: 0.34, roughness: 0.06 },
    make: () => [
      ...prismShard(0.24, 0.62, 0.3).map((g) => xf(g, {})),
      ...prismShard(0.13, 0.32, 0.16).map((g) => xf(g, { rz: -0.3, x: 0.27, y: 0.02 })),
      ...prismShard(0.1, 0.2, 0.12).map((g) => xf(g, { rz: 0.4, rx: 0.15, x: -0.25, y: 0.02, z: 0.06 })),
    ],
  },
  // 5 Citrine — trillion, lemon yellow
  {
    spec: { color: 0xffe814, transmission: 0.88, ior: 1.55, emissive: 0.14 },
    make: () => [
      facetGem({
        girdle: trillionPts(24, 0.3, 0.16),
        scallop: 0.032,
        gh: 0.05,
        crown: [{ s: 0.5, h: 0.16 }],
        pav: [{ s: 0, h: 0.44 }],
      }),
    ],
    tilt: { rz: 0.06, rx: 0.48 },
  },
  // 6 Aquamarine — long shallow baguette, pale cyan
  {
    spec: { color: 0x3fd8f0, transmission: 0.9, ior: 1.58, emissive: 0.24 },
    make: () => [
      facetGem({
        girdle: cutRect(0.56, 0.19, 0.05),
        gh: 0.08,
        crown: [{ s: 0.78, h: 0.07 }],
        pav: [{ s: 0, h: 0.2 }],
        keel: 0.4,
      }),
    ],
    tilt: { rz: 0.05, rx: 0.5, ry: 0.12 },
  },
  // 7 Garnet — cushion, scarlet-orange
  {
    spec: { color: 0xff5410, transmission: 0.86, ior: 1.8, emissive: 0.15 },
    make: () => [
      facetGem({
        girdle: cushionPts(16, 0.46, 0.46, 4.5),
        scallop: 0.038,
        gh: 0.055,
        crown: [{ s: 0.56, h: 0.19 }],
        pav: [{ s: 0, h: 0.5 }],
      }),
    ],
    tilt: { rz: 0.1, rx: 0.46, ry: 0.3 },
  },
  // 8 Peridot — oval brilliant, lime
  {
    spec: { color: 0xa9e321, transmission: 0.88, ior: 1.65, emissive: 0.26 },
    make: () => [
      facetGem({
        girdle: ellipse(18, 0.54, 0.34),
        scallop: 0.034,
        gh: 0.05,
        crown: [{ s: 0.52, h: 0.16 }],
        pav: [{ s: 0, h: 0.42 }],
        keel: 0.16,
      }),
    ],
    tilt: { rz: 0.08, rx: 0.5, ry: 0.1 },
  },
  // 9 Opal — high cabochon, milky and iridescent
  {
    spec: {
      color: 0x2fc9b4, transmission: 0.16, ior: 1.45, emissive: 0.5,
      roughness: 0.14, iridescence: 1, sheen: 1, sheenColor: 0xff5ac8, env: 0.8,
    },
    make: () => {
      const dome = new THREE.SphereGeometry(0.44, 44, 24, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.scale(1, 0.68, 0.82);
      const bottom = new THREE.CircleGeometry(0.44, 44).rotateX(Math.PI / 2);
      bottom.scale(1, 1, 0.78);
      return [dome, bottom];
    },
  },
  // 10 Onyx — raw polished shard, jet black
  {
    spec: {
      color: 0x0d0d18, transmission: 0, ior: 1.6, emissive: 0.9,
      roughness: 0.04, metalness: 0.35,
    },
    make: () => {
      const shard = (r: number, h: number, t: Xf) => {
        const g = new THREE.CylinderGeometry(r * 0.62, r, h, 5, 1, false);
        g.translate(0, h / 2, 0);
        const c = cone(r * 0.62, h * 0.42, 5);
        c.translate(0, h * 1.21, 0);
        return [xf(g, t), xf(c, t)];
      };
      return [
        ...shard(0.24, 0.62, { rz: 0.08 }),
        ...shard(0.13, 0.34, { rz: -0.42, x: 0.26, y: 0.01 }),
        ...shard(0.1, 0.22, { rz: 0.46, rx: -0.2, x: -0.23, y: 0.01, z: 0.07 }),
      ];
    },
  },
  // 11 Rose Quartz — frosted rough cluster, blush pink
  {
    spec: { color: 0xff9ec4, transmission: 0.62, ior: 1.54, emissive: 0.3, roughness: 0.3 },
    make: () => [
      ...prismShard(0.19, 0.3, 0.16).map((g) => xf(g, { rz: 0.12 })),
      ...prismShard(0.15, 0.46, 0.2).map((g) => xf(g, { rz: -0.26, x: 0.2, y: 0.01, z: 0.06 })),
      ...prismShard(0.13, 0.22, 0.13).map((g) => xf(g, { rz: 0.44, x: -0.22, y: 0.01, z: -0.05 })),
      ...prismShard(0.11, 0.34, 0.14).map((g) => xf(g, { rz: 0.1, rx: 0.42, x: -0.02, y: 0.0, z: -0.2 })),
    ],
  },
  // 12 Turquoise — opaque kite, waxy teal
  {
    spec: {
      color: 0x11a894, transmission: 0, ior: 1.6, emissive: 0.3,
      roughness: 0.42, metalness: 0.15, env: 1.1,
    },
    make: () => [
      facetGem({
        girdle: [[0.62, 0], [0.04, 0.36], [-0.44, 0], [0.04, -0.36]],
        gh: 0.1,
        crown: [{ s: 0.44, h: 0.26 }],
        pav: [{ s: 0.44, h: 0.2 }],
      }),
    ],
    tilt: { rz: 0.05, rx: 0.4, ry: 0.16 },
  },
  // 13 Moonstone — polished orb with a cold adularescent sheen
  {
    spec: {
      color: 0x4f86ee, transmission: 0.3, ior: 1.52, emissive: 0.5,
      roughness: 0.06, iridescence: 0.95, sheen: 1, sheenColor: 0xdbe8ff, env: 1.1,
    },
    make: () => [ball(0.44, 48, 34)],
  },
  // 14 Diamond — princess cut, colourless fire
  {
    spec: {
      color: 0xffffff, transmission: 0.95, ior: 2.33, emissive: 0.3,
      iridescence: 0.4, attenuate: 4,
    },
    make: () => [
      facetGem({
        girdle: cutRect(0.42, 0.42, 0.07),
        scallop: 0.034,
        gh: 0.05,
        crown: [{ s: 0.6, h: 0.18 }],
        pav: [{ s: 0, h: 0.66 }],
      }),
    ],
    tilt: { rz: 0.06, rx: 0.44, ry: 0.22 },
  },
];

function gemParts(index: number): Part[] {
  const s = STONES[index];
  const m = stoneMat(String(index), s.spec);
  const parts = s.make().map((g) => P(g, m));
  if (s.tilt) for (const p of parts) xf(p.g, s.tilt);
  return parts;
}

// ===========================================================================
// Templates + public API
// ===========================================================================

function buildTemplate(theme: MemoryTheme, kind: number): THREE.Group {
  if (theme === 'chess') {
    const piece = CHESS_KINDS[kind % 5];
    const finish = Math.floor(kind / 5) as Finish;
    return ground(assemble(chessPiece(piece, finish)), 0.97, CHESS_SCALE);
  }
  if (theme === 'gems') {
    return ground(assemble(gemParts(kind)), 0.96);
  }
  return ground(assemble(COSMOS[kind]()), 0.98);
}

function templateFor(theme: MemoryTheme, kind: number): THREE.Group {
  const key = `${theme}:${kind}`;
  let t = templates.get(key);
  if (!t) {
    t = buildTemplate(theme, kind);
    templates.set(key, t);
  }
  return t;
}

export function buildArtifact(theme: MemoryTheme, kind: number, size: number): THREE.Group {
  const k = ((kind % KINDS_PER_THEME) + KINDS_PER_THEME) % KINDS_PER_THEME;
  // The returned group's own transform is left untouched so callers stay free
  // to scale/position it; the size lives on the inner clone.
  const group = new THREE.Group();
  const inner = templateFor(theme, k).clone(true);
  inner.scale.setScalar(size);
  group.add(inner);
  return group;
}

export function disposeArtifactCache(): void {
  for (const g of geoBin) g.dispose();
  for (const m of matBin) m.dispose();
  geoBin.length = 0;
  matBin.length = 0;
  matCache.clear();
  templates.clear();
}
