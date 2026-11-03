import { decimateAudioStream } from '../dsp/decimate';
import { extractDopplerObservations } from '../dsp/ridge-tracker';
import {
  computeDopplerSpectrogram,
  computeSingleSpectrogramFrame,
  type ComputedSingleFrame,
  type DopplerSpectrogram,
} from '../dsp/spectrogram';
import type { DopplerObservation } from '../schemas';
import { MS_PER_SECOND } from '../time';
import { MIC_CAPTURE_PROCESSOR_NAME } from './mic-capture-protocol';

/** Sample rate the captured audio is decimated to before analysis. The aircraft Doppler band lies far below its Nyquist frequency of 1,000 Hz. */
const ANALYSIS_RATE_HZ = 2000;

/** Capture rate assumed until the `AudioContext` reports the real one, in Hz. */
const DEFAULT_CAPTURE_RATE_HZ = 48000;

/** Length of the rolling analysis window, in seconds. */
const ROLLING_WINDOW_SEC = 60;

/** Samples of the rolling window at the analysis rate. */
const MAX_WINDOW_SAMPLES = ROLLING_WINDOW_SEC * ANALYSIS_RATE_HZ;

/** FFT length of both the live waterfall frame and the ridge-tracking spectrogram: a power of two giving about 1 Hz of resolution at the analysis rate. */
const FFT_SIZE = 2048;

/** Passband of the live waterfall frame, in Hz. */
const LIVE_MIN_FREQ_HZ = 50;
const LIVE_MAX_FREQ_HZ = 500;

/** Analysis window that must be buffered before ridges are extracted: 4 s of audio at the analysis rate. */
const RIDGE_MIN_WINDOW_SAMPLES = 8000;

/** Hop of the ridge-tracking spectrogram, in samples at the analysis rate. */
const SPECTROGRAM_HOP_SAMPLES = 500;

/** Smallest signal-to-noise ratio, in dB, at which a spectrogram ridge counts as an observation. */
const MIN_RIDGE_SNR_DB = 6;

/** Location of the audio worklet module, which the site build emits next to the bundle that contains this code. */
const WORKLET_MODULE_URL = new URL('./mic-capture.worklet.js', import.meta.url);

/**
 * Event callbacks emitted during continuous or episodic microphone listening.
 */
export interface MicMonitorCallbacks {
  readonly onSpectrogramFrame?: (frame: Readonly<ComputedSingleFrame>) => void;
  readonly onNoiseUpdate?: (noiseFloorDb: number, noisePolluted: boolean) => void;
  readonly onObservationDetected?: (observation: Readonly<DopplerObservation>) => void;
  readonly onError?: (error: Readonly<Error>) => void;
}

/**
 * Live audio monitor that captures raw microphone audio without WebRTC voice filters,
 * applies streaming 24x decimation to 2,000 Hz, tracks in-band noise pollution, and extracts
 * aircraft Doppler S-curves in real time.
 * Capture runs in an audio worklet loaded from `mic-capture.worklet.js`, which must be served next to the module that contains this class.
 */
export class MicMonitor {
  private audioCtx: AudioContext | null = null;

  private mediaStream: MediaStream | null = null;

  private captureNode: AudioWorkletNode | null = null;

  private sampleBuffer: Float32Array = new Float32Array(0);

  private isListening = false;

  private isPaused = false;

  private episodeId = '';

  private episodeStartEpochSec = 0;

  private actualSampleRateHz = DEFAULT_CAPTURE_RATE_HZ;

  private readonly callbacks: MicMonitorCallbacks;

  constructor(callbacks: MicMonitorCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * Starts microphone capture with all browser noise suppression, echo cancellation, and AGC explicitly disabled.
   * @param episodeId - Identifier for the active listening episode.
   */
  public async start(episodeId: string): Promise<void> {
    if (this.isListening) {
      return;
    }
    this.episodeId = episodeId;
    this.episodeStartEpochSec = Math.floor(Date.now() / MS_PER_SECOND);
    this.isListening = true;
    this.isPaused = false;
    this.sampleBuffer = new Float32Array(0);

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      this.audioCtx = new AudioContext();
      this.actualSampleRateHz = this.audioCtx.sampleRate;
      const source = this.audioCtx.createMediaStreamSource(this.mediaStream);

      await this.audioCtx.audioWorklet.addModule(WORKLET_MODULE_URL);
      this.captureNode = new AudioWorkletNode(this.audioCtx, MIC_CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      this.captureNode.port.onmessage = (event: MessageEvent<unknown>) => {
        if (!this.isListening || this.isPaused || !(event.data instanceof Float32Array)) {
          return;
        }
        this.handleRawAudioChunk(event.data);
      };

      // The node outputs silence; it is connected to the destination because the graph only pulls nodes that reach it.
      source.connect(this.captureNode);
      this.captureNode.connect(this.audioCtx.destination);
    } catch (err) {
      this.stop();
      const errorObj = err instanceof Error ? err : new Error(String(err));
      this.callbacks.onError?.(errorObj);
      throw errorObj;
    }
  }

  /**
   * Temporarily pauses listening (e.g. user pauses or moves through a high-noise area).
   */
  public pause(): void {
    this.isPaused = true;
  }

  /**
   * Resumes listening from a paused state.
   */
  public resume(): void {
    this.isPaused = false;
  }

  /**
   * Stops microphone capture, releases the hardware audio stream, and flushes remaining buffer.
   */
  public stop(): void {
    this.isListening = false;
    this.isPaused = false;

    if (this.captureNode !== null) {
      this.captureNode.port.onmessage = null;
      this.captureNode.disconnect();
      this.captureNode = null;
    }
    if (this.mediaStream !== null) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    if (this.audioCtx !== null) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.sampleBuffer = new Float32Array(0);
  }

  /**
   * Processes a raw 48 kHz chunk, decimates it to 2,000 Hz, appends it to the rolling window, and checks for Doppler ridges.
   */
  private handleRawAudioChunk(rawChunk: Float32Array): void {
    const decimated = decimateAudioStream(rawChunk, this.actualSampleRateHz, ANALYSIS_RATE_HZ);
    const newBuf = new Float32Array(this.sampleBuffer.length + decimated.samples.length);
    newBuf.set(this.sampleBuffer, 0);
    newBuf.set(decimated.samples, this.sampleBuffer.length);
    this.sampleBuffer = newBuf;

    // Maintain the rolling window at the analysis rate.
    if (this.sampleBuffer.length > MAX_WINDOW_SAMPLES) {
      this.sampleBuffer = this.sampleBuffer.slice(this.sampleBuffer.length - MAX_WINDOW_SAMPLES);
    }

    // Emit live single-frame STFT for real-time waterfall display
    if (this.sampleBuffer.length >= FFT_SIZE) {
      const windowSlice = this.sampleBuffer.subarray(this.sampleBuffer.length - FFT_SIZE);
      const frameTimeSec = this.episodeStartEpochSec + this.sampleBuffer.length / ANALYSIS_RATE_HZ;
      const liveFrame = computeSingleSpectrogramFrame(windowSlice, {
        sampleRateHz: ANALYSIS_RATE_HZ,
        fftSize: FFT_SIZE,
        minFreqHz: LIVE_MIN_FREQ_HZ,
        maxFreqHz: LIVE_MAX_FREQ_HZ,
        timeSec: frameTimeSec,
      });

      this.callbacks.onSpectrogramFrame?.(liveFrame);
      this.callbacks.onNoiseUpdate?.(liveFrame.medianNoiseFloorDb, liveFrame.noisePolluted);
    }

    // Once enough audio is buffered, compute the spectrogram and extract candidate ridges.
    if (this.sampleBuffer.length >= RIDGE_MIN_WINDOW_SAMPLES) {
      const spectrogram: DopplerSpectrogram = computeDopplerSpectrogram(this.sampleBuffer, {
        sampleRateHz: ANALYSIS_RATE_HZ,
        startTimeSec: this.episodeStartEpochSec,
        fftSize: FFT_SIZE,
        hopSamples: SPECTROGRAM_HOP_SAMPLES,
      });

      const observations = extractDopplerObservations(spectrogram, {
        episodeId: this.episodeId,
        minSnrDb: MIN_RIDGE_SNR_DB,
      });

      for (const obs of observations) {
        this.callbacks.onObservationDetected?.(obs);
      }
    }
  }
}
