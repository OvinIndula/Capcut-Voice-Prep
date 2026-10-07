import React, { useRef, useEffect, useState } from 'react';
import { Play, Pause, RotateCcw, Scissors } from 'lucide-react';
import { formatTime, formatIntervalLabel } from '../utils/audioSplitter';

interface WaveformTimelineProps {
  peaks: Float32Array | null;
  duration: number;
  intervalSeconds: number;
  isPlaying: boolean;
  timeRef: React.MutableRefObject<number>;
  seekTick: number;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
}

export const WaveformTimeline: React.FC<WaveformTimelineProps> = ({
  peaks,
  duration,
  intervalSeconds,
  isPlaying,
  timeRef,
  seekTick,
  onSeek,
  onTogglePlay,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || duration <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const amp = height / 2;
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, amp);
    ctx.lineTo(width, amp);
    ctx.stroke();

    const barWidth = 2.5;
    const gap = 1.5;
    const totalBars = Math.max(1, Math.floor(width / (barWidth + gap)));

    for (let i = 0; i < totalBars; i++) {
      const peakIndex = Math.min(peaks.length - 1, Math.floor((i / totalBars) * peaks.length));
      const avg = peaks[peakIndex] || 0;
      const barHeight = Math.max(3, avg * height * 1.6);
      const x = i * (barWidth + gap);
      const y = amp - barHeight / 2;
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 2);
      ctx.fill();
    }

    if (intervalSeconds > 0 && duration > 0) {
      let cutTime = intervalSeconds;
      while (cutTime < duration - 0.05) {
        const cutX = (cutTime / duration) * width;
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cutX, 0);
        ctx.lineTo(cutX, height);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(cutX - 1, 0, 2, 8);
        cutTime += intervalSeconds;
      }
    }
  }, [peaks, duration, intervalSeconds]);

  useEffect(() => {
    let raf = 0;
    const place = () => {
      const t = Math.max(0, Math.min(duration || 0, timeRef.current || 0));
      if (playheadRef.current && duration > 0) {
        playheadRef.current.style.left = `${(t / duration) * 100}%`;
      }
      if (labelRef.current) labelRef.current.textContent = formatTime(t, true);
      if (isPlaying) raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, duration, seekTick, timeRef]);

  const timeFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !duration) return 0;
    const rect = canvasRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  if (!peaks || duration <= 0) return null;

  const segmentCount = Math.ceil(duration / intervalSeconds);

  return (
    <div
      id="waveform-timeline-container"
      className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-3"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            id="btn-waveform-play-toggle"
            onClick={onTogglePlay}
            className="h-10 w-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-indigo-600/30 transition-all"
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <Pause className="h-5 w-5 fill-current" />
            ) : (
              <Play className="h-5 w-5 fill-current ml-0.5" />
            )}
          </button>

          <button
            id="btn-waveform-restart"
            onClick={() => onSeek(0)}
            className="h-9 w-9 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition-colors"
            title="Rewind to start"
          >
            <RotateCcw className="h-4 w-4" />
          </button>

          <div>
            <div className="flex items-center gap-2">
              <span ref={labelRef} className="text-base font-mono font-bold text-white">
                {formatTime(0, true)}
              </span>
              <span className="text-xs font-mono text-slate-500">/ {formatTime(duration, true)}</span>
            </div>
            <span className="text-[11px] text-slate-400">Click anywhere on the waveform to seek</span>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 text-slate-400">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-500"></span>
            <span>Audio waveform</span>
          </div>
          <div className="flex items-center gap-1.5 text-amber-400">
            <span className="inline-block w-2.5 h-0.5 border-t border-dashed border-amber-400"></span>
            <Scissors className="h-3 w-3" />
            <span>Split line ({formatIntervalLabel(intervalSeconds)})</span>
          </div>
        </div>
      </div>

      <div className="bg-slate-950/80 rounded-xl p-3 border border-slate-800 overflow-hidden">
        <div className="relative">
          <canvas
            id="canvas-waveform"
            ref={canvasRef}
            width={900}
            height={90}
            onClick={(e) => onSeek(timeFromEvent(e))}
            onMouseMove={(e) => setHoverTime(timeFromEvent(e))}
            onMouseLeave={() => setHoverTime(null)}
            className="w-full h-24 cursor-pointer block"
          />
          <div
            ref={playheadRef}
            className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_8px_#6366f1] pointer-events-none"
            style={{ left: '0%' }}
          />
        </div>

        {hoverTime !== null && (
          <div
            className="absolute top-2 pointer-events-none transform -translate-x-1/2 bg-slate-800/90 text-amber-300 border border-slate-700 text-[10px] font-mono px-1.5 py-0.5 rounded shadow"
            style={{
              left: `${Math.min(95, Math.max(5, (hoverTime / duration) * 100))}%`,
            }}
          >
            {formatTime(hoverTime, true)}
          </div>
        )}

        <div className="flex justify-between items-center text-[10px] font-mono text-slate-500 mt-2 px-1 border-t border-slate-800/60 pt-1.5">
          <span>00:00</span>
          {intervalSeconds > 0 && intervalSeconds < duration && (
            <span>
              Every {formatIntervalLabel(intervalSeconds)} ({segmentCount}{' '}
              {segmentCount === 1 ? 'part' : 'parts'})
            </span>
          )}
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
};
