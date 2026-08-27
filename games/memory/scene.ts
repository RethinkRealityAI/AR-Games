// PLACEHOLDER Quantum Pairs scene — keeps the platform building and playable
// while the full scene (materialisation shader, match celebration, constellation
// claim-marks and the Nova Pulse spectacle) is built. Exported name is frozen.

import * as THREE from 'three';
import type { GameScene, SceneContext } from '../../engine/sceneTypes';
import type { GameCore, Move } from '../../types';
import { HIDDEN, type MemoryBoard } from './logic';
import { buildArtifact, disposeArtifactCache } from './artifacts';

export function createMemoryScene(): GameScene {
  let ctx: SceneContext | null = null;
  let group: THREE.Group | null = null;
  let tileLayer: THREE.Group | null = null;
  let artLayer: THREE.Group | null = null;
  let tileSize = 0.1;
  let cols = 6;
  let rows = 3;
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  const track = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const posFor = (tile: number) => {
    const c = tile % cols;
    const r = Math.floor(tile / cols);
    return new THREE.Vector3(
      (c - (cols - 1) / 2) * tileSize,
      0,
      (r - (rows - 1) / 2) * tileSize,
    );
  };

  const layout = (b: MemoryBoard) => {
    cols = b.cols;
    rows = b.rows;
    const span = Math.max(cols, rows);
    tileSize = (ctx!.boardSize / span) * 0.94;
  };

  return {
    init(c: SceneContext) {
      ctx = c;
      group = new THREE.Group();
      c.root.add(group);
      tileLayer = new THREE.Group();
      artLayer = new THREE.Group();
      group.add(tileLayer, artLayer);
    },

    update(core: GameCore) {
      if (!ctx || !tileLayer || !artLayer) return;
      const b = core.board as MemoryBoard;
      layout(b);

      while (tileLayer.children.length) tileLayer.remove(tileLayer.children[0]);
      while (artLayer.children.length) artLayer.remove(artLayer.children[0]);

      const geo = track(new THREE.BoxGeometry(tileSize * 0.9, tileSize * 0.1, tileSize * 0.9));
      const shown = new Set<number>([...b.up, ...(b.pulse ?? [])]);

      for (let t = 0; t < b.owners.length; t++) {
        const owner = b.owners[t];
        const color =
          owner === null ? 0x1a2340 : new THREE.Color(ctx.profiles[owner].color).getHex();
        const mat = track(
          new THREE.MeshPhysicalMaterial({
            color,
            roughness: 0.25,
            metalness: 0.1,
            transparent: true,
            opacity: owner === null ? 0.85 : 0.95,
          }),
        );
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(posFor(t));
        mesh.userData.tile = t;
        tileLayer.add(mesh);

        // Face-up (or claimed) tiles show their artifact.
        const kind = b.deck[t];
        if ((shown.has(t) || owner !== null) && kind !== HIDDEN) {
          const art = buildArtifact(b.theme, kind, tileSize * 0.8);
          art.position.copy(posFor(t));
          art.position.y = tileSize * 0.08;
          if (owner !== null) art.scale.setScalar(0.55);
          artLayer.add(art);
        }
      }
    },

    animate(timeMs: number) {
      if (!artLayer) return;
      const spin = (timeMs / 1000) * 0.8;
      for (const a of artLayer.children) a.rotation.y = spin;
    },

    pickMove(raycaster: THREE.Raycaster, core: GameCore): Move | null {
      if (!tileLayer) return null;
      const b = core.board as MemoryBoard;
      if (b.phase !== 'play') return null;
      const hit = raycaster
        .intersectObjects(tileLayer.children, true)
        .find((h) => typeof h.object.userData.tile === 'number');
      if (!hit) return null;
      const tile = hit.object.userData.tile as number;
      if (b.owners[tile] !== null) return null;
      if (!b.pendingClear && b.up.includes(tile)) return null;
      return { tile };
    },

    dispose() {
      if (ctx && group) ctx.root.remove(group);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      disposeArtifactCache();
      group = null;
      tileLayer = null;
      artLayer = null;
      ctx = null;
    },
  };
}
