import React, { useEffect, useState } from 'react';
import type { GameCore, GameMode, PlayerProfile, PlayerSlot, Session } from '../types';
import { AvatarDot, Icon, ThinkingDots, rgba } from './GlassUI';

const AWAY_AFTER_MS = 10_000;

interface HudProps {
  profiles: [PlayerProfile, PlayerProfile];
  currentSlot: PlayerSlot;
  winner: GameCore['winner'];
  mode: GameMode;
  mySlot?: PlayerSlot | null;
  aiThinking?: boolean;
  /** Waiting on the server to echo a move back. */
  pending?: boolean;
  session?: Session | null;
  /** Shown only when the chat dock has been switched off entirely. */
  onRestoreChat?: () => void;
}

const PlayerChip: React.FC<{
  profile: PlayerProfile;
  active: boolean;
  presence?: 'connected' | 'away' | null;
  you?: boolean;
}> = ({ profile, active, presence, you }) => (
  <div
    className="relative flex items-center gap-2 rounded-full px-2 py-1 transition-all duration-300"
    style={{
      background: active ? rgba(profile.color, 0.16) : 'transparent',
      opacity: active ? 1 : 0.55,
    }}
  >
    <span
      className={active ? 'pulse-ring rounded-full' : 'rounded-full'}
      style={{ ['--pulse' as string]: rgba(profile.color, 0.55) }}
    >
      <AvatarDot type={profile.avatarId} color={profile.color} size={24} glow={active} />
    </span>
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        className="max-w-[7.5rem] truncate text-[13px] font-semibold tracking-tight"
        style={{ color: active ? '#fff' : '#cbd5e1' }}
      >
        {profile.name}
      </span>
      {you && <span className="text-[9px] font-bold tracking-widest text-slate-400">YOU</span>}
      {presence && (
        <span
          title={presence === 'connected' ? 'Connected' : 'Away'}
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            background: presence === 'connected' ? '#34d399' : '#f59e0b',
            boxShadow: `0 0 8px ${presence === 'connected' ? '#34d399' : '#f59e0b'}`,
          }}
        />
      )}
    </span>
  </div>
);

const Hud: React.FC<HudProps> = ({
  profiles,
  currentSlot,
  winner,
  mode,
  mySlot = null,
  aiThinking,
  pending,
  session,
  onRestoreChat,
}) => {
  // Tick so `lastSeen` based presence decays without a network event.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (mode !== 'online') return;
    const id = setInterval(() => setTick((t) => t + 1), 4000);
    return () => clearInterval(id);
  }, [mode]);

  const presenceFor = (slot: PlayerSlot): 'connected' | 'away' | null => {
    if (mode !== 'online' || !session) return null;
    const p = session.players[slot];
    if (!p) return 'away';
    if (!p.connected) return 'away';
    return Date.now() - p.lastSeen > AWAY_AFTER_MS ? 'away' : 'connected';
  };

  // NB: PlayerSlot 0 is falsy — every winner check must compare against null.
  const over = winner !== null;

  const turnLabel = (): string => {
    if (over) return winner === 'DRAW' ? 'Stalemate' : `${profiles[winner as PlayerSlot].name} wins`;
    if (mode === 'online') return currentSlot === mySlot ? 'Your move' : 'Their move';
    if (mode === 'ai') return currentSlot === 0 ? 'Your move' : 'NOVA is moving';
    return `${profiles[currentSlot].name}'s move`;
  };

  const turnColor =
    over && winner !== 'DRAW'
      ? profiles[winner as PlayerSlot].color
      : over
        ? '#e2e8f0'
        : profiles[currentSlot].color;

  return (
    <div className="no-tap absolute inset-x-0 top-0 z-40 flex flex-col items-center gap-2 px-3 pt-[max(0.85rem,env(safe-area-inset-top))]">
      <div className="glass-pill anim-fade-up flex max-w-full items-center gap-1 px-2 py-1.5">
        <PlayerChip
          profile={profiles[0]}
          active={over ? winner === 0 : currentSlot === 0}
          presence={presenceFor(0)}
          you={mode === 'online' && mySlot === 0}
        />
        <span className="mx-0.5 h-4 w-px shrink-0 bg-white/15" />
        <PlayerChip
          profile={profiles[1]}
          active={over ? winner === 1 : currentSlot === 1}
          presence={presenceFor(1)}
          you={mode === 'online' && mySlot === 1}
        />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <span
          className="glass-pill px-3 py-1 text-[11px] font-semibold tracking-wide"
          style={{ color: turnColor }}
        >
          {turnLabel()}
        </span>

        {mode === 'online' && session && (
          <span className="glass-pill mono px-2.5 py-1 text-[11px] font-bold tracking-[0.18em] text-slate-300">
            {session.code}
          </span>
        )}

        {aiThinking && !over && (
          <span className="glass-pill anim-pop flex items-center gap-2 px-3 py-1 text-[11px] font-medium text-cyan-200">
            NOVA is thinking
            <ThinkingDots />
          </span>
        )}

        {pending && !over && (
          <span className="glass-pill shimmer overflow-hidden px-3 py-1 text-[11px] font-medium text-slate-300">
            <span className="relative z-10">Syncing…</span>
          </span>
        )}

        {onRestoreChat && (
          <button
            onClick={onRestoreChat}
            aria-label="Show chat"
            className="yes-tap press glass-pill flex items-center gap-1 px-2.5 py-1 text-[11px] text-slate-300"
          >
            <Icon name="chat" size={13} />
            Chat
          </button>
        )}
      </div>
    </div>
  );
};

export default Hud;
