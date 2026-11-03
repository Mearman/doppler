import { decimateAudioStream } from '../dsp/decimate';
import { extractDopplerObservations } from '../dsp/ridge-tracker';
import { computeDopplerSpectrogram, type DopplerSpectrogram, type SpectrogramFrame } from '../dsp/spectrogram';
import type { DopplerObservation } from '../schemas';

/**
 * Event callbacks emitted during continuous or episodic microphone listening.
 */
export interface MicMonitorCallbacks {
  readonly onSpectrogramFrame?: (frame: Readonly<SpectrogramFrame>) => void;
  readonly onNoiseUpdate?: (noiseFloorDb: number, noisePolluted: boolean) => void;
  readonly onObservationDetected?: (observation: Readonly<DopplerObservation>) => void;
  readonly onError?: (error: Readonly<Error>) => void;
}

/**
 * Live audio monitor that captures raw microphone audio without WebRTC voice filters,
 * applies streaming 24x decimation to 2,000 Hz, tracks in-band noise pollution, and extracts
 * aircraft Doppler S-curves in real time.
 */
export class MicMonitor {
  private audioCtx: AudioContext | null = null;

  private mediaStream: MediaStream | null = null;

  private processorNode: ScriptProcessorNode | null = null;

  private sampleBuffer: Float32Array = new Float32Array(0);

  private isListening = false;

  private isPaused = false;

  private episodeId = '';

  private episodeStartEpochSec = 0;

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
    this.episodeStartEpochSec = Math.floor(Date.now() / 1000);
    this.isListening = true;
    this.isPaused = false;
    this.sampleBuffer = new Float32Array(0);

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 48000,
        },
      });

      this.audioCtx = new AudioContext({ sampleRate: 48000 });
      const source = this.audioCtx.createMediaStreamSource(this.mediaStream);

      // 4096-sample chunks at 48kHz = ~85ms buffer
      this.processorNode = this.audioCtx.createScriptProcessor(4096, 1, 1);
      this.processorNode.onaudioprocess = (e) => {
        if (!this.isListening || this.isPaused) {
          return;
        }
        const inputChannel = e.inputBuffer.getChannelData(0);
        this.handleRawAudioChunk(inputChannel);
      };

      source.connect(this.processorNode);
      this.processorNode.connect(this.audioCtx.destination);
    } catch (err) {
      this.isListening = false;
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

    if (this.processorNode !== null) {
      this.processorNode.disconnect();
      this.processorNode = null;
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
    const decimated = decimateAudioStream(rawChunk, 48000, 2000);
    const newBuf = new Float32Array(this.sampleBuffer.length + decimated.samples.length);
    newBuf.set(this.sampleBuffer, 0);
    newBuf.set(decimated.samples, this.sampleBuffer.length);
    this.sampleBuffer = newBuf;

    // Maintain a rolling 60-second window at 2,000 Hz (120,000 samples)
    const maxWindowSamples = 120000;
    if (this.sampleBuffer.length > maxWindowSamples) {
      this.sampleBuffer = this.sampleBuffer.slice(this.sampleBuffer.length - maxWindowSamples);
    }

    // Every ~2 seconds of audio, compute spectrogram and extract candidate ridges
    if (this.sampleBuffer.length >= 8000) {
      const spectrogram: DopplerSpectrogram = computeDopplerSpectrogram(this.sampleBuffer, {
        sampleRateHz: 2000,
        startTimeSec: this.episodeStartEpochSec,
        fftSize: 2048,
        hopSamples: 500,
      });

      const lastFrame = spectrogram.frames[spectrogram.frames.length - 1];
      if (lastFrame !== undefined) {
        this.callbacks.onSpectrogramFrame?.(lastFrame);
        this.callbacks.onNoiseUpdate?.(lastFrame.medianNoiseFloorDb, lastFrame.noisePolluted);
      }

      const observations = extractDopplerObservations(spectrogram, {
        episodeId: this.episodeId,
        minSnrDb: 6.0,
      });

      for (const obs of observations) {
        this.callbacks.onObservationDetected?.(obs);
      }
    }
  }
}
