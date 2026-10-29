/**
 * **정체 홉**(연쇄 한도 재설계 ②, 2026-10-27). 연쇄 깊이(`mention_depth`)는 사람이 마지막으로 말한 뒤 **몇 번 건넜나**를
 * 센다 — 그래서 에이전트끼리 역할대로 일을 주고받는 정상 협업도 길어지면 상한에 걸렸다(#rcms: 이틀 동안 약 45홉, 모든 홉이
 * 새 PR·새 head 를 냈다). 무한 루프의 표지는 홉 수가 아니라 **아무것도 새로 나오지 않는 홉이 이어지는 것**이다.
 *
 * 결과물로 치는 것: 커밋 sha(7~40 자리 16진수, 숫자와 a-f 를 둘 다 품은 것), `#123`·`owner/repo#123` 같은 PR·이슈 번호,
 * `harkroom://message/<id>` 링크, GitHub PR·이슈·커밋 URL, 첨부. 시각·날짜(`10:15`·`2026-10-27`)는 숫자만이라 sha 로 잡히지 않는다.
 * 앞 줄에 이미 있던 것은 새 결과물이 아니다 — 「이미 했다」·「이미 봤다」를 같은 sha 로 되풀이하는 메아리는 정체다.
 *
 * 16진수 낱말(`deadbeef`)을 sha 로 잘못 읽는 쪽은 **덜 막는** 방향이라 백스톱(③)이 받는다.
 */

/** 새 결과물 없이 이어진 에이전트 홉이 이만큼이면 에이전트 부름을 막는다(그림자 단계에서는 기록만). */
export const STALL_HOP_LIMIT = 4;

/**
 * **백스톱의 시간 축**(연쇄 한도 재설계 ③). 사람 손길에서 시작한 사슬이 이만큼 지나면 홉 수와 무관하게 에이전트 부름을 막고
 * 서버가 소유자에게 카드([계속 — 예산 리셋]/[멈춤])를 세운다. 홉 축은 워크스페이스 상한(`mention_policy.chain_limit`)이다.
 */
export const CHAIN_BACKSTOP_MS = 24 * 60 * 60_000;

/** 백스톱 카드의 선택지 id — 서버가 「계속」 답만 사슬을 새로 시작한 것으로 친다(`causeDepth`). */
export const CHAIN_BACKSTOP_CONTINUE = 'continue';
export const CHAIN_BACKSTOP_STOP = 'stop';

/** 결과물 비교에 쓰는 앞 줄 수 — 같은 스레드의 최근 메시지. */
export const STALL_LOOKBACK = 10;

const SHA = /\b[0-9a-f]{7,40}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISSUE_REF = /(?:^|[\s(\[,])((?:[\w.-]+\/[\w.-]+)?#\d{1,7})\b/g;
const MESSAGE_LINK = /harkroom:\/\/message\/([0-9a-f-]{36})/gi;
const GITHUB_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues|commit)\/[0-9a-f]+/gi;

/** 본문의 `harkroom://message/<id>` 링크가 가리키는 메시지 id(소문자). 서버가 같은 스레드 글인지 가르는 데 쓴다. */
export function messageLinkIds(body: string): string[] {
  // uuid 꼴만 — 서버가 `::uuid[]` 로 넘기므로 하이픈 자리가 틀린 36자는 조회를 깨뜨린다.
  return [...new Set([...body.matchAll(MESSAGE_LINK)].map((m) => m[1]!.toLowerCase()))]
    .filter((id) => UUID_EXACT.test(id));
}

export interface ChainArtifactOptions {
  /**
   * **같은 스레드 글의 id**(⑤, security M2). 그 글로 가는 링크는 결과물이 아니다 — 루프를 도는 에이전트가 서로의 앞 글
   * 링크만 달아도 매 홉 「새 결과물」로 읽혀 정체 셈이 0 으로 돌아갔다. 서버가 본문의 링크 가운데 이 스레드 것만 골라 준다.
   */
  ownThreadIds?: ReadonlySet<string>;
}

/**
 * 본문에서 결과물 표지를 뽑는다. 비교용이라 소문자로 맞추고, sha 는 앞 7자리로 줄인다(짧은 sha·긴 sha 를 같은 것으로).
 * **맨 uuid 는 결과물이 아니다**(⑤) — 턴 id·메시지 id 의 마디(`1e086e53`)가 sha 로 잡히면 아무 id 나 붙여도 정체가 풀린다.
 */
export function chainArtifacts(body: string, opts: ChainArtifactOptions = {}): Set<string> {
  const out = new Set<string>();
  // 링크를 먼저 뽑고 지운다 — 남겨 두면 uuid 마디가 sha 로 다시 잡힌다. 같은 스레드 글로 가는 링크는 버린다.
  let rest = body.replace(MESSAGE_LINK, (m, id: string) => {
    if (!opts.ownThreadIds?.has(id.toLowerCase())) out.add(`msg:${m.toLowerCase()}`);
    return ' ';
  });
  rest = rest.replace(GITHUB_URL, (m) => {
    const tail = m.toLowerCase().split('/').slice(-2);
    out.add(tail[0] === 'commit' ? `sha:${tail[1]!.slice(0, 7)}` : `ref:#${tail[1]}`);
    return ' ';
  });
  rest = rest.replace(UUID, ' ');
  for (const m of rest.matchAll(SHA)) {
    const w = m[0].toLowerCase();
    if (/[0-9]/.test(w) && /[a-f]/.test(w)) out.add(`sha:${w.slice(0, 7)}`);
  }
  for (const m of rest.matchAll(ISSUE_REF)) out.add(`ref:${m[1]!.toLowerCase().replace(/^.*#/, '#')}`);
  return out;
}

/** 이 본문이 앞 줄들에 없던 결과물 — 비었으면 새 결과물이 없다. */
export function newArtifacts(body: string, recentBodies: readonly string[], opts: ChainArtifactOptions = {}): Set<string> {
  const mine = chainArtifacts(body, opts);
  if (mine.size === 0) return mine;
  const seen = new Set<string>();
  for (const b of recentBodies) for (const a of chainArtifacts(b, opts)) seen.add(a);
  return new Set([...mine].filter((a) => !seen.has(a)));
}

/** 이 본문이 앞 줄들에 없던 결과물을 하나라도 내놓았나. 첨부는 언제나 새 결과물이다. */
export function bringsNewArtifact(
  body: string, recentBodies: readonly string[], hasAttachment = false, opts: ChainArtifactOptions = {},
): boolean {
  return hasAttachment || newArtifacts(body, recentBodies, opts).size > 0;
}

export interface StallStep {
  stallDepth: number;
  /**
   * 셈이 **다른 스레드 글 링크만으로** 0 이 됐다(⑤ 그림자 표지). 좁힌 뒤에도 남는 틈 — 루프가 바깥 글 링크를 돌려 달면
   * 여전히 정체가 풀린다 — 이 얼마나 되는지 그림자 기간에 잰다.
   */
  linkOnlyReset: boolean;
}

/**
 * 이 발화의 정체 홉 수. 사슬 밖(깊이 0 — 사람 글·누구도 부르지 않은 이어 말하기)이면 0, 새 결과물이 있으면 0,
 * 아니면 앞 고리의 정체 + 1.
 */
export function stallStep(input: {
  mentionDepth: number; prevStall: number; body: string; recentBodies: readonly string[]; hasAttachment?: boolean;
  ownThreadIds?: ReadonlySet<string>;
}): StallStep {
  if (input.mentionDepth <= 0) return { stallDepth: 0, linkOnlyReset: false };
  if (input.hasAttachment) return { stallDepth: 0, linkOnlyReset: false };
  const fresh = newArtifacts(input.body, input.recentBodies, { ownThreadIds: input.ownThreadIds });
  if (fresh.size === 0) return { stallDepth: input.prevStall + 1, linkOnlyReset: false };
  return { stallDepth: 0, linkOnlyReset: [...fresh].every((a) => a.startsWith('msg:')) };
}

/** `stallStep` 의 깊이만. */
export function nextStallDepth(input: {
  mentionDepth: number; prevStall: number; body: string; recentBodies: readonly string[]; hasAttachment?: boolean;
  ownThreadIds?: ReadonlySet<string>;
}): number {
  return stallStep(input).stallDepth;
}
