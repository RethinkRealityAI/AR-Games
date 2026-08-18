// ============================================================================
// SHARED PLATFORM CONTRACTS — see docs/ARCHITECTURE.md
// These shapes are shared between the client, the games, and the Netlify
// function. Do not change existing fields; adding optional fields is OK.
// ============================================================================

export type GameId = 'tictactoe' | 'connect4';

/** Slot 0 = host / X / first color. Slot 1 = guest / O / second color. */
export type PlayerSlot = 0 | 1;

export type GameMode = 'ai' | 'local' | 'online';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type AvatarType = 'ASTRONAUT' | 'DRONE' | 'CRYSTAL';

export interface PlayerProfile {
  name: string;
  avatarId: AvatarType;
  color: string; // hex, e.g. '#38bdf8'
}

/** Serializable move. Tic-tac-toe uses `cell` (0-8); Connect Four uses `column` (0-6). */
export interface Move {
  cell?: number;
  column?: number;
}

/** Platform-level game state. `board` is game-specific JSON; games cast it. */
export interface GameCore {
  gameId: GameId;
  board: unknown;
  currentSlot: PlayerSlot;
  winner: PlayerSlot | 'DRAW' | null;
  /** Cells/positions forming the winning line, in each game's own indexing. */
  winningCells: number[] | null;
  moveCount: number;
}

// ---------------------------------------------------------------------------
// Online sessions
// ---------------------------------------------------------------------------

export interface SessionPlayer {
  profile: PlayerProfile;
  connected: boolean;
  /** epoch ms of last poll/heartbeat (server-maintained) */
  lastSeen: number;
}

export interface ChatMessage {
  id: string;
  slot: PlayerSlot;
  name: string;
  text: string;
  at: number; // epoch ms
}

export type SessionStatus = 'waiting' | 'active' | 'finished';

export interface Session {
  code: string;
  gameId: GameId;
  status: SessionStatus;
  core: GameCore;
  players: [SessionPlayer, SessionPlayer | null];
  chat: ChatMessage[]; // server keeps the last 100
  /** Monotonic version, bumped on every mutation. Used for polling + optimistic writes. */
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Which slot starts the current round (rematch swaps it). */
  startingSlot: PlayerSlot;
  round: number;
}

// ---------------------------------------------------------------------------
// Network client interface (implemented by services/net.ts, consumed by UI)
// ---------------------------------------------------------------------------

export type NetEvent =
  | { type: 'session'; session: Session }
  | { type: 'chat'; messages: ChatMessage[] }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'connection'; online: boolean };

export interface NetClient {
  /** Current mirrored session (null before create/join). */
  readonly session: Session | null;
  /** This client's slot in the session. */
  readonly slot: PlayerSlot | null;

  createSession(gameId: GameId, profile: PlayerProfile): Promise<Session>;
  joinSession(code: string, profile: PlayerProfile): Promise<Session>;
  sendMove(move: Move): Promise<void>;
  sendChat(text: string): Promise<void>;
  requestRematch(): Promise<void>;
  leave(): Promise<void>;

  /** Subscribe to events; returns unsubscribe. Polling starts on create/join. */
  on(handler: (e: NetEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Game plug-in interface
// ---------------------------------------------------------------------------

export interface GameMeta {
  id: GameId;
  name: string;
  tagline: string;
  /** path under /assets for the landing card art */
  cardArt: string;
}

export interface GameLogic {
  createCore(): GameCore;
  /** Returns the next core, or null if the move is illegal. Pure. */
  applyMove(core: GameCore, move: Move, slot: PlayerSlot): GameCore | null;
  legalMoves(core: GameCore): Move[];
  /** Synchronous local AI. Must return a legal move. */
  aiMove(core: GameCore, slot: PlayerSlot, difficulty: Difficulty): Move;
}

export interface GameDefinition {
  meta: GameMeta;
  logic: GameLogic;
}
