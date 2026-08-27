// ============================================================================
// Quantum Pairs — the pre-match overlay.
//
// Two beats, one surface:
//
//   1. MATCH SETTINGS — board size, artifact theme, turn timer. Emitted as
//      `{ config }` moves, which the engine only accepts before play starts.
//      Online: the host (slot 0) edits, the guest watches live and read-only.
//
//   2. THE OPENER — rock-paper-scissors with hidden simultaneous commits.
//      Solo:      NOVA locks in the moment you reach the sigils.
//      Pass&Play: a shield covers the screen between the two seats.
//      Online:    you send your sigil and wait for theirs to land.
//      A tie plays an "Again!" beat and re-rolls; the round counter is visible.
//
// The winner of the opener moves first, which is exactly `core.currentSlot`
// once the engine flips `phase` to 'play'.
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { GameMode, Move, PlayerProfile, PlayerSlot } from '../types';
import type { MemoryBoard, MemorySize, MemoryTheme, RpsPick } from '../games/memory/logic';
import QuantumSettings from './QuantumSettings';
import { AvatarGlyph, GlassButton, Icon, ThinkingDots, rgba } from './GlassUI';
import { sound } from '../services/sound';

const TIE_BEAT_MS = 1900;
const REVEAL_MS = 2600;

const PICKS: RpsPick[] = ['rock', 'paper', 'scissors'];

const PICK_LABEL: Record<RpsPick, string> = {
  rock: 'Rock',
  paper: 'Paper',
  scissors: 'Scissors',
};

/** Who beats whom, plus the line announced on the reveal. */
const BEATS: Record<RpsPick, { loses: RpsPick; line: string }> = {
  rock: { loses: 'scissors', line: 'Rock crushes Scissors' },
  paper: { loses: 'rock', line: 'Paper smothers Rock' },
  scissors: { loses: 'paper', line: 'Scissors slice Paper' },
};

/* -------------------------------------------------------------------------- */

const Sigil: React.FC<{ pick: RpsPick; size?: number }> = ({ pick, size = 40 }) => {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 48 48',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.1,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (pick === 'paper') {
    return (
      <svg {...common} aria-hidden>
        <path d="M13 9h13l9 9v21a2 2 0 0 1-2 2H13a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z" />
        <path d="M26 9v9h9" />
        <path d="M17 26h13M17 32h10" opacity=".7" />
      </svg>
    );
  }
  if (pick === 'scissors') {
    return (
      <svg {...common} aria-hidden>
        <path d="M13 8l17 24M35 8L18 32" />
        <circle cx="15" cy="38" r="5" />
        <circle cx="33" cy="38" r="5" />
        <path d="M24 22l3 4" opacity=".7" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden>
      <path d="M11 29l6-13 12-5 10 9-3 13-15 4z" />
      <path d="M17 16l6 8 6-9M23 24l-12 5M23 24l3 12" opacity=".7" />
    </svg>
  );
};

const SigilButton: React.FC<{
  pick: RpsPick;
  tint: string;
  delay: number;
  onPick: (p: RpsPick) => void;
}> = ({ pick, tint, delay, onPick }) => (
  <button
    type="button"
    data-testid={`rps-${pick}`}
    aria-label={PICK_LABEL[pick]}
    onClick={() => {
      sound.playClick();
      onPick(pick);
    }}
    className="press anim-pop group flex flex-col items-center gap-2"
    style={{ animationDelay: `${delay}ms` }}
  >
    <span
      className="grid h-[76px] w-[76px] place-items-center rounded-full transition-all duration-300 group-hover:-translate-y-1 sm:h-20 sm:w-20"
      style={{
        background: `radial-gradient(circle at 34% 26%, ${rgba(tint, 0.34)}, rgba(2,6,23,.72))`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,.2), inset 0 0 0 1px ${rgba(tint, 0.45)}, 0 14px 34px -18px ${rgba(tint, 0.95)}`,
        color: tint,
      }}
    >
      <Sigil pick={pick} size={40} />
    </span>
    <span className="text-[12px] font-semibold tracking-tight text-slate-300 group-hover:text-white">
      {PICK_LABEL[pick]}
    </span>
  </button>
);

/** A committed sigil, face-down until the reveal. */
const SigilCard: React.FC<{
  profile: PlayerProfile;
  pick: RpsPick | null;
  won: boolean | null;
  first?: boolean;
}> = ({ profile, pick, won, first }) => (
  <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
    <span
      className="grid h-[72px] w-[72px] place-items-center rounded-3xl transition-all duration-500"
      style={{
        background:
          pick === null
            ? 'rgba(255,255,255,.05)'
            : `radial-gradient(circle at 34% 26%, ${rgba(profile.color, 0.36)}, rgba(2,6,23,.75))`,
        boxShadow:
          won === true
            ? `inset 0 0 0 1.5px ${rgba(profile.color, 0.9)}, 0 16px 40px -18px ${rgba(profile.color, 1)}`
            : 'inset 0 0 0 1px rgba(255,255,255,.1)',
        color: pick === null ? '#64748b' : profile.color,
        opacity: won === false ? 0.45 : 1,
      }}
    >
      {pick === null ? (
        <Icon name="sparkle" size={26} className="opacity-50" />
      ) : (
        <span className="anim-pop">
          <Sigil pick={pick} size={38} />
        </span>
      )}
    </span>
    <span className="flex items-center gap-1.5">
      <AvatarGlyph type={profile.avatarId} color={profile.color} size={16} />
      <span className="max-w-[6.5rem] truncate text-[12px] font-semibold text-slate-200">
        {profile.name}
      </span>
    </span>
    {first && (
      <span
        className="glass-pill px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em]"
        style={{ color: profile.color }}
      >
        Moves first
      </span>
    )}
  </div>
);

/* -------------------------------------------------------------------------- */

type Stage = 'settings' | 'commit' | 'reveal';

export interface QuantumOpenerProps {
  board: MemoryBoard;
  /** Turn holder once the engine flips to 'play' — i.e. the opener's winner. */
  currentSlot: PlayerSlot;
  mode: GameMode;
  mySlot: PlayerSlot | null;
  profiles: [PlayerProfile, PlayerProfile];
  /** Online: settings are host-only, and nothing is legal until the room fills. */
  settingsEditable: boolean;
  settingsNote?: string | null;
  waitingForOpponent?: boolean;
  onMove: (move: Move, slot?: PlayerSlot) => void;
  /** The player has reached the sigils — NOVA may commit its hidden pick. */
  onArmed: () => void;
  /** Reveal is over; hand the screen to the board. */
  onDone: () => void;
}

const QuantumOpener: React.FC<QuantumOpenerProps> = ({
  board,
  currentSlot,
  mode,
  mySlot,
  profiles,
  settingsEditable,
  settingsNote,
  waitingForOpponent,
  onMove,
  onArmed,
  onDone,
}) => {
  const [stage, setStage] = useState<Stage>('settings');
  const [tie, setTie] = useState<{ round: number; pick: RpsPick | null } | null>(null);
  /** Pass & Play: the seat that has already lifted the "pass the device" shield. */
  const [unshielded, setUnshielded] = useState<PlayerSlot | null>(null);
  const lastPickRef = useRef<RpsPick | null>(null);

  const passPlay = mode === 'local';
  /** The seat this device commits for right now. */
  const seat: PlayerSlot = passPlay
    ? board.picks[0] === null
      ? 0
      : 1
    : mode === 'online'
      ? (mySlot ?? 0)
      : 0;
  const foe: PlayerSlot = seat === 0 ? 1 : 0;
  const committed = board.picks[seat] !== null;

  // -- tie: the engine clears both picks and bumps the round ----------------
  const roundRef = useRef(board.rpsRound);
  useEffect(() => {
    if (board.rpsRound === roundRef.current) return;
    const grew = board.rpsRound > roundRef.current;
    roundRef.current = board.rpsRound;
    if (!grew) return;
    sound.playClick();
    setTie({ round: board.rpsRound, pick: lastPickRef.current });
    setUnshielded(null);
  }, [board.rpsRound]);

  useEffect(() => {
    if (!tie) return;
    const t = setTimeout(() => setTie(null), TIE_BEAT_MS);
    return () => clearTimeout(t);
  }, [tie]);

  // -- resolution ------------------------------------------------------------
  useEffect(() => {
    if (board.phase !== 'play') return;
    setStage('reveal');
    setTie(null);
    sound.playStart();
    const t = setTimeout(onDone, REVEAL_MS);
    return () => clearTimeout(t);
  }, [board.phase, onDone]);

  useEffect(() => {
    if (stage === 'commit') onArmed();
  }, [stage, onArmed]);

  const commit = useCallback(
    (pick: RpsPick) => {
      lastPickRef.current = pick;
      onMove({ rps: pick }, seat);
      if (passPlay) setUnshielded(null);
    },
    [onMove, seat, passPlay],
  );

  const changeConfig = useCallback(
    (cfg: { size?: MemorySize; theme?: MemoryTheme; turnSeconds?: number }) => {
      onMove({ config: cfg }, 0);
    },
    [onMove],
  );

  /* ------------------------------------------------------------------ views */

  const heading = (title: string, sub: string) => (
    <div className="text-center">
      <span className="label">Quantum Pairs</span>
      <h2 className="text-glow mt-1.5 font-display text-2xl font-bold tracking-tight">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-[22rem] text-[13px] leading-snug text-slate-400">{sub}</p>
    </div>
  );

  let body: React.ReactNode;

  if (stage === 'settings') {
    body = (
      <>
        {heading(
          'Match settings',
          settingsEditable
            ? 'Set the table, then win the opener to move first.'
            : 'Your host is setting the table.',
        )}
        <div className="mt-5">
          <QuantumSettings
            board={board}
            editable={settingsEditable}
            lockNote={settingsNote}
            onChange={changeConfig}
          />
        </div>
        <GlassButton
          variant="primary"
          block
          className="mt-6 !py-3.5"
          data-testid="opener-begin"
          onClick={() => setStage('commit')}
        >
          Begin the opener
          <Icon name="back" size={18} className="rotate-180" />
        </GlassButton>
      </>
    );
  } else if (stage === 'reveal') {
    const [a, z] = board.picks;
    const winner = currentSlot;
    const win = a && z ? (BEATS[a].loses === z ? a : z) : null;
    body = (
      <>
        {heading(
          `${profiles[winner].name} takes the opener`,
          win ? `${BEATS[win].line} — they reveal the first tile.` : 'The opener is settled.',
        )}
        <div className="mt-6 flex items-start justify-center gap-4">
          <SigilCard
            profile={profiles[0]}
            pick={a}
            won={winner === 0}
            first={winner === 0}
          />
          <span className="mt-6 font-display text-lg font-bold text-slate-500">vs</span>
          <SigilCard
            profile={profiles[1]}
            pick={z}
            won={winner === 1}
            first={winner === 1}
          />
        </div>
        <p
          className="mt-6 text-center text-[12px] font-semibold tracking-wide"
          style={{ color: profiles[winner].color }}
          data-testid="opener-result"
        >
          {profiles[winner].name} moves first
        </p>
      </>
    );
  } else if (tie) {
    // -- "Again!" beat ------------------------------------------------------
    body = (
      <div className="py-2 text-center" data-testid="rps-tie">
        <span className="label">Round {tie.round}</span>
        <h2
          className="anim-pop text-glow mt-2 font-display text-4xl font-bold tracking-tight"
          style={{ color: '#fcd34d' }}
        >
          Again!
        </h2>
        <p className="mt-2 text-[13px] text-slate-400">
          {tie.pick ? `Both chose ${PICK_LABEL[tie.pick]}.` : 'Both sigils matched.'} Nobody moves
          first on a mirror.
        </p>
        <div className="mt-5 flex items-center justify-center gap-6 text-slate-300">
          {[0, 1].map((i) => (
            <span
              key={i}
              className="anim-pop grid h-16 w-16 place-items-center rounded-3xl"
              style={{
                animationDelay: `${i * 90}ms`,
                background: `radial-gradient(circle at 34% 26%, ${rgba(profiles[i as PlayerSlot].color, 0.3)}, rgba(2,6,23,.75))`,
                boxShadow: `inset 0 0 0 1px ${rgba(profiles[i as PlayerSlot].color, 0.5)}`,
                color: profiles[i as PlayerSlot].color,
              }}
            >
              {tie.pick ? <Sigil pick={tie.pick} size={34} /> : <Icon name="sparkle" size={26} />}
            </span>
          ))}
        </div>
      </div>
    );
  } else if (passPlay && unshielded !== seat) {
    // -- pass-the-device shield --------------------------------------------
    body = (
      <div className="py-2 text-center" data-testid="rps-shield">
        <span className="label">Hidden commit</span>
        <div
          className="mx-auto mt-4 grid h-20 w-20 place-items-center rounded-3xl"
          style={{
            background: `radial-gradient(circle at 34% 26%, ${rgba(profiles[seat].color, 0.42)}, rgba(2,6,23,.75))`,
            boxShadow: `0 14px 34px -14px ${rgba(profiles[seat].color, 0.95)}`,
          }}
        >
          <AvatarGlyph type={profiles[seat].avatarId} color={profiles[seat].color} size={50} />
        </div>
        <h2 className="mt-4 font-display text-2xl font-bold tracking-tight">
          Pass to {profiles[seat].name}
        </h2>
        <p className="mx-auto mt-1.5 max-w-[20rem] text-[13px] leading-snug text-slate-400">
          {seat === 0
            ? 'Nobody may see this pick. Hand the device over, then reveal the sigils.'
            : `${profiles[0].name} has locked in. Your turn to choose in secret.`}
        </p>
        <GlassButton
          variant="primary"
          block
          className="mt-6 !py-3.5"
          data-testid="rps-shield-go"
          onClick={() => setUnshielded(seat)}
        >
          I'm {profiles[seat].name}
        </GlassButton>
      </div>
    );
  } else {
    // -- commit -------------------------------------------------------------
    const opponentIn = board.picks[foe] !== null;
    const waiting = committed;
    body = (
      <>
        {heading(
          waiting ? 'Locked in' : passPlay ? `${profiles[seat].name}, choose in secret` : 'Choose your sigil',
          waiting
            ? mode === 'ai'
              ? 'NOVA is committing to a sigil of its own.'
              : `Waiting for ${profiles[foe].name} to commit.`
            : 'Both sigils stay hidden until they are in. The winner reveals the first tile.',
        )}

        {board.rpsRound > 1 && (
          <p className="mono mt-2 text-center text-[11px] tracking-[0.2em] text-amber-300/80">
            ROUND {board.rpsRound}
          </p>
        )}

        {waiting ? (
          <div className="mt-7 flex flex-col items-center gap-4">
            <span
              className="anim-pop grid h-[76px] w-[76px] place-items-center rounded-full"
              style={{
                background: `radial-gradient(circle at 34% 26%, ${rgba(profiles[seat].color, 0.36)}, rgba(2,6,23,.75))`,
                boxShadow: `inset 0 0 0 1px ${rgba(profiles[seat].color, 0.6)}`,
                color: profiles[seat].color,
              }}
            >
              {board.picks[seat] && <Sigil pick={board.picks[seat]!} size={38} />}
            </span>
            <span className="glass-pill flex items-center gap-2 px-3.5 py-1.5 text-[12px] text-slate-300">
              {opponentIn ? 'Resolving…' : `${profiles[foe].name} is choosing`}
              <ThinkingDots color={profiles[foe].color} />
            </span>
          </div>
        ) : (
          <>
            <div className="mt-7 flex items-start justify-center gap-3.5 sm:gap-5">
              {PICKS.map((p, i) => (
                <SigilButton
                  key={p}
                  pick={p}
                  tint={profiles[seat].color}
                  delay={i * 70}
                  onPick={commit}
                />
              ))}
            </div>
            {mode === 'ai' && (
              <p className="mt-6 text-center text-[12px] text-slate-400">
                {opponentIn ? (
                  <span className="glass-pill px-3 py-1 text-cyan-200">NOVA has locked in</span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    NOVA is committing
                    <ThinkingDots />
                  </span>
                )}
              </p>
            )}
            {mode === 'online' && waitingForOpponent && (
              <p className="mt-6 text-center text-[12px] text-slate-400">
                Your opponent has not joined the room yet.
              </p>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <div
      className="anim-fade-in absolute inset-0 z-[45] flex items-center justify-center overflow-y-auto px-4 py-6"
      style={{ background: 'rgba(3,4,14,.62)', backdropFilter: 'blur(10px)' }}
      data-testid="quantum-opener"
    >
      <div className="glass-strong anim-spring w-full max-w-md rounded-[26px] p-6">{body}</div>
    </div>
  );
};

export default QuantumOpener;
