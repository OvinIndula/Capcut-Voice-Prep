import React from 'react';
import { Scissors, Music } from 'lucide-react';

interface HeaderProps {
  onLoadDemo: () => void;
  hasAudio: boolean;
}

export const Header: React.FC<HeaderProps> = ({ onLoadDemo }) => {
  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-40 px-4 lg:px-8 py-3.5">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-amber-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 ring-1 ring-white/20">
            <Scissors className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold tracking-tight text-white font-['Space_Grotesk']">
                CapCut <span className="text-indigo-400">Voice Prep</span>
              </h1>
              <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Under 15 min
              </span>
              <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                Under 50 MB
              </span>
              <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">
                MP3 44.1 kHz
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">
              Split a voice recording into files CapCut Voice Changer will accept
            </p>
          </div>
        </div>

        <button
          id="btn-load-demo-header"
          onClick={onLoadDemo}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700 transition-colors"
        >
          <Music className="h-3.5 w-3.5 text-indigo-400" />
          <span>Load demo audio (3 min)</span>
        </button>
      </div>
    </header>
  );
};
