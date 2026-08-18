// ============================================================================
// Shared liquid-glass primitives used across every view.
// ============================================================================

import React from 'react';
import type { AvatarType } from '../types';
import { sound } from '../services/sound';

/* --------------------------------------------------------------------------
   Palette
   -------------------------------------------------------------------------- */

export const PLAYER_COLORS: { hex: string; name: string }[] = [
  { hex: '#22d3ee', name: 'Ion Cyan' },
  { hex: '#8b5cf6', name: 'Warp Violet' },
  { hex: '#f472b6', name: 'Nova Pink' },
  { hex: '#34d399', name: 'Nebula Mint' },
  { hex: '#fbbf24', name: 'Solar Flare' },
  { hex: '#fb7185', name: 'Mars Coral' },
];

export const DEFAULT_COLOR_P1 = PLAYER_COLORS[0].hex;
export const DEFAULT_COLOR_P2 = PLAYER_COLORS[4].hex;

export const AVATAR_OPTIONS: { id: AvatarType; label: string; desc: string }[] = [
  { id: 'ASTRONAUT', label: 'Explorer', desc: 'Suited voyager' },
  { id: 'DRONE', label: 'Sentinel', desc: 'Hovering droid' },
  { id: 'CRYSTAL', label: 'Shard', desc: 'Psionic crystal' },
];

/** `#22d3ee` -> `rgba(34,211,238,a)` */
export function rgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/* --------------------------------------------------------------------------
   Background
   -------------------------------------------------------------------------- */

/** Cheap animated aurora + starfield. Sits behind every non-game view. */
export const AuroraBackground: React.FC<{ dim?: boolean }> = ({ dim = false }) => (
  <div className="aurora" aria-hidden style={dim ? { opacity: 0.55 } : undefined}>
    <div className="aurora-blob b1" />
    <div className="aurora-blob b2" />
    <div className="aurora-blob b3" />
    <div className="starfield">
      <i />
      <i />
      <i />
    </div>
  </div>
);

/* --------------------------------------------------------------------------
   Surfaces
   -------------------------------------------------------------------------- */

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export const GlassPanel: React.FC<DivProps & { strong?: boolean; pill?: boolean }> = ({
  strong,
  pill,
  className = '',
  children,
  ...rest
}) => (
  <div
    className={`${pill ? 'glass-pill' : strong ? 'glass-strong' : 'glass'} ${className}`}
    {...rest}
  >
    {children}
  </div>
);

/* --------------------------------------------------------------------------
   Buttons
   -------------------------------------------------------------------------- */

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'glass' | 'danger';
  block?: boolean;
  silent?: boolean;
};

export const GlassButton: React.FC<BtnProps> = ({
  variant = 'glass',
  block,
  silent,
  className = '',
  onClick,
  children,
  ...rest
}) => (
  <button
    className={`glass-btn ${
      variant === 'primary' ? 'glass-btn-primary' : variant === 'danger' ? 'glass-btn-danger' : ''
    } ${block ? 'w-full' : ''} ${className}`}
    onClick={(e) => {
      if (!silent) sound.playClick();
      onClick?.(e);
    }}
    {...rest}
  >
    {children}
  </button>
);

export const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'neutral' | 'danger' }
> = ({ label, tone = 'neutral', className = '', onClick, children, ...rest }) => (
  <button
    aria-label={label}
    title={label}
    className={`glass-btn ${tone === 'danger' ? 'glass-btn-danger' : ''} !rounded-full !p-0 h-11 w-11 shrink-0 ${className}`}
    onClick={(e) => {
      sound.playClick();
      onClick?.(e);
    }}
    {...rest}
  >
    {children}
  </button>
);

/* --------------------------------------------------------------------------
   Segmented control
   -------------------------------------------------------------------------- */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="tablist"
      className="flex gap-1 rounded-full p-1"
      style={{
        background: 'rgba(2,6,23,.5)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.07)',
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={(e) => {
              e.stopPropagation();
              sound.playClick();
              onChange(o.value);
            }}
            className={`press flex-1 rounded-full font-semibold transition-colors ${
              size === 'sm' ? 'px-3 py-1.5 text-[11px]' : 'px-4 py-2 text-xs'
            } ${active ? 'text-slate-950' : 'text-slate-300 hover:text-white'}`}
            style={
              active
                ? {
                    background: 'linear-gradient(135deg,#67e8f9,#a78bfa)',
                    boxShadow: '0 6px 18px -8px rgba(34,211,238,.7)',
                  }
                : undefined
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Avatar previews (pure SVG, tinted by the player's colour)
   -------------------------------------------------------------------------- */

export const AvatarGlyph: React.FC<{ type: AvatarType; color: string; size?: number }> = ({
  type,
  color,
  size = 44,
}) => {
  const common = { width: size, height: size, viewBox: '0 0 48 48' } as const;
  if (type === 'DRONE') {
    return (
      <svg {...common} aria-hidden>
        <ellipse cx="24" cy="41" rx="11" ry="2.6" fill={rgba(color, 0.22)} />
        <circle cx="24" cy="22" r="13.5" fill="none" stroke={color} strokeWidth="1.6" opacity=".85" />
        <circle cx="24" cy="22" r="8.4" fill="#1e293b" stroke="#64748b" strokeWidth="1" />
        <circle cx="24" cy="22" r="3.6" fill={color} />
        <circle cx="24" cy="22" r="6.2" fill="none" stroke={rgba(color, 0.5)} strokeWidth="1" />
        <circle cx="24" cy="8.5" r="1.7" fill={color} opacity=".9" />
        <circle cx="37.5" cy="22" r="1.7" fill={color} opacity=".55" />
        <circle cx="10.5" cy="22" r="1.7" fill={color} opacity=".55" />
      </svg>
    );
  }
  if (type === 'CRYSTAL') {
    return (
      <svg {...common} aria-hidden>
        <ellipse cx="24" cy="42" rx="10" ry="2.4" fill={rgba(color, 0.22)} />
        <path d="M24 5 L37 22 L24 41 L11 22 Z" fill={rgba(color, 0.45)} stroke={color} strokeWidth="1.5" />
        <path d="M24 5 L24 41" stroke={rgba(color, 0.85)} strokeWidth="1" />
        <path d="M11 22 L37 22" stroke={rgba(color, 0.6)} strokeWidth="1" />
        <path d="M24 5 L31 22 L24 41 Z" fill="rgba(255,255,255,.16)" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden>
      <ellipse cx="24" cy="43" rx="11" ry="2.4" fill={rgba(color, 0.22)} />
      <rect x="15" y="21" width="18" height="17" rx="6" fill="#e2e8f0" />
      <rect x="15" y="21" width="18" height="17" rx="6" fill="none" stroke={rgba(color, 0.65)} strokeWidth="1.4" />
      <rect x="20.5" y="26" width="7" height="7" rx="2" fill={color} opacity=".9" />
      <circle cx="24" cy="14.5" r="10" fill="#f1f5f9" />
      <circle cx="24" cy="14.5" r="10" fill="none" stroke={rgba(color, 0.7)} strokeWidth="1.5" />
      <path d="M16.5 13.5a7.5 7.5 0 0 1 15 0 7.5 7.5 0 0 1-15 0Z" fill="#0f172a" />
      <path d="M18.6 12.2a5.6 5.6 0 0 1 5.4-3.4" stroke={rgba(color, 0.9)} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <rect x="10.5" y="24" width="4" height="10" rx="2" fill={color} opacity=".8" />
      <rect x="33.5" y="24" width="4" height="10" rx="2" fill={color} opacity=".8" />
    </svg>
  );
};

/** Small round avatar chip used in the HUD and chat. */
export const AvatarDot: React.FC<{
  type: AvatarType;
  color: string;
  size?: number;
  glow?: boolean;
}> = ({ type, color, size = 26, glow }) => (
  <span
    className="inline-flex items-center justify-center rounded-full shrink-0"
    style={{
      width: size,
      height: size,
      background: `radial-gradient(circle at 32% 28%, ${rgba(color, 0.95)}, ${rgba(color, 0.35)})`,
      boxShadow: glow
        ? `0 0 0 2px ${rgba(color, 0.55)}, 0 0 14px ${rgba(color, 0.75)}`
        : `inset 0 1px 0 rgba(255,255,255,.35)`,
    }}
  >
    <AvatarGlyph type={type} color="#0b1120" size={size * 0.72} />
  </span>
);

/* --------------------------------------------------------------------------
   Icons
   -------------------------------------------------------------------------- */

export type IconName =
  | 'back'
  | 'close'
  | 'reset'
  | 'move'
  | 'chat'
  | 'send'
  | 'copy'
  | 'check'
  | 'ar'
  | 'cpu'
  | 'phone'
  | 'globe'
  | 'trophy'
  | 'chevron'
  | 'mute'
  | 'sparkle';

const PATHS: Record<IconName, React.ReactNode> = {
  back: <path d="M15 19l-7-7 7-7" />,
  close: <path d="M6 18L18 6M6 6l12 12" />,
  reset: (
    <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  ),
  move: (
    <path d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
  ),
  chat: (
    <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.9 9.9 0 01-4-.8l-4 1.6 1.2-3.6A7.6 7.6 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  ),
  send: <path d="M4 12l16-8-6 8 6 8-16-8z" />,
  copy: (
    <path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2v-2m-8-2h8a2 2 0 002-2V5a2 2 0 00-2-2H10a2 2 0 00-2 2v8a2 2 0 002 2z" />
  ),
  check: <path d="M5 13l4 4L19 7" />,
  ar: (
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v18m8-13.5L12 12 4 7.5" />
  ),
  cpu: (
    <path d="M9 3v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2M6 6h12v12H6z M10 10h4v4h-4z" />
  ),
  phone: <path d="M7 2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2V4a2 2 0 012-2zm3 18h4" />,
  globe: (
    <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-18 0h18M12 3c2.5 2.6 2.5 15.4 0 18-2.5-2.6-2.5-15.4 0-18z" />
  ),
  trophy: (
    <path d="M8 21h8m-4-4v4m-6-16h12v3a6 6 0 01-12 0V5zM6 6H3v2a4 4 0 004 4m11-6h3v2a4 4 0 01-4 4" />
  ),
  chevron: <path d="M19 9l-7 7-7-7" />,
  mute: <path d="M11 5L6 9H3v6h3l5 4V5zM17 9l4 6m0-6l-4 6" />,
  sparkle: <path d="M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12 4.5 10 10 8.5 12 3z" />,
};

export const Icon: React.FC<{ name: IconName; size?: number; className?: string }> = ({
  name,
  size = 20,
  className = '',
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    {PATHS[name]}
  </svg>
);

/* --------------------------------------------------------------------------
   Misc bits
   -------------------------------------------------------------------------- */

export const BackButton: React.FC<{ onClick: () => void; label?: string }> = ({
  onClick,
  label = 'Back',
}) => (
  <button
    onClick={() => {
      sound.playClick();
      onClick();
    }}
    className="press inline-flex items-center gap-1.5 text-sm font-medium text-slate-400 transition-colors hover:text-white"
  >
    <Icon name="back" size={17} />
    {label}
  </button>
);

export const ColorSwatches: React.FC<{
  value: string;
  onChange: (hex: string) => void;
  disabledHex?: string;
}> = ({ value, onChange, disabledHex }) => (
  <div
    className="flex items-center justify-between gap-1.5 rounded-2xl p-2"
    style={{ background: 'rgba(2,6,23,.45)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.06)' }}
  >
    {PLAYER_COLORS.map((c) => {
      const active = c.hex === value;
      const taken = c.hex === disabledHex && !active;
      return (
        <button
          key={c.hex}
          type="button"
          title={taken ? `${c.name} (taken)` : c.name}
          aria-label={c.name}
          disabled={taken}
          onClick={() => {
            sound.playClick();
            onChange(c.hex);
          }}
          className="press relative h-9 w-9 rounded-full transition-all disabled:opacity-25"
          style={{
            background: `radial-gradient(circle at 34% 28%, ${rgba(c.hex, 1)}, ${rgba(c.hex, 0.55)})`,
            transform: active ? 'scale(1.12)' : undefined,
            boxShadow: active
              ? `0 0 0 2px #fff, 0 0 18px ${rgba(c.hex, 0.85)}`
              : `inset 0 1px 0 rgba(255,255,255,.3)`,
          }}
        />
      );
    })}
  </div>
);

export const ThinkingDots: React.FC<{ color?: string }> = ({ color = '#a5f3fc' }) => (
  <span className="inline-flex items-end gap-[3px]">
    <span className="dot-1 h-1 w-1 rounded-full" style={{ background: color }} />
    <span className="dot-2 h-1 w-1 rounded-full" style={{ background: color }} />
    <span className="dot-3 h-1 w-1 rounded-full" style={{ background: color }} />
  </span>
);
