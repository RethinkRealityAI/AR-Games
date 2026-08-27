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
// ============================================================================

import * as THREE from 'three';
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
      'Rocket', 'Ringworld', 'Comet', 'Helmet', 'Crystal',
      'Satellite', 'Moon', 'Starburst', 'Saucer', 'Singularity',
      'Spiral', 'Nebula', 'Asteroid', 'Beacon', 'Observatory',
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

// ---------------------------------------------------------------------------
// PLACEHOLDER IMPLEMENTATION
//
// Distinct, readable shapes so the game is playable and the scene can be built
// against a real API. Replaced by the sculpted library — the exports above are
// the contract and must not change.
// ---------------------------------------------------------------------------

const geometries: THREE.BufferGeometry[] = [];
const materials: THREE.Material[] = [];

const track = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
  if ((x as THREE.BufferGeometry).isBufferGeometry) geometries.push(x as THREE.BufferGeometry);
  else materials.push(x as THREE.Material);
  return x;
};

const cache = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material }>();

/** Evenly spaced, well-separated hues so neighbouring kinds never read alike. */
function hueFor(kind: number): number {
  return ((kind * 137.508) % 360) / 360;
}

function primitiveFor(kind: number, r: number): THREE.BufferGeometry {
  switch (kind % 5) {
    case 0:
      return new THREE.IcosahedronGeometry(r, 0);
    case 1:
      return new THREE.ConeGeometry(r * 0.85, r * 2, 6);
    case 2:
      return new THREE.TorusGeometry(r * 0.7, r * 0.28, 10, 24);
    case 3:
      return new THREE.OctahedronGeometry(r, 0);
    default:
      return new THREE.DodecahedronGeometry(r, 0);
  }
}

export function buildArtifact(theme: MemoryTheme, kind: number, size: number): THREE.Group {
  const k = ((kind % KINDS_PER_THEME) + KINDS_PER_THEME) % KINDS_PER_THEME;
  const key = `${theme}:${k}:${size.toFixed(4)}`;

  let entry = cache.get(key);
  if (!entry) {
    const r = size * 0.3;
    const geo = track(primitiveFor(k, r));
    const color = new THREE.Color().setHSL(hueFor(k), theme === 'gems' ? 0.75 : 0.55, 0.6);
    const mat = track(
      new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.18,
        metalness: 0.15,
        clearcoat: 0.6,
        transmission: theme === 'gems' ? 0.35 : 0,
        emissive: color.clone().multiplyScalar(0.25),
      }),
    );
    entry = { geo, mat };
    cache.set(key, entry);
  }

  const group = new THREE.Group();
  const mesh = new THREE.Mesh(entry.geo, entry.mat);
  // Rest the artifact on y = 0 regardless of which primitive it uses.
  entry.geo.computeBoundingBox();
  const box = entry.geo.boundingBox!;
  mesh.position.y = -box.min.y;
  group.add(mesh);
  return group;
}

export function disposeArtifactCache(): void {
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  geometries.length = 0;
  materials.length = 0;
  cache.clear();
}
