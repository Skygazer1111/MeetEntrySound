import { useEffect, useMemo, useRef } from 'react';
import { wavPeaks } from '@/audio/clipProcessor';

interface Props {
  wav: ArrayBuffer;
  lengthSec: number;
  startOffsetSec: number;
  durationSec: number;
  /** 0..1 progress through the selected window, or null when not previewing. */
  progress: number | null;
  onStartChange: (startSec: number) => void;
}

const HEIGHT = 64;
const BUCKETS = 140;

/** Waveform of the stored clip. The highlighted window is what plays; click/drag to move it. */
export function Waveform({ wav, lengthSec, startOffsetSec, durationSec, progress, onStartChange }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const peaks = useMemo(() => wavPeaks(wav, BUCKETS), [wav]);
  const dragging = useRef(false);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const width = c.clientWidth;
    c.width = width * dpr;
    c.height = HEIGHT * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, width, HEIGHT);

    const winStart = (startOffsetSec / lengthSec) * width;
    const winWidth = Math.min(width - winStart, (durationSec / lengthSec) * width);

    g.fillStyle = 'rgba(139, 92, 246, 0.16)';
    g.fillRect(winStart, 0, winWidth, HEIGHT);

    const barW = width / BUCKETS;
    const gradient = g.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#8b5cf6');
    gradient.addColorStop(1, '#3b82f6');
    for (let i = 0; i < BUCKETS; i++) {
      const x = i * barW;
      const inWindow = x + barW / 2 >= winStart && x + barW / 2 <= winStart + winWidth;
      const h = Math.max(2, peaks[i] * (HEIGHT - 8));
      g.fillStyle = inWindow ? gradient : 'rgba(148, 163, 184, 0.35)';
      g.fillRect(x + 0.5, (HEIGHT - h) / 2, Math.max(1, barW - 1.5), h);
    }

    g.strokeStyle = 'rgba(167, 139, 250, 0.9)';
    g.lineWidth = 1.5;
    g.strokeRect(winStart + 0.75, 0.75, Math.max(0, winWidth - 1.5), HEIGHT - 1.5);

    if (progress !== null) {
      const x = winStart + progress * winWidth;
      g.fillStyle = '#fff';
      g.fillRect(x - 1, 0, 2, HEIGHT);
    }
  }, [peaks, lengthSec, startOffsetSec, durationSec, progress]);

  const setFromPointer = (clientX: number) => {
    const c = canvas.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const t = ((clientX - rect.left) / rect.width) * lengthSec - durationSec / 2;
    const max = Math.max(0, lengthSec - durationSec);
    onStartChange(Math.min(max, Math.max(0, Math.round(t * 10) / 10)));
  };

  const canMove = lengthSec > durationSec + 0.05;

  return (
    <canvas
      ref={canvas}
      className={`waveform${canMove ? ' movable' : ''}`}
      style={{ height: HEIGHT }}
      aria-label="Waveform of your clip. The highlighted section is what plays."
      onPointerDown={(e) => {
        if (!canMove) return;
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setFromPointer(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && setFromPointer(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    />
  );
}
