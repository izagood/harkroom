// Task 4 — 진행(progress)을 상태 한 줄로 접는다(#144, 규칙 02).
//
// `kind='progress'` 는 이미 서버에 있고 러너가 `message.progress` 로 보내는데, 데스크탑이
// 특별히 그리지 않아 **일반 발화로 흘렀다** — 규칙 02("로그가 아니라 사람의 말")가 새고 있던
// 자리다. 이 파일은 그 구멍이 다시 열리지 않게 잠근다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { ProgressRow } from '../src/components/ProgressRow';
import { groupProgress, elapsedLabel } from '../src/lib/progressGroup';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';

const prog = (id: string, body: string, authorId = FORGE, createdAt?: string): MessageRow =>
  msg(id, 'c1', 1, body, authorId, { kind: 'progress', ...(createdAt ? { createdAt } : {}) });

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      // 소유자가 나인 에이전트 — 터미널 링크가 뜬다.
      [FORGE]: acc(FORGE, 'forge', 'agent', false, { ownerAccountId: ME }),
      // 소유자가 남인 에이전트 — 링크가 **없어야** 한다.
      [CODEX]: acc(CODEX, 'codex', 'agent', false, { ownerAccountId: 'someone-else' }),
    },
  });
});
afterEach(() => cleanup());

describe('groupProgress — 무엇이 한 묶음인가', () => {
  it('같은 저자의 연속 progress 를 하나로 접는다', () => {
    const slots = groupProgress([prog('p1', 'a'), prog('p2', 'b'), prog('p3', 'c')]);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.kind).toBe('progress');
    expect(slots[0]!.kind === 'progress' && slots[0]!.messages).toHaveLength(3);
  });

  it('사이에 사람의 발화가 끼면 묶음이 갈린다', () => {
    const slots = groupProgress([
      prog('p1', 'a'), prog('p2', 'b'),
      msg('u1', 'c1', 3, '잠깐, 그거 말고', ME),
      prog('p3', 'c'),
    ]);
    // 진행 · 발화 · 진행 — 세 자리다. 발화 앞뒤는 다른 구간이다.
    expect(slots.map((s) => s.kind)).toEqual(['progress', 'message', 'progress']);
    expect(slots[0]!.kind === 'progress' && slots[0]!.messages).toHaveLength(2);
    expect(slots[2]!.kind === 'progress' && slots[2]!.messages).toHaveLength(1);
  });

  it('저자가 바뀌면 묶음이 갈린다 — 누가 무엇을 하는지가 사라지면 안 된다', () => {
    const slots = groupProgress([prog('p1', 'a', FORGE), prog('p2', 'b', CODEX)]);
    expect(slots).toHaveLength(2);
  });

  it('progress 가 없으면 원래 목록 그대로다', () => {
    const slots = groupProgress([msg('u1', 'c1', 1, '안녕', ME), msg('u2', 'c1', 2, '응', FORGE)]);
    expect(slots.map((s) => s.kind)).toEqual(['message', 'message']);
  });
});

describe('elapsedLabel — 경과는 묶음의 시작부터', () => {
  const t0 = new Date('2026-09-06T00:00:00.000Z').getTime();
  it('1분 미만은 숫자를 붙이지 않는다 — 0분째는 정보가 아니라 잡음이다', () => {
    expect(elapsedLabel('2026-09-06T00:00:00.000Z', t0 + 30_000)).toBeNull();
  });
  it('분과 시간을 사람이 읽는 말로 준다', () => {
    expect(elapsedLabel('2026-09-06T00:00:00.000Z', t0 + 3 * 60_000)).toBe('3분째');
    expect(elapsedLabel('2026-09-06T00:00:00.000Z', t0 + 90 * 60_000)).toBe('1시간째');
  });
});

describe('ProgressRow — 상태 한 줄', () => {
  it('본문이 아니라 저자 + 작업 중을 그리고, 펼치면 접힌 줄이 보인다', () => {
    render(<ProgressRow messages={[prog('p1', '파일을 읽는다'), prog('p2', '테스트를 돌린다')]} />);

    expect(screen.getByTestId('progress-row')).toBeTruthy();
    expect(screen.getByText('forge')).toBeTruthy();
    expect(screen.getByText('작업 중')).toBeTruthy();
    // **본문은 기본으로 안 보인다** — progress 본문은 요약의 재료이지 발화가 아니다.
    expect(screen.queryByText('파일을 읽는다')).toBeNull();
    expect(screen.queryByTestId('progress-detail')).toBeNull();

    // 다만 버리지도 않는다 — 펼치면 러너가 남긴 진행 기록이 그대로 있다.
    fireEvent.click(screen.getByTestId('progress-expand'));
    expect(screen.getByTestId('progress-detail')).toBeTruthy();
    expect(screen.getByText('파일을 읽는다')).toBeTruthy();
    expect(screen.getByText('테스트를 돌린다')).toBeTruthy();
  });

  it('한 줄뿐이면 펼치기를 그리지 않는다 — 접힌 것이 없다', () => {
    render(<ProgressRow messages={[prog('p1', '혼자')]} />);
    expect(screen.queryByTestId('progress-expand')).toBeNull();
  });

  it('소유자가 아니면 터미널 링크가 없다 — 비활성이 아니라 부재다', () => {
    render(<ProgressRow messages={[prog('p1', 'a', CODEX)]} />);
    // 남의 러너 셸이 여기 있다는 사실 자체가 새면 안 된다(`TerminalChip` 주석).
    expect(screen.queryByText('터미널 보기')).toBeNull();
  });

  it('소유자에게는 터미널 링크가 있다', () => {
    render(<ProgressRow messages={[prog('p1', 'a', FORGE)]} />);
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });
});

/**
 * **끝난 진행은 "작업 중" 이라고 말하지 않는다** (2026-09-07 후속).
 *
 * 그날 15:15 에 사용자가 화면을 보고 물은 것이 `죽었나 도나?` 였다. 화면은 이랬다:
 *
 * ```
 * ● mumur  작업 중 · 11분째   2줄 펼치기   터미널 보기
 * mumur  (답 없이 턴을 끝냈습니다 — 프로세스는 정상 종료, 발화 없음)   오후 03:08
 * ```
 *
 * 턴은 15:08 에 끝났는데 그 위의 줄은 15:04 부터 **계속 자라고 있었다** — 경과가
 * `elapsedLabel(first.createdAt, Date.now())` 였기 때문이다. 즉 화면이 거짓을 말했다:
 * 끝난 것을 도는 것으로 그리고, 그 숫자는 볼 때마다 커진다.
 *
 * 판정을 `groupProgress` 에 두는 이유는 그 함수의 주석과 같다 — 채널과 스레드 두 곳이
 * 같은 묶음을 그려야 하고, 컴포넌트 안에 두면 두 곳이 조용히 갈라진다.
 */
const AT_P1 = '2026-09-07T06:04:00.000Z';
const AT_P2 = '2026-09-07T06:05:00.000Z';
const AT_END = '2026-09-07T06:08:00.000Z';

/** 평범한 발화 하나. 진행 묶음을 끊는(그리고 끝내는) 쪽이다. */
const said = (id: string, body: string, authorId = FORGE, createdAt = AT_END): MessageRow =>
  msg(id, 'c1', 1, body, authorId, { createdAt });

describe('groupProgress — 무엇이 그 진행을 끝내는가', () => {
  it('같은 저자의 다음 발화가 끝낸다', () => {
    const slots = groupProgress([
      prog('p1', '파일을 읽는다', FORGE, AT_P1),
      prog('p2', '테스트를 돌린다', FORGE, AT_P2),
      said('m1', '다 했습니다'),
    ]);
    expect(slots[0]!.kind).toBe('progress');
    expect((slots[0] as { endedAt: string | null }).endedAt).toBe(AT_END);
  });

  /**
   * 사람이 끼어드는 것으로는 끝나지 않는다 — 러너는 그 사이에도 계속 돌고 있다.
   * 여기서 끝났다고 그리면 도는 것을 끝난 것으로 말하는, 반대 방향의 거짓이 된다.
   */
  it('다른 저자의 발화는 끝내지 않는다', () => {
    const slots = groupProgress([
      prog('p1', '파일을 읽는다', FORGE, AT_P1),
      said('m1', '어떻게 돼가?', ME),
    ]);
    expect((slots[0] as { endedAt: string | null }).endedAt).toBeNull();
  });

  it('뒤에 아무것도 없으면 아직 도는 것이다', () => {
    const slots = groupProgress([prog('p1', '파일을 읽는다', FORGE, AT_P1)]);
    expect((slots[0] as { endedAt: string | null }).endedAt).toBeNull();
  });
});

describe('ProgressRow — 끝난 묶음', () => {
  it('끝난 묶음은 "작업 중" 이라고 말하지 않고 경과를 고정한다', () => {
    render(
      <ProgressRow
        messages={[prog('p1', '파일을 읽는다', FORGE, AT_P1), prog('p2', '테스트를 돌린다', FORGE, AT_P2)]}
        endedAt={AT_END}
      />,
    );

    const row = screen.getByTestId('progress-row');
    expect(row.textContent).not.toContain('작업 중');
    // 첫 progress(06:04)부터 끝(06:08)까지 — `Date.now()` 가 아니라 **끝난 시각**으로 잰다.
    expect(row.textContent).toContain('4분');
    expect(row.textContent).not.toContain('째');
    // 접힌 줄과 터미널로 가는 길은 그대로다 — 끝났다고 기록이 사라지지는 않는다.
    expect(screen.getByTestId('progress-expand')).toBeTruthy();
  });

  it('도는 묶음은 그대로 "작업 중" 이다 (회귀)', () => {
    render(
      <ProgressRow
        messages={[prog('p1', '파일을 읽는다', FORGE, AT_P1), prog('p2', '테스트', FORGE, AT_P2)]}
        endedAt={null}
      />,
    );
    expect(screen.getByTestId('progress-row').textContent).toContain('작업 중');
  });
});

/**
 * **배선 회귀선** — 채널과 스레드가 그 값을 실제로 넘기는가.
 *
 * 판정(`groupProgress`)과 표시(`ProgressRow`)는 위에서 각각 잰다. 두 호출부가 슬롯의
 * `endedAt` 을 **넘기지 않으면** 기본값 `null` 이 들어가 화면은 고치기 전과 똑같다 —
 * 초록으로 지나가는 실패다. 그리고 이 저장소는 같은 종류의 누락(한쪽 호출부만 고침)을
 * 반복해 고쳤다(`groupProgress` 주석의 "두 곳이 조용히 갈라진다").
 */
describe('endedAt 배선', () => {
  it('채널과 스레드가 슬롯의 endedAt 을 ProgressRow 로 넘긴다', async () => {
    // `import.meta.url` 을 쓰지 않는다 — 이 파일은 jsdom 환경에서 돌고 그때 그 값이
    // file 스킴이 아니라 `readFile` 이 거절한다(실측: "The URL must be of scheme file").
    const src = (name: string) => join(process.cwd(), 'src/components', name);
    const [channel, thread] = await Promise.all([
      readFile(src('ChannelPane.tsx'), 'utf8'),
      readFile(src('ThreadPanel.tsx'), 'utf8'),
    ]);
    expect(channel).toMatch(/<ProgressRow[^>]*endedAt=\{slot\.endedAt\}/s);
    expect(thread).toMatch(/<ProgressRow[^>]*endedAt=\{slot\.endedAt\}/s);
  });
});
