import React, { useState } from 'react';
import { PlayerProfile, AvatarType } from '../types';
import { soundService } from '../services/soundService';

interface PlayerSetupProps {
  onComplete: (profile: PlayerProfile) => void;
  onBack: () => void;
}

const AVATAR_OPTIONS: { id: AvatarType; label: string; desc: string }[] = [
  { id: 'ASTRONAUT', label: 'Explorer', desc: 'Classic space suit' },
  { id: 'DRONE', label: 'Sentinel', desc: 'Hovering droid' },
  { id: 'CRYSTAL', label: 'Shard', desc: 'Psionic energy' },
];

const COLOR_OPTIONS = [
  { hex: '#0088ff', name: 'Blue' },
  { hex: '#00ff88', name: 'Green' },
  { hex: '#ff00ff', name: 'Pink' },
  { hex: '#ffaa00', name: 'Gold' },
];

const PlayerSetup: React.FC<PlayerSetupProps> = ({ onComplete, onBack }) => {
  const [name, setName] = useState('Player 1');
  const [selectedAvatar, setSelectedAvatar] = useState<AvatarType>('ASTRONAUT');
  const [selectedColor, setSelectedColor] = useState(COLOR_OPTIONS[0].hex);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    soundService.playStart();
    onComplete({
      name: name.trim(),
      avatarId: selectedAvatar,
      color: selectedColor
    });
  };

  return (
    <div className="max-w-md w-full p-6 relative z-20 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="glass-panel rounded-3xl p-6">
        
        <div className="flex items-center justify-between mb-6">
            <button onClick={onBack} className="text-slate-400 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
            </button>
            <h2 className="text-2xl font-bold text-white tracking-wider">CUSTOMIZE</h2>
            <div className="w-6"></div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Name Input */}
          <div className="space-y-2">
            <label className="text-xs text-cyan-300 font-bold uppercase tracking-wider ml-1">Call Sign</label>
            <input
              type="text"
              value={name}
              maxLength={10}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-black/30 border border-white/10 text-white px-4 py-3 rounded-xl focus:outline-none focus:border-cyan-500/50 focus:bg-black/50 transition-all font-mono"
              placeholder="ENTER NAME"
            />
          </div>

          {/* Avatar Selection */}
          <div className="space-y-3">
            <label className="text-xs text-cyan-300 font-bold uppercase tracking-wider ml-1">Select Model</label>
            <div className="grid grid-cols-3 gap-3">
              {AVATAR_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                      setSelectedAvatar(opt.id);
                      soundService.playClick();
                  }}
                  className={`relative p-3 rounded-xl border transition-all flex flex-col items-center gap-2 ${
                    selectedAvatar === opt.id
                      ? 'bg-cyan-500/20 border-cyan-500 shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                      : 'bg-white/5 border-white/10 hover:bg-white/10'
                  }`}
                >
                  {/* Simple CSS representations of models */}
                  <div className="w-10 h-10 flex items-center justify-center">
                      {opt.id === 'ASTRONAUT' && (
                          <div className="w-6 h-8 bg-slate-200 rounded-t-full relative">
                              <div className="absolute top-2 left-1 w-4 h-3 bg-black rounded-full"></div>
                          </div>
                      )}
                      {opt.id === 'DRONE' && (
                          <div className="w-8 h-8 border-2 border-slate-200 rounded-full flex items-center justify-center">
                              <div className="w-3 h-3 bg-cyan-400 rounded-full"></div>
                          </div>
                      )}
                      {opt.id === 'CRYSTAL' && (
                          <div className="w-0 h-0 border-l-[10px] border-l-transparent border-r-[10px] border-r-transparent border-b-[20px] border-b-slate-200"></div>
                      )}
                  </div>
                  <span className={`text-[10px] font-bold ${selectedAvatar === opt.id ? 'text-white' : 'text-slate-400'}`}>
                      {opt.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Color Selection */}
          <div className="space-y-3">
             <label className="text-xs text-cyan-300 font-bold uppercase tracking-wider ml-1">Hull Color</label>
             <div className="flex justify-between bg-black/20 p-2 rounded-xl border border-white/5">
                {COLOR_OPTIONS.map((c) => (
                    <button
                        key={c.hex}
                        type="button"
                        onClick={() => {
                            setSelectedColor(c.hex);
                            soundService.playClick();
                        }}
                        className={`w-10 h-10 rounded-full border-2 transition-all ${
                            selectedColor === c.hex ? 'scale-110 border-white shadow-lg' : 'border-transparent opacity-70 hover:opacity-100'
                        }`}
                        style={{ backgroundColor: c.hex }}
                        title={c.name}
                    />
                ))}
             </div>
          </div>

          <button
            type="submit"
            className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold py-4 rounded-xl shadow-[0_0_20px_rgba(6,182,212,0.4)] flex items-center justify-center gap-2 transition-all active:scale-95 mt-4"
          >
            <span>ENTER ARENA</span>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
};

export default PlayerSetup;