// Premium 3D piece models generated with Higgsfield (image_to_3d, textured GLB),
// lazy-loaded from the CDN at runtime. The procedural models in each game's
// scene module remain the instant fallback: if a fetch fails, times out, or has
// not finished by the time a piece spawns, the procedural piece is used instead.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AvatarType } from '../types';

const MODEL_URLS: Record<AvatarType, string> = {
  ASTRONAUT:
    'https://d8j0ntlcm91z4.cloudfront.net/user_33Txeg6YsaHeKOwmprAOf8Wr55B/hf_20260818_053104_cdc6e9ce-72d4-47d1-bbdb-f3cdc1897796.glb',
  DRONE:
    'https://d8j0ntlcm91z4.cloudfront.net/user_33Txeg6YsaHeKOwmprAOf8Wr55B/hf_20260818_053104_c2046e17-ffd6-40b2-ad55-2ca5fdf22e96.glb',
  CRYSTAL:
    'https://d8j0ntlcm91z4.cloudfront.net/user_33Txeg6YsaHeKOwmprAOf8Wr55B/hf_20260818_053105_232bed1c-b280-4ce9-8100-f283d8c43264.glb',
};

/** Height (in board units, pre pieceScale) the normalized model should stand. */
const TARGET_HEIGHT = 0.13;
const LOAD_TIMEOUT_MS = 12_000;

// null = load attempted and failed (never retried); Group = normalized template.
const templates = new Map<AvatarType, THREE.Group | null>();
const inflight = new Map<AvatarType, Promise<void>>();

function normalize(scene: THREE.Object3D): THREE.Group {
  const wrapper = new THREE.Group();
  wrapper.add(scene);
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const height = Math.max(size.y, 1e-6);
  const s = TARGET_HEIGHT / height;
  scene.scale.setScalar(s);
  // Center on X/Z, rest the base on y=0.
  scene.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  return wrapper;
}

/** Begin loading a premium model for this avatar. Safe to call repeatedly. */
export function prefetchPieceModel(avatarId: AvatarType): void {
  if (templates.has(avatarId) || inflight.has(avatarId)) return;
  const url = MODEL_URLS[avatarId];
  if (!url) {
    templates.set(avatarId, null);
    return;
  }

  const loader = new GLTFLoader();
  const attempt = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (tpl: THREE.Group | null, note: string) => {
      if (settled) return;
      settled = true;
      templates.set(avatarId, tpl);
      console.info(`[models] ${avatarId}: ${note}`);
      resolve();
    };
    const timer = window.setTimeout(
      () => finish(null, 'premium model timed out, using procedural fallback'),
      LOAD_TIMEOUT_MS,
    );
    loader.load(
      url,
      (gltf) => {
        window.clearTimeout(timer);
        try {
          finish(normalize(gltf.scene), 'premium Higgsfield model loaded');
        } catch {
          finish(null, 'premium model failed to normalize, using procedural fallback');
        }
      },
      undefined,
      () => {
        window.clearTimeout(timer);
        finish(null, 'premium model unavailable, using procedural fallback');
      },
    );
  }).finally(() => inflight.delete(avatarId));

  inflight.set(avatarId, attempt);
}

/**
 * A normalized template for this avatar if (and only if) it has finished
 * loading, else null. Callers must clone before adding to a scene.
 */
export function getPieceModel(avatarId: AvatarType): THREE.Group | null {
  return templates.get(avatarId) ?? null;
}
