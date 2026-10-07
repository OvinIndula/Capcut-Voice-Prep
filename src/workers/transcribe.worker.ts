import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

type InMessage = {
  id: number;
  samples: Float32Array;
};

type Cue = {
  start: number;
  end: number | null;
  text: string;
};

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>
) => Promise<{
  chunks?: { timestamp: [number, number | null]; text: string }[];
}>;

let transcriberPromise: Promise<Transcriber> | null = null;
let engineLabel = 'this processor';

function loadModel(id: number): Promise<Transcriber> {
  if (!transcriberPromise) {
    const progress_callback = (info: { status?: string; progress?: number }) => {
      if (info.status === 'progress' || info.status === 'progress_total') {
        const pct = Math.max(0, Math.min(100, Math.round(info.progress || 0)));
        self.postMessage({
          type: 'status',
          id,
          label: `Downloading the fast speech model… ${pct}%`,
        });
      }
    };
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const setups = [
      ...(hasGpu
        ? [
            {
              model: 'onnx-community/whisper-tiny.en',
              device: 'webgpu' as const,
              dtype: 'q4f16' as const,
              label: 'the graphics chip',
            },
          ]
        : []),
      {
        model: 'Xenova/whisper-tiny.en',
        dtype: 'q8' as const,
        label: 'this processor',
      },
    ];
    const attempt = (async () => {
      let lastError: unknown;
      for (const setup of setups) {
        try {
          const transcriber = (await pipeline('automatic-speech-recognition', setup.model, {
            ...(setup.device ? { device: setup.device } : {}),
            dtype: setup.dtype,
            progress_callback,
          })) as Transcriber;
          engineLabel = setup.label;
          return transcriber;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Could not load the speech model');
    })();
    transcriberPromise = attempt;
    attempt.catch(() => {
      if (transcriberPromise === attempt) transcriberPromise = null;
    });
  }
  return transcriberPromise;
}

function windowLoud(samples: Float32Array, index: number): number {
  const size = 160;
  const end = Math.min(samples.length, index + size);
  let sum = 0;
  for (let i = index; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - index));
}

/** Pull a timestamp in to where the voice actually starts and stops. */
function snapToVoice(samples: Float32Array, start: number, end: number): { start: number; end: number } {
  const rate = 16000;
  const hop = 160;
  let from = Math.max(0, Math.floor(start * rate));
  let to = Math.min(samples.length, Math.floor(end * rate));
  if (to - from < hop * 4) return { start, end };
  while (from + hop < to && windowLoud(samples, from) < 0.012) from += hop;
  while (to - hop > from && windowLoud(samples, to - hop) < 0.012) to -= hop;
  return { start: from / rate, end: Math.max(from / rate + 0.05, to / rate) };
}

self.onmessage = async (event: MessageEvent<InMessage>) => {
  const { id, samples } = event.data;
  try {
    self.postMessage({ type: 'status', id, label: 'Loading speech model…' });
    const transcriber = await loadModel(id);
    self.postMessage({ type: 'status', id, label: `Timing each word on ${engineLabel}…` });
    const duration = samples.length / 16000;
    const options: Record<string, unknown> = {
      return_timestamps: 'word',
      num_beams: 1,
      do_sample: false,
    };
    if (duration > 28) {
      options.chunk_length_s = 30;
      options.stride_length_s = 1;
    }
    let output: { chunks?: { timestamp: [number, number | null]; text: string }[] };
    try {
      output = await transcriber(samples, options);
    } catch {
      output = await transcriber(samples, { ...options, return_timestamps: true });
    }
    const cues: Cue[] = (output.chunks || [])
      .map((chunk) => ({
        start: Number(chunk.timestamp?.[0] ?? 0),
        end: chunk.timestamp?.[1] == null ? null : Number(chunk.timestamp[1]),
        text: String(chunk.text || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((cue) => cue.text && !/^\[(music|silence|blank_audio|applause|noise)\]$/i.test(cue.text))
      .map((cue) => {
        const snapped = snapToVoice(samples, cue.start, cue.end ?? cue.start + 0.2);
        return { ...cue, start: snapped.start, end: snapped.end };
      });
    self.postMessage({ type: 'result', id, cues });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed';
    self.postMessage({
      type: 'error',
      id,
      message: message.includes('fetch') || message.includes('Failed to')
        ? 'Could not download the speech model. Check your connection and try the file again.'
        : message,
    });
  }
};
