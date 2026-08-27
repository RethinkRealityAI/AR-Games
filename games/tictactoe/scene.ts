// ============================================================================
// Cosmic Tac-Toe — 3D board.
// Ported and upgraded from the legacy ArBoard: glass tiles with neon wireframe
// borders that tint to the active player, a galaxy particle disc beneath, and
// six procedural avatar models as pieces — astronaut / drone / crystal /
// rocket / saturn / comet. ASTRONAUT, DRONE and CRYSTAL are swapped for
// premium Higgsfield GLBs once those finish loading (see services/models.ts);
// the other three ship procedural-only, which is their intended final look.
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

  // -- ROCKET: finned retro rocket with a glowing engine ring ---------------

  const createRocket = (slot: PlayerSlot): THREE.Group => {
    const color = colorOf(slot);
    const group = new THREE.Group();

    const hull = mat(
      'rocket-hull',
      () =>
        new THREE.MeshPhysicalMaterial({
          color: 0xeef2f8,
          roughness: 0.22,
          metalness: 0.35,
          clearcoat: 1,
          clearcoatRoughness: 0.12,
          envMapIntensity: 0.8,
        }),
    );
    const accent = mat(
      `rocket-accent-${slot}`,
      () =>
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.28,
          metalness: 0.5,
          emissive: color,
          emissiveIntensity: 0.55,
        }),
    );
    const port = mat(
      'rocket-port',
      () => new THREE.MeshPhysicalMaterial({ color: 0x0b1020, roughness: 0.06, metalness: 0.9 }),
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

    // Everything sits in a slow spinner so `obj.lookAt()` on the outer group
    // (which orients pieces toward the board centre) survives.
    const spinner = new THREE.Group();
    group.add(spinner);

    // Lathed retro silhouette: flared skirt, slim barrel, long ogive nose that
    // comes to an actual point.
    const body = new THREE.Mesh(
      geo('rocket-body', () =>
        new THREE.LatheGeometry(
          [
            new THREE.Vector2(0.0, 0.022),
            new THREE.Vector2(0.0225, 0.022),
            new THREE.Vector2(0.0255, 0.034),
            new THREE.Vector2(0.024, 0.076),
            new THREE.Vector2(0.0215, 0.095),
            new THREE.Vector2(0.0155, 0.117),
            new THREE.Vector2(0.008, 0.138),
            new THREE.Vector2(0.0026, 0.152),
            new THREE.Vector2(0.0, 0.156),
          ],
          30,
        ),
      ),
      hull,
    );
    spinner.add(body);

    // Accent shoulder band, and a second thin one at the tip, so the colour
    // reads as livery rather than a cone glued on top.
    const bandGeo = geo('rocket-band', () =>
      new THREE.TorusGeometry(0.0243, 0.0032, 8, 30).rotateX(Math.PI / 2),
    );
    const band = new THREE.Mesh(bandGeo, accent);
    band.position.y = 0.068;
    spinner.add(band);

    const tipBand = new THREE.Mesh(bandGeo, accent);
    tipBand.position.y = 0.113;
    tipBand.scale.setScalar(0.7);
    spinner.add(tipBand);

    const tip = new THREE.Mesh(
      geo('rocket-tip', () => new THREE.ConeGeometry(0.008, 0.026, 20)),
      accent,
    );
    tip.position.y = 0.148;
    spinner.add(tip);

    // Porthole: a dark lens set into the hull, with a bright bezel.
    const hole = new THREE.Mesh(
      geo('rocket-port', () => new THREE.SphereGeometry(0.0085, 16, 12)),
      port,
    );
    hole.position.set(0, 0.09, 0.019);
    hole.scale.set(1, 1, 0.45);
    spinner.add(hole);

    const bezel = new THREE.Mesh(
      geo('rocket-bezel', () => new THREE.TorusGeometry(0.0085, 0.0016, 6, 22)),
      accent,
    );
    bezel.position.set(0, 0.09, 0.0195);
    spinner.add(bezel);

    // Three swept-back fins, extruded from a 2D profile in the XY plane and
    // spun around the hull.
    const finGeo = geo('rocket-fin', () => {
      const shape = new THREE.Shape();
      shape.moveTo(0, 0.058);
      shape.lineTo(0.03, -0.002);
      shape.lineTo(0.03, 0.014);
      shape.lineTo(0.004, 0.066);
      shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth: 0.005, bevelEnabled: false });
      g.translate(0, 0, -0.0025);
      return g;
    });
    for (let i = 0; i < 3; i++) {
      const pivot = new THREE.Group();
      pivot.rotation.y = (i * Math.PI * 2) / 3;
      const fin = new THREE.Mesh(finGeo, accent);
      fin.position.set(0.017, 0.024, 0);
      pivot.add(fin);
      spinner.add(pivot);
    }

    // Engine ring flares wider than the skirt so it stays visible from the
    // usual top-down camera, backed by a glow disc washing the tile.
    const ring = new THREE.Mesh(
      geo('rocket-engine', () => new THREE.TorusGeometry(0.0295, 0.0038, 8, 34).rotateX(Math.PI / 2)),
      glow,
    );
    ring.position.y = 0.019;
    spinner.add(ring);

    const wash = new THREE.Mesh(
      geo('rocket-wash', () => new THREE.CircleGeometry(0.05, 32).rotateX(-Math.PI / 2)),
      mat(
        `rocket-wash-${slot}`,
        () =>
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.2,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
      ),
    );
    wash.position.y = 0.003;
    group.add(wash);

    const plume = new THREE.Mesh(
      geo('rocket-plume', () => new THREE.ConeGeometry(0.016, 0.042, 20, 1, true).rotateX(Math.PI)),
      glow,
    );
    plume.position.y = 0.006;
    spinner.add(plume);

    group.userData.spin = (t: number) => {
      spinner.rotation.y = t * 0.00055;
      const pulse = 0.55 + Math.sin(t / 200) * 0.3;
      ring.scale.setScalar(1 + Math.sin(t / 260) * 0.05);
      plume.scale.set(1, 0.75 + pulse * 0.5, 1);
      wash.scale.setScalar(0.9 + pulse * 0.25);
    };
    return group;
  };

  // -- SATURN: glossy planet with a tilted translucent ring -----------------

  const createSaturn = (slot: PlayerSlot): THREE.Group => {
    const color = colorOf(slot);
    const group = new THREE.Group();

    const planetMat = mat(
      `saturn-planet-${slot}`,
      () =>
        new THREE.MeshPhysicalMaterial({
          color,
          roughness: 0.16,
          metalness: 0.15,
          clearcoat: 1,
          clearcoatRoughness: 0.06,
          emissive: color,
          emissiveIntensity: 0.16,
          envMapIntensity: 1.1,
        }),
    );
    const ringMat = mat(
      `saturn-ring-${slot}`,
      () =>
        new THREE.MeshPhysicalMaterial({
          color,
          roughness: 0.1,
          metalness: 0.05,
          transmission: 0.72,
          thickness: 0.12,
          ior: 1.3,
          transparent: true,
          opacity: 0.62,
          emissive: color,
          emissiveIntensity: 0.25,
          side: THREE.DoubleSide,
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

    // The whole system is tilted once, then the planet and rings spin on the
    // tilted axis — the same trick the real thing uses.
    const tilt = new THREE.Group();
    tilt.rotation.z = 0.42;
    tilt.rotation.x = 0.1;
    tilt.position.y = 0.076;
    group.add(tilt);

    const planet = new THREE.Mesh(
      geo('saturn-planet', () => new THREE.SphereGeometry(0.046, 32, 24)),
      planetMat,
    );
    tilt.add(planet);

    // Faint equatorial banding — much dimmer than the ring highlights, so it
    // reads as cloud belts rather than a string of lights.
    const bandMat = mat(
      `saturn-band-${slot}`,
      () =>
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
    );
    const bandGeo = geo('saturn-band', () =>
      new THREE.TorusGeometry(0.0455, 0.0022, 6, 44).rotateX(Math.PI / 2),
    );
    for (const y of [0.016, -0.013]) {
      const b = new THREE.Mesh(bandGeo, bandMat);
      b.position.y = y;
      b.scale.setScalar(Math.sqrt(Math.max(0.04, 1 - (y / 0.046) ** 2)) + 0.01);
      tilt.add(b);
    }

    const ring = new THREE.Mesh(
      geo('saturn-ring', () => new THREE.RingGeometry(0.062, 0.098, 72, 1).rotateX(-Math.PI / 2)),
      ringMat,
    );
    tilt.add(ring);

    // Bright inner edge so the ring catches a rim light even head-on.
    const edge = new THREE.Mesh(
      geo('saturn-ring-edge', () => new THREE.TorusGeometry(0.0625, 0.0018, 6, 60).rotateX(-Math.PI / 2)),
      glow,
    );
    tilt.add(edge);

    const shepherd = new THREE.Mesh(
      geo('saturn-ring-outer', () => new THREE.TorusGeometry(0.0975, 0.0014, 6, 60).rotateX(-Math.PI / 2)),
      glow,
    );
    tilt.add(shepherd);

    group.userData.spin = (t: number) => {
      planet.rotation.y = t * 0.00042;
      ring.rotation.y = t * 0.00016;
      edge.rotation.y = -t * 0.00024;
      shepherd.rotation.y = t * 0.00031;
    };
    return group;
  };

  // -- COMET: crystalline core with a swept particle + geometry tail --------

  const createComet = (slot: PlayerSlot): THREE.Group => {
    const color = colorOf(slot);
    const group = new THREE.Group();

    const coreMat = mat(
      `comet-core-${slot}`,
      () =>
        new THREE.MeshPhysicalMaterial({
          color,
          metalness: 0.1,
          roughness: 0.05,
          transmission: 0.7,
          thickness: 0.4,
          ior: 1.6,
          emissive: color,
          emissiveIntensity: 0.5,
          transparent: true,
          clearcoat: 1,
          clearcoatRoughness: 0.04,
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
    const dust = mat(
      `comet-dust-${slot}`,
      () =>
        new THREE.PointsMaterial({
          color,
          size: 0.0055,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.85,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
    );

    // Faceted core, stretched along the direction of travel (+Z, which
    // `obj.lookAt()` points at the board centre).
    const core = new THREE.Mesh(
      geo('comet-core', () => new THREE.IcosahedronGeometry(0.033, 0)),
      coreMat,
    );
    core.position.y = 0.09;
    core.scale.set(0.9, 0.9, 1.18);
    group.add(core);

    const coma = new THREE.Mesh(
      geo('comet-coma', () => new THREE.SphereGeometry(0.019, 16, 12)),
      glow,
    );
    coma.position.y = 0.09;
    group.add(coma);

    /**
     * Two nested groups: `sway` animates, `rig` holds the fixed sweep. The
     * tail is built along local -Y and then laid almost flat by the rig, so
     * it streams backwards behind the core instead of hanging under it —
     * which, from the usual top-down camera, is the whole difference between
     * a comet and a jellyfish.
     */
    const sway = new THREE.Group();
    sway.position.y = 0.09;
    group.add(sway);

    const rig = new THREE.Group();
    // Past horizontal: streams back along -Z and rises, so the tail clears the
    // tile instead of sprawling across its neighbours.
    rig.rotation.x = 2.02;
    sway.add(rig);

    // Thin tapered streaks fanning out within the tail plane.
    const streakGeo = geo('comet-streak', () =>
      new THREE.ConeGeometry(0.0105, 0.105, 12, 1, true).translate(0, -0.052, 0),
    );
    const streaks: THREE.Mesh[] = [];
    const fan = [0, 0.26, -0.26];
    for (let i = 0; i < fan.length; i++) {
      const s = new THREE.Mesh(streakGeo, glow);
      s.rotation.z = fan[i];
      const k = i === 0 ? 1 : 0.72;
      s.scale.set(k, k, k);
      rig.add(s);
      streaks.push(s);
    }

    // Ion dust: a deterministic cone of points streaming along local -Y.
    const dustPts = new THREE.Points(
      geo('comet-dust', () => {
        const count = 170;
        const pos = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          // Golden-angle spiral keeps the spread even without Math.random,
          // so both players' comets are identical and the geometry cacheable.
          const u = (i + 0.5) / count;
          const along = Math.pow(u, 0.72) * 0.13;
          const ang = i * 2.39996;
          const spread = 0.005 + along * 0.24;
          pos[i * 3] = Math.cos(ang) * spread * (0.4 + u);
          pos[i * 3 + 1] = -along;
          pos[i * 3 + 2] = Math.sin(ang) * spread * (0.4 + u);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        return g;
      }),
      dust,
    );
    rig.add(dustPts);

    group.userData.spin = (t: number) => {
      core.rotation.y = t * 0.0014;
      core.rotation.x = t * 0.0007;
      // Gentle sway, as if the tail trails a shifting solar wind.
      sway.rotation.y = Math.sin(t / 1600) * 0.3;
      sway.rotation.z = Math.sin(t / 2100) * 0.1;
      for (let i = 0; i < streaks.length; i++) {
        streaks[i].scale.y = (i === 0 ? 1 : 0.72) * (0.86 + Math.sin(t / 260 + i * 1.7) * 0.16);
      }
      dust.opacity = 0.62 + Math.sin(t / 210) * 0.22;
      coma.scale.setScalar(0.9 + Math.sin(t / 300) * 0.12);
    };
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
    // Premium GLB when one exists for this avatar and has finished loading;
    // ROCKET / SATURN / COMET have no GLB — procedural is their final look.
    const premium = getPieceModel(type);
    if (premium) return buildPremiumPiece(slot, premium);
    if (type === 'DRONE') return createDrone(slot);
    if (type === 'CRYSTAL') return createCrystal(slot);
    if (type === 'ROCKET') return createRocket(slot);
    if (type === 'SATURN') return createSaturn(slot);
    if (type === 'COMET') return createComet(slot);
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
