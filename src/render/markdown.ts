import type { XComment } from '../models/comment.ts';
import type { XPost } from '../models/post.ts';
import type { ResearchReport } from '../models/report.ts';

function fmtNum(n: number | undefined): string {
  if (n === undefined) return '?';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function postById(report: ResearchReport, id: string): XPost | undefined {
  if (report.thread.rootPost.id === id) return report.thread.rootPost;
  return (
    report.thread.authorPosts.find((p) => p.id === id) ??
    report.thread.quoteTweets.find((p) => p.id === id) ??
    report.thread.comments.find((p) => p.id === id)
  );
}

/**
 * Flatten reply tree to a single array (DFS). Local copy of the helper in
 * `src/intelligence/classify.ts` — duplicated here to keep the renderer
 * free of intelligence-layer imports (renderer is a leaf module).
 */
function flattenComments(comments: XComment[]): XComment[] {
  const out: XComment[] = [];
  const walk = (list: XComment[]): void => {
    for (const c of list) {
      out.push(c);
      if (c.replies.length > 0) walk(c.replies);
    }
  };
  walk(comments);
  return out;
}

function classifiedComments(report: ResearchReport): XComment[] {
  return flattenComments(report.thread.comments).filter((c) => c.classification);
}

function renderReplyLine(c: XComment): string[] {
  const lines: string[] = [];
  const cls = c.classification;
  const handle = `@${c.author.handle}`;
  const scoreLabel = cls ? cls.qualityScore.toFixed(2) : '—';
  const stance = cls ? cls.stance : 'unknown';
  const quality = cls ? cls.quality : '—';
  lines.push(
    `- **${handle}** — score **${scoreLabel}** · [${stance}] · ${quality} (♥${fmtNum(c.metrics.likes)})`,
  );
  const snippet = c.text.replace(/\s+/g, ' ').slice(0, 200);
  lines.push(`  > _“${snippet}${c.text.length > 200 ? '…' : ''}”_`);
  return lines;
}

export function renderReportMarkdown(report: ResearchReport): string {
  const root = report.thread.rootPost;
  const m = root.metrics;
  const out: string[] = [];

  out.push(`# Thread Research — @${root.author.handle}`);
  if (report.topic) out.push(`> **Topic:** ${report.topic}`);
  out.push('');
  out.push(`**URL:** ${root.url}`);
  if (root.createdAt) out.push(`**Posted:** ${root.createdAt}`);
  out.push(
    `**Engagement:** ${fmtNum(m.likes)} likes · ${fmtNum(m.reposts)} reposts · ${fmtNum(m.replies)} replies · ${fmtNum(m.views)} views`,
  );
  out.push(
    `**Model:** \`${report.source.model}\` · cache: ${report.source.cacheHit ? 'hit' : 'miss'}`,
  );
  out.push('');

  if (report.warnings.length > 0) {
    out.push(`> ⚠ ${report.warnings.join(' · ')}`);
    out.push('');
  }

  out.push('## TL;DR');
  out.push(report.tldr);
  out.push('');

  out.push('## Summary');
  out.push(report.summary);
  out.push('');

  if (report.coverage || report.stanceDistribution) {
    out.push('## Conversation Analysis');
    if (report.coverage) {
      const cov = report.coverage;
      out.push(
        `**Coverage:** ${cov.fetchedReplies}/${cov.targetReplies} replies fetched · depth ${cov.achievedDepth}/${cov.targetDepth} · ${cov.classifiedReplies} classified · status ${cov.status}`,
      );
    }
    if (report.stanceDistribution) {
      const d = report.stanceDistribution;
      out.push(
        `**Stance distribution:** ${d.agree} agree · ${d.disagree} disagree · ${d.neutral} neutral · ${d.question} question · ${d.humor} humor · ${d.meta} meta`,
      );
    }
    out.push('');
  }

  if (report.keyInsights.length > 0) {
    out.push('## Key Insights');
    for (const k of report.keyInsights) {
      const tag = `[${k.confidence}]`;
      const evidence =
        k.evidencePostIds.length > 0
          ? ` _(evidence: ${k.evidencePostIds.map((id) => `\`${id}\``).join(', ')})_`
          : '';
      out.push(`- **${tag}** ${k.insight}${evidence}`);
    }
    out.push('');
  }

  if (report.notableReplies.length > 0) {
    out.push('## Notable Replies');
    for (const r of report.notableReplies) {
      const post = postById(report, r.postId);
      const who = post ? `@${post.author.handle}` : 'unknown';
      out.push(`- **${who}** — ${r.reason}`);
      if (r.summary) out.push(`  > ${r.summary}`);
      if (post) {
        const snippet = post.text.replace(/\s+/g, ' ').slice(0, 180);
        out.push(
          `  > _“${snippet}${post.text.length > 180 ? '…' : ''}”_  (♥${fmtNum(post.metrics.likes)})`,
        );
      }
    }
    out.push('');
  }

  if (report.openQuestions.length > 0) {
    out.push('## Open Questions');
    for (const q of report.openQuestions) out.push(`- ${q}`);
    out.push('');
  }

  // P1.2: classification-derived sections. Both gated on `coverage` AND
  // `stanceDistribution` presence so Phase 0 / no-Kyma outputs skip cleanly.
  // Section ordering (after Conversation Analysis, before Source) is per
  // PHASE_1_PLAN.md lines 696-722.
  if (report.coverage && report.stanceDistribution) {
    const classified = classifiedComments(report);
    if (classified.length > 0) {
      const top = [...classified]
        .sort(
          (a, b) => (b.classification?.qualityScore ?? 0) - (a.classification?.qualityScore ?? 0),
        )
        .slice(0, 5);
      out.push('## Top Quality Replies');
      for (const c of top) {
        for (const line of renderReplyLine(c)) out.push(line);
      }
      out.push('');

      const dissenting = classified
        .filter((c) => c.classification?.stance === 'disagree')
        .sort(
          (a, b) => (b.classification?.qualityScore ?? 0) - (a.classification?.qualityScore ?? 0),
        )
        .slice(0, 3);
      if (dissenting.length > 0) {
        out.push('## Dissenting Views');
        for (const c of dissenting) {
          for (const line of renderReplyLine(c)) out.push(line);
        }
        out.push('');
      }
    }
  }

  // P1.3: Deep mode subtree summaries + synthesis output. Rendered only when
  // `--deep` ran and produced at least one subtree summary. Positioned AFTER
  // "Dissenting Views" and BEFORE "Source — Root Post" per task brief.
  if (report.subtreeSummaries && report.subtreeSummaries.length > 0) {
    out.push('## Deep Analysis — Subtree Summaries');
    for (const s of report.subtreeSummaries) {
      out.push(
        `### Subtree: @${s.rootReplyHandle} (${s.replyCount} ${s.replyCount === 1 ? 'reply' : 'replies'})`,
      );
      out.push(`**Headline:** ${s.headline}`);
      if (s.keyPoints.length > 0) {
        out.push('');
        out.push('**Key points:**');
        for (const p of s.keyPoints) out.push(`- ${p}`);
      }
      if (s.dissent.length > 0) {
        out.push('');
        out.push('**Dissent:**');
        for (const d of s.dissent) out.push(`- ${d}`);
      }
      out.push('');
    }

    if (report.deepSynthesis) {
      const syn = report.deepSynthesis;
      if (syn.topArguments.length > 0) {
        out.push('### Top Arguments');
        for (const a of syn.topArguments) {
          const voiced = a.voicedBy.length > 0 ? ` _(voiced by: ${a.voicedBy.join(', ')})_` : '';
          out.push(`- **${a.argument}**${voiced}`);
        }
        out.push('');
      }
      if (syn.dissentMap.length > 0) {
        out.push('### Dissent Map');
        for (const d of syn.dissentMap) {
          const target = d.againstOp ? 'vs OP' : 'within replies';
          const voiced = d.voicedBy.length > 0 ? ` _(voiced by: ${d.voicedBy.join(', ')})_` : '';
          out.push(`- _[${target}]_ ${d.claim}${voiced}`);
        }
        out.push('');
      }
      if (syn.subThreadsWorthReading.length > 0) {
        out.push('### Sub-threads Worth Reading');
        for (const p of syn.subThreadsWorthReading) {
          out.push(`- **${p.handle}** — ${p.reason}`);
        }
        out.push('');
      }
    }
  }

  // P1.6: unify root + author follow-ups into a single numbered "Author Thread"
  // code block so readers don't conclude the OP posted just one tweet. Falls
  // back to the original "Source — Root Post" heading when there are no
  // follow-ups (preserves the simpler look + keeps existing tests stable).
  const authorPosts = report.thread.authorPosts;
  if (authorPosts.length > 0) {
    const total = 1 + authorPosts.length;
    out.push('## Source — Author Thread');
    out.push('```text');
    out.push(`[1/${total}] ${root.text}`);
    for (let i = 0; i < authorPosts.length; i++) {
      out.push('');
      out.push(`[${i + 2}/${total}] ${authorPosts[i]?.text ?? ''}`);
    }
    out.push('```');
  } else {
    out.push('## Source — Root Post');
    out.push('```');
    out.push(root.text);
    out.push('```');
  }

  // P1.6: author engagement section — same-author replies to commenters,
  // pulled out as their own block because they're the highest-signal context
  // a reader can get beyond the OP's main thesis. Cap at 10 entries.
  const authorReplies = flattenComments(report.thread.comments)
    .filter((c) => c.isAuthorReply)
    .slice(0, 10);
  if (authorReplies.length > 0) {
    out.push('');
    out.push(`### Author engagement (${authorReplies.length} replies to commenters)`);
    const authorHandle = root.author.handle;
    for (const reply of authorReplies) {
      const parentId = reply.inReplyToPostId;
      const parent = parentId ? postById(report, parentId) : undefined;
      const replySnippet = reply.text.replace(/\s+/g, ' ').slice(0, 180);
      const replyTail = reply.text.length > 180 ? '…' : '';
      if (parent) {
        const parentSnippet = parent.text.replace(/\s+/g, ' ').slice(0, 120);
        const parentTail = parent.text.length > 120 ? '…' : '';
        out.push(
          `- @${parent.author.handle} asked/said: "${parentSnippet}${parentTail}" → @${authorHandle}: "${replySnippet}${replyTail}"`,
        );
      } else {
        const parentNote = parentId ? ` (in reply to ${parentId})` : '';
        out.push(`- @${authorHandle}${parentNote}: "${replySnippet}${replyTail}"`);
      }
    }
  }

  if (report.thread.quoteTweets.length > 0) {
    out.push('');
    out.push(`### Quote tweets (${report.thread.quoteTweets.length})`);
    for (const q of report.thread.quoteTweets.slice(0, 10)) {
      out.push(`- **@${q.author.handle}**: ${q.text.replace(/\n/g, ' ').slice(0, 240)}`);
    }
  }

  if (report.thread.comments.length > 0) {
    out.push('');
    out.push(`### Top replies (${report.thread.comments.length})`);
    for (const c of report.thread.comments.slice(0, 20)) {
      out.push(
        `- **@${c.author.handle}** (♥${fmtNum(c.metrics.likes)}): ${c.text.replace(/\n/g, ' ').slice(0, 240)}`,
      );
    }
  }

  out.push('');
  out.push('---');
  out.push(`_Generated by XRay at ${report.generatedAt}_`);

  return out.join('\n');
}
