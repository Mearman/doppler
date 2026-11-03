import React, { useEffect, useRef, useState } from 'react';
import { Badge, Button, Group, Text } from '@mantine/core';
import type { ComputedSingleFrame, SpectrogramFrame } from '../../src/dsp/spectrogram';
import type { DopplerObservation } from '../../src/schemas';
import * as styles from '../styles.css';

export interface ClipSpectrogramData {
  readonly minFreqHz: number;
  readonly maxFreqHz: number;
  readonly binStepHz: number;
  readonly minBin: number;
  readonly maxBin: number;
  readonly overallMedianNoiseDb: number;
  readonly frames: readonly SpectrogramFrame[];
}

export interface SpectrogramViewerProps {
  readonly liveFrames: readonly ComputedSingleFrame[];
  readonly clipSpectrogram: ClipSpectrogramData | null;
  readonly observations: readonly DopplerObservation[];
  readonly isListening: boolean;
  readonly onClearLive?: () => void;
}

export interface DbColorOptions {
  readonly minDb?: number;
  readonly maxDb?: number;
}

/**
 * Maps audio power in decibels to a high-contrast scientific Magma / Turbo heatmap RGB triplet.
 * -85 dB = dark navy/purple (ambient silence)
 * -50 dB = rich magenta (moderate signals)
 * -30 dB = electric orange/gold (strong propeller harmonics)
 * -15 dB = bright white-hot (peak CPA tone)
 */
export function dbToRgb(powerDb: number, options: DbColorOptions = {}): readonly [number, number, number] {
  const minDb = options.minDb ?? -85;
  const maxDb = options.maxDb ?? -20;
  const t = Math.max(0, Math.min(1, (powerDb - minDb) / (maxDb - minDb)));

  if (t < 0.2) {
    const s = t / 0.2;

    return [Math.round(8 + 37 * s), Math.round(8 + 9 * s), Math.round(18 + 67 * s)] as const;
  }
  if (t < 0.45) {
    const s = (t - 0.2) / 0.25;

    return [Math.round(45 + 78 * s), Math.round(17 + 12 * s), Math.round(85 + 26 * s)] as const;
  }
  if (t < 0.7) {
    const s = (t - 0.45) / 0.25;

    return [Math.round(123 + 89 * s), Math.round(29 + 49 * s), Math.round(111 - 46 * s)] as const;
  }
  if (t < 0.9) {
    const s = (t - 0.7) / 0.2;

    return [Math.round(212 + 33 * s), Math.round(78 + 80 * s), Math.round(65 - 54 * s)] as const;
  }
  const s = (t - 0.9) / 0.1;

  return [Math.round(245 + 10 * s), Math.round(158 + 97 * s), Math.round(11 + 244 * s)] as const;
}

export function SpectrogramViewer({
  liveFrames,
  clipSpectrogram,
  observations,
  isListening,
  onClearLive,
}: SpectrogramViewerProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; timeSec: number; freqHz: number } | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Determine active view mode: live mic rolling waterfall vs clip spectrogram
  const isClipActive = clipSpectrogram !== null && !isListening;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);

    if (width <= 0 || height <= 0) {
      return;
    }

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      return;
    }
    ctx.scale(dpr, dpr);

    const leftMargin = 46;
    const rightMargin = 12;
    const topMargin = 10;
    const bottomMargin = 22;

    const plotWidth = Math.max(10, width - leftMargin - rightMargin);
    const plotHeight = Math.max(10, height - topMargin - bottomMargin);

    // Dark background
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, width, height);

    const minFreq = isClipActive ? clipSpectrogram.minFreqHz : 50;
    const maxFreq = isClipActive ? clipSpectrogram.maxFreqHz : 500;
    const binStep = isClipActive ? clipSpectrogram.binStepHz : 2000 / 2048;

    const activeFrames: readonly (SpectrogramFrame | ComputedSingleFrame)[] = isClipActive
      ? clipSpectrogram.frames
      : liveFrames;

    if (activeFrames.length > 0) {
      const startTime = isClipActive ? activeFrames[0]?.timeSec ?? 0 : activeFrames[0]?.timeSec ?? 0;
      const endTime = activeFrames[activeFrames.length - 1]?.timeSec ?? startTime + 1;
      const timeSpan = Math.max(1, endTime - startTime);

      // Render Spectrogram Pixels via direct ImageData buffer
      const imgData = ctx.createImageData(plotWidth, plotHeight);
      const data = imgData.data;

      // Fill background
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 10;
        data[i + 1] = 10;
        data[i + 2] = 15;
        data[i + 3] = 255;
      }

      for (let px = 0; px < plotWidth; px += 1) {
        // Map pixel X to frame index
        const frameIdx = Math.min(activeFrames.length - 1, Math.floor((px / plotWidth) * activeFrames.length));
        const frame = activeFrames[frameIdx];
        if (frame === undefined) {
          continue;
        }

        const powerDb = frame.powerDb;
        const binCount = powerDb.length;

        for (let py = 0; py < plotHeight; py += 1) {
          // Pixel Y is inverted (top is high frequency, bottom is low frequency)
          const freqNorm = 1 - py / plotHeight;
          const targetFreq = minFreq + freqNorm * (maxFreq - minFreq);
          const binIdx = Math.max(0, Math.min(binCount - 1, Math.floor((targetFreq - minFreq) / binStep)));

          const db = powerDb[binIdx] ?? -100;
          const [r, g, b] = dbToRgb(db);

          const pixelIdx = (py * plotWidth + px) * 4;
          data[pixelIdx] = r;
          data[pixelIdx + 1] = g;
          data[pixelIdx + 2] = b;
          data[pixelIdx + 3] = 255;
        }
      }

      ctx.putImageData(imgData, leftMargin, topMargin);

      // Draw Grid & Frequency Axes
      ctx.lineWidth = 1;
      ctx.font = '10px -apple-system, BlinkMacSystemFont, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      const freqSteps = [50, 100, 150, 200, 250, 300, 350, 400, 450, 500];
      for (const f of freqSteps) {
        if (f < minFreq || f > maxFreq) {
          continue;
        }
        const y = topMargin + (1 - (f - minFreq) / (maxFreq - minFreq)) * plotHeight;

        // Special highlight for 50 Hz and 60 Hz mains hum lines
        if (f === 50 || f === 60) {
          ctx.strokeStyle = f === 50 ? 'rgba(234, 179, 8, 0.45)' : 'rgba(56, 189, 248, 0.45)';
          ctx.setLineDash([4, 4]);
        } else {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.setLineDash([2, 4]);
        }

        ctx.beginPath();
        ctx.moveTo(leftMargin, y);
        ctx.lineTo(leftMargin + plotWidth, y);
        ctx.stroke();

        ctx.fillStyle = f === 50 || f === 60 ? '#facc15' : '#888896';
        ctx.fillText(`${String(f)}Hz`, leftMargin - 5, y);
      }
      ctx.setLineDash([]);

      // Draw Time Axis Ticks
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#888896';

      const tickCount = 6;
      for (let i = 0; i <= tickCount; i += 1) {
        const x = leftMargin + (i / tickCount) * plotWidth;
        const tickSec = isClipActive ? (i / tickCount) * timeSpan : -timeSpan + (i / tickCount) * timeSpan;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.beginPath();
        ctx.moveTo(x, topMargin + plotHeight);
        ctx.lineTo(x, topMargin + plotHeight + 4);
        ctx.stroke();

        const label = isClipActive ? `${tickSec.toFixed(0)}s` : `${tickSec.toFixed(0)}s`;
        ctx.fillText(label, x, topMargin + plotHeight + 6);
      }

      // Draw Detected Doppler Ridge Overlays
      for (let oIdx = 0; oIdx < observations.length; oIdx += 1) {
        const obs = observations[oIdx];
        if (obs === undefined || obs.ridgePoints.length === 0) {
          continue;
        }

        ctx.strokeStyle = '#10b981';
        ctx.fillStyle = '#10b981';
        ctx.lineWidth = 2;
        ctx.beginPath();

        let started = false;
        for (const pt of obs.ridgePoints) {
          const ptTimeRel = pt.timeSec - startTime;
          const x = leftMargin + (ptTimeRel / timeSpan) * plotWidth;
          const y = topMargin + (1 - (pt.freqHz - minFreq) / (maxFreq - minFreq)) * plotHeight;
          const isWithin = x >= leftMargin && x <= leftMargin + plotWidth && y >= topMargin && y <= topMargin + plotHeight;
          if (!isWithin) {
            continue;
          }

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();

        // Draw CPA target marker
        const cpaRel = obs.cpaTimeSec - startTime;
        const cpaX = leftMargin + (cpaRel / timeSpan) * plotWidth;
        const cpaY = topMargin + (1 - (obs.kinematics.baseFreqHz - minFreq) / (maxFreq - minFreq)) * plotHeight;

        if (cpaX >= leftMargin && cpaX <= leftMargin + plotWidth && cpaY >= topMargin && cpaY <= topMargin + plotHeight) {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(cpaX, cpaY, 6, 0, 2 * Math.PI);
          ctx.stroke();

          ctx.fillStyle = '#38bdf8';
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`CPA #${String(oIdx + 1)} (${obs.kinematics.inferredSpeedMps.toFixed(0)}m/s)`, cpaX + 8, cpaY - 2);
        }
      }
    } else {
      // Empty placeholder when no audio has arrived yet
      ctx.fillStyle = '#555566';
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        isListening
          ? 'Listening for microphone acoustic telemetry...'
          : 'Spectrogram Idle. Click "Start Mic" or "Simulate Flyover Stream" or upload an audio file.',
        width / 2,
        height / 2,
      );
    }

    // Border around plot
    ctx.strokeStyle = '#282836';
    ctx.lineWidth = 1;
    ctx.strokeRect(leftMargin, topMargin, plotWidth, plotHeight);
  }, [liveFrames, clipSpectrogram, observations, isListening, isClipActive, isExpanded]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const leftMargin = 46;
    const rightMargin = 12;
    const topMargin = 10;
    const bottomMargin = 22;
    const plotWidth = rect.width - leftMargin - rightMargin;
    const plotHeight = rect.height - topMargin - bottomMargin;

    if (x >= leftMargin && x <= leftMargin + plotWidth && y >= topMargin && y <= topMargin + plotHeight) {
      const minFreq = isClipActive ? clipSpectrogram.minFreqHz : 50;
      const maxFreq = isClipActive ? clipSpectrogram.maxFreqHz : 500;
      const freqNorm = 1 - (y - topMargin) / plotHeight;
      const freqHz = minFreq + freqNorm * (maxFreq - minFreq);

      const timeNorm = (x - leftMargin) / plotWidth;
      // Nominal scale in seconds
      const timeSec = timeNorm * 120;

      setHoverInfo({ x, y, timeSec, freqHz });
    } else {
      setHoverInfo(null);
    }
  };

  return (
    <div
      className={styles.spectrogramSection}
      style={{ height: isExpanded ? '340px' : '220px', transition: 'height 0.2s ease' }}
    >
      <div className={styles.spectrogramHeader}>
        <Group gap="xs">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">
            Acoustic Spectrogram & Waterfall
          </Text>
          <Badge color={isListening ? 'red' : isClipActive ? 'blue' : 'gray'} size="xs" variant="filled">
            {isListening ? '● Live Microphone' : isClipActive ? 'Audio Clip Analysis' : 'Idle'}
          </Badge>
          <Badge color="dark" size="xs" variant="outline">
            50–500 Hz (0.98 Hz/bin)
          </Badge>
          {observations.length > 0 && (
            <Badge color="teal" size="xs" variant="light">
              {String(observations.length)} Flyover Track(s) Detected
            </Badge>
          )}
        </Group>

        <Group gap="xs">
          {hoverInfo !== null && (
            <Text size="xs" c="cyan.4" ff="monospace">
              {hoverInfo.freqHz.toFixed(1)} Hz
            </Text>
          )}
          {isListening && onClearLive !== undefined && (
            <Button size="compact-xs" variant="subtle" color="gray" onClick={onClearLive}>
              Clear
            </Button>
          )}
          <Button
            size="compact-xs"
            variant="light"
            color="gray"
            onClick={() => {
              setIsExpanded((prev) => !prev);
            }}
          >
            {isExpanded ? 'Collapse' : 'Expand'}
          </Button>
        </Group>
      </div>

      <div ref={containerRef} className={styles.canvasWrapper}>
        <canvas
          ref={canvasRef}
          className={styles.fullCanvas}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => {
            setHoverInfo(null);
          }}
        />
      </div>
    </div>
  );
}
