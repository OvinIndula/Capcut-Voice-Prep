import React, { useState, useRef, useEffect } from 'react';
import {
  Download,
  Play,
  Pause,
  FileArchive,
  Clock,
  CheckCircle2,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { AudioSegment } from '../types';
import {
  formatTime,
  formatFileSize,
  formatIntervalLabel,
  downloadBlob,
  downloadAllAsZip,
  CAPCUT_VOICE_CHANGER_URL,
} from '../utils/audioSplitter';

interface SegmentListProps {
  segments: AudioSegment[];
  originalFilename: string;
  intervalSeconds: number;
}

export const SegmentList: React.FC<SegmentListProps> = ({
  segments,
  originalFilename,
  intervalSeconds,
}) => {
  const [activePlayingId, setActivePlayingId] = useState<string | null>(null);
  const [playbackProgress, setPlaybackProgress] = useState<number>(0);
  const [isZipping, setIsZipping] = useState(false);
  const [zipPercent, setZipPercent] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const totalBytes = segments.reduce((sum, seg) => sum + seg.sizeBytes, 0);

  const stopPlayback = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setActivePlayingId(null);
    setPlaybackProgress(0);
  };

  const playSegment = async (seg: AudioSegment) => {
    if (activePlayingId === seg.id) {
      stopPlayback();
      return;
    }

    if (!audioRef.current) audioRef.current = new Audio();
    const audio = audioRef.current;
    audio.pause();
    audio.src = seg.url;
    audio.onended = () => {
      setActivePlayingId(null);
      setPlaybackProgress(0);
    };
    audio.ontimeupdate = () => {
      const dur = audio.duration || seg.duration || 1;
      setPlaybackProgress(Math.min(100, (audio.currentTime / dur) * 100));
    };
    setActivePlayingId(seg.id);
    setPlaybackProgress(0);
    try {
      await audio.play();
    } catch {
      setActivePlayingId(null);
    }
  };

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const handleDownloadZip = async () => {
    if (segments.length === 0 || isZipping) return;
    setIsZipping(true);
    setZipPercent(0);

    const baseName = originalFilename.replace(/\.[^/.]+$/, '') || 'voice';
    const intervalStr =
      intervalSeconds % 60 === 0 ? `${intervalSeconds / 60}min` : `${intervalSeconds}s`;
    const zipName = `${baseName}_capcut_${intervalStr}_${segments.length}_parts.zip`;

    try {
      await downloadAllAsZip(segments, zipName, (pct) => setZipPercent(pct));
    } catch (err) {
      console.error('ZIP generation error:', err);
    } finally {
      setIsZipping(false);
      setZipPercent(0);
    }
  };

  if (segments.length === 0) return null;

  return (
    <div
      id="segment-list-container"
      className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-base font-bold text-white tracking-tight">CapCut-ready files</h2>
            <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              {segments.length} {segments.length === 1 ? 'part' : 'parts'}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {formatIntervalLabel(intervalSeconds)} max · {formatFileSize(totalBytes)} total · MP3,
            44.1 kHz, mono, 128 kbps
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <a
            id="link-open-capcut"
            href={CAPCUT_VOICE_CHANGER_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs sm:text-sm font-semibold rounded-xl border border-slate-700 transition-colors"
          >
            <ExternalLink className="h-4 w-4 text-amber-300" />
            <span>Open CapCut Voice Changer</span>
          </a>
          <button
            id="btn-download-all-zip"
            disabled={isZipping}
            onClick={handleDownloadZip}
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs sm:text-sm font-semibold rounded-xl shadow-lg shadow-emerald-600/20 transition-all"
          >
            {isZipping ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Packing… {zipPercent}%</span>
              </>
            ) : (
              <>
                <FileArchive className="h-4 w-4" />
                <span>Download all ({segments.length})</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
        {segments.map((seg) => {
          const isPlaying = activePlayingId === seg.id;
          return (
            <div
              key={seg.id}
              id={`segment-row-${seg.partNumber}`}
              className={`p-3.5 rounded-xl border transition-all ${
                isPlaying
                  ? 'bg-indigo-950/30 border-indigo-500/60 ring-1 ring-indigo-500/40'
                  : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    id={`btn-play-segment-${seg.partNumber}`}
                    onClick={() => playSegment(seg)}
                    className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${
                      isPlaying
                        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white'
                    }`}
                    title={isPlaying ? 'Pause segment' : 'Play segment'}
                  >
                    {isPlaying ? (
                      <Pause className="h-4 w-4 fill-current" />
                    ) : (
                      <Play className="h-4 w-4 fill-current ml-0.5" />
                    )}
                  </button>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-white bg-slate-800/90 px-2 py-0.5 rounded border border-slate-700">
                        Part {seg.partNumber}
                      </span>
                      <span className="text-xs font-medium text-slate-300 truncate" title={seg.filename}>
                        {seg.filename}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-slate-400 mt-1 font-mono">
                      <span className="flex items-center gap-1 text-amber-400">
                        <Clock className="h-3 w-3" />
                        {formatTime(seg.startTime)} → {formatTime(seg.endTime)}
                      </span>
                      <span>{formatTime(seg.duration)}</span>
                      <span className="font-semibold text-slate-200">{formatFileSize(seg.sizeBytes)}</span>
                      <span>44.1 kHz · mono · {seg.bitrateKbps} kbps</span>
                      {seg.capcutReady ? (
                        <span className="text-emerald-400/90 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/5 border border-emerald-500/20 flex items-center gap-1">
                          <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400" />
                          Under 15 min and 50 MB
                        </span>
                      ) : (
                        <span className="text-rose-400 text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/20 font-bold">
                          Over CapCut limit
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  id={`btn-download-segment-${seg.partNumber}`}
                  onClick={() => downloadBlob(seg.blob, seg.filename)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-semibold rounded-lg border border-slate-700/80 transition-colors self-end sm:self-center"
                >
                  <Download className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Download MP3</span>
                </button>
              </div>

              {isPlaying && (
                <div className="mt-2.5 w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                  <div className="bg-indigo-500 h-full" style={{ width: `${playbackProgress}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
