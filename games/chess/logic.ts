// ============================================================================
// Chess — pure rules + synchronous AI.
// Board: 64 squares, a1 = 0 … h8 = 63 (index = rank * 8 + file).
// Slot 0 = white, slot 1 = black. Pieces are 2-char codes: 'wP', 'bK', …
// ============================================================================

import { Difficulty, GameCore, GameLogic, Move, PlayerSlot } from '../../types';

export type PieceCode =
  | 'wP' | 'wN' | 'wB' | 'wR' | 'wQ' | 'wK'
  | 'bP' | 'bN' | 'bB' | 'bR' | 'bQ' | 'bK';

export interface ChessBoard {
  squares: (PieceCode | null)[];
  castling: { wk: boolean; wq: boolean; bk: boolean; bq: boolean };
  /** en-passant target square (the square a capturing pawn lands on), or null */
  ep: number | null;
  /** half-move clock for the 50-move rule */
  halfmove: number;
  /** last move played, for scene highlighting */
  lastMove: { from: number; to: number } | null;
  /** square of a king currently in check (for UI), or null */
  checkSquare: number | null;
}

export const FILE = (sq: number) => sq % 8;
export const RANK = (sq: number) => Math.floor(sq / 8);
export const SQ = (rank: number, file: number) => rank * 8 + file;

const colorOf = (p: PieceCode): PlayerSlot => (p[0] === 'w' ? 0 : 1);
const kindOf = (p: PieceCode) => p[1] as 'P' | 'N' | 'B' | 'R' | 'Q' | 'K';

function initialSquares(): (PieceCode | null)[] {
  const s: (PieceCode | null)[] = new Array(64).fill(null);
  const order = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'] as const;
  for (let f = 0; f < 8; f++) {
    s[SQ(0, f)] = ('w' + order[f]) as PieceCode;
    s[SQ(1, f)] = 'wP';
    s[SQ(6, f)] = 'bP';
    s[SQ(7, f)] = ('b' + order[f]) as PieceCode;
  }
  return s;
}

function cloneBoard(b: ChessBoard): ChessBoard {
  return {
    squares: b.squares.slice(),
    castling: { ...b.castling },
    ep: b.ep,
    halfmove: b.halfmove,
    lastMove: b.lastMove ? { ...b.lastMove } : null,
    checkSquare: b.checkSquare,
  };
}

const KNIGHT_D = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_D = [
  [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
];
const BISHOP_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Is `sq` attacked by pieces of color `by`? */
export function isAttacked(squares: (PieceCode | null)[], sq: number, by: PlayerSlot): boolean {
  const r = RANK(sq);
  const f = FILE(sq);
  const c = by === 0 ? 'w' : 'b';
  // Pawns (white attacks upward, so a white pawn sits one rank BELOW its target)
  const pr = by === 0 ? r - 1 : r + 1;
  if (pr >= 0 && pr < 8) {
    for (const df of [-1, 1]) {
      const pf = f + df;
      if (pf >= 0 && pf < 8 && squares[SQ(pr, pf)] === c + 'P') return true;
    }
  }
  // Knights
  for (const [dr, df] of KNIGHT_D) {
    const nr = r + dr;
    const nf = f + df;
    if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && squares[SQ(nr, nf)] === c + 'N') return true;
  }
  // King
  for (const [dr, df] of KING_D) {
    const nr = r + dr;
    const nf = f + df;
    if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && squares[SQ(nr, nf)] === c + 'K') return true;
  }
  // Sliders
  for (const [dr, df] of BISHOP_D) {
    let nr = r + dr;
    let nf = f + df;
    while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
      const p = squares[SQ(nr, nf)];
      if (p) {
        if (p === c + 'B' || p === c + 'Q') return true;
        break;
      }
      nr += dr;
      nf += df;
    }
  }
  for (const [dr, df] of ROOK_D) {
    let nr = r + dr;
    let nf = f + df;
    while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
      const p = squares[SQ(nr, nf)];
      if (p) {
        if (p === c + 'R' || p === c + 'Q') return true;
        break;
      }
      nr += dr;
      nf += df;
    }
  }
  return false;
}

function kingSquare(squares: (PieceCode | null)[], slot: PlayerSlot): number {
  const k = (slot === 0 ? 'wK' : 'bK') as PieceCode;
  for (let i = 0; i < 64; i++) if (squares[i] === k) return i;
  return -1;
}

interface RawMove {
  from: number;
  to: number;
  promotion?: 'q' | 'r' | 'b' | 'n';
  /** square of the pawn captured en passant (differs from `to`) */
  epCapture?: number;
  castle?: 'k' | 'q';
  double?: boolean;
}

function pseudoMoves(b: ChessBoard, slot: PlayerSlot): RawMove[] {
  const out: RawMove[] = [];
  const c = slot === 0 ? 'w' : 'b';
  const dir = slot === 0 ? 1 : -1;
  const startRank = slot === 0 ? 1 : 6;
  const promoRank = slot === 0 ? 7 : 0;
  const { squares } = b;

  const pushPawn = (from: number, to: number, epCapture?: number, double?: boolean) => {
    if (RANK(to) === promoRank) {
      for (const promotion of ['q', 'r', 'b', 'n'] as const) out.push({ from, to, promotion });
    } else {
      out.push({ from, to, epCapture, double });
    }
  };

  for (let from = 0; from < 64; from++) {
    const p = squares[from];
    if (!p || p[0] !== c) continue;
    const r = RANK(from);
    const f = FILE(from);
    const kind = kindOf(p);

    if (kind === 'P') {
      const one = SQ(r + dir, f);
      if (r + dir >= 0 && r + dir < 8 && !squares[one]) {
        pushPawn(from, one);
        const two = SQ(r + dir * 2, f);
        if (r === startRank && !squares[two]) pushPawn(from, two, undefined, true);
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        const nr = r + dir;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = SQ(nr, nf);
        const target = squares[to];
        if (target && target[0] !== c) pushPawn(from, to);
        else if (b.ep === to) pushPawn(from, to, SQ(r, nf));
      }
    } else if (kind === 'N' || kind === 'K') {
      const deltas = kind === 'N' ? KNIGHT_D : KING_D;
      for (const [dr, df] of deltas) {
        const nr = r + dr;
        const nf = f + df;
        if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
        const to = SQ(nr, nf);
        const target = squares[to];
        if (!target || target[0] !== c) out.push({ from, to });
      }
      if (kind === 'K') {
        const home = slot === 0 ? 0 : 7;
        const enemy: PlayerSlot = slot === 0 ? 1 : 0;
        const rightsK = slot === 0 ? b.castling.wk : b.castling.bk;
        const rightsQ = slot === 0 ? b.castling.wq : b.castling.bq;
        if (from === SQ(home, 4) && !isAttacked(squares, from, enemy)) {
          if (
            rightsK &&
            !squares[SQ(home, 5)] && !squares[SQ(home, 6)] &&
            squares[SQ(home, 7)] === c + 'R' &&
            !isAttacked(squares, SQ(home, 5), enemy) &&
            !isAttacked(squares, SQ(home, 6), enemy)
          ) {
            out.push({ from, to: SQ(home, 6), castle: 'k' });
          }
          if (
            rightsQ &&
            !squares[SQ(home, 3)] && !squares[SQ(home, 2)] && !squares[SQ(home, 1)] &&
            squares[SQ(home, 0)] === c + 'R' &&
            !isAttacked(squares, SQ(home, 3), enemy) &&
            !isAttacked(squares, SQ(home, 2), enemy)
          ) {
            out.push({ from, to: SQ(home, 2), castle: 'q' });
          }
        }
      }
    } else {
      const deltas = kind === 'B' ? BISHOP_D : kind === 'R' ? ROOK_D : KING_D; // Q uses all 8
      for (const [dr, df] of deltas) {
        let nr = r + dr;
        let nf = f + df;
        while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
          const to = SQ(nr, nf);
          const target = squares[to];
          if (!target) out.push({ from, to });
          else {
            if (target[0] !== c) out.push({ from, to });
            break;
          }
          nr += dr;
          nf += df;
        }
      }
    }
  }
  return out;
}

/** Apply a raw move to a cloned board. Does NOT check legality. */
function applyRaw(b: ChessBoard, m: RawMove, slot: PlayerSlot): ChessBoard {
  const nb = cloneBoard(b);
  const { squares } = nb;
  const p = squares[m.from]!;
  const c = slot === 0 ? 'w' : 'b';
  const isPawn = kindOf(p) === 'P';
  const isCapture = !!squares[m.to] || m.epCapture !== undefined;

  squares[m.to] = m.promotion ? ((c + m.promotion.toUpperCase()) as PieceCode) : p;
  squares[m.from] = null;
  if (m.epCapture !== undefined) squares[m.epCapture] = null;

  if (m.castle) {
    const home = slot === 0 ? 0 : 7;
    if (m.castle === 'k') {
      squares[SQ(home, 5)] = squares[SQ(home, 7)];
      squares[SQ(home, 7)] = null;
    } else {
      squares[SQ(home, 3)] = squares[SQ(home, 0)];
      squares[SQ(home, 0)] = null;
    }
  }

  // Castling rights
  if (p === 'wK') { nb.castling.wk = false; nb.castling.wq = false; }
  if (p === 'bK') { nb.castling.bk = false; nb.castling.bq = false; }
  for (const sq of [m.from, m.to]) {
    if (sq === SQ(0, 0)) nb.castling.wq = false;
    if (sq === SQ(0, 7)) nb.castling.wk = false;
    if (sq === SQ(7, 0)) nb.castling.bq = false;
    if (sq === SQ(7, 7)) nb.castling.bk = false;
  }

  nb.ep = m.double ? SQ(RANK(m.from) + (slot === 0 ? 1 : -1), FILE(m.from)) : null;
  nb.halfmove = isPawn || isCapture ? 0 : nb.halfmove + 1;
  nb.lastMove = { from: m.from, to: m.to };
  return nb;
}

function legalRawMoves(b: ChessBoard, slot: PlayerSlot): RawMove[] {
  const enemy: PlayerSlot = slot === 0 ? 1 : 0;
  return pseudoMoves(b, slot).filter((m) => {
    const nb = applyRaw(b, m, slot);
    return !isAttacked(nb.squares, kingSquare(nb.squares, slot), enemy);
  });
}

function insufficientMaterial(squares: (PieceCode | null)[]): boolean {
  const minors: string[] = [];
  for (const p of squares) {
    if (!p) continue;
    const k = kindOf(p);
    if (k === 'K') continue;
    if (k === 'P' || k === 'R' || k === 'Q') return false;
    minors.push(p);
  }
  return minors.length <= 1;
}

function finish(core: GameCore, board: ChessBoard, moverSlot: PlayerSlot): GameCore {
  const next: PlayerSlot = moverSlot === 0 ? 1 : 0;
  const inCheck = isAttacked(board.squares, kingSquare(board.squares, next), moverSlot);
  board.checkSquare = inCheck ? kingSquare(board.squares, next) : null;
  const replies = legalRawMoves(board, next);

  let winner: GameCore['winner'] = null;
  let winningCells: number[] | null = null;
  if (replies.length === 0) {
    if (inCheck) {
      winner = moverSlot;
      winningCells = [kingSquare(board.squares, next)];
    } else {
      winner = 'DRAW';
    }
  } else if (board.halfmove >= 100 || insufficientMaterial(board.squares)) {
    winner = 'DRAW';
  }

  return {
    ...core,
    board,
    currentSlot: next,
    winner,
    winningCells,
    moveCount: core.moveCount + 1,
  };
}

// ---------------------------------------------------------------------------
// Evaluation + search
// ---------------------------------------------------------------------------

const VALUE: Record<string, number> = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

// Piece-square tables from white's perspective (index = square, a1 = 0).
const PST: Record<string, number[]> = {
  P: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, -20, -20, 10, 10, 5,
    5, -5, -10, 0, 0, -10, -5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, 5, 10, 25, 25, 10, 5, 5,
    10, 10, 20, 30, 30, 20, 10, 10,
    50, 50, 50, 50, 50, 50, 50, 50,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  N: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  B: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  R: [
    0, 0, 0, 5, 5, 0, 0, 0,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    5, 10, 10, 10, 10, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  Q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -10, 5, 5, 5, 5, 5, 0, -10,
    0, 0, 5, 5, 5, 5, 0, -5,
    -5, 0, 5, 5, 5, 5, 0, -5,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  K: [
    20, 30, 10, 0, 0, 10, 30, 20,
    20, 20, 0, 0, 0, 0, 20, 20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
  ],
};

const MIRROR = (sq: number) => SQ(7 - RANK(sq), FILE(sq));

/** Static eval from `slot`'s perspective, in centipawns. */
function evaluate(squares: (PieceCode | null)[], slot: PlayerSlot): number {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = squares[i];
    if (!p) continue;
    const kind = kindOf(p);
    const base = VALUE[kind] + PST[kind][p[0] === 'w' ? i : MIRROR(i)];
    score += p[0] === 'w' ? base : -base;
  }
  return slot === 0 ? score : -score;
}

function orderMoves(b: ChessBoard, moves: RawMove[]): RawMove[] {
  return moves
    .map((m) => {
      let s = 0;
      const victim = b.squares[m.to];
      if (victim) s += 10 * VALUE[kindOf(victim)] - VALUE[kindOf(b.squares[m.from]!)];
      if (m.epCapture !== undefined) s += 900;
      if (m.promotion === 'q') s += 8000;
      return { m, s };
    })
    .sort((a, z) => z.s - a.s)
    .map((x) => x.m);
}

function negamax(
  b: ChessBoard,
  slot: PlayerSlot,
  depth: number,
  alpha: number,
  beta: number,
): number {
  const moves = legalRawMoves(b, slot);
  const enemy: PlayerSlot = slot === 0 ? 1 : 0;
  if (moves.length === 0) {
    const inCheck = isAttacked(b.squares, kingSquare(b.squares, slot), enemy);
    return inCheck ? -100000 - depth : 0; // prefer faster mates
  }
  if (b.halfmove >= 100 || insufficientMaterial(b.squares)) return 0;
  if (depth === 0) return evaluate(b.squares, slot);

  let best = -Infinity;
  for (const m of orderMoves(b, moves)) {
    const score = -negamax(applyRaw(b, m, slot), enemy, depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// ---------------------------------------------------------------------------
// GameLogic implementation
// ---------------------------------------------------------------------------

function toMove(m: RawMove): Move {
  const out: Move = { from: m.from, to: m.to };
  if (m.promotion) out.promotion = m.promotion;
  return out;
}

export const chessLogic: GameLogic = {
  createCore(): GameCore {
    const board: ChessBoard = {
      squares: initialSquares(),
      castling: { wk: true, wq: true, bk: true, bq: true },
      ep: null,
      halfmove: 0,
      lastMove: null,
      checkSquare: null,
    };
    return {
      gameId: 'chess',
      board,
      currentSlot: 0,
      winner: null,
      winningCells: null,
      moveCount: 0,
    };
  },

  applyMove(core: GameCore, move: Move, slot: PlayerSlot): GameCore | null {
    if (core.winner !== null || core.currentSlot !== slot) return null;
    if (typeof move.from !== 'number' || typeof move.to !== 'number') return null;
    const b = core.board as ChessBoard;
    const legal = legalRawMoves(b, slot);
    const match = legal.find(
      (m) =>
        m.from === move.from &&
        m.to === move.to &&
        (m.promotion === undefined
          ? move.promotion === undefined
          : m.promotion === (move.promotion ?? 'q')),
    );
    if (!match) return null;
    return finish(core, applyRaw(b, match, slot), slot);
  },

  legalMoves(core: GameCore): Move[] {
    if (core.winner !== null) return [];
    const b = core.board as ChessBoard;
    return legalRawMoves(b, core.currentSlot).map(toMove);
  },

  aiMove(core: GameCore, slot: PlayerSlot, difficulty: Difficulty): Move {
    const b = core.board as ChessBoard;
    const moves = legalRawMoves(b, slot);
    const enemy: PlayerSlot = slot === 0 ? 1 : 0;
    const depth = difficulty === 'easy' ? 1 : difficulty === 'medium' ? 2 : 3;

    let best: RawMove = moves[0];
    let bestScore = -Infinity;
    const scored: { m: RawMove; s: number }[] = [];
    for (const m of orderMoves(b, moves)) {
      const s = -negamax(applyRaw(b, m, slot), enemy, depth - 1, -Infinity, Infinity);
      scored.push({ m, s });
      if (s > bestScore) {
        bestScore = s;
        best = m;
      }
    }

    if (difficulty === 'easy') {
      // Play a reasonable-but-fallible move: pick randomly among the top half,
      // ignoring outright blunders when something sane exists.
      const sane = scored.filter((x) => x.s > bestScore - 250);
      const pool = (sane.length > 0 ? sane : scored).slice(
        0,
        Math.max(1, Math.ceil(scored.length / 2)),
      );
      return toMove(pool[Math.floor(Math.random() * pool.length)].m);
    }
    return toMove(best);
  },
};

/** Node-count for move-generator validation (tests only). */
export function perft(b: ChessBoard, slot: PlayerSlot, depth: number): number {
  if (depth === 0) return 1;
  const enemy: PlayerSlot = slot === 0 ? 1 : 0;
  let nodes = 0;
  for (const m of legalRawMoves(b, slot)) {
    nodes += perft(applyRaw(b, m, slot), enemy, depth - 1);
  }
  return nodes;
}
