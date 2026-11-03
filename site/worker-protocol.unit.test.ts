import { describe, expect, it } from 'vitest';
import { ANALYSIS_STAGES, WorkerReplySchema, WorkerRequestSchema } from './client/worker-protocol';

const WAV_HEADER_BYTES = 44;
const START_EPOCH_SEC = 1788900000;

describe('worker protocol', () => {
  it('accepts a WAV file sent as bytes for the worker to decode', () => {
    const request = { id: 'file_1', type: 'process_wav', payload: { bytes: new ArrayBuffer(WAV_HEADER_BYTES), startEpochSec: START_EPOCH_SEC, episodeId: 'clip.wav' } };

    expect(WorkerRequestSchema.safeParse(request).success).toBe(true);
  });

  it('rejects a WAV request whose bytes are not an ArrayBuffer', () => {
    const request = { id: 'file_1', type: 'process_wav', payload: { bytes: 'not bytes', startEpochSec: START_EPOCH_SEC, episodeId: 'clip.wav' } };

    expect(WorkerRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each(ANALYSIS_STAGES)('accepts a progress reply for the %s stage', (stage) => {
    expect(WorkerReplySchema.safeParse({ id: 'file_1', success: true, type: 'progress', stage }).success).toBe(true);
  });

  it('rejects a progress reply naming a stage the worker does not have', () => {
    expect(WorkerReplySchema.safeParse({ id: 'file_1', success: true, type: 'progress', stage: 'rendering' }).success).toBe(false);
  });
});
