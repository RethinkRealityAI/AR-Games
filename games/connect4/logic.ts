import { Difficulty, GameCore, GameLogic, Move, PlayerSlot } from '../../types';

export const COLS = 7;
export const ROWS = 6;

/**
 * Board: flat array of 42 cells, index = row * COLS + col.
 * Row 0 is the BOTTOM row (discs stack upward).
 */
export type C4Board = (PlayerSlot | null)[];

export const cellIndex = (row: number, col: number) => row * COLS + col;

const other = (s: PlayerSlot): PlayerSlot => (s === 0 ? 1 : 0);

/** All 69 winning windows of 4, precomputed as flat indices. */
const WINDOWS: number[][] = (() => {
  const w: number[][] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (c + 3 < COLS) w.push([0, 1, 2, 3].map((i) => cellIndex(r, c + i)));
      if (r + 3 < ROWS) w.push([0, 1, 2, 3].map((i) => cellIndex(r + i, c)));
      if (c + 3 < COLS && r + 3 < ROWS) w.push([0, 1, 2, 3].map((i) => cellIndex(r + i, c + i)));
      if (c - 3 >= 0 && r + 3 < ROWS) w.push([0, 1, 2, 3].map((i) => cellIndex(r + i, c - i)));
    }
  }
  return w;
})();

function findWinner(board: C4Board): { winner: PlayerSlot | 'DRAW' | null; line: number[] | null } {
  for (const win of WINDOWS) {
    const v = board[win[0]];
    if (v !== null && v === board[win[1]] && v === board[win[2]] && v === board[win[3]]) {
      return { winner: v, line: win };
    }
  }
  if (board.every((c) => c !== null)) return { winner: 'DRAW', line: null };
  return { winner: null, line: null };
}

/** Lowest empty row in a column, or -1 if full. */
export function dropRow(board: C4Board, col: number): number {
  for (let r = 0; r < ROWS; r++) {
    if (board[cellIndex(r, col)] === null) return r;
  }
  return -1;
}

function createCore(): GameCore {
  return {
    gameId: 'connect4',
    board: Array(ROWS * COLS).fill(null) as C4Board,
    currentSlot: 0,
    winner: null,
    winningCells: null,
    moveCount: 0,
  };
}

function applyMove(core: GameCore, move: Move, slot: PlayerSlot): GameCore | null {
  const col = move.column;
  if (core.winner !== null) return null;
  if (slot !== core.currentSlot) return null;
  if (col === undefined || col < 0 || col >= COLS || !Number.isInteger(col)) return null;
  const board = core.board as C4Board;
  const row = dropRow(board, col);
  if (row < 0) return null;

  const next = board.slice();
  next[cellIndex(row, col)] = slot;
  const { winner, line } = findWinner(next);
  return {
    ...core,
    board: next,
    currentSlot: other(slot),
    winner,
    winningCells: line,
    moveCount: core.moveCount + 1,
  };
}

function legalMoves(core: GameCore): Move[] {
  if (core.winner !== null) return [];
  const board = core.board as C4Board;
  const moves: Move[] = [];
  for (let c = 0; c < COLS; c++) {
    if (dropRow(board, c) >= 0) moves.push({ column: c });
  }
  return moves;
}

// --- AI: negamax with alpha-beta ------------------------------------------

/** Column search order, center-out — dramatically improves pruning. */
const ORDER = [3, 2, 4, 1, 5, 0, 6];

/** Heuristic score of a position from `me`'s perspective. */
function evaluate(board: C4Board, me: PlayerSlot): number {
  let score = 0;
  // Center-column control.
  for (let r = 0; r < ROWS; r++) {
    const v = board[cellIndex(r, 3)];
    if (v === me) score += 3;
    else if (v !== null) score -= 3;
  }
  // Window potentials.
  for (const win of WINDOWS) {
    let mine = 0;
    let theirs = 0;
    for (const idx of win) {
      const v = board[idx];
      if (v === me) mine++;
      else if (v !== null) theirs++;
    }
    if (mine > 0 && theirs > 0) continue;
    if (mine === 3) score += 60;
    else if (mine === 2) score += 8;
    if (theirs === 3) score -= 80;
    else if (theirs === 2) score -= 8;
  }
  return score;
}

const WIN_SCORE = 1_000_000;

function negamax(
  board: C4Board,
  turn: PlayerSlot,
  me: PlayerSlot,
  depth: number,
  alpha: number,
  beta: number,
): number {
  const { winner } = findWinner(board);
  if (winner !== null) {
    if (winner === 'DRAW') return 0;
    // The player who just moved won; from `turn`'s perspective this is a loss.
    return winner === turn ? WIN_SCORE + depth : -(WIN_SCORE + depth);
  }
  if (depth === 0) {
    const e = evaluate(board, me);
    return turn === me ? e : -e;
  }

  let best = -Infinity;
  for (const col of ORDER) {
    const row = dropRow(board, col);
    if (row < 0) continue;
    const idx = cellIndex(row, col);
    board[idx] = turn;
    const score = -negamax(board, other(turn), me, depth - 1, -beta, -alpha);
    board[idx] = null;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Column that wins immediately for `slot`, or null. */
function immediateWin(board: C4Board, slot: PlayerSlot): number | null {
  for (const col of ORDER) {
    const row = dropRow(board, col);
    if (row < 0) continue;
    const idx = cellIndex(row, col);
    board[idx] = slot;
    const won = findWinner(board).winner === slot;
    board[idx] = null;
    if (won) return col;
  }
  return null;
}

function aiMove(core: GameCore, slot: PlayerSlot, difficulty: Difficulty): Move {
  const board = (core.board as C4Board).slice();
  const legal = ORDER.filter((c) => dropRow(board, c) >= 0);
  if (legal.length === 0) return { column: 3 };

  // Always take an immediate win; block an immediate loss (all difficulties
  // above easy — easy only sometimes notices).
  const win = immediateWin(board, slot);
  const block = immediateWin(board, other(slot));

  if (difficulty === 'easy') {
    if (win !== null && Math.random() < 0.6) return { column: win };
    if (block !== null && Math.random() < 0.4) return { column: block };
    // Center-biased random.
    const weighted = legal.flatMap((c) => Array(4 - Math.min(3, Math.abs(3 - c))).fill(c));
    return { column: pickRandom(weighted) };
  }

  if (win !== null) return { column: win };
  if (block !== null) return { column: block };

  const depth = difficulty === 'medium' ? 4 : 7;
  let bestScore = -Infinity;
  let bestCols: number[] = [];
  for (const col of legal) {
    const row = dropRow(board, col);
    const idx = cellIndex(row, col);
    board[idx] = slot;
    const score = -negamax(board, other(slot), slot, depth - 1, -Infinity, Infinity);
    board[idx] = null;
    if (score > bestScore) {
      bestScore = score;
      bestCols = [col];
    } else if (score === bestScore) {
      bestCols.push(col);
    }
  }
  return { column: pickRandom(bestCols) };
}

export const connect4Logic: GameLogic = { createCore, applyMove, legalMoves, aiMove };
