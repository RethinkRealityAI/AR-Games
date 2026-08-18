// ============================================================================
// Nebula Four — 3D board.
//
// An upright translucent deep-blue glass slab with 42 real circular holes
// (a single extruded THREE.Shape with holes → one draw call), rimmed by an
// InstancedMesh of 42 neon tori. Discs are glossy clearcoat cylinders that fall
// with gravity easing and a small bounce.
//
// Board indexing follows games/connect4/logic.ts: row 0 is the BOTTOM row.
// ============================================================================

import * as THREE from 'three';
import type { GameScene, SceneContext } from '../../engine/sceneTypes';
import type { PlayerProfile, PlayerSlot } from '../../types';
import { COLS, ROWS, dropRow, type C4Board } from './logic';
import { sound } from '../../services/sound';

const GOLD = 0xfcd34d;

// Time-based drop so the animation reads identically at 15 fps or 120 fps.
const FALL_MS = 430;
const BOUNCE_MS = 190;

interface DiscData {
  index: number;
  slot: PlayerSlot;
  startY: number;
  targetY: number;
  /** -1 until the first animate frame assigns the clock. */
  spawnAt: number;
  landed: boolean;
  thocked: boolean;
}

export function createConnect4Scene(): GameScene {
  let ctx: SceneContext | null = null;

  const geoCache = new Map<string, THREE.BufferGeometry>();
  const matCache = new Map<string, THREE.Material>();

  const pickBoxes: THREE.Mesh[] = [];
  const discs = new Map<number, THREE.Mesh>();
  let galaxy: THREE.Points | null = null;
  let frameMat: THREE.MeshPhysicalMaterial | null = null;
  let rimMesh: THREE.InstancedMesh | null = null;
  let ghost: THREE.Mesh | null = null;
  let turnLight: THREE.PointLight | null = null;
  let winBeam: THREE.Mesh | null = null;
  let winCells: number[] | null = null;

  let S = 0.62; // board width
  let pitch = S / COLS;
  let discR = pitch * 0.4;
  let discT = pitch * 0.22;
  let holeR = pitch * 0.42;
  let baseY = 0.03; // bottom of the playfield above the stand
  let lastTime = 0;

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

  const colorOf = (slot: PlayerSlot): number => {
    const profile: PlayerProfile | undefined = ctx?.profiles[slot];
    return new THREE.Color(profile?.color ?? (slot === 0 ? '#22d3ee' : '#fbbf24')).getHex();
  };

  const colX = (col: number) => (col - (COLS - 1) / 2) * pitch;
  const rowY = (row: number) => baseY + (row + 0.5) * pitch;

  /** Galaxy particle disc, shared visual language with tic-tac-toe. */
  const createGalaxy = (): THREE.Points => {
    const count = 1400;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const inside = new THREE.Color(0x22d3ee);
    const outside = new THREE.Color(0xe879f9);
    const maxR = S * 2.2;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const radius = Math.random() * maxR;
      const spin = radius * 4;
      const branch = (i % 3) * ((Math.PI * 2) / 3);
      pos[i3] = Math.cos(branch + spin) * radius;
      pos[i3 + 1] = (Math.random() - 0.5) * 0.14;
      pos[i3 + 2] = Math.sin(branch + spin) * radius;
      const mixed = inside.clone().lerp(outside, radius / maxR);
      col[i3] = mixed.r;
      col[i3 + 1] = mixed.g;
      col[i3 + 2] = mixed.b;
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
      opacity: 0.75,
    });
    matCache.set('galaxy', m);
    return new THREE.Points(g, m);
  };

  /** Rounded rectangle slab with 42 circular holes punched through it. */
  const createFrameGeometry = (): THREE.ExtrudeGeometry => {
    const w = S;
    const h = ROWS * pitch;
    const r = pitch * 0.28;
    const x0 = -w / 2;
    const y0 = baseY;

    const shape = new THREE.Shape();
    shape.moveTo(x0 + r, y0);
    shape.lineTo(x0 + w - r, y0);
    shape.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    shape.lineTo(x0 + w, y0 + h - r);
    shape.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
    shape.lineTo(x0 + r, y0 + h);
    shape.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
    shape.lineTo(x0, y0 + r);
    shape.quadraticCurveTo(x0, y0, x0 + r, y0);

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const hole = new THREE.Path();
        hole.absarc(colX(col), rowY(row), holeR, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
    }

    const g = new THREE.ExtrudeGeometry(shape, {
      depth: discT * 1.9,
      bevelEnabled: true,
      bevelThickness: pitch * 0.02,
      bevelSize: pitch * 0.02,
      bevelSegments: 1,
      curveSegments: 18,
    });
    g.translate(0, 0, -discT * 0.95);
    return g;
  };

  const clearWinBeam = () => {
    if (winBeam && ctx) {
      ctx.root.remove(winBeam);
      winBeam.geometry.dispose();
      winBeam = null;
    }
    winCells = null;
  };

  const createWinBeam = (line: number[]) => {
    if (!ctx || line.length < 2) return;
    clearWinBeam();
    const first = line[0];
    const last = line[line.length - 1];
    const a = new THREE.Vector3(colX(first % COLS), rowY(Math.floor(first / COLS)), 0);
    const b = new THREE.Vector3(colX(last % COLS), rowY(Math.floor(last / COLS)), 0);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const len = a.distanceTo(b) + pitch * 0.9;
    const g = new THREE.CylinderGeometry(pitch * 0.06, pitch * 0.06, len, 12, 1, true).rotateX(
      Math.PI / 2,
    );
    const m = mat(
      'winbeam',
      () =>
        new THREE.MeshBasicMaterial({
          color: GOLD,
          transparent: true,
          opacity: 0.8,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
    );
    const beam = new THREE.Mesh(g, m);
    beam.position.copy(mid);
    beam.position.z = discT * 0.9;
    beam.lookAt(b.x, b.y, discT * 0.9);
    ctx.root.add(beam);
    winBeam = beam;
    winCells = line;
  };

  const discMaterial = (slot: PlayerSlot) =>
    mat(
      `disc-${slot}`,
      () => {
        const c = colorOf(slot);
        return new THREE.MeshPhysicalMaterial({
          color: c,
          metalness: 0.55,
          roughness: 0.22,
          clearcoat: 1,
          clearcoatRoughness: 0.08,
          emissive: c,
          emissiveIntensity: 0.28,
          iridescence: 0.4,
          iridescenceIOR: 1.4,
        });
      },
    );

  const rimMaterial = (slot: PlayerSlot) =>
    mat(
      `disc-rim-${slot}`,
      () =>
        new THREE.MeshBasicMaterial({
          color: colorOf(slot),
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
    );

  const addDisc = (index: number, slot: PlayerSlot, animated: boolean) => {
    if (!ctx || discs.has(index)) return;
    const row = Math.floor(index / COLS);
    const col = index % COLS;

    const mesh = new THREE.Mesh(
      geo('disc', () => new THREE.CylinderGeometry(discR, discR, discT, 40).rotateX(Math.PI / 2)),
      discMaterial(slot),
    );
    const rim = new THREE.Mesh(
      geo('disc-rim', () =>
        new THREE.TorusGeometry(discR * 0.98, discT * 0.13, 6, 40),
      ),
      rimMaterial(slot),
    );
    mesh.add(rim);

    const target = rowY(row);
    const startY = animated ? rowY(ROWS) + pitch * 1.4 : target;
    mesh.position.set(colX(col), startY, 0);
    const data: DiscData = {
      index,
      slot,
      startY,
      targetY: target,
      spawnAt: -1,
      landed: !animated,
      thocked: !animated,
    };
    mesh.userData.disc = data;
    ctx.root.add(mesh);
    discs.set(index, mesh);
  };

  const removeDisc = (index: number) => {
    const m = discs.get(index);
    if (!m || !ctx) return;
    ctx.root.remove(m);
    discs.delete(index);
  };

  return {
    init(c) {
      ctx = c;
      S = c.boardSize;
      pitch = S / COLS;
      discR = pitch * 0.4;
      discT = pitch * 0.22;
      holeR = pitch * 0.43;
      baseY = pitch * 0.42;

      // Galaxy disc beneath the stand.
      galaxy = createGalaxy();
      galaxy.position.y = -S * 0.28;
      c.root.add(galaxy);

      // Glass stand.
      const stand = new THREE.Mesh(
        geo('stand', () => new THREE.BoxGeometry(S * 1.08, baseY * 0.75, pitch * 1.5)),
        mat(
          'stand',
          () =>
            new THREE.MeshPhysicalMaterial({
              color: 0x0b1a33,
              metalness: 0.2,
              roughness: 0.1,
              transmission: 0.6,
              thickness: 0.05,
              transparent: true,
              opacity: 0.85,
              clearcoat: 1,
            }),
        ),
      );
      stand.position.y = baseY * 0.375;
      c.root.add(stand);

      // Halo ring on the ground plane.
      const halo = new THREE.Mesh(
        geo('halo', () => new THREE.TorusGeometry(S * 0.62, S * 0.005, 8, 72).rotateX(-Math.PI / 2)),
        mat(
          'halo',
          () =>
            new THREE.MeshBasicMaterial({
              color: 0x38bdf8,
              transparent: true,
              opacity: 0.28,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
        ),
      );
      c.root.add(halo);

      // The perforated glass slab — one mesh, one draw call.
      frameMat = mat(
        'frame',
        () =>
          new THREE.MeshPhysicalMaterial({
            color: 0x123a6b,
            metalness: 0.15,
            roughness: 0.1,
            transmission: 0.72,
            thickness: 0.08,
            transparent: true,
            opacity: 0.9,
            clearcoat: 1,
            clearcoatRoughness: 0.06,
            ior: 1.45,
            side: THREE.DoubleSide,
          }),
      );
      const frame = new THREE.Mesh(geo('frame', createFrameGeometry), frameMat);
      c.root.add(frame);

      // Neon rims around every hole — one InstancedMesh.
      const rimGeo = geo('rim', () => new THREE.TorusGeometry(holeR, pitch * 0.018, 5, 28));
      const rimMat = mat(
        'rim',
        () =>
          new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
      );
      rimMesh = new THREE.InstancedMesh(rimGeo, rimMat, ROWS * COLS * 2);
      const m4 = new THREE.Matrix4();
      let n = 0;
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          for (const z of [discT * 1.0, -discT * 1.0]) {
            m4.makeTranslation(colX(col), rowY(row), z);
            rimMesh.setMatrixAt(n++, m4);
          }
        }
      }
      rimMesh.instanceMatrix.needsUpdate = true;
      c.root.add(rimMesh);

      // Side posts.
      const postGeo = geo('post', () =>
        new THREE.BoxGeometry(pitch * 0.14, ROWS * pitch + baseY, pitch * 0.6),
      );
      const postMat = mat(
        'post',
        () =>
          new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            metalness: 0.75,
            roughness: 0.3,
          }),
      );
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(sx * (S / 2 + pitch * 0.07), (ROWS * pitch + baseY) / 2, 0);
        ctx.root.add(post);
      }

      // Ghost preview disc.
      ghost = new THREE.Mesh(
        geo('disc', () => new THREE.CylinderGeometry(discR, discR, discT, 40).rotateX(Math.PI / 2)),
        mat(
          'ghost',
          () =>
            new THREE.MeshBasicMaterial({
              color: 0xffffff,
              transparent: true,
              opacity: 0.28,
              depthWrite: false,
            }),
        ),
      );
      ghost.visible = false;
      c.root.add(ghost);

      // Invisible per-column pick boxes covering the whole column height.
      pickBoxes.length = 0;
      const pickGeo = geo('pick', () =>
        new THREE.BoxGeometry(pitch * 0.98, ROWS * pitch + pitch, pitch * 1.2),
      );
      const pickMat = mat(
        'pick',
        () => new THREE.MeshBasicMaterial({ visible: false, depthWrite: false }),
      );
      for (let col = 0; col < COLS; col++) {
        const box = new THREE.Mesh(pickGeo, pickMat);
        box.position.set(colX(col), baseY + (ROWS * pitch) / 2 + pitch * 0.2, 0);
        box.userData = { column: col };
        c.root.add(box);
        pickBoxes.push(box);
      }

      turnLight = new THREE.PointLight(0xffffff, 1.2, S * 5);
      turnLight.position.set(0, ROWS * pitch * 0.9, S * 0.7);
      c.root.add(turnLight);
    },

    update(core, prev) {
      if (!ctx) return;
      const board = core.board as C4Board;
      const reset = prev === null || core.moveCount < (prev?.moveCount ?? 0);
      if (reset) {
        for (const idx of Array.from(discs.keys())) removeDisc(idx);
        clearWinBeam();
      }

      // A single new disc relative to prev animates; a bulk sync (join mid-game,
      // reconnect) snaps into place.
      const animateDrop = !reset && prev !== null && core.moveCount === prev.moveCount + 1;

      for (let i = 0; i < ROWS * COLS; i++) {
        const v = board[i];
        if (v !== null && v !== undefined) {
          if (!discs.has(i)) addDisc(i, v, animateDrop);
        } else if (discs.has(i)) {
          removeDisc(i);
        }
      }

      if (core.winningCells && core.winningCells.length >= 2) {
        if (!winBeam) createWinBeam(core.winningCells);
      } else if (winBeam) {
        clearWinBeam();
      }

      if (ghost && core.winner !== null) ghost.visible = false;
    },

    animate(t, currentSlot, winner) {
      const dt = lastTime ? Math.min(0.05, (t - lastTime) / 1000) : 0.016;
      lastTime = t;

      if (galaxy) galaxy.rotation.y += dt * 0.08;

      const target = new THREE.Color(colorOf(currentSlot));
      if (turnLight) {
        turnLight.intensity = 1.0 + Math.sin(t / 400) * 0.4;
        turnLight.color.lerp(target, 0.06);
      }
      if (rimMesh) {
        const m = rimMesh.material as THREE.MeshBasicMaterial;
        m.color.lerp(target, 0.05);
        m.opacity = winner !== null ? 0.3 : 0.4 + Math.sin(t / 850) * 0.14;
      }

      discs.forEach((mesh, index) => {
        const d = mesh.userData.disc as DiscData | undefined;
        if (!d) return;
        if (!d.landed) {
          if (d.spawnAt < 0) d.spawnAt = t;
          const e = t - d.spawnAt;
          if (e < FALL_MS) {
            // Quadratic ease-in — reads as gravity.
            const k = (e / FALL_MS) ** 2;
            mesh.position.y = d.startY + (d.targetY - d.startY) * k;
          } else if (e < FALL_MS + BOUNCE_MS) {
            if (!d.thocked) {
              d.thocked = true;
              sound.playDrop();
            }
            const b = (e - FALL_MS) / BOUNCE_MS;
            mesh.position.y =
              d.targetY + Math.sin(b * Math.PI) * (d.targetY - d.startY) * -0.075 * (1 - b);
          } else {
            if (!d.thocked) {
              d.thocked = true;
              sound.playDrop();
            }
            mesh.position.y = d.targetY;
            d.landed = true;
          }
        }

        const isWinner = !!winCells?.includes(index);
        if (isWinner) {
          const s = 1 + Math.sin(t / 165) * 0.08;
          mesh.scale.setScalar(s);
          mesh.rotation.z = Math.sin(t / 500) * 0.12;
        } else if (mesh.scale.x !== 1) {
          mesh.scale.setScalar(1);
          mesh.rotation.z = 0;
        }
      });

      if (winBeam) {
        const m = winBeam.material as THREE.MeshBasicMaterial;
        m.opacity = 0.55 + Math.sin(t / 190) * 0.3;
      }
    },

    pickMove(raycaster, core) {
      if (core.winner !== null) return null;
      const hits = raycaster.intersectObjects(pickBoxes, false);
      if (hits.length === 0) return null;
      const column = hits[0].object.userData.column as number | undefined;
      if (typeof column !== 'number') return null;
      if (dropRow(core.board as C4Board, column) < 0) return null;
      return { column };
    },

    hover(raycaster, core) {
      if (!ghost) return;
      if (!raycaster || core.winner !== null) {
        ghost.visible = false;
        return;
      }
      const hits = raycaster.intersectObjects(pickBoxes, false);
      if (hits.length === 0) {
        ghost.visible = false;
        return;
      }
      const column = hits[0].object.userData.column as number;
      const board = core.board as C4Board;
      const row = dropRow(board, column);
      if (row < 0) {
        ghost.visible = false;
        return;
      }
      ghost.position.set(colX(column), rowY(row), 0);
      (ghost.material as THREE.MeshBasicMaterial).color.set(colorOf(core.currentSlot));
      ghost.visible = true;
    },

    dispose() {
      if (ctx) {
        for (const child of [...ctx.root.children]) ctx.root.remove(child);
      }
      discs.clear();
      pickBoxes.length = 0;
      rimMesh?.dispose();
      rimMesh = null;
      winBeam?.geometry.dispose();
      winBeam = null;
      winCells = null;
      galaxy = null;
      ghost = null;
      frameMat = null;
      turnLight = null;
      geoCache.forEach((g) => g.dispose());
      matCache.forEach((m) => m.dispose());
      geoCache.clear();
      matCache.clear();
      ctx = null;
      lastTime = 0;
    },
  } satisfies GameScene;
}

export default createConnect4Scene;
