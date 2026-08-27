# AR Games Platform — Architecture

A multi-game AR/3D arcade ("Cosmic Arcade") built with React 19 + Three.js + WebXR,
hosted on Netlify (static site + Netlify Functions + Netlify Blobs).

## Goals

1. **Liquid-glass UI** — modern glassmorphism design system, animated aurora background,
   Space Grotesk + Inter typography, buttery micro-interactions.
2. **Multi-game platform** — landing page with game cards; games plug in through a shared
   `GameDefinition` interface. Games: Tic-Tac-Toe and Connect Four.
3. **Three play modes per game**:
   - `ai` — vs. on-device AI (instant minimax/heuristic; Gemini optional if key present).
   - `local` — pass-and-play turn-taking, two humans on one phone with handoff UI.
   - `online` — real network session: host creates a game → gets a room code + QR code →
     second player scans the QR on their phone → shared session synced via Netlify
     Functions + Blobs (short polling).
4. **Chat** — collapsible chat dock for online games; never obstructs the board;
   unread badge; can be toggled off entirely.
5. **Works everywhere** — WebXR AR when supported; otherwise an equally polished non-AR
   3D table view (OrbitControls-style gestures) so desktop/iPhone users can play too.

## File layout (repo root is the Vite root)

```
index.html                     entry (no CDN scripts; everything bundled)
index.tsx                      React bootstrap
App.tsx                        top-level router/shell (view state machine)
types.ts                       ★ SHARED CONTRACT — game/session/chat types (do not change shapes)
styles/global.css              design system: tokens, liquid glass utilities, animations
components/
  Landing.tsx                  hero + game cards (uses /assets artwork)
  PlayerSetup.tsx              profile: name, avatar, color
  ModeSelect.tsx               ai / local / online chooser (+ difficulty)
  OnlineLobby.tsx              create (QR + code) / join / waiting states
  GameScreen.tsx               hosts scene + HUD + chat for the active game
  Hud.tsx                      top status bar: players, turn, thinking indicator
  ChatDock.tsx                 collapsible chat (online mode)
  WinOverlay.tsx               result + rematch
  GlassUI.tsx                  shared primitives: GlassPanel, GlassButton, IconButton…
engine/
  SceneHost.tsx                Three.js host: WebXR AR session OR fallback 3D view,
                               placement reticle, gestures (rotate/pinch), raycast picking
games/
  registry.ts                  GAMES: Record<GameId, GameDefinition>
  tictactoe/logic.ts           pure rules + AI (minimax, perfect play at 'hard')
  tictactoe/scene.ts           builds/updates Three.js board & pieces from state
  connect4/logic.ts            pure rules + AI (negamax w/ alpha-beta, depth by difficulty)
  connect4/scene.ts            3D board (7x6 frame, discs drop with gravity animation)
services/
  net.ts                       ★ network client implementing NetClient (types.ts)
  ai.ts                        dispatches to game logic AI; optional Gemini flavor
  sound.ts                     procedural WebAudio SFX (kept + polished)
netlify/functions/api.mts      single function, path "/api/*" — sessions, moves, chat
netlify.toml                   build config, functions dir, SPA redirect
public/assets/                 Higgsfield artwork (hero, game cards) + any GLB models
```

## Shared contracts (`types.ts`) — FROZEN

Implementation agents must import from `types.ts` and must NOT alter existing shapes
(adding new optional fields is OK). See the file itself; summary:

- `GameId = 'tictactoe' | 'connect4'`
- `PlayerSlot = 0 | 1` — slot 0 is host/X/red, slot 1 is guest/O/yellow.
- `Move = { cell?: number; column?: number }` — serializable.
- `GameCore` — `board` is game-specific JSON (`unknown` at platform level; each game
  casts). Contains `currentSlot`, `winner`, `winningCells`, `moveCount`.
- `Session` — the online-session document stored in Blobs and mirrored client-side.
- `ChatMessage = { id, slot, name, text, at }`.
- `NetClient` — interface `services/net.ts` implements; UI depends only on this.
- `GameDefinition` — interface each game implements (pure logic + scene builder).

## Online protocol (Netlify Function `netlify/functions/api.mts`, path `/api/*`)

Storage: `getStore({ name: 'sessions', consistency: 'strong' })`; key = room code
(6 chars, unambiguous alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`). Last-write-wins is
mitigated with optimistic concurrency: mutations carry `expectedVersion`; server rejects
stale writes with 409 and returns the fresh session.

Endpoints (JSON bodies; player auth via `playerToken` issued at create/join):

| Method/Path                    | Body                                   | Returns |
|--------------------------------|----------------------------------------|---------|
| POST `/api/session`            | `{ gameId, profile }`                  | `{ code, token, session }` |
| POST `/api/session/:code/join` | `{ profile }`                          | `{ token, session }` (409 if full) |
| GET  `/api/session/:code`      | `?v=<version>` (client's version)      | `{ session }` or `{ unchanged: true }` |
| POST `/api/session/:code/move` | `{ token, move, expectedVersion }`     | `{ session }` |
| POST `/api/session/:code/chat` | `{ token, text }` (≤ 280 chars)        | `{ session }` |
| POST `/api/session/:code/rematch` | `{ token }`                         | `{ session }` (resets GameCore, swaps starter) |
| POST `/api/session/:code/leave`| `{ token }`                            | `{ session }` (marks player disconnected) |

Server owns rules for online games: it validates moves via the same pure logic modules
(functions bundle `games/*/logic.ts`) so clients cannot desync.

Client (`services/net.ts`): polls GET every 1.5 s while a session is live (2.5 s when
tab hidden), exposes an event-emitter `NetClient` per `types.ts`, dedupes identical
versions, resends on transient failure with backoff.

Join URL for QR: `${location.origin}/?join=CODE` — App reads `?join=` on boot and jumps
straight to setup → join flow. QR rendered client-side with the `qrcode` npm package.

## Modes & turn-taking

- `ai`: human is slot 0. AI thinking indicator with a minimum 500 ms delay for feel.
  Difficulties: easy / medium / hard. Local engines are the default and always work
  offline; Gemini (`@google/genai`) is used for 'hard' flavor ONLY if
  `process.env.API_KEY` is present, with local engine as instant fallback.
- `local`: both humans on one phone. HUD shows a "pass the phone" handoff banner
  between turns with each player's name/color; both profiles collected at setup.
- `online`: slot assignment by server; moves only accepted from the player whose turn
  it is; HUD shows presence (connected/away) from `lastSeen` heartbeats (the GET poll
  doubles as heartbeat via `?t=token`).

## Design system ("liquid glass")

- CSS custom properties in `styles/global.css`; Tailwind v4 via `@tailwindcss/vite`
  plugin for utility classes (no CDN scripts).
- Glass recipe: translucent slate `rgba(15,23,42,.55)` + `backdrop-filter: blur(24px)
  saturate(1.4)` + 1px gradient border (top-light specular) + inner highlight
  `inset 0 1px 0 rgba(255,255,255,.12)` + soft outer shadow. Utility classes:
  `.glass`, `.glass-strong`, `.glass-pill`, `.glass-btn`.
- Animated aurora/nebula background layer behind all lobby views; hidden during AR.
- Motion: 150–350 ms ease-out transforms; respect `prefers-reduced-motion`.

## Build & deploy

- `npm run build` → `vite build` → `dist/`.
- `netlify.toml`: publish `dist`, functions `netlify/functions`, SPA fallback redirect
  `/* -> /index.html 200` (excluding `/api/*`).
- Deployed via Netlify MCP `deploy-site`.
