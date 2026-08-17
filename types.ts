import React from 'react';

export type Player = 'X' | 'O';
export type CellValue = Player | null;

export type AvatarType = 'ASTRONAUT' | 'DRONE' | 'CRYSTAL';

export interface PlayerProfile {
  name: string;
  avatarId: AvatarType;
  color: string; // Hex color string
}

export interface GameState {
  board: CellValue[];
  currentPlayer: Player;
  winner: Player | 'DRAW' | null;
  winningLine: number[] | null;
  roomCode: string | null;
  isAiThinking: boolean;
}