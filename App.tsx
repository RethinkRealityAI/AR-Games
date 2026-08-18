// ============================================================================
// COSMIC ARCADE — app shell and view state machine.
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import Landing from './components/Landing';
import ModeSelect from './components/ModeSelect';
import PlayerSetup, { DEFAULT_PROFILES } from './components/PlayerSetup';
import OnlineLobby, { sanitizeCode, CODE_LENGTH } from './components/OnlineLobby';
import GameScreen from './components/GameScreen';
import { GAMES } from './games/registry';
import { netClient } from './services/net';
import { sound } from './services/sound';
import type { Difficulty, GameId, GameMode, PlayerProfile, Session } from './types';

type View = 'landing' | 'mode' | 'setup' | 'lobby' | 'game';

const PROFILE_KEY = 'cosmic-arcade:profiles:v1';

/** `?join=CODE` deep link, read once at boot. */
function readJoinCode(): string | null {
  if (typeof location === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('join');
  if (!raw) return null;
  const code = sanitizeCode(raw);
  return code.length === CODE_LENGTH ? code : null;
}

function loadProfiles(): [PlayerProfile, PlayerProfile] {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as [PlayerProfile, PlayerProfile];
      if (Array.isArray(parsed) && parsed.length === 2 && parsed[0]?.name) return parsed;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PROFILES;
}

const App: React.FC = () => {
  const [joinCode] = useState<string | null>(readJoinCode);

  const [view, setView] = useState<View>(() => (readJoinCode() ? 'setup' : 'landing'));
  const [gameId, setGameId] = useState<GameId>('tictactoe');
  const [mode, setMode] = useState<GameMode>(() => (readJoinCode() ? 'online' : 'ai'));
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [profiles, setProfiles] = useState<[PlayerProfile, PlayerProfile]>(loadProfiles);
  /**
   * Player 2's remembered profile. Kept apart from `profiles[1]`, which holds
   * the synthesised NOVA identity while a solo game is running — we never want
   * that written back as the human second player's default.
   */
  const [p2Memory, setP2Memory] = useState<PlayerProfile>(() => loadProfiles()[1]);
  const [lobbyIntent, setLobbyIntent] = useState<'create' | 'join'>('create');
  const [session, setSession] = useState<Session | null>(null);

  // Strip the deep-link query so refreshes and shares stay clean.
  useEffect(() => {
    if (!joinCode) return;
    setLobbyIntent('join');
    try {
      history.replaceState({}, '', location.pathname);
    } catch {
      /* ignore */
    }
  }, [joinCode]);

  useEffect(() => {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify([profiles[0], p2Memory]));
    } catch {
      /* ignore */
    }
  }, [profiles, p2Memory]);

  const goHome = useCallback(() => {
    setSession(null);
    setView('landing');
  }, []);

  const pickGame = useCallback((id: GameId) => {
    setGameId(id);
    setView('mode');
  }, []);

  const pickMode = useCallback((m: GameMode, intent?: 'create' | 'join') => {
    setMode(m);
    if (m === 'online') setLobbyIntent(intent ?? 'create');
    setView('setup');
  }, []);

  const finishSetup = useCallback(
    (next: [PlayerProfile, PlayerProfile]) => {
      setProfiles(next);
      if (mode === 'local') setP2Memory(next[1]);
      sound.resume();
      setView(mode === 'online' ? 'lobby' : 'game');
    },
    [mode],
  );

  const lobbyReady = useCallback((s: Session) => {
    setSession(s);
    setGameId(s.gameId);
    setView('game');
  }, []);

  const setupContext =
    mode === 'online'
      ? joinCode
        ? `Joining ${joinCode}`
        : lobbyIntent === 'create'
          ? 'Hosting online'
          : 'Joining online'
      : GAMES[gameId].meta.name;

  return (
    <div className="relative h-full w-full">
      {view === 'landing' && <Landing onPickGame={pickGame} />}

      {view === 'mode' && (
        <ModeSelect
          gameId={gameId}
          difficulty={difficulty}
          onDifficultyChange={setDifficulty}
          onPick={pickMode}
          onBack={goHome}
        />
      )}

      {view === 'setup' && (
        <PlayerSetup
          mode={mode}
          contextLabel={setupContext}
          initial={[profiles[0], p2Memory]}
          onComplete={finishSetup}
          onBack={() => setView(joinCode ? 'landing' : 'mode')}
        />
      )}

      {view === 'lobby' && (
        <OnlineLobby
          gameId={gameId}
          profile={profiles[0]}
          intent={lobbyIntent}
          presetCode={joinCode}
          onReady={lobbyReady}
          onBack={() => setView(joinCode ? 'landing' : 'mode')}
        />
      )}

      {view === 'game' && (
        <GameScreen
          gameId={gameId}
          mode={mode}
          difficulty={difficulty}
          profiles={profiles}
          initialSession={session ?? netClient.session}
          onExit={goHome}
        />
      )}
    </div>
  );
};

export default App;
