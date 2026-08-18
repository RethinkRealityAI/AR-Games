import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import SceneHost from '../engine/SceneHost';
import Hud from './Hud';
import ChatDock from './ChatDock';
import WinOverlay from './WinOverlay';
import { GAMES } from '../games/registry';
import { getAiMove } from '../services/ai';
import { netClient } from '../services/net';
import { sound } from '../services/sound';
import { Icon, IconButton, GlassButton, rgba } from './GlassUI';
import type {
  Difficulty,
  GameCore,
  GameId,
  GameMode,
  Move,
  PlayerProfile,
  PlayerSlot,
  Session,
} from '../types';

const AI_DELAY_MS = 650;
const HANDOFF_MS = 1200;

// ---------------------------------------------------------------------------
// Local game state (modes 'ai' and 'local')
// ---------------------------------------------------------------------------

interface LocalState {
  core: GameCore;
  prev: GameCore | null;
  round: number;
  startingSlot: PlayerSlot;
}

type LocalAction =
  | { type: 'move'; move: Move; slot: PlayerSlot }
  | { type: 'reset' }
  | { type: 'newGame'; gameId: GameId };

const freshCore = (gameId: GameId, startingSlot: PlayerSlot): GameCore => ({
  ...GAMES[gameId].logic.createCore(),
  currentSlot: startingSlot,
});

const initLocal = (gameId: GameId): LocalState => ({
  core: freshCore(gameId, 0),
  prev: null,
  round: 1,
  startingSlot: 0,
});

function localReducer(state: LocalState, action: LocalAction): LocalState {
  switch (action.type) {
    case 'move': {
      const next = GAMES[state.core.gameId].logic.applyMove(state.core, action.move, action.slot);
      if (!next) return state;
      return { ...state, core: next, prev: state.core };
    }
    case 'reset': {
      const nextStart: PlayerSlot = state.startingSlot === 0 ? 1 : 0;
      return {
        core: freshCore(state.core.gameId, nextStart),
        prev: state.core,
        round: state.round + 1,
        startingSlot: nextStart,
      };
    }
    case 'newGame':
      return initLocal(action.gameId);
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------

export interface GameScreenProps {
  gameId: GameId;
  mode: GameMode;
  difficulty: Difficulty;
  profiles: [PlayerProfile, PlayerProfile];
  /** Session handed over by the lobby (online mode). */
  initialSession?: Session | null;
  onExit: () => void;
}

const GameScreen: React.FC<GameScreenProps> = ({
  gameId,
  mode,
  difficulty,
  profiles,
  initialSession = null,
  onExit,
}) => {
  const online = mode === 'online';

  const [local, dispatch] = useReducer(localReducer, gameId, initLocal);
  const [session, setSession] = useState<Session | null>(initialSession);
  const [prevOnlineCore, setPrevOnlineCore] = useState<GameCore | null>(null);

  const [aiThinking, setAiThinking] = useState(false);
  const [pending, setPending] = useState(false);
  const [rematchPending, setRematchPending] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);

  const [arActive, setArActive] = useState(false);
  const [placed, setPlaced] = useState(true);
  const [repositionNonce, setRepositionNonce] = useState(0);
  const [chatHidden, setChatHidden] = useState(false);
  const [handoff, setHandoff] = useState<PlayerSlot | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);

  const mySlot: PlayerSlot | null = online ? netClient.slot : null;

  // -- rebuild local state if the game ever changes underneath us -----------
  useEffect(() => {
    if (!online) dispatch({ type: 'newGame', gameId });
  }, [gameId, online]);

  // -- online: mirror the session -------------------------------------------
  const sessionRef = useRef<Session | null>(initialSession);
  useEffect(() => {
    if (!online) return;

    // Compared by moveCount/round rather than object identity: a polling client
    // hands us a freshly parsed Session every tick, and the scenes need a `prev`
    // that is exactly one move behind for the drop/spawn animations to play.
    const apply = (next: Session) => {
      const prev = sessionRef.current;
      sessionRef.current = next;
      if (prev && (prev.core.moveCount !== next.core.moveCount || prev.round !== next.round)) {
        setPrevOnlineCore(prev.core);
      }
      if (prev && prev.round !== next.round) setRematchPending(false);
      setSession(next);
      setPending(false);
      setNetError(null);
    };

    const off = netClient.on((e) => {
      if (e.type === 'session') {
        apply(e.session);
      } else if (e.type === 'error') {
        setNetError(e.message);
        setPending(false);
      } else if (e.type === 'connection') {
        setNetError(e.online ? null : 'Connection lost — retrying…');
      }
    });

    const current = netClient.session;
    if (current) apply(current);
    return off;
  }, [online]);

  // -- resolved state -------------------------------------------------------
  const core: GameCore | null = online ? (session?.core ?? null) : local.core;
  const prevCore: GameCore | null = online ? prevOnlineCore : local.prev;
  const round = online ? (session?.round ?? 1) : local.round;

  const rawProfiles: [PlayerProfile, PlayerProfile] =
    online && session
      ? [session.players[0].profile, session.players[1]?.profile ?? profiles[1]]
      : profiles;
  // Stable identity so SceneHost only rebuilds when the profiles really change.
  const profKey = JSON.stringify(rawProfiles);
  const activeProfiles = useMemo(
    () => JSON.parse(profKey) as [PlayerProfile, PlayerProfile],
    [profKey],
  );

  const winner = core?.winner ?? null;
  const currentSlot: PlayerSlot = core?.currentSlot ?? 0;

  const inputEnabled = useMemo(() => {
    if (!core || winner !== null) return false;
    if (mode === 'ai') return currentSlot === 0 && !aiThinking;
    if (mode === 'local') return true;
    return (
      mySlot !== null &&
      currentSlot === mySlot &&
      !pending &&
      session?.status === 'active'
    );
  }, [core, winner, mode, currentSlot, aiThinking, mySlot, pending, session?.status]);

  // -- moves ----------------------------------------------------------------
  const handleMove = useCallback(
    (move: Move) => {
      if (!core || winner !== null) return;
      if (online) {
        if (mySlot === null || currentSlot !== mySlot) return;
        setPending(true);
        netClient.sendMove(move).catch((err: unknown) => {
          setPending(false);
          setNetError(err instanceof Error ? err.message : 'Move rejected.');
        });
        return;
      }
      const slot: PlayerSlot = mode === 'ai' ? 0 : currentSlot;
      dispatch({ type: 'move', move, slot });
    },
    [core, winner, online, mySlot, currentSlot, mode],
  );

  // -- AI turn --------------------------------------------------------------
  useEffect(() => {
    if (mode !== 'ai' || !core) return;
    if (core.winner !== null || core.currentSlot !== 1) return;

    let cancelled = false;
    setAiThinking(true);
    const timer = setTimeout(() => {
      void getAiMove(gameId, core, 1, difficulty).then((move) => {
        if (cancelled) return;
        setAiThinking(false);
        dispatch({ type: 'move', move, slot: 1 });
      });
    }, AI_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setAiThinking(false);
    };
  }, [mode, core, gameId, difficulty]);

  // -- sound + handoff on state transitions ---------------------------------
  const lastCountRef = useRef(-1);
  useEffect(() => {
    if (!core) return;
    const count = core.moveCount;
    if (count === lastCountRef.current) return;
    const advanced = count > lastCountRef.current;
    lastCountRef.current = count;

    if (count === 0) {
      setHandoff(null);
      return;
    }
    if (!advanced) return;

    // Connect Four plays its own "thock" when the disc actually lands.
    if (gameId !== 'connect4') sound.playMove();

    if (core.winner === 'DRAW') sound.playDraw();
    else if (core.winner !== null) {
      const iLost =
        (mode === 'ai' && core.winner === 1) || (online && mySlot !== null && core.winner !== mySlot);
      if (iLost) sound.playLose();
      else sound.playWin();
    } else if (mode === 'local') {
      setHandoff(core.currentSlot);
    }
  }, [core, gameId, mode, online, mySlot]);

  useEffect(() => {
    if (handoff === null) return;
    const t = setTimeout(() => setHandoff(null), HANDOFF_MS);
    return () => clearTimeout(t);
  }, [handoff]);

  // -- reset / rematch ------------------------------------------------------
  const resetGame = useCallback(() => {
    if (online) {
      setRematchPending(true);
      netClient.requestRematch().catch((err: unknown) => {
        setRematchPending(false);
        setNetError(err instanceof Error ? err.message : 'Rematch failed.');
      });
      return;
    }
    lastCountRef.current = -1;
    setHandoff(null);
    sound.playStart();
    dispatch({ type: 'reset' });
  }, [online]);

  const doExit = useCallback(() => {
    if (online) void netClient.leave();
    onExit();
  }, [online, onExit]);

  const requestExit = () => {
    sound.playClick();
    if (online) setConfirmExit(true);
    else doExit();
  };

  // -- controls visibility --------------------------------------------------
  const showReset = !online || mySlot === 0 || winner !== null;

  // -- online handshake states ----------------------------------------------
  if (online && !core) {
    return (
      <div className="relative flex h-full items-center justify-center px-6">
        <div className="game-bg" />
        <div className="glass anim-spring relative z-10 max-w-xs rounded-3xl p-7 text-center">
          <div className="shimmer mx-auto h-2 w-36 overflow-hidden rounded-full bg-white/10" />
          <p className="mt-4 text-sm text-slate-300">Syncing with the room…</p>
          {netError && <p className="mt-2 text-xs text-rose-300">{netError}</p>}
          <GlassButton className="mt-5" onClick={doExit}>
            <Icon name="close" size={15} />
            Leave
          </GlassButton>
        </div>
      </div>
    );
  }

  if (!core) return null;

  const waitingForOpponent = online && session?.status === 'waiting';

  return (
    <div className="relative h-full w-full overflow-hidden">
      {!arActive && <div className="game-bg" />}

      <SceneHost
        gameId={gameId}
        core={core}
        prevCore={prevCore}
        profiles={activeProfiles}
        currentSlot={currentSlot}
        winner={winner}
        onMove={handleMove}
        enabled={inputEnabled}
        onPlacedChange={setPlaced}
        onArActiveChange={setArActive}
        repositionNonce={repositionNonce}
      />

      <Hud
        profiles={activeProfiles}
        currentSlot={currentSlot}
        winner={winner}
        mode={mode}
        mySlot={mySlot}
        aiThinking={aiThinking}
        pending={pending}
        session={session}
        onRestoreChat={online && chatHidden ? () => setChatHidden(false) : undefined}
      />

      {/* ------------------------------------------------------- controls */}
      <div
        className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-4 z-40 flex flex-col gap-2.5 transition-opacity duration-200"
        style={winner !== null ? { opacity: 0, pointerEvents: 'none' } : undefined}
      >
        {showReset && (
          <IconButton label={online ? 'Request rematch' : 'Reset board'} onClick={resetGame}>
            <Icon name="reset" size={19} />
          </IconButton>
        )}
        {arActive && placed && (
          <IconButton
            label="Reposition board"
            onClick={() => setRepositionNonce((n) => n + 1)}
          >
            <Icon name="move" size={19} />
          </IconButton>
        )}
        <IconButton label="Exit to home" tone="danger" onClick={requestExit}>
          <Icon name="close" size={19} />
        </IconButton>
      </div>

      {/* --------------------------------------------------- handoff toast */}
      {handoff !== null && mode === 'local' && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 z-40 flex -translate-y-1/2 justify-center px-6">
          <div
            className="glass-strong anim-pop flex items-center gap-3 rounded-full px-5 py-3"
            style={{ boxShadow: `0 0 0 1px ${rgba(activeProfiles[handoff].color, 0.4)}` }}
          >
            <span
              className="h-3 w-3 rounded-full"
              style={{
                background: activeProfiles[handoff].color,
                boxShadow: `0 0 14px ${activeProfiles[handoff].color}`,
              }}
            />
            <span className="font-display text-base font-bold tracking-tight">
              Pass to {activeProfiles[handoff].name}
            </span>
          </div>
        </div>
      )}

      {/* ------------------------------------------------ waiting / errors */}
      {waitingForOpponent && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-40 flex justify-center px-6">
          <div className="glass-pill shimmer overflow-hidden px-4 py-2 text-[12px] text-slate-200">
            <span className="relative z-10">Waiting for your opponent to join…</span>
          </div>
        </div>
      )}

      {netError && !waitingForOpponent && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-40 flex justify-center px-6">
          <div className="glass-pill px-4 py-2 text-[12px] text-rose-200">{netError}</div>
        </div>
      )}

      {/* ------------------------------------------------------------ chat */}
      {online && (
        <ChatDock
          mySlot={mySlot}
          profiles={activeProfiles}
          hidden={chatHidden}
          onHiddenChange={setChatHidden}
        />
      )}

      {/* --------------------------------------------------------- outcome */}
      {winner !== null && (
        <WinOverlay
          winner={winner}
          profiles={activeProfiles}
          mode={mode}
          mySlot={mySlot}
          round={round}
          rematchPending={rematchPending}
          onRematch={resetGame}
          onExit={doExit}
        />
      )}

      {/* --------------------------------------------------- exit confirm */}
      {confirmExit && (
        <div className="absolute inset-0 z-[60] grid place-items-center bg-black/55 px-6 backdrop-blur-sm">
          <div className="glass-strong anim-spring w-full max-w-xs rounded-3xl p-6 text-center">
            <h3 className="font-display text-xl font-bold tracking-tight">Leave the match?</h3>
            <p className="mt-1.5 text-[13px] text-slate-400">
              Your opponent will be told you disconnected.
            </p>
            <div className="mt-5 flex gap-2.5">
              <GlassButton block onClick={() => setConfirmExit(false)}>
                Stay
              </GlassButton>
              <GlassButton block variant="danger" onClick={doExit}>
                Leave
              </GlassButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GameScreen;
