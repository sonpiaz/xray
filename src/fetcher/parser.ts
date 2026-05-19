import { logger } from '../core/logger.ts';
import type { XComment } from '../models/comment.ts';
import type { XExternalLink } from '../models/link.ts';
import type { XMedia } from '../models/media.ts';
/**
 * Parser for X's TweetDetail GraphQL response shape.
 * The structure is unstable; we defensively pull the fields we know and ignore the rest.
 */
import type { XAuthor, XPost, XPostMetrics } from '../models/post.ts';

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
  };
}

export type ParsedDetail = {
  rootPost?: XPost;
  authorPosts: XPost[];
  comments: XComment[];
  quoteTweets: XPost[];
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
      addTweet(itemContent, result, rootId, seen, 0);
      continue;
    }

    // TimelineTimelineModule (conversation thread by same author)
    const items = arr(content.items);
    if (items) {
      for (const it of items) {
        const io = obj(it);
        const ic = obj(io?.item);
        const itc = obj(ic?.itemContent);
        if (itc && itc.itemType === 'TimelineTweet') {
          addTweet(itc, result, rootId, seen, 0);
        }
      }
    }
  }

  return result;
}

function addTweet(
  itemContent: AnyObj,
  result: ParsedDetail,
  rootId: string,
  seen: Set<string>,
  depth: number,
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

  if (result.rootPost && post.author.id === result.rootPost.author.id && post.isReply) {
    // same-author follow-up post in the same thread
    result.authorPosts.push(post);
    return;
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
