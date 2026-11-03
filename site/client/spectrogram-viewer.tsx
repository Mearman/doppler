import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@mantine/core';
import type { ComputedSingleFrame, SpectrogramFrame } from '../../src/dsp/spectrogram';
import type { DopplerObservation } from '../../src/schemas';
import * as styles from '../styles.css';
import { binIndexAt, formatElapsed, frameIndexAt, niceTicks } from './spectrogram-geometry';

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

/** Power, in decibels, drawn as the darkest colour: the ambient silence of a quiet room. */
export const DB_FLOOR = -85;

/** Power, in decibels, drawn as the brightest colour: the peak of a close propeller tone. */
export const DB_CEILING = -20;

/**
 * Maps audio power in decibels to a Magma-like heatmap colour. The floor is dark navy, a moderate signal is magenta, a strong harmonic is orange and the ceiling is white-hot.
 * @param powerDb - The power in decibels.
 * @param options - Overrides for the floor and ceiling of the scale.
 * @returns The red, green and blue components, each 0 to 255.
 */
export function dbToRgb(powerDb: number, options: DbColorOptions = {}): readonly [number, number, number] {
  const minDb = options.minDb ?? DB_FLOOR;
  const maxDb = options.maxDb ?? DB_CEILING;
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

/** Number of colour stops sampled to draw the legend, enough that the gradient shows no banding. */
const LEGEND_STOPS = 12;

/** The legend's CSS gradient, sampled from the same function that colours the plot so the two cannot disagree. */
const LEGEND_GRADIENT = `linear-gradient(to right, ${Array.from({ length: LEGEND_STOPS + 1 }, (_, index) => {
  const [r, g, b] = dbToRgb(DB_FLOOR + (index / LEGEND_STOPS) * (DB_CEILING - DB_FLOOR));

  return `rgb(${String(r)} ${String(g)} ${String(b)})`;
}).join(', ')})`;

/** Plot margins in CSS pixels, shared by drawing and pointer hit-testing so the two cannot drift. */
const LEFT_MARGIN = 44;
const RIGHT_MARGIN = 10;
const TOP_MARGIN = 8;
const BOTTOM_MARGIN = 22;

/** Mains frequencies marked on the frequency axis, in hertz, because a hum at either reveals the grid. */
const MAINS_FREQS_HZ = [50, 60] as const;

/** Pixels either side of a mains label within which an ordinary tick label would overlap it and is left out. */
const LABEL_CLEARANCE_PX = 12;

/** Target counts for axis ticks; the nice-number step lands near them. */
const FREQUENCY_TICK_TARGET = 8;
const TIME_TICK_TARGET = 6;

const BACKGROUND = '#0a0a0f';
const AXIS_TEXT = '#a3a3b8';
const RIDGE_COLOUR = '#10b981';
const CPA_COLOUR = '#38bdf8';

/** What the plot shows, resolved once from either the live waterfall or the analysed clip. */
interface PlotView {
  readonly frames: readonly (SpectrogramFrame | ComputedSingleFrame)[];
  readonly minFreq: number;
  readonly maxFreq: number;
  readonly binStep: number;
  readonly startTime: number;
  readonly timeSpan: number;
  readonly isClip: boolean;
}

/** The reading under the pointer. */
interface Readout {
  readonly x: number;
  readonly y: number;
  readonly timeLabel: string;
  readonly freqHz: number;
  readonly powerDb: number | undefined;
}

/**
 * Resolves what to plot, or null while no audio has arrived. Live frames carry their own band, so the frequency range follows the capture rather than a literal.
 */
function resolveView(clip: ClipSpectrogramData | null, liveFrames: readonly ComputedSingleFrame[], isListening: boolean): PlotView | null {
  if (clip !== null && !isListening && clip.frames.length > 0) {
    const first = clip.frames[0];
    const last = clip.frames[clip.frames.length - 1];
    if (first === undefined || last === undefined) {
      return null;
    }

    return { frames: clip.frames, minFreq: clip.minFreqHz, maxFreq: clip.maxFreqHz, binStep: clip.binStepHz, startTime: first.timeSec, timeSpan: Math.max(1, last.timeSec - first.timeSec), isClip: true };
  }
  const first = liveFrames[0];
  const last = liveFrames[liveFrames.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }

  return {
    frames: liveFrames,
    minFreq: first.minBin * first.binStepHz,
    maxFreq: first.maxBin * first.binStepHz,
    binStep: first.binStepHz,
    startTime: first.timeSec,
    timeSpan: Math.max(1, last.timeSec - first.timeSec),
    isClip: false,
  };
}

/**
 * The spectrogram of an analysed clip, or the rolling waterfall of the live microphone, with detected flyover ridges on top. The empty state is ordinary text over the canvas so that it wraps at any width and is read by assistive technology.
 * @param props - The frames to draw (live or clip), the observations to overlay and the live-mode controls.
 * @returns The viewer with its single-row header.
 */
export function SpectrogramViewer(props: Readonly<SpectrogramViewerProps>): React.JSX.Element {
  const { liveFrames, clipSpectrogram, observations, isListening, onClearLive } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [readout, setReadout] = useState<Readout | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  // The container's size in CSS pixels, kept current so that a rotation, a window resize or the layout changing redraws the canvas at its new size instead of stretching the old one.
  const [size, setSize] = useState({ width: 0, height: 0 });

  const view = useMemo(() => resolveView(clipSpectrogram, liveFrames, isListening), [clipSpectrogram, liveFrames, isListening]);
  // Observations from an earlier clip stay in the session, so only those whose closest approach falls inside the plotted time are counted and drawn.
  const visibleObservations = useMemo(
    () => (view === null ? [] : observations.filter((observation) => observation.cpaTimeSec >= view.startTime && observation.cpaTimeSec <= view.startTime + view.timeSpan)),
    [view, observations],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const { width, height } = size;
    if (canvas === null || width <= 0 || height <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      return;
    }
    ctx.scale(dpr, dpr);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);

    const plotWidth = Math.max(10, width - LEFT_MARGIN - RIGHT_MARGIN);
    const plotHeight = Math.max(10, height - TOP_MARGIN - BOTTOM_MARGIN);
    ctx.strokeStyle = '#282836';
    ctx.lineWidth = 1;
    ctx.strokeRect(LEFT_MARGIN, TOP_MARGIN, plotWidth, plotHeight);
    if (view === null) {
      return;
    }

    const { frames, minFreq, maxFreq, binStep, startTime, timeSpan, isClip } = view;
    const freqToY = (freq: number): number => TOP_MARGIN + (1 - (freq - minFreq) / (maxFreq - minFreq)) * plotHeight;
    const timeToX = (timeSec: number): number => LEFT_MARGIN + ((timeSec - startTime) / timeSpan) * plotWidth;

    const image = ctx.createImageData(plotWidth, plotHeight);
    const data = image.data;
    for (let px = 0; px < plotWidth; px += 1) {
      const frame = frames[frameIndexAt(px / plotWidth, frames.length)];
      if (frame === undefined) {
        continue;
      }
      for (let py = 0; py < plotHeight; py += 1) {
        const freq = minFreq + (1 - py / plotHeight) * (maxFreq - minFreq);
        const [r, g, b] = dbToRgb(frame.powerDb[binIndexAt(freq, minFreq, binStep, frame.powerDb.length)] ?? -100);
        const index = (py * plotWidth + px) * 4;
        data[index] = r;
        data[index + 1] = g;
        data[index + 2] = b;
        data[index + 3] = 255;
      }
    }
    // putImageData ignores the context transform, so the pixels go through an offscreen canvas and drawImage, which applies the devicePixelRatio scale like every other drawing call here.
    const layer = document.createElement('canvas');
    layer.width = plotWidth;
    layer.height = plotHeight;
    layer.getContext('2d')?.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer, LEFT_MARGIN, TOP_MARGIN);
    ctx.imageSmoothingEnabled = true;

    // Frequency axis: round ticks, with the mains frequencies marked and their labels kept clear of the ticks.
    ctx.font = '10px -apple-system, BlinkMacSystemFont, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const mains = MAINS_FREQS_HZ.filter((freq) => freq >= minFreq && freq <= maxFreq);
    const mainsY = mains.map((freq) => freqToY(freq));
    for (const freq of niceTicks(minFreq, maxFreq, FREQUENCY_TICK_TARGET)) {
      const y = freqToY(freq);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(LEFT_MARGIN, y);
      ctx.lineTo(LEFT_MARGIN + plotWidth, y);
      ctx.stroke();
      if (!mainsY.some((mainY) => Math.abs(mainY - y) < LABEL_CLEARANCE_PX)) {
        ctx.fillStyle = AXIS_TEXT;
        ctx.fillText(`${String(freq)} Hz`, LEFT_MARGIN - 5, y);
      }
    }
    mains.forEach((freq, index) => {
      const y = mainsY[index] ?? 0;
      ctx.strokeStyle = freq === 50 ? 'rgba(234, 179, 8, 0.5)' : 'rgba(56, 189, 248, 0.5)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(LEFT_MARGIN, y);
      ctx.lineTo(LEFT_MARGIN + plotWidth, y);
      ctx.stroke();
      ctx.fillStyle = freq === 50 ? '#facc15' : '#7dd3fc';
      ctx.fillText(`${String(freq)} Hz`, LEFT_MARGIN - 5, y);
    });
    ctx.setLineDash([]);

    // Time axis: seconds from the start of a clip, or seconds before now for the live waterfall.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = AXIS_TEXT;
    for (const tick of niceTicks(0, timeSpan, TIME_TICK_TARGET)) {
      const x = LEFT_MARGIN + (tick / timeSpan) * plotWidth;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.beginPath();
      ctx.moveTo(x, TOP_MARGIN + plotHeight);
      ctx.lineTo(x, TOP_MARGIN + plotHeight + 4);
      ctx.stroke();
      ctx.fillText(formatElapsed(isClip ? tick : tick - timeSpan), x, TOP_MARGIN + plotHeight + 6);
    }

    // Detected flyovers: the tracked ridge and the closest point of approach.
    visibleObservations.forEach((observation, index) => {
      ctx.strokeStyle = RIDGE_COLOUR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (const point of observation.ridgePoints) {
        const x = timeToX(point.timeSec);
        const y = freqToY(point.freqHz);
        if (x < LEFT_MARGIN || x > LEFT_MARGIN + plotWidth || y < TOP_MARGIN || y > TOP_MARGIN + plotHeight) {
          continue;
        }
        if (started) {
          ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
          started = true;
        }
      }
      ctx.stroke();

      const cpaX = timeToX(observation.cpaTimeSec);
      const cpaY = freqToY(observation.kinematics.baseFreqHz);
      if (cpaY >= TOP_MARGIN && cpaY <= TOP_MARGIN + plotHeight) {
        ctx.strokeStyle = CPA_COLOUR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cpaX, cpaY, 6, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillStyle = CPA_COLOUR;
        ctx.font = 'bold 10px monospace';
        // The label sits on the side of the marker with room for it, so it is never cut off at the edge.
        const roomRight = LEFT_MARGIN + plotWidth - cpaX > plotWidth / 3;
        ctx.textAlign = roomRight ? 'left' : 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`#${String(index + 1)} ${observation.kinematics.inferredSpeedMps.toFixed(0)} m/s`, cpaX + (roomRight ? 9 : -9), cpaY - 3);
      }
    });
  }, [view, visibleObservations, size]);

  const handlePointer = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (canvas === null || view === null) {
      setReadout(null);

      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const plotWidth = rect.width - LEFT_MARGIN - RIGHT_MARGIN;
    const plotHeight = rect.height - TOP_MARGIN - BOTTOM_MARGIN;
    if (x < LEFT_MARGIN || x > LEFT_MARGIN + plotWidth || y < TOP_MARGIN || y > TOP_MARGIN + plotHeight) {
      setReadout(null);

      return;
    }
    const freqHz = view.minFreq + (1 - (y - TOP_MARGIN) / plotHeight) * (view.maxFreq - view.minFreq);
    const frame = view.frames[frameIndexAt((x - LEFT_MARGIN) / plotWidth, view.frames.length)];
    const timeSec = frame === undefined ? view.startTime : frame.timeSec - view.startTime;
    setReadout({
      x,
      y,
      freqHz,
      timeLabel: formatElapsed(view.isClip ? timeSec : timeSec - view.timeSpan),
      powerDb: frame?.powerDb[binIndexAt(freqHz, view.minFreq, view.binStep, frame.powerDb.length)],
    });
  };

  const mode = isListening ? 'Live microphone' : view?.isClip === true ? 'Clip analysis' : 'Idle';
  const description =
    view === null
      ? 'Spectrogram with no audio yet.'
      : `Spectrogram of ${view.isClip ? 'an analysed clip' : 'the live microphone'}, ${view.minFreq.toFixed(0)} to ${view.maxFreq.toFixed(0)} hertz over ${formatElapsed(view.timeSpan)}, with ${String(visibleObservations.length)} flyover${visibleObservations.length === 1 ? '' : 's'} detected.`;

  return (
    <section className={styles.spectrogramSection} data-expanded={isExpanded} aria-label="Spectrogram">
      <div className={styles.spectrogramHeader}>
        <span className={styles.modeTag} data-mode={isListening ? 'live' : view?.isClip === true ? 'clip' : 'idle'}>{mode}</span>
        <span className={styles.readout} aria-live="off">
          {readout === null
            ? view !== null && visibleObservations.length > 0
              ? `${String(visibleObservations.length)} flyover${visibleObservations.length === 1 ? '' : 's'} detected`
              : ''
            : `${readout.timeLabel} · ${readout.freqHz.toFixed(1)} Hz${readout.powerDb === undefined ? '' : ` · ${readout.powerDb.toFixed(0)} dB`}`}
        </span>
        <span className={styles.legend} aria-hidden="true">
          <span className={styles.legendBar} style={{ background: LEGEND_GRADIENT }} />
          <span className={styles.legendLabels}>
            <span>{`${String(DB_FLOOR)} dB`}</span>
            <span>{`${String(DB_CEILING)} dB`}</span>
          </span>
        </span>
        {isListening && onClearLive !== undefined && (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={onClearLive}>
            Clear
          </Button>
        )}
        <Button
            className={styles.expandButton}
            size="compact-xs"
            variant="light"
            color="gray"
            aria-pressed={isExpanded}
            onClick={() => {
              setIsExpanded((previous) => !previous);
            }}
          >
            {isExpanded ? 'Collapse' : 'Expand'}
          </Button>
      </div>

      <div ref={containerRef} className={styles.canvasWrapper}>
        <canvas
          ref={canvasRef}
          className={styles.fullCanvas}
          role="img"
          aria-label={description}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => {
            setReadout(null);
          }}
        />
        {readout !== null && (
          <>
            <span className={styles.crosshairV} style={{ left: readout.x }} aria-hidden="true" />
            <span className={styles.crosshairH} style={{ top: readout.y }} aria-hidden="true" />
          </>
        )}
        {view === null && (
          <p className={styles.canvasEmpty} role="status">
            {isListening ? 'Listening. The waterfall appears as audio arrives.' : 'No audio yet. Start the microphone, simulate a flyover or choose a file.'}
          </p>
        )}
      </div>
    </section>
  );
}
