// ============================================================================
// SceneHost — the Three.js / WebXR host.
//
// Three presentation paths share one renderer, scene graph and game scene:
//
//  1. FALLBACK "holo-table" (always available, shown first): the board floats
//     over a galaxy particle disc in a soft dark environment. Pointer-drag
//     orbits, wheel/pinch zooms, tap/click plays. A slow idle auto-rotate
//     pauses for 3 s after any interaction.
//
//  2. WEBXR AR (when navigator.xr supports immersive-ar): hit-test reticle,
//     tap to place, dom-overlay UI, 1-finger rotate / 2-finger pinch-scale,
//     transparent page background. These behaviours are ported from the
//     battle-tested legacy ArBoard.
//
//  3. AR LITE (no WebXR, but a phone with a camera and motion sensors — i.e.
//     iOS Safari, which still has no immersive-ar in 2026): the rear camera
//     feed is painted behind the transparent canvas and the camera's rotation
//     is driven by `deviceorientation`. No world tracking, so the board is
//     anchored to a virtual floor 1.4 m below the viewer; the viewer only
//     rotates (3-DoF). Gestures match the WebXR path. See ./arLite.
//
// The host owns placement, camera, gestures and raycasting; each game's
// GameScene owns everything inside `root`.
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { GameScene, GameSceneFactory, SceneContext } from './sceneTypes';
import type { GameCore, GameId, Move, PlayerProfile, PlayerSlot } from '../types';
import { createTicTacToeScene } from '../games/tictactoe/scene';
import { createConnect4Scene } from '../games/connect4/scene';
import { createChessScene } from '../games/chess/scene';
import { createMemoryScene } from '../games/memory/scene';
import { sound } from '../services/sound';
import { Icon, rgba } from '../components/GlassUI';
import {
  AR_LITE_FLOOR_DROP,
  AR_LITE_FOV,
  AR_LITE_SCALE_MAX,
  AR_LITE_SCALE_MIN,
  ArLiteError,
  DeviceOrientationTracker,
  createCameraVideoElement,
  detectArTier,
  projectToVirtualFloor,
  startArLiteSensors,
  stopStream,
  teardownCameraVideo,
  type ArTier,
} from './arLite';

// -- registry ---------------------------------------------------------------

const SCENE_FACTORIES: Record<GameId, GameSceneFactory> = {
  tictactoe: createTicTacToeScene,
  connect4: createConnect4Scene,
  chess: createChessScene,
  memory: createMemoryScene,
};

/** Board footprint + fallback-camera framing per game. */
const FRAMING: Record<GameId, { boardSize: number; targetY: number; fitRadius: number; phi: number }> =
  {
    tictactoe: { boardSize: 0.5, targetY: 0.045, fitRadius: 0.3, phi: 0.8 },
    connect4: { boardSize: 0.62, targetY: 0.3, fitRadius: 0.36, phi: 1.34 },
    chess: { boardSize: 0.56, targetY: 0.06, fitRadius: 0.36, phi: 0.9 },
    memory: { boardSize: 0.58, targetY: 0.05, fitRadius: 0.38, phi: 0.86 },
  };

const FOV = 55;
const AUTO_ROTATE = 0.05; // rad/s
const IDLE_DELAY = 3000; // ms of stillness before auto-rotate resumes

export interface SceneHostProps {
  gameId: GameId;
  core: GameCore;
  prevCore: GameCore | null;
  profiles: [PlayerProfile, PlayerProfile];
  currentSlot: PlayerSlot;
  winner: GameCore['winner'];
  onMove: (move: Move) => void;
  /** Input gate — taps are ignored while false. */
  enabled: boolean;
  onPlacedChange?: (placed: boolean) => void;
  onArActiveChange?: (active: boolean) => void;
  /** Bump to ask for a fresh AR placement (the "reposition" control). */
  repositionNonce?: number;
}

const SceneHost: React.FC<SceneHostProps> = ({
  gameId,
  core,
  prevCore,
  profiles,
  currentSlot,
  winner,
  onMove,
  enabled,
  onPlacedChange,
  onArActiveChange,
  repositionNonce = 0,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [arTier, setArTier] = useState<ArTier | null>(null);
  const [xrActive, setXrActive] = useState(false);
  const [liteActive, setLiteActive] = useState(false);
  const [liteStarting, setLiteStarting] = useState(false);
  const [arNotice, setArNotice] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  const [ready, setReady] = useState(false);

  /** Either AR path is compositing over the real world. */
  const arActive = xrActive || liteActive;

  // --- stale-closure-safe mirrors of every prop the render loop reads ------
  const coreRef = useRef(core);
  const enabledRef = useRef(enabled);
  const onMoveRef = useRef(onMove);
  const currentSlotRef = useRef(currentSlot);
  const winnerRef = useRef(winner);
  const placedRef = useRef(false);
  const lockRef = useRef(false); // input lock until core changes
  const lockTimerRef = useRef<number | null>(null);

  const releaseLock = useCallback(() => {
    lockRef.current = false;
    if (lockTimerRef.current !== null) {
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    coreRef.current = core;
    releaseLock();
  }, [core, releaseLock]);
  useEffect(() => {
    enabledRef.current = enabled;
    // Input becoming available again always clears a stale lock (e.g. a move
    // the server rejected, which never produces a new core).
    if (enabled) releaseLock();
  }, [enabled, releaseLock]);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);
  useEffect(() => {
    currentSlotRef.current = currentSlot;
  }, [currentSlot]);
  useEffect(() => {
    winnerRef.current = winner;
  }, [winner]);

  // --- Three.js refs -------------------------------------------------------
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const anchorRef = useRef<THREE.Group | null>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const backdropRef = useRef<THREE.Points | null>(null);
  const reticleRef = useRef<THREE.Mesh | null>(null);
  const controllerRef = useRef<THREE.XRTargetRaySpace | null>(null);
  const rimLightsRef = useRef<[THREE.PointLight, THREE.PointLight] | null>(null);
  const envRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const gameSceneRef = useRef<GameScene | null>(null);
  const sceneCtxRef = useRef<SceneContext | null>(null);
  const gameIdRef = useRef<GameId>(gameId);

  // --- XR refs -------------------------------------------------------------
  const sessionRef = useRef<XRSession | null>(null);
  const hitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const hitTestRequestedRef = useRef(false);
  const isMountedRef = useRef(true);

  // --- AR Lite refs --------------------------------------------------------
  const liteActiveRef = useRef(false);
  const liteStartingRef = useRef(false);
  const liteVideoRef = useRef<HTMLVideoElement | null>(null);
  const trackerRef = useRef<DeviceOrientationTracker | null>(null);
  const liteQuatRef = useRef(new THREE.Quaternion());
  const noticeTimerRef = useRef<number | null>(null);

  /** Non-blocking, self-dismissing notice (permission denied, no camera…). */
  const showNotice = useCallback((message: string) => {
    if (!isMountedRef.current) return;
    setArNotice(message);
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      if (isMountedRef.current) setArNotice(null);
    }, 4200);
  }, []);

  // --- camera / gesture state ---------------------------------------------
  const orbitRef = useRef({ theta: 0, phi: 0.78, dist: 1.4, baseDist: 1.4, zoom: 1, targetY: 0 });
  const lastInteractRef = useRef(0);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ x: number; y: number; moved: number; t: number } | null>(null);
  const pinchRef = useRef({ dist: 0, zoom: 1, scale: 1 });
  const hoverNdcRef = useRef<THREE.Vector2 | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());

  // ------------------------------------------------------------------------
  // Camera framing
  // ------------------------------------------------------------------------

  const frameCamera = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const cfg = FRAMING[gameIdRef.current];
    const vHalf = THREE.MathUtils.degToRad(FOV) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const minHalf = Math.max(0.12, Math.min(vHalf, hHalf));
    const dist = (cfg.fitRadius / Math.sin(minHalf)) * 1.06;
    orbitRef.current.baseDist = dist;
    orbitRef.current.targetY = cfg.targetY;
  }, []);

  const applyCamera = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const o = orbitRef.current;
    const d = o.baseDist * o.zoom;
    const sinP = Math.sin(o.phi);
    camera.position.set(
      Math.sin(o.theta) * sinP * d,
      o.targetY + Math.cos(o.phi) * d,
      Math.cos(o.theta) * sinP * d,
    );
    camera.lookAt(0, o.targetY, 0);
  }, []);

  // ------------------------------------------------------------------------
  // Raycasting / picking
  // ------------------------------------------------------------------------

  const raycasterFrom = useCallback((ndc: THREE.Vector2): THREE.Raycaster | null => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!renderer || !camera) return null;
    const rc = raycasterRef.current;
    rc.setFromCamera(ndc, camera);
    return rc;
  }, []);

  const ndcFromClient = (clientX: number, clientY: number): THREE.Vector2 =>
    new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );

  /**
   * AR Lite placement: intersect the tap ray with the virtual floor. There is
   * no hit-test, so the "surface" is simply a horizontal plane a fixed drop
   * below the viewer's eye.
   */
  const placeBoardLite = useCallback(
    (clientX: number, clientY: number) => {
      const anchor = anchorRef.current;
      const camera = cameraRef.current;
      const root = rootRef.current;
      if (!anchor || !camera || !root) return;
      const rc = raycasterFrom(ndcFromClient(clientX, clientY));
      if (!rc) return;

      const pos = projectToVirtualFloor(rc.ray, camera.position.y - AR_LITE_FLOOR_DROP);
      anchor.position.copy(pos);
      // Face the board towards the viewer, who never leaves the origin.
      const camPos = new THREE.Vector3();
      camera.getWorldPosition(camPos);
      anchor.rotation.set(0, Math.atan2(camPos.x - pos.x, camPos.z - pos.z), 0);
      anchor.scale.setScalar(1);

      root.rotation.set(0, 0, 0);
      root.scale.setScalar(1);
      root.visible = true;
      if (reticleRef.current) reticleRef.current.visible = false;

      placedRef.current = true;
      setPlaced(true);
      sound.playMove();
    },
    [raycasterFrom],
  );

  const handleTap = useCallback(
    (clientX: number, clientY: number) => {
      // Placement comes before the turn gate: in AR Lite the tap that anchors
      // the board must work even when it is not your move. (The WebXR path
      // gets this for free — placement arrives on the XR `select` event.)
      if (liteActiveRef.current && !placedRef.current) {
        placeBoardLite(clientX, clientY);
        return;
      }
      if (lockRef.current || !enabledRef.current) return;
      const scene = gameSceneRef.current;
      if (!scene || !placedRef.current) return;
      const rc = raycasterFrom(ndcFromClient(clientX, clientY));
      if (!rc) return;
      const move = scene.pickMove(rc, coreRef.current);
      if (move) {
        lockRef.current = true;
        // Failsafe: never leave the board permanently unresponsive.
        if (lockTimerRef.current !== null) clearTimeout(lockTimerRef.current);
        lockTimerRef.current = window.setTimeout(() => {
          lockRef.current = false;
          lockTimerRef.current = null;
        }, 2500);
        onMoveRef.current(move);
      }
    },
    [raycasterFrom, placeBoardLite],
  );

  // ------------------------------------------------------------------------
  // Gestures (unified pointer events: mouse, touch and AR dom-overlay taps)
  // ------------------------------------------------------------------------

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const touch = () => {
      lastInteractRef.current = performance.now();
    };

    const onPointerDown = (e: PointerEvent) => {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      touch();
      sound.resume();
      if (pointersRef.current.size === 1) {
        dragRef.current = { x: e.clientX, y: e.clientY, moved: 0, t: performance.now() };
      } else if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()];
        pinchRef.current.dist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchRef.current.zoom = orbitRef.current.zoom;
        pinchRef.current.scale = rootRef.current?.scale.x ?? 1;
        dragRef.current = null;
      }
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      // AR Lite behaves like the WebXR path: gestures move the *board*, never
      // the camera (which belongs to the gyro).
      const arMode = !!rendererRef.current?.xr.isPresenting || liteActiveRef.current;
      const prev = pointersRef.current.get(e.pointerId);

      // Desktop hover highlight when no button is held.
      if (!prev && e.pointerType === 'mouse') {
        hoverNdcRef.current = arMode ? null : ndcFromClient(e.clientX, e.clientY);
        return;
      }
      if (!prev) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      touch();

      if (pointersRef.current.size >= 2) {
        const [a, b] = [...pointersRef.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchRef.current.dist > 0) {
          const ratio = dist / pinchRef.current.dist;
          if (arMode && rootRef.current) {
            const [lo, hi] = liteActiveRef.current
              ? [AR_LITE_SCALE_MIN, AR_LITE_SCALE_MAX]
              : [0.2, 3];
            const s = THREE.MathUtils.clamp(pinchRef.current.scale * ratio, lo, hi);
            rootRef.current.scale.setScalar(s);
          } else {
            orbitRef.current.zoom = THREE.MathUtils.clamp(
              pinchRef.current.zoom / ratio,
              0.45,
              2.4,
            );
          }
        }
        dragRef.current = null;
        return;
      }

      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      d.x = e.clientX;
      d.y = e.clientY;

      if (arMode) {
        // AR: 1-finger horizontal drag spins the placed board.
        if (rootRef.current && placedRef.current) rootRef.current.rotation.y += dx * 0.005;
      } else {
        const o = orbitRef.current;
        o.theta -= dx * 0.0065;
        o.phi = THREE.MathUtils.clamp(o.phi + dy * 0.0055, 0.22, 1.47);
      }
    };

    const endPointer = (e: PointerEvent) => {
      const d = dragRef.current;
      const wasSingle = pointersRef.current.size === 1;
      pointersRef.current.delete(e.pointerId);
      touch();
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (pointersRef.current.size === 0) {
        pinchRef.current.dist = 0;
        if (wasSingle && d && d.moved < 14 && performance.now() - d.t < 500) {
          handleTap(e.clientX, e.clientY);
        }
        dragRef.current = null;
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (rendererRef.current?.xr.isPresenting || liteActiveRef.current) return;
      e.preventDefault();
      touch();
      const o = orbitRef.current;
      o.zoom = THREE.MathUtils.clamp(o.zoom * (1 + Math.sign(e.deltaY) * 0.09), 0.45, 2.4);
    };

    const onLeave = () => {
      hoverNdcRef.current = null;
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endPointer);
      el.removeEventListener('pointercancel', endPointer);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
    };
  }, [handleTap]);

  // ------------------------------------------------------------------------
  // AR placement (XR select)
  // ------------------------------------------------------------------------

  const placeBoard = useCallback(() => {
    const reticle = reticleRef.current;
    const anchor = anchorRef.current;
    const camera = cameraRef.current;
    const root = rootRef.current;
    if (!reticle || !anchor || !camera || !root || !reticle.visible) return;

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    reticle.matrix.decompose(pos, quat, scl);

    anchor.position.copy(pos);
    // Face the board towards whoever placed it.
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    anchor.rotation.set(0, Math.atan2(camPos.x - pos.x, camPos.z - pos.z), 0);
    anchor.scale.setScalar(1);

    root.rotation.set(0, 0, 0);
    root.scale.setScalar(1);
    root.visible = true;
    reticle.visible = false;

    placedRef.current = true;
    setPlaced(true);
    sound.playMove();
  }, []);

  const placeBoardRef = useRef(placeBoard);
  useEffect(() => {
    placeBoardRef.current = placeBoard;
  }, [placeBoard]);

  // ------------------------------------------------------------------------
  // Mount: build renderer + scene graph, run the loop
  // ------------------------------------------------------------------------

  useEffect(() => {
    isMountedRef.current = true;
    const container = containerRef.current;
    if (!container || rendererRef.current) return;

    // AR capability probe: real WebXR, else camera+gyro AR Lite, else holo only.
    void detectArTier().then((tier) => {
      if (isMountedRef.current) setArTier(tier);
    });

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      FOV,
      window.innerWidth / window.innerHeight,
      0.01,
      60,
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // --- environment (gives glass / clearcoat something to reflect) ------
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    pmrem.dispose();
    envRTRef.current = envRT;

    // --- lighting -------------------------------------------------------
    scene.add(new THREE.AmbientLight(0x8fa8ff, 0.55));
    const hemi = new THREE.HemisphereLight(0x86e6ff, 0x120a24, 0.7);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2.5, 5, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x7dd3fc, 0.5);
    fill.position.set(-3, 2, -2);
    scene.add(fill);

    const rim0 = new THREE.PointLight(0x22d3ee, 2.2, 6, 2);
    rim0.position.set(-1.1, 0.6, -0.9);
    scene.add(rim0);
    const rim1 = new THREE.PointLight(0xfbbf24, 2.2, 6, 2);
    rim1.position.set(1.1, 0.6, -0.9);
    scene.add(rim1);
    rimLightsRef.current = [rim0, rim1];

    // --- deep-space backdrop (fallback only) -----------------------------
    const starCount = 900;
    const starPos = new Float32Array(starCount * 3);
    const starCol = new Float32Array(starCount * 3);
    const tintA = new THREE.Color(0xa5f3fc);
    const tintB = new THREE.Color(0xc4b5fd);
    for (let i = 0; i < starCount; i++) {
      const i3 = i * 3;
      const r = 14 + Math.random() * 16;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      starPos[i3] = r * Math.sin(ph) * Math.cos(th);
      starPos[i3 + 1] = r * Math.cos(ph);
      starPos[i3 + 2] = r * Math.sin(ph) * Math.sin(th);
      const c = tintA.clone().lerp(tintB, Math.random());
      starCol[i3] = c.r;
      starCol[i3 + 1] = c.g;
      starCol[i3 + 2] = c.b;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
    const backdrop = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        size: 0.12,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    scene.add(backdrop);
    backdropRef.current = backdrop;

    // --- placement reticle (AR) ------------------------------------------
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.075, 0.095, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);
    reticleRef.current = reticle;

    // --- anchor / root ----------------------------------------------------
    const anchor = new THREE.Group();
    scene.add(anchor);
    anchorRef.current = anchor;

    const root = new THREE.Group();
    anchor.add(root);
    rootRef.current = root;

    // Fallback view is live immediately — no AR prompt required.
    placedRef.current = true;
    setPlaced(true);

    // --- XR controller for the placement tap ------------------------------
    const controller = renderer.xr.getController(0);
    const onSelect = () => {
      if (!isMountedRef.current) return;
      if (!placedRef.current) placeBoardRef.current();
    };
    controller.addEventListener('select', onSelect);
    scene.add(controller);
    controllerRef.current = controller;

    // --- resize -----------------------------------------------------------
    const onResize = () => {
      const r = rendererRef.current;
      const c = cameraRef.current;
      if (!r || !c || r.xr.isPresenting) return;
      c.aspect = window.innerWidth / window.innerHeight;
      c.updateProjectionMatrix();
      r.setSize(window.innerWidth, window.innerHeight);
      frameCamera();
    };
    window.addEventListener('resize', onResize);
    frameCamera();
    applyCamera();
    setReady(true);

    // --- render loop ------------------------------------------------------
    let lastFrame = 0;
    const centreNdc = new THREE.Vector2(0, 0);
    const floorScratch = new THREE.Vector3();
    const render = (time: number, frame?: XRFrame) => {
      const r = rendererRef.current;
      const s = sceneRef.current;
      const c = cameraRef.current;
      if (!r || !s || !c) return;
      const dt = lastFrame ? Math.min(0.06, (time - lastFrame) / 1000) : 0.016;
      lastFrame = time;

      const presenting = r.xr.isPresenting;
      const lite = liteActiveRef.current;
      const arMode = presenting || lite;

      if (lite) {
        // 3-DoF: the viewer sits at the origin and only ever rotates. Before
        // the first deviceorientation event the camera keeps the holo-table
        // orientation, which already looks down at the floor — so the reticle
        // is sensible even on a device whose sensors never report.
        c.position.set(0, 0, 0);
        if (trackerRef.current?.applyTo(liteQuatRef.current)) {
          c.quaternion.copy(liteQuatRef.current);
        }
      } else if (!presenting) {
        // Idle auto-rotate that yields to the user for a beat.
        if (performance.now() - lastInteractRef.current > IDLE_DELAY) {
          orbitRef.current.theta += AUTO_ROTATE * dt;
        }
        applyCamera();
      }

      // The starfield is the holo table's backdrop; the real world replaces it.
      if (backdropRef.current) {
        backdropRef.current.visible = !arMode;
        if (!arMode) backdropRef.current.rotation.y += dt * 0.006;
      }

      // AR hit-test while unplaced.
      if (frame && presenting && !placedRef.current) {
        const session = r.xr.getSession();
        if (!hitTestRequestedRef.current && session) {
          hitTestRequestedRef.current = true;
          session
            .requestReferenceSpace('viewer')
            .then((refSpace) => session.requestHitTestSource?.({ space: refSpace }))
            .then((source) => {
              if (source) hitTestSourceRef.current = source;
            })
            .catch(() => {
              /* device without hit-test: the user can still see the fallback */
            });
        }
        const src = hitTestSourceRef.current;
        const refSpace = r.xr.getReferenceSpace();
        if (src && refSpace && reticleRef.current) {
          const results = frame.getHitTestResults(src);
          if (results.length > 0) {
            const pose = results[0].getPose(refSpace);
            if (pose) {
              reticleRef.current.visible = true;
              reticleRef.current.matrix.fromArray(pose.transform.matrix);
            }
          } else {
            reticleRef.current.visible = false;
          }
        }
      } else if (lite && !placedRef.current && reticleRef.current) {
        // AR Lite has no surface detection, so the reticle previews where the
        // centre of the screen meets the virtual floor.
        const rc = raycasterFrom(centreNdc);
        if (rc) {
          projectToVirtualFloor(rc.ray, c.position.y - AR_LITE_FLOOR_DROP, floorScratch);
          reticleRef.current.visible = true;
          reticleRef.current.matrix.makeTranslation(
            floorScratch.x,
            floorScratch.y,
            floorScratch.z,
          );
        }
      } else if (reticleRef.current && placedRef.current) {
        reticleRef.current.visible = false;
      }

      // Hover highlight (desktop pointer only).
      const gs = gameSceneRef.current;
      if (gs?.hover) {
        if (!arMode && hoverNdcRef.current && enabledRef.current) {
          const rc = raycasterFrom(hoverNdcRef.current);
          if (rc) gs.hover(rc, coreRef.current);
        } else {
          gs.hover(null, coreRef.current);
        }
      }

      gs?.animate(time, currentSlotRef.current, winnerRef.current);

      r.render(s, c);
    };
    renderer.setAnimationLoop(render);

    return () => {
      isMountedRef.current = false;
      renderer.setAnimationLoop(null);
      window.removeEventListener('resize', onResize);
      controller.removeEventListener('select', onSelect);

      // Hard-release the camera and sensors first: leaving the game must never
      // leave the camera indicator lit.
      liteActiveRef.current = false;
      trackerRef.current?.stop();
      trackerRef.current = null;
      teardownCameraVideo(liteVideoRef.current);
      liteVideoRef.current = null;
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }

      try {
        gameSceneRef.current?.dispose();
      } catch {
        /* ignore */
      }
      gameSceneRef.current = null;
      sceneCtxRef.current = null;

      if (sessionRef.current) {
        try {
          void sessionRef.current.end();
        } catch {
          /* ignore */
        }
        sessionRef.current = null;
      }

      // Deep dispose of everything the host itself created.
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
        if (mesh.geometry) mesh.geometry.dispose();
        const m = mesh.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else if (m) m.dispose();
      });
      scene.clear();
      scene.environment = null;
      envRTRef.current?.dispose();
      envRTRef.current = null;

      renderer.dispose();
      renderer.forceContextLoss?.();
      const dom = renderer.domElement;
      if (dom.parentNode) dom.parentNode.removeChild(dom);

      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      anchorRef.current = null;
      rootRef.current = null;
      backdropRef.current = null;
      reticleRef.current = null;
      controllerRef.current = null;
      rimLightsRef.current = null;
      hitTestSourceRef.current = null;
      hitTestRequestedRef.current = false;
      pointersRef.current.clear();
      if (lockTimerRef.current !== null) {
        clearTimeout(lockTimerRef.current);
        lockTimerRef.current = null;
      }
    };
    // Mount-only: everything else is synced through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------------
  // Build / rebuild the game scene when the game changes
  // ------------------------------------------------------------------------

  useEffect(() => {
    if (!ready) return;
    const root = rootRef.current;
    const scene = sceneRef.current;
    if (!root || !scene) return;

    gameIdRef.current = gameId;
    try {
      gameSceneRef.current?.dispose();
    } catch {
      /* ignore */
    }

    const ctx: SceneContext = {
      root,
      scene,
      profiles,
      boardSize: FRAMING[gameId].boardSize,
    };
    sceneCtxRef.current = ctx;

    const gs = SCENE_FACTORIES[gameId]();
    gs.init(ctx);
    gs.update(coreRef.current, null);
    gameSceneRef.current = gs;

    orbitRef.current.theta = 0;
    orbitRef.current.phi = FRAMING[gameId].phi;
    orbitRef.current.zoom = 1;
    frameCamera();
    applyCamera();

    return () => {
      try {
        gs.dispose();
      } catch {
        /* ignore */
      }
      if (gameSceneRef.current === gs) gameSceneRef.current = null;
    };
    // `profiles` must be a stable reference from the caller (GameScreen memoises
    // it) — a new identity here tears the scene down and rebuilds it.
  }, [gameId, ready, profiles, frameCamera, applyCamera]);

  // Rim lights follow the two players' colours.
  useEffect(() => {
    const lights = rimLightsRef.current;
    if (!lights) return;
    lights[0].color.set(profiles[0].color);
    lights[1].color.set(profiles[1].color);
  }, [profiles]);

  // Push core changes into the scene.
  useEffect(() => {
    if (!ready) return;
    gameSceneRef.current?.update(core, prevCore);
  }, [core, prevCore, ready]);

  // ------------------------------------------------------------------------
  // AR session lifecycle
  // ------------------------------------------------------------------------

  const startAR = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer || sessionRef.current) return;
    const xr = typeof navigator !== 'undefined' ? navigator.xr : undefined;
    if (!xr) return;

    sound.resume();
    sound.playClick();

    try {
      const session = await xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'local-floor'],
        domOverlay: { root: document.body },
      });

      session.addEventListener('end', () => {
        sessionRef.current = null;
        hitTestSourceRef.current = null;
        hitTestRequestedRef.current = false;
        if (!isMountedRef.current) return;
        setXrActive(false);
        // Restore the holo-table view.
        const anchor = anchorRef.current;
        const root = rootRef.current;
        if (anchor) {
          anchor.position.set(0, 0, 0);
          anchor.rotation.set(0, 0, 0);
        }
        if (root) {
          root.rotation.set(0, 0, 0);
          root.scale.setScalar(1);
          root.visible = true;
        }
        placedRef.current = true;
        setPlaced(true);
        frameCamera();
        applyCamera();
      });

      sessionRef.current = session;
      setXrActive(true);

      // Board must be (re)placed against the real world.
      placedRef.current = false;
      setPlaced(false);
      if (rootRef.current) rootRef.current.visible = false;
      hitTestSourceRef.current = null;
      hitTestRequestedRef.current = false;

      renderer.xr.setReferenceSpaceType('local');
      await renderer.xr.setSession(session);
    } catch (err) {
      console.error('[SceneHost] AR session failed', err);
      sessionRef.current = null;
      setXrActive(false);
      placedRef.current = true;
      setPlaced(true);
      if (rootRef.current) rootRef.current.visible = true;
    }
  }, [applyCamera, frameCamera]);

  // ------------------------------------------------------------------------
  // AR Lite lifecycle (camera + gyro)
  // ------------------------------------------------------------------------

  /** Releases camera + sensors and restores the holo-table view. */
  const stopArLite = useCallback(
    (notice?: string) => {
      liteActiveRef.current = false;

      trackerRef.current?.stop();
      trackerRef.current = null;
      teardownCameraVideo(liteVideoRef.current);
      liteVideoRef.current = null;

      const camera = cameraRef.current;
      if (camera) {
        camera.fov = FOV;
        camera.quaternion.identity();
        camera.updateProjectionMatrix();
      }
      const anchor = anchorRef.current;
      if (anchor) {
        anchor.position.set(0, 0, 0);
        anchor.rotation.set(0, 0, 0);
        anchor.scale.setScalar(1);
      }
      const root = rootRef.current;
      if (root) {
        root.rotation.set(0, 0, 0);
        root.scale.setScalar(1);
        root.visible = true;
      }
      if (reticleRef.current) reticleRef.current.visible = false;

      placedRef.current = true;
      if (!isMountedRef.current) return;
      setLiteActive(false);
      setPlaced(true);
      frameCamera();
      applyCamera();
      if (notice) showNotice(notice);
    },
    [applyCamera, frameCamera, showNotice],
  );

  const startArLite = useCallback(async () => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const scene = sceneRef.current;
    const container = containerRef.current;
    if (!renderer || !camera || !scene || !container) return;
    if (liteActiveRef.current || liteStartingRef.current) return;

    liteStartingRef.current = true;
    setLiteStarting(true);
    sound.resume();
    sound.playClick();

    try {
      // Kicks off the iOS motion prompt and getUserMedia inside this gesture.
      const { stream } = await startArLiteSensors();
      if (!isMountedRef.current) {
        stopStream(stream);
        return;
      }

      const video = createCameraVideoElement(stream);
      // Behind the renderer canvas, which already clears fully transparent.
      container.insertBefore(video, container.firstChild);
      liteVideoRef.current = video;

      const tracker = new DeviceOrientationTracker();
      tracker.start();
      trackerRef.current = tracker;

      scene.background = null;
      camera.fov = AR_LITE_FOV;
      camera.position.set(0, 0, 0);
      camera.updateProjectionMatrix();

      // The board must be (re)placed against the virtual floor.
      liteActiveRef.current = true;
      placedRef.current = false;
      if (rootRef.current) rootRef.current.visible = false;
      setLiteActive(true);
      setPlaced(false);

      // Deliberately *not* awaited: the element is already on screen, so
      // pausing here would leave the camera feed showing behind a canvas still
      // drawing the holo table — and taps in that window would be routed to the
      // holo handler instead of placement. The muted/playsinline/autoplay
      // attributes are what actually satisfy iOS; this is just a nudge.
      void video.play().catch(() => {
        /* autoplay policy — attributes cover iOS Safari */
      });
    } catch (err) {
      console.warn('[SceneHost] AR Lite unavailable', err);
      stopArLite(
        err instanceof ArLiteError ? err.notice : 'AR unavailable — showing the holo table.',
      );
    } finally {
      liteStartingRef.current = false;
      if (isMountedRef.current) setLiteStarting(false);
    }
  }, [stopArLite]);

  const enterAr = useCallback(() => {
    if (arTier === 'webxr') void startAR();
    else if (arTier === 'lite') void startArLite();
  }, [arTier, startAR, startArLite]);

  // Reposition request (either AR path).
  useEffect(() => {
    if (repositionNonce === 0) return;
    if (!rendererRef.current?.xr.isPresenting && !liteActiveRef.current) return;
    placedRef.current = false;
    setPlaced(false);
    if (rootRef.current) rootRef.current.visible = false;
    hitTestSourceRef.current = null;
    hitTestRequestedRef.current = false;
    // Re-centre AR Lite's yaw so the reticle starts under the current aim.
    trackerRef.current?.recentre();
  }, [repositionNonce]);

  // Page background must be see-through while AR composites over the camera.
  useEffect(() => {
    onArActiveChange?.(arActive);
    const html = document.documentElement;
    if (arActive) html.classList.add('xr-active');
    else html.classList.remove('xr-active');
    return () => {
      html.classList.remove('xr-active');
    };
  }, [arActive, onArActiveChange]);

  useEffect(() => {
    onPlacedChange?.(placed);
  }, [placed, onPlacedChange]);

  // ------------------------------------------------------------------------
  // Overlay UI
  // ------------------------------------------------------------------------

  const accent = profiles[currentSlot]?.color ?? '#22d3ee';

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0 z-0 h-full w-full"
        style={{ touchAction: 'none' }}
      />

      {/* Enter AR — floats over the fallback view on both AR tiers. */}
      {arTier !== null && arTier !== 'none' && !arActive && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-6">
          <button
            onClick={enterAr}
            disabled={liteStarting}
            className="glass-btn pointer-events-auto anim-fade-up !rounded-full !px-6 !py-3 text-sm font-bold tracking-wide"
            style={{ boxShadow: `0 0 0 1px ${rgba(accent, 0.35)}, 0 18px 40px -16px ${rgba(accent, 0.7)}` }}
          >
            <Icon name="ar" size={18} />
            Enter AR
          </button>
        </div>
      )}

      {/* Leave AR Lite — the WebXR path gets an exit affordance from the UA. */}
      {liteActive && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-6">
          <button
            onClick={() => {
              sound.playClick();
              stopArLite();
            }}
            className="glass-btn pointer-events-auto anim-fade-up !rounded-full !px-5 !py-2.5 text-xs font-bold tracking-wide"
          >
            <Icon name="close" size={15} />
            Exit AR
          </button>
        </div>
      )}

      {/* Placement affordance — AR Lite aims at a virtual floor, not a surface.
          Sits above centre so it never covers the reticle being aimed. */}
      {liteActive && !placed && (
        <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-start px-8 pt-[21vh] text-center">
          <div className="phone-anim mb-5 opacity-90">
            <div className="relative h-16 w-10 rounded-xl border-2 border-white/85">
              <span className="absolute left-1/2 top-1.5 h-0.5 w-3.5 -translate-x-1/2 rounded-full bg-white/60" />
              <span className="absolute bottom-1.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white/60" />
            </div>
          </div>
          <div className="glass-strong max-w-xs rounded-2xl px-6 py-4">
            <p className="font-display text-base font-bold tracking-wide text-cyan-300">
              AIM AT THE FLOOR…
            </p>
            <p className="mt-1 text-sm text-slate-300">
              Tilt your phone down until the ring sits where you want to play.
            </p>
            <div className="shimmer mt-3 h-1 w-full overflow-hidden rounded-full bg-white/15" />
          </div>
          <p className="glass-pill mt-3.5 px-3 py-1 text-[11px] text-cyan-200">
            Tap anywhere to place the board
          </p>
        </div>
      )}

      {/* Scanning overlay while an AR session hunts for a surface. */}
      {xrActive && !placed && (
        <div className="pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center px-8 text-center">
          <div className="phone-anim mb-7 opacity-90">
            <div className="relative h-20 w-12 rounded-xl border-2 border-white/85">
              <span className="absolute left-1/2 top-1.5 h-0.5 w-4 -translate-x-1/2 rounded-full bg-white/60" />
              <span className="absolute bottom-1.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white/60" />
            </div>
          </div>
          <div className="glass-strong max-w-xs rounded-2xl px-6 py-5">
            <p className="font-display text-base font-bold tracking-wide text-cyan-300">
              SCANNING AREA…
            </p>
            <p className="mt-1 text-sm text-slate-300">
              Move your phone slowly side to side to find a flat surface.
            </p>
            <div className="shimmer mt-3 h-1 w-full overflow-hidden rounded-full bg-white/15" />
          </div>
          <p className="glass-pill mt-4 px-3 py-1 text-[11px] text-cyan-200">
            Tap the glowing ring to place the board
          </p>
        </div>
      )}

      {/* Gesture hint inside AR (both tiers share the same gestures). */}
      {arActive && placed && (
        <div className="pointer-events-none absolute inset-x-0 top-28 z-30 flex justify-center">
          <div className="glass-pill px-3 py-1 text-[10px] tracking-wide text-cyan-200">
            1 finger to rotate • 2 fingers to scale
          </div>
        </div>
      )}

      {/* Non-blocking notice when AR could not start (permissions, no camera). */}
      {arNotice && (
        <div className="pointer-events-none absolute inset-x-0 bottom-44 z-40 flex justify-center px-6">
          <div className="glass-pill anim-fade-up px-4 py-2 text-[12px] text-rose-200">
            {arNotice}
          </div>
        </div>
      )}
    </>
  );
};

export default SceneHost;
