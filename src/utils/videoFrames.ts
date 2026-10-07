/** A few small frames so a video can help correct words. The soundtrack is still what gets transcribed. */
export function captureVideoFrames(file: File, count = 4): Promise<string[]> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;

    const finish = (frames: string[]) => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve(frames.slice(0, count));
    };

    const timer = window.setTimeout(() => finish([]), 8000);
    video.onerror = () => {
      window.clearTimeout(timer);
      finish([]);
    };

    video.onloadedmetadata = async () => {
      try {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const times = Array.from({ length: count }, (_, index) => {
          if (duration <= 0.2) return 0;
          return Math.min(Math.max(0, duration - 0.05), (duration * (index + 1)) / (count + 1));
        });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          window.clearTimeout(timer);
          finish([]);
          return;
        }
        const frames: string[] = [];
        for (const time of times) {
          await new Promise<void>((seekDone) => {
            const onSeek = () => {
              video.removeEventListener('seeked', onSeek);
              seekDone();
            };
            video.addEventListener('seeked', onSeek);
            video.currentTime = time;
          });
          const scale = Math.min(1, 420 / (video.videoWidth || 420));
          canvas.width = Math.max(1, Math.round((video.videoWidth || 320) * scale));
          canvas.height = Math.max(1, Math.round((video.videoHeight || 180) * scale));
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
          if (base64) frames.push(base64);
        }
        window.clearTimeout(timer);
        finish(frames);
      } catch {
        window.clearTimeout(timer);
        finish([]);
      }
    };
  });
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || (/\.(mp4|mov|mkv)$/i.test(file.name) && !file.type.startsWith('audio/'));
}
