/**
 * P4.2 — MCP input-schema validation tests for `xray_profile`.
 *
 * Mirrors `tests/unit/mcp-search.test.ts` — lifts the exported Zod
 * record from `src/mcp/schemas.ts`, wraps it in `z.object()`, and
 * asserts on parse / reject paths.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProfileInput } from '../../src/mcp/schemas.ts';

const ProfileSchema = z.object(ProfileInput);

describe('MCP ProfileInput schema (xray_profile)', () => {
  it('accepts a minimal payload with just a handle', () => {
    const parsed = ProfileSchema.parse({ handle: 'karpathy' });
    expect(parsed.handle).toBe('karpathy');
    expect(parsed.noCache).toBeUndefined();
    expect(parsed.fresh).toBeUndefined();
    expect(parsed.format).toBeUndefined();
  });

  it('accepts @-prefixed handles', () => {
    const parsed = ProfileSchema.parse({ handle: '@karpathy' });
    expect(parsed.handle).toBe('@karpathy'); // Zod doesn't normalize; orchestrator does
  });

  it('rejects an empty handle', () => {
    expect(() => ProfileSchema.parse({ handle: '' })).toThrow();
  });

  it('accepts all optional fields together', () => {
    const parsed = ProfileSchema.parse({
      handle: 'karpathy',
      noCache: true,
      fresh: 20,
      model: 'gemini-2.5-flash',
      format: 'both',
    });
    expect(parsed.noCache).toBe(true);
    expect(parsed.fresh).toBe(20);
    expect(parsed.model).toBe('gemini-2.5-flash');
    expect(parsed.format).toBe('both');
  });

  it('rejects fresh < 1', () => {
    expect(() => ProfileSchema.parse({ handle: 'h', fresh: 0 })).toThrow();
  });

  it('rejects fresh > 50', () => {
    expect(() => ProfileSchema.parse({ handle: 'h', fresh: 100 })).toThrow();
  });

  it('rejects non-integer fresh', () => {
    expect(() => ProfileSchema.parse({ handle: 'h', fresh: 1.5 })).toThrow();
  });

  it('rejects unknown format values', () => {
    expect(() => ProfileSchema.parse({ handle: 'h', format: 'yaml' })).toThrow();
  });
});
