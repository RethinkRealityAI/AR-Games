// ============================================================================
// Online session API — single Netlify Function mounted at /api/*
// See docs/ARCHITECTURE.md ("Online protocol") for the endpoint table.
//
// All routing + mutation logic lives in the exported `handleApi(req, store)` so
// it can be exercised against an in-memory store in tests. The default export
// wires it to the real Netlify Blobs store.
// ============================================================================

import type { Config, Context } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { GAMES } from '../../games/registry';
import type {
  AvatarType,
  ChatMessage,
  GameId,
  PlayerProfile,
  PlayerSlot,
  Session,
  SessionPlayer,
} from '../../types';

// ---------------------------------------------------------------------------
// Store abstraction — the subset of the Blobs API this function needs.
// ---------------------------------------------------------------------------

export interface StoreLike {
  get(key: string, opts: { type: 'json' }): Promise<unknown>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}

/** The stored document: a Session plus the two secret player tokens. */
interface StoredSession extends Session {
  tokens: [string, string];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_ATTEMPTS = 12;

/** A colliding blob older than this is considered abandoned and reusable. */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;
/** Heartbeat writes are throttled to at most one per player per this window. */
const HEARTBEAT_WRITE_MS = 5_000;
/** A player whose lastSeen is older than this is reported as disconnected. */
const PRESENCE_TIMEOUT_MS = 15_000;

const MAX_CHAT = 100;
const MAX_CHAT_LEN = 280;
const MAX_NAME_LEN = 14;

const AVATARS: AvatarType[] = ['ASTRONAUT', 'DRONE', 'CRYSTAL', 'ROCKET', 'SATURN', 'COMET'];
const GAME_IDS = Object.keys(GAMES) as GameId[];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_PROFILE: PlayerProfile = {
  name: 'Player',
  avatarId: 'ASTRONAUT',
  color: '#38bdf8',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fail = (message: string, status: number) => json({ error: message }, status);

/**
 * Strip secrets. Every response body passes through this — tokens never leak.
 *
 * Games with concealed state (Quantum Pairs' face-down tiles) also get their
 * core masked for `viewer`, so a client can never read the board out of the
 * network response. A null viewer is an unauthenticated poller and is masked
 * from both seats' perspectives.
 */
export function publicSession(s: StoredSession, viewer: PlayerSlot | null): Session {
  const { tokens: _tokens, ...rest } = s;
  const mask = GAMES[rest.gameId]?.logic.maskCore;
  if (!mask) return rest;
  const core =
    viewer === null ? mask(mask(rest.core, 0), 1) : mask(rest.core, viewer);
  return { ...rest, core };
}

function randomCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function sanitizeProfile(raw: unknown): PlayerProfile {
  const p = (raw ?? {}) as Partial<PlayerProfile>;

  let name = typeof p.name === 'string' ? p.name.trim() : '';
  if (name.length === 0) name = DEFAULT_PROFILE.name;
  if (name.length > MAX_NAME_LEN) name = name.slice(0, MAX_NAME_LEN);

  const color =
    typeof p.color === 'string' && HEX_COLOR.test(p.color) ? p.color : DEFAULT_PROFILE.color;

  const avatarId =
    typeof p.avatarId === 'string' && (AVATARS as string[]).includes(p.avatarId)
      ? (p.avatarId as AvatarType)
      : DEFAULT_PROFILE.avatarId;

  return { name, avatarId, color };
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function loadSession(store: StoreLike, code: string): Promise<StoredSession | null> {
  const raw = await store.get(code, { type: 'json' });
  if (!raw || typeof raw !== 'object') return null;
  return raw as StoredSession;
}

/** Resolve which slot a token belongs to, or null if it matches neither. */
function slotForToken(s: StoredSession, token: unknown): PlayerSlot | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  if (token === s.tokens[0]) return 0;
  if (token === s.tokens[1]) return 1;
  return null;
}

/**
 * Recompute `connected` from `lastSeen`. Mutates in place and returns whether
 * anything changed, so callers can decide whether a write is warranted.
 */
function refreshPresence(s: StoredSession, now: number): boolean {
  let changed = false;
  for (const player of s.players) {
    if (!player) continue;
    const alive = now - player.lastSeen <= PRESENCE_TIMEOUT_MS;
    if (player.connected !== alive) {
      player.connected = alive;
      changed = true;
    }
  }
  return changed;
}

function newPlayer(profile: PlayerProfile, now: number): SessionPlayer {
  return { profile, connected: true, lastSeen: now };
}

/** Bump version + updatedAt. Called by every mutation before it writes. */
function touch(s: StoredSession, now: number): void {
  s.version += 1;
  s.updatedAt = now;
}

function newToken(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function createSession(req: Request, store: StoreLike): Promise<Response> {
  const body = await readBody(req);
  if (!body) return fail('Malformed JSON body', 400);

  const gameId = body.gameId;
  if (typeof gameId !== 'string' || !(GAME_IDS as string[]).includes(gameId)) {
    return fail('Unknown gameId', 400);
  }

  const now = Date.now();
  const profile = sanitizeProfile(body.profile);

  // Find a free code. A colliding blob older than 24h is treated as abandoned
  // and overwritten — this is our lazy TTL cleanup.
  let code: string | null = null;
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const candidate = randomCode();
    const existing = await loadSession(store, candidate);
    if (!existing || now - (existing.updatedAt ?? 0) > STALE_SESSION_MS) {
      code = candidate;
      break;
    }
  }
  if (code === null) return fail('Could not allocate a room code, please retry', 503);

  const tokens: [string, string] = [newToken(), newToken()];

  const session: StoredSession = {
    code,
    gameId: gameId as GameId,
    status: 'waiting',
    core: GAMES[gameId as GameId].logic.createCore(),
    players: [newPlayer(profile, now), null],
    chat: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    startingSlot: 0,
    round: 1,
    tokens,
  };

  await store.setJSON(code, session);
  return json({ code, token: tokens[0], session: publicSession(session, 0) }, 201);
}

async function joinSession(req: Request, store: StoreLike, code: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return fail('Malformed JSON body', 400);

  const session = await loadSession(store, code);
  if (!session) return fail('Room not found', 404);

  const now = Date.now();
  refreshPresence(session, now);

  // Occupied only counts if the seat's owner is still around; a guest who
  // dropped off frees the seat for a reconnect.
  if (session.players[1] && session.players[1].connected) {
    return fail('Room is full', 409);
  }

  const profile = sanitizeProfile(body.profile);
  session.players[1] = newPlayer(profile, now);
  // A rematch-in-progress or finished board keeps its status; a fresh room goes active.
  if (session.status === 'waiting') session.status = 'active';
  touch(session, now);

  await store.setJSON(code, session);
  return json({ token: session.tokens[1], session: publicSession(session, 1) });
}

async function getSession(req: Request, store: StoreLike, code: string): Promise<Response> {
  const session = await loadSession(store, code);
  if (!session) return fail('Room not found', 404);

  const url = new URL(req.url);
  const now = Date.now();

  // The poll doubles as a heartbeat.
  //
  // Two kinds of change can come out of a GET, and they are treated very
  // differently:
  //
  //  * a `connected` flag flipping (either direction) is real, observable state
  //    — it bumps `version` and is persisted immediately, so the peer's next
  //    poll actually reports "opponent left" / "opponent is back". Flips are
  //    rare, so this costs at most one write per transition.
  //  * a plain `lastSeen` refresh is bookkeeping. It is persisted at most once
  //    per HEARTBEAT_WRITE_MS per player and never bumps `version`, so two
  //    clients polling every 1.5s cannot cause a write storm or invalidate each
  //    other's cached view.
  const slot = slotForToken(session, url.searchParams.get('t'));
  let presenceFlip = false;
  let heartbeatWrite = false;

  if (slot !== null) {
    const me = session.players[slot];
    if (me) {
      if (!me.connected) {
        me.connected = true;
        me.lastSeen = now;
        presenceFlip = true;
      } else if (now - me.lastSeen >= HEARTBEAT_WRITE_MS) {
        me.lastSeen = now;
        heartbeatWrite = true;
      }
    }
  }

  // Presence decay is computed on read, so a silent peer is noticed even though
  // it is not around to report its own absence.
  if (refreshPresence(session, now)) presenceFlip = true;

  if (presenceFlip) touch(session, now);
  if (presenceFlip || heartbeatWrite) {
    session.updatedAt = now;
    await store.setJSON(code, session);
  }

  const clientVersion = Number(url.searchParams.get('v'));
  if (Number.isFinite(clientVersion) && clientVersion === session.version) {
    return json({ unchanged: true, version: session.version });
  }

  return json({ session: publicSession(session, slot) });
}

async function postMove(req: Request, store: StoreLike, code: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return fail('Malformed JSON body', 400);

  const session = await loadSession(store, code);
  if (!session) return fail('Room not found', 404);

  const slot = slotForToken(session, body.token);
  if (slot === null) return fail('Invalid player token', 401);

  if (body.expectedVersion !== session.version) {
    return json({ error: 'Version conflict', session: publicSession(session, slot) }, 409);
  }

  if (session.status !== 'active') return fail('Game is not accepting moves', 400);

  const move = body.move;
  if (!move || typeof move !== 'object' || Array.isArray(move)) {
    return fail('Illegal move', 400);
  }

  const next = GAMES[session.gameId].logic.applyMove(session.core, move, slot);
  if (next === null) return fail('Illegal move', 400);

  const now = Date.now();
  session.core = next;
  if (next.winner !== null) session.status = 'finished';

  const me = session.players[slot];
  if (me) {
    me.lastSeen = now;
    me.connected = true;
  }
  refreshPresence(session, now);
  touch(session, now);

  await store.setJSON(code, session);
  return json({ session: publicSession(session, slot) });
}

async function postChat(req: Request, store: StoreLike, code: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return fail('Malformed JSON body', 400);

  const session = await loadSession(store, code);
  if (!session) return fail('Room not found', 404);

  const slot = slotForToken(session, body.token);
  if (slot === null) return fail('Invalid player token', 401);

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length === 0) return fail('Message is empty', 400);
  if (text.length > MAX_CHAT_LEN) return fail('Message is too long', 400);

  const now = Date.now();
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    slot,
    name: session.players[slot]?.profile.name ?? 'Player',
    text,
    at: now,
  };

  session.chat = [...session.chat, message].slice(-MAX_CHAT);

  const me = session.players[slot];
  if (me) {
    me.lastSeen = now;
    me.connected = true;
  }
  refreshPresence(session, now);
  touch(session, now);

  await store.setJSON(code, session);
  return json({ session: publicSession(session, slot) });
}

async function postRematch(req: Request, store: StoreLike, code: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return fail('Malformed JSON body', 400);

  const session = await loadSession(store, code);
  if (!session) return fail('Room not found', 404);

  const slot = slotForToken(session, body.token);
  if (slot === null) return fail('Invalid player token', 401);

  if (session.status !== 'finished') return fail('Rematch is only available once a game ends', 409);

  const now = Date.now();
  const startingSlot: PlayerSlot = session.startingSlot === 0 ? 1 : 0;
  const core = GAMES[session.gameId].logic.createCore();
  core.currentSlot = startingSlot;

  session.core = core;
  session.startingSlot = startingSlot;
  session.round += 1;
  session.status = 'active';

  const me = session.players[slot];
  if (me) {
    me.lastSeen = now;
    me.connected = true;
  }
  refreshPresence(session, now);
  touch(session, now);

  await store.setJSON(code, session);
  return json({ session: publicSession(session, slot) });
}

async function postLeave(req: Request, store: StoreLike, code: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return fail('Malformed JSON body', 400);

  const session = await loadSession(store, code);
  if (!session) return fail('Room not found', 404);

  const slot = slotForToken(session, body.token);
  if (slot === null) return fail('Invalid player token', 401);

  const now = Date.now();
  const me = session.players[slot];
  if (me) {
    me.connected = false;
    // Backdate so presence recomputation on the peer's next poll agrees.
    me.lastSeen = now - PRESENCE_TIMEOUT_MS - 1;
  }
  // Status is deliberately left alone; the peer surfaces "opponent left" from presence.
  touch(session, now);

  await store.setJSON(code, session);
  return json({ session: publicSession(session, slot) });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Pure-ish request router. Everything it touches goes through `store`, so tests
 * can hand it an in-memory Map-backed implementation.
 */
export async function handleApi(req: Request, store: StoreLike): Promise<Response> {
  let segments: string[];
  try {
    segments = new URL(req.url).pathname.split('/').filter(Boolean);
  } catch {
    return fail('Bad request URL', 400);
  }

  // Expect: api / session [ / :code [ / action ] ]
  if (segments[0] !== 'api' || segments[1] !== 'session') return fail('Not found', 404);

  const method = req.method.toUpperCase();

  // /api/session
  if (segments.length === 2) {
    if (method !== 'POST') return fail('Method not allowed', 405);
    return createSession(req, store);
  }

  const code = (segments[2] ?? '').toUpperCase();
  if (code.length !== CODE_LENGTH) return fail('Room not found', 404);

  // /api/session/:code
  if (segments.length === 3) {
    if (method !== 'GET') return fail('Method not allowed', 405);
    return getSession(req, store, code);
  }

  // /api/session/:code/:action
  if (segments.length === 4) {
    const action = segments[3];
    const routes: Record<string, (r: Request, s: StoreLike, c: string) => Promise<Response>> = {
      join: joinSession,
      move: postMove,
      chat: postChat,
      rematch: postRematch,
      leave: postLeave,
    };
    const handler = routes[action];
    if (!handler) return fail('Not found', 404);
    if (method !== 'POST') return fail('Method not allowed', 405);
    return handler(req, store, code);
  }

  return fail('Not found', 404);
}

// ---------------------------------------------------------------------------
// Netlify entrypoint
// ---------------------------------------------------------------------------

export default async (req: Request, _context: Context): Promise<Response> => {
  const store = getStore({ name: 'sessions', consistency: 'strong' }) as unknown as StoreLike;
  try {
    return await handleApi(req, store);
  } catch (err) {
    console.error('api error', err);
    return fail('Internal error', 500);
  }
};

export const config: Config = { path: '/api/*' };
