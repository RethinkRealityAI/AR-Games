// PLACEHOLDER chess scene — keeps the platform compiling while the full
// scene (Staunton lathe pieces, selection flow, move/capture animation) is
// built. Renders a checkered board and simple discs; taps select + move.

import * as THREE from 'three';
import type { GameScene, SceneContext } from '../../engine/sceneTypes';
import type { GameCore, Move } from '../../types';
import { chessLogic, ChessBoard, FILE, RANK } from './logic';

export function createChessScene(): GameScene {
  let ctx: SceneContext | null = null;
  let group: THREE.Group | null = null;
  let pieces: THREE.Group | null = null;
  let selected: number | null = null;
  const tiles: THREE.Mesh[] = [];
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  const track = <T extends THREE.BufferGeometry | THREE.Material>(x: T): T => {
    disposables.push(x);
    return x;
  };

  return {
    init(c: SceneContext) {
      ctx = c;
      group = new THREE.Group();
      c.root.add(group);
      const size = c.boardSize;
      const tile = size / 8;
      const geo = track(new THREE.BoxGeometry(tile * 0.96, tile * 0.12, tile * 0.96));
      for (let sq = 0; sq < 64; sq++) {
        const dark = (RANK(sq) + FILE(sq)) % 2 === 0;
        const mat = track(
          new THREE.MeshPhysicalMaterial({
            color: dark ? 0x1a2340 : 0x8fa8d8,
            roughness: 0.25,
            metalness: 0.1,
            transparent: true,
            opacity: 0.85,
          }),
        );
        const m = new THREE.Mesh(geo, mat);
        m.position.set((FILE(sq) - 3.5) * tile, 0, (3.5 - RANK(sq)) * tile);
        m.userData.square = sq;
        tiles.push(m);
        group.add(m);
      }
      pieces = new THREE.Group();
      pieces.position.y = tile * 0.12;
      group.add(pieces);
    },

    update(core: GameCore) {
      if (!ctx || !pieces) return;
      selected = null;
      while (pieces.children.length) pieces.remove(pieces.children[0]);
      const b = core.board as ChessBoard;
      const size = ctx.boardSize;
      const tile = size / 8;
      for (let sq = 0; sq < 64; sq++) {
        const p = b.squares[sq];
        if (!p) continue;
        const isKing = p[1] === 'K';
        const h = isKing ? tile * 1.1 : tile * 0.6;
        const geo = track(new THREE.CylinderGeometry(tile * 0.3, tile * 0.36, h, 20));
        const mat = track(
          new THREE.MeshPhysicalMaterial({
            color: p[0] === 'w' ? ctx.profiles[0].color : ctx.profiles[1].color,
            roughness: 0.2,
            metalness: 0.3,
          }),
        );
        const m = new THREE.Mesh(geo, mat);
        m.position.set((FILE(sq) - 3.5) * tile, h / 2, (3.5 - RANK(sq)) * tile);
        m.userData.square = sq;
        pieces.add(m);
      }
    },

    animate() {
      /* placeholder: no idle animation */
    },

    pickMove(raycaster: THREE.Raycaster, core: GameCore): Move | null {
      if (!group) return null;
      const hits = raycaster.intersectObjects(group.children, true);
      const hit = hits.find((h) => typeof h.object.userData.square === 'number');
      if (!hit) return null;
      const sq = hit.object.userData.square as number;
      const legal = chessLogic.legalMoves(core);
      if (selected !== null) {
        const mv = legal.find((m) => m.from === selected && m.to === sq);
        selected = null;
        if (mv) return mv.promotion ? { ...mv, promotion: 'q' } : mv;
      }
      if (legal.some((m) => m.from === sq)) selected = sq;
      return null;
    },

    dispose() {
      if (ctx && group) ctx.root.remove(group);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      tiles.length = 0;
      group = null;
      pieces = null;
      ctx = null;
    },
  };
}
