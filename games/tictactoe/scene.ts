// ============================================================================
// Cosmic Tac-Toe — 3D board.
// Ported and upgraded from the legacy ArBoard: glass tiles with neon wireframe
// borders that tint to the active player, a galaxy particle disc beneath, and
// the three avatar models (astronaut / drone / crystal) as pieces.
// ============================================================================

import * as THREE from 'three';
import type { GameScene, SceneContext } from '../../engine/sceneTypes';
import type { PlayerProfile, PlayerSlot } from '../../types';
import type { TttBoard } from './logic';
import { getPieceModel, prefetchPieceModel } from '../../services/models';

const GOLD = 0xfcd34d;

interface PieceData {
  slot: PlayerSlot;
  index: number;
  spawnAt: number;
  baseScale: number;
  spin?: (t: number, obj: THREE.Object3D) => void;
}

export function createTicTacToeScene(): GameScene {
  let ctx: SceneContext | null = null;

  const geoCache = new Map<string, THREE.BufferGeometry>();
  const matCache = new Map<string, THREE.Material>();

  const tiles: THREE.Mesh[] = [];
  const pieces = new Map<number, THREE.Object3D>();
  let galaxy: THREE.Points | null = null;
  let turnLight: THREE.PointLight | null = null;
  let borderMat: THREE.LineBasicMaterial | null = null;
  let hoverRing: THREE.Mesh | null = null;
  let winBeam: THREE.Mesh | null = null;
  let winCells: number[] | null = null;

  let S = 0.5; // board footprint
  let spacing = S / 3;
  let tileSize = spacing * 0.85;
  let pieceScale = 1;
  let lastTime = 0;

  // -- caches ---------------------------------------------------------------

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

  // -- geometry helpers -----------------------------------------------------

  const cellPos = (index: number, y = 0): THREE.Vector3 => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    return new THREE.Vector3((col - 1) * spacing, y, (row - 1) * spacing);
  };

  /** Legacy procedural galaxy disc — a three-branch spiral of additive points. */
  const createGalaxy = (): THREE.Points => {
    const count = 1400;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const inside = new THREE.Color(0x22d3ee);
    const outside = new THREE.Color(0xe879f9);
    const maxR = S * 2.5;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const radius = Math.random() * maxR;
      const spin = radius * 4;
      const branch = (i % 3) * ((Math.PI * 2) / 3);
      pos[i3] = Math.cos(branch + spin) * radius + (Math.random() - 0.5) * 0.02;
      pos[i3 + 1] = (Math.random() - 0.5) * 0.15;
      pos[i3 + 2] = Math.sin(branch + spin) * radius + (Math.random() - 0.5) * 0.02;

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

  // -- avatar models (ported from legacy ArBoard) ---------------------------

  const createDrone = (slot: PlayerSlot): THREE.Group => {
    const color = colorOf(slot);
    const group = new THREE.Group();
    const shell = mat(
      'drone-shell',
      () =>
        new THREE.MeshPhysicalMaterial({
          color: 0xdbe6f5,
          roughness: 0.18,
          metalness: 0.9,
          clearcoat: 1,
          clearcoatRoughness: 0.1,
        }),
    );
    const accent = mat(
      `drone-accent-${slot}`,
      () =>
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.3,
          metalness: 0.4,
          emissive: color,
          emissiveIntensity: 0.8,
        }),
    );
    const glow = mat(
      `glow-${slot}`,
      () =>
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
    );

    const core = new THREE.Mesh(geo('drone-core', () => new THREE.SphereGeometry(0.036, 22, 18)), shell);
    core.position.y = 0.075;
    group.add(core);

    const visor = new THREE.Mesh(
      geo('drone-visor', () =>
        new THREE.SphereGeometry(0.0365, 22, 14, 0, Math.PI * 2, Math.PI * 0.36, Math.PI * 0.22),
      ),
      accent,
    );
    visor.position.y = 0.075;
    group.add(visor);

    const ring = new THREE.Mesh(
      geo('drone-ring', () => new THREE.TorusGeometry(0.056, 0.0055, 10, 40).rotateX(Math.PI / 2)),
      shell,
    );
    ring.position.y = 0.075;
    ring.rotation.x = 0.22;
    group.add(ring);

    const halo = new THREE.Mesh(
      geo('drone-halo', () => new THREE.TorusGeometry(0.047, 0.0028, 6, 32).rotateX(Math.PI / 2)),
      glow,
    );
    halo.position.y = 0.075;
    group.add(halo);

    group.userData.spin = (t: number) => {
      ring.rotation.z = t * 0.0016;
      halo.rotation.z = -t * 0.0026;
    };
    return group;
  };

  const createCrystal = (slot: PlayerSlot): THREE.Group => {
    const color = colorOf(slot);
    const group = new THREE.Group();
    const m = mat(
      `crystal-${slot}`,
      () =>
        new THREE.MeshPhysicalMaterial({
          color,
          metalness: 0.1,
          roughness: 0.08,
          transmission: 0.65,
          thickness: 0.5,
          emissive: color,
          emissiveIntensity: 0.35,
          transparent: true,
        }),
    );
    const crystal = new THREE.Mesh(geo('crystal', () => new THREE.OctahedronGeometry(0.062, 0)), m);
    crystal.position.y = 0.085;
    group.add(crystal);

    const shard = new THREE.Mesh(geo('crystal-s', () => new THREE.OctahedronGeometry(0.026, 0)), m);
    shard.position.set(0.035, 0.04, 0.02);
    group.add(shard);

    group.userData.spin = (t: number) => {
      crystal.rotation.y = t * 0.0018;
      crystal.rotation.z = t * 0.0009;
      shard.rotation.y = -t * 0.0026;
    };
    return group;
  };

  const createAstronaut = (slot: PlayerSlot): THREE.Group => {
    const color = colorOf(slot);
    const group = new THREE.Group();
    const suit = mat(
      'astro-suit',
      () => new THREE.MeshStandardMaterial({ color: 0xe8edf5, roughness: 0.55, metalness: 0.05 }),
    );
    const accent = mat(
      `astro-accent-${slot}`,
      () =>
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.35,
          metalness: 0.25,
          emissive: color,
          emissiveIntensity: 0.25,
        }),
    );
    const visor = mat(
      'astro-visor',
      () => new THREE.MeshStandardMaterial({ color: 0x0b1020, roughness: 0.08, metalness: 0.95 }),
    );

    const body = new THREE.Mesh(geo('astro-body', () => new THREE.BoxGeometry(0.06, 0.08, 0.042)), suit);
    body.position.y = 0.06;
    group.add(body);

    const pack = new THREE.Mesh(geo('astro-pack', () => new THREE.BoxGeometry(0.05, 0.06, 0.03)), accent);
    pack.position.set(0, 0.06, -0.032);
    group.add(pack);

    const head = new THREE.Mesh(geo('astro-head', () => new THREE.SphereGeometry(0.036, 20, 16)), suit);
    head.position.y = 0.122;
    group.add(head);

    const vis = new THREE.Mesh(
      geo('astro-visor', () =>
        new THREE.SphereGeometry(0.017, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2.4).rotateX(-Math.PI / 2),
      ),
      visor,
    );
    vis.position.set(0, 0.122, 0.03);
    group.add(vis);

    const limb = geo('astro-limb', () => new THREE.CapsuleGeometry(0.011, 0.03, 4, 8));
    const armL = new THREE.Mesh(limb, accent);
    armL.position.set(-0.041, 0.072, 0);
    armL.rotation.z = Math.PI / 4;
    group.add(armL);
    const armR = new THREE.Mesh(limb, accent);
    armR.position.set(0.041, 0.072, 0);
    armR.rotation.z = -Math.PI / 4;
    group.add(armR);
    const legL = new THREE.Mesh(limb, accent);
    legL.position.set(-0.018, 0.024, 0);
    group.add(legL);
    const legR = new THREE.Mesh(limb, accent);
    legR.position.set(0.018, 0.024, 0);
    group.add(legR);

    return group;
  };

  /**
   * Premium Higgsfield GLB piece: an independent clone of the cached template
   * with a glowing base ring in the player's color so identity stays readable.
   * The ring's material is created per-piece (it is tinted), tracked in
   * premiumMats for disposal.
   */
  const premiumMats: THREE.Material[] = [];
  const buildPremiumPiece = (slot: PlayerSlot, template: THREE.Group): THREE.Group => {
    const group = new THREE.Group();
    group.add(template.clone(true));
    const ringMat = new THREE.MeshBasicMaterial({
      color: colorOf(slot),
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    premiumMats.push(ringMat);
    const ring = new THREE.Mesh(
      geo('premium-ring', () => new THREE.TorusGeometry(0.052, 0.005, 8, 40).rotateX(-Math.PI / 2)),
      ringMat,
    );
    ring.position.y = 0.004;
    group.add(ring);
    group.userData.spin = (t: number) => {
      ring.rotation.y = t / 900;
      const pulse = 0.6 + Math.sin(t / 420) * 0.2;
      ringMat.opacity = pulse;
    };
    return group;
  };

  const buildPiece = (slot: PlayerSlot): THREE.Group => {
    const type = ctx?.profiles[slot]?.avatarId ?? 'ASTRONAUT';
    const premium = getPieceModel(type);
    if (premium) return buildPremiumPiece(slot, premium);
    if (type === 'DRONE') return createDrone(slot);
    if (type === 'CRYSTAL') return createCrystal(slot);
    return createAstronaut(slot);
  };

  const addPiece = (index: number, slot: PlayerSlot) => {
    if (!ctx || pieces.has(index)) return;
    const obj = buildPiece(slot);
    const p = cellPos(index);
    obj.position.copy(p);
    obj.lookAt(0, 0, 0);
    obj.scale.setScalar(0.0001);
    const data: PieceData = {
      slot,
      index,
      spawnAt: -1,
      baseScale: pieceScale,
      spin: obj.userData.spin,
    };
    obj.userData.piece = data;
    ctx.root.add(obj);
    pieces.set(index, obj);
  };

  const removePiece = (index: number) => {
    const obj = pieces.get(index);
    if (!obj || !ctx) return;
    ctx.root.remove(obj);
    pieces.delete(index);
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
    const a = cellPos(line[0], 0.14 * pieceScale);
    const b = cellPos(line[line.length - 1], 0.14 * pieceScale);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const len = a.distanceTo(b) + tileSize;
    const g = new THREE.CylinderGeometry(0.009, 0.009, len, 10, 1, true).rotateX(Math.PI / 2);
    const m = mat(
      'winbeam',
      () =>
        new THREE.MeshBasicMaterial({
          color: GOLD,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
    );
    const beam = new THREE.Mesh(g, m);
    beam.position.copy(mid);
    beam.lookAt(b);
    ctx.root.add(beam);
    winBeam = beam;
    winCells = line;
  };

  // -- GameScene ------------------------------------------------------------

  return {
    init(c) {
      ctx = c;
      S = c.boardSize;
      spacing = S / 3;
      tileSize = spacing * 0.85;
      pieceScale = (S / 0.5) * 0.92;

      // Kick off premium Higgsfield model loads; pieces spawned before a model
      // arrives fall back to the procedural builds.
      prefetchPieceModel(c.profiles[0].avatarId);
      prefetchPieceModel(c.profiles[1].avatarId);

      // Galaxy disc beneath the board.
      galaxy = createGalaxy();
      galaxy.position.y = -S * 0.6;
      c.root.add(galaxy);

      // Halo ring for grounding.
      const halo = new THREE.Mesh(
        geo('halo', () => new THREE.TorusGeometry(S * 0.62, S * 0.005, 8, 72).rotateX(-Math.PI / 2)),
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
      halo.position.y = -0.004;
      c.root.add(halo);

      // Pulsing turn light above the board.
      turnLight = new THREE.PointLight(0xffffff, 1.2, S * 4);
      turnLight.position.set(0, S, 0);
      c.root.add(turnLight);

      // Tiles.
      const tileGeo = geo('tile', () => new THREE.BoxGeometry(tileSize, S * 0.03, tileSize));
      const tileMat = mat(
        'tile',
        () =>
          new THREE.MeshPhysicalMaterial({
            color: 0x1b2b47,
            metalness: 0.05,
            roughness: 0.28,
            transmission: 0.6,
            thickness: 0.04,
            ior: 1.35,
            transparent: true,
            opacity: 0.9,
            clearcoat: 0.7,
            clearcoatRoughness: 0.28,
            envMapIntensity: 0.55,
            side: THREE.DoubleSide,
          }),
      );
      // Clean rectangular neon outline (EdgesGeometry avoids the ugly
      // triangle diagonals a wireframe would draw on a box).
      const edgeGeo = geo('tile-edges', () => new THREE.EdgesGeometry(tileGeo));
      borderMat = mat(
        'border',
        () =>
          new THREE.LineBasicMaterial({
            color: 0x22d3ee,
            transparent: true,
            opacity: 0.75,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
      );

      tiles.length = 0;
      for (let i = 0; i < 9; i++) {
        const tile = new THREE.Mesh(tileGeo, tileMat);
        tile.position.copy(cellPos(i));
        tile.userData = { index: i, isTile: true };
        const border = new THREE.LineSegments(edgeGeo, borderMat);
        border.scale.setScalar(1.004);
        tile.add(border);
        c.root.add(tile);
        tiles.push(tile);
      }

      // Hover highlight.
      hoverRing = new THREE.Mesh(
        geo('hover', () =>
          new THREE.RingGeometry(tileSize * 0.42, tileSize * 0.5, 32).rotateX(-Math.PI / 2),
        ),
        mat(
          'hover',
          () =>
            new THREE.MeshBasicMaterial({
              color: 0xffffff,
              transparent: true,
              opacity: 0.55,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              side: THREE.DoubleSide,
            }),
        ),
      );
      hoverRing.visible = false;
      hoverRing.position.y = S * 0.026;
      c.root.add(hoverRing);
    },

    update(core, prev) {
      if (!ctx) return;
      const board = core.board as TttBoard;
      const reset = prev === null || core.moveCount < (prev?.moveCount ?? 0);

      if (reset) {
        for (const idx of Array.from(pieces.keys())) removePiece(idx);
        clearWinBeam();
      }

      for (let i = 0; i < 9; i++) {
        const v = board[i];
        if (v !== null && v !== undefined) {
          if (!pieces.has(i)) addPiece(i, v);
        } else if (pieces.has(i)) {
          removePiece(i);
        }
      }

      if (core.winningCells && core.winningCells.length >= 2) {
        if (!winBeam) createWinBeam(core.winningCells);
      } else if (winBeam) {
        clearWinBeam();
      }

      if (hoverRing && core.winner !== null) hoverRing.visible = false;
    },

    animate(t, currentSlot, winner) {
      const dt = lastTime ? Math.min(0.05, (t - lastTime) / 1000) : 0.016;
      lastTime = t;

      if (galaxy) galaxy.rotation.y += dt * 0.09;

      const target = new THREE.Color(colorOf(currentSlot));
      if (turnLight) {
        turnLight.intensity = 1.0 + Math.sin(t / 380) * 0.45;
        turnLight.color.lerp(target, 0.06);
      }
      if (borderMat) {
        borderMat.color.lerp(target, 0.06);
        borderMat.opacity = winner !== null ? 0.45 : 0.7 + Math.sin(t / 900) * 0.2;
      }

      pieces.forEach((obj, index) => {
        const d = obj.userData.piece as PieceData | undefined;
        if (!d) return;
        if (d.spawnAt < 0) d.spawnAt = t;
        const age = (t - d.spawnAt) / 380;
        // Overshooting ease-out for a springy spawn.
        const grow = age >= 1 ? 1 : 1 - Math.pow(1 - age, 3) * (1 - 0.12 * Math.sin(age * Math.PI));
        const isWinner = !!winCells?.includes(index);
        const pulse = isWinner ? 1 + Math.sin(t / 160) * 0.09 : 1;
        obj.scale.setScalar(d.baseScale * grow * pulse);
        obj.position.y = Math.sin(t / 620 + index) * 0.005 * pieceScale;
        d.spin?.(t, obj);
      });

      if (winBeam) {
        const m = winBeam.material as THREE.MeshBasicMaterial;
        m.opacity = 0.6 + Math.sin(t / 190) * 0.3;
        winBeam.rotation.z += dt * 1.2;
      }
    },

    pickMove(raycaster, core) {
      if (core.winner !== null) return null;
      const hits = raycaster.intersectObjects(tiles, false);
      if (hits.length === 0) return null;
      const index = hits[0].object.userData.index as number | undefined;
      if (typeof index !== 'number') return null;
      const board = core.board as TttBoard;
      if (board[index] !== null) return null;
      return { cell: index };
    },

    hover(raycaster, core) {
      if (!hoverRing) return;
      if (!raycaster || core.winner !== null) {
        hoverRing.visible = false;
        return;
      }
      const hits = raycaster.intersectObjects(tiles, false);
      const index = hits.length ? (hits[0].object.userData.index as number) : -1;
      const board = core.board as TttBoard;
      if (index >= 0 && board[index] === null) {
        const p = cellPos(index, S * 0.026);
        hoverRing.position.copy(p);
        hoverRing.visible = true;
        (hoverRing.material as THREE.MeshBasicMaterial).color.set(colorOf(core.currentSlot));
      } else {
        hoverRing.visible = false;
      }
    },

    dispose() {
      if (ctx) {
        for (const child of [...ctx.root.children]) ctx.root.remove(child);
      }
      pieces.clear();
      tiles.length = 0;
      winBeam?.geometry.dispose();
      winBeam = null;
      winCells = null;
      galaxy = null;
      turnLight = null;
      borderMat = null;
      hoverRing = null;
      geoCache.forEach((g) => g.dispose());
      matCache.forEach((m) => m.dispose());
      geoCache.clear();
      matCache.clear();
      premiumMats.forEach((m) => m.dispose());
      premiumMats.length = 0;
      ctx = null;
      lastTime = 0;
    },
  } satisfies GameScene;
}

export default createTicTacToeScene;
