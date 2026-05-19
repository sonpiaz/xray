/**
 * P3.0 — Article module re-exports. The orchestrator + CLI consume this
 * file rather than reaching into individual modules so the module
 * boundary stays clean.
 */
export {
  ArticleError,
  ArticleParseError,
  detectArticleSource,
} from './detect.ts';
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
  _setDbModuleForTests,
  type ArticleCacheInfo,
  articleCacheInfo,
  clearArticleCache,
  getCachedArticleBody,
  getCachedArticleSummary,
  putCachedArticleBody,
  putCachedArticleSummary,
} from './cache.ts';
