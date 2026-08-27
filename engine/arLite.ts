// ============================================================================
// arLite — camera + gyroscope "AR Lite" primitives.
//
// WebXR `immersive-ar` does not exist on iOS Safari (still true in 2026), so
// the platform needs a second, sensor-only path to put a board in the room:
//
//   * the rear camera feed is painted behind a transparent WebGL canvas, and
//   * the camera's *rotation* comes from `deviceorientation` (3-DoF).
//
// There is no world tracking, so the board is anchored to a **virtual floor**
// a fixed distance below the viewer rather than to a detected surface. The
// viewer never translates: look around, and the board stays put in the
// direction you left it. That is the honest limit of the technique, and it is
// enough for a board game you sit or stand in front of.
//
// Everything here is framework-free so `SceneHost` stays readable.
// ============================================================================

import * as THREE from 'three';

// -- capability detection ----------------------------------------------------

/**
 * Three presentation tiers, best first:
 *  - `webxr` — real `immersive-ar` (Android Chrome, Quest browser…).
 *  - `lite`  — no WebXR, but a mobile device with a camera and orientation
 *              sensors (iOS Safari, older Android browsers).
 *  - `none`  — desktop / no sensors: the holo-table view is the whole story.
 */
export type ArTier = 'webxr' | 'lite' | 'none';

/** Vertical drop from the viewer's eye to the virtual floor, in metres. */
export const AR_LITE_FLOOR_DROP = 1.4;

/** Phone rear cameras are wider than the holo-table framing FOV. */
export const AR_LITE_FOV = 65;

/** Board scale limits for the AR Lite pinch gesture. */
export const AR_LITE_SCALE_MIN = 0.5;
export const AR_LITE_SCALE_MAX = 2;

/** How far in front of the viewer the board may be dropped, in metres. */
const MIN_REACH = 0.55;
const MAX_REACH = 4;
/** Used when the tap ray points at or above the horizon and never meets the floor. */
const FALLBACK_FORWARD = 1.6;

export async function isWebXrArSupported(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('xr' in navigator) || !navigator.xr) return false;
  try {
    return (await navigator.xr.isSessionSupported('immersive-ar')) === true;
  } catch {
    return false;
  }
}

/**
 * Feature-detects the AR Lite prerequisites: a camera we may ask for, an
 * orientation sensor API, a touch screen (the "is this a phone?" proxy that
 * keeps desktop Chrome — which *does* define DeviceOrientationEvent — out of
 * this tier) and a secure context.
 */
export function isArLiteCapable(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (window.isSecureContext === false) return false;
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return false;
  if (typeof window.DeviceOrientationEvent === 'undefined') return false;
  const touch = (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window;
  return touch;
}

export async function detectArTier(): Promise<ArTier> {
  if (await isWebXrArSupported()) return 'webxr';
  return isArLiteCapable() ? 'lite' : 'none';
}

// -- permissions -------------------------------------------------------------

type PermissionCapableCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied' | 'prompt'>;
};

/** iOS 13+ gates the motion sensors behind an explicit, gesture-bound prompt. */
export function needsOrientationPermission(): boolean {
  if (typeof window === 'undefined' || typeof window.DeviceOrientationEvent === 'undefined') {
    return false;
  }
  const ctor = window.DeviceOrientationEvent as PermissionCapableCtor;
  return typeof ctor.requestPermission === 'function';
}

/**
 * Resolves true when orientation events are allowed. MUST be *invoked* inside
 * the user gesture that starts AR — iOS rejects a call made after an await.
 */
export function requestOrientationPermission(): Promise<boolean> {
  if (!needsOrientationPermission()) return Promise.resolve(true);
  const ctor = window.DeviceOrientationEvent as PermissionCapableCtor;
  try {
    return Promise.resolve(ctor.requestPermission!())
      .then((state) => state === 'granted')
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

// -- camera stream -----------------------------------------------------------

export interface ArLiteSensors {
  stream: MediaStream;
  /** False when the device has motion sensors but the user refused them. */
  orientationGranted: boolean;
}

export class ArLiteError extends Error {
  constructor(
    message: string,
    /** Copy safe to show the player. */
    readonly notice: string,
  ) {
    super(message);
    this.name = 'ArLiteError';
  }
}

/**
 * Starts the orientation-permission prompt and the camera request *in the same
 * synchronous turn* so both keep the user-gesture grant that iOS requires.
 * Rejects with an {@link ArLiteError} carrying player-facing copy.
 */
export async function startArLiteSensors(): Promise<ArLiteSensors> {
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new ArLiteError('getUserMedia unavailable', 'This browser cannot open the camera.');
  }

  // Both promises are created before the first await — do not refactor into
  // sequential awaits, it silently breaks the iOS motion prompt.
  const orientation = requestOrientationPermission();
  const camera = navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });

  const [orientationResult, cameraResult] = await Promise.allSettled([orientation, camera]);

  if (cameraResult.status === 'rejected') {
    const err = cameraResult.reason as { name?: string } | undefined;
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    throw new ArLiteError(
      `getUserMedia failed: ${err?.name ?? 'unknown'}`,
      denied ? 'Camera access denied — showing the holo table.' : 'No camera available for AR.',
    );
  }

  const stream = cameraResult.value;
  const orientationGranted = orientationResult.status === 'fulfilled' && orientationResult.value;

  if (!orientationGranted) {
    stopStream(stream);
    throw new ArLiteError('orientation permission denied', 'Motion access denied — showing the holo table.');
  }

  return { stream, orientationGranted };
}

/** A fullscreen, cover-fit video that sits *behind* the transparent canvas. */
export function createCameraVideoElement(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', 'true');
  video.setAttribute('muted', '');
  video.setAttribute('autoplay', '');
  video.setAttribute('data-ar-lite-feed', '');
  video.disablePictureInPicture = true;
  Object.assign(video.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    // Negative index keeps it under the renderer canvas without having to
    // restyle a DOM node three.js owns. The host container is a positioned,
    // z-indexed stacking context, so this cannot leak behind the page.
    zIndex: '-1',
    pointerEvents: 'none',
    backgroundColor: '#000',
  } satisfies Partial<CSSStyleDeclaration>);
  return video;
}

export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already ended */
    }
  }
}

/** Detaches and hard-stops a camera video element (no lingering camera light). */
export function teardownCameraVideo(video: HTMLVideoElement | null | undefined): void {
  if (!video) return;
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  const stream = video.srcObject;
  if (stream instanceof MediaStream) stopStream(stream);
  video.srcObject = null;
  video.removeAttribute('src');
  video.remove();
}

// -- orientation -> camera quaternion ---------------------------------------

/**
 * The classic three.js `DeviceOrientationControls` transform: the device
 * reports an intrinsic ZXY euler in degrees, which becomes a YXZ euler for
 * three's coordinate system, then gets a -PI/2 X correction (the camera looks
 * out of the *back* of the phone, not the top) and a screen-orientation twist.
 */
export class DeviceOrientationTracker {
  private alpha = 0;
  private beta = 0;
  private gamma = 0;
  private screenAngle = 0;
  private received = false;
  private running = false;

  /** Yaw offset so the first reading looks straight down -Z instead of north. */
  private alphaOffset = 0;
  private offsetCaptured = false;

  private readonly zee = new THREE.Vector3(0, 0, 1);
  private readonly euler = new THREE.Euler();
  private readonly q0 = new THREE.Quaternion();
  /** -PI/2 about X. */
  private readonly q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

  private readonly onOrientation = (event: DeviceOrientationEvent) => {
    if (event.alpha === null && event.beta === null && event.gamma === null) return;
    this.alpha = event.alpha ?? 0;
    this.beta = event.beta ?? 0;
    this.gamma = event.gamma ?? 0;
    if (!this.offsetCaptured) {
      // Face the board the way the phone is already pointing.
      this.alphaOffset = -THREE.MathUtils.degToRad(this.alpha);
      this.offsetCaptured = true;
    }
    this.received = true;
  };

  private readonly onScreenOrientation = () => {
    this.screenAngle = readScreenAngle();
  };

  get hasReading(): boolean {
    return this.received;
  }

  start(): void {
    if (this.running || typeof window === 'undefined') return;
    this.running = true;
    this.screenAngle = readScreenAngle();
    window.addEventListener('deviceorientation', this.onOrientation, true);
    window.addEventListener('orientationchange', this.onScreenOrientation);
    window.screen?.orientation?.addEventListener?.('change', this.onScreenOrientation);
  }

  stop(): void {
    if (!this.running || typeof window === 'undefined') return;
    this.running = false;
    window.removeEventListener('deviceorientation', this.onOrientation, true);
    window.removeEventListener('orientationchange', this.onScreenOrientation);
    window.screen?.orientation?.removeEventListener?.('change', this.onScreenOrientation);
  }

  /** Resets the captured yaw so the next reading re-centres the view. */
  recentre(): void {
    this.offsetCaptured = false;
  }

  /** Writes the current device attitude into `out`. No-op before the first event. */
  applyTo(out: THREE.Quaternion): boolean {
    if (!this.received) return false;
    const alpha = THREE.MathUtils.degToRad(this.alpha) + this.alphaOffset;
    const beta = THREE.MathUtils.degToRad(this.beta);
    const gamma = THREE.MathUtils.degToRad(this.gamma);
    const orient = THREE.MathUtils.degToRad(this.screenAngle);

    // 'ZXY' on the device, 'YXZ' for us.
    this.euler.set(beta, alpha, -gamma, 'YXZ');
    out.setFromEuler(this.euler);
    out.multiply(this.q1);
    out.multiply(this.q0.setFromAxisAngle(this.zee, -orient));
    return true;
  }
}

function readScreenAngle(): number {
  if (typeof window === 'undefined') return 0;
  const fromApi = window.screen?.orientation?.angle;
  if (typeof fromApi === 'number') return fromApi;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

// -- virtual floor placement -------------------------------------------------

/**
 * Where a tap ray meets the virtual floor. Taps at or above the horizon (and
 * absurdly distant hits) are folded back to a comfortable arm's-length spot
 * instead of flinging the board to infinity.
 */
export function projectToVirtualFloor(
  ray: THREE.Ray,
  floorY: number,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const o = ray.origin;
  const d = ray.direction;
  let hit = false;

  if (d.y < -1e-4) {
    const t = (floorY - o.y) / d.y;
    if (t > 0 && Number.isFinite(t)) {
      out.copy(o).addScaledVector(d, t);
      hit = true;
    }
  }

  if (!hit) {
    const flatX = d.x;
    const flatZ = d.z;
    const len = Math.hypot(flatX, flatZ);
    if (len > 1e-6) {
      out.set(o.x + (flatX / len) * FALLBACK_FORWARD, floorY, o.z + (flatZ / len) * FALLBACK_FORWARD);
    } else {
      out.set(o.x, floorY, o.z - FALLBACK_FORWARD);
    }
  }

  // Clamp reach in the horizontal plane.
  const dx = out.x - o.x;
  const dz = out.z - o.z;
  const horiz = Math.hypot(dx, dz);
  const clamped = THREE.MathUtils.clamp(horiz, MIN_REACH, MAX_REACH);
  if (Math.abs(clamped - horiz) > 1e-6) {
    if (horiz > 1e-6) {
      out.x = o.x + (dx / horiz) * clamped;
      out.z = o.z + (dz / horiz) * clamped;
    } else {
      out.x = o.x;
      out.z = o.z - clamped;
    }
  }
  out.y = floorY;
  return out;
}
