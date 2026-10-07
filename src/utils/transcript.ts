export type TranscriptCue = {
  start: number;
  end: number;
  text: string;
};

export class TranscriptCancelled extends Error {
  constructor() {
    super('Transcription cancelled');
    this.name = 'TranscriptCancelled';
  }
}

export function formatClock(seconds: number): string {
  const totalMs = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const hrs = Math.floor(totalMs / 3_600_000);
  const mins = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const clock = [hrs, mins, secs].map((n) => String(n).padStart(2, '0')).join(':');
  return `${clock}.${String(ms).padStart(3, '0')}`;
}

/**
 * Group word times into readable lines without moving the spoken start or end.
 * A new line begins after a pause, a sentence, or about 8 seconds.
 */
export function groupExactTimeline(cues: TranscriptCue[]): TranscriptCue[] {
  const grouped: TranscriptCue[] = [];
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = Math.max(0, cue.start);
    const end = Math.max(start + 0.05, cue.end);
    const prev = grouped[grouped.length - 1];
    const gap = prev ? start - prev.end : 0;
    const sentenceDone = /[.!?]["']?$/.test(prev?.text ?? '');
    const tooLong = prev ? end - prev.start > 8 : false;
    if (!prev || gap > 0.35 || sentenceDone || tooLong) {
      grouped.push({ start, end, text });
    } else {
      prev.end = Math.max(prev.end, end);
      const joiner = prev.text.endsWith('-') ? '' : ' ';
      prev.text = `${prev.text}${joiner}${text}`.replace(/\s+/g, ' ').trim();
    }
  }
  return grouped;
}

export function formatTranscript(cues: TranscriptCue[]): string {
  return groupExactTimeline(cues)
    .map((cue) => `${formatClock(cue.start)} - ${formatClock(cue.end)}\n"${cue.text}"`)
    .join('\n\n');
}

export async function correctTranscriptText(
  transcript: string,
  topic: string,
  frames: string[] = []
): Promise<string> {
  try {
    const response = await fetch('/api/openai/correct-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, topic, frames: frames.slice(0, 4) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && typeof payload.transcript === 'string' && payload.transcript.trim()) {
      return payload.transcript;
    }
  } catch {
    /* Keep the spoken transcript when correction is unavailable. */
  }
  return transcript;
}

async function sliceTo16k(buffer: AudioBuffer, startSec: number, durationSec: number): Promise<Float32Array> {
  const duration = Math.max(0.05, durationSec);
  const frames = Math.max(1, Math.round(duration * 16000));
  const offline = new OfflineAudioContext(1, frames, 16000);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0, Math.max(0, startSec), duration);
  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

type WorkerReply = {
  type: 'status' | 'result' | 'error';
  id: number;
  label?: string;
  message?: string;
  cues?: { start: number; end: number | null; text: string }[];
};

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<
  number,
  {
    resolve: (cues: { start: number; end: number | null; text: string }[]) => void;
    reject: (error: Error) => void;
    onStatus?: (label: string) => void;
  }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/transcribe.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const data = event.data;
      const job = pending.get(data.id);
      if (!job) return;
      if (data.type === 'status' && data.label) {
        job.onStatus?.(data.label);
        return;
      }
      pending.delete(data.id);
      if (data.type === 'error') job.reject(new Error(data.message || 'Transcription failed'));
      else job.resolve(data.cues || []);
    };
    worker.onerror = (event) => {
      const message = event.message || 'The transcription worker failed to start.';
      pending.forEach((job) => job.reject(new Error(message)));
      pending.clear();
    };
  }
  return worker;
}

function transcribeSamples(
  samples: Float32Array,
  onStatus?: (label: string) => void
): Promise<{ start: number; end: number | null; text: string }[]> {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onStatus });
    getWorker().postMessage({ id, samples }, [samples.buffer]);
  });
}

export async function transcribeBuffer(
  buffer: AudioBuffer,
  hooks: {
    isCancelled?: () => boolean;
    onStatus?: (label: string) => void;
    onCues?: (cues: TranscriptCue[]) => void;
  } = {}
): Promise<TranscriptCue[]> {
  if (hooks.isCancelled?.()) throw new TranscriptCancelled();
  hooks.onStatus?.('Preparing the voice track…');
  const samples = await sliceTo16k(buffer, 0, buffer.duration);
  if (hooks.isCancelled?.()) throw new TranscriptCancelled();
  hooks.onStatus?.('Transcribing the audio…');
  const raw = await transcribeSamples(samples, hooks.onStatus);
  if (hooks.isCancelled?.()) throw new TranscriptCancelled();

  const cues: TranscriptCue[] = [];
  for (const cue of raw) {
    const start = Math.max(0, cue.start);
    const end = cue.end == null ? start + 0.4 : Math.max(start + 0.2, cue.end);
    if (!cue.text.trim()) continue;
    cues.push({ start, end: Math.min(buffer.duration, end), text: cue.text.trim() });
  }
  hooks.onCues?.(cues);
  return cues;
}
