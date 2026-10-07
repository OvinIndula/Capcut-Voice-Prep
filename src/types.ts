export interface AudioSegment {
  id: string;
  partNumber: number;
  startTime: number;
  endTime: number;
  duration: number;
  blob: Blob;
  url: string;
  filename: string;
  sizeBytes: number;
  format: 'mp3';
  sampleRate: number;
  channels: number;
  bitrateKbps: number;
  capcutReady: boolean;
}

export interface AudioFileInfo {
  name: string;
  size: number;
  type: string;
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
}

export interface SplitSettings {
  intervalValue: number;
  intervalUnit: 'minutes' | 'seconds';
  intervalSeconds: number;
  format: 'mp3' | 'wav';
  bitrateKbps: number;
  includeRemainder: boolean;
  prefix: string;
}
