import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalisePrecache } from './precache';

describe('finalisePrecache', () => {
  let outDir = '';

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'doppler-precache-'));
    writeFileSync(join(outDir, 'index.html'), '<html></html>');
    writeFileSync(join(outDir, 'app.js'), 'app');
    writeFileSync(join(outDir, 'solver-worker.js'), 'worker');
    writeFileSync(join(outDir, 'precache.json'), JSON.stringify({ version: '1.2.3', urls: ['./', 'app.js'] }));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  function manifest(): { version: string; urls: string[] } {
    return JSON.parse(readFileSync(join(outDir, 'precache.json'), 'utf8')) as { version: string; urls: string[] };
  }

  it('adds bundle outputs to the list without duplicating shell entries', () => {
    finalisePrecache(outDir, ['app.js', 'solver-worker.js']);

    expect(manifest().urls).toEqual(['./', 'app.js', 'solver-worker.js']);
  });

  it('changes the version when any precached file changes', () => {
    const before = finalisePrecache(outDir, ['solver-worker.js']);
    writeFileSync(join(outDir, 'precache.json'), JSON.stringify({ version: '1.2.3', urls: ['./', 'app.js'] }));
    writeFileSync(join(outDir, 'solver-worker.js'), 'worker changed');
    const after = finalisePrecache(outDir, ['solver-worker.js']);

    expect(before).toMatch(/^1\.2\.3\+[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it('rejects a file that is not a precache manifest', () => {
    writeFileSync(join(outDir, 'precache.json'), '{}');

    expect(() => finalisePrecache(outDir, [])).toThrow('not a precache manifest');
  });
});
