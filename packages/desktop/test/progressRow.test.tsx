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
import { groupProgress, elapsedMs } from '../src/lib/progressGroup';
import { durationLabel, runningLabel, tookLabel } from '../src/lib/time';
import { translator } from '../src/i18n';
import { usePrefsStore } from '../src/state/prefsStore';
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
  // **언어를 고정한다**(`#619` 후속으로 경과가 앱 언어를 따른다). 이 파일이 재는 것은
  // 진행이 상태 한 줄로 접히는가이지 그 문구의 언어가 아니다.
  usePrefsStore.getState().setLocale('ko');
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
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

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

describe('elapsedMs — 경과는 묶음의 시작부터, 그리고 말할 만한가', () => {
  const t0 = new Date('2026-09-06T00:00:00.000Z').getTime();
  const at = (ms: number) => elapsedMs('2026-09-06T00:00:00.000Z', t0 + ms);

  it('1분 미만은 숫자를 붙이지 않는다 — 0분째는 정보가 아니라 잡음이다', () => {
    expect(at(30_000)).toBeNull();
  });

  /**
   * **서식이 아니라 정책만 남았다**(`#619` 후속). 이 함수가 내던 `3분째` 는
   * `lib/time.ts::runningLabel` 로 갔다 — `daemonFacts.ts` 에 같은 이름의 함수가
   * 두 벌로 있던 것을 그쪽 하나로 합쳤기 때문이다(그 함수 주석의 표).
   *
   * 여기 남는 것은 **말할 만한가**이고, 그 문구는 아래 `runningLabel` 축이 잰다.
   */
  it('1분이 넘으면 그 길이를 그대로 준다 — 자르는 것은 서식의 일이다', () => {
    expect(at(3 * 60_000)).toBe(3 * 60_000);
    expect(at(90 * 60_000)).toBe(90 * 60_000);
  });
});

/**
 * **`3분` 과 `3분째` 는 다른 사실이다** — `lib/time.ts` 가 그 둘을 사전 항목 둘로 가른
 * 이유를 잠근다.
 *
 * 이전 코드는 `ProgressRow` 에서 `elapsed.replace(/째$/, '')` 로 끝난 묶음의 어미를
 * 잘랐다. 한국어 어미를 정규식으로 자르는 것이라 **다른 언어에서는 아무것도 안 잘리고**,
 * 영어 화면이 도는 진행과 끝난 진행을 같은 글자로 말하게 된다. 그 결함이 다시 들어오지
 * 않게 **두 언어 모두**에서 둘이 갈리는 것을 잰다.
 */
describe('runningLabel · tookLabel — 상[aspect]은 언어마다 다른 문법으로 온다', () => {
  const ko = translator('ko');
  const en = translator('en');
  const THREE_MIN = 3 * 60_000;

  it('한국어는 어미로 가른다', () => {
    expect(runningLabel(THREE_MIN, 'ko', ko)).toBe('3분째');
    expect(tookLabel(THREE_MIN, 'ko', ko)).toBe('3분');
  });

  it('영어는 말을 앞에 세워 가른다 — 어미가 없다', () => {
    expect(runningLabel(THREE_MIN, 'en', en)).toBe('running 3m');
    expect(tookLabel(THREE_MIN, 'en', en)).toBe('took 3m');
  });

  it('두 언어 모두에서 도는 것과 끝난 것이 **다른 글자**다', () => {
    for (const [locale, t] of [['ko', ko], ['en', en]] as const) {
      expect(runningLabel(THREE_MIN, locale, t)).not.toBe(tookLabel(THREE_MIN, locale, t));
    }
  });

  /**
   * **진행 줄은 초를 안 읽는다**(`Grain`). 이 줄은 곁눈으로 읽는 자리라 초까지 적으면
   * 매 초 글자가 바뀌어 옆의 이름과 상태를 읽기 어렵다 — 옛 `progressGroup.elapsedLabel`
   * 이 분·시간만 낸 것이 그 판단이었고, `lib/time.ts` 로 합치면서 잃지 않았다.
   *
   * 같은 길이를 상세(`daemonFacts`)는 `fine` 으로 읽어 `4분 12초` 라고 적는다 — 그것이
   * 이 축이 지키는 갈림이다.
   */
  it('진행 줄은 큰 단위만 읽는다 — 상세는 초까지 읽는다', () => {
    const FOUR_TWELVE = 4 * 60_000 + 12_000;
    expect(runningLabel(FOUR_TWELVE, 'ko', ko)).toBe('4분째');
    expect(runningLabel(FOUR_TWELVE, 'en', en)).toBe('running 4m');
    // 같은 값을 `fine` 으로 부르면 초가 온다.
    expect(durationLabel(FOUR_TWELVE, 'ko', 'fine')).toBe('4분 12초');
  });

  /**
   * **0 을 빈 칸으로 그리지 않는다.**
   *
   * `Intl.DurationFormat` 은 `{seconds: 0}` 을 **빈 문자열**로 낸다(실측 2026-09-08).
   * 그대로 두면 소요 시간 칸이 비고, 빈 칸은 "짧다"가 아니라 **"못 읽었다"** 로 읽힌다.
   * 러너가 `durationMs: 0` 을 보낼 수 있으므로(`ReportMeta`) 가상의 경우가 아니다.
   */
  it('0 을 빈 문자열로 내지 않는다 — 빈 칸은 "못 읽었다"로 읽힌다', () => {
    for (const locale of ['ko', 'en'] as const) {
      expect(durationLabel(0, locale)).not.toBe('');
      expect(durationLabel(0, locale)).toMatch(/0/);
    }
    expect(durationLabel(0, 'ko')).toBe('0초');
    expect(durationLabel(0, 'en')).toBe('0s');
  });

  /** 아랫단위가 0 이면 뺀다 — `1분 0초` 는 0 이 자리를 차지하는 잡음이다(규칙 06). */
  it('아랫단위가 0 이면 적지 않는다', () => {
    expect(durationLabel(60_000, 'ko')).toBe('1분');
    expect(durationLabel(3_600_000, 'ko')).toBe('1시간');
    expect(durationLabel(86_400_000, 'ko')).toBe('1일');
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

  /**
   * **화면에서도 두 상태가 갈린다 — 영어에서도**(`#619` 후속).
   *
   * 이전 코드는 `elapsed.replace(/째$/, '')` 로 끝난 묶음의 어미를 잘랐다. 그 정규식은
   * 영어에서 아무것도 안 잘라, **영어 화면이 도는 진행과 끝난 진행을 같은 글자로**
   * 말하게 된다. 두 축을 나란히 두어 그 결함이 다시 들어오면 빨개지게 한다.
   */
  it('언어를 영어로 바꿔도 끝난 것과 도는 것이 다른 글자다', () => {
    usePrefsStore.getState().setLocale('en');
    const messages = [prog('p1', '파일을 읽는다', FORGE, AT_P1), prog('p2', '테스트', FORGE, AT_P2)];

    const { unmount } = render(<ProgressRow messages={messages} endedAt={AT_END} />);
    expect(screen.getByTestId('progress-row').textContent).toContain('took 4m');
    expect(screen.getByTestId('progress-row').textContent).not.toContain('running');
    unmount();

    render(<ProgressRow messages={messages} endedAt={null} />);
    // 도는 쪽은 `running` 이 붙는다 — 한국어의 `째` 가 하던 일을 영어는 이렇게 한다.
    expect(screen.getByTestId('progress-row').textContent).toContain('running');
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
