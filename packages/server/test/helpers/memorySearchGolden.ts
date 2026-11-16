// memory_search.json 을 TS 정본으로 계산한다 — 생성 스크립트와 TS 시험이 같이 쓴다.
import { isThreadStateSlug } from '@harkroom/shared';
import {
  ENDINGS, FOCUS_STOPWORDS, PARTICLES, RECALL_FOCUS_TERM_CAP, RECALL_STOPWORDS, excludedNamesFrom, focusTermsOf, rankRecall, searchTerms,
} from '../../src/services/memory.js';
import { nameRows, rankQueries, rankRows, termQueries, threadStateSlugs } from './memorySearchGoldenInputs.js';

export function memorySearchGolden() {
  const excluded = excludedNamesFrom(nameRows);
  const terms = termQueries.map((query) => ({
    query, plain: searchTerms(query), recall: searchTerms(query, { exclude: excluded }), focus: focusTermsOf(query, excluded),
  }));
  // searchMemory 의 recall 앞머리와 같은 식(focus 낱말 먼저, 16개).
  const rank = rankQueries.map(({ query, focus }) => {
    const focusTerms = focus !== undefined ? focusTermsOf(focus, excluded) : undefined;
    const t = focusTerms
      ? [...new Set([...focusTerms, ...searchTerms(query, { exclude: excluded })])].slice(0, RECALL_FOCUS_TERM_CAP)
      : searchTerms(query, { exclude: excluded });
    const hits = rankRecall(t, rankRows, 5, focusTerms ? { focus: new Set(focusTerms) } : {})
      .map((h) => ({ slug: h.slug, score: h.score, nameHits: h.nameHits, termHits: h.termHits }));
    return { query, ...(focus !== undefined ? { focus } : {}), terms: t, hits };
  });
  return {
    lists: { particles: PARTICLES, endings: ENDINGS, recallStopwords: [...RECALL_STOPWORDS], focusStopwords: [...FOCUS_STOPWORDS] },
    nameRows,
    excluded: [...excluded].sort(),
    terms,
    threadState: threadStateSlugs.map((slug) => ({ slug, want: isThreadStateSlug(slug) })),
    rows: rankRows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
    rank,
  };
}
