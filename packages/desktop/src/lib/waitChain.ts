import { readAskMeta, readDelegationMeta, type MessageRow, type OpenAskLink } from '@harkroom/shared';
import type { Liveness } from './threadState';
import type { Translate } from '../i18n';

/**
 * 대기 사슬의 한 마디 — **누가 누구를 기다리는가**.
 *
 * `waiter` 가 `blockedBy` 의 답을 기다린다. `blockedBy` 가 `null` 이면 사람 아무나를
 * 기다린다는 뜻이다(`AskAudience` 의 `'human'`).
 */
export interface WaitLink {
  /** 기다리는 쪽 — 그 물음을 낸 계정. */
  waiter: string;
  /** 답해야 하는 쪽. `null` 은 '사람 아무나'. */
  blockedBy: string | null;
  /**
   * 이 마디를 만든 미답 ask. **집계로 만든 사슬에는 없다**(#488 A3-b) — 채널 목록은
   * 답글을 싣지 않으므로 서버가 두 계정과 시각만 준다. 그래서 옵셔널이다.
   */
  message?: MessageRow;
  /** 이 마디가 생긴 시각(ISO). 메시지가 없어도 경과를 말할 수 있어야 한다. */
  askedAt: string;
  /**
   * **같은 사람이 동시에 기다리는 다른 마디의 수**(2026-09-14). 0 이면 하나만 기다린다.
   *
   * 사슬은 화면에서 **한 줄**로 읽히므로 갈래를 전부 그리면 명단이 된다(`chainEnds` 의
   * 그 문단과 같은 걱정이다). 그래서 고른 갈래 하나를 그리고 나머지는 **수**로 말한다 —
   * *"forge 가 scout 외 1명을 기다린다"*. 이름은 양 끝에만 쓴다는 규율을 지키면서도
   * "하나만 기다린다"는 거짓을 말하지 않는다.
   */
  siblings?: number;
}

/**
 * 사슬의 끝이 무엇인가 — **사람이 다음에 할 일을 정하는 값이다.**
 *
 * - `me`       내가 답하면 풀린다
 * - `deadlock` 아무 데도 안 닿는다. 사람만이 풀 수 있으므로 실패와 같은 대접(규칙 04)
 * - `other`    남을 기다린다. 나를 막지는 않는다
 * - `none`     기다리는 것이 없다
 */
export type ChainEnd = 'me' | 'deadlock' | 'other' | 'none';

export interface WaitChain {
  links: WaitLink[];
  end: ChainEnd;
  /**
   * **내가 한 번 답하면 몇 개가 풀리는가.** 사람이 답할 이유가 이 숫자다 —
   * "골라 줘"보다 "답하면 codex 도 풀린다"가 사람을 움직인다(규칙 05).
   */
  unblocks: number;
  /** 교착이면 그 이유. 화면이 무엇을 고쳐야 하는지 말할 수 있어야 한다. */
  deadlockReason?: 'cycle' | 'dead-runner';
}

export interface WaitChainInput {
  messages: MessageRow[];
  myAccountId: string | null;
  /** 지금 살아 있는 에이전트들. `null` 은 '모른다' — `threadState` 와 같은 규약이다. */
  live: Liveness;
}

/**
 * 미답 ask 들을 이어 대기 사슬을 만든다(규칙 04 · 계획 Task 7).
 *
 * 사람이 "왜 아무것도 안 움직이지"를 묻지 않게 하는 것이 이 계산의 목적이다.
 * 에이전트끼리 주고받는 물음도 진행을 막지만 나를 막지는 않으므로, 강조가 아니라
 * **사슬**로 표시한다.
 *
 * ## 무엇을 잇는가
 *
 * 각 미답 ask 는 `낸 사람 → 답할 사람` 한 마디다. 그 마디들을 **답할 사람이 다시 무언가를
 * 기다리고 있으면** 이어 붙인다: `codex → forge → 나`.
 *
 * ## 순환은 즉시 끊는다
 *
 * A→B→A 는 방문 집합으로 막는다. **없으면 렌더에서 무한 루프가 터진다** — 이것이 이
 * 함수에서 가장 위험한 부분이고, 그래서 테스트로 고정한다.
 *
 * ## 죽은 러너를 기다리는 것도 교착이다
 *
 * 사슬의 끝이 **죽었다고 아는** 에이전트면 그 사슬은 아무 데도 닿지 않는다. `live` 가
 * `null`(모른다)이면 교착으로 부르지 않는다 — `threadState` 와 같은 이유로, 모른다는
 * 이유로 붉게 칠하는 것도 거짓말이다.
 */
export function waitChain(input: WaitChainInput): WaitChain {
  const { messages, myAccountId, live } = input;
  const links: WaitLink[] = [];

  for (const m of messages) {
    const ask = readAskMeta(m.meta);
    if (ask && ask.answeredWith == null) {
      links.push({
        waiter: m.authorId,
        blockedBy: ask.to.kind === 'human' ? null : ask.to.accountId,
        message: m,
        askedAt: m.createdAt,
      });
      continue;
    }

    /**
     * **위임도 마디다**(050 · 3-3). 팀장이 기다리는 팀원 하나마다 하나다.
     *
     * 이것이 없으면 사람은 *"왜 조용한지"* 를 볼 수 없다: 팀원이 죽어 기한(기본 10분)을
     * 기다리는 동안 스레드에는 팀장의 *"이렇게 나눴다"* 한 줄만 있고, 그 뒤는 아무 것도
     * 없다. 물음과 달리 위임은 **본문이 아니라 상태**라 그 침묵이 정상인지 막힌 것인지
     * 구별되지 않는다.
     *
     * 마디로 만들면 그 판정이 공짜로 따라온다 — `walk()` 가 사슬의 끝이 **죽었다고 아는**
     * 에이전트면 `deadlock('dead-runner')` 을 내고, 화면은 그것을 실패와 같은 무게로
     * 그린다(규칙 04). 팀장이 죽은 경우도 같은 길로 잡힌다.
     *
     * `message` 를 싣는 이유는 물음과 같다 — 사람이 그 줄을 눌러 무엇을 넘겼는지 읽을 수
     * 있어야 한다.
     */
    const delegation = readDelegationMeta(m.meta);
    if (delegation) {
      for (const blockedBy of delegation.open) {
        links.push({ waiter: m.authorId, blockedBy, message: m, askedAt: m.createdAt });
      }
    }
  }

  return walk(links, myAccountId, live);
}

/**
 * **집계로 만든 사슬**(#488 A3-b) — 스레드를 열지 않고도 낸다.
 *
 * `waitChain()` 은 답글 메시지를 훑어 마디를 만드는데, **채널 목록에는 답글이 없다**
 * (`controller.openThread` 로 스레드를 열 때만 로드된다). 그래서 서버가 마디를 미리
 * 만들어 실어 준다(`openAskLinks`).
 *
 * **판정은 여기서 갈리지 않는다** — 두 진입점이 같은 `walk()` 를 지난다. 슬라이스 1 의
 * `threadStateFromFacts` 와 같은 구조이고, 같은 이유다: 사슬이 스레드 안과 사이드바에서
 * 다른 말을 하면 어느 쪽을 믿어야 할지 알 수 없다.
 *
 * 재료가 없으면(옛 서버·답글 행) `null` 이다 — **'기다리는 것이 없다'가 아니다.**
 * 모르는 것을 안다고 말하지 않는다.
 */
export function waitChainFromLinks(input: {
  links: OpenAskLink[] | null;
  myAccountId: string | null;
  live: Liveness;
}): WaitChain | null {
  if (input.links === null) return null;
  return walk(
    input.links.map((l) => ({ waiter: l.waiter, blockedBy: l.blockedBy, askedAt: l.askedAt })),
    input.myAccountId,
    input.live,
  );
}

/**
 * 마디들을 이어 사슬 하나를 낸다. **두 진입점이 공유하는 유일한 판정**이다.
 */
function walk(links: WaitLink[], myAccountId: string | null, live: Liveness): WaitChain {
  /**
   * 계정 → 그 계정이 지금 내고 답을 못 받은 마디들. **배열이다**(2026-09-14).
   *
   * 전에는 `Map<waiter, 마디 하나>` 라 뒤엣것이 앞엣것을 덮었다. 그래서 팀장이 팀원 둘에게
   * 넘기면 화면에는 **하나만** 섰고, 더 나쁜 것은 판정이었다: 덮여서 남은 그 하나가 죽은
   * 러너이면 다른 갈래가 멀쩡해도 **교착**이라고 말했다.
   */
  const pendingByWaiter = new Map<string, WaitLink[]>();
  /** 답해야 하는 쪽 → 그를 기다리는 마디들. **사슬을 거꾸로 타기 위한 색인이다.** */
  const waitersOf = new Map<string, WaitLink[]>();
  for (const link of links) {
    const mine = pendingByWaiter.get(link.waiter) ?? [];
    mine.push(link);
    pendingByWaiter.set(link.waiter, mine);
    if (link.blockedBy !== null) {
      const bucket = waitersOf.get(link.blockedBy) ?? [];
      bucket.push(link);
      waitersOf.set(link.blockedBy, bucket);
    }
  }

  if (links.length === 0) return { links: [], end: 'none', unblocks: 0 };

  interface Branch { end: ChainEnd; path: WaitLink[]; reason?: WaitChain['deadlockReason'] }

  /**
   * 갈래 고르기의 **순서**다. 낮을수록 이긴다: `me` → `other` → `deadlock`.
   *
   * 이 순서가 곧 "한 가지가 죽었다고 교착이 아니다"라는 규칙이다. 팀장이 둘을 기다리는데
   * 하나는 죽고 하나는 나에게 닿으면 그것은 **내 차례**이지 교착이 아니다 — 내가 답하면
   * 무언가 풀린다. 반대로 뒤집으면 화면이 사람에게 "손쓸 수 없다"고 거짓말한다.
   *
   * 교착이 마지막인 이유도 같다: 모든 갈래가 막혔을 때만 그 말을 할 수 있다.
   */
  const rank: Record<ChainEnd, number> = { me: 0, other: 1, deadlock: 2, none: 3 };

  /**
   * 한 마디에서 시작해 **그 아래 가장 좋은 갈래**를 찾는다.
   *
   * `seen` 은 **이 경로에서** 이미 지난 사람들이다(전역 방문 집합이 아니다) — 전역으로 두면
   * 갈래 둘이 같은 계정을 지날 때 뒤에 본 갈래가 순환으로 오판된다. 이 줄이 없으면 A→B→A
   * 에서 렌더가 무한 루프로 터진다(그것이 이 계산에서 가장 위험한 부분이다).
   */
  const explore = (link: WaitLink, seen: ReadonlySet<string>): Branch => {
    if (seen.has(link.waiter)) return { end: 'deadlock', reason: 'cycle', path: [link] };
    const next = link.blockedBy;
    // 사람 아무나를 기다린다 — 내가 사람이면 여기가 내 차례다.
    if (next === null) return { end: myAccountId ? 'me' : 'other', path: [link] };
    if (next === myAccountId) return { end: 'me', path: [link] };
    // 답해야 하는 쪽이 죽었다고 **알면** 이 갈래는 아무 데도 닿지 않는다.
    if (live !== null && !live.has(next)) return { end: 'deadlock', reason: 'dead-runner', path: [link] };

    const branches = pendingByWaiter.get(next) ?? [];
    // 그 계정이 아무것도 안 기다린다 — 그 사람이/에이전트가 답할 차례다(나는 아니다).
    if (!branches.length) return { end: 'other', path: [link] };

    const deeper = new Set(seen).add(link.waiter);
    let best: Branch | null = null;
    for (const b of branches) {
      const found = explore(b, deeper);
      if (!best || rank[found.end] < rank[best.end]) best = found;
    }
    return { end: best!.end, reason: best!.reason, path: [link, ...best!.path] };
  };

  /**
   * 시작은 **가장 최근 마디를 낸 사람**이다 — 지금 무엇이 멈춰 있는지를 묻는 것이므로.
   * 그 사람이 여럿을 기다리면 **그 갈래들도 함께 본다**(뿌리에서부터 나무다).
   */
  const root = links[links.length - 1]!;
  const rootBranches = pendingByWaiter.get(root.waiter) ?? [root];
  let best: Branch | null = null;
  for (const b of rootBranches) {
    const found = explore(b, new Set());
    if (!best || rank[found.end] < rank[best.end]) best = found;
  }

  /** 고른 경로의 각 마디에 **가려진 갈래 수**를 붙인다(화면이 "외 N명"으로 말한다). */
  const chain = best!.path.map((l) => {
    const siblings = (pendingByWaiter.get(l.waiter)?.length ?? 1) - 1;
    return siblings > 0 ? { ...l, siblings } : l;
  });
  const end = best!.end;

  if (end === 'deadlock') {
    return { links: chain, end, unblocks: 0, deadlockReason: best!.reason };
  }
  if (end === 'me') {
    /**
     * **내가 답하면 몇 개가 풀리는가.** 사슬을 앞으로 탄 것(`chain`)만 세면 부족하다 —
     * 내가 답할 그 계정을 *기다리고 있던* 쪽들도 함께 풀리기 때문이다.
     * 그래서 답할 지점에서 **거꾸로** 훑어 도달 가능한 마디를 전부 센다. 나무가 되어도
     * 이 셈은 그대로다: `waitersOf` 는 원래 갈래를 전부 담고 있었다.
     */
    const answerTarget = chain[chain.length - 1]!;
    const counted = new Set<WaitLink>(best!.path);
    const queue = [answerTarget.waiter];
    const visited = new Set<string>();
    while (queue.length) {
      const who = queue.shift()!;
      if (visited.has(who)) continue;
      visited.add(who);
      for (const l of waitersOf.get(who) ?? []) {
        counted.add(l);
        queue.push(l.waiter);
      }
    }
    return { links: chain, end, unblocks: counted.size };
  }
  return { links: chain, end: 'other', unblocks: 0 };
}

/**
 * 사슬을 **한 문장**으로 — 채널 요약 줄의 말 슬롯(identity 문서 Task 13).
 *
 * ## 왜 `WaitChainLine` 을 그대로 쓰지 않는가
 *
 * 그 컴포넌트는 마디를 **전부** 이어 붙인다(`codex 가 forge의 답을 기다린다 ·
 * forge 가 사람의 답을 기다린다`). 스레드를 열어 놓고 보는 자리에서는 그것이 맞지만,
 * 채널 요약에서는 **문서가 금지한 명단**이 된다: *"이름은 대기 사슬의 양 끝일 때만
 * 쓴다 — 그래서 최대 둘, 참여자 수와 무관하다."*
 *
 * 일곱이 답한 스레드에서도 이 줄은 이름 **둘**만 쓴다. 얼굴이 "누가"를 이미 답하고
 * 있으므로 글자는 **"무엇을 기다리는가"** 만 말한다.
 *
 * ## 아무도 기다리지 않으면 이름이 아예 안 나온다
 *
 * 문서: *"아무도 기다리지 않으면 이름은 아예 안 나오고 숫자와 시각만 남는다."*
 * 그래서 `null` 을 낸다.
 */
export function chainEnds(chain: WaitChain): { waiter: string; blockedBy: string | null } | null {
  if (chain.end === 'none' || chain.links.length === 0) return null;
  // **양 끝**이다: 사슬을 시작한 쪽과, 마지막으로 답을 기다려지는 쪽.
  // 가운데 마디들은 이름을 받지 않는다 — 그것이 명단이 되는 지점이다.
  const first = chain.links[0]!;
  const last = chain.links[chain.links.length - 1]!;
  return { waiter: first.waiter, blockedBy: last.blockedBy };
}

// ---------------------------------------------------------------------------
// 사슬을 **사람이 읽는 말**로 — 번역기를 인자로 받는다
// ---------------------------------------------------------------------------

/**
 * 계정 id 를 화면에 쓸 이름으로. `null` 은 '사람 아무나'다.
 *
 * 화면이 넘긴다 — 이름은 스토어(`accounts`)에서 오고 `lib/` 는 스토어를 모른다.
 */
export type NameOf = (accountId: string | null) => string;

/**
 * 사슬 문장들 — **`WaitChainLine` 이 이어 붙일 조각**.
 *
 * ## 왜 이 함수가 `lib/` 에 있나 (i18n 구조 판단 (b))
 *
 * 원래 이 문장 조립은 `WaitChain.tsx` 안에 있었고 조사(`subjectParticle`)를 화면이
 * 손으로 붙였다. 영어를 원본으로 두는 순간 그 모양이 무너진다 — 영어에는 조사가 없고
 * **어순이 다르다**(`A가 B의 답을 기다린다` / `A is waiting for B`). 조각을 화면이
 * 이으면 언어마다 이을 방법이 달라지므로, **문장 전체를 사전이 갖고** 화면은 채우기만
 * 한다.
 *
 * 그러면 그 채우기는 어디서 하나. 이 저장소의 규율은 **판정과 렌더를 가른다**
 * (`threadState`·`faceState`·`inboxRow` 가 전부 `lib/` 에 있고 화면은 그리기만 한다).
 * 문장을 고르는 것은 판정 쪽이다 — 어떤 마디가 `linkAnyone` 이고 어떤 것이 `link`
 * 인지는 **`blockedBy` 가 null 인가**라는 판정이고, 그것을 화면에 두면 두 화면
 * (스레드 패널·인박스)이 각자 판정하게 된다.
 *
 * **`t` 를 인자로 받는다**(후보 (b)). 그래서 이 함수는 여전히 순수하고 React 를
 * 모른다 — 시험이 `translator('en')` 을 그냥 넘긴다. 후보 (a)(키와 인자만 내기)를
 * 버린 이유는 `i18n/index.ts::Translate` 머리말에 있다: 이 저장소의 회귀선은 키가
 * 아니라 **사람이 읽는 문구**를 재고, 키만 내면 그 의도를 잃는다.
 */
export function chainSentences(chain: WaitChain, name: NameOf, t: Translate): string[] {
  return chain.links.map((l) => {
    if (l.blockedBy === null) {
      // '사람 아무나'는 특정인을 기다리는 것과 **다른 문장**이다. 한국어에서는 이름
      // 자리에 보통명사를 끼우면 조사가 어긋나서 갈랐고(실측 회귀선), 영어에서도
      // `waiting for someone to answer` 가 `waiting for someone` 보다 곧다.
      return t('waitChain.linkAnyone', { waiter: name(l.waiter) });
    }
    /**
     * **여럿을 기다리면 수로 말한다**(2026-09-14). 이름을 전부 적으면 그것이 명단이고,
     * 이 줄의 규율은 *"이름은 양 끝일 때만"* 이다(`chainEnds` 의 그 문단). 그래도
     * "하나만 기다린다"는 거짓을 말하지 않으려면 나머지가 **있다는 사실**은 나와야 한다.
     */
    if (l.siblings) {
      return t('waitChain.linkMany', {
        waiter: name(l.waiter), blockedBy: name(l.blockedBy), count: l.siblings,
      });
    }
    return t('waitChain.link', { waiter: name(l.waiter), blockedBy: name(l.blockedBy) });
  });
}

/**
 * 교착 한 문장. **두 이유가 다른 문장인 이유는 사람이 할 일이 다르기 때문이다** —
 * 서로를 기다리는 것은 끊어야 하고, 죽은 러너는 다시 띄워야 한다.
 */
export function deadlockSentence(chain: WaitChain, name: NameOf, t: Translate): string {
  const head = chain.links[0]!;
  if (chain.deadlockReason === 'cycle') {
    return t('waitChain.deadlockCycle', {
      names: chain.links.map((l) => name(l.waiter)).join(' ↔ '),
    });
  }
  return t('waitChain.deadlockDeadRunner', {
    waiter: name(head.waiter),
    blockedBy: name(head.blockedBy),
  });
}

/**
 * **몇 개가 풀리는지.** 둘 이상일 때만 문장이 있다 — 하나뿐이면 "답하면 1개가 풀린다"는
 * 정보가 아니라 잡음이고, 그 물음 자체가 이미 그 말을 하고 있다.
 *
 * 그래서 `null` 을 낼 수 있다. 화면이 그 문턱을 다시 쓰지 않게 **판정을 여기 둔다** —
 * 두 화면이 각자 들고 있으면 한쪽만 고쳐질 수 있다.
 */
export function unblocksSentence(chain: WaitChain, t: Translate): string | null {
  if (chain.end !== 'me' || chain.unblocks <= 1) return null;
  return t('waitChain.unblocks', { count: chain.unblocks });
}
