import { GameDefinition, GameId } from '../types';
import { tictactoeLogic } from './tictactoe/logic';
import { connect4Logic } from './connect4/logic';
import { chessLogic } from './chess/logic';

export const GAMES: Record<GameId, GameDefinition> = {
  tictactoe: {
    meta: {
      id: 'tictactoe',
      name: 'Cosmic Tac-Toe',
      tagline: 'Three in a row among the stars',
      cardArt: '/assets/card-tictactoe.webp',
    },
    logic: tictactoeLogic,
  },
  connect4: {
    meta: {
      id: 'connect4',
      name: 'Nebula Four',
      tagline: 'Drop discs, connect four, claim the galaxy',
      cardArt: '/assets/card-connect4.webp',
    },
    logic: connect4Logic,
  },
  chess: {
    meta: {
      id: 'chess',
      name: 'Astral Chess',
      tagline: 'The royal game, played among nebulae',
      cardArt: '/assets/card-chess.webp',
    },
    logic: chessLogic,
  },
};

export const GAME_LIST = Object.values(GAMES);
