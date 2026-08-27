// ============================================================================
// Quantum Pairs — match settings (board size, artifact theme, turn timer).
//
// Every control emits a `{ config }` move, which the engine only accepts before
// play starts. That is why this panel lives inside the game screen rather than
// in the pre-game flow in App.tsx: config is a move on the shared core, so in
// an online room the host's edits reach the guest through the ordinary session
// stream — the guest simply renders the same panel read-only.
// ============================================================================

import React from 'react';
import {
  SIZES,
  SIZE_IDS,
  THEME_IDS,
  TURN_SECOND_CHOICES,
  type MemoryBoard,
  type MemorySize,
  type MemoryTheme,
} from '../games/memory/logic';
import { THEME_META } from '../games/memory/artifacts';
import { sound } from '../services/sound';
import { rgba } from './GlassUI';

const ACCENT = '#34d399';

/** Miniature of a board's grid — the shape you are actually choosing. */
const GridShape: React.FC<{ cols: number; rows: number; active: boolean }> = ({
  cols,
  rows,
  active,
}) => (
  <span
    className="grid gap-[2px]"
    style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, width: cols * 7 + (cols - 1) * 2 }}
    aria-hidden
  >
    {Array.from({ length: cols * rows }, (_, i) => (
      <span
        key={i}
        className="h-[7px] w-[7px] rounded-[2px] transition-colors"
        style={{
          background: active ? rgba(ACCENT, 0.9) : 'rgba(255,255,255,.22)',
          boxShadow: active ? `0 0 6px ${rgba(ACCENT, 0.55)}` : undefined,
        }}
      />
    ))}
  </span>
);

const OptionButton: React.FC<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
  label?: string;
}> = ({ active, disabled, onClick, className = '', children, label }) => (
  <button
    type="button"
    aria-pressed={active}
    aria-label={label}
    disabled={disabled}
    onClick={() => {
      sound.playClick();
      onClick();
    }}
    className={`press relative flex flex-col items-center rounded-2xl transition-all disabled:cursor-default ${className}`}
    style={{
      background: active ? rgba(ACCENT, 0.16) : 'rgba(255,255,255,.04)',
      boxShadow: active
        ? `inset 0 0 0 1px ${rgba(ACCENT, 0.75)}, 0 10px 26px -14px ${rgba(ACCENT, 0.9)}`
        : 'inset 0 0 0 1px rgba(255,255,255,.07)',
      opacity: disabled && !active ? 0.55 : 1,
    }}
  >
    {children}
  </button>
);

export interface QuantumSettingsProps {
  board: MemoryBoard;
  /** False for the guest in an online room — controls render read-only. */
  editable: boolean;
  /** Why the controls are locked, shown under the heading. */
  lockNote?: string | null;
  onChange: (cfg: { size?: MemorySize; theme?: MemoryTheme; turnSeconds?: number }) => void;
}

const QuantumSettings: React.FC<QuantumSettingsProps> = ({
  board,
  editable,
  lockNote,
  onChange,
}) => (
  <div className="space-y-4" data-testid="quantum-settings">
    <div className="space-y-2">
      <span className="label ml-0.5 block">Board</span>
      <div className="grid grid-cols-3 gap-2">
        {SIZE_IDS.map((id) => {
          const spec = SIZES[id];
          const active = board.size === id;
          return (
            <OptionButton
              key={id}
              active={active}
              disabled={!editable}
              onClick={() => onChange({ size: id })}
              className="gap-1.5 px-1.5 py-3"
              label={`${spec.label}, ${spec.cols} by ${spec.rows}, ${spec.pairs} pairs`}
            >
              <span
                className={`text-[13px] font-bold leading-none ${active ? 'text-white' : 'text-slate-300'}`}
              >
                {spec.label}
              </span>
              <span className="my-1 grid h-[26px] place-items-center">
                <GridShape cols={spec.cols} rows={spec.rows} active={active} />
              </span>
              <span className="mono text-[10px] leading-none text-slate-400">
                {spec.cols}×{spec.rows}
              </span>
              <span
                className="mt-1 text-[10px] font-semibold leading-none"
                style={{ color: active ? ACCENT : '#94a3b8' }}
              >
                {spec.pairs} pairs
              </span>
            </OptionButton>
          );
        })}
      </div>
    </div>

    <div className="space-y-2">
      <span className="label ml-0.5 block">Artifacts</span>
      <div className="grid grid-cols-3 gap-2">
        {THEME_IDS.map((id) => {
          const meta = THEME_META[id];
          const active = board.theme === id;
          return (
            <OptionButton
              key={id}
              active={active}
              disabled={!editable}
              onClick={() => onChange({ theme: id })}
              className="gap-1 px-2 py-2.5 text-center"
              label={`${meta.name} — ${meta.blurb}`}
            >
              <span
                className={`text-[13px] font-bold leading-none ${active ? 'text-white' : 'text-slate-300'}`}
              >
                {meta.name}
              </span>
              <span className="text-[10px] leading-tight text-slate-400">{meta.blurb}</span>
            </OptionButton>
          );
        })}
      </div>
    </div>

    <div className="space-y-2">
      <span className="label ml-0.5 block">Turn timer</span>
      <div className="grid grid-cols-5 gap-1.5">
        {TURN_SECOND_CHOICES.map((s) => {
          const active = board.turnSeconds === s;
          return (
            <OptionButton
              key={s}
              active={active}
              disabled={!editable}
              onClick={() => onChange({ turnSeconds: s })}
              className="justify-center px-1 py-2.5"
              label={s === 0 ? 'No turn timer' : `${s} second turns`}
            >
              <span
                className={`mono text-[12px] font-bold leading-none ${active ? 'text-white' : 'text-slate-300'}`}
              >
                {s === 0 ? 'Off' : `${s}s`}
              </span>
            </OptionButton>
          );
        })}
      </div>
      <p className="ml-0.5 text-[11px] leading-snug text-slate-500">
        {board.turnSeconds === 0
          ? 'Untimed — take as long as you need to remember.'
          : `Run the clock down and your turn is forfeit to the other player.`}
      </p>
    </div>

    {!editable && lockNote && (
      <p className="ml-0.5 text-[11px] font-medium text-cyan-200/80">{lockNote}</p>
    )}
  </div>
);

export default QuantumSettings;
