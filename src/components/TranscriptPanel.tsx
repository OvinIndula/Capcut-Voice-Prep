import React, { useState } from 'react';
import { Copy, Download, Loader2, Quote } from 'lucide-react';
import { downloadBlob } from '../utils/audioSplitter';

interface TranscriptPanelProps {
  text: string;
  status: string | null;
  error: string | null;
  busy: boolean;
  filename: string;
  topic: string;
  onTopicChange: (topic: string) => void;
}

export const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
  text,
  status,
  error,
  busy,
  filename,
  topic,
  onTopicChange,
}) => {
  const [copied, setCopied] = useState(false);

  const copyText = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const downloadText = () => {
    if (!text) return;
    const base = filename.replace(/\.[^/.]+$/, '') || 'voice';
    downloadBlob(new Blob([text], { type: 'text/plain' }), `${base}_transcript.txt`);
  };

  return (
    <div
      id="transcript-panel"
      className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
            <Quote className="h-4 w-4 text-amber-300" />
            <span>Timestamped transcript</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Each line uses the exact spoken start and end. Audio is transcribed first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            id="btn-copy-transcript"
            type="button"
            onClick={copyText}
            disabled={!text}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-40"
          >
            <span className="inline-flex items-center gap-1.5">
              <Copy className="h-3.5 w-3.5" />
              {copied ? 'Copied' : 'Copy'}
            </span>
          </button>
          <button
            id="btn-download-transcript"
            type="button"
            onClick={downloadText}
            disabled={!text}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40"
          >
            <span className="inline-flex items-center gap-1.5">
              <Download className="h-3.5 w-3.5" />
              Download .txt
            </span>
          </button>
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] font-semibold text-slate-300">Topic</span>
        <input
          id="input-transcript-topic"
          value={topic}
          onChange={(event) => onTopicChange(event.target.value)}
          placeholder="What this recording is about"
          className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
        />
      </label>

      {busy && (
        <div className="flex items-center gap-2 text-xs text-indigo-200">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{status || 'Transcribing…'}</span>
        </div>
      )}

      {!busy && status && !text && (
        <p className="text-xs text-slate-400">{status}</p>
      )}

      {error && (
        <p className="text-xs text-rose-300">{error}</p>
      )}

      {text && (
        <pre
          id="transcript-output"
          className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl bg-slate-950 border border-slate-800 p-4 text-sm leading-relaxed text-slate-100 font-mono"
        >
          {text}
        </pre>
      )}
    </div>
  );
};
