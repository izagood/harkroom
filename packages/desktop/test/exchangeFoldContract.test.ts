import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageRow } from '@harkroom/shared';
import {
  groupAgentExchanges, exchangeParticipants, exchangeConclusion, exchangeLastLine, firstLine,
  type ExchangeSlot,
} from '../src/lib/agentExchange';
import { groupProgress, type Slot } from '../src/lib/progressGroup';

/**
 * **주고받기 접힘의 계약** — 데스크톱(`lib/agentExchange.ts`)과 모바일(`apps/mobile/lib/screens/
 * agent_exchange.dart`)이 **같은 글을 접는다**는 것을 이 표 하나가 지킨다.
 *
 * `mentionCases.json` 과 같은 판례다: 여기(TS)가 **원본**이고 표의 답은 손으로 적지 않는다 —
 * 입력(`CASES`)만 손으로 적고, 답은 지금 구현이 낸다. 그래서
 *
 * - 데스크톱 판정을 **모르고** 바꾸면 여기가 먼저 빨개진다.
 * - **일부러** 바꿨다면 `UPDATE_EXCHANGE_FOLD_CASES=1 npx vitest run test/exchangeFoldContract.test.ts`
 *   로 표를 다시 뽑는다. 그러면 Dart 쪽(`apps/mobile/test/agent_exchange_contract_test.dart`)이
 *   빨개지고, 모바일 포팅을 안 고쳤다는 사실이 사람보다 CI 에게 먼저 보인다.
 */

const FIXTURE = join(import.meta.dirname, 'fixtures', 'exchangeFoldCases.json');

// 멘션 토큰(`<@id>`)은 36 자 uuid 만 받는다 — 짧은 id 로는 멘션 갈래가 엉뚱한 이유로 통과한다.
const HUMAN = '11111111-1111-4111-8111-111111111111';
const HUMAN2 = '11111111-1111-4111-8111-222222222222';
const FORGE = '22222222-2222-4222-8222-222222222222';
const CODEX = '33333333-3333-4333-8333-333333333333';
const SCRIBE = '44444444-4444-4444-8444-444444444444';
/** 목록에 없는 계정 — 에이전트로 치지 않는다(사람 쪽으로 센다). */
const STRANGER = '55555555-5555-4555-8555-555555555555';
const AGENTS = [FORGE, CODEX, SCRIBE];

interface In {
  id: string;
  authorId: string;
  kind?: 'user' | 'progress' | 'wake' | 'system';
  body?: string;
  meta?: Record<string, unknown>;
  attachments?: number;
}
interface Case { name: string; rootId?: string; messages: In[] }

const ask = (to: unknown, extra: Record<string, unknown> = {}, n = 2) => ({
  kind: 'ask',
  ask: { options: [{ id: 'a', label: '첫째 안' }, { id: 'b', label: '둘째 안' }, { id: 'c', label: 'C' }].slice(0, n), to, ...extra },
});
const fail = (retryable: unknown) => ({ kind: 'failure', failure: { what: '못 했다', retryable } });
const report = (checks: unknown) => ({ kind: 'report', report: { checks } });
const deleg = (to: unknown, open?: unknown) => ({
  kind: 'delegation',
  delegation: { to, unreachable: [], deadlineAt: '2026-10-13T00:00:00.000Z', ...(open === undefined ? {} : { open }) },
});
const wake = { kind: 'wake', wake: { wakeAt: '2026-10-13T01:00:00.000Z' } };

const F = (id: string, body = `${id} 말`, rest: Partial<In> = {}): In => ({ id, authorId: FORGE, body, ...rest });
const C = (id: string, body = `${id} 말`, rest: Partial<In> = {}): In => ({ id, authorId: CODEX, body, ...rest });
const S = (id: string, body = `${id} 말`, rest: Partial<In> = {}): In => ({ id, authorId: SCRIBE, body, ...rest });
const H = (id: string, body = `${id} 사람 말`, rest: Partial<In> = {}): In => ({ id, authorId: HUMAN, body, ...rest });
const P = (id: string, authorId: string): In => ({ id, authorId, kind: 'progress', body: '진행' });
const W = (id: string, authorId: string): In => ({ id, authorId, kind: 'wake', body: 'will check again', meta: wake });

const CASES: Case[] = [
  { name: '에이전트 둘이 주고받으면 접힌다', messages: [F('m1'), C('m2'), F('m3')] },
  { name: '혼잣말은 접지 않는다', messages: [F('m1'), F('m2'), F('m3')] },
  { name: '말 하나는 접지 않는다', messages: [F('m1'), P('p1', CODEX)] },
  { name: '사람이 끼면 구간이 끊긴다', messages: [F('m1'), C('m2'), H('h1', '그만'), F('m3', 'm3 <@11111111-1111-4111-8111-111111111111> 알겠다'), C('m4'), F('m5')] },
  { name: '사람이 부른 뒤 각 에이전트의 첫 답은 펼친다', messages: [H('h1'), F('m1'), C('m2'), S('m3'), F('m4'), C('m5'), S('m6')] },
  { name: '사람이 말한 적 없으면 첫 답 예외가 없다', messages: [F('m1'), C('m2'), S('m3')] },
  { name: '실패는 접지 않는다', messages: [F('m1'), C('m2'), F('m3', '못 했다', { meta: fail(true) }), C('m4'), F('m5')] },
  { name: 'retryable 이 boolean 이 아닌 실패는 실패로 안 읽는다', messages: [F('m1'), C('m2', '못 했다', { meta: fail('yes') }), F('m3')] },
  { name: '사람에게 온 미답 선택은 접지 않는다', messages: [F('m1'), C('m2'), F('m3', '고를까', { meta: ask({ kind: 'human' }) }), C('m4'), F('m5')] },
  { name: '답한 선택은 접히고 결론이 된다', messages: [F('m1'), C('m2', '고를까', { meta: ask({ kind: 'human' }, { answeredWith: 'b', answeredBy: HUMAN }) }), F('m3')] },
  { name: '닫힌 선택도 접힌다', messages: [F('m1'), C('m2', '고를까', { meta: ask({ kind: 'human' }, { closedAt: '2026-10-13T00:00:00.000Z' }) }), F('m3')] },
  { name: '에이전트에게 간 선택은 접힌다', messages: [F('m1'), C('m2', '고를까', { meta: ask({ kind: 'account', accountId: FORGE }) }), F('m3')] },
  { name: '선택지 하나짜리 ask 는 선택이 아니다', messages: [F('m1'), C('m2', '이거', { meta: ask({ kind: 'human' }, {}, 1) }), F('m3')] },
  { name: '수신자를 못 읽는 ask 는 선택이 아니다', messages: [F('m1'), C('m2', '이거', { meta: ask({ kind: 'team' }) }), F('m3')] },
  { name: '보고가 결론이 된다', messages: [F('m1'), C('m2', '끝', { meta: report(['테스트\n  통과', '둘째']) }), F('m3')] },
  { name: '빈 checks 보고는 결론이 아니다', messages: [F('m1'), C('m2', '끝', { meta: report([]) }), F('m3', '**마지막** 말이다')] },
  { name: '빈 글자가 섞인 checks 보고는 결론이 아니다', messages: [F('m1'), C('m2', '끝', { meta: report(['', '둘째']) }), F('m3')] },
  { name: '사람 멘션은 접지 않는다', messages: [F('m1'), C('m2', '<@11111111-1111-4111-8111-222222222222> 확인 부탁'), F('m3')] },
  { name: '모르는 계정 멘션도 사람으로 센다', messages: [F('m1'), C('m2', '<@55555555-5555-4555-8555-555555555555> 봐'), F('m3')] },
  { name: '코드 안 멘션은 부름이 아니다', messages: [F('m1'), C('m2', '이렇게 쓴다 `<@11111111-1111-4111-8111-111111111111>`'), F('m3', '```\n<@11111111-1111-4111-8111-111111111111>\n```')] },
  { name: '인용 안 멘션은 부름이 아니다', messages: [F('m1'), C('m2', '> <@11111111-1111-4111-8111-111111111111> 가 말했다\n그래서'), F('m3')] },
  { name: '자기 멘션·에이전트 멘션은 사람이 아니다', messages: [F('m1', '<@22222222-2222-4222-8222-222222222222> 나다'), C('m2', '<@22222222-2222-4222-8222-222222222222> 너에게'), F('m3')] },
  { name: '위임은 사람의 차례를 닫는다', messages: [H('h1'), F('d1', '나눴다', { meta: deleg([CODEX, SCRIBE]) }), C('m2'), S('m3'), F('m4', '<@11111111-1111-4111-8111-111111111111> 최종 답')] },
  { name: 'to 가 배열이 아닌 위임은 위임이 아니다', messages: [H('h1'), F('d1', '나눴다', { meta: deleg('codex') }), C('m2'), S('m3')] },
  { name: 'open 이 없는 옛 위임도 위임이다', messages: [H('h1'), F('d1', '나눴다', { meta: deleg([CODEX], undefined) }), C('m2'), S('m3')] },
  { name: '진행은 구간을 끊지 않는다', messages: [F('m1'), P('p1', CODEX), P('p2', CODEX), C('m2'), P('p3', FORGE), F('m3')] },
  { name: '진행만 남긴 에이전트는 참여자가 아니다', messages: [F('m1'), P('p1', CODEX), F('m2')] },
  { name: '맨 끝에 도는 진행은 구간 밖', messages: [F('m1'), C('m2'), P('p1', FORGE), P('p2', CODEX)] },
  { name: '맨 끝 진행이라도 끝났으면 구간 안', messages: [F('m1'), P('p1', CODEX), C('m2'), F('m3')] },
  { name: '남의 글 너머의 진행도 같은 저자의 다음 말이 닫는다', messages: [P('p1', FORGE), C('m1'), S('m2'), F('m3'), P('p2', CODEX)] },
  { name: '예약 줄은 구간 안, 세지 않는다', messages: [F('m1'), W('w1', CODEX), C('m2'), W('w2', FORGE)] },
  { name: '예약 줄은 첫 답 장부를 안 쓴다', messages: [H('h1'), W('w1', FORGE), F('m1'), C('m2'), F('m3'), C('m4')] },
  { name: '예약 줄만으로는 접지 않는다', messages: [F('m1'), W('w1', CODEX), W('w2', FORGE)] },
  { name: '에이전트 루트는 접지 않는다', rootId: 'r', messages: [F('r', '스레드 시작'), C('m1'), F('m2'), C('m3')] },
  { name: '사람 루트', rootId: 'r', messages: [H('r', '@forge @codex 봐 줘'), F('m1'), C('m2'), F('m3')] },
  { name: '사람 원글에서 에이전트 둘을 부르면 각자 첫 답은 펼친다', rootId: 'r', messages: [H('r', '<@22222222-2222-4222-8222-222222222222> <@33333333-3333-4333-8333-333333333333> 봐 줘'), F('m1', '봤다'), C('m2', '나도 봤다'), F('m3'), C('m4')] },
  { name: '사람 루트 뒤 사람 말', rootId: 'r', messages: [H('r'), F('m1'), H('h1'), F('m2'), C('m3'), F('m4'), C('m5')] },
  { name: '시스템 줄도 말이다', messages: [F('m1'), { id: 's1', authorId: CODEX, kind: 'system', body: '시스템' }, F('m2')] },
  { name: '첨부만 있는 마지막 말', messages: [F('m1'), C('m2', '', { attachments: 2 })] },
  { name: '빈 마지막 말', messages: [F('m1'), C('m2', '   ')] },
  { name: '모르는 저자는 사람이다', messages: [F('m1'), { id: 'x1', authorId: STRANGER, body: '누구' }, C('m2'), F('m3')] },
  { name: '긴 대화', messages: [H('h1'), F('m1'), C('m2'), P('p1', FORGE), F('m3'), C('m4'), W('w1', FORGE), S('m5'), C('m6', '끝', { meta: report(['배포 확인']) }), F('m7'), H('h2', '고마워'), F('m8'), C('m9'), F('m10'), P('p2', CODEX)] },
];

/** 첫 줄 판정 표 — 접힌 줄의 「handle: 첫 줄」이 두 화면에서 같아야 한다. */
const FIRST_LINES: string[] = [
  '그냥 한 줄',
  '@forge @codex, 머리 멘션은 뺀다',
  '@forge\n@codex\n둘째 줄이 첫 줄',
  '가운데 @forge 는 말의 일부',
  '```\ncode\n```\n코드 뒤',
  '~~~\nx\n~~~\n물결 울타리 뒤',
  '> 인용\n인용 뒤',
  '---\n가로줄 뒤',
  '* * *\n별 가로줄 뒤',
  '| 칸 | 둘 |\n|---|:--:|\n| a | b |',
  '|---|---|\n| 구분 먼저 |',
  '# 제목',
  '## **굵은** 제목',
  '- 목록 하나',
  '1. 번호 목록',
  '2) 괄호 번호',
  '[링크 글](https://example.com) 과 ![그림](x.png)',
  '`코드` 와 ~~취소~~ 와 __밑줄__',
  '*기울임* 과 _밑줄 기울임_',
  'snake_case_name 은 그대로',
  '   \n\n  공백 뒤 줄  ',
  '여러    칸   공백',
  '',
  '@forge',
  '@forge\n',
  `${'가'.repeat(600)}`,
  '이모지 🎉 와 한글',
  '  > 들여쓴 인용\n본문',
  '@forge, @codex 쉼표 머리',
];

const MSG_DEFAULTS = {
  channelId: 'c1', threadRootId: null, editedAt: null, reactions: [], replyCount: null, activityCount: null,
  lastReplyAt: null, participantIds: null, openAskHumanCount: null, openAskAccountIds: null, openAskLinks: null,
  failureCount: null, unresolvedFailureCount: null, lastKind: null, lastAuthorId: null, alsoInChannel: false,
  deletedAt: null,
};

function toRow(m: In, i: number): MessageRow {
  return {
    ...MSG_DEFAULTS,
    id: m.id, seq: i + 1, authorId: m.authorId, body: m.body ?? '', kind: m.kind ?? 'user', meta: m.meta ?? {},
    // 1분 간격 — 진행의 `endedAt` 이 같은 시각끼리 비교되지 않게 한다.
    createdAt: new Date(Date.UTC(2026, 9, 13, 0, i)).toISOString(),
    attachments: Array.from({ length: m.attachments ?? 0 }, (_, k) => ({ id: `${m.id}-att${k}` })),
  } as unknown as MessageRow;
}

/** 슬롯을 비교할 수 있는 모양으로 — id 만 남긴다. */
function encodeSlot(s: Slot): unknown {
  return s.kind === 'message'
    ? { message: s.message.id }
    : { progress: s.messages.map((m) => m.id), endedAt: s.endedAt };
}
function encode(s: ExchangeSlot): unknown {
  if (s.kind !== 'exchange') return encodeSlot(s);
  return {
    exchange: s.items.map(encodeSlot),
    participants: exchangeParticipants(s.messages),
    conclusion: exchangeConclusion(s.messages),
    lastLine: exchangeLastLine(s.messages, (m) => m.body),
  };
}

function compute() {
  const isAgent = (id: string) => AGENTS.includes(id);
  return {
    agents: AGENTS,
    cases: CASES.map((c) => {
      const rows = c.messages.map(toRow);
      return {
        name: c.name,
        rootId: c.rootId ?? null,
        messages: rows.map((r) => ({
          id: r.id, seq: r.seq, authorId: r.authorId, body: r.body, kind: r.kind, meta: r.meta,
          createdAt: r.createdAt, attachments: r.attachments,
        })),
        slots: groupAgentExchanges(groupProgress(rows), isAgent, c.rootId).map(encode),
      };
    }),
    firstLines: FIRST_LINES.map((body) => ({ body, line: firstLine(body) })),
  };
}

describe('주고받기 접힘 계약 (데스크톱 ↔ 모바일 공용 표)', () => {
  const now = compute();
  if (process.env.UPDATE_EXCHANGE_FOLD_CASES === '1') {
    writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ReturnType<typeof compute>;

  it('표가 지금 데스크톱 구현과 같다', () => {
    expect(
      fixture,
      '판정을 일부러 바꿨다면 UPDATE_EXCHANGE_FOLD_CASES=1 로 표를 다시 뽑고 모바일 포팅(agent_exchange.dart)도 고쳐라',
    ).toEqual(now);
  });

  it('표가 지키는 갈래가 실제로 들어 있다', () => {
    // 표가 "아무것도 안 접힌다" 같은 시시한 것으로 줄면 위 시험은 초록인데 아무것도 못 지킨다.
    const kinds = fixture.cases.flatMap((c) => c.slots.map((s) => Object.keys(s as object)[0]));
    expect(kinds.filter((k) => k === 'exchange').length).toBeGreaterThan(10);
    expect(fixture.cases.filter((c) => !c.slots.some((s) => 'exchange' in (s as object))).length).toBeGreaterThan(6);
    expect(fixture.firstLines.length).toBeGreaterThan(20);
  });
});
