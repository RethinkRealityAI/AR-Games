import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { netClient } from '../services/net';
import type { ChatMessage, PlayerProfile, PlayerSlot } from '../types';
import { Icon, rgba } from './GlassUI';
import { sound } from '../services/sound';

const MAX_LEN = 280;

interface ChatDockProps {
  mySlot: PlayerSlot | null;
  profiles: [PlayerProfile, PlayerProfile];
  /** When true the dock is fully off — not even the bubble shows. */
  hidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}

const timeOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const ChatDock: React.FC<ChatDockProps> = ({ mySlot, profiles, hidden, onHiddenChange }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openRef = useRef(open);
  const seenRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef<number | null>(null);

  useEffect(() => {
    openRef.current = open;
    if (open) {
      seenRef.current = messages.length;
      setUnread(0);
    }
  }, [open, messages.length]);

  // --- subscribe -----------------------------------------------------------
  useEffect(() => {
    const ingest = (next: ChatMessage[]) => {
      setMessages((prev) => {
        if (next.length === prev.length) return prev;
        const incoming = next.slice(prev.length);
        const fromOther = incoming.some((m) => m.slot !== mySlot);
        if (fromOther) sound.playChat();
        if (!openRef.current) {
          setUnread(next.length - seenRef.current);
        } else {
          seenRef.current = next.length;
        }
        return next;
      });
    };

    const off = netClient.on((e) => {
      if (e.type === 'chat') ingest(e.messages);
      else if (e.type === 'session') ingest(e.session.chat ?? []);
    });

    const existing = netClient.session?.chat;
    if (existing && existing.length) {
      setMessages(existing);
      seenRef.current = existing.length;
    }
    return off;
  }, [mySlot]);

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
      sound.playChat();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Message not sent.');
    } finally {
      setSending(false);
    }
  };

  const opponentName = mySlot === null ? 'your opponent' : profiles[mySlot === 0 ? 1 : 0].name;

  // Long-press the bubble to switch chat off entirely.
  const startHold = () => {
    holdRef.current = window.setTimeout(() => {
      holdRef.current = null;
      sound.playClick();
      onHiddenChange(true);
    }, 650);
  };
  const cancelHold = () => {
    if (holdRef.current !== null) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };

  if (hidden) return null;

  // ---------------------------------------------------------------- bubble
  if (!open) {
    return (
      <button
        onClick={() => {
          cancelHold();
          sound.playClick();
          setOpen(true);
        }}
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        aria-label="Open chat"
        title="Open chat (hold to hide)"
        className="glass-btn press anim-pop fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-4 z-50 !h-14 !w-14 !rounded-full !p-0"
      >
        <Icon name="chat" size={22} />
        {unread > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[11px] font-bold text-slate-950"
            style={{ background: 'linear-gradient(135deg,#67e8f9,#a78bfa)' }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    );
  }

  // ---------------------------------------------------------------- panel
  return (
    <div
      className="glass-strong anim-spring fixed z-50 flex flex-col overflow-hidden
                 inset-x-0 bottom-0 h-[45vh] rounded-t-[26px]
                 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:h-[26rem] sm:w-80 sm:rounded-[22px]"
      role="dialog"
      aria-label="Match chat"
    >
      <header className="relative z-10 flex items-center gap-2 border-b border-white/8 px-4 py-3">
        <Icon name="chat" size={17} className="text-cyan-300" />
        <span className="flex-1 font-display text-sm font-bold tracking-tight">Comms</span>
        <button
          onClick={() => {
            sound.playClick();
            onHiddenChange(true);
            setOpen(false);
          }}
          aria-label="Turn chat off"
          title="Turn chat off"
          className="press rounded-full p-1.5 text-slate-400 hover:text-white"
        >
          <Icon name="mute" size={16} />
        </button>
        <button
          onClick={() => {
            sound.playClick();
            setOpen(false);
          }}
          aria-label="Collapse chat"
          className="press rounded-full p-1.5 text-slate-400 hover:text-white"
        >
          <Icon name="chevron" size={16} />
        </button>
      </header>

      <div ref={listRef} className="relative z-10 flex-1 space-y-2.5 overflow-y-auto px-3.5 py-3">
        {messages.length === 0 && (
          <p className="mt-10 text-center text-[13px] text-slate-500">
            Say hi to {opponentName} 👋
          </p>
        )}
        {messages.map((m) => {
          const mine = m.slot === mySlot;
          const color = profiles[m.slot]?.color ?? '#94a3b8';
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
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
        className="relative z-10 flex items-end gap-2 border-t border-white/8 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={draft}
          maxLength={MAX_LEN}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message…"
          aria-label="Chat message"
          className="min-w-0 flex-1 rounded-full border border-white/10 bg-black/35 px-4 py-2.5 text-[13px] outline-none placeholder:text-white/25 focus:border-cyan-400/50"
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
  );
};

export default ChatDock;
