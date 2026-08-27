// TEMPORARY verification harness for games/memory/scene.ts. Not part of the app.
import React, { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SceneHost from '../engine/SceneHost';
import { memoryLogic, createMemoryCore, type MemoryBoard } from '../games/memory/logic';
import type { GameCore, Move, PlayerProfile, PlayerSlot } from '../types';

const PROFILES: [PlayerProfile, PlayerProfile] = [
  { name: 'Nova', avatarId: 'ASTRONAUT', color: '#22d3ee' },
  { name: 'Vega', avatarId: 'DRONE', color: '#fbbf24' },
];

const Harness: React.FC = () => {
  const [core, setCore] = useState<GameCore>(() => createMemoryCore({ size: 'standard' }));
  const [prev, setPrev] = useState<GameCore | null>(null);

  const profiles = useMemo(() => PROFILES, []);

  const apply = useCallback((move: Move, slot: PlayerSlot) => {
    setCore((c) => {
      const next = memoryLogic.applyMove(c, move, slot);
      if (!next) return c;
      setPrev(c);
      return next;
    });
  }, []);

  const onMove = useCallback(
    (move: Move) => {
      setCore((c) => {
        const next = memoryLogic.applyMove(c, move, c.currentSlot);
        if (!next) return c;
        setPrev(c);
        return next;
      });
    },
    [],
  );

  // Test hooks.
  (window as unknown as Record<string, unknown>).__qp = {
    board: () => JSON.parse(JSON.stringify(core.board as MemoryBoard)),
    core: () => ({ winner: core.winner, winningCells: core.winningCells, currentSlot: core.currentSlot, moveCount: core.moveCount }),
    move: (m: Move, slot?: PlayerSlot) => apply(m, (slot ?? core.currentSlot) as PlayerSlot),
    ai: (slot?: PlayerSlot) => {
      const s = (slot ?? core.currentSlot) as PlayerSlot;
      apply(memoryLogic.aiMove(core, s, 'hard'), s);
    },
    reset: (size: string) => {
      setPrev(null);
      setCore(createMemoryCore({ size: size as never }));
    },
  };

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <SceneHost
        gameId="memory"
        core={core}
        prevCore={prev}
        profiles={profiles}
        currentSlot={core.currentSlot}
        winner={core.winner}
        onMove={onMove}
        enabled={core.winner === null}
      />
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<Harness />);
