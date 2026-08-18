import React from 'react';
import type { GameCore, GameMode, PlayerProfile, PlayerSlot } from '../types';
import { AvatarGlyph, GlassButton, Icon, rgba } from './GlassUI';

interface WinOverlayProps {
  winner: NonNullable<GameCore['winner']>;
  profiles: [PlayerProfile, PlayerProfile];
  mode: GameMode;
  mySlot?: PlayerSlot | null;
  round?: number;
  rematchPending?: boolean;
  onRematch: () => void;
  onExit: () => void;
}

const WinOverlay: React.FC<WinOverlayProps> = ({
  winner,
  profiles,
  mode,
  mySlot = null,
  round,
  rematchPending,
  onRematch,
  onExit,
}) => {
  const draw = winner === 'DRAW';
  const champ = draw ? null : profiles[winner as PlayerSlot];
  const tint = champ?.color ?? '#94a3b8';

  const headline = draw
    ? 'Stalemate'
    : mode === 'ai'
      ? winner === 0
        ? 'Victory!'
        : 'NOVA wins'
      : mode === 'online' && mySlot !== null
        ? winner === mySlot
          ? 'Victory!'
          : 'Defeated'
        : `${champ?.name} wins`;

  const sub = draw
    ? 'Nobody claims the sector this round.'
    : mode === 'local'
      ? `${champ?.name} takes the round.`
      : mode === 'ai' && winner === 1
        ? 'The machine holds the line. Run it back?'
        : 'The galaxy is yours — for now.';

  return (
    <>
      {/* Scrim keeps the card legible without hiding the winning line. */}
      <div
        className="anim-fade-in pointer-events-none absolute inset-0 z-40"
        style={{
          background:
            'linear-gradient(180deg, rgba(3,4,14,0) 38%, rgba(3,4,14,.55) 72%, rgba(3,4,14,.88) 100%)',
        }}
      />
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-50 flex justify-center p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div
        className="glass-strong anim-spring pointer-events-auto w-full max-w-sm overflow-hidden rounded-[26px] p-6 text-center"
        style={{ boxShadow: `0 0 0 1px ${rgba(tint, 0.28)}, 0 30px 70px -24px ${rgba(tint, 0.75)}` }}
      >
        <div
          className="mx-auto grid h-20 w-20 place-items-center rounded-full"
          style={{
            background: `radial-gradient(circle at 34% 26%, ${rgba(tint, 0.5)}, rgba(2,6,23,.75))`,
            boxShadow: `0 14px 34px -14px ${rgba(tint, 0.95)}`,
          }}
        >
          {draw ? (
            <Icon name="sparkle" size={34} className="text-slate-300" />
          ) : (
            <AvatarGlyph type={champ!.avatarId} color={tint} size={52} />
          )}
        </div>

        <h2
          className="text-glow mt-4 font-display text-3xl font-bold tracking-tight"
          style={{ color: draw ? '#e2e8f0' : tint }}
        >
          {headline}
        </h2>
        <p className="mt-1.5 text-sm text-slate-400">{sub}</p>

        {typeof round === 'number' && round > 1 && (
          <p className="mono mt-2 text-[11px] tracking-[0.2em] text-slate-500">ROUND {round}</p>
        )}

        <div className="mt-6 flex gap-2.5">
          <GlassButton onClick={onExit} className="!py-3">
            <Icon name="close" size={16} />
            Exit
          </GlassButton>
          <GlassButton
            variant="primary"
            block
            onClick={onRematch}
            disabled={rematchPending}
            className="!py-3"
          >
            {rematchPending ? (
              <span className="shimmer relative overflow-hidden rounded px-1">
                <span className="relative z-10">Waiting…</span>
              </span>
            ) : (
              <>
                <Icon name="reset" size={16} />
                Rematch
              </>
            )}
          </GlassButton>
        </div>
      </div>
    </div>
    </>
  );
};

export default WinOverlay;
