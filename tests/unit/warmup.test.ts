/**
 * P5.1 — `xray warmup` command tests. Uses the `_warmupDeps` test seam to
 * stub the embedder / browser / db so we never trigger a real ~23MB model
 * download or Chromium launch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _warmupDeps, runWarmup, warmupCommand } from '../../src/cli/commands/warmup.ts';

const originalDeps = { ..._warmupDeps };

beforeEach(() => {
  _warmupDeps.getEmbedder = vi.fn().mockResolvedValue(() => ({ data: new Float32Array(384) }));
  _warmupDeps.getBrowser = vi.fn().mockResolvedValue({ isConnected: () => true });
  _warmupDeps.closeBrowser = vi.fn().mockResolvedValue(undefined);
  _warmupDeps.openDb = vi.fn().mockResolvedValue({});
  _warmupDeps.closeDb = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  _warmupDeps.getEmbedder = originalDeps.getEmbedder;
  _warmupDeps.getBrowser = originalDeps.getBrowser;
  _warmupDeps.closeBrowser = originalDeps.closeBrowser;
  _warmupDeps.openDb = originalDeps.openDb;
  _warmupDeps.closeDb = originalDeps.closeDb;
  vi.restoreAllMocks();
});

describe('runWarmup', () => {
  it('runs all three steps and returns ready=true for each', async () => {
    const result = await runWarmup();
    expect(result.embedding.ready).toBe(true);
    expect(result.playwright.ready).toBe(true);
    expect(result.sqlite.ready).toBe(true);
    expect(result.embedding.error).toBeUndefined();
    expect(_warmupDeps.getEmbedder).toHaveBeenCalledOnce();
    expect(_warmupDeps.getBrowser).toHaveBeenCalledOnce();
    expect(_warmupDeps.openDb).toHaveBeenCalledOnce();
  });

  it('closes the browser after warmup (no leaked handle)', async () => {
    await runWarmup();
    expect(_warmupDeps.closeBrowser).toHaveBeenCalledOnce();
  });

  it('continues steps 2 and 3 even when embedder fails (best-effort)', async () => {
    _warmupDeps.getEmbedder = vi.fn().mockRejectedValue(new Error('model boom'));
    const result = await runWarmup();
    expect(result.embedding.ready).toBe(false);
    expect(result.embedding.error).toContain('model boom');
    // Browser + sqlite still attempted.
    expect(result.playwright.ready).toBe(true);
    expect(result.sqlite.ready).toBe(true);
    expect(_warmupDeps.getBrowser).toHaveBeenCalledOnce();
    expect(_warmupDeps.openDb).toHaveBeenCalledOnce();
  });

  it('reports playwright failure but continues to sqlite step', async () => {
    _warmupDeps.getBrowser = vi.fn().mockRejectedValue(new Error('chromium missing'));
    const result = await runWarmup();
    expect(result.embedding.ready).toBe(true);
    expect(result.playwright.ready).toBe(false);
    expect(result.playwright.error).toContain('chromium missing');
    expect(result.sqlite.ready).toBe(true);
    // closeBrowser should NOT have been called since getBrowser threw.
    expect(_warmupDeps.closeBrowser).not.toHaveBeenCalled();
  });

  it('timing fields are non-negative finite numbers', async () => {
    const result = await runWarmup();
    expect(Number.isFinite(result.totalDurationMs)).toBe(true);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.embedding.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.playwright.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.sqlite.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('warmupCommand --json', () => {
  it('emits valid JSON to stdout when --json is set', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    await warmupCommand({ json: true });
    spy.mockRestore();
    const out = writes.join('');
    const parsed = JSON.parse(out);
    expect(parsed.totalDurationMs).toBeDefined();
    expect(parsed.embedding.ready).toBe(true);
    expect(parsed.playwright.ready).toBe(true);
    expect(parsed.sqlite.ready).toBe(true);
  });

  it('emits a human-readable summary by default', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    await warmupCommand({});
    spy.mockRestore();
    const out = writes.join('');
    expect(out).toContain('xray warmup completed in');
    expect(out).toContain('embedding model');
    expect(out).toContain('playwright chromium');
    expect(out).toContain('sqlite cache');
  });
});
