import { describe, expect, it } from 'vitest';
import { MAX_JSON_CHARS, fitsInBrowser, formatBytes, parseDatasetFiles } from './flight-data-sources';

describe('parseDatasetFiles', () => {
  it('keeps only dataset files, newest first', () => {
    const files = parseDatasetFiles([
      { type: 'file', path: '.gitattributes', size: 10 },
      { type: 'file', path: '2025-12-29.dataset.json', size: 20 },
      { type: 'directory', path: 'archive.dataset.json', size: 0 },
      { type: 'file', path: '2025-12-30.dataset.json', size: 30 },
      { type: 'file', path: 'README.md', size: 5 },
    ]);

    expect(files).toEqual([
      { path: '2025-12-30.dataset.json', sizeBytes: 30 },
      { path: '2025-12-29.dataset.json', sizeBytes: 20 },
    ]);
  });

  it('rejects a listing of another shape', () => {
    expect(() => parseDatasetFiles({ error: 'not found' })).toThrow();
  });
});

describe('formatBytes', () => {
  it('switches from megabytes to gigabytes at a gigabyte', () => {
    expect(formatBytes(2_564)).toBe('0.0 MB');
    expect(formatBytes(150_000_000)).toBe('150.0 MB');
    expect(formatBytes(1_849_124_275)).toBe('1.8 GB');
  });
});

describe('fitsInBrowser', () => {
  it('accepts a file up to the string limit and refuses one over it', () => {
    expect(fitsInBrowser(MAX_JSON_CHARS)).toBe(true);
    expect(fitsInBrowser(MAX_JSON_CHARS + 1)).toBe(false);
  });
});
