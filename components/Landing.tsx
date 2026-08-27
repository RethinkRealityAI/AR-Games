import React, { useState } from 'react';
import { GAME_LIST } from '../games/registry';
import type { GameId } from '../types';
import { AuroraBackground, Icon, rgba, useTilt } from './GlassUI';
import { sound } from '../services/sound';

/**
 * Artwork that degrades gracefully: the gradient + glyph beneath always looks
 * intentional, and the bitmap simply fades in on top when it exists.
 */
const ArtLayer: React.FC<{
  src: string;
  alt: string;
  className?: string;
}> = ({ src, alt, className = '' }) => {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setOk(false)}
      className={`absolute inset-0 h-full w-full object-cover ${className}`}
    />
  );
};

const GAME_GLYPH: Record<GameId, React.ReactNode> = {
  tictactoe: (
    <svg viewBox="0 0 64 64" className="h-full w-full" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="2.2" opacity=".55" strokeLinecap="round">
        <path d="M24 10v44M40 10v44M10 24h44M10 40h44" />
      </g>
      <g stroke="currentColor" strokeWidth="4" strokeLinecap="round">
        <path d="M13.5 13.5l7 7M20.5 13.5l-7 7" />
        <path d="M45.5 29.5l7 7M52.5 29.5l-7 7" />
      </g>
      <circle cx="32" cy="32" r="5.5" stroke="currentColor" strokeWidth="4" />
      <circle cx="16.5" cy="48" r="5.5" stroke="currentColor" strokeWidth="4" opacity=".7" />
    </svg>
  ),
  connect4: (
    <svg viewBox="0 0 64 64" className="h-full w-full" fill="none" aria-hidden>
      <rect x="7" y="12" width="50" height="42" rx="7" stroke="currentColor" strokeWidth="2.4" opacity=".6" />
      {[0, 1, 2, 3].map((r) =>
        [0, 1, 2, 3, 4].map((c) => {
          const filled = (r === 3 && c < 3) || (r === 2 && c === 2) || (r === 3 && c === 4);
          return (
            <circle
              key={`${r}-${c}`}
              cx={13.5 + c * 9.3}
              cy={20 + r * 9.3}
              r="3.4"
              stroke="currentColor"
              strokeWidth="1.6"
              fill={filled ? 'currentColor' : 'none'}
              opacity={filled ? 0.95 : 0.45}
            />
          );
        }),
      )}
    </svg>
  ),
  chess: (
    <svg viewBox="0 0 64 64" className="h-full w-full" fill="none" aria-hidden>
      {/* knight silhouette */}
      <path
        d="M24 52h20M26 48h16M40 44c2-6 6-10 6-18 0-10-8-16-16-16l2 5c-6 1-11 6-13 12l-3 8 6-2 3-4c1 3 0 6-2 9-2 2-3 4-3 6h20z"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="30" cy="22" r="1.6" fill="currentColor" />
    </svg>
  ),
  memory: (
    <svg viewBox="0 0 64 64" className="h-full w-full" fill="none" aria-hidden>
      {/* a grid of tiles, two of them entangled */}
      <g stroke="currentColor" strokeWidth="2.2">
        <rect x="8" y="10" width="20" height="20" rx="5" opacity=".9" />
        <rect x="36" y="10" width="20" height="20" rx="5" opacity=".45" />
        <rect x="8" y="36" width="20" height="20" rx="5" opacity=".45" />
        <rect x="36" y="36" width="20" height="20" rx="5" opacity=".9" />
      </g>
      <circle cx="18" cy="20" r="4.5" fill="currentColor" />
      <circle cx="46" cy="46" r="4.5" fill="currentColor" />
      <path d="M22 24l20 18" stroke="currentColor" strokeWidth="2" strokeDasharray="3 3" opacity=".8" />
    </svg>
  ),
};

const CARD_TINT: Record<GameId, [string, string]> = {
  tictactoe: ['#22d3ee', '#8b5cf6'],
  connect4: ['#e879f9', '#38bdf8'],
  chess: ['#fbbf24', '#7c3aed'],
  memory: ['#34d399', '#6366f1'],
};

/**
 * One game card. Its own component so each can own a `useTilt` instance —
 * hooks cannot live inside the `.map()`.
 */
const GameCard: React.FC<{
  game: (typeof GAME_LIST)[number];
  index: number;
  onPick: (id: GameId) => void;
}> = ({ game, index, onPick }) => {
  const { ref, tiltProps } = useTilt<HTMLButtonElement>();
  const [c1, c2] = CARD_TINT[game.meta.id];

  return (
    // The entrance animation lives on the wrapper: it animates `transform`
    // with fill-mode both, which would otherwise permanently pin the tilt.
    <div className="anim-card-in h-full" style={{ animationDelay: `${120 + index * 110}ms` }}>
    <button
      ref={ref}
      {...tiltProps}
      onClick={() => {
        sound.resume();
        sound.playStart();
        onPick(game.meta.id);
      }}
      className="glass tilt group relative block h-full w-full overflow-hidden rounded-[24px] text-left"
    >
      <div className="relative h-40 overflow-hidden sm:h-44">
        <div
          className="absolute inset-0 transition-transform duration-500 group-hover:scale-105"
          style={{
            background:
              `radial-gradient(120% 130% at 20% 10%, ${rgba(c1, 0.6)}, transparent 60%),` +
              `radial-gradient(120% 130% at 85% 90%, ${rgba(c2, 0.55)}, transparent 62%),` +
              'linear-gradient(150deg,#0a1130,#080816)',
          }}
        />
        <ArtLayer
          src={game.meta.cardArt}
          alt={game.meta.name}
          className="opacity-80 transition-transform duration-500 group-hover:scale-105"
        />
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(180deg, rgba(3,4,14,0) 35%, rgba(3,4,14,.9) 100%)',
          }}
        />
        <div
          className="anim-float absolute right-4 top-4 h-16 w-16 opacity-70 sm:h-20 sm:w-20"
          style={{ color: c1 }}
        >
          {GAME_GLYPH[game.meta.id]}
        </div>
      </div>

      <div className="relative flex items-end justify-between gap-3 px-5 pb-5 pt-4">
        <div className="min-w-0">
          <h3 className="font-display text-xl font-bold tracking-tight text-white">
            {game.meta.name}
          </h3>
          <p className="mt-1 text-[13px] leading-snug text-slate-400">{game.meta.tagline}</p>
        </div>
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full transition-transform duration-300 group-hover:translate-x-0.5"
          style={{
            background: `linear-gradient(135deg, ${rgba(c1, 0.9)}, ${rgba(c2, 0.9)})`,
            color: '#050510',
          }}
        >
          <Icon name="back" size={18} className="rotate-180" />
        </span>
      </div>
    </button>
    </div>
  );
};

const Landing: React.FC<{ onPickGame: (id: GameId) => void }> = ({ onPickGame }) => (
  <div className="relative h-full overflow-y-auto overflow-x-hidden">
    <AuroraBackground />

    <div className="relative z-10 mx-auto flex min-h-full w-full max-w-5xl flex-col px-5 pb-10 pt-8 sm:px-8 sm:pt-12">
      {/* ---------------------------------------------------------------- hero */}
      <header className="anim-fade-in relative overflow-hidden rounded-[28px]">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 130% at 12% 0%, rgba(34,211,238,.45), transparent 55%),' +
              'radial-gradient(120% 120% at 88% 20%, rgba(139,92,246,.5), transparent 58%),' +
              'radial-gradient(140% 140% at 50% 120%, rgba(232,121,249,.35), transparent 60%),' +
              'linear-gradient(160deg,#0b1030,#070718)',
          }}
        />
        <ArtLayer src="/assets/hero.webp" alt="" className="opacity-60 mix-blend-screen" />
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(180deg, rgba(5,5,16,.15) 20%, rgba(5,5,16,.82) 100%)' }}
        />

        {/* Cascade: eyebrow, wordmark, blurb, then the mode pills. */}
        <div className="relative px-6 py-12 text-center sm:px-12 sm:py-16">
          <span
            className="glass-pill anim-fade-up inline-flex items-center gap-1.5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-200"
            style={{ animationDelay: '40ms' }}
          >
            <Icon name="sparkle" size={12} />
            AR arcade
          </span>

          <h1
            className="text-glow anim-fade-up mt-5 font-display text-[2.6rem] font-bold leading-[0.92] tracking-[-0.045em] sm:text-7xl"
            style={{ animationDelay: '120ms' }}
          >
            <span className="text-gradient">COSMIC</span>
            <br />
            <span className="text-gradient">ARCADE</span>
          </h1>

          <p
            className="anim-fade-up mx-auto mt-5 max-w-md text-sm leading-relaxed text-slate-300 sm:text-base"
            style={{ animationDelay: '240ms' }}
          >
            Tabletop games rebuilt as holograms. Place a board on your desk in AR, or spin the
            holo-table right here — solo against the machine, side-by-side, or across the galaxy.
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-[11px] text-slate-400">
            {['Solo vs AI', 'Pass & Play', 'Online Match'].map((t, i) => (
              <span
                key={t}
                className="glass-pill anim-fade-up px-3 py-1.5 font-medium text-slate-200"
                style={{ animationDelay: `${330 + i * 70}ms` }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------------- cards */}
      <section className="mt-9">
        <h2 className="label mb-3 ml-1">Choose your game</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {GAME_LIST.map((game, i) => (
            <GameCard key={game.meta.id} game={game} index={i} onPick={onPickGame} />
          ))}
        </div>
      </section>

      <footer className="mt-auto pt-10 text-center">
        <p className="text-[11px] tracking-[0.18em] text-slate-500">
          POWERED BY WEBXR • THREE.JS • GEMINI
        </p>
      </footer>
    </div>
  </div>
);

export default Landing;
