
import React, { useState, useEffect, useCallback } from 'react';
import ArBoard from './components/ArBoard';
import RoomJoin from './components/RoomJoin';
import PlayerSetup from './components/PlayerSetup';
import { GameState, Player, CellValue, PlayerProfile } from './types';
import { getBestMove } from './services/geminiService';
import { soundService } from './services/soundService';

const WINNING_COMBINATIONS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], 
  [0, 3, 6], [1, 4, 7], [2, 5, 8], 
  [0, 4, 8], [2, 4, 6]             
];

const STORAGE_KEY = 'ar-tictactoe-state_v1';

const checkWinner = (board: CellValue[]): { winner: Player | 'DRAW' | null, line: number[] | null } => {
  for (const [a, b, c] of WINNING_COMBINATIONS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a] as Player, line: [a, b, c] };
    }
  }
  if (board.every(cell => cell !== null)) return { winner: 'DRAW', line: null };
  return { winner: null, line: null };
};

type ViewState = 'HOME' | 'SETUP' | 'GAME';

const App: React.FC = () => {
  // Initialize State from LocalStorage if available
  const [gameState, setGameState] = useState<GameState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error("Failed to load state", e);
    }
    return {
      board: Array(9).fill(null),
      currentPlayer: 'X',
      winner: null,
      winningLine: null,
      roomCode: null,
      isAiThinking: false
    };
  });

  const [view, setView] = useState<ViewState>('HOME');
  const [gameMode, setGameMode] = useState<'AI' | 'LOCAL'>('AI');
  const [isBoardPlaced, setIsBoardPlaced] = useState(false);
  const [isArActive, setIsArActive] = useState(false);
  
  const [playerProfile, setPlayerProfile] = useState<PlayerProfile>({
      name: 'Commander',
      avatarId: 'ASTRONAUT',
      color: '#0088ff'
  });

  // Persistence Effect
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
  }, [gameState]);

  // Auto-restore game view if refresh happens during a match
  useEffect(() => {
      if (gameState.roomCode && view === 'HOME') {
          setView('GAME');
      }
  }, [gameState.roomCode]);

  const handleJoinRoom = (code: string, mode: 'AI' | 'LOCAL') => {
    setGameMode(mode);
    setGameState(prev => ({ ...prev, roomCode: code })); // Set code temporarily
    setView('SETUP');
  };

  const handleSetupComplete = (profile: PlayerProfile) => {
      setPlayerProfile(profile);
      setView('GAME');
  };

  const handleCellClick = useCallback(async (index: number) => {
    if (gameState.isAiThinking) return;
    if (gameMode === 'AI' && gameState.currentPlayer !== 'X') return;
    if (gameState.board[index] || gameState.winner) return;

    const newBoard = [...gameState.board];
    newBoard[index] = gameState.currentPlayer;

    const result = checkWinner(newBoard);
    
    if (result.winner === 'DRAW') soundService.playDraw();
    else if (result.winner) soundService.playWin();
    else soundService.playMove();
    
    setGameState(prev => ({
      ...prev,
      board: newBoard,
      currentPlayer: prev.currentPlayer === 'X' ? 'O' : 'X',
      winner: result.winner,
      winningLine: result.line,
      isAiThinking: !result.winner && gameMode === 'AI' 
    }));

  }, [gameState.board, gameState.winner, gameState.isAiThinking, gameState.currentPlayer, gameMode]);

  // Unified AI Turn Effect
  useEffect(() => {
    let timeoutId: any;
    let isCancelled = false;

    if (gameMode !== 'AI' || gameState.winner) return;

    if (gameState.currentPlayer === 'O') {
        if (!gameState.isAiThinking) {
            setGameState(prev => ({ ...prev, isAiThinking: true }));
            return; 
        }

        timeoutId = setTimeout(() => {
            if(!isCancelled) {
                setGameState(prev => ({ ...prev, isAiThinking: false }));
            }
        }, 8000);

        const makeAiMove = async () => {
            await new Promise(r => setTimeout(r, 800));
            if (isCancelled) return;

            const moveIndex = await getBestMove([...gameState.board], gameState.currentPlayer);
            if (isCancelled) return;

            setGameState(prev => {
                if (prev.winner || prev.currentPlayer !== 'O') return prev;

                if (moveIndex !== -1 && !prev.board[moveIndex]) {
                    const newBoard = [...prev.board];
                    newBoard[moveIndex] = 'O';
                    const result = checkWinner(newBoard);

                    if (result.winner === 'DRAW') soundService.playDraw();
                    else if (result.winner) soundService.playWin();
                    else soundService.playMove();

                    return {
                        ...prev,
                        board: newBoard,
                        currentPlayer: 'X',
                        winner: result.winner,
                        winningLine: result.line,
                        isAiThinking: false
                    };
                } 
                return { ...prev, isAiThinking: false };
            });
        };
        
        makeAiMove();
    }

    return () => {
        isCancelled = true;
        clearTimeout(timeoutId);
    };
  }, [gameState.currentPlayer, gameState.isAiThinking, gameMode, gameState.winner, gameState.board]);

  const handleReset = () => {
    soundService.playStart();
    const newState: GameState = {
        board: Array(9).fill(null),
        currentPlayer: 'X',
        winner: null,
        winningLine: null,
        roomCode: gameState.roomCode,
        isAiThinking: false
    };
    setGameState(newState);
  };

  const handleReposition = () => {
      soundService.playClick();
      setIsBoardPlaced(false);
  };

  const handleHome = () => {
      setGameState(prev => ({ ...prev, roomCode: null, board: Array(9).fill(null) }));
      setView('HOME');
  }

  return (
    <div className="relative w-full h-full">
      {!isArActive && <div className="galaxy-bg" />}

      {view === 'HOME' && (
        <div className="absolute inset-0 flex items-center justify-center z-50">
           <RoomJoin onJoin={handleJoinRoom} />
        </div>
      )}

      {view === 'SETUP' && (
          <div className="absolute inset-0 flex items-center justify-center z-50">
             <PlayerSetup 
                onComplete={handleSetupComplete} 
                onBack={handleHome}
             />
          </div>
      )}

      {view === 'GAME' && (
        <>
           <ArBoard 
             board={gameState.board} 
             onCellClick={handleCellClick}
             winner={gameState.winner}
             winningLine={gameState.winningLine}
             isBoardPlaced={isBoardPlaced}
             onBoardPlacedChange={setIsBoardPlaced}
             onArStatusChange={setIsArActive}
             currentPlayer={gameState.currentPlayer}
             playerProfile={playerProfile}
           />

           {/* Game UI Overlay */}
           <div className="absolute top-6 left-0 right-0 z-40 flex flex-col items-center gap-2 pointer-events-none">
             <div className="glass-panel px-6 py-3 rounded-full flex items-center gap-4">
                <div className={`flex items-center gap-2 ${gameState.currentPlayer === 'X' ? 'opacity-100' : 'opacity-50'}`}>
                    <div className="w-3 h-3 rounded-full animate-pulse" style={{ backgroundColor: playerProfile.color }}/>
                    <span className="text-white font-bold uppercase">{playerProfile.name}</span>
                </div>
                <div className="w-px h-4 bg-white/20"/>
                <div className={`flex items-center gap-2 ${gameState.currentPlayer === 'O' ? 'opacity-100' : 'opacity-50'}`}>
                    <span className="text-red-400 font-bold">{gameMode === 'AI' ? 'GEMINI' : 'P2'}</span>
                    <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"/>
                </div>
             </div>
             
             {gameState.isAiThinking && (
                <div className="text-cyan-300 text-sm font-mono animate-pulse bg-black/40 px-3 py-1 rounded-md backdrop-blur">
                   GEMINI IS THINKING...
                </div>
             )}
           </div>
           
           {/* Bottom Controls */}
           <div className="absolute bottom-8 w-full px-8 flex justify-between items-end z-40 pointer-events-none">
              {isBoardPlaced && (
                <div className="pointer-events-auto space-y-2">
                     <button 
                        onClick={handleReset}
                        className="block bg-white/10 backdrop-blur-md border border-white/20 p-3 rounded-full text-white hover:bg-white/20 transition-all active:scale-95"
                     >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                     </button>
                     <button 
                        onClick={handleReposition}
                        className="block bg-white/10 backdrop-blur-md border border-white/20 p-3 rounded-full text-white hover:bg-white/20 transition-all active:scale-95"
                     >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                        </svg>
                     </button>
                     <button 
                        onClick={handleHome}
                        className="block bg-red-500/20 backdrop-blur-md border border-red-500/40 p-3 rounded-full text-red-200 hover:bg-red-500/40 transition-all active:scale-95"
                     >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                     </button>
                </div>
              )}
              
              {gameState.winner && (
                <div className="pointer-events-auto bg-slate-900/90 backdrop-blur-lg border border-cyan-500/50 p-6 rounded-2xl shadow-[0_0_50px_rgba(6,182,212,0.3)] animate-in slide-in-from-bottom-10">
                    <h2 className="text-3xl font-black text-white mb-1">
                        {gameState.winner === 'DRAW' ? "IT'S A DRAW" : `${gameState.winner === 'X' ? playerProfile.name : 'GEMINI'} WINS!`}
                    </h2>
                    <button 
                        onClick={handleReset}
                        className="mt-4 w-full bg-cyan-500 hover:bg-cyan-400 text-black font-bold py-3 rounded-xl transition-all"
                    >
                        PLAY AGAIN
                    </button>
                </div>
              )}
           </div>
        </>
      )}
    </div>
  );
};

export default App;
