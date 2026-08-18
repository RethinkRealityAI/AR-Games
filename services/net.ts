// ============================================================================
// services/net.ts — online session client.
//
// Implements the `NetClient` contract from types.ts against the Netlify
// Function at /api/* (see docs/ARCHITECTURE.md). The UI depends only on
// `NetClient`; everything below — polling cadence, backoff, chat diffing — is
// an implementation detail.
// ============================================================================

import type {
  ChatMessage,
  GameId,
  Move,
  NetClient,
  NetEvent,
  PlayerProfile,
  PlayerSlot,
  Session,
} from '../types';

/** Poll interval while the tab is focused. */
const POLL_VISIBLE_MS = 1_500;
/** Poll interval while the tab is backgrounded. */
const POLL_HIDDEN_MS = 2_500;
/** After this long hidden, polling stops entirely until the tab is visible again. */
const HIDDEN_PAUSE_AFTER_MS = 60_000;
/** Consecutive poll failures before we tell the UI we are offline. */
const OFFLINE_AFTER_FAILURES = 2;
/** Ceiling for the exponential retry backoff. */
const MAX_BACKOFF_MS = 5_000;

const API = '/api';

type PollDelay = number;

interface ApiError extends Error {
  status?: number;
  session?: Session;
}

function apiError(message: string, status?: number, session?: Session): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  err.session = session;
  return err;
}

const isHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

class NetClientImpl implements NetClient {
  // --- mirrored state ----------------------------------------------------
  private _session: Session | null = null;
  private _slot: PlayerSlot | null = null;
  private token: string | null = null;
  private code: string | null = null;

  // --- polling ------------------------------------------------------------
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Incremented every time polling is (re)started or stopped. A scheduled
   * callback that sees a stale epoch exits without doing anything, so an
   * old timer can never resurrect a session we have left.
   */
  private epoch = 0;
  private polling = false;
  private paused = false;
  private hiddenSince: number | null = isHidden() ? Date.now() : null;

  // --- connection health --------------------------------------------------
  private failures = 0;
  private online = true;

  // --- chat dedupe --------------------------------------------------------
  private seenChatIds = new Set<string>();

  // --- subscribers --------------------------------------------------------
  private handlers = new Set<(e: NetEvent) => void>();

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  // =======================================================================
  // NetClient surface
  // =======================================================================

  get session(): Session | null {
    return this._session;
  }

  get slot(): PlayerSlot | null {
    return this._slot;
  }

  on(handler: (e: NetEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async createSession(gameId: GameId, profile: PlayerProfile): Promise<Session> {
    const res = await this.request<{ code: string; token: string; session: Session }>(
      'POST',
      `${API}/session`,
      { gameId, profile },
    );

    this.code = res.code;
    this.token = res.token;
    this._slot = 0;
    this.resetForNewSession();
    this.adopt(res.session, 'session-first');
    this.startPolling();
    return res.session;
  }

  async joinSession(code: string, profile: PlayerProfile): Promise<Session> {
    const normalized = code.trim().toUpperCase();
    const res = await this.request<{ token: string; session: Session }>(
      'POST',
      `${API}/session/${encodeURIComponent(normalized)}/join`,
      { profile },
    );

    this.code = res.session.code ?? normalized;
    this.token = res.token;
    this._slot = 1;
    this.resetForNewSession();
    this.adopt(res.session, 'session-first');
    this.startPolling();
    return res.session;
  }

  async sendMove(move: Move): Promise<void> {
    const session = this.requireSession();
    try {
      const res = await this.request<{ session: Session }>(
        'POST',
        `${API}/session/${session.code}/move`,
        { token: this.token, move, expectedVersion: session.version },
      );
      this.adopt(res.session);
      this.resetPollTimer();
    } catch (err) {
      const e = err as ApiError;
      // 409 means we were behind. The server hands back the truth; adopt it and
      // signal the UI that this particular move should be treated as a no-op.
      if (e.status === 409 && e.session) {
        this.adopt(e.session);
        this.resetPollTimer();
        throw new Error('out-of-sync');
      }
      throw err;
    }
  }

  async sendChat(text: string): Promise<void> {
    const session = this.requireSession();
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    const res = await this.request<{ session: Session }>(
      'POST',
      `${API}/session/${session.code}/chat`,
      { token: this.token, text: trimmed },
    );
    this.adopt(res.session);
    this.resetPollTimer();
  }

  async requestRematch(): Promise<void> {
    const session = this.requireSession();
    const res = await this.request<{ session: Session }>(
      'POST',
      `${API}/session/${session.code}/rematch`,
      { token: this.token },
    );
    this.adopt(res.session);
    this.resetPollTimer();
  }

  async leave(): Promise<void> {
    const session = this._session;
    const token = this.token;

    // Stop polling first so an in-flight poll cannot re-adopt the session we
    // are abandoning.
    this.stopPolling();

    if (session && token) {
      try {
        await this.request<{ session: Session }>('POST', `${API}/session/${session.code}/leave`, {
          token,
        });
      } catch {
        // Leaving is best-effort — the peer will notice via presence decay.
      }
    }

    this._session = null;
    this._slot = null;
    this.token = null;
    this.code = null;
    this.seenChatIds.clear();
    this.failures = 0;
    this.online = true;
  }

  // =======================================================================
  // HTTP
  // =======================================================================

  private async request<T>(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const rec = (payload ?? {}) as { error?: string; session?: Session };
      const message =
        typeof rec.error === 'string' && rec.error.length > 0
          ? rec.error
          : `Request failed (${res.status})`;
      throw apiError(message, res.status, rec.session);
    }

    return payload as T;
  }

  private requireSession(): Session {
    if (!this._session || !this.token) throw new Error('Not in a session');
    return this._session;
  }

  // =======================================================================
  // Polling
  // =======================================================================

  private startPolling(): void {
    this.stopPolling();
    this.epoch += 1;
    this.polling = true;
    this.paused = false;
    this.failures = 0;
    this.hiddenSince = isHidden() ? Date.now() : null;
    this.schedule(this.baseDelay());
  }

  private stopPolling(): void {
    this.epoch += 1;
    this.polling = false;
    this.paused = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Reschedule the next poll from now — used after a mutation already synced us. */
  private resetPollTimer(): void {
    if (!this.polling || this.paused) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.schedule(this.baseDelay());
  }

  private baseDelay(): PollDelay {
    return isHidden() ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
  }

  private schedule(delay: PollDelay): void {
    if (!this.polling) return;

    // Deep background: stop burning requests until the user comes back.
    if (
      isHidden() &&
      this.hiddenSince !== null &&
      Date.now() - this.hiddenSince > HIDDEN_PAUSE_AFTER_MS
    ) {
      this.paused = true;
      this.pollTimer = null;
      return;
    }

    const epoch = this.epoch;
    this.pollTimer = setTimeout(() => {
      if (epoch !== this.epoch) return;
      void this.poll(epoch);
    }, delay);
  }

  private async poll(epoch: number): Promise<void> {
    if (epoch !== this.epoch || !this._session) return;

    const { code, version } = this._session;
    const query = `v=${encodeURIComponent(String(version))}${
      this.token ? `&t=${encodeURIComponent(this.token)}` : ''
    }`;

    try {
      const res = await this.request<{ unchanged?: true; version?: number; session?: Session }>(
        'GET',
        `${API}/session/${encodeURIComponent(code)}?${query}`,
      );

      if (epoch !== this.epoch) return;

      this.markOnline();
      if (res.session) this.adopt(res.session);
      this.schedule(this.baseDelay());
    } catch (err) {
      if (epoch !== this.epoch) return;

      const e = err as ApiError;

      // The room is gone (expired or never existed) — nothing to recover from.
      if (e.status === 404) {
        this.stopPolling();
        this.emit({ type: 'error', message: e.message || 'Room not found', fatal: true });
        return;
      }

      this.failures += 1;
      if (this.failures >= OFFLINE_AFTER_FAILURES && this.online) {
        this.online = false;
        this.emit({ type: 'connection', online: false });
      }

      // Exponential backoff on top of the base cadence, capped.
      const backoff = Math.min(
        MAX_BACKOFF_MS,
        this.baseDelay() * Math.pow(2, this.failures - 1),
      );
      this.schedule(backoff);
    }
  }

  private markOnline(): void {
    this.failures = 0;
    if (!this.online) {
      this.online = true;
      this.emit({ type: 'connection', online: true });
    }
  }

  private onVisibilityChange = (): void => {
    if (isHidden()) {
      this.hiddenSince = Date.now();
      // Re-scheduling picks up the slower hidden cadence on the next tick.
      this.resetPollTimer();
      return;
    }

    this.hiddenSince = null;
    if (!this.polling) return;

    // Back in the foreground: poll straight away so the board is current.
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.paused = false;
    const epoch = this.epoch;
    this.pollTimer = setTimeout(() => {
      if (epoch !== this.epoch) return;
      void this.poll(epoch);
    }, 0);
  };

  // =======================================================================
  // State adoption + events
  // =======================================================================

  private resetForNewSession(): void {
    this.seenChatIds.clear();
    this.failures = 0;
    this.online = true;
  }

  /**
   * Take a server session as the new truth and emit the resulting events.
   * Chat is diffed by message id so subscribers only ever see genuinely new
   * messages (the server always sends the whole tail).
   */
  private adopt(session: Session, order: 'chat-first' | 'session-first' = 'chat-first'): void {
    this._session = session;

    const fresh: ChatMessage[] = [];
    for (const message of session.chat ?? []) {
      if (this.seenChatIds.has(message.id)) continue;
      this.seenChatIds.add(message.id);
      fresh.push(message);
    }

    if (order === 'session-first') {
      this.emit({ type: 'session', session });
      this.emit({ type: 'chat', messages: fresh });
      return;
    }

    if (fresh.length > 0) this.emit({ type: 'chat', messages: fresh });
    this.emit({ type: 'session', session });
  }

  private emit(event: NetEvent): void {
    for (const handler of Array.from(this.handlers)) {
      try {
        handler(event);
      } catch (err) {
        // A broken subscriber must never break the network loop.
        console.error('netClient handler error', err);
      }
    }
  }
}

export const netClient: NetClient = new NetClientImpl();
