import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { netClient } from '../services/net';
import type { GameId, PlayerProfile, Session } from '../types';
import { AuroraBackground, BackButton, GlassButton, Icon, rgba } from './GlassUI';
import { sound } from '../services/sound';

/** Room-code alphabet — no 0/O/1/I/L, so codes are unambiguous out loud. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;

export const sanitizeCode = (raw: string): string =>
  raw
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, CODE_LENGTH);

interface OnlineLobbyProps {
  gameId: GameId;
  profile: PlayerProfile;
  intent: 'create' | 'join';
  /** Code captured from a `?join=` deep link — joined automatically. */
  presetCode?: string | null;
  onReady: (session: Session) => void;
  onBack: () => void;
}

const OnlineLobby: React.FC<OnlineLobbyProps> = ({
  gameId,
  profile,
  intent,
  presetCode,
  onReady,
  onBack,
}) => {
  const [session, setSession] = useState<Session | null>(null);
  const [code, setCode] = useState(() => sanitizeCode(presetCode ?? ''));
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const startedRef = useRef(false);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const joinUrl = session ? `${location.origin}/?join=${session.code}` : '';

  // --- live session events -------------------------------------------------
  useEffect(() => {
    const off = netClient.on((e) => {
      if (e.type === 'session') {
        setSession(e.session);
        if (e.session.status === 'active') {
          sound.playJoin();
          onReadyRef.current(e.session);
        }
      } else if (e.type === 'error') {
        setError(e.message);
      }
    });
    return off;
  }, []);

  // --- create --------------------------------------------------------------
  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await netClient.createSession(gameId, profile);
      setSession(s);
      if (s.status === 'active') onReadyRef.current(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a room.');
    } finally {
      setBusy(false);
    }
  }, [gameId, profile]);

  // --- join ----------------------------------------------------------------
  const join = useCallback(
    async (raw: string) => {
      const c = sanitizeCode(raw);
      if (c.length !== CODE_LENGTH) return;
      setBusy(true);
      setError(null);
      try {
        const s = await netClient.joinSession(c, profile);
        setSession(s);
        sound.playJoin();
        onReadyRef.current(s);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not join that room.');
      } finally {
        setBusy(false);
      }
    },
    [profile],
  );

  // Kick off exactly once.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (intent === 'create') void create();
    else if (presetCode && sanitizeCode(presetCode).length === CODE_LENGTH) void join(presetCode);
  }, [intent, presetCode, create, join]);

  // --- QR ------------------------------------------------------------------
  useEffect(() => {
    if (!joinUrl) return;
    let alive = true;
    QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 8,
      color: { dark: '#04040fff', light: '#e8fbffff' },
    })
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {
        if (alive) setQr(null);
      });
    return () => {
      alive = false;
    };
  }, [joinUrl]);

  const copy = async () => {
    if (!session) return;
    sound.playClick();
    try {
      await navigator.clipboard.writeText(session.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const leaveBack = () => {
    void netClient.leave();
    onBack();
  };

  // -------------------------------------------------------------------------

  return (
    <div className="relative h-full overflow-y-auto">
      <AuroraBackground />
      <div className="relative z-10 mx-auto flex min-h-full w-full max-w-md flex-col px-5 pb-10 pt-7 sm:px-8">
        <div className="mb-6 flex items-center justify-between">
          <BackButton onClick={leaveBack} />
          <span className="label">{intent === 'create' ? 'Host a room' : 'Join a room'}</span>
        </div>

        <div className="flex flex-1 flex-col justify-center">
        {/* ---------------------------------------------------------- create */}
        {intent === 'create' && (
          <div className="glass anim-spring rounded-[26px] p-6 text-center">
            {busy && !session && (
              <div className="py-10">
                <div className="shimmer mx-auto h-2 w-40 overflow-hidden rounded-full bg-white/10" />
                <p className="mt-4 text-sm text-slate-400">Opening a wormhole…</p>
              </div>
            )}

            {session && (
              <>
                <span className="label">Room code</span>
                <div className="mt-2 flex items-center justify-center gap-3">
                  <span className="mono text-glow font-display text-[2.6rem] font-bold leading-none tracking-[0.16em] text-white">
                    {session.code}
                  </span>
                  <button
                    onClick={() => void copy()}
                    aria-label="Copy room code"
                    className="press glass-pill grid h-10 w-10 place-items-center text-cyan-200"
                  >
                    <Icon name={copied ? 'check' : 'copy'} size={17} />
                  </button>
                </div>

                <div className="mx-auto mt-6 w-fit rounded-2xl bg-[#e8fbff] p-2.5 shadow-lg">
                  {qr ? (
                    <img src={qr} alt="Scan to join this room" className="h-40 w-40 rounded-lg" />
                  ) : (
                    <div className="grid h-40 w-40 place-items-center rounded-lg bg-slate-200 text-xs text-slate-500">
                      QR unavailable
                    </div>
                  )}
                </div>
                <p className="mt-3 text-[12px] text-slate-400">
                  Scan with the other phone, or share the code.
                </p>

                <div className="shimmer mt-6 flex items-center justify-center gap-2 overflow-hidden rounded-2xl bg-white/5 px-4 py-3">
                  <span className="relative z-10 h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
                  <span className="relative z-10 text-sm font-medium text-slate-200">
                    Waiting for opponent…
                  </span>
                </div>
              </>
            )}

            {error && !session && (
              <div className="py-6">
                <p className="text-sm text-rose-300">{error}</p>
                <GlassButton className="mt-4" onClick={() => void create()} disabled={busy}>
                  <Icon name="reset" size={16} />
                  Try again
                </GlassButton>
              </div>
            )}
          </div>
        )}

        {/* ------------------------------------------------------------ join */}
        {intent === 'join' && (
          <form
            className="glass anim-spring rounded-[26px] p-6"
            onSubmit={(e) => {
              e.preventDefault();
              void join(code);
            }}
          >
            <h1 className="font-display text-2xl font-bold tracking-tight">Enter room code</h1>
            <p className="mt-1 text-[13px] text-slate-400">
              Six characters from your friend's screen or QR code.
            </p>

            <input
              value={code}
              onChange={(e) => setCode(sanitizeCode(e.target.value))}
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              placeholder="ABC234"
              aria-label="Room code"
              className="mono mt-5 w-full rounded-2xl border border-white/10 bg-black/40 py-4 text-center text-3xl font-bold tracking-[0.34em] text-cyan-300 outline-none transition-all placeholder:text-white/12 focus:border-cyan-400/50"
            />

            <div className="mt-3 flex justify-center gap-1.5">
              {Array.from({ length: CODE_LENGTH }).map((_, i) => (
                <span
                  key={i}
                  className="h-1 w-6 rounded-full transition-colors"
                  style={{
                    background:
                      i < code.length ? rgba('#22d3ee', 0.9) : 'rgba(255,255,255,.12)',
                  }}
                />
              ))}
            </div>

            {error && <p className="mt-4 text-center text-sm text-rose-300">{error}</p>}

            <GlassButton
              type="submit"
              variant="primary"
              block
              silent
              className="mt-5 !py-3.5"
              disabled={code.length !== CODE_LENGTH || busy}
            >
              {busy ? 'Connecting…' : 'Join match'}
            </GlassButton>
          </form>
        )}

        <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-500">
          Rooms stay open while both players are connected. Moves and chat sync automatically.
        </p>
        </div>
      </div>
    </div>
  );
};

export default OnlineLobby;
