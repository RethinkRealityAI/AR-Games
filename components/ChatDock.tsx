// ============================================================================
// COMMS — a floating liquid-glass orb (bottom-right, safe-area aware) that
// springs open into a glass chat sheet.
//
// Layout contract: the orb lives in the bottom-right gutter so it never sits
// under the HUD (top) or the centred "Enter AR" button (bottom-centre). The
// open sheet is capped at 45vh on portrait phones so the board stays readable,
// and becomes a side panel from `sm:` up — where it floats *above* the orb, so
// the orb keeps working as a toggle.
// ============================================================================

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { netClient } from '../services/net';
import type { ChatMessage, PlayerProfile, PlayerSlot } from '../types';
import { Icon, rgba } from './GlassUI';
import { sound } from '../services/sound';

const MAX_LEN = 280;
const PULSE_MS = 900;

interface ChatDockProps {
  mySlot: PlayerSlot | null;
  profiles: [PlayerProfile, PlayerProfile];
}

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Height of the on-screen keyboard, in px, from the visual viewport. Lets the
 * orb and the sheet ride above the keyboard instead of hiding behind it.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const read = () => {
      // Layout viewport minus the visible slice below the scroll offset.
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      setInset(hidden > 90 ? Math.round(hidden) : 0);
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, []);

  return inset;
}

const ChatDock: React.FC<ChatDockProps> = ({ mySlot, profiles }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [chatMuted, setChatMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openRef = useRef(open);
  const mutedRef = useRef(chatMuted);
  /** Every message id already in `messages`, so batches can be merged safely. */
  const seenIds = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const kbInset = useKeyboardInset();

  useEffect(() => {
    mutedRef.current = chatMuted;
  }, [chatMuted]);

  useEffect(() => {
    openRef.current = open;
    if (open) setUnread(0);
  }, [open]);

  // Focus the composer once the spring-in has cleared its first frames.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 220);
    return () => window.clearTimeout(t);
  }, [open]);

  // --- subscribe -----------------------------------------------------------
  useEffect(() => {
    /**
     * Merge a batch by message id. Batches arrive in two flavours: a `chat`
     * event carries only the messages net.ts has not emitted before, while a
     * `session` event carries the server's whole tail. Keying on ids means
     * either shape is safe — a length diff would wipe history on the first
     * kind and double-count on the second.
     *
     * Diffing lives outside the state updater so it never runs twice.
     */
    const ingest = (batch: readonly ChatMessage[]) => {
      const additions = batch.filter((m) => m && !seenIds.current.has(m.id));
      if (additions.length === 0) return;
      for (const m of additions) seenIds.current.add(m.id);

      setMessages((prev) => [...prev, ...additions].sort((a, b) => a.at - b.at));

      const fromThem = additions.filter((m) => m.slot !== mySlot);
      if (fromThem.length === 0) return;
      if (!mutedRef.current) sound.playChat();
      if (!openRef.current) {
        setUnread((n) => n + fromThem.length);
        // One soft pulse of the orb per arriving burst.
        setPulse((n) => n + 1);
      }
    };

    const existing = netClient.session?.chat;
    if (existing && existing.length) {
      seenIds.current = new Set(existing.map((m) => m.id));
      setMessages([...existing].sort((a, b) => a.at - b.at));
    }

    return netClient.on((e) => {
      if (e.type === 'chat') ingest(e.messages);
      else if (e.type === 'session') ingest(e.session.chat ?? []);
    });
  }, [mySlot]);

  // Retire the pulse class so it can re-trigger on the next message.
  useEffect(() => {
    if (pulse === 0) return;
    const t = window.setTimeout(() => setPulse(0), PULSE_MS);
    return () => window.clearTimeout(t);
  }, [pulse]);

  // --- autoscroll ----------------------------------------------------------
  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const send = async () => {
    const text = draft.trim().slice(0, MAX_LEN);
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await netClient.sendChat(text);
      setDraft('');
      if (!chatMuted) sound.playChat();
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Message not sent.');
    } finally {
      setSending(false);
    }
  };

  const toggle = useCallback(() => {
    sound.playClick();
    setOpen((v) => !v);
  }, []);

  const opponentName = mySlot === null ? 'your opponent' : profiles[mySlot === 0 ? 1 : 0].name;
  const accent = profiles[mySlot ?? 0]?.color ?? '#22d3ee';

  // Accent-driven glass tokens shared by the orb and the sheet.
  const orbVars = {
    ['--orb-rim' as string]: rgba(accent, 0.55),
    ['--orb-glow' as string]: rgba(accent, 0.5),
    ['--orb-glow-far' as string]: rgba(accent, 0.28),
    ['--orb-tint' as string]: rgba(accent, 0.22),
  } as React.CSSProperties;

  // With the soft keyboard up, ride above it (and shrink so the composer,
  // the messages and the board all stay on screen).
  const orbLift: React.CSSProperties = kbInset ? { bottom: kbInset + 12 } : {};
  const sheetLift: React.CSSProperties = kbInset
    ? { bottom: kbInset + 12, maxHeight: `calc(100vh - ${kbInset + 96}px)` }
    : {};

  return (
    <>
      {/* --------------------------------------------------------------- orb */}
      <button
        type="button"
        onClick={toggle}
        aria-label={open ? 'Close chat' : unread > 0 ? `Open chat, ${unread} unread` : 'Open chat'}
        aria-expanded={open}
        title={open ? 'Close chat' : 'Open chat'}
        className={`chat-orb ${pulse ? 'chat-orb--ping' : ''} ${open ? 'chat-orb--open' : ''}`}
        style={{ ...orbVars, ...orbLift }}
      >
        <span className="chat-orb__halo" aria-hidden />
        <span className="chat-orb__ball" aria-hidden />
        <span className="chat-orb__ping" aria-hidden />
        <span className="chat-orb__glyph">
          <Icon name={open ? 'chevron' : 'chat'} size={23} />
        </span>
        {unread > 0 && !open && (
          <span className="chat-orb__badge" aria-hidden>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* ------------------------------------------------------------- sheet */}
      {open && (
        <div
          className="chat-sheet glass-strong"
          style={{ ...orbVars, ...sheetLift }}
          role="dialog"
          aria-label="Match chat"
        >
          <header className="relative z-10 flex items-center gap-2 border-b border-white/8 px-4 py-3">
            <span
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full"
              style={{
                background: `radial-gradient(circle at 32% 26%, ${rgba(accent, 0.75)}, ${rgba(accent, 0.18)})`,
                boxShadow: `inset 0 1px 0 rgba(255,255,255,.35), 0 0 14px -2px ${rgba(accent, 0.7)}`,
              }}
            >
              <Icon name="chat" size={14} className="text-slate-950" />
            </span>
            <span className="flex-1 font-display text-sm font-bold tracking-tight">Comms</span>
            <button
              type="button"
              onClick={() => {
                sound.playClick();
                setChatMuted((v) => !v);
              }}
              aria-label={chatMuted ? 'Unmute chat alerts' : 'Mute chat alerts'}
              aria-pressed={chatMuted}
              title={chatMuted ? 'Unmute chat alerts' : 'Mute chat alerts'}
              className={`press rounded-full p-1.5 transition-colors ${
                chatMuted ? 'text-rose-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Icon name="mute" size={16} />
            </button>
            <button
              type="button"
              onClick={() => {
                sound.playClick();
                setOpen(false);
              }}
              aria-label="Collapse chat"
              title="Collapse chat"
              className="press rounded-full p-1.5 text-slate-400 hover:text-white"
            >
              <Icon name="chevron" size={16} />
            </button>
          </header>

          <div
            ref={listRef}
            className="relative z-10 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3.5 py-3"
          >
            {messages.length === 0 && (
              <p className="mt-8 text-center text-[13px] text-slate-500">
                Say hi to {opponentName} 👋
              </p>
            )}
            {messages.map((m) => {
              const mine = m.slot === mySlot;
              const color = profiles[m.slot]?.color ?? '#94a3b8';
              return (
                <div key={m.id} className={`anim-pop flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className="max-w-[82%] rounded-2xl px-3 py-2"
                    style={{
                      background: mine ? rgba(color, 0.2) : 'rgba(255,255,255,.06)',
                      boxShadow: mine
                        ? `inset 0 0 0 1px ${rgba(color, 0.35)}`
                        : 'inset 0 0 0 1px rgba(255,255,255,.07)',
                      borderBottomRightRadius: mine ? 6 : undefined,
                      borderBottomLeftRadius: mine ? undefined : 6,
                    }}
                  >
                    <div className="mb-0.5 flex items-baseline gap-2">
                      <span className="text-[11px] font-bold" style={{ color }}>
                        {m.name}
                      </span>
                      <span className="mono text-[10px] text-slate-500">{timeOf(m.at)}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-snug text-slate-100">
                      {m.text}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {error && (
            <p className="relative z-10 px-4 pb-1 text-center text-[11px] text-rose-300">{error}</p>
          )}

          <form
            className="chat-sheet__composer relative z-10 flex items-end gap-2 border-t border-white/8 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              ref={inputRef}
              value={draft}
              maxLength={MAX_LEN}
              enterKeyHint="send"
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message…"
              aria-label="Chat message"
              className="min-w-0 flex-1 rounded-full border border-white/10 bg-black/35 px-4 py-2.5 text-[13px] outline-none transition-colors placeholder:text-white/25 focus:border-cyan-400/50 focus:bg-black/50"
            />
            <button
              type="submit"
              disabled={!draft.trim() || sending}
              aria-label="Send message"
              className="glass-btn glass-btn-primary press !h-10 !w-10 shrink-0 !rounded-full !p-0"
            >
              <Icon name="send" size={17} />
            </button>
          </form>
        </div>
      )}
    </>
  );
};

export default ChatDock;
