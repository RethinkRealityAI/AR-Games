import React, { useEffect, useMemo, useState } from 'react';
import type { AvatarType, GameMode, PlayerProfile } from '../types';
import {
  AVATAR_OPTIONS,
  AuroraBackground,
  AvatarGlyph,
  BackButton,
  ColorSwatches,
  DEFAULT_COLOR_P1,
  DEFAULT_COLOR_P2,
  GlassButton,
  Icon,
  rgba,
} from './GlassUI';
import { sound } from '../services/sound';

export const AI_PROFILE: PlayerProfile = {
  name: 'NOVA',
  avatarId: 'DRONE',
  color: DEFAULT_COLOR_P2,
};

export const DEFAULT_PROFILES: [PlayerProfile, PlayerProfile] = [
  { name: 'Commander', avatarId: 'ASTRONAUT', color: DEFAULT_COLOR_P1 },
  { name: 'Player 2', avatarId: 'CRYSTAL', color: DEFAULT_COLOR_P2 },
];

interface PlayerSetupProps {
  mode: GameMode;
  /** Headline context, e.g. the game name or "Joining ABC123". */
  contextLabel?: string;
  initial?: [PlayerProfile, PlayerProfile];
  onComplete: (profiles: [PlayerProfile, PlayerProfile]) => void;
  onBack: () => void;
}

const PlayerSetup: React.FC<PlayerSetupProps> = ({
  mode,
  contextLabel,
  initial = DEFAULT_PROFILES,
  onComplete,
  onBack,
}) => {
  const twoPlayers = mode === 'local';
  const [step, setStep] = useState<0 | 1>(0);
  const [p1, setP1] = useState<PlayerProfile>(initial[0]);
  const [p2, setP2] = useState<PlayerProfile>(initial[1]);

  const current = step === 0 ? p1 : p2;
  const setCurrent = step === 0 ? setP1 : setP2;

  // Keep the second player off the first player's colour.
  useEffect(() => {
    if (twoPlayers && step === 1 && p2.color === p1.color) {
      const next = p1.color === DEFAULT_COLOR_P2 ? DEFAULT_COLOR_P1 : DEFAULT_COLOR_P2;
      setP2((v) => ({ ...v, color: next }));
    }
  }, [step, twoPlayers, p1.color, p2.color]);

  const heading = useMemo(() => {
    if (twoPlayers) return step === 0 ? 'Player One' : 'Player Two';
    return 'Your Pilot';
  }, [twoPlayers, step]);

  const ctaLabel = twoPlayers && step === 0 ? 'Next player' : 'Launch';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!current.name.trim()) return;
    sound.resume();
    if (twoPlayers && step === 0) {
      sound.playClick();
      setStep(1);
      return;
    }
    sound.playStart();
    const a: PlayerProfile = { ...p1, name: p1.name.trim() || 'Player 1' };
    const b: PlayerProfile = twoPlayers
      ? { ...p2, name: p2.name.trim() || 'Player 2' }
      : mode === 'ai'
        ? { ...AI_PROFILE, color: p1.color === AI_PROFILE.color ? DEFAULT_COLOR_P1 : AI_PROFILE.color }
        : { ...p2, name: 'Opponent' };
    onComplete([a, b]);
  };

  return (
    <div className="relative h-full overflow-y-auto">
      <AuroraBackground />
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-md flex-col px-5 pb-10 pt-7 sm:px-8">
        <div className="mb-6 flex items-center justify-between">
          <BackButton
            onClick={() => {
              if (twoPlayers && step === 1) setStep(0);
              else onBack();
            }}
          />
          {contextLabel && <span className="label">{contextLabel}</span>}
        </div>

        <div className="flex flex-1 flex-col justify-center">
        <form onSubmit={submit} className="glass anim-spring rounded-[26px] p-6">
          <div className="mb-5 flex items-center gap-4">
            <span
              className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl"
              style={{
                background: `radial-gradient(circle at 34% 26%, ${rgba(current.color, 0.42)}, rgba(2,6,23,.7))`,
                boxShadow: `inset 0 1px 0 rgba(255,255,255,.16), 0 12px 30px -14px ${rgba(current.color, 0.9)}`,
              }}
            >
              <AvatarGlyph type={current.avatarId} color={current.color} size={46} />
            </span>
            <div className="min-w-0">
              <h1 className="font-display text-2xl font-bold tracking-tight">{heading}</h1>
              <p className="mt-0.5 text-[13px] text-slate-400">
                {twoPlayers
                  ? 'Both pilots share one device — pick distinct colours.'
                  : 'Name your pilot, pick a hull and a colour.'}
              </p>
            </div>
          </div>

          {twoPlayers && (
            <div className="mb-5 flex gap-1.5">
              {[0, 1].map((i) => (
                <span
                  key={i}
                  className="h-1 flex-1 rounded-full transition-colors"
                  style={{
                    background: i <= step ? 'linear-gradient(90deg,#67e8f9,#a78bfa)' : 'rgba(255,255,255,.12)',
                  }}
                />
              ))}
            </div>
          )}

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="label ml-1 block" htmlFor="callsign">
                Call sign
              </label>
              <input
                id="callsign"
                type="text"
                value={current.name}
                maxLength={14}
                autoComplete="off"
                onChange={(e) => setCurrent({ ...current, name: e.target.value })}
                placeholder="Enter name"
                className="w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3.5 font-medium tracking-wide text-white outline-none transition-all placeholder:text-white/25 focus:border-cyan-400/50 focus:bg-black/50"
              />
            </div>

            <div className="space-y-2.5">
              <span className="label ml-1 block">Hull</span>
              <div className="grid grid-cols-3 gap-2.5">
                {AVATAR_OPTIONS.map((opt, i) => {
                  const active = current.avatarId === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      title={opt.desc}
                      aria-pressed={active}
                      onClick={() => {
                        sound.playClick();
                        setCurrent({ ...current, avatarId: opt.id as AvatarType });
                      }}
                      className="press anim-pop relative flex flex-col items-center gap-1.5 rounded-2xl px-1.5 py-3 transition-all"
                      style={{
                        animationDelay: `${i * 45}ms`,
                        background: active ? rgba(current.color, 0.16) : 'rgba(255,255,255,.04)',
                        boxShadow: active
                          ? `inset 0 0 0 1px ${rgba(current.color, 0.75)}, 0 10px 26px -14px ${rgba(current.color, 0.9)}`
                          : 'inset 0 0 0 1px rgba(255,255,255,.07)',
                      }}
                    >
                      <AvatarGlyph
                        type={opt.id}
                        color={active ? current.color : '#94a3b8'}
                        size={38}
                      />
                      <span
                        className={`text-[11px] font-semibold leading-none ${active ? 'text-white' : 'text-slate-400'}`}
                      >
                        {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2.5">
              <span className="label ml-1 block">Colour</span>
              <ColorSwatches
                value={current.color}
                onChange={(hex) => setCurrent({ ...current, color: hex })}
                disabledHex={twoPlayers && step === 1 ? p1.color : undefined}
              />
            </div>
          </div>

          <GlassButton type="submit" variant="primary" block className="mt-6 !py-3.5" silent>
            {ctaLabel}
            <Icon name="back" size={18} className="rotate-180" />
          </GlassButton>
        </form>

        {mode === 'ai' && (
          <p className="mt-5 text-center text-[11px] text-slate-500">
            You play first. NOVA answers on the other side of the table.
          </p>
        )}
        </div>
      </div>
    </div>
  );
};

export default PlayerSetup;
