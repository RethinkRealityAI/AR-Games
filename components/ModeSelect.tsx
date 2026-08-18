import React from 'react';
import { GAMES } from '../games/registry';
import type { Difficulty, GameId, GameMode } from '../types';
import { AuroraBackground, BackButton, Icon, SegmentedControl, rgba } from './GlassUI';
import { sound } from '../services/sound';

interface ModeSelectProps {
  gameId: GameId;
  difficulty: Difficulty;
  onDifficultyChange: (d: Difficulty) => void;
  onPick: (mode: GameMode, intent?: 'create' | 'join') => void;
  onBack: () => void;
}

const DIFFICULTIES: { value: Difficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];

const OptionCard: React.FC<{
  tint: string;
  icon: React.ReactNode;
  title: string;
  blurb: string;
  delay: number;
  onClick?: () => void;
  children?: React.ReactNode;
}> = ({ tint, icon, title, blurb, delay, onClick, children }) => (
  <div
    className="glass anim-fade-up relative overflow-hidden rounded-[22px]"
    style={{ animationDelay: `${delay}ms` }}
  >
    <button
      onClick={() => {
        sound.playClick();
        onClick?.();
      }}
      disabled={!onClick}
      className="press group flex w-full items-center gap-4 px-5 py-5 text-left disabled:cursor-default"
    >
      <span
        className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl"
        style={{
          background: `linear-gradient(140deg, ${rgba(tint, 0.85)}, ${rgba(tint, 0.28)})`,
          color: '#04040f',
          boxShadow: `0 10px 26px -12px ${rgba(tint, 0.9)}`,
        }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-lg font-bold tracking-tight text-white">
          {title}
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-slate-400">{blurb}</span>
      </span>
      {onClick && (
        <Icon
          name="back"
          size={18}
          className="shrink-0 rotate-180 text-slate-500 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-white"
        />
      )}
    </button>
    {children && <div className="border-t border-white/5 px-5 pb-5 pt-4">{children}</div>}
  </div>
);

const ModeSelect: React.FC<ModeSelectProps> = ({
  gameId,
  difficulty,
  onDifficultyChange,
  onPick,
  onBack,
}) => {
  const meta = GAMES[gameId].meta;

  return (
    <div className="relative h-full overflow-y-auto">
      <AuroraBackground />
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-lg flex-col px-5 pb-10 pt-7 sm:px-8">
        <div className="mb-7 flex items-center justify-between">
          <BackButton onClick={onBack} label="Games" />
          <span className="label">Choose a mode</span>
        </div>

        <div className="flex flex-1 flex-col justify-center">
        <div className="anim-fade-up mb-7 text-center">
          <h1 className="text-glow font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {meta.name}
          </h1>
          <p className="mt-2 text-sm text-slate-400">{meta.tagline}</p>
        </div>

        <div className="flex flex-col gap-3.5">
          <OptionCard
            tint="#22d3ee"
            delay={60}
            icon={<Icon name="cpu" size={22} />}
            title="Solo vs AI"
            blurb="Face the on-device engine. Instant, offline, ruthless on hard."
            onClick={() => onPick('ai')}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="label shrink-0">Difficulty</span>
              <div className="w-full max-w-[16rem]">
                <SegmentedControl
                  size="sm"
                  options={DIFFICULTIES}
                  value={difficulty}
                  onChange={onDifficultyChange}
                />
              </div>
            </div>
          </OptionCard>

          <OptionCard
            tint="#8b5cf6"
            delay={140}
            icon={<Icon name="phone" size={22} />}
            title="Pass & Play"
            blurb="Two players, one phone. Hand it over between turns."
            onClick={() => onPick('local')}
          />

          <OptionCard
            tint="#e879f9"
            delay={220}
            icon={<Icon name="globe" size={22} />}
            title="Online Match"
            blurb="Create a room and share the code, or join a friend's."
          >
            <div className="grid grid-cols-2 gap-2.5">
              <button
                onClick={() => {
                  sound.playClick();
                  onPick('online', 'create');
                }}
                className="glass-btn glass-btn-primary !py-2.5 text-sm"
              >
                Create room
              </button>
              <button
                onClick={() => {
                  sound.playClick();
                  onPick('online', 'join');
                }}
                className="glass-btn !py-2.5 text-sm"
              >
                Join with code
              </button>
            </div>
          </OptionCard>
        </div>

        <p className="mt-8 text-center text-[11px] leading-relaxed text-slate-500">
          Works on any device. WebXR headsets and AR phones get the full augmented board;
          everyone else plays on the holo-table.
        </p>
        </div>
      </div>
    </div>
  );
};

export default ModeSelect;
