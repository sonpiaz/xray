/**
 * P3.0 — Article module re-exports. The orchestrator + CLI consume this
 * file rather than reaching into individual modules so the module
 * boundary stays clean.
 *
 * P3.1 — Adds external fetch + URL canonicalization + platform detect
 * exports for the orchestrator wiring.
 */
export {
  ArticleError,
  ArticleParseError,
  detectArticleSource,
  detectExternalPlatform,
  type ExternalPlatform,
} from './detect.ts';
export {
  _fetchDeps,
  type FetchExternalOptions,
  type FetchedArticleBody,
  detectPaywall,
  fetchExternalArticle,
} from './fetch.ts';
export { parseXArticle } from './parse-x-article.ts';
export {
  buildSummarizePrompts,
  estimateSummarizeCost,
  SUMMARIZE_PROMPT_VERSION,
  type SummarizeArticleOptions,
  type SummarizeArticleResult,
  summarizeArticle,
} from './summarize.ts';
export {
  buildCrossReferencePrompts,
  CROSS_REFERENCE_PROMPT_VERSION,
  type CrossReferenceInput,
  type CrossReferenceOutput,
  crossReferenceArticle,
  estimateCrossReferenceCost,
  MAX_CROSS_REFERENCES,
  parseCrossReferenceResponse,
  repairCrossReferenceResponse,
} from './cross-reference.ts';
export {
  _setDbModuleForTests,
  _setHeadResolverForTests,
  type ArticleCacheInfo,
  articleCacheInfo,
  canonicalizeArticleUrl,
  clearArticleCache,
  getCachedArticleBody,
  getCachedArticleSummary,
  putCachedArticleBody,
  putCachedArticleSummary,
  resolveCanonicalArticleUrl,
} from './cache.ts';
