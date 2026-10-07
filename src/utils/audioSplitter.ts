import JSZip from 'jszip';
import { Mp3Encoder } from '@breezystack/lamejs';
import { AudioSegment } from '../types';

/**
 * CapCut Voice Changer (web): "File size up to 50 MB and 15 minutes".
 * Parts are kept shorter and smaller than those caps so an upload on the
 * limit is not rejected, and audio is re-encoded as 44.1 kHz mono MP3.
 * Browser-recorded files are often 48 kHz, which this encoder writes in a
 * form CapCut reports as unsupported.
 */
export const CAPCUT_MAX_DURATION_SEC = 15 * 60;
export const CAPCUT_SAFE_DURATION_SEC = 14 * 60;
export const CAPCUT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const CAPCUT_SAFE_FILE_BYTES = 48 * 1024 * 1024;
export const CAPCUT_SAMPLE_RATE = 44100;
export const CAPCUT_CHANNELS = 1;
export const CAPCUT_BITRATE_KBPS = 128;
export const CAPCUT_VOICE_CHANGER_URL =
  'https://www.capcut.com/magic-tools/text-to-speech?tab=voice-changer';

export const MAX_DOWNLOAD_FILE_SIZE_MB = 50;
export const MAX_DOWNLOAD_FILE_SIZE_BYTES = CAPCUT_MAX_FILE_BYTES;

export function clampIntervalForCapCut(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return CAPCUT_SAFE_DURATION_SEC;
  return Math.min(CAPCUT_SAFE_DURATION_SEC, Math.max(1, seconds));
}

export function estimateOutputSize(
  durationSeconds: number,
  bitrateKbps: number = CAPCUT_BITRATE_KBPS
): number {
  const bytesPerSecond = (bitrateKbps * 1000) / 8;
  return Math.round(durationSeconds * bytesPerSecond);
}

export function getMaxSafeIntervalMinutes(bitrateKbps: number = CAPCUT_BITRATE_KBPS): number {
  const bytesPerSecond = (bitrateKbps * 1000) / 8;
  const maxSafeSeconds = (CAPCUT_SAFE_FILE_BYTES * 0.98) / bytesPerSecond;
  const bySize = Math.floor((maxSafeSeconds / 60) * 10) / 10;
  const byDuration = CAPCUT_SAFE_DURATION_SEC / 60;
  return Math.min(bySize, byDuration);
}

export class SplitCancelled extends Error {
  constructor() {
    super('Split cancelled');
    this.name = 'SplitCancelled';
  }
}

export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

let sharedAudioCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    sharedAudioCtx = new AudioContextClass();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume();
  }
  return sharedAudioCtx;
}

export async function decodeAudioFile(file: File | Blob): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  return await ctx.decodeAudioData(arrayBuffer.slice(0));
}

/**
 * Peak envelope for the waveform. Strides through the buffer so a long
 * file does not freeze the tab by reading every sample.
 */
export function computeWaveformPeaks(audioBuffer: AudioBuffer, bars = 900): Float32Array {
  const channel = audioBuffer.getChannelData(0);
  const peaks = new Float32Array(bars);
  const samplesPerBar = Math.max(1, Math.floor(channel.length / bars));

  for (let i = 0; i < bars; i++) {
    const start = i * samplesPerBar;
    const end = Math.min(channel.length, start + samplesPerBar);
    const stride = Math.max(1, Math.floor((end - start) / 350));
    let max = 0;
    for (let j = start; j < end; j += stride) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }

  return peaks;
}

function peakStride(samples: Float32Array): number {
  let peak = 0;
  const stride = Math.max(1, Math.floor(samples.length / 8000));
  for (let i = 0; i < samples.length; i += stride) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

async function renderSegmentMono(
  audioBuffer: AudioBuffer,
  startSec: number,
  durationSec: number,
  isCancelled?: () => boolean
): Promise<Float32Array> {
  const start = Math.max(0, Math.min(startSec, Math.max(0, audioBuffer.duration - 0.001)));
  const duration = Math.max(0.01, Math.min(durationSec, audioBuffer.duration - start));
  const frames = Math.max(1, Math.round(duration * CAPCUT_SAMPLE_RATE));

  if (typeof OfflineAudioContext !== 'undefined') {
    try {
      const offline = new OfflineAudioContext(CAPCUT_CHANNELS, frames, CAPCUT_SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offline.destination);
      source.start(0, start, duration);
      const rendered = await offline.startRendering();
      if (isCancelled?.()) throw new SplitCancelled();
      const mixed = rendered.getChannelData(0);
      if (peakStride(mixed) > 0.0001 || peakOfSource(audioBuffer, start, duration) < 0.0001) {
        const copy = new Float32Array(mixed.length);
        copy.set(mixed);
        return copy;
      }
    } catch (err) {
      if (err instanceof SplitCancelled) throw err;
    }
  }

  return resampleLinearMono(audioBuffer, start, duration, isCancelled);
}

function peakOfSource(audioBuffer: AudioBuffer, startSec: number, durationSec: number): number {
  const channel = audioBuffer.getChannelData(0);
  const start = Math.floor(startSec * audioBuffer.sampleRate);
  const end = Math.min(channel.length, Math.floor((startSec + durationSec) * audioBuffer.sampleRate));
  let peak = 0;
  const stride = Math.max(1, Math.floor((end - start) / 4000));
  for (let i = start; i < end; i += stride) {
    const v = Math.abs(channel[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

async function resampleLinearMono(
  audioBuffer: AudioBuffer,
  startSec: number,
  durationSec: number,
  isCancelled?: () => boolean
): Promise<Float32Array> {
  const srcRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  const srcStart = Math.floor(startSec * srcRate);
  const srcEnd = Math.min(audioBuffer.length, Math.floor((startSec + durationSec) * srcRate));
  const srcLength = Math.max(1, srcEnd - srcStart);
  const dstLength = Math.max(1, Math.round((srcLength * CAPCUT_SAMPLE_RATE) / srcRate));
  const out = new Float32Array(dstLength);
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));

  const ratio = srcRate / CAPCUT_SAMPLE_RATE;
  for (let i = 0; i < dstLength; i++) {
    const srcPos = srcStart + i * ratio;
    const i0 = Math.min(audioBuffer.length - 1, Math.floor(srcPos));
    const i1 = Math.min(audioBuffer.length - 1, i0 + 1);
    const frac = srcPos - Math.floor(srcPos);
    let s0 = 0;
    let s1 = 0;
    for (let c = 0; c < channels; c++) {
      s0 += data[c][i0] || 0;
      s1 += data[c][i1] || 0;
    }
    out[i] = (s0 + (s1 - s0) * frac) / channels;
    if (i > 0 && i % 200000 === 0) {
      if (isCancelled?.()) throw new SplitCancelled();
      await yieldToMain();
    }
  }
  return out;
}

function toUnsignedBytes(mp3buf: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(mp3buf.length);
  for (let i = 0; i < mp3buf.length; i++) out[i] = mp3buf[i] & 0xff;
  return out;
}

/** True when the buffer starts at an MPEG frame or an ID3 tag followed by one. */
export function mp3FrameLooksValid(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  let i = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length > 10) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    i = 10 + size;
  }
  if (i + 1 >= bytes.length) return false;
  return bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0;
}

/**
 * Encode mono float PCM as a constant-bitrate MPEG-1 Layer III file.
 * Yields to the browser between blocks so the tab stays responsive.
 */
export async function encodeMonoPcmToMp3(
  samples: Float32Array,
  sampleRate: number = CAPCUT_SAMPLE_RATE,
  kbps: number = CAPCUT_BITRATE_KBPS,
  hooks?: {
    isCancelled?: () => boolean;
    onPercent?: (percent: number) => void;
  }
): Promise<Blob> {
  if (sampleRate !== CAPCUT_SAMPLE_RATE) {
    throw new Error(`CapCut export must be ${CAPCUT_SAMPLE_RATE} Hz`);
  }

  const encoder = new Mp3Encoder(CAPCUT_CHANNELS, sampleRate, kbps);
    const blockSize = 1152;
    const parts: Uint8Array[] = [];
    const total = samples.length;
    let lastReport = 0;

    for (let i = 0; i < total; i += blockSize) {
    const n = Math.min(blockSize, total - i);
    const chunk = new Int16Array(n);
    for (let j = 0; j < n; j++) {
      let s = samples[i + j];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      chunk[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const mp3buf = encoder.encodeBuffer(chunk);
    if (mp3buf && mp3buf.length > 0) parts.push(toUnsignedBytes(mp3buf));

      if ((i / blockSize) % 24 === 0) {
        if (hooks?.isCancelled?.()) throw new SplitCancelled();
        const now = Date.now();
        if (now - lastReport > 200) {
          lastReport = now;
          hooks?.onPercent?.(total > 0 ? i / total : 1);
        }
        await yieldToMain();
      }
  }

  const flushed = encoder.flush();
  if (flushed && flushed.length > 0) parts.push(toUnsignedBytes(flushed));

  const blob = new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
  const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (!mp3FrameLooksValid(header)) {
    throw new Error('Encoder produced an MP3 CapCut will not accept. Try the file again.');
  }
  return blob;
}

function safeBaseName(baseFilename: string): string {
  const cleaned = baseFilename
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  return cleaned || 'voice';
}

export interface SplitProgress {
  part: number;
  total: number;
  percent: number;
  label: string;
}

/**
 * Split into MP3 parts that fit CapCut Voice Changer:
 * under 15 minutes, under 50 MB, 44.1 kHz mono, 128 kbps.
 */
export async function splitAudioForCapCut(
  audioBuffer: AudioBuffer,
  intervalSeconds: number,
  baseFilename: string = 'voice',
  hooks: {
    isCancelled?: () => boolean;
    onProgress?: (info: SplitProgress) => void;
    onSegment?: (segment: AudioSegment) => void;
  } = {}
): Promise<AudioSegment[]> {
  const interval = clampIntervalForCapCut(intervalSeconds);
  const totalDuration = audioBuffer.duration;
  const total = Math.max(1, Math.ceil(totalDuration / interval));
  const base = safeBaseName(baseFilename);
  const segments: AudioSegment[] = [];

  let currentStart = 0;
  let partIndex = 1;

  while (currentStart < totalDuration - 0.05) {
    if (hooks.isCancelled?.()) throw new SplitCancelled();

    let currentEnd = Math.min(totalDuration, currentStart + interval);
    const segDuration = currentEnd - currentStart;
    if (segDuration < 0.1) break;

    const partLabel = `Part ${partIndex} of ${total}`;
    hooks.onProgress?.({
      part: partIndex,
      total,
      percent: Math.round(((partIndex - 1) / total) * 100),
      label: `Preparing ${partLabel} for CapCut…`,
    });

    const samples = await renderSegmentMono(audioBuffer, currentStart, segDuration, hooks.isCancelled);

    let bitrate = CAPCUT_BITRATE_KBPS;
    let audioBlob = await encodeMonoPcmToMp3(samples, CAPCUT_SAMPLE_RATE, bitrate, {
      isCancelled: hooks.isCancelled,
      onPercent: (fraction) => {
        const overall = ((partIndex - 1 + fraction) / total) * 100;
        hooks.onProgress?.({
          part: partIndex,
          total,
          percent: Math.min(99, Math.round(overall)),
          label: `Encoding ${partLabel} for CapCut… ${Math.round(fraction * 100)}%`,
        });
      },
    });

    if (audioBlob.size > CAPCUT_SAFE_FILE_BYTES) {
      bitrate = 64;
      audioBlob = await encodeMonoPcmToMp3(samples, CAPCUT_SAMPLE_RATE, bitrate, {
        isCancelled: hooks.isCancelled,
      });
    }

    const capcutReady =
      segDuration < CAPCUT_MAX_DURATION_SEC - 0.25 && audioBlob.size < CAPCUT_MAX_FILE_BYTES;

    if (!capcutReady) {
      throw new Error(
        `${partLabel} is still over CapCut's 15 minute or 50 MB limit. Use a shorter interval.`
      );
    }

    const url = URL.createObjectURL(audioBlob);
    const filename = `${base}_part${String(partIndex).padStart(2, '0')}.mp3`;
    const segment: AudioSegment = {
      id: `seg-${partIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      partNumber: partIndex,
      startTime: currentStart,
      endTime: currentEnd,
      duration: segDuration,
      blob: audioBlob,
      url,
      filename,
      sizeBytes: audioBlob.size,
      format: 'mp3',
      sampleRate: CAPCUT_SAMPLE_RATE,
      channels: CAPCUT_CHANNELS,
      bitrateKbps: bitrate,
      capcutReady,
    };

    segments.push(segment);
    hooks.onSegment?.(segment);

    currentStart = currentEnd;
    partIndex++;
  }

  hooks.onProgress?.({
    part: total,
    total,
    percent: 100,
    label: `${segments.length} CapCut-ready ${segments.length === 1 ? 'file' : 'files'}`,
  });

  return segments;
}

export function formatTime(seconds: number, includeMs = false): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  let timeStr = '';
  if (hrs > 0) {
    timeStr = `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  if (includeMs) {
    const ms = Math.floor((seconds % 1) * 10);
    return `${timeStr}.${ms}`;
  }
  return timeStr;
}

export function formatTimestampForFilename(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}h${mins.toString().padStart(2, '0')}m${secs.toString().padStart(2, '0')}s`;
  }
  return `${mins.toString().padStart(2, '0')}m${secs.toString().padStart(2, '0')}s`;
}

export function formatIntervalLabel(seconds: number): string {
  if (seconds <= 0) return '0s';
  if (seconds % 60 === 0) {
    const mins = seconds / 60;
    return `${mins} ${mins === 1 ? 'min' : 'mins'}`;
  }
  if (seconds >= 60) {
    const mins = (seconds / 60).toFixed(1).replace(/\.0$/, '');
    return `${mins} mins`;
  }
  return `${seconds}s`;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadAllAsZip(
  segments: AudioSegment[],
  zipFilename: string = 'capcut_voice_parts.zip',
  onProgress?: (percent: number) => void
): Promise<void> {
  const zip = new JSZip();
  segments.forEach((seg) => {
    zip.file(seg.filename, seg.blob);
  });

  const zipBlob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'STORE',
    },
    (metadata) => {
      if (onProgress) onProgress(Math.round(metadata.percent));
    }
  );

  downloadBlob(zipBlob, zipFilename);
}

export function createDemoAudioBuffer(): AudioBuffer {
  const ctx = getAudioContext();
  const sampleRate = ctx.sampleRate;
  const duration = 180;
  const buffer = ctx.createBuffer(2, Math.floor(sampleRate * duration), sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  for (let i = 0; i < buffer.length; i++) {
    const t = i / sampleRate;
    const tone = Math.sin(2 * Math.PI * (220 + (Math.floor(t / 60) % 3) * 40) * t);
    const pulse = Math.sin(2 * Math.PI * 3 * t) > 0 ? 1 : 0.35;
    left[i] = tone * 0.25 * pulse;
    right[i] = tone * 0.2 * pulse;
  }

  return buffer;
}
