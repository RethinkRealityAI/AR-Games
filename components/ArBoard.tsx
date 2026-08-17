
import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Player, CellValue, PlayerProfile } from '../types';
import { soundService } from '../services/soundService';

// Define WebXR types locally
type XRHitTestSource = any;
type XRFrame = any;
type XRSession = any;

interface ArBoardProps {
  board: CellValue[];
  onCellClick: (index: number) => void;
  winner: Player | 'DRAW' | null;
  winningLine: number[] | null;
  isBoardPlaced: boolean;
  onBoardPlacedChange: (placed: boolean) => void;
  onArStatusChange: (isActive: boolean) => void;
  currentPlayer: Player;
  playerProfile: PlayerProfile;
}

const ArBoard: React.FC<ArBoardProps> = ({ 
  board, 
  onCellClick, 
  winner, 
  winningLine, 
  isBoardPlaced, 
  onBoardPlacedChange,
  onArStatusChange,
  currentPlayer,
  playerProfile
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [arSupported, setArSupported] = useState<boolean | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  
  // --- State Refs (To fix Stale Closures in Loop & Events) ---
  const isBoardPlacedRef = useRef(isBoardPlaced);
  const boardRef = useRef(board);
  const winningLineRef = useRef(winningLine);
  const onCellClickRef = useRef(onCellClick);
  const currentPlayerRef = useRef(currentPlayer);
  const playerProfileRef = useRef(playerProfile);
  
  // Input Lock to prevent double-submission race conditions
  const isProcessingMoveRef = useRef(false);
  
  // Sync Refs with Props
  useEffect(() => { isBoardPlacedRef.current = isBoardPlaced; }, [isBoardPlaced]);
  useEffect(() => { 
      boardRef.current = board;
      isProcessingMoveRef.current = false;
  }, [board]);
  useEffect(() => { winningLineRef.current = winningLine; }, [winningLine]);
  useEffect(() => { onCellClickRef.current = onCellClick; }, [onCellClick]);
  useEffect(() => { currentPlayerRef.current = currentPlayer; }, [currentPlayer]);
  useEffect(() => { playerProfileRef.current = playerProfile; }, [playerProfile]);

  // Three.js Refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const reticleRef = useRef<THREE.Mesh | null>(null);
  const boardGroupRef = useRef<THREE.Group | null>(null);
  const galaxyRef = useRef<THREE.Points | null>(null);
  const tilesRef = useRef<THREE.Mesh[]>([]); 
  const piecesMapRef = useRef<Map<number, THREE.Object3D>>(new Map());
  const winningLineMeshRef = useRef<THREE.Mesh | null>(null);
  
  // Visual Cue Refs
  const turnLightRef = useRef<THREE.PointLight | null>(null);
  const borderMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  
  // XR Refs
  const sessionRef = useRef<XRSession | null>(null);
  const hitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const hitTestSourceRequestedRef = useRef(false);
  const controllerRef = useRef<THREE.XRTargetRaySpace | null>(null);
  const isMountedRef = useRef(true);

  // Gesture Refs
  const touchStartRef = useRef<{x: number, y: number} | null>(null);
  const initialPinchDistRef = useRef<number>(0);
  const initialScaleRef = useRef<number>(1);
  const isDraggingRef = useRef(false); 
  
  const BOARD_SIZE = 0.5; 
  const TILE_SIZE = (BOARD_SIZE / 3) * 0.85; 
  const TILE_SPACING = BOARD_SIZE / 3;

  useEffect(() => {
    isMountedRef.current = true;

    if ('xr' in navigator) {
      (navigator as any).xr.isSessionSupported('immersive-ar')
        .then((supported: boolean) => {
          if (isMountedRef.current) setArSupported(supported);
        })
        .catch(() => {
          if (isMountedRef.current) setArSupported(false);
        });
    } else {
      setArSupported(false);
    }

    initThree();

    return () => {
      isMountedRef.current = false;
      cleanupThree();
    };
  }, []);

  // Handle Background Transparency via Parent Callback
  useEffect(() => {
    const rootEl = document.getElementById('root');
    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    
    if (isSessionActive) {
        onArStatusChange(true);
        htmlEl.style.background = 'transparent';
        bodyEl.style.background = 'transparent';
        if (rootEl) rootEl.style.background = 'transparent';
    } else {
        onArStatusChange(false);
        htmlEl.style.background = '';
        bodyEl.style.background = '';
        if (rootEl) rootEl.style.background = '';
    }

    return () => {
         onArStatusChange(false);
         htmlEl.style.background = '';
         bodyEl.style.background = '';
         if (rootEl) rootEl.style.background = '';
    }
  }, [isSessionActive, onArStatusChange]);

  const cleanupThree = () => {
    if (rendererRef.current) {
      rendererRef.current.setAnimationLoop(null);
    }
    
    if (controllerRef.current) {
        controllerRef.current.removeEventListener('select', onXRSelect);
        controllerRef.current = null;
    }

    if (containerRef.current) {
        containerRef.current.removeEventListener('touchstart', onTouchStart);
        containerRef.current.removeEventListener('touchmove', onTouchMove);
        containerRef.current.removeEventListener('touchend', onTouchEnd);
    }

    if (sessionRef.current) {
      try { sessionRef.current.end(); } catch(e) {}
      sessionRef.current = null;
    }

    if (rendererRef.current) {
      rendererRef.current.dispose();
      const domEl = rendererRef.current.domElement;
      if (domEl && domEl.parentNode) domEl.parentNode.removeChild(domEl);
      rendererRef.current = null;
    }
    
    sceneRef.current = null;
    cameraRef.current = null;
    boardGroupRef.current = null;
    galaxyRef.current = null;
    tilesRef.current = [];
    piecesMapRef.current.clear();
    winningLineMeshRef.current = null;
    turnLightRef.current = null;
    borderMatRef.current = null;
    
    hitTestSourceRef.current = null;
    hitTestSourceRequestedRef.current = false;
    
    window.removeEventListener('resize', onWindowResize);
  };

  // --- Sync Board Visuals ---
  useEffect(() => {
    if (!boardGroupRef.current || !sceneRef.current) return;

    board.forEach((cell, index) => {
      if (cell && !piecesMapRef.current.has(index)) {
        createPiece(cell, index);
      } else if (!cell && piecesMapRef.current.has(index)) {
        const mesh = piecesMapRef.current.get(index);
        if (mesh) boardGroupRef.current?.remove(mesh);
        piecesMapRef.current.delete(index);
      }
    });

    if (board.every(c => c === null)) {
      piecesMapRef.current.forEach((mesh) => boardGroupRef.current?.remove(mesh));
      piecesMapRef.current.clear();
      if (winningLineMeshRef.current) {
        boardGroupRef.current?.remove(winningLineMeshRef.current);
        winningLineMeshRef.current = null;
      }
    }
  }, [board, isBoardPlaced]); 

  useEffect(() => {
    if (winningLine && !winningLineMeshRef.current && boardGroupRef.current) {
      createWinningLine(winningLine);
    }
  }, [winningLine]);

  useEffect(() => {
     if (!isBoardPlaced && boardGroupRef.current && sceneRef.current) {
        sceneRef.current.remove(boardGroupRef.current);
        boardGroupRef.current = null;
        tilesRef.current = [];
        galaxyRef.current = null;
        piecesMapRef.current.clear();
        winningLineMeshRef.current = null;
        turnLightRef.current = null;
        borderMatRef.current = null;
        hitTestSourceRef.current = null;
        hitTestSourceRequestedRef.current = false;
        if(reticleRef.current) reticleRef.current.visible = true;
     }
  }, [isBoardPlaced]);

  const initThree = () => {
    if (!containerRef.current || rendererRef.current) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0); 
    renderer.xr.enabled = true;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // Reticle
    const reticleGeo = new THREE.RingGeometry(0.1, 0.11, 32).rotateX(-Math.PI / 2);
    const reticleMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    const reticle = new THREE.Mesh(reticleGeo, reticleMat);
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);
    reticleRef.current = reticle;

    // Controller
    const controller = renderer.xr.getController(0);
    controller.addEventListener('select', onXRSelect); 
    scene.add(controller);
    controllerRef.current = controller;

    containerRef.current.addEventListener('touchstart', onTouchStart, { passive: false });
    containerRef.current.addEventListener('touchmove', onTouchMove, { passive: false });
    containerRef.current.addEventListener('touchend', onTouchEnd, { passive: false });

    renderer.setAnimationLoop(render);
    window.addEventListener('resize', onWindowResize);
  };

  // --- Gesture Handling ---
  const onTouchStart = (e: TouchEvent) => {
    if (!isBoardPlacedRef.current || !boardGroupRef.current) return;
    if (e.touches.length === 1) {
        touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        isDraggingRef.current = false;
    } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        initialPinchDistRef.current = Math.sqrt(dx*dx + dy*dy);
        initialScaleRef.current = boardGroupRef.current.scale.x;
        isDraggingRef.current = true;
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!isBoardPlacedRef.current || !boardGroupRef.current) return;
    if (e.cancelable) e.preventDefault(); 

    if (e.touches.length === 1 && touchStartRef.current) {
        const currentX = e.touches[0].clientX;
        const deltaX = currentX - touchStartRef.current.x;
        if (Math.abs(deltaX) > 5) {
             isDraggingRef.current = true;
             boardGroupRef.current.rotation.y += deltaX * 0.005;
             touchStartRef.current.x = currentX;
        }
    } else if (e.touches.length === 2) {
        isDraggingRef.current = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (initialPinchDistRef.current > 0) {
            const scale = Math.min(Math.max(0.2, initialScaleRef.current * (dist / initialPinchDistRef.current)), 3.0);
            boardGroupRef.current.scale.set(scale, scale, scale);
        }
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!isBoardPlacedRef.current || !boardGroupRef.current) return;
    if (!isDraggingRef.current && e.changedTouches.length > 0 && e.touches.length === 0) {
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        if (touchStartRef.current) {
            const dist = Math.sqrt(
                Math.pow(endX - touchStartRef.current.x, 2) + 
                Math.pow(endY - touchStartRef.current.y, 2)
            );
            if (dist < 20) handleGameTap(endX, endY);
        }
    }
    touchStartRef.current = null;
    initialPinchDistRef.current = 0;
    isDraggingRef.current = false;
  };

  const handleGameTap = (clientX: number, clientY: number) => {
     if (isProcessingMoveRef.current) return;
     if (!boardGroupRef.current || tilesRef.current.length === 0) return;
     
     const mouse = new THREE.Vector2();
     mouse.x = (clientX / window.innerWidth) * 2 - 1;
     mouse.y = -(clientY / window.innerHeight) * 2 + 1;

     const raycaster = new THREE.Raycaster();
     if (cameraRef.current) {
         raycaster.setFromCamera(mouse, cameraRef.current);
         const intersects = raycaster.intersectObjects(tilesRef.current, false);
         if (intersects.length > 0) {
             const hit = intersects[0].object;
             const index = hit.userData.index;
             if (typeof index === 'number') {
                 isProcessingMoveRef.current = true;
                 if (onCellClickRef.current) onCellClickRef.current(index);
             }
         }
     }
  };

  const onXRSelect = () => {
    if (!isMountedRef.current || isBoardPlacedRef.current) return;
    if (reticleRef.current && reticleRef.current.visible) {
       createBoard(reticleRef.current.matrix);
       onBoardPlacedChange(true); 
       soundService.playMove();
    }
  };

  // --- 3D MODELS GENERATORS ---

  const createDrone = (color: number): THREE.Group => {
    const group = new THREE.Group();
    const materialMain = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.3, metalness: 0.8 });
    const materialGlow = new THREE.MeshBasicMaterial({ color: color });

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 16), materialMain);
    core.position.y = 0.08;
    group.add(core);

    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.02, 8), materialGlow);
    eye.rotateX(Math.PI / 2);
    eye.position.set(0, 0.08, 0.035);
    group.add(eye);

    const ringGeo = new THREE.TorusGeometry(0.06, 0.005, 8, 32);
    const ring = new THREE.Mesh(ringGeo, materialMain);
    ring.rotateX(Math.PI / 2);
    ring.position.y = 0.08;
    group.add(ring);
    
    // Add simple rotation animation script via userData
    group.userData.animate = (time: number) => {
        ring.rotation.z = time * 0.005;
        group.position.y = Math.sin(time * 0.003) * 0.02;
    };

    return group;
  };

  const createCrystal = (color: number): THREE.Group => {
    const group = new THREE.Group();
    const material = new THREE.MeshPhysicalMaterial({ 
        color: color, 
        metalness: 0.1, 
        roughness: 0.1, 
        transmission: 0.6, 
        thickness: 0.5,
        emissive: color,
        emissiveIntensity: 0.2
    });
    const geo = new THREE.OctahedronGeometry(0.06, 0);
    const crystal = new THREE.Mesh(geo, material);
    crystal.position.y = 0.08;
    group.add(crystal);

    group.userData.animate = (time: number) => {
        crystal.rotation.y = time * 0.002;
        crystal.rotation.z = time * 0.001;
    };
    return group;
  };

  const createAstronaut = (color: number): THREE.Group => {
    const group = new THREE.Group();
    const materialMain = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 });
    const materialColor = new THREE.MeshStandardMaterial({ color: color, roughness: 0.4, metalness: 0.2 });
    const materialVisor = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.9 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.04), materialMain);
    body.position.y = 0.06;
    group.add(body);

    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.03), materialMain);
    pack.position.set(0, 0.06, -0.03);
    group.add(pack);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 16), materialMain);
    head.position.y = 0.12;
    group.add(head);

    const visorGeo = new THREE.SphereGeometry(0.015, 16, 16, 0, Math.PI * 2, 0, Math.PI/2.5);
    visorGeo.rotateX(-Math.PI / 2);
    const visor = new THREE.Mesh(visorGeo, materialVisor);
    visor.position.set(0, 0.12, 0.028);
    group.add(visor);

    const limbGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.05);
    const armL = new THREE.Mesh(limbGeo, materialColor);
    armL.position.set(-0.04, 0.07, 0);
    armL.rotation.z = Math.PI / 4;
    group.add(armL);

    const armR = new THREE.Mesh(limbGeo, materialColor);
    armR.position.set(0.04, 0.07, 0);
    armR.rotation.z = -Math.PI / 4;
    group.add(armR);

    const legL = new THREE.Mesh(limbGeo, materialColor);
    legL.position.set(-0.02, 0.025, 0);
    group.add(legL);

    const legR = new THREE.Mesh(limbGeo, materialColor);
    legR.position.set(0.02, 0.025, 0);
    group.add(legR);

    return group;
  };

  const createGalaxy = (): THREE.Points => {
      const particlesCount = 1200;
      const posArray = new Float32Array(particlesCount * 3);
      const colorArray = new Float32Array(particlesCount * 3);
      const colorInside = new THREE.Color(0x00ffff);
      const colorOutside = new THREE.Color(0xff00ff);

      for(let i = 0; i < particlesCount; i++) {
          const i3 = i * 3;
          const radius = Math.random() * BOARD_SIZE * 2.5;
          const spinAngle = radius * 4;
          const branchAngle = (i % 3) * ((Math.PI * 2) / 3);
          
          const x = Math.cos(branchAngle + spinAngle) * radius;
          const z = Math.sin(branchAngle + spinAngle) * radius;
          const y = (Math.random() - 0.5) * 0.15;

          posArray[i3] = x;
          posArray[i3+1] = y;
          posArray[i3+2] = z;

          const mixedColor = colorInside.clone().lerp(colorOutside, radius / (BOARD_SIZE * 2.5));
          colorArray[i3] = mixedColor.r;
          colorArray[i3+1] = mixedColor.g;
          colorArray[i3+2] = mixedColor.b;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
      const material = new THREE.PointsMaterial({
          size: 0.008,
          vertexColors: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          opacity: 0.7
      });
      return new THREE.Points(geometry, material);
  };

  const createBoard = (matrix: THREE.Matrix4) => {
    if (!sceneRef.current) return;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(matrix);
    sceneRef.current.add(group);
    boardGroupRef.current = group;

    if (reticleRef.current) reticleRef.current.visible = false;

    const galaxy = createGalaxy();
    galaxy.position.y = -0.3;
    group.add(galaxy);
    galaxyRef.current = galaxy;

    const turnLight = new THREE.PointLight(0xffffff, 1, 2);
    turnLight.position.set(0, 0.5, 0);
    group.add(turnLight);
    turnLightRef.current = turnLight;

    tilesRef.current = [];
    const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0x222222,
        metalness: 0.1, roughness: 0.1, transmission: 0.6,
        thickness: 0.02, transparent: true, opacity: 0.8,
        side: THREE.DoubleSide
    });
    const borderMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.4, wireframe: true });
    borderMatRef.current = borderMat;

    for (let i = 0; i < 9; i++) {
        const row = Math.floor(i / 3);
        const col = i % 3;
        const x = (col - 1) * TILE_SPACING;
        const z = (row - 1) * TILE_SPACING;
        const geo = new THREE.BoxGeometry(TILE_SIZE, 0.015, TILE_SIZE);
        const tile = new THREE.Mesh(geo, glassMat.clone());
        tile.position.set(x, 0, z);
        
        const border = new THREE.Mesh(geo, borderMat);
        tile.add(border);
        
        tile.userData = { index: i, isTile: true };
        group.add(tile);
        tilesRef.current.push(tile);
    }

    // Force sync
    boardRef.current.forEach((cell, index) => {
        if (cell) createPiece(cell, index);
    });
  };

  const createPiece = (player: Player, index: number) => {
    if (!boardGroupRef.current || piecesMapRef.current.has(index)) return;
    const row = Math.floor(index / 3);
    const col = index % 3;
    const x = (col - 1) * TILE_SPACING;
    const z = (row - 1) * TILE_SPACING;
    
    // Determine Color and Model
    let color: number;
    let mesh: THREE.Group;

    if (player === 'X') {
        // User Player
        color = parseInt(playerProfileRef.current.color.replace('#', '0x'));
        const type = playerProfileRef.current.avatarId;
        if (type === 'DRONE') mesh = createDrone(color);
        else if (type === 'CRYSTAL') mesh = createCrystal(color);
        else mesh = createAstronaut(color);
    } else {
        // Opponent (Red Astronaut by default)
        color = 0xff3333;
        mesh = createAstronaut(color);
    }

    mesh.position.set(x, 0, z);
    mesh.lookAt(0, 0, 0);
    mesh.scale.set(0,0,0); // Start small for animation
    
    let s = 0;
    const grow = () => {
        s += 0.08;
        if (s <= 1.5) {
            mesh.scale.set(s, s, s);
            requestAnimationFrame(grow);
        }
    };
    grow();
    
    boardGroupRef.current.add(mesh);
    piecesMapRef.current.set(index, mesh);
  };

  const createWinningLine = (line: number[]) => {
    if (!boardGroupRef.current) return;
    const startIdx = line[0];
    const endIdx = line[2];
    const getPos = (idx: number) => {
        const row = Math.floor(idx / 3);
        const col = idx % 3;
        return new THREE.Vector3((col - 1) * TILE_SPACING, 0.15, (row - 1) * TILE_SPACING);
    };
    const startPos = getPos(startIdx);
    const endPos = getPos(endIdx);
    const midPoint = new THREE.Vector3().addVectors(startPos, endPos).multiplyScalar(0.5);
    const distance = startPos.distanceTo(endPos);
    const geo = new THREE.CylinderGeometry(0.01, 0.01, distance + TILE_SIZE, 8);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(midPoint);
    mesh.lookAt(endPos);
    boardGroupRef.current.add(mesh);
    winningLineMeshRef.current = mesh;
  };

  const onWindowResize = () => {
    if (cameraRef.current && rendererRef.current && !rendererRef.current.xr.isPresenting) {
        cameraRef.current.aspect = window.innerWidth / window.innerHeight;
        cameraRef.current.updateProjectionMatrix();
        rendererRef.current.setSize(window.innerWidth, window.innerHeight);
    }
  };

  // --- MAIN LOOP ---
  const render = (timestamp: number, frame?: XRFrame) => {
    if (!rendererRef.current || !sceneRef.current || !cameraRef.current) return;

    if (galaxyRef.current) galaxyRef.current.rotation.y += 0.001;

    // Animate Pieces
    if (piecesMapRef.current) {
        piecesMapRef.current.forEach((obj, idx) => {
             // Generic hover
             obj.position.y = 0 + Math.sin((timestamp / 600) + idx) * 0.005;
             // Specific model animation if attached
             if (obj.userData.animate) obj.userData.animate(timestamp);
        });
    }
    
    // Animate Turn Visuals
    const currentP = currentPlayerRef.current;
    const userColor = parseInt(playerProfileRef.current.color.replace('#', '0x'));
    const targetColor = currentP === 'X' ? new THREE.Color(userColor) : new THREE.Color(0xff3333);
    
    if (turnLightRef.current) {
        const pulse = 1.0 + Math.sin(timestamp / 400) * 0.5;
        turnLightRef.current.intensity = pulse;
        turnLightRef.current.color.lerp(targetColor, 0.05);
    }
    
    if (borderMatRef.current) {
        borderMatRef.current.color.lerp(targetColor, 0.05);
        borderMatRef.current.opacity = 0.3 + Math.sin(timestamp / 1000) * 0.1;
    }

    const isPlaced = isBoardPlacedRef.current;

    if (frame && !isPlaced) {
        const session = rendererRef.current.xr.getSession();
        if (hitTestSourceRequestedRef.current === false && session) {
            session.requestReferenceSpace('viewer').then((refSpace: any) => {
               if(session.requestHitTestSource) {
                   session.requestHitTestSource({ space: refSpace }).then((source: any) => {
                       hitTestSourceRef.current = source;
                   });
               }
            });
            hitTestSourceRequestedRef.current = true;
        }

        if (hitTestSourceRef.current && reticleRef.current) {
             const refSpace = rendererRef.current.xr.getReferenceSpace();
             if(refSpace) {
                const hitResults = frame.getHitTestResults(hitTestSourceRef.current);
                if (hitResults.length > 0) {
                    const pose = hitResults[0].getPose(refSpace);
                    if(pose) {
                        reticleRef.current.visible = true;
                        reticleRef.current.matrix.fromArray(pose.transform.matrix);
                    }
                } else {
                    reticleRef.current.visible = false;
                }
             }
        }
    } else if (isPlaced && reticleRef.current) {
        reticleRef.current.visible = false;
    }

    rendererRef.current.render(sceneRef.current, cameraRef.current);
  };

  const startAR = async () => {
    if (isSessionActive || sessionRef.current) return;
    if (!rendererRef.current || !(navigator as any).xr) return;

    soundService.resume(); 
    soundService.playClick();
    
    try {
        const session = await (navigator as any).xr.requestSession('immersive-ar', { 
            requiredFeatures: ['hit-test'], 
            optionalFeatures: ['dom-overlay'], 
            domOverlay: { root: document.body } 
        });

        session.addEventListener('end', () => {
            sessionRef.current = null;
            if (isMountedRef.current) setIsSessionActive(false);
        });

        sessionRef.current = session;
        if (isMountedRef.current) setIsSessionActive(true);

        rendererRef.current.xr.setReferenceSpaceType('local');
        rendererRef.current.xr.setSession(session);
    } catch (error) {
        console.error("Failed to start AR session:", error);
        alert("AR Session failed. Please try again.");
        setIsSessionActive(false);
        sessionRef.current = null;
    }
  };

  return (
    <>
      <div ref={containerRef} className="absolute inset-0 w-full h-full z-0 touch-none" />
      
      {/* AR Initialization Button (Now styled as Final Confirmation) */}
      {!isBoardPlaced && arSupported === true && !isSessionActive && (
        <div className="absolute bottom-24 left-1/2 transform -translate-x-1/2 z-50 pointer-events-auto w-full flex flex-col items-center gap-4 animate-in fade-in slide-in-from-bottom-4">
           <button 
             onClick={startAR}
             className="bg-cyan-500 hover:bg-cyan-400 text-white font-bold py-4 px-10 rounded-full shadow-[0_0_20px_rgba(6,182,212,0.5)] flex items-center gap-3 animate-pulse transition-all active:scale-95"
           >
             <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" />
             </svg>
             ENTER AR
           </button>
           <p className="text-cyan-200 text-xs bg-black/40 backdrop-blur px-3 py-1 rounded-full border border-cyan-500/30">
               Ready to scan your environment
           </p>
        </div>
      )}

      {/* Unsupported State */}
      {arSupported === false && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-50 bg-red-900/80 border border-red-500 p-6 rounded-xl text-white text-center max-w-xs backdrop-blur-lg">
           <h3 className="font-bold text-lg mb-2">AR Not Supported</h3>
           <p className="text-sm opacity-80">WebXR not detected.</p>
        </div>
      )}

      {/* In-Session Scanning Overlay */}
      {!isBoardPlaced && isSessionActive && (
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none z-50 flex flex-col items-center text-center w-full px-8">
             
             {/* Phone Animation */}
             <div className="mb-6 phone-anim opacity-80">
                <div className="w-12 h-20 border-2 border-white rounded-xl relative">
                    <div className="absolute top-1 left-1/2 -translate-x-1/2 w-4 h-0.5 bg-white/50 rounded-full"></div>
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 bg-white/50 rounded-full"></div>
                </div>
             </div>
             
             <div className="bg-black/60 text-white px-6 py-4 rounded-2xl backdrop-blur-md border border-white/20 animate-pulse shadow-2xl max-w-xs">
                <p className="font-bold text-lg text-cyan-300 mb-1">SCANNING AREA...</p>
                <p className="text-sm opacity-90">Move your phone slowly side-to-side to detect the floor.</p>
                <div className="w-full h-1 bg-white/20 rounded-full mt-3 overflow-hidden">
                    <div className="h-full bg-cyan-400 w-1/2 animate-[shimmer_1s_infinite_linear] origin-left"></div>
                </div>
             </div>

             <p className="mt-4 text-xs text-cyan-200 bg-black/40 px-3 py-1 rounded-full border border-cyan-500/20">
                Tap the blue circle when it appears
             </p>
          </div>
      )}
      
      {isBoardPlaced && isSessionActive && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 z-40 pointer-events-none">
           <div className="bg-black/30 text-cyan-200 text-[10px] px-3 py-1 rounded-full backdrop-blur-sm border border-cyan-500/20">
              2 fingers to scale • 1 finger drag to rotate
           </div>
        </div>
      )}
    </>
  );
};

export default ArBoard;
