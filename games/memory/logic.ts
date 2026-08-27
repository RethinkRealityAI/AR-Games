// ============================================================================
// Quantum Pairs — pure rules + AI.
//
// A turn-taking memory game. Tiles hide 3D artifacts; reveal two that match and
// you claim the pair and go again. Design decisions worth knowing:
//
//  • FAIRNESS. Every board has an ODD number of pairs, so a draw is impossible
//    and one player always wins outright. Who moves first is decided by a
//    rock-paper-scissors opener with hidden simultaneous commits (neither side
//    can react to the other's pick).
//
//  • A MISMATCH STAYS FACE-UP until the next player commits their first pick.
//    That removes any reaction-time advantage in memorising it — exactly like
//    the physical game, where the cards sit there while your opponent looks.
//
//  • NOVA PULSE. Once per game each player can reveal every unclaimed tile for
//    a beat. The reveal is public: it enters the shared history, so it arms the
//    opponent too. Spending it is a real decision, not a free win.
//
//  • HISTORY is the public record of what has been revealed, most-recent-last,
//    at most one entry per tile. It bounds session size, drives the AI's
//    recall model, and is honest to mask: it only ever holds tiles that both
//    players genuinely saw.
//
//  • MASKING. `maskCore` blanks the kind of every tile that has never been
//    revealed, so the server never ships a peekable board to either client.
// ============================================================================

import { Difficulty, GameCore, GameLogic, Move, PlayerSlot } from '../../types';

export type RpsPick = 'rock' | 'paper' | 'scissors';
export type MemoryTheme = 'cosmos' | 'chess' | 'gems';
export type MemorySize = 'skirmish' | 'standard' | 'odyssey';

/** Kind of a tile whose artifact this viewer has never been shown. */
export const HIDDEN = -1;

export interface SizeSpec {
  cols: number;
  rows: number;
  pairs: number;
  label: string;
  blurb: string;
}

/**
 * Tile counts are all ≡ 2 (mod 4), which makes the pair count odd — the reason
 * this game can never end in a draw.
 */
export const SIZES: Record<MemorySize, SizeSpec> = {
  skirmish: { cols: 5, rows: 2, pairs: 5, label: 'Skirmish', blurb: '10 tiles · a quick duel' },
  standard: { cols: 6, rows: 3, pairs: 9, label: 'Standard', blurb: '18 tiles · the classic' },
  odyssey: { cols: 6, rows: 5, pairs: 15, label: 'Odyssey', blurb: '30 tiles · the long haul' },
};

export const SIZE_IDS = Object.keys(SIZES) as MemorySize[];
export const THEME_IDS: MemoryTheme[] = ['cosmos', 'chess', 'gems'];

export const DEFAULT_SIZE: MemorySize = 'standard';
export const DEFAULT_THEME: MemoryTheme = 'cosmos';
export const DEFAULT_TURN_SECONDS = 0; // 0 = untimed
export const TURN_SECOND_CHOICES = [0, 5, 10, 15, 20];

export interface HistoryEntry {
  /** tile index */
  t: number;
  /** artifact kind */
  k: number;
}

export interface MemoryBoard {
  size: MemorySize;
  cols: number;
  rows: number;
  pairs: number;
  theme: MemoryTheme;
  /** artifact kind per tile, or HIDDEN when masked for a viewer */
  deck: number[];
  /** claimant per tile */
  owners: (PlayerSlot | null)[];
  /** tiles face-up right now: this turn's picks, or a pending mismatch */
  up: number[];
  /** true when `up` holds a settled mismatch awaiting the next pick */
  pendingClear: boolean;
  /** tiles a Nova Pulse is currently showing */
  pulse: number[] | null;
  pulseBy: PlayerSlot | null;
  scores: [number, number];
  /** Nova Pulses remaining per player */
  pulses: [number, number];
  /** public reveal log, most-recent-last, one entry per tile */
  history: HistoryEntry[];
  /** rock-paper-scissors opener */
  picks: [RpsPick | null, RpsPick | null];
  rpsRound: number;
  phase: 'rps' | 'play';
  /** per-turn limit in seconds; 0 = untimed */
  turnSeconds: number;
  /** the pair just claimed, for the scene's celebration */
  lastMatch: { tiles: [number, number]; slot: PlayerSlot } | null;
  /** set when the game ended because a majority was mathematically secured */
  clinched: boolean;
}

export interface MemoryConfig {
  size?: MemorySize;
  theme?: MemoryTheme;
  turnSeconds?: number;
}

type Rng = () => number;

const isSize = (v: unknown): v is MemorySize =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(SIZES, v);
const isTheme = (v: unknown): v is MemoryTheme =>
  typeof v === 'string' && (THEME_IDS as string[]).includes(v);

/** Fisher-Yates over one tile of each kind, twice. */
export function dealDeck(pairs: number, rng: Rng = Math.random): number[] {
  const deck: number[] = [];
  for (let k = 0; k < pairs; k++) deck.push(k, k);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function createMemoryBoard(cfg: MemoryConfig = {}, rng: Rng = Math.random): MemoryBoard {
  const size = isSize(cfg.size) ? cfg.size : DEFAULT_SIZE;
  const theme = isTheme(cfg.theme) ? cfg.theme : DEFAULT_THEME;
  const spec = SIZES[size];
  const turnSeconds =
    typeof cfg.turnSeconds === 'number' && TURN_SECOND_CHOICES.includes(cfg.turnSeconds)
      ? cfg.turnSeconds
      : DEFAULT_TURN_SECONDS;

  return {
    size,
    cols: spec.cols,
    rows: spec.rows,
    pairs: spec.pairs,
    theme,
    deck: dealDeck(spec.pairs, rng),
    owners: new Array(spec.cols * spec.rows).fill(null),
    up: [],
    pendingClear: false,
    pulse: null,
    pulseBy: null,
    scores: [0, 0],
    pulses: [1, 1],
    history: [],
    picks: [null, null],
    rpsRound: 1,
    phase: 'rps',
    turnSeconds,
    lastMatch: null,
    clinched: false,
  };
}

export function createMemoryCore(cfg: MemoryConfig = {}, rng: Rng = Math.random): GameCore {
  return {
    gameId: 'memory',
    board: createMemoryBoard(cfg, rng),
    currentSlot: 0,
    winner: null,
    winningCells: null,
    moveCount: 0,
  };
}

function cloneBoard(b: MemoryBoard): MemoryBoard {
  return {
    ...b,
    deck: b.deck.slice(),
    owners: b.owners.slice(),
    up: b.up.slice(),
    pulse: b.pulse ? b.pulse.slice() : null,
    scores: [b.scores[0], b.scores[1]],
    pulses: [b.pulses[0], b.pulses[1]],
    history: b.history.map((h) => ({ ...h })),
    picks: [b.picks[0], b.picks[1]],
    lastMatch: b.lastMatch ? { tiles: [...b.lastMatch.tiles], slot: b.lastMatch.slot } : null,
  };
}

const other = (s: PlayerSlot): PlayerSlot => (s === 0 ? 1 : 0);

/** Record a public reveal: one entry per tile, moved to the most-recent end. */
function remember(b: MemoryBoard, tile: number): void {
  const at = b.history.findIndex((h) => h.t === tile);
  if (at >= 0) b.history.splice(at, 1);
  b.history.push({ t: tile, k: b.deck[tile] });
}

const BEATS: Record<RpsPick, RpsPick> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

/** Tiles still in play (unclaimed). */
function unclaimed(b: MemoryBoard): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.owners.length; i++) if (b.owners[i] === null) out.push(i);
  return out;
}

/** Tiles locked by the current turn's picks (a pending mismatch does not lock). */
function lockedUp(b: MemoryBoard): number[] {
  return b.pendingClear ? [] : b.up;
}

/** Settle the game if someone has secured a majority or every pair is gone. */
function settle(core: GameCore, b: MemoryBoard): GameCore {
  const claimed = b.scores[0] + b.scores[1];
  let winner: GameCore['winner'] = null;
  let clinched = false;

  // Pair counts are always odd, so a strict majority is unassailable.
  if (b.scores[0] * 2 > b.pairs) {
    winner = 0;
    clinched = claimed < b.pairs;
  } else if (b.scores[1] * 2 > b.pairs) {
    winner = 1;
    clinched = claimed < b.pairs;
  } else if (claimed === b.pairs) {
    winner = b.scores[0] > b.scores[1] ? 0 : 1;
  }

  if (winner === null) return { ...core, board: b };

  b.clinched = clinched;
  const winningCells: number[] = [];
  for (let i = 0; i < b.owners.length; i++) if (b.owners[i] === winner) winningCells.push(i);
  return { ...core, board: b, winner, winningCells };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function applyRps(core: GameCore, b: MemoryBoard, pick: RpsPick, slot: PlayerSlot): GameCore | null {
  if (b.picks[slot] !== null) return null; // already committed this round
  b.picks[slot] = pick;

  const [a, z] = b.picks;
  if (a === null || z === null) {
    // Still waiting on the other player; the turn holder is meaningless here.
    return { ...core, board: b, moveCount: core.moveCount + 1 };
  }

  if (a === z) {
    b.picks = [null, null];
    b.rpsRound += 1;
    return { ...core, board: b, moveCount: core.moveCount + 1 };
  }

  const first: PlayerSlot = BEATS[a] === z ? 0 : 1;
  b.phase = 'play';
  return { ...core, board: b, currentSlot: first, moveCount: core.moveCount + 1 };
}

function applyTile(core: GameCore, b: MemoryBoard, tile: number, slot: PlayerSlot): GameCore | null {
  if (!Number.isInteger(tile) || tile < 0 || tile >= b.owners.length) return null;
  if (b.owners[tile] !== null) return null;
  if (lockedUp(b).includes(tile)) return null;

  // Committing a pick clears whatever the previous turn left showing.
  if (b.pendingClear) {
    b.up = [];
    b.pendingClear = false;
  }
  b.pulse = null;
  b.pulseBy = null;
  b.lastMatch = null;

  b.up.push(tile);
  remember(b, tile);

  if (b.up.length < 2) {
    return { ...core, board: b, moveCount: core.moveCount + 1 };
  }

  const [x, y] = b.up;
  if (b.deck[x] === b.deck[y]) {
    b.owners[x] = slot;
    b.owners[y] = slot;
    b.scores[slot] += 1;
    b.lastMatch = { tiles: [x, y], slot };
    b.up = [];
    // A match earns another turn.
    return settle({ ...core, board: b, moveCount: core.moveCount + 1 }, b);
  }

  // Mismatch: the pair stays face-up for the incoming player to study.
  b.pendingClear = true;
  return { ...core, board: b, currentSlot: other(slot), moveCount: core.moveCount + 1 };
}

function applyPulse(core: GameCore, b: MemoryBoard, slot: PlayerSlot): GameCore | null {
  if (b.pulses[slot] <= 0) return null;
  if (lockedUp(b).length > 0) return null; // only before this turn's first pick
  if (b.pulse) return null; // already pulsing

  const open = unclaimed(b);
  if (open.length === 0) return null;

  b.pulses[slot] -= 1;
  b.pulse = open;
  b.pulseBy = slot;
  // The reveal is public — it arms the opponent just as much.
  for (const t of open) remember(b, t);

  return { ...core, board: b, moveCount: core.moveCount + 1 };
}

function applyPass(core: GameCore, b: MemoryBoard, slot: PlayerSlot): GameCore | null {
  if (b.turnSeconds <= 0) return null; // no timer, nothing to expire
  b.up = [];
  b.pendingClear = false;
  b.pulse = null;
  b.pulseBy = null;
  b.lastMatch = null;
  return { ...core, board: b, currentSlot: other(slot), moveCount: core.moveCount + 1 };
}

function applyConfig(core: GameCore, b: MemoryBoard, cfg: NonNullable<Move['config']>): GameCore | null {
  if (b.phase !== 'play') {
    const next = createMemoryBoard({
      size: isSize(cfg.size) ? cfg.size : b.size,
      theme: isTheme(cfg.theme) ? cfg.theme : b.theme,
      turnSeconds: typeof cfg.turnSeconds === 'number' ? cfg.turnSeconds : b.turnSeconds,
    });
    // Settings can change mid-opener; the rock-paper-scissors state carries over.
    next.picks = [b.picks[0], b.picks[1]];
    next.rpsRound = b.rpsRound;
    return { ...core, board: next, winner: null, winningCells: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/** How far back this difficulty can recall the public reveal log. */
const RECALL: Record<Difficulty, number> = { easy: 3, medium: 8, hard: Number.POSITIVE_INFINITY };

/** What the AI believes about face-down tiles, plus everything currently visible. */
function recall(b: MemoryBoard, difficulty: Difficulty): Map<number, number> {
  const depth = RECALL[difficulty];
  const known = new Map<number, number>();
  const from = depth === Number.POSITIVE_INFINITY ? 0 : Math.max(0, b.history.length - depth);
  for (let i = from; i < b.history.length; i++) {
    const e = b.history[i];
    if (b.owners[e.t] === null) known.set(e.t, e.k);
  }
  // Anything face-up right now is simply visible.
  for (const t of b.up) if (b.owners[t] === null) known.set(t, b.deck[t]);
  if (b.pulse) for (const t of b.pulse) if (b.owners[t] === null) known.set(t, b.deck[t]);
  return known;
}

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

function aiTile(b: MemoryBoard, difficulty: Difficulty): number {
  const known = recall(b, difficulty);
  const locked = lockedUp(b);
  const open = unclaimed(b).filter((t) => !locked.includes(t));
  const unseen = open.filter((t) => !known.has(t));

  if (locked.length === 1) {
    // Second pick: close the pair if the partner's location is remembered.
    const want = b.deck[locked[0]];
    const partner = open.filter((t) => known.get(t) === want);
    if (partner.length) return pick(partner);
    return unseen.length ? pick(unseen) : pick(open);
  }

  // First pick: play a pair the AI can already see both halves of.
  const byKind = new Map<number, number[]>();
  for (const t of open) {
    const k = known.get(t);
    if (k === undefined) continue;
    const list = byKind.get(k);
    if (list) list.push(t);
    else byKind.set(k, [t]);
  }
  for (const list of byKind.values()) if (list.length >= 2) return list[0];

  return unseen.length ? pick(unseen) : pick(open);
}

function shouldPulse(b: MemoryBoard, slot: PlayerSlot, difficulty: Difficulty): boolean {
  if (difficulty === 'easy') return false;
  if (b.pulses[slot] <= 0 || b.pulse || lockedUp(b).length > 0) return false;

  const known = recall(b, difficulty);
  const open = unclaimed(b);
  if (open.length < 6) return false; // too late to be worth the tell

  // Only worth spending when the AI cannot already see a pair to take.
  const seen = new Map<number, number>();
  for (const t of open) {
    const k = known.get(t);
    if (k === undefined) continue;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const n of seen.values()) if (n >= 2) return false;

  return difficulty === 'hard' || Math.random() < 0.5;
}

// ---------------------------------------------------------------------------
// GameLogic
// ---------------------------------------------------------------------------

export const memoryLogic: GameLogic = {
  createCore(): GameCore {
    return createMemoryCore();
  },

  applyMove(core: GameCore, move: Move, slot: PlayerSlot): GameCore | null {
    if (core.winner !== null) return null;
    const b = cloneBoard(core.board as MemoryBoard);

    if (move.config) return applyConfig(core, b, move.config);

    if (b.phase === 'rps') {
      if (!move.rps || !(move.rps in BEATS)) return null;
      return applyRps(core, b, move.rps, slot);
    }

    // Only the turn holder acts once play begins.
    if (core.currentSlot !== slot) return null;
    if (move.pass) return applyPass(core, b, slot);
    if (move.pulse) return applyPulse(core, b, slot);
    if (typeof move.tile === 'number') return applyTile(core, b, move.tile, slot);
    return null;
  },

  legalMoves(core: GameCore): Move[] {
    if (core.winner !== null) return [];
    const b = core.board as MemoryBoard;

    if (b.phase === 'rps') {
      return (Object.keys(BEATS) as RpsPick[]).map((rps) => ({ rps }));
    }

    const locked = lockedUp(b);
    const moves: Move[] = unclaimed(b)
      .filter((t) => !locked.includes(t))
      .map((tile) => ({ tile }));
    if (b.pulses[core.currentSlot] > 0 && !b.pulse && locked.length === 0) moves.push({ pulse: true });
    if (b.turnSeconds > 0) moves.push({ pass: true });
    return moves;
  },

  aiMove(core: GameCore, slot: PlayerSlot, difficulty: Difficulty): Move {
    const b = core.board as MemoryBoard;
    if (b.phase === 'rps') return { rps: pick(['rock', 'paper', 'scissors'] as RpsPick[]) };
    if (shouldPulse(b, slot, difficulty)) return { pulse: true };
    return { tile: aiTile(b, difficulty) };
  },

  /**
   * Blank every tile this viewer has never been shown. History is deliberately
   * left intact: it only ever holds tiles both players already saw.
   */
  maskCore(core: GameCore, viewer: PlayerSlot): GameCore {
    const b = core.board as MemoryBoard;
    const visible = new Set<number>();
    for (let i = 0; i < b.owners.length; i++) if (b.owners[i] !== null) visible.add(i);
    for (const t of b.up) visible.add(t);
    if (b.pulse) for (const t of b.pulse) visible.add(t);
    for (const h of b.history) visible.add(h.t);
    if (core.winner !== null) for (let i = 0; i < b.deck.length; i++) visible.add(i);

    const masked: MemoryBoard = {
      ...cloneBoard(b),
      deck: b.deck.map((k, i) => (visible.has(i) ? k : HIDDEN)),
      // An undecided opener must not leak the opponent's committed pick.
      picks:
        b.phase === 'rps' && (b.picks[0] === null || b.picks[1] === null)
          ? ([viewer === 0 ? b.picks[0] : null, viewer === 1 ? b.picks[1] : null] as MemoryBoard['picks'])
          : [b.picks[0], b.picks[1]],
    };
    return { ...core, board: masked };
  },
};
