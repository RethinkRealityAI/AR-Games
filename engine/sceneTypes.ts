import type * as THREE from 'three';
import type { GameCore, Move, PlayerProfile, PlayerSlot } from '../types';

/**
 * Contract between the SceneHost (engine) and each game's 3D scene module.
 * The host owns the renderer, camera, XR session / fallback controls, and the
 * root group's placement; the scene owns everything inside the root group.
 */

export interface SceneContext {
  /** Root group. The host positions/scales/rotates it (AR placement or table view). */
  root: THREE.Group;
  scene: THREE.Scene;
  profiles: [PlayerProfile, PlayerProfile];
  /** Nominal board footprint in meters (host uses it to frame the fallback camera). */
  boardSize: number;
}

export interface GameScene {
  /** Build the static board into ctx.root. Called once after placement. */
  init(ctx: SceneContext): void;
  /**
   * Sync visuals to a new core (add/remove/animate pieces, show winning line).
   * prev is null on first sync or after reset.
   */
  update(core: GameCore, prev: GameCore | null): void;
  /** Per-frame animation hook (piece hover, glow pulses…). */
  animate(timeMs: number, currentSlot: PlayerSlot, winner: GameCore['winner']): void;
  /**
   * Convert a raycast into a move, or null if nothing actionable was hit.
   * The host builds the raycaster from taps/clicks.
   */
  pickMove(raycaster: THREE.Raycaster, core: GameCore): Move | null;
  /** Optional hover highlight (fallback/desktop). */
  hover?(raycaster: THREE.Raycaster | null, core: GameCore): void;
  /** Remove everything from ctx.root and dispose geometries/materials. */
  dispose(): void;
}

export type GameSceneFactory = () => GameScene;
