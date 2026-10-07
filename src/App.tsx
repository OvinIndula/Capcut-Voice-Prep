import React, { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Scissors,
  FileAudio,
  AlertCircle,
  Music,
  Info,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import { Header } from './components/Header';
import { WaveformTimeline } from './components/WaveformTimeline';
import { SegmentList } from './components/SegmentList';
import { TranscriptPanel } from './components/TranscriptPanel';
import { AudioSegment, AudioFileInfo } from './types';
import {
  decodeAudioFile,
  splitAudioForCapCut,
  createDemoAudioBuffer,
  formatTime,
  formatFileSize,
  formatIntervalLabel,
  getAudioContext,
  estimateOutputSize,
  computeWaveformPeaks,
  clampIntervalForCapCut,
  yieldToMain,
  SplitCancelled,
  SplitProgress,
  CAPCUT_SAFE_DURATION_SEC,
  CAPCUT_BITRATE_KBPS,
  CAPCUT_SAFE_FILE_BYTES,
} from './utils/audioSplitter';
import {
  correctTranscriptText,
  formatTranscript,
  transcribeBuffer,
  TranscriptCancelled,
  TranscriptCue,
} from './utils/transcript';
import { captureVideoFrames, isVideoFile } from './utils/videoFrames';

const PRESET_MINUTES = [1, 2, 3, 5, 10, 14];
const PRESET_SECONDS = [15, 30, 45, 60, 90, 120];

export default function App() {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [fileInfo, setFileInfo] = useState<AudioFileInfo | null>(null);

  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'seconds'>('minutes');
  const [intervalMinutes, setIntervalMinutes] = useState<number>(14);
  const [intervalSecondsVal, setIntervalSecondsVal] = useState<number>(60);

  const effectiveIntervalSeconds = clampIntervalForCapCut(
    intervalUnit === 'minutes'
      ? Math.max(1, Math.round(intervalMinutes * 60))
      : Math.max(1, intervalSecondsVal)
  );

  const [isBusy, setIsBusy] = useState(false);
  const [progress, setProgress] = useState<SplitProgress | null>(null);
  const [segments, setSegments] = useState<AudioSegment[]>([]);
  const [transcript, setTranscript] = useState('');
  const [transcriptStatus, setTranscriptStatus] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [topic, setTopic] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [seekTick, setSeekTick] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);
  const timeRef = useRef<number>(0);
  const jobRef = useRef(0);
  const segmentsRef = useRef<AudioSegment[]>([]);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const fileNameRef = useRef('voice');
  const debounceRef = useRef<number | null>(null);
  const transcriptJobRef = useRef(0);
  const rawTranscriptRef = useRef('');
  const topicRef = useRef('');
  const topicDebounceRef = useRef<number | null>(null);
  const videoFramesPromiseRef = useRef<Promise<string[]>>(Promise.resolve([]));

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    audioBufferRef.current = audioBuffer;
  }, [audioBuffer]);

  useEffect(() => {
    return () => {
      jobRef.current += 1;
      transcriptJobRef.current += 1;
      stopMasterAudio();
      segmentsRef.current.forEach((seg) => URL.revokeObjectURL(seg.url));
    };
  }, []);

  const stopMasterAudio = () => {
    if (masterSourceRef.current) {
      try {
        masterSourceRef.current.onended = null;
        masterSourceRef.current.stop();
        masterSourceRef.current.disconnect();
      } catch {
        /* already stopped */
      }
      masterSourceRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    setIsPlaying(false);
  };

  const playMasterAudio = async (startOffset = 0) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    const ctx = getAudioContext();
    audioCtxRef.current = ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    stopMasterAudio();

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const offset = Math.min(Math.max(0, startOffset), buffer.duration);
    startTimeRef.current = ctx.currentTime - offset;
    timeRef.current = offset;
    source.start(0, offset);
    masterSourceRef.current = source;
    setIsPlaying(true);
    setSeekTick((n) => n + 1);

    source.onended = () => {
      if (masterSourceRef.current !== source) return;
      setIsPlaying(false);
      pausedAtRef.current = 0;
      timeRef.current = 0;
      setSeekTick((n) => n + 1);
    };

    const updateLoop = () => {
      if (!audioCtxRef.current || masterSourceRef.current !== source) return;
      const elapsed = audioCtxRef.current.currentTime - startTimeRef.current;
      if (elapsed >= buffer.duration) {
        setIsPlaying(false);
        timeRef.current = 0;
        pausedAtRef.current = 0;
        setSeekTick((n) => n + 1);
        return;
      }
      timeRef.current = elapsed;
      animFrameRef.current = requestAnimationFrame(updateLoop);
    };
    animFrameRef.current = requestAnimationFrame(updateLoop);
  };

  const pauseMasterAudio = () => {
    if (masterSourceRef.current && audioCtxRef.current) {
      const elapsed = audioCtxRef.current.currentTime - startTimeRef.current;
      const duration = audioBufferRef.current?.duration || 0;
      pausedAtRef.current = Math.min(Math.max(0, elapsed), duration);
      timeRef.current = pausedAtRef.current;
      setSeekTick((n) => n + 1);
      stopMasterAudio();
    }
  };

  const toggleMasterPlay = () => {
    if (isPlaying) pauseMasterAudio();
    else playMasterAudio(pausedAtRef.current);
  };

  const handleSeek = (time: number) => {
    pausedAtRef.current = time;
    timeRef.current = time;
    setSeekTick((n) => n + 1);
    if (isPlaying) playMasterAudio(time);
  };

  const releaseSegments = () => {
    segmentsRef.current.forEach((seg) => URL.revokeObjectURL(seg.url));
    segmentsRef.current = [];
    setSegments([]);
  };

  const performSplit = async (buffer: AudioBuffer, interval: number, baseName: string) => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const job = ++jobRef.current;
    const safeInterval = clampIntervalForCapCut(interval);
    releaseSegments();
    setErrorMessage(null);
    setIsBusy(true);
    setProgress({
      part: 0,
      total: Math.max(1, Math.ceil(buffer.duration / safeInterval)),
      percent: 0,
      label: 'Starting CapCut export…',
    });

    try {
      await splitAudioForCapCut(buffer, safeInterval, baseName, {
        isCancelled: () => jobRef.current !== job,
        onProgress: (info) => {
          if (jobRef.current !== job) return;
          setProgress(info);
        },
        onSegment: (segment) => {
          if (jobRef.current !== job) {
            URL.revokeObjectURL(segment.url);
            return;
          }
          setSegments((prev) => {
            const next = [...prev, segment];
            segmentsRef.current = next;
            return next;
          });
        },
      });
    } catch (err: any) {
      if (jobRef.current !== job || err instanceof SplitCancelled) return;
      console.error('Split error:', err);
      setErrorMessage(err?.message || 'Could not prepare CapCut files.');
    } finally {
      if (jobRef.current === job) {
        setIsBusy(false);
      }
    }
  };

  const scheduleSplit = (seconds: number) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;
      performSplit(buffer, seconds, fileNameRef.current);
    }, 350);
  };

  const startTranscript = (buffer: AudioBuffer) => {
    const job = ++transcriptJobRef.current;
    const collected: TranscriptCue[] = [];
    rawTranscriptRef.current = '';
    setTranscript('');
    setTranscriptError(null);
    setTranscriptBusy(true);
    setTranscriptStatus('Preparing the transcript…');

    const polish = async (raw: string) => {
      if (!raw.trim() || transcriptJobRef.current !== job) return;
      setTranscriptBusy(true);
      setTranscriptStatus(
        'Checking the wording against the topic…'
      );
      const frames = await videoFramesPromiseRef.current.catch(() => [] as string[]);
      if (transcriptJobRef.current !== job) return;
      const corrected = await correctTranscriptText(raw, topicRef.current.trim(), frames);
      if (transcriptJobRef.current !== job) return;
      setTranscript(corrected);
      setTranscriptError(null);
      setTranscriptBusy(false);
      setTranscriptStatus(null);
    };

    void transcribeBuffer(buffer, {
      isCancelled: () => transcriptJobRef.current !== job,
      onStatus: (label) => {
        if (transcriptJobRef.current === job) setTranscriptStatus(label);
      },
      onCues: (cues) => {
        if (transcriptJobRef.current !== job) return;
        collected.splice(0, collected.length, ...cues);
        const raw = formatTranscript(collected);
        rawTranscriptRef.current = raw;
        setTranscript(raw);
      },
    })
      .then((cues) => {
        if (transcriptJobRef.current !== job) return;
        if (cues.length === 0) {
          setTranscriptBusy(false);
          setTranscriptStatus(null);
          setTranscriptError('No speech was found in this file.');
          return;
        }
        const raw = formatTranscript(cues);
        rawTranscriptRef.current = raw;
        return polish(raw);
      })
      .catch((err: unknown) => {
        if (transcriptJobRef.current !== job || err instanceof TranscriptCancelled) return;
        console.error('Transcript error:', err);
        setTranscriptBusy(false);
        setTranscriptStatus(null);
        setTranscriptError(err instanceof Error ? err.message : 'Transcription failed.');
      });
  };

  const handleTopicChange = (next: string) => {
    setTopic(next);
    topicRef.current = next;
    if (topicDebounceRef.current) window.clearTimeout(topicDebounceRef.current);
    const raw = rawTranscriptRef.current;
    if (!raw.trim()) return;
    const job = transcriptJobRef.current;
    topicDebounceRef.current = window.setTimeout(() => {
      if (transcriptJobRef.current !== job) return;
      setTranscriptBusy(true);
      setTranscriptStatus('Checking the wording against the topic…');
      void videoFramesPromiseRef.current
        .catch(() => [] as string[])
        .then((frames) => correctTranscriptText(raw, next.trim(), frames))
        .then((corrected) => {
          if (transcriptJobRef.current !== job) return;
          setTranscript(corrected);
          setTranscriptError(null);
        })
        .finally(() => {
          if (transcriptJobRef.current === job) {
            setTranscriptBusy(false);
            setTranscriptStatus(null);
          }
        });
    }, 700);
  };

  const handleFileProcess = async (file: File) => {
    stopMasterAudio();
    const job = ++jobRef.current;
    transcriptJobRef.current += 1;
    rawTranscriptRef.current = '';
    videoFramesPromiseRef.current = Promise.resolve([]);
    setErrorMessage(null);
    setTranscript('');
    setTranscriptError(null);
    setTranscriptBusy(false);
    setTranscriptStatus(null);
    releaseSegments();
    setAudioBuffer(null);
    setPeaks(null);
    setFileInfo(null);

    const maxBytes = 500 * 1024 * 1024;
    if (file.size > maxBytes) {
      setErrorMessage(
        `"${file.name}" is ${formatFileSize(file.size)}. Use a file under 500 MB so the browser can decode it.`
      );
      return;
    }

    const looksLikeAudio =
      file.type.startsWith('audio/') ||
      file.type.startsWith('video/') ||
      /\.(mp3|wav|m4a|aac|ogg|flac|webm|mp4|mpeg)$/i.test(file.name);
    if (file.type && !looksLikeAudio) {
      setErrorMessage('Drop an audio file first. A video is also accepted, and its soundtrack is what gets transcribed.');
      return;
    }

    videoFramesPromiseRef.current = isVideoFile(file) ? captureVideoFrames(file) : Promise.resolve([]);

    setIsBusy(true);
    setProgress({ part: 0, total: 1, percent: 0, label: 'Reading audio…' });
    await yieldToMain();

    try {
      const buffer = await decodeAudioFile(file);
      if (jobRef.current !== job) return;
      if (!buffer.duration || !Number.isFinite(buffer.duration)) {
        throw new Error('This file has no playable audio.');
      }
      const nextPeaks = computeWaveformPeaks(buffer);
      fileNameRef.current = file.name;
      setAudioBuffer(buffer);
      audioBufferRef.current = buffer;
      setPeaks(nextPeaks);
      setFileInfo({
        name: file.name,
        size: file.size,
        type: file.type || 'audio/mpeg',
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        numberOfChannels: buffer.numberOfChannels,
      });
      pausedAtRef.current = 0;
      timeRef.current = 0;
      setSeekTick((n) => n + 1);
      startTranscript(buffer);
      await performSplit(buffer, effectiveIntervalSeconds, file.name);
    } catch (err: any) {
      console.error('Audio decode error:', err);
      if (jobRef.current === job) {
        setIsBusy(false);
        setProgress(null);
        setErrorMessage(
          'This file could not be read. Use an MP3, WAV, M4A, or a video that contains a voice track.'
        );
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleLoadDemo = async () => {
    stopMasterAudio();
    const job = ++jobRef.current;
    transcriptJobRef.current += 1;
    rawTranscriptRef.current = '';
    videoFramesPromiseRef.current = Promise.resolve([]);
    setErrorMessage(null);
    setTranscript('');
    setTranscriptError(null);
    setTranscriptBusy(false);
    setTranscriptStatus('Upload a voice recording to transcribe it. The demo tone has no speech.');
    releaseSegments();
    setIsBusy(true);
    setProgress({ part: 0, total: 1, percent: 0, label: 'Building demo audio…' });
    await yieldToMain();

    const demoBuffer = createDemoAudioBuffer();
    if (jobRef.current !== job) return;
    const demoName = 'Demo_Voice_3min.mp3';
    fileNameRef.current = demoName;
    setAudioBuffer(demoBuffer);
    audioBufferRef.current = demoBuffer;
    setPeaks(computeWaveformPeaks(demoBuffer));
    setFileInfo({
      name: demoName,
      size: Math.round(demoBuffer.duration * (CAPCUT_BITRATE_KBPS * 1000) / 8),
      type: 'audio/mpeg',
      duration: demoBuffer.duration,
      sampleRate: demoBuffer.sampleRate,
      numberOfChannels: demoBuffer.numberOfChannels,
    });
    pausedAtRef.current = 0;
    timeRef.current = 0;
    setSeekTick((n) => n + 1);
    await performSplit(demoBuffer, effectiveIntervalSeconds, demoName);
  };

  const applyMinutes = (mins: number, immediate: boolean) => {
    const next = Math.min(14, Math.max(0.5, Number(mins.toFixed(1))));
    setIntervalMinutes(next);
    const seconds = clampIntervalForCapCut(Math.round(next * 60));
    if (!audioBufferRef.current) return;
    if (immediate) performSplit(audioBufferRef.current, seconds, fileNameRef.current);
    else scheduleSplit(seconds);
  };

  const applySeconds = (secs: number, immediate: boolean) => {
    const next = Math.min(CAPCUT_SAFE_DURATION_SEC, Math.max(1, Math.round(secs)));
    setIntervalSecondsVal(next);
    if (!audioBufferRef.current) return;
    if (immediate) performSplit(audioBufferRef.current, next, fileNameRef.current);
    else scheduleSplit(next);
  };

  const totalDuration = audioBuffer ? audioBuffer.duration : 0;
  const estimatedParts =
    totalDuration > 0 ? Math.ceil(totalDuration / effectiveIntervalSeconds) : 0;
  const remainder =
    totalDuration > 0 ? totalDuration % effectiveIntervalSeconds : 0;
  const estimatedBytes = estimateOutputSize(Math.min(totalDuration, effectiveIntervalSeconds));

  return (
    <div className="min-h-screen bg-[#0b0f17] text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Header onLoadDemo={handleLoadDemo} hasAudio={!!audioBuffer} />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-7 space-y-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
            <div>
              <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                <Scissors className="h-4 w-4 text-indigo-400" />
                <span>Prepare audio for CapCut Voice Changer</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                CapCut accepts one file up to 15 minutes and 50 MB. Each part here stays at 14
                minutes or less, under 48 MB, as a 44.1 kHz mono MP3.
              </p>
            </div>

            {!audioBuffer && (
              <button
                id="btn-load-demo-inline"
                onClick={handleLoadDemo}
                disabled={isBusy}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 transition-colors flex items-center gap-1.5 self-start sm:self-center disabled:opacity-50"
              >
                <Music className="h-3.5 w-3.5" />
                <span>Try with 3 min demo</span>
              </button>
            )}
          </div>

          <input
            type="file"
            ref={fileInputRef}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileProcess(f);
            }}
            accept="audio/*,video/mp4,video/webm,video/quicktime,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm,.mp4,.mov"
            className="hidden"
          />

          {!audioBuffer ? (
            <div
              id="dropzone-audio-splitter"
              onClick={() => {
                if (!isBusy) fileInputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file && !isBusy) handleFileProcess(file);
              }}
              className={`border-2 border-dashed rounded-2xl p-8 text-center transition-all flex flex-col items-center justify-center min-h-[180px] ${
                isBusy ? 'cursor-progress' : 'cursor-pointer'
              } ${
                isDragging
                  ? 'border-indigo-500 bg-indigo-500/10 scale-[1.01]'
                  : 'border-slate-700/80 hover:border-indigo-500/80 bg-slate-950/40 hover:bg-indigo-500/5'
              }`}
            >
              <div className="h-12 w-12 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center mb-3 border border-indigo-500/20">
                {isBusy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
              </div>
              <p className="text-sm font-semibold text-slate-200">
                {isBusy ? progress?.label || 'Working…' : 'Drop an audio file, or a video with a voice'}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Audio is used first. A video’s soundtrack is transcribed, and a few frames help fix the words.
              </p>
              {isBusy && (
                <div className="w-full max-w-sm mt-4">
                  <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 transition-all"
                      style={{ width: `${progress?.percent ?? 8}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3.5 overflow-hidden">
                <div className="h-10 w-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0 border border-emerald-500/30">
                  <FileAudio className="h-5 w-5" />
                </div>
                <div className="truncate">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white truncate">{fileInfo?.name}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-emerald-300 border border-slate-700">
                      {formatTime(totalDuration, true)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-400 mt-0.5 font-mono">
                    <span>{formatFileSize(fileInfo?.size || 0)}</span>
                    <span>{fileInfo?.sampleRate} Hz</span>
                    <span>{fileInfo?.numberOfChannels === 1 ? 'Mono' : 'Stereo'}</span>
                  </div>
                </div>
              </div>

              <button
                id="btn-replace-audio"
                onClick={() => fileInputRef.current?.click()}
                disabled={isBusy}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors self-end sm:self-center disabled:opacity-50"
              >
                Change file
              </button>
            </div>
          )}

          <div className="space-y-4 pt-2 border-t border-slate-800/80">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-bold text-slate-200">Part length</label>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                    CapCut max 14 min
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {intervalUnit === 'minutes'
                    ? `Each file is ${intervalMinutes} ${intervalMinutes === 1 ? 'minute' : 'minutes'} or shorter`
                    : `Each file is ${intervalSecondsVal} seconds or shorter`}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800">
                  <button
                    id="btn-unit-minutes"
                    type="button"
                    onClick={() => {
                      setIntervalUnit('minutes');
                      if (audioBufferRef.current) {
                        performSplit(
                          audioBufferRef.current,
                          clampIntervalForCapCut(Math.round(intervalMinutes * 60)),
                          fileNameRef.current
                        );
                      }
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                      intervalUnit === 'minutes'
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Minutes
                  </button>
                  <button
                    id="btn-unit-seconds"
                    type="button"
                    onClick={() => {
                      setIntervalUnit('seconds');
                      if (audioBufferRef.current) {
                        performSplit(audioBufferRef.current, intervalSecondsVal, fileNameRef.current);
                      }
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                      intervalUnit === 'seconds'
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Seconds
                  </button>
                </div>

                {intervalUnit === 'minutes' ? (
                  <div className="flex items-center bg-slate-950 border border-slate-700 rounded-xl overflow-hidden focus-within:border-indigo-500">
                    <button
                      id="btn-decrease-minutes"
                      onClick={() => applyMinutes(intervalMinutes - (intervalMinutes <= 1 ? 0.5 : 1), true)}
                      className="px-3 py-2 text-sm font-bold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                    >
                      -
                    </button>
                    <input
                      id="input-interval-minutes"
                      type="number"
                      step="0.5"
                      min="0.5"
                      max="14"
                      value={intervalMinutes}
                      onChange={(e) => applyMinutes(parseFloat(e.target.value) || 1, false)}
                      className="w-16 text-center text-sm font-mono font-bold bg-transparent text-white focus:outline-none"
                    />
                    <span className="text-xs text-slate-400 pr-2 select-none font-semibold">min</span>
                    <button
                      id="btn-increase-minutes"
                      onClick={() => applyMinutes(intervalMinutes + (intervalMinutes < 1 ? 0.5 : 1), true)}
                      className="px-3 py-2 text-sm font-bold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                    >
                      +
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center bg-slate-950 border border-slate-700 rounded-xl overflow-hidden focus-within:border-indigo-500">
                    <button
                      id="btn-decrease-seconds"
                      onClick={() => applySeconds(intervalSecondsVal - 5, true)}
                      className="px-3 py-2 text-sm font-bold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                    >
                      -
                    </button>
                    <input
                      id="input-interval-seconds"
                      type="number"
                      min="1"
                      max={CAPCUT_SAFE_DURATION_SEC}
                      value={intervalSecondsVal}
                      onChange={(e) => applySeconds(parseInt(e.target.value, 10) || 1, false)}
                      className="w-16 text-center text-sm font-mono font-bold bg-transparent text-white focus:outline-none"
                    />
                    <span className="text-xs text-slate-400 pr-2 select-none font-semibold">sec</span>
                    <button
                      id="btn-increase-seconds"
                      onClick={() => applySeconds(intervalSecondsVal + 5, true)}
                      className="px-3 py-2 text-sm font-bold text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                    >
                      +
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-slate-400 mr-1">
                {intervalUnit === 'minutes' ? 'Minute presets:' : 'Second presets:'}
              </span>
              {intervalUnit === 'minutes'
                ? PRESET_MINUTES.map((mins) => (
                    <button
                      key={mins}
                      id={`btn-preset-${mins}min`}
                      onClick={() => applyMinutes(mins, true)}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold font-mono transition-all ${
                        intervalMinutes === mins
                          ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30 ring-1 ring-indigo-400'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80'
                      }`}
                    >
                      {mins === 14 ? '14 min · CapCut max' : `${mins} min`}
                    </button>
                  ))
                : PRESET_SECONDS.map((sec) => (
                    <button
                      key={sec}
                      id={`btn-preset-${sec}s`}
                      onClick={() => applySeconds(sec, true)}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold font-mono transition-all ${
                        intervalSecondsVal === sec
                          ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30 ring-1 ring-indigo-400'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700/80'
                      }`}
                    >
                      {sec}s
                    </button>
                  ))}
            </div>

            {audioBuffer && (
              <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="flex items-start sm:items-center gap-2.5 text-slate-300">
                  <Info className="h-4 w-4 text-indigo-400 flex-shrink-0 mt-0.5 sm:mt-0" />
                  <div>
                    <div>
                      {formatTime(totalDuration)} becomes <strong>{estimatedParts}</strong>{' '}
                      {estimatedParts === 1 ? 'file' : 'files'} of{' '}
                      <strong>{formatIntervalLabel(effectiveIntervalSeconds)}</strong>
                      {remainder > 0.5 && estimatedParts > 1 && (
                        <span className="text-slate-400"> (last file {formatTime(remainder)})</span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1 font-mono text-[11px]">
                      <span className="text-slate-400">
                        About <strong className="text-white">{formatFileSize(estimatedBytes)}</strong> each
                      </span>
                      <span className="text-emerald-400 font-semibold flex items-center gap-1">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {estimatedBytes <= CAPCUT_SAFE_FILE_BYTES
                          ? 'Inside CapCut’s 50 MB and 15 minute limits'
                          : 'Too large for CapCut — shorten the part length'}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  id="btn-re-split"
                  onClick={() => {
                    if (audioBufferRef.current) {
                      performSplit(audioBufferRef.current, effectiveIntervalSeconds, fileNameRef.current);
                    }
                  }}
                  disabled={isBusy}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-semibold rounded-lg shadow transition-all flex items-center gap-1.5 self-start sm:self-auto flex-shrink-0"
                >
                  {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
                  <span>{isBusy ? 'Preparing…' : 'Make CapCut files'}</span>
                </button>
              </div>
            )}

            {isBusy && progress && audioBuffer && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>{progress.label}</span>
                  <span>{progress.percent}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 transition-all duration-150"
                    style={{ width: `${Math.max(4, progress.percent)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {errorMessage && (
            <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-3 flex items-center gap-2 text-rose-400 text-xs">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {audioBuffer && peaks && (
          <WaveformTimeline
            peaks={peaks}
            duration={totalDuration}
            intervalSeconds={effectiveIntervalSeconds}
            isPlaying={isPlaying}
            timeRef={timeRef}
            seekTick={seekTick}
            onSeek={handleSeek}
            onTogglePlay={toggleMasterPlay}
          />
        )}

        {audioBuffer && (
          <TranscriptPanel
            text={transcript}
            status={transcriptStatus}
            error={transcriptError}
            busy={transcriptBusy}
            filename={fileInfo?.name || 'voice'}
            topic={topic}
            onTopicChange={handleTopicChange}
          />
        )}

        {segments.length > 0 && (
          <SegmentList
            segments={segments}
            originalFilename={fileInfo?.name || 'voice'}
            intervalSeconds={effectiveIntervalSeconds}
          />
        )}
      </main>

      <footer className="border-t border-slate-800/80 bg-slate-950 py-5 px-4 text-center text-xs text-slate-500 mt-auto">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-400">CapCut Voice Prep</span>
            <span>Your audio stays in this browser. Transcription runs on this computer.</span>
          </div>
          <div>Then drop each MP3 into CapCut Voice Changer.</div>
        </div>
      </footer>
    </div>
  );
}
