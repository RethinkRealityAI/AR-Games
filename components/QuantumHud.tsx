// ============================================================================
// Quantum Pairs — the scored HUD.
//
// Unlike the other games in the arcade this one keeps score, so the pair count
// is the headline: both totals, the pairs still on the board, each player's
// Nova Pulse, and — when the match is timed — the turn clock.
//
// The clock lives here rather than in GameScreen so that ticking at 10 Hz only
// re-renders this leaf. It counts down by elapsed deltas and simply stops
// accumulating when it is not the local player's turn, when NOVA is thinking or
// when the tab is hidden; on expiry it fires `{ pass: true }` exactly once per
// turn, guarded by the turn epoch it fired for.
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import type { GameMode, Move, PlayerProfile, PlayerSlot } from '../types';
import type { MemoryBoard } from '../games/memory/logic';
import { rgba } from './GlassUI';
import { sound } from '../services/sound';

const URGENT_AT = 3; // seconds left when the clock starts shouting
const TICK_MS = 100;

/* ------------------------------------------------------------------ pulse */

const PulseButton: React.FC<{
  profile: PlayerProfile;
  slot: PlayerSlot;
  available: boolean;
  armed: boolean;
  onFire: () => void;
}> = ({ profile, slot, available, armed, onFire }) => {
  const [fired, setFired] = useState(false);

  useEffect(() => {
    if (!fired) return;
    const t = setTimeout(() => setFired(false), 620);
    return () => clearTimeout(t);
  }, [fired]);

  const label = available
    ? armed
      ? `Fire ${profile.name}'s Nova Pulse`
      : `${profile.name}'s Nova Pulse is ready`
    : `${profile.name} has spent their Nova Pulse`;

  return (
    <button
      type="button"
      data-testid={`pulse-${slot}`}
      data-state={available ? (armed ? 'armed' : 'ready') : 'spent'}
      aria-label={label}
      title={label}
      disabled={!armed}
      onClick={() => {
        if (!armed) return;
        sound.playStart();
        setFired(true);
        onFire();
      }}
      className={`yes-tap press relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-all disabled:cursor-default ${
        fired ? 'nova-fired' : ''
      } ${armed ? 'pulse-ring' : ''}`}
      style={{
        ['--pulse' as string]: rgba(profile.color, 0.5),
        background: available
          ? `radial-gradient(circle at 34% 28%, ${rgba(profile.color, armed ? 0.95 : 0.4)}, ${rgba(profile.color, armed ? 0.4 : 0.14)})`
          : 'rgba(255,255,255,.05)',
        boxShadow: armed
          ? `inset 0 1px 0 rgba(255,255,255,.4), 0 0 14px ${rgba(profile.color, 0.75)}`
          : 'inset 0 0 0 1px rgba(255,255,255,.09)',
        color: available ? '#04040f' : '#64748b',
        opacity: available ? 1 : 0.6,
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12 4.5 10 10 8.5 12 3z"
          fill={available ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        {!available && <path d="M5 19L19 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
      </svg>
    </button>
  );
};

/* ------------------------------------------------------------------ timer */

const TimerRing: React.FC<{ seconds: number; total: number; live: boolean; tint: string }> = ({
  seconds,
  total,
  live,
  tint,
}) => {
  const R = 15;
  const C = 2 * Math.PI * R;
  const frac = total > 0 ? Math.max(0, Math.min(1, seconds / total)) : 0;
  const urgent = live && seconds <= URGENT_AT;
  const stroke = urgent ? '#fb7185' : live ? tint : '#475569';

  return (
    <span
      className={`relative grid h-9 w-9 place-items-center ${urgent ? 'timer-urgent' : ''}`}
      data-testid="turn-timer"
      data-seconds={Math.ceil(seconds)}
      title={live ? `${Math.ceil(seconds)}s left this turn` : `${total}s turns`}
    >
      <svg width="36" height="36" viewBox="0 0 36 36" className="-rotate-90">
        <circle cx="18" cy="18" r={R} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="2.6" />
        <circle
          cx="18"
          cy="18"
          r={R}
          fill="none"
          stroke={stroke}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          style={{ transition: 'stroke-dashoffset 120ms linear, stroke 300ms ease' }}
        />
      </svg>
      <span
        className="mono absolute text-[11px] font-bold leading-none"
        style={{ color: urgent ? '#fecdd3' : live ? '#e2e8f0' : '#94a3b8' }}
      >
        {Math.ceil(seconds)}
      </span>
    </span>
  );
};

/* -------------------------------------------------------------------------- */

export interface QuantumHudProps {
  board: MemoryBoard;
  profiles: [PlayerProfile, PlayerProfile];
  currentSlot: PlayerSlot;
  winner: PlayerSlot | 'DRAW' | null;
  mode: GameMode;
  mySlot: PlayerSlot | null;
  aiThinking: boolean;
  pending: boolean;
  /** Bumped by GameScreen whenever a fresh turn starts. Resets the clock. */
  turnEpoch: number;
  onMove: (move: Move, slot?: PlayerSlot) => void;
}

const QuantumHud: React.FC<QuantumHudProps> = ({
  board,
  profiles,
  currentSlot,
  winner,
  mode,
  mySlot,
  aiThinking,
  pending,
  turnEpoch,
  onMove,
}) => {
  const over = winner !== null;
  const playing = board.phase === 'play' && !over;

  /** Does this device act for whoever holds the turn? */
  const controls =
    mode === 'local' || (mode === 'ai' && currentSlot === 0) || (mode === 'online' && mySlot === currentSlot);

  const claimed = board.scores[0] + board.scores[1];
  const remaining = board.pairs - claimed;

  // -- turn clock -----------------------------------------------------------
  //
  // The remaining seconds are stored *with* the turn they belong to. Anything
  // looser double-fires: the forfeit lands, the turn (and epoch) changes, and
  // the expiry effect re-runs against the previous render's `0` before a reset
  // effect could have replaced it — forfeiting the incoming player's turn too.
  const total = board.turnSeconds;
  const timed = total > 0;
  const [clock, setClock] = useState(() => ({ epoch: turnEpoch, total, left: total }));
  const fresh = clock.epoch === turnEpoch && clock.total === total;
  if (!fresh) setClock({ epoch: turnEpoch, total, left: total });
  const left = fresh ? clock.left : total;

  const firedFor = useRef(-1);
  const hidden = useSyncedHidden();

  const live = timed && playing && controls && !aiThinking && !pending && !hidden;

  useEffect(() => {
    if (!live) return;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      setClock((c) =>
        c.epoch === turnEpoch && c.total === total
          ? { ...c, left: Math.max(0, c.left - dt) }
          : c,
      );
    }, TICK_MS);
    return () => clearInterval(id);
  }, [live, turnEpoch, total]);

  useEffect(() => {
    if (!live || !fresh || left > 0) return;
    if (firedFor.current === turnEpoch) return; // one forfeit per turn, ever
    firedFor.current = turnEpoch;
    sound.playLose();
    onMove({ pass: true }, currentSlot);
  }, [live, fresh, left, turnEpoch, onMove, currentSlot]);

  // -- pulse ----------------------------------------------------------------
  const pulseArmed = (slot: PlayerSlot): boolean => {
    if (!playing || slot !== currentSlot || board.pulses[slot] <= 0) return false;
    if (board.pulse) return false;
    // Legal only at the top of a turn — a face-up pick locks it out.
    if (!board.pendingClear && board.up.length > 0) return false;
    if (mode === 'ai') return slot === 0 && !aiThinking;
    if (mode === 'online') return mySlot === slot && !pending;
    return true;
  };

  // Slot 1 mirrors so both pulses sit outboard and the scores face the centre.
  const score = (slot: PlayerSlot) => (
    <div className={`flex items-center gap-1.5 ${slot === 1 ? 'flex-row-reverse' : ''}`}>
      <span
        className="mono text-[19px] font-bold leading-none tabular-nums transition-colors"
        style={{
          color: board.scores[slot] > 0 ? profiles[slot].color : '#64748b',
          textShadow:
            board.scores[slot] > 0 ? `0 0 16px ${rgba(profiles[slot].color, 0.6)}` : undefined,
        }}
        data-testid={`pairs-${slot}`}
      >
        {board.scores[slot]}
      </span>
      <PulseButton
        profile={profiles[slot]}
        slot={slot}
        available={board.pulses[slot] > 0}
        armed={pulseArmed(slot)}
        onFire={() => onMove({ pulse: true }, slot)}
      />
    </div>
  );

  return (
    <div
      className="glass-pill anim-fade-up flex items-center gap-2.5 px-3 py-1.5"
      data-testid="quantum-hud"
    >
      {score(0)}

      <span className="flex min-w-[4.5rem] flex-col items-center leading-none">
        <span className="mono text-[13px] font-bold text-slate-100" data-testid="pairs-left">
          {remaining}
        </span>
        <span className="mt-0.5 text-[8.5px] font-bold uppercase tracking-[0.15em] text-slate-400">
          {remaining === 1 ? 'pair left' : 'pairs left'}
        </span>
      </span>

      {timed && playing && (
        <TimerRing seconds={left} total={total} live={live} tint={profiles[currentSlot].color} />
      )}

      {board.pulse && (
        <span
          className="anim-pop glass-pill px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]"
          style={{ color: profiles[board.pulseBy ?? currentSlot].color }}
          data-testid="pulse-live"
        >
          Pulse
        </span>
      )}

      <span className="h-4 w-px bg-white/15" />
      {score(1)}
    </div>
  );
};

/** `true` while the tab is backgrounded — the clock must not run there. */
function useSyncedHidden(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  );
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

export default QuantumHud;
