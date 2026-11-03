import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computePrecache } from './precache';

describe('computePrecache', () => {
  let outDir = '';

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'doppler-precache-'));
    writeFileSync(join(outDir, 'index.html'), '<html></html>');
    writeFileSync(join(outDir, 'app.js'), 'app');
    writeFileSync(join(outDir, 'solver-worker.js'), 'worker');
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('lists each URL once, in first-seen order', () => {
    const { urls } = computePrecache(outDir, '1.2.3', ['./', 'app.js', 'solver-worker.js', 'app.js']);

    expect(urls).toEqual(['./', 'app.js', 'solver-worker.js']);
  });

  it('changes the version when any precached file changes', () => {
    const urls = ['./', 'app.js', 'solver-worker.js'];
    const before = computePrecache(outDir, '1.2.3', urls).version;
    writeFileSync(join(outDir, 'solver-worker.js'), 'worker changed');
    const after = computePrecache(outDir, '1.2.3', urls).version;

    expect(before).toMatch(/^1\.2\.3\+[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it('keeps the version when nothing changes', () => {
    const urls = ['./', 'app.js'];

    expect(computePrecache(outDir, '1.2.3', urls)).toEqual(computePrecache(outDir, '1.2.3', urls));
  });
});
