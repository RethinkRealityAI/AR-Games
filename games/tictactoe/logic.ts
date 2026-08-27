import { Difficulty, GameCore, GameLogic, Move, PlayerSlot } from '../../types';

/** Board: 9 cells, row-major, each PlayerSlot | null. */
export type TttBoard = (PlayerSlot | null)[];

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const other = (s: PlayerSlot): PlayerSlot => (s === 0 ? 1 : 0);

function findWinner(board: TttBoard): { winner: PlayerSlot | 'DRAW' | null; line: number[] | null } {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a] as PlayerSlot, line };
    }
  }
  if (board.every((c) => c !== null)) return { winner: 'DRAW', line: null };
  return { winner: null, line: null };
}

function createCore(): GameCore {
  return {
    gameId: 'tictactoe',
    board: Array(9).fill(null) as TttBoard,
    currentSlot: 0,
    winner: null,
    winningCells: null,
    moveCount: 0,
  };
}

function applyMove(core: GameCore, move: Move, slot: PlayerSlot): GameCore | null {
  const cell = move.cell;
  if (core.winner !== null) return null;
  if (slot !== core.currentSlot) return null;
  if (cell === undefined || cell < 0 || cell > 8 || !Number.isInteger(cell)) return null;
  const board = core.board as TttBoard;
  if (board[cell] !== null) return null;

  const next = board.slice();
  next[cell] = slot;
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
  const board = core.board as TttBoard;
  const moves: Move[] = [];
  board.forEach((c, i) => {
    if (c === null) moves.push({ cell: i });
  });
  return moves;
}

// --- AI -------------------------------------------------------------------

function winningCell(board: TttBoard, slot: PlayerSlot): number | null {
  for (let i = 0; i < 9; i++) {
    if (board[i] !== null) continue;
    const test = board.slice();
    test[i] = slot;
    if (findWinner(test).winner === slot) return i;
  }
  return null;
}

/** Perfect-play minimax. Small state space; no memo needed. */
function minimax(board: TttBoard, turn: PlayerSlot, me: PlayerSlot, depth: number): number {
  const { winner } = findWinner(board);
  if (winner === me) return 10 - depth;
  if (winner === 'DRAW') return 0;
  if (winner !== null) return depth - 10;

  let best = turn === me ? -Infinity : Infinity;
  for (let i = 0; i < 9; i++) {
    if (board[i] !== null) continue;
    board[i] = turn;
    const score = minimax(board, other(turn), me, depth + 1);
    board[i] = null;
    best = turn === me ? Math.max(best, score) : Math.min(best, score);
  }
  return best;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function aiMove(core: GameCore, slot: PlayerSlot, difficulty: Difficulty): Move {
  const board = (core.board as TttBoard).slice();
  const empty = board.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
  if (empty.length === 0) return { cell: 0 };

  if (difficulty === 'easy') {
    // Mostly random, occasionally takes an obvious win.
    const win = winningCell(board, slot);
    if (win !== null && Math.random() < 0.5) return { cell: win };
    return { cell: pickRandom(empty) };
  }

  if (difficulty === 'medium') {
    const win = winningCell(board, slot);
    if (win !== null) return { cell: win };
    const block = winningCell(board, other(slot));
    if (block !== null) return { cell: block };
    if (board[4] === null) return { cell: 4 };
    const corners = [0, 2, 6, 8].filter((i) => board[i] === null);
    if (corners.length > 0) return { cell: pickRandom(corners) };
    return { cell: pickRandom(empty) };
  }

  // hard: perfect play
  let bestScore = -Infinity;
  let bestCells: number[] = [];
  for (const i of empty) {
    board[i] = slot;
    const score = minimax(board, other(slot), slot, 0);
    board[i] = null;
    if (score > bestScore) {
      bestScore = score;
      bestCells = [i];
    } else if (score === bestScore) {
      bestCells.push(i);
    }
  }
  return { cell: pickRandom(bestCells) };
}

export const tictactoeLogic: GameLogic = { createCore, applyMove, legalMoves, aiMove };
