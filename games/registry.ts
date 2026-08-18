import { GameDefinition, GameId } from '../types';
import { tictactoeLogic } from './tictactoe/logic';
import { connect4Logic } from './connect4/logic';

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
};

export const GAME_LIST = Object.values(GAMES);
