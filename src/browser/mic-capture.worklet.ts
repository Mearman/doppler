/**
 * Audio worklet module that batches the microphone's 128-frame render quanta into fixed-size chunks and posts each chunk to the main thread, which receives it as a `Float32Array` message.
 * It runs in the `AudioWorkletGlobalScope`, which the DOM library does not describe, so the two globals it uses are declared here. Nothing is exported: the module's only effect is registering the processor, and the main thread loads it with `audioWorklet.addModule`.
 */
import { MIC_CAPTURE_PROCESSOR_NAME } from './mic-capture-protocol';

/** The base class of an audio worklet processor, provided by the worklet scope. */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

/** Registers a processor class under a name that `AudioWorkletNode` can construct, provided by the worklet scope. */
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

/** Samples per posted chunk: about 85 ms at 48 kHz, a multiple of the 128-frame render quantum. */
const CAPTURE_CHUNK_FRAMES = 4096;

class MicCaptureProcessor extends AudioWorkletProcessor {
  private chunk = new Float32Array(CAPTURE_CHUNK_FRAMES);

  private filled = 0;

  /**
   * Appends one render quantum of the first input's first channel to the current chunk and posts the chunk, transferring its buffer, whenever it is full.
   * @param inputs - The node's inputs; empty while nothing is connected.
   * @returns True, so the processor stays alive for as long as the node does.
   */
  process(inputs: readonly (readonly Float32Array[])[]): boolean {
    const channel = inputs[0]?.[0];
    if (channel === undefined) {
      return true;
    }
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.chunk.length - this.filled);
      this.chunk.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(CAPTURE_CHUNK_FRAMES);
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor(MIC_CAPTURE_PROCESSOR_NAME, MicCaptureProcessor);
