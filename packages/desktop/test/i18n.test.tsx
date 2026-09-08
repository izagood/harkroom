/**
 * i18n 뼈대의 회귀선 — **다음 PR 이 규칙을 어기면 여기서 잡힌다.**
 *
 * ## 이 파일이 지키는 것 넷
 *
 * 1. **사전이 갈라지지 않는다** — 새 언어가 키를 빠뜨리면 잡힌다. 타입도 잡지만
 *    (`satisfies Catalog`) 타입은 **복수형 갈래**까지는 못 본다: `other` 만 필수라
 *    영어가 `one` 을 빠뜨려도 컴파일된다. 그것을 여기서 잡는다
 * 2. **자리표시자가 갈라지지 않는다** — 번역이 `{count}` 를 빠뜨리면 화면에서 숫자가
 *    조용히 사라진다. 사람은 그것을 "0개"로도 못 읽고 그냥 못 읽는다
 * 3. **문법이 그 언어의 파일에만 있다** — 조사 표기(`:이가`)가 영어 사전에 새어 들면
 *    영어 화면에 `forge 가` 가 뜬다
 * 4. **화면이 실제로 두 언어로 뜬다** — 위 셋이 다 초록이어도 배선이 틀리면 화면은
 *    한 언어로만 뜬다. 그래서 마지막 묶음이 **렌더까지** 간다
 *
 * ## RED 로 확인한 것 (2026-09-08)
 *
 * | 무엇을 깼나 | 무엇이 빨개졌나 |
 * |---|---|
 * | `ko.ts` 에서 `waitChain.empty` 삭제 | **타입** — `satisfies Catalog` 가 컴파일을 막는다 |
 * | `ko.ts` 의 `{count}` 를 지움 | "자리표시자가 두 사전에서 같다" |
 * | `en.ts` 의 `one` 갈래를 지움 | "영어는 복수형 두 갈래를 다 갖는다" |
 * | `en.ts` 에 `{waiter:이가}` 를 넣음 | "조사 표기는 한국어 사전에만 있다" |
 * | `useT` 가 언어를 무시하게 함 | "언어를 바꾸면 화면이 따라온다" |
 * | 없는 키 `t('waitChain.nope')` | **타입** — `MessageKey` 에 없어 컴파일이 막힌다 |
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { OpenAskLink } from '@murmur/shared';
import { CATALOGS, LOCALES, translator, detectLocale, isLocale, type Locale } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ko } from '../src/i18n/ko';
import { interpolate } from '../src/i18n/format';
import { useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { WaitChainSection } from '../src/components/WaitChainSection';
import { WaitChainLine } from '../src/components/WaitChain';
import { Sidebar } from '../src/components/Sidebar';
import { fireEvent } from '@testing-library/react';
import { waitChainFromLinks } from '../src/lib/waitChain';
import { acc, chan, msg } from './helpers/fakeApi';

/** 사전 값에서 자리표시자 이름을 뽑는다. 조사 표기(`:이가`)는 이름의 일부가 아니다. */
function placeholders(value: unknown): Set<string> {
  const texts = typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(/\{(\w+)(?::[^\s}]+)?\}/g)) found.add(m[1]!);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. 사전이 갈라지지 않는다
// ---------------------------------------------------------------------------

describe('사전 — 언어가 갈라지지 않는다', () => {
  const keys = Object.keys(en) as (keyof typeof en)[];

  it('붙어 있는 언어가 둘 이상이다 — 하나면 이 뼈대가 증명하는 것이 없다', () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(2);
    expect(LOCALES).toContain('en');
    expect(LOCALES).toContain('ko');
  });

  /**
   * 타입이 이미 막지만(`satisfies Catalog`) **여기서 한 번 더 잰다** — 다음 사람이
   * `as unknown as Catalog` 로 우회하면 타입은 조용하고 화면만 빈다.
   */
  it.each(LOCALES)('%s 사전에 원본의 키가 하나도 안 빠졌다', (locale) => {
    const catalog = CATALOGS[locale];
    for (const key of keys) {
      expect(catalog[key], `${locale} 에 ${key} 가 없다`).toBeDefined();
    }
  });

  it.each(LOCALES)('%s 사전에 원본에 없는 키가 없다 — 죽은 번역은 썩는다', (locale) => {
    expect(Object.keys(CATALOGS[locale]).sort()).toEqual([...keys].sort());
  });

  /**
   * **자리표시자가 갈리면 화면에서 값이 조용히 사라진다.** 번역이 `{count}` 를
   * 빠뜨리면 "답하면 개가 풀린다"가 되는데, 그것은 빈 화면보다 나쁘다 — 문장이
   * 말이 되는 것처럼 보여서 아무도 못 찾는다.
   */
  it.each(LOCALES)('%s 번역이 원본과 같은 자리표시자를 쓴다', (locale) => {
    for (const key of keys) {
      expect(placeholders(CATALOGS[locale][key]), `${locale}.${key}`)
        .toEqual(placeholders(en[key]));
    }
  });
});

describe('복수형 — 언어마다 필요한 갈래가 다르다', () => {
  /**
   * **영어는 둘을 다 가져야 한다.** `other` 만 있으면 `1 threads` 가 뜬다.
   * 타입은 이것을 못 막는다 — `Plural` 은 `other` 만 필수다(어느 언어에나 있는
   * 유일한 갈래라서). 그 느슨함의 대가를 이 축이 갚는다.
   */
  it('영어의 복수형 항목은 one 과 other 를 다 갖는다', () => {
    const plurals = Object.entries(en).filter(([, v]) => typeof v !== 'string');
    // 복수형 항목이 하나도 없으면 이 축은 아무것도 안 지킨다.
    expect(plurals.length).toBeGreaterThan(0);
    for (const [key, value] of plurals) {
      expect((value as { one?: string }).one, `en.${key} 에 one 이 없다`).toBeDefined();
      expect((value as { other: string }).other, `en.${key} 에 other 가 없다`).toBeDefined();
    }
  });

  /** **한국어가 `other` 하나인 것은 누락이 아니라 그 언어의 사실이다.** */
  it('한국어는 other 만으로 충분하다 — 수에 따라 명사가 안 바뀐다', () => {
    const t = translator('ko');
    expect(t('waitChain.unblocks', { count: 1 })).toContain('1개');
    expect(t('waitChain.unblocks', { count: 7 })).toContain('7개');
  });

  /** `1 reply / 2 replies` 가 실제로 되는가 — 사용자가 물은 그 축이다. */
  it('영어는 1 과 2 가 다른 낱말이 된다', () => {
    const t = translator('en');
    expect(t('waitChain.unblocks', { count: 1 })).toBe('answering unblocks 1 thread');
    expect(t('waitChain.unblocks', { count: 2 })).toBe('answering unblocks 2 threads');
  });
});

// ---------------------------------------------------------------------------
// 2. 문법은 그것을 가진 언어의 파일에만 있다
// ---------------------------------------------------------------------------

describe('조사 — 한국어만의 규칙이 영어로 새지 않는다', () => {
  /**
   * **영어 사전에 `:이가` 가 들어오면 영어 화면에 `forge 가` 가 뜬다.** 원본을 쓰는
   * 사람이 한국어 사정을 모른 채 표기를 흉내 내는 것을 막는다.
   */
  it('영어 사전에는 조사 표기가 없다', () => {
    for (const [key, value] of Object.entries(en)) {
      const texts = typeof value === 'string' ? [value] : Object.values(value);
      for (const text of texts) {
        expect(text, `en.${key} 에 조사 표기가 있다`).not.toMatch(/\{\w+:[^\s}]+\}/);
      }
    }
  });

  it('받침 있는 이름은 이, 없는 이름은 가', () => {
    // 한글 음절의 종성으로 가른다 — '민수'는 받침이 없고 '민준'은 있다.
    expect(interpolate('{who:이가}', { who: '민수' })).toBe('민수가');
    expect(interpolate('{who:이가}', { who: '민준' })).toBe('민준이');
  });

  /**
   * 영문·숫자로 끝나면 받침을 **모른다**. 원래 화면이 `forge 가` 로 띄고 있었고
   * 회귀선이 그 모양을 잰다 — 띄어쓰기까지 그대로다.
   */
  it('영문 이름은 띄고 가 — 원래 화면 그대로다', () => {
    expect(interpolate('{who:이가}', { who: 'forge' })).toBe('forge 가');
  });

  it('인자가 없는 자리는 지우지 않고 남긴다 — 지우면 아무도 못 찾는다', () => {
    expect(interpolate('답하면 {count}개', {})).toBe('답하면 {count}개');
  });
});

// ---------------------------------------------------------------------------
// 3. 언어 고르기
// ---------------------------------------------------------------------------

describe('언어 고르기', () => {
  it('지역이 붙어 와도 앞칸으로 고른다', () => {
    expect(detectLocale(['ko-KR', 'en-US'])).toBe('ko');
    expect(detectLocale(['en-GB'])).toBe('en');
  });

  /** **원본이 최후의 보루다.** 모르는 언어에서 빈 화면을 내지 않는다. */
  it('가진 것이 없으면 영어로 떨어진다', () => {
    expect(detectLocale(['fr-FR', 'de'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('아는 언어만 언어로 친다', () => {
    expect(isLocale('ko')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. 화면이 실제로 두 언어로 뜬다 — **완료 기준 3**
// ---------------------------------------------------------------------------

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';

const link = (waiter: string, blockedBy: string | null): OpenAskLink =>
  ({ waiter, blockedBy, askedAt: new Date(Date.now() - 3 * 60_000).toISOString() });

function seed(links: OpenAskLink[] | null) {
  useActiveStore.getState().set({
    me: acc(ME, 'me'),
    accounts: { [ME]: acc(ME, 'me'), [FORGE]: acc(FORGE, 'forge'), [CODEX]: acc(CODEX, 'codex') },
    channels: [chan('c1', 'general')],
    messages: { c1: [msg('root-1', 'c1', 1, '루트', FORGE, { openAskLinks: links })] },
    online: [FORGE, CODEX],
    connected: true,
  });
}

/** 언어를 정한다. `'system'` 을 안 쓰는 이유: 시험이 브라우저 설정에 매달리면 안 된다. */
const speak = (locale: Locale) => usePrefsStore.getState().setLocale(locale);

beforeEach(() => {
  setController({ openThread: async () => undefined } as unknown as Controller);
  useActiveStore.getState().reset();
  usePrefsStore.getState().setLocale('en');
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('화면 — 기본은 영어다', () => {
  it('빈 구획이 영어로 뜬다', () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me') },
      channels: [chan('c1', 'general')], messages: { c1: [] }, online: [], connected: true,
    });
    render(<WaitChainSection />);
    expect(screen.getByText('Nothing is waiting')).toBeTruthy();
    expect(screen.getByTestId('wait-chain-section').querySelector('h3')?.textContent)
      .toBe('Waiting on (0)');
  });

  /**
   * **경과 표기도 이제 영어다**(`#619` 후속). 그 PR 이 남긴 주의점이 여기 있었다 —
   * *"경과 표기(`3분째`)는 아직 한국어라 이 축은 사슬 줄만 재고 행 전체를 재지 않는다."*
   *
   * 시간 표기가 `lib/time.ts` 한 벌로 합쳐지면서 그 예외가 없어졌으므로 **행 전체**를
   * 잰다. 예외를 남겨 두면 다음 사람이 그 자리에 한국어를 다시 넣어도 초록이다.
   */
  it('사슬 줄이 영어 어순으로 뜬다 — 조사가 안 붙고, 경과도 영어다', () => {
    seed([link(FORGE, ME)]);
    render(<WaitChainSection />);
    const row = screen.getByTestId('wait-chain-root-1');
    expect(row.textContent).toContain('#general');
    expect(row.textContent).toContain('forge');
    // **행 전체**에 한국어가 없다 — 빼 두는 자리가 하나도 없다.
    expect(row.textContent).not.toMatch(/[가-힣]/);
  });

  it('몇 개가 풀리는지 영어로 말한다', () => {
    seed([link(CODEX, FORGE), link(FORGE, ME)]);
    render(<WaitChainSection />);
    expect(screen.getByTestId('wait-chain-root-1').textContent)
      .toContain('answering unblocks 2 threads');
  });
});

describe('화면 — 언어를 한국어로 바꾸면 한국어로 뜬다', () => {
  it('빈 구획이 한국어로 바뀐다', () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me') },
      channels: [chan('c1', 'general')], messages: { c1: [] }, online: [], connected: true,
    });
    speak('ko');
    render(<WaitChainSection />);
    expect(screen.getByText('기다리는 것이 없다')).toBeTruthy();
    expect(screen.getByTestId('wait-chain-section').querySelector('h3')?.textContent)
      .toBe('기다리는 것 (0)');
  });

  it('몇 개가 풀리는지 한국어로 말한다', () => {
    seed([link(CODEX, FORGE), link(FORGE, ME)]);
    speak('ko');
    render(<WaitChainSection />);
    expect(screen.getByTestId('wait-chain-root-1').textContent).toContain('답하면 2개가 풀린다');
  });

  /**
   * **"없다"와 "아직 안 봤다"는 다른 사실이다**(design.md §4). 그 구별이 언어를
   * 바꿔도 남는지 — 뼈대가 뜻을 옮겼지 낱말만 옮긴 것이 아님을 재는 축이다.
   */
  it('"아직 다 보지 못했다"가 두 언어에 다 있다', () => {
    const twoChannels = {
      me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me') },
      channels: [chan('c1', 'general'), chan('c2', 'design')],
      messages: { c1: [] }, online: [], connected: true,
    };
    useActiveStore.getState().set(twoChannels);
    render(<WaitChainSection />);
    expect(screen.getByText('Not everything has been checked yet')).toBeTruthy();
    // 모를 때는 제목이 수를 말하지 않는다 — 그 규율도 언어를 건너 살아남는다.
    expect(screen.getByTestId('wait-chain-section').querySelector('h3')?.textContent)
      .not.toContain('0');

    cleanup();
    speak('ko');
    render(<WaitChainSection />);
    expect(screen.getByText('아직 다 보지 못했다')).toBeTruthy();
  });
});

/**
 * **어순이 실제로 다르다.** 이것이 문장을 조각으로 쪼개면 안 되는 이유였고,
 * 뼈대가 그것을 감당하는지를 재는 축이다 — 한국어는 목적어가 동사 앞에,
 * 영어는 동사 뒤에 온다.
 */
describe('스레드 패널의 사슬 줄 — 어순이 언어를 따른다', () => {
  const chainOf = (links: OpenAskLink[]) =>
    waitChainFromLinks({ links, myAccountId: ME, live: new Set([FORGE, CODEX]) })!;

  beforeEach(() => {
    useActiveStore.getState().set({
      accounts: { [ME]: acc(ME, 'me'), [FORGE]: acc(FORGE, 'forge'), [CODEX]: acc(CODEX, 'codex') },
    });
  });

  it('영어는 A is waiting for B', () => {
    render(<WaitChainLine chain={chainOf([link(FORGE, CODEX)])} />);
    expect(screen.getByTestId('wait-chain').textContent).toContain('forge is waiting for codex');
  });

  it('한국어는 A가 B의 답을 기다린다 — 조사까지 붙는다', () => {
    speak('ko');
    render(<WaitChainLine chain={chainOf([link(FORGE, CODEX)])} />);
    expect(screen.getByTestId('wait-chain').textContent).toContain('forge 가 codex의 답을 기다린다');
  });

  /** '사람 아무나'는 **다른 문장**이다 — 이름 자리에 보통명사를 끼우면 조사가 어긋난다. */
  it("'사람 아무나'는 두 언어 모두 별도 문장이다", () => {
    render(<WaitChainLine chain={chainOf([link(FORGE, null)])} />);
    expect(screen.getByTestId('wait-chain').textContent)
      .toContain('forge is waiting for someone to answer');

    cleanup();
    speak('ko');
    render(<WaitChainLine chain={chainOf([link(FORGE, null)])} />);
    expect(screen.getByTestId('wait-chain').textContent).toContain('forge 가 사람의 답을 기다린다');
  });

  it('교착은 두 언어 모두 이유를 말한다', () => {
    render(<WaitChainLine chain={chainOf([link(FORGE, CODEX), link(CODEX, FORGE)])} />);
    expect(screen.getByTestId('wait-chain').textContent).toContain('only a human can break this');

    cleanup();
    speak('ko');
    render(<WaitChainLine chain={chainOf([link(FORGE, CODEX), link(CODEX, FORGE)])} />);
    expect(screen.getByTestId('wait-chain').textContent).toContain('사람만이 풀 수 있다');
  });
});

// ---------------------------------------------------------------------------
// 5. 사이드바가 두 언어로 뜬다 — **이 PR 의 완료 기준 3**
//
// 다른 사이드바 회귀선 열넷은 **한국어로 고정돼 있다**(각 파일 머리의 주석) — 그것들이
// 재는 것은 언어가 아니라 그 언어로 표현된 규율이라, 언어를 재는 자리는 여기 하나다.
// 두 곳에서 같은 것을 재면 문구를 고칠 때 한쪽만 고쳐진다.
//
// **화면을 열어서 잰다.** 사전을 직접 읽어 `en['sidebar.menu.leave'] !== ko[...]` 를
// 확인하는 것으로는 부족하다 — 위 1번 묶음이 이미 사전을 재고 있고, 사전이 갈려 있어도
// **화면이 `t()` 를 안 지나면** 그 화면은 한 언어로 굳는다(예전 `NOTIFY_LEVEL_LABEL` 이
// 모듈 상수라 정확히 그랬다). 배선을 재는 유일한 방법이 렌더다.
// ---------------------------------------------------------------------------

const sidebarProps = {
  onOpenDirectory: () => {},
  onOpenChannelDirectory: () => {},
  onOpenInbox: () => {},
  // #629 가 더한 두 열기 훅. 이 파일은 문자열만 재지만 **필수 prop 이라 빠지면 타입이
  // 깨진다** — 실제로 #630(이 테스트)과 #629(prop 추가)가 각자 초록으로 머지된 뒤 main 에서
  // 처음 만나 깨졌다. 여는 동작은 이 테스트의 관심사가 아니므로 빈 함수로 둔다.
  onOpenAgentConfig: () => {},
  onOpenProfile: () => {},
  collapsed: false,
  onToggleCollapse: () => {},
};

/** admin 이어야 편집·삭제·만들기가 메뉴에 선다 — 옮긴 문자열 대부분이 그 뒤에 있다. */
function seedSidebar() {
  useActiveStore.getState().set({
    me: { ...acc(ME, 'me'), isAdmin: true },
    accounts: { [ME]: { ...acc(ME, 'me'), isAdmin: true }, [FORGE]: acc(FORGE, 'forge', 'agent') },
    channels: [chan('c1', 'general')],
    messages: { c1: [] },
    dms: [],
    online: [],
    connected: true,
  });
}

/** 채널 행의 `⋯` 를 눌러 메뉴를 연다. */
function openChannelMenu(): HTMLElement {
  const trigger = screen.getAllByRole('button', { name: '⋯' })[0]!;
  fireEvent.click(trigger);
  return screen.getByRole('menu');
}

describe('사이드바 — 기본은 영어다', () => {
  beforeEach(seedSidebar);

  it('구획 머리와 연결 점이 영어로 뜬다', () => {
    render(<Sidebar panel="home" {...sidebarProps} />);
    expect(screen.getByRole('navigation', { name: 'Channels' })).toBeTruthy();
    expect(screen.getByLabelText('Collapse sidebar')).toBeTruthy();
    expect(screen.getByTestId('connection-dot').getAttribute('title'))
      .toBe('Connected to the server');
  });

  /** **알림 3단이 한 축으로 선다** — 셋의 관계가 이름에서 읽혀야 한다(`en.ts` notify 머리말). */
  it('알림 3단이 영어로 뜨고 셋이 같은 축에 선다', () => {
    render(<Sidebar panel="home" {...sidebarProps} />);
    const items = [...openChannelMenu().querySelectorAll('[role="menuitem"]')]
      .map((el) => el.textContent);
    // 기본값이 `mentions` 이므로 그 줄에만 `✓` 가 붙는다(`notifyLevelOf`).
    expect(items).toContain('Notify: Everything');
    expect(items).toContain('✓ Notify: Only mentions');
    expect(items).toContain('Notify: Nothing');
  });

  it('메뉴 항목이 영어로 뜬다', () => {
    render(<Sidebar panel="home" {...sidebarProps} />);
    const items = [...openChannelMenu().querySelectorAll('[role="menuitem"]')]
      .map((el) => el.textContent);
    expect(items).toContain('Edit channel');
    expect(items).toContain('View members');
    expect(items).toContain('Copy channel name');
    // 사이드바 메뉴에는 한국어가 한 글자도 없다 — 섹션 이름 같은 사람이 지은 값은 없는 상태다.
    expect(items.join(' ')).not.toMatch(/[가-힣]/);
  });

  /**
   * **오류가 영어로 뜬다.** 화면이 실제로 실패를 겪는 경로로 확인한다 — 사전만 재면
   * `setCreateError` 가 옛 문자열을 그대로 들고 있어도 초록이다.
   */
  it('채널 이름 규칙 오류가 영어로 뜬다 — 무엇이 되는지를 적는다', () => {
    render(<Sidebar panel="home" {...sidebarProps} />);
    fireEvent.click(screen.getByTestId('add-channel'));
    fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByText('Create'));
    const alert = screen.getByRole('alert');
    // `Invalid name` 이 아니라 **무엇이 되는지**를 적는다.
    expect(alert.textContent).toContain('lowercase letters');
    expect(alert.textContent).toContain('1 to 48 characters');
  });
});

describe('사이드바 — 언어를 한국어로 바꾸면 한국어로 뜬다', () => {
  beforeEach(() => {
    seedSidebar();
    speak('ko');
  });

  it('구획 머리와 연결 점이 한국어로 바뀐다', () => {
    render(<Sidebar panel="home" {...sidebarProps} />);
    expect(screen.getByRole('navigation', { name: '채널 목록' })).toBeTruthy();
    expect(screen.getByLabelText('사이드바 접기')).toBeTruthy();
    expect(screen.getByTestId('connection-dot').getAttribute('title')).toBe('서버에 연결됨');
  });

  it('알림 3단이 한국어로 바뀐다', () => {
    render(<Sidebar panel="home" {...sidebarProps} />);
    const items = [...openChannelMenu().querySelectorAll('[role="menuitem"]')]
      .map((el) => el.textContent);
    expect(items).toContain('알림: 전체');
    expect(items).toContain('✓ 알림: 멘션만');
    expect(items).toContain('알림: 없음');
  });

  it('메뉴 항목이 한국어로 바뀐다', () => {
    render(<Sidebar panel="home" {...sidebarProps} />);
    const items = [...openChannelMenu().querySelectorAll('[role="menuitem"]')]
      .map((el) => el.textContent);
    expect(items).toContain('채널 편집');
    expect(items).toContain('멤버 보기');
    expect(items).toContain('채널명 복사');
  });

  it('채널 이름 규칙 오류가 한국어로 바뀐다', () => {
    render(<Sidebar panel="home" {...sidebarProps} />);
    fireEvent.click(screen.getByTestId('add-channel'));
    fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByText('만들기'));
    expect(screen.getByRole('alert').textContent).toContain('1~48자');
  });
});

/**
 * **복수형이 사이드바에서도 실제로 갈린다.** 되돌릴 수 없는 조작의 규모를 말하는 자리라
 * `1 messages` 가 뜨면 그 문장이 급조된 것으로 읽히고, 사람은 숫자를 다시 확인하지 않는다.
 *
 * 한국어가 한 갈래인 것은 그 언어의 사실이므로 같은 축에서 함께 잰다 — 그래야 "한국어에
 * `one` 이 없다"가 누락이 아니라 **설계**임이 이 파일 안에서 읽힌다.
 */
describe('사이드바 삭제 확인 — 규모를 말하는 문장의 복수형', () => {
  const t = (locale: Locale) => translator(locale);

  it('영어는 1개와 2개가 다른 낱말이다', () => {
    expect(t('en')('sidebar.delete.scope', { count: 1 })).toContain('its 1 message for good');
    expect(t('en')('sidebar.delete.scope', { count: 2 })).toContain('its 2 messages for good');
  });

  it('한국어는 수에 따라 명사가 안 바뀐다', () => {
    expect(t('ko')('sidebar.delete.scope', { count: 1 })).toContain('메시지 1개');
    expect(t('ko')('sidebar.delete.scope', { count: 7 })).toContain('메시지 7개');
  });
});

/**
 * **긴 안내문이 뜻을 잃지 않았다.** 자동 멘션 안내는 두 사실을 진다 — 무엇이 일어나는가,
 * 그리고 한 번만 빼려면 어디를 누르는가. 영어로 옮기면서 뒤엣것을 잘라내면 사람은 칩을
 * 영영 발견하지 못하므로, **두 언어 모두 두 사실을 다 갖는지**를 잰다(낱말이 아니라 뜻).
 */
describe('사이드바 안내문 — 옮기면서 사실을 잃지 않는다', () => {
  it('자동 멘션 안내가 두 언어 모두 「무엇이 일어나나」와 「어떻게 빼나」를 다 말한다', () => {
    const note = { en: en['sidebar.members.autoMentionNote'], ko: ko['sidebar.members.autoMentionNote'] };
    expect(note.en).toContain('called at the front');
    expect(note.en).toContain('composer');
    expect(note.ko).toContain('앞에 자동으로 불린다');
    expect(note.ko).toContain('작성창');
  });

  /**
   * **끊김은 한 단어로 끝나지 않는다**(`#443`). 그 뒤에 따라오는 사실 — 아래 목록의
   * 생사를 알 수 없다 — 까지 말해야 사람이 아래에서 볼 것을 미리 안다.
   */
  it('끊김 문구가 두 언어 모두 「그래서 아래를 믿을 수 없다」까지 말한다', () => {
    expect(en['sidebar.brand.disconnected'].length).toBeGreaterThan('Disconnected'.length + 10);
    expect(en['sidebar.brand.disconnected']).toContain('trusted');
    expect(ko['sidebar.brand.disconnected']).toContain('알 수 없다');
/**
 * **시간 표기가 한 벌인 것을 잠근다**(`#619` 후속).
 *
 * 이 저장소가 반복 결함으로 지목한 것이 *"같은 판정이 두 벌"* 이고, 시간 표기가 정확히
 * 그 모양이었다 — `elapsedLabel` 이 **이름까지 같은 채** 두 파일에 있었고(시그니처가
 * 달라 컴파일은 조용했다), 같은 일을 하는 함수가 `minutesAgo` · `lastTurnAgo` ·
 * `formatDuration` 까지 합쳐 여섯 벌이었다.
 *
 * 합친 것을 문구 대조만으로는 지킬 수 없다: 다음 사람이 화면 안에서 `${분}분 전` 을
 * 다시 조립해도 그 화면의 회귀선은 초록이다. 그래서 **소스를 직접 읽어** 시간 단위를
 * 손으로 이어 붙이는 자리가 `lib/time.ts` 밖에 없음을 단언한다
 * (`daemonFacts.test.tsx` 의 *"판정 함수 어디에도 임계값 상수가 없다 — 소스를 직접
 * 본다"* 와 같은 방식이다).
 */
describe('시간 표기 — 한 벌이다', () => {
  /**
   * 시간 낱말이 **문자열 리터럴 안에서** 조립되는 모양. 템플릿의 `}` 나 따옴표 바로 뒤에
   * 단위가 붙는 것이 그 신호다(`` `${mins}분 전` `` · `` `${secs}초` ``).
   */
  const HAND_BUILT = /[}'"]\s*(?:분 전|시간 전|일 전|분째|시간째|초|분|시간|일)\s*[`'"]/;

  /** `src/` 아래 모든 `.ts`·`.tsx` 를 **주석을 지운 채** 준다. */
  async function sources(): Promise<[path: string, code: string][]> {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const out: [string, string][] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // 주석에서 옛 문구를 **인용**하는 것은 정상이다 — 근거를 남기는 자리다.
        // 금지 대상은 코드가 그 문자열을 만드는 것이므로 주석을 지운 뒤 본다.
        const code = (await readFile(full, 'utf8'))
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        out.push([full.replace(/^.*\/src\//, 'src/'), code]);
      }
    };
    await walk(join(process.cwd(), 'src'));
    return out;
  }

  it('시간 단위를 손으로 이어 붙이는 자리가 사전과 time.ts 밖에 없다', async () => {
    const offenders = (await sources())
      // 사전은 시간 낱말을 **가질 수밖에 없다**(`time.running` 의 `{duration}째`) —
      // 그것이 `Intl` 이 못 내는 뜻이고, 이 PR 이 사전에 남기기로 한 자리다.
      .filter(([path]) => !path.startsWith('src/i18n/'))
      // `time.ts` 는 그 조립을 **혼자 하기로 한** 파일이다.
      .filter(([path]) => path !== 'src/lib/time.ts')
      .filter(([, code]) => HAND_BUILT.test(code))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  /** 이름이 같은 함수가 두 파일에 다시 서는 것도 막는다 — 그것이 옛 결함의 모양이다. */
  it('`elapsedLabel` 이 한 파일에만 있다', async () => {
    const files = (await sources())
      .filter(([, code]) => /export function elapsedLabel/.test(code))
      .map(([path]) => path);

    expect(files).toEqual(['src/lib/daemonFacts.ts']);
  });

  /**
   * **"얼마나 전"이 분에서 멈추지 않는다.**
   *
   * 옛 `minutesAgo` 는 한 시간 전을 `60분 전`, 한 달 전을 `41760분 전` 이라고 적었고
   * 옛 `lastTurnAgo` 는 같은 물음에 `1시간 전`·`29일 전` 이라고 답했다 — **같은 뜻을
   * 두 함수가 다르게 말하고 있었다.** 합치면서 뒤쪽으로 수렴했고, 그 근거는
   * `lastTurn.ts` 가 이미 적어 둔 것이다: *"사람이 시계와 뺄셈으로 계산하게 만들 이유가
   * 없다."*
   *
   * 이 축이 없으면 다음 사람이 "원래 분이었는데" 하며 되돌릴 수 있다.
   */
  it('"얼마나 전"이 시간·일로 올라간다 — 분에서 멈추지 않는다', async () => {
    const { agoLabel } = await import('../src/lib/time');
    const NOW = 1_800_000_000_000;
    const ko = translator('ko');
    const ago = (ms: number) => agoLabel(NOW - ms, NOW, 'ko', ko);

    expect(ago(59 * 60_000)).toBe('59분 전');
    // 여기서 올라간다 — 옛 `minutesAgo` 는 `60분 전` 이었다.
    expect(ago(60 * 60_000)).toBe('1시간 전');
    expect(ago(23 * 3_600_000)).toBe('23시간 전');
    // 여기서 또 올라간다 — 옛 `minutesAgo` 는 `1440분 전` 이었다.
    expect(ago(24 * 3_600_000)).toBe('1일 전');
    expect(ago(29 * 86_400_000)).toBe('29일 전');
    // 분에서 멈추던 옛 문구가 어디에도 안 나온다.
    for (const ms of [60 * 60_000, 24 * 3_600_000, 29 * 86_400_000]) {
      expect(ago(ms)).not.toMatch(/^\d{3,}분 전$/);
    }
  });
});
