// ============================================================================
// AI move dispatch.
//
// The local engines in games/*/logic.ts are the SOURCE OF TRUTH — they are
// synchronous, always legal, and work offline. Gemini is an optional "flavour"
// for tic-tac-toe on 'hard' when an API key is present; any failure, timeout or
// illegal suggestion silently falls back to the local engine.
// ============================================================================

import { GAMES } from '../games/registry';
import type { Difficulty, GameCore, GameId, Move, PlayerSlot } from '../types';

const GEMINI_TIMEOUT_MS = 3500;
const MODEL = 'gemini-2.5-flash';

function apiKey(): string | undefined {
  try {
    const k = process.env.API_KEY;
    return typeof k === 'string' && k.length > 0 ? k : undefined;
  } catch {
    return undefined;
  }
}

/** True when a Gemini attempt is worth making at all. */
function wantsGemini(gameId: GameId, difficulty: Difficulty): boolean {
  return difficulty === 'hard' && gameId === 'tictactoe' && apiKey() !== undefined;
}

function localMove(gameId: GameId, core: GameCore, slot: PlayerSlot, difficulty: Difficulty): Move {
  return GAMES[gameId].logic.aiMove(core, slot, difficulty);
}

/** A move is only accepted if the pure logic module says it is legal. */
function isLegal(gameId: GameId, core: GameCore, move: Move, slot: PlayerSlot): boolean {
  return GAMES[gameId].logic.applyMove(core, move, slot) !== null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gemini-timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function geminiTicTacToeMove(core: GameCore, slot: PlayerSlot): Promise<Move> {
  const key = apiKey();
  if (!key) throw new Error('no-key');

  // Imported lazily so the SDK is code-split out of the initial bundle.
  const { GoogleGenAI, Type } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: key });

  const board = core.board as (PlayerSlot | null)[];
  const glyph = (v: PlayerSlot | null) => (v === null ? '.' : v === 0 ? 'X' : 'O');
  const me = slot === 0 ? 'X' : 'O';
  const rows = [0, 3, 6].map((r) => [0, 1, 2].map((c) => glyph(board[r + c])).join(' '));

  const prompt = [
    'You are a perfect tic-tac-toe engine.',
    'Cells are indexed 0-8, row-major (0,1,2 = top row).',
    'Board (". " = empty):',
    ...rows.map((row, i) => `  ${row}   (cells ${i * 3}-${i * 3 + 2})`),
    `You play "${me}".`,
    'Pick the strongest legal move: win if you can, otherwise block, otherwise play optimally.',
    'Respond with the integer index of an EMPTY cell only.',
  ].join('\n');

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          cell: { type: Type.INTEGER, description: 'Index 0-8 of the chosen empty cell.' },
        },
        required: ['cell'],
      },
    },
  });

  const text = response.text;
  if (!text) throw new Error('empty-response');
  const parsed = JSON.parse(text) as { cell?: unknown };
  const cell = typeof parsed.cell === 'number' ? parsed.cell : Number(parsed.cell);
  if (!Number.isInteger(cell)) throw new Error('bad-response');
  return { cell };
}

/**
 * Resolve the AI's move for `slot`. Always resolves with a legal move.
 */
export async function getAiMove(
  gameId: GameId,
  core: GameCore,
  slot: PlayerSlot,
  difficulty: Difficulty,
): Promise<Move> {
  const fallback = localMove(gameId, core, slot, difficulty);

  if (!wantsGemini(gameId, difficulty)) return fallback;

  try {
    const move = await withTimeout(geminiTicTacToeMove(core, slot), GEMINI_TIMEOUT_MS);
    if (isLegal(gameId, core, move, slot)) return move;
    console.warn('[ai] Gemini returned an illegal move; using local engine.', move);
  } catch (err) {
    console.warn('[ai] Gemini unavailable; using local engine.', err);
  }
  return fallback;
}

/** Whether the "hard" difficulty will try to consult Gemini for this game. */
export function geminiEnabledFor(gameId: GameId, difficulty: Difficulty): boolean {
  return wantsGemini(gameId, difficulty);
}
