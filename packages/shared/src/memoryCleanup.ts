/**
 * 한 스레드의 진행 상태로 보이는 기억(메모리 재설계 S3). 판정은 서버 `scripts/memory-metrics.sql` 의 `state_like` 와
 * 글자까지 같다 — 쓰는 자리의 경고와 지표가 같은 자로 잰다. 이름이 `delegation-*`·`review-*` 이거나, 요약에
 * PR 번호와 진행 낱말이 함께 있다.
 */
export function looksLikeThreadState(slug: string, description: string | null | undefined): boolean {
  if (/^mem\/(.*\/)?(delegation|review)-/.test(slug)) return true;
  const d = description ?? '';
  // `CI` 는 대문자 낱말 그대로만(security n1 — `/i` 면 policy·decision 의 ci 에도 걸렸다). 앞뒤가 영문자만 아니면 된다.
  return /#[0-9]+/.test(d) && (/(^|[^A-Za-z])CI(?![A-Za-z])/.test(d) || /(머지|대기|초록|검토|rebase|head)/i.test(d));
}

/**
 * 진행 상태 기록 꼴의 **이름**(#1A). 서버는 새로 만드는 것만 거절하고(보관 안 된 행이 있으면 고치기·합치기는 된다), 러너 목록·recall 은 이 이름으로만 거른다.
 * **끝 마디**가 `delegation`·`review`(복수 포함)로 시작하거나(`mem/review-x`·`mem/a/delegations_x`·`mem/delegation`),
 * 어느 마디든 그 낱말 바로 뒤에 번호가 붙으면(`mem/pr-review-1666`·`mem/review12`·`mem/review-12/x`) 걸린다.
 * 분야 마디(`mem/review/<교훈>`)는 걸지 않는다 — 분야 이름이 review 인 교훈까지 숨기고 새로 못 만들게 했다.
 * 이름 꼴 판정이라 다른 낱말로 바꾸면 지나간다 — 그때는 저장 뒤 `threadState` 경고(요약 판정)가 남는다.
 */
export function isThreadStateSlug(slug: string): boolean {
  const segs = slug.split('/').slice(1);
  const last = segs[segs.length - 1] ?? '';
  return /^(delegations?|reviews?)([-_]|$)/.test(last)
    || segs.some((seg) => /(^|[-_])(delegations?|reviews?)[-_]?#?[0-9]/.test(seg));
}
