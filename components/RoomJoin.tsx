
import React, { useState } from 'react';
import { soundService } from '../services/soundService';

interface RoomJoinProps {
  onJoin: (code: string, mode: 'AI' | 'LOCAL') => void;
}

const RoomJoin: React.FC<RoomJoinProps> = ({ onJoin }) => {
  const [code, setCode] = useState('');
  const [showRoomInput, setShowRoomInput] = useState(false);

  const handleQuickPlay = () => {
    soundService.playStart();
    onJoin('PRACTICE', 'AI');
  };

  const handleRoomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    soundService.playStart();
    // Logic assumes room is primarily for multiplayer/pass-n-play simulation
    onJoin(code, 'LOCAL'); 
  };

  return (
    <div className="max-w-md w-full p-8 relative z-10">
      {/* Header */}
      <div className="text-center mb-10 relative">
        <div className="absolute -inset-1 bg-cyan-500/20 blur-xl rounded-full"></div>
        <h1 className="relative text-5xl font-black text-white tracking-tighter drop-shadow-[0_0_15px_rgba(6,182,212,0.5)]">
          <span className="bg-clip-text text-transparent bg-gradient-to-b from-white to-cyan-400">COSMIC</span>
          <br />
          <span className="text-4xl text-cyan-500">TAC-TOE</span>
        </h1>
        <p className="text-cyan-200/60 mt-2 text-sm font-mono tracking-widest uppercase">Augmented Reality Battle</p>
      </div>

      <div className="glass-panel rounded-3xl p-6 space-y-4 transition-all duration-300">
        
        {!showRoomInput ? (
          <>
            {/* Main Menu Options */}
            <button
              onClick={handleQuickPlay}
              className="group w-full relative overflow-hidden rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 p-1 transition-all hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(6,182,212,0.4)]"
            >
              <div className="relative bg-slate-900/50 backdrop-blur-sm rounded-lg p-5 flex items-center justify-between group-hover:bg-opacity-0 transition-all">
                 <div className="text-left">
                    <div className="text-xl font-bold text-white mb-1">Quick Match</div>
                    <div className="text-xs text-cyan-200/70">VS Gemini AI • No Setup</div>
                 </div>
                 <div className="h-10 w-10 bg-white/10 rounded-full flex items-center justify-center">
                    <svg className="w-6 h-6 text-cyan-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                 </div>
              </div>
            </button>

            <button
              onClick={() => {
                soundService.playClick();
                setShowRoomInput(true);
              }}
              className="w-full rounded-xl border border-white/10 bg-white/5 p-5 flex items-center justify-between hover:bg-white/10 transition-all hover:border-white/20 group"
            >
               <div className="text-left">
                  <div className="text-xl font-bold text-slate-200 mb-1 group-hover:text-white">Join Portal</div>
                  <div className="text-xs text-slate-400 group-hover:text-slate-300">Enter Room Code • Multiplayer</div>
               </div>
               <div className="h-10 w-10 bg-black/20 rounded-full flex items-center justify-center group-hover:bg-black/40">
                   <svg className="w-5 h-5 text-slate-400 group-hover:text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" /></svg>
               </div>
            </button>
          </>
        ) : (
          /* Room Code Input Form */
          <form onSubmit={handleRoomSubmit} className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex items-center justify-between mb-2">
               <h3 className="text-white font-bold">Enter Portal Code</h3>
               <button 
                 type="button"
                 onClick={() => setShowRoomInput(false)}
                 className="text-xs text-slate-400 hover:text-white underline"
               >
                 Cancel
               </button>
            </div>
            
            <input
              type="text"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XYZ123"
              className="w-full bg-black/30 border border-white/10 text-center text-3xl font-mono tracking-[0.3em] text-cyan-400 py-4 rounded-xl focus:outline-none focus:border-cyan-500/50 focus:bg-black/50 transition-all placeholder:text-white/10"
              autoFocus
            />

            <button
              type="submit"
              disabled={code.length < 3}
              className="w-full bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-4 rounded-xl shadow-lg shadow-cyan-900/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              CONNECT
            </button>
          </form>
        )}

      </div>
      
      <div className="mt-8 text-center">
        <p className="text-[10px] text-slate-500/80 font-mono">
          POWERED BY GOOGLE GEMINI • THREE.JS • WEBXR
        </p>
      </div>
    </div>
  );
};

export default RoomJoin;
