// STUB — replaced by networking agent
// ============================================================================
// Thin placeholder implementing the NetClient contract from types.ts so the UI
// compiles and runs standalone. The real implementation (Netlify Functions +
// Blobs short-polling) is delivered by the networking agent and MUST keep this
// exact export: `export const netClient: NetClient`.
//
// The UI depends only on the NetClient interface and the NetEvent stream, so
// swapping this file out requires no UI changes.
// ============================================================================

import type {
  GameId,
  Move,
  NetClient,
  NetEvent,
  PlayerProfile,
  PlayerSlot,
  Session,
} from '../types';

const NOT_IMPLEMENTED = 'Online play is not wired up yet (services/net.ts is a stub).';

class StubNetClient implements NetClient {
  private handlers = new Set<(e: NetEvent) => void>();

  get session(): Session | null {
    return null;
  }

  get slot(): PlayerSlot | null {
    return null;
  }

  async createSession(_gameId: GameId, _profile: PlayerProfile): Promise<Session> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async joinSession(_code: string, _profile: PlayerProfile): Promise<Session> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async sendMove(_move: Move): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async sendChat(_text: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async requestRematch(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async leave(): Promise<void> {
    // No-op: nothing to tear down in the stub.
  }

  on(handler: (e: NetEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

export const netClient: NetClient = new StubNetClient();
