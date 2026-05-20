import { logger } from '../core/logger.ts';
import type { XComment } from '../models/comment.ts';
import type { XExternalLink } from '../models/link.ts';
import type { XMedia } from '../models/media.ts';
/**
 * Parser for X's TweetDetail GraphQL response shape.
 * The structure is unstable; we defensively pull the fields we know and ignore the rest.
 */
import type { XArticleCard, XAuthor, XPost, XPostMetrics } from '../models/post.ts';

type AnyObj = Record<string, unknown>;
const obj = (v: unknown): AnyObj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : undefined;
const arr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function unwrapTweetResult(result: unknown): AnyObj | undefined {
  const r = obj(result);
  if (!r) return undefined;
  // TweetWithVisibilityResults wraps the actual tweet
  if (r.__typename === 'TweetWithVisibilityResults') return obj(r.tweet);
  return r;
}

function parseAuthor(coreUser: unknown): XAuthor | undefined {
  const user = unwrapUserResult(coreUser);
  if (!user) return undefined;
  const legacy = obj(user.legacy);
  const core = obj(user.core);
  const handle = str(core?.screen_name) ?? str(legacy?.screen_name);
  if (!handle) return undefined;
  return {
    id: str(user.rest_id),
    handle,
    displayName: str(core?.name) ?? str(legacy?.name),
    verified: Boolean(legacy?.verified) || Boolean(user.is_blue_verified),
    avatarUrl: str(legacy?.profile_image_url_https),
  };
}

function unwrapUserResult(coreUser: unknown): AnyObj | undefined {
  const c = obj(coreUser);
  if (!c) return undefined;
  // core.user_results.result
  const userResults = obj(c.user_results);
  if (userResults) {
    return obj(userResults.result);
  }
  return c;
}

function parseMetrics(legacy: AnyObj): XPostMetrics {
  return {
    likes: num(legacy.favorite_count),
    reposts: num(legacy.retweet_count),
    replies: num(legacy.reply_count),
    views: num(legacy.view_count),
    bookmarks: num(legacy.bookmark_count),
  };
}

function parseMedia(legacy: AnyObj): XMedia[] {
  const entities = obj(legacy.entities);
  const extended = obj(legacy.extended_entities);
  const mediaList = arr(extended?.media) ?? arr(entities?.media) ?? [];
  const out: XMedia[] = [];
  for (const item of mediaList) {
    const m = obj(item);
    if (!m) continue;
    const type = str(m.type);
    const url = str(m.media_url_https) ?? str(m.media_url);
    if (!url) continue;
    if (type === 'photo') {
      out.push({ type: 'image', url, altText: str(m.ext_alt_text) });
    } else if (type === 'video' || type === 'animated_gif') {
      const variants = arr(obj(m.video_info)?.variants) ?? [];
      // prefer highest bitrate mp4
      let bestUrl: string | undefined;
      let bestBr = -1;
      for (const v of variants) {
        const vv = obj(v);
        if (vv?.content_type !== 'video/mp4') continue;
        const br = num(vv.bitrate) ?? 0;
        const vurl = str(vv.url);
        if (vurl && br > bestBr) {
          bestBr = br;
          bestUrl = vurl;
        }
      }
      out.push({
        type: type === 'video' ? 'video' : 'gif',
        url: bestUrl ?? url,
        previewUrl: url,
        durationMs: num(obj(m.video_info)?.duration_millis),
      });
    }
  }
  return out;
}

function parseLinks(legacy: AnyObj): XExternalLink[] {
  const urls = arr(obj(legacy.entities)?.urls) ?? [];
  const out: XExternalLink[] = [];
  for (const u of urls) {
    const o = obj(u);
    if (!o) continue;
    const url = str(o.url);
    const expanded = str(o.expanded_url);
    if (!url) continue;
    let domain: string | undefined;
    try {
      domain = new URL(expanded ?? url).hostname;
    } catch {
      /* skip */
    }
    out.push({
      url,
      expandedUrl: expanded,
      domain,
      title: str(o.title),
      description: str(o.description),
    });
  }
  return out;
}

/**
 * P3.0 — Extract X Article card binding values from a TweetDetail tweet
 * result. X serves long-form articles as a tweet `card` payload with
 * shape `card.legacy.binding_values: Array<{ key, value: { string_value | scribe_value | ... } }>`.
 * The exact set of keys is unstable across X's experiments (card_url,
 * title, body_text, article_text, author_name, created_at, etc.) — we
 * surface whatever's present as a flat string map so the downstream
 * `parse-x-article.ts` can defensively pick the fields it needs.
 *
 * Returns `undefined` when the tweet has no card, the card has no
 * binding_values, or none of the bindings resolved to a string.
 *
 * Conservative — only the `string_value.string_value` and
 * `scribe_value.value` shapes are read. Image / user / numeric binding
 * shapes are skipped silently; P3.0 only cares about article text.
 */
export function parseCardBindings(tweetResult: unknown): Record<string, string> | undefined {
  const tweet = unwrapTweetResult(tweetResult);
  const card = obj(tweet?.card);
  const legacy = obj(card?.legacy);
  const bindings = arr(legacy?.binding_values) ?? arr(card?.binding_values);
  if (!bindings) return undefined;
  const out: Record<string, string> = {};
  for (const b of bindings) {
    const bo = obj(b);
    const key = str(bo?.key);
    if (!key) continue;
    const value =
      str(obj(bo?.value)?.string_value) ??
      str(obj(bo?.value)?.scribe_key) ??
      str(obj(bo?.value)?.url) ??
      str(obj(bo?.string_value)?.string_value) ??
      str(obj(bo?.scribe_value)?.value);
    if (value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * P3.0 — Pull the raw `card` sub-object off a TweetDetail tweet result.
 * Used by `analyze-thread.ts` to thread the card payload into the
 * standalone `xray article` orchestrator without re-fetching. Returns
 * `undefined` when no card is present.
 */
export function extractTweetCard(tweetResult: unknown): unknown {
  const tweet = unwrapTweetResult(tweetResult);
  return tweet?.card;
}

/**
 * v1.0.1 — Lift the `tweet.card` payload into a structured `XArticleCard`
 * suitable for the typed `XPost.card` field. Distinct from
 * `parseCardBindings` (returns a flat `Record<string, string>`) and
 * `parseXArticle` (returns a typed `ArticleBody`); this helper sits in
 * between, exposing just the fields the article-candidate collector and
 * orchestrator need without burning a Kyma call.
 *
 * Returns `undefined` when:
 *   - the tweet has no `card`,
 *   - the card has no resolvable URL (we can't dedupe / route without one),
 *   - or `parseCardBindings` returned nothing.
 *
 * Defensive throughout — never throws on shape variance. Unknown binding
 * shapes are ignored; missing fields become `undefined`.
 *
 * URL precedence (highest first):
 *   1. `card.url` (top-level — X Articles always set this)
 *   2. `binding_values[card_url].string_value`
 *   3. `binding_values[url].string_value`
 *   4. `binding_values[article_url].string_value`
 */
export function parseTweetCard(tweetResult: unknown): XArticleCard | undefined {
  const tweet = unwrapTweetResult(tweetResult);
  const card = obj(tweet?.card);
  if (!card) return undefined;

  const bindings = parseCardBindings(tweetResult) ?? {};
  const cardUrl = str(card.url) ?? bindings.card_url ?? bindings.url ?? bindings.article_url;
  if (!cardUrl) return undefined;

  const title = bindings.title ?? bindings.card_title ?? bindings.article_title;
  const byline = bindings.author_name ?? bindings.author ?? bindings.byline;
  const publishedAt = bindings.published_at ?? bindings.created_at ?? bindings.date_published;
  // Body text only ships on X Articles — summary_large_image / video cards
  // leave it unset. We probe the documented X Article keys + a few common
  // fallbacks. Description / summary are intentionally last (preview-only).
  const bodyText =
    bindings.body_text ??
    bindings.article_text ??
    bindings.article_content ??
    bindings.content ??
    bindings.body;

  const out: XArticleCard = { url: cardUrl, raw: bindings };
  if (title) out.title = title;
  if (byline) out.byline = byline;
  if (publishedAt) out.publishedAt = publishedAt;
  if (bodyText) out.bodyText = bodyText;
  return out;
}

function isoFromTwitterDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function parsePost(tweetResult: unknown): XPost | undefined {
  const tweet = unwrapTweetResult(tweetResult);
  if (!tweet) return undefined;
  const legacy = obj(tweet.legacy);
  if (!legacy) return undefined;

  const id = str(tweet.rest_id) ?? str(legacy.id_str);
  if (!id) return undefined;

  const author = parseAuthor(tweet.core);
  if (!author) return undefined;

  const text = str(legacy.full_text) ?? '';
  const inReplyTo = str(legacy.in_reply_to_status_id_str);
  const quotedResult = unwrapTweetResult(obj(tweet.quoted_status_result)?.result);
  const quotedId = quotedResult ? str(quotedResult.rest_id) : undefined;

  // P3.0 / v1.0.1 — surface the card sub-object via TWO channels:
  //   1. `XPost.card` (v1.0.1, structured) — the typed shape downstream
  //      code (analyze-thread, article orchestrator) reads to detect
  //      X Articles + skip refetch. Populated via `parseTweetCard`.
  //   2. `XPost.raw.card` (P3.0, raw) — kept for backward compat with
  //      any v1.0.0-era cache rows + the standalone `xray article` path
  //      that hands the raw card to `parseXArticle`. Cheap to keep
  //      (re-uses the same object reference).
  const rawCard = tweet.card;
  const structuredCard = parseTweetCard(tweetResult);

  return {
    id,
    url: `https://x.com/${author.handle}/status/${id}`,
    author,
    text,
    createdAt: isoFromTwitterDate(str(legacy.created_at)),
    language: str(legacy.lang),
    metrics: parseMetrics(legacy),
    media: parseMedia(legacy),
    links: parseLinks(legacy),
    isReply: Boolean(inReplyTo),
    inReplyToPostId: inReplyTo,
    isQuote: Boolean(quotedId),
    quotedPostId: quotedId,
    ...(structuredCard !== undefined ? { card: structuredCard } : {}),
    ...(rawCard !== undefined ? { raw: { card: rawCard } } : {}),
  };
}

export type ParsedDetail = {
  rootPost?: XPost;
  authorPosts: XPost[];
  comments: XComment[];
  quoteTweets: XPost[];
};

/**
 * A ShowMore cursor (a.k.a. "Show replies") that hangs off a particular parent
 * comment in a nested conversation module. P1.0 pagination uses these to walk
 * deeper into the reply tree.
 */
export type NestedShowMoreCursor = {
  /** The cursor token to pass back to TweetDetail. */
  value: string;
  /** The post id this cursor is "anchored under" (last tweet in the module before the cursor item), if we can identify one. */
  parentPostId?: string;
  /** Module-level depth hint: 1 for first-level nested replies, 2 for replies-to-replies, etc. */
  depth: number;
  /**
   * P1.6 PR2: true when the cursor's anchor parent is the root author replying
   * to a commenter (i.e. the parent comment would have `isAuthorReply=true`).
   * Phase B uses this flag to prioritise expansion under author-engagement
   * replies, where follow-up signal density is highest. Optional/omitted on
   * cursors whose parent we can't identify or that aren't author-anchored.
   */
  parentIsAuthorReply?: boolean;
};

export type ExtractedCursors = {
  /** Bottom cursor for paginating top-level replies. */
  bottom?: string;
  /** ShowMore cursors discovered inside conversation modules. */
  showMore: NestedShowMoreCursor[];
};

/**
 * Walk a TweetDetail GraphQL response and extract:
 *   - rootPost: the OP
 *   - authorPosts: subsequent posts in the conversation by the SAME author (thread)
 *   - comments: top-level replies from other authors
 *   - quoteTweets: harvested from any embedded quoted_status_result
 */
export function parseTweetDetail(payload: unknown, rootId: string): ParsedDetail {
  const result: ParsedDetail = { authorPosts: [], comments: [], quoteTweets: [] };
  const instructions = findInstructions(payload);
  if (!instructions) {
    logger.debug('parseTweetDetail: no instructions found');
    return result;
  }

  const entries: AnyObj[] = [];
  for (const ins of instructions) {
    const i = obj(ins);
    if (!i) continue;
    if (i.type === 'TimelineAddEntries' || i.type === 'TimelineAddToModule') {
      const es = arr(i.entries) ?? arr(i.moduleItems) ?? [];
      for (const e of es) {
        const eo = obj(e);
        if (eo) entries.push(eo);
      }
    }
  }

  const seen = new Set<string>();

  for (const entry of entries) {
    const content = obj(entry.content) ?? obj(entry.item);
    if (!content) continue;

    // TimelineTimelineItem (single tweet)
    const itemContent = obj(content.itemContent);
    if (itemContent && itemContent.itemType === 'TimelineTweet') {
      addTweet(itemContent, result, rootId, seen, 0, false);
      continue;
    }

    // TimelineTimelineModule — may be:
    //   (a) the OP's own follow-up thread (author posts);
    //   (b) a "VerticalConversation" of nested replies, where items[i] sit at increasing depth.
    // We let addTweet() figure out per-tweet routing; depth is the item's position
    // within the module (0 = top-of-module reply, 1 = reply-to-reply, ...).
    //
    // P1.6: same-author tweets that appear inside a module without an explicit
    // `in_reply_to_status_id_str` are still self-thread continuations — X's
    // VerticalConversation packs Karpathy-style "2/N, 3/N" tweets here without
    // the in_reply_to back-pointer. We pass `fromModule=true` so addTweet()
    // can route them to `authorPosts` even when `post.isReply === false`.
    const items = arr(content.items);
    if (items) {
      let posIdx = 0;
      for (const it of items) {
        const io = obj(it);
        const ic = obj(io?.item);
        const itc = obj(ic?.itemContent);
        if (!itc) continue;
        if (itc.itemType === 'TimelineTweet') {
          addTweet(itc, result, rootId, seen, posIdx, true);
          posIdx += 1;
        }
      }
    }
  }

  return result;
}

/**
 * Walk a TweetDetail payload and collect pagination cursors:
 *   - the "Bottom" cursor (next page of top-level replies);
 *   - any "ShowMore" / "ShowMoreThreads" / "ShowMoreThreadsPrompt" cursors in
 *     conversation modules (used to walk nested reply subtrees).
 *
 * X has used several cursorType values over time; we accept any cursorType that
 * starts with "ShowMore" as a nested expansion cursor.
 *
 * P1.6 PR2: optional `ctx` lets the caller pass `rootId` + `rootAuthorId` so
 * we can flag cursors whose anchor parent is the root author replying to a
 * commenter (same heuristic as `XComment.isAuthorReply`). Phase B uses this
 * to prioritise author-engagement subtrees. Backward-compatible: callers that
 * don't pass `ctx` get the same cursor shape as before, just without the flag.
 */
export function extractCursors(
  payload: unknown,
  ctx?: { rootId: string; rootAuthorId?: string },
): ExtractedCursors {
  const out: ExtractedCursors = { showMore: [] };
  const instructions = findInstructions(payload);
  if (!instructions) return out;

  for (const ins of instructions) {
    const i = obj(ins);
    if (!i) continue;
    if (i.type !== 'TimelineAddEntries' && i.type !== 'TimelineAddToModule') continue;
    const entries = arr(i.entries) ?? arr(i.moduleItems) ?? [];

    for (const entry of entries) {
      const eo = obj(entry);
      if (!eo) continue;
      const content = obj(eo.content) ?? obj(eo.item);
      if (!content) continue;

      // Top-level cursor entry.
      const ctype = str(content.cursorType);
      const cvalue = str(content.value);
      if (ctype && cvalue) {
        if (ctype === 'Bottom') {
          out.bottom = cvalue;
        } else if (ctype.startsWith('ShowMore')) {
          out.showMore.push({ value: cvalue, depth: 1 });
        }
        continue;
      }

      // Cursor nested inside a module's items[].
      const items = arr(content.items);
      if (!items) continue;
      let lastTweetId: string | undefined;
      let lastTweetIsAuthorReply = false;
      let depthHint = 1;
      for (const it of items) {
        const io = obj(it);
        const ic = obj(io?.item);
        const itc = obj(ic?.itemContent);
        if (!itc) continue;
        if (itc.itemType === 'TimelineTweet') {
          const tweetResults = obj(itc.tweet_results);
          const tweet = unwrapTweetResult(tweetResults?.result);
          const id = str(tweet?.rest_id) ?? str(obj(tweet?.legacy)?.id_str);
          if (id) {
            lastTweetId = id;
            depthHint += 1; // each tweet under a parent deepens the module
            // P1.6 PR2: mirror the addTweet() isAuthorReply heuristic so the
            // cursor can carry the parent-engagement flag. Same author as
            // root + replies to another comment (not root) ⇒ author reply.
            lastTweetIsAuthorReply = false;
            if (ctx?.rootAuthorId) {
              const author = parseAuthor(tweet?.core);
              const legacy = obj(tweet?.legacy);
              const inReplyTo = str(legacy?.in_reply_to_status_id_str);
              if (
                author?.id === ctx.rootAuthorId &&
                inReplyTo !== undefined &&
                inReplyTo !== ctx.rootId
              ) {
                lastTweetIsAuthorReply = true;
              }
            }
          }
        } else if (itc.itemType === 'TimelineTimelineCursor') {
          const cType = str(itc.cursorType) ?? str(itc.type);
          const cVal = str(itc.value);
          if (cType && cVal && cType.startsWith('ShowMore')) {
            const cursor: NestedShowMoreCursor = { value: cVal, depth: depthHint };
            if (lastTweetId !== undefined) cursor.parentPostId = lastTweetId;
            if (lastTweetIsAuthorReply) cursor.parentIsAuthorReply = true;
            out.showMore.push(cursor);
          }
        }
      }
    }
  }
  return out;
}

function addTweet(
  itemContent: AnyObj,
  result: ParsedDetail,
  rootId: string,
  seen: Set<string>,
  depth: number,
  fromModule: boolean,
): void {
  const tweetResults = obj(itemContent.tweet_results);
  const post = parsePost(tweetResults?.result);
  if (!post) return;
  if (seen.has(post.id)) return;
  seen.add(post.id);

  if (post.id === rootId) {
    result.rootPost = post;
    return;
  }

  // P1.6 self-thread routing. A same-author follow-up belongs in `authorPosts`
  // when it's a chain continuation; the same author replying to a commenter is
  // a high-signal engagement reply that stays in `comments` (flagged below).
  if (result.rootPost && post.author.id === result.rootPost.author.id) {
    const repliesToRoot = post.isReply && post.inReplyToPostId === rootId;
    // A same-author tweet inside a conversation module without an explicit
    // in_reply_to back-pointer is still a self-thread continuation (X packs
    // "2/N, 3/N" Karpathy-style tweets this way). `fromModule` gates this
    // looser branch so a top-level same-author reply-to-commenter doesn't get
    // mis-routed.
    const moduleContinuation = fromModule && !post.isReply;
    if (repliesToRoot || moduleContinuation) {
      result.authorPosts.push(post);
      return;
    }
    if (post.isReply && post.inReplyToPostId && post.inReplyToPostId !== rootId) {
      // Author replying to a commenter — keep in comments tree but flag it so
      // the renderer + LLM prompt can surface it as high-signal engagement.
      result.comments.push({ ...post, depth, replies: [], isAuthorReply: true });
      return;
    }
  }

  if (post.isQuote && post.quotedPostId === rootId) {
    result.quoteTweets.push(post);
    return;
  }

  // top-level reply from another author
  result.comments.push({ ...post, depth, replies: [] });
}

function findInstructions(payload: unknown): unknown[] | undefined {
  const root = obj(payload);
  if (!root) return undefined;
  // data.threaded_conversation_with_injections_v2.instructions
  const data = obj(root.data);
  const conv = obj(data?.threaded_conversation_with_injections_v2);
  if (conv) {
    const ins = arr(conv.instructions);
    if (ins) return ins;
  }
  // fallback recursive search
  return deepFindArray(root, 'instructions');
}

function deepFindArray(node: unknown, key: string): unknown[] | undefined {
  const o = obj(node);
  if (!o) return undefined;
  if (Array.isArray(o[key])) return o[key] as unknown[];
  for (const v of Object.values(o)) {
    const found = deepFindArray(v, key);
    if (found) return found;
  }
  return undefined;
}
