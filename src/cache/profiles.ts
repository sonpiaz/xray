/**
 * P4.2 — Profile cache reader/writer.
 *
 * Profile cache lives in `profile_cache(handle, report_json, created_at)`
 * (migration in `./db.ts`). Keyed by lowercased handle (no leading @).
 *
 * Freshness is independent of the global `cache.ttlSeconds` config —
 * profile reports are LLM-synthesized and cheap to refresh, so we pick a
 * fixed 24h TTL per Son's call (PHASE_4_PLAN §9). Callers that want a
 * forced re-synthesis pass `noCache=true` to the orchestrator, which
 * bypasses this module entirely.
 *
 * Why a separate module instead of inlining into the orchestrator:
 *   - Tests can stub these two functions without touching `bun:sqlite`,
 *     same pattern as `threads.ts` / `posts.ts`.
 *   - `xray cache clear --profiles` calls `clearProfileCache()` from
 *     here without dragging in the orchestrator.
 */
import { type ProfileReport, ProfileReportSchema } from '../models/profile.ts';
import { getDb } from './db.ts';

/** 24h fixed staleness window. */
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase();
}

/**
 * Read a cached profile by handle. Returns undefined when:
 *   - no row exists
 *   - the row is older than the 24h TTL
 *   - the JSON is corrupt or fails Zod parse (defensive — caller will
 *     re-synthesize and overwrite)
 */
export function getCachedProfile(handle: string): ProfileReport | undefined {
  const key = normalizeHandle(handle);
  const row = getDb()
    .query<{ report_json: string; created_at: number }, [string]>(
      'SELECT report_json, created_at FROM profile_cache WHERE handle = ?',
    )
    .get(key);
  if (!row) return undefined;
  if (Date.now() - row.created_at > PROFILE_CACHE_TTL_MS) return undefined;
  try {
    return ProfileReportSchema.parse(JSON.parse(row.report_json));
  } catch {
    return undefined;
  }
}

export function putCachedProfile(report: ProfileReport): void {
  const key = normalizeHandle(report.handle);
  getDb()
    .query(
      `INSERT INTO profile_cache (handle, report_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET report_json = excluded.report_json,
                                         created_at = excluded.created_at`,
    )
    .run(key, JSON.stringify(report), Date.now());
}

/**
 * Wipe every row from `profile_cache`. Used by
 * `xray cache clear --profiles` — preserves posts/threads/embeddings
 * and only drops the synthesized profile reports.
 */
export function clearProfileCache(): void {
  getDb().exec('DELETE FROM profile_cache');
}

export function profileCacheCount(): number {
  return getDb().query<{ c: number }, []>('SELECT COUNT(*) AS c FROM profile_cache').get()?.c ?? 0;
}
