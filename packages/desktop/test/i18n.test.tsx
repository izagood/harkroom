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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type {
  AgentDefaults, AgentTeamRow, AgentView, OpenAskLink, PatView,
} from '@murmur/shared';
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
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
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
  });
});

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

// ---------------------------------------------------------------------------
// 6. 에이전트 설정이 두 언어로 뜬다 — **이 PR 의 완료 기준 3**
//
// 사이드바(5번 묶음)와 같은 방식이다: 이 화면의 다른 회귀선 열한 벌은 **한국어로
// 고정돼 있고**(각 파일 머리의 주석), 그것들이 재는 것은 언어가 아니라 그 언어로
// 표현된 규율이다 — 세 상태를 접지 않는 것 · 못 읽은 것과 없는 것을 가르는 것 ·
// 되돌릴 수 없는 조작에 확인을 거는 것. 언어를 재는 자리는 여기 하나다.
//
// **화면을 열어서 잰다.** 사전만 비교하면 화면이 `t()` 를 안 지나도 초록이고, 이
// 화면에는 그 함정이 실제로 있었다 — `lastTurnLabel` 은 컴포넌트 밖 순수 함수라
// 훅이 닿지 않고, 번역기를 인자로 안 받으면 영원히 한 언어로 굳는다.
// ---------------------------------------------------------------------------

const AGENT_ID = 'id-forge';

const agentView = (extra: Partial<AgentView> = {}): AgentView => ({
  id: AGENT_ID, handle: 'forge', displayName: 'forge', kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

/**
 * 이 화면은 admin 이라야 대부분의 문자열이 선다(만들기 · 비활성화 · 러너 실행·중지).
 * `pats` 를 인자로 두는 이유: PAT 0개와 그 안내가 **켜짐/꺼짐에 따라 다른 문장**이라
 * 그 갈림을 아래 축이 직접 연다.
 */
function seedAgents(agents: AgentView[], pats: PatView[] = [], teams: AgentTeamRow[] | null = []) {
  useActiveStore.getState().reset();
  useActiveStore.getState().set({
    me: { ...acc(ME, 'me'), isAdmin: true },
    accounts: { [ME]: { ...acc(ME, 'me'), isAdmin: true } },
    online: [],
    connected: true,
    teams,
  });
  setController({
    listAgents: vi.fn(async () => agents),
    listPats: vi.fn(async () => pats),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    agentMemory: vi.fn(async () => []),
    getTeam: vi.fn(async () => ({ members: [] })),
    refreshAccounts: vi.fn(async () => undefined),
  } as unknown as Controller);
}

/** 카드를 눌러 상세로 들어간다 — 옮긴 문자열 대부분이 그 뒤에 있다. */
async function openDetail() {
  fireEvent.click(await screen.findByTestId('agent-card-forge'));
}

describe('에이전트 설정 — 기본은 영어다', () => {
  it('격자 머리와 탭이 영어로 뜬다', async () => {
    seedAgents([agentView()]);
    render(<AgentsSettings />);
    await screen.findByTestId('agent-card-forge');
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Agents and teams' })).toBeTruthy();
    expect(screen.getByText('Call one with @name in a channel. Click a card to open its settings.'))
      .toBeTruthy();
  });

  it('상세의 세 묶음 제목이 영어로 뜬다', async () => {
    seedAgents([agentView()]);
    render(<AgentsSettings />);
    await openDetail();
    for (const title of ['Profile', 'Run', 'Permissions']) {
      expect(screen.getByRole('heading', { name: title }), title).toBeTruthy();
    }
  });

  /**
   * **`#493` 이 접은 한 쌍**(실행/중지)이 영어로도 한 쌍이다. `Resume` 이 아니라
   * `Start` 인 근거는 `en.ts` 의 그 표에 있다 — 이 버튼은 멈춘 것을 잇는 것이 아니라
   * 자동 기동 대상에 되넣는 것이다.
   */
  it('러너 실행·중지가 영어로 뜨고 세 상태가 접히지 않는다', async () => {
    seedAgents([agentView()]);
    render(<AgentsSettings />);
    await openDetail();
    expect(await screen.findByRole('button', { name: 'Stop the runner' })).toBeTruthy();
    expect(screen.getByText('It is in the auto-start set — no stop has ever been asked for.'))
      .toBeTruthy();
  });

  /**
   * **긴 안내문의 굵은 마디가 영어로도 굵다.** 그 굵기는 꾸밈이 아니라 문단에서 건져야
   * 할 사실을 가리킨다(`AgentsSettings.emphasize` 머리말) — 사전이 평문이 되면서
   * `<strong>` 이 통째로 사라지는 것이 이 배선의 실패 모양이라, 그것을 여기서 잰다.
   */
  it('중지 안내의 굵은 마디가 영어로도 <strong> 이다', async () => {
    seedAgents([agentView()]);
    render(<AgentsSettings />);
    await openDetail();
    const note = (await screen.findByText(/does not cut the runner off now/)).closest('p')!;
    const strongs = [...note.querySelectorAll('strong')].map((el) => el.textContent);
    expect(strongs).toContain('Stop');
    expect(strongs).toContain('Start');
    // 굵기가 살아 있어도 **문장이 조각으로 흩어지면 안 된다** — 통째로 한 문단이다.
    expect(note.textContent).toContain('it is not started here and now');
  });

  /**
   * **오류가 영어로 뜬다.** 화면이 실제로 실패를 겪는 경로로 확인한다 — 사전만 재면
   * `setError` 가 옛 문자열을 그대로 들고 있어도 초록이다.
   */
  it('에이전트 목록을 못 받으면 영어로 그 사실을 말한다', async () => {
    seedAgents([]);
    setController({
      listAgents: vi.fn(async () => { throw new Error('down'); }),
      agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
        { harness: 'claude-code', model: null, effort: null }
      )),
      refreshAccounts: vi.fn(async () => undefined),
    } as unknown as Controller);
    render(<AgentsSettings />);
    await waitFor(() => {
      // `Failed to load` 가 아니라 **화면이 지금 무엇을 모르는지**를 말한다.
      expect(screen.getByRole('alert').textContent).toContain('did not arrive');
    });
  });

  /**
   * 이름 규칙 오류. **`Invalid name` 이 아니라 무엇이 되는지를 적는다** — 그리고
   * 왜 그 문법인지(`@name` 으로 부른다)까지 남아 있는지 함께 잰다.
   */
  it('이름 규칙 오류가 영어로 규칙과 그 이유를 다 말한다', async () => {
    seedAgents([]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-create'));
    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('lowercase letters');
    expect(alert.textContent).toContain('2 to 32 characters');
    expect(alert.textContent).toContain('@name');
  });
});

describe('에이전트 설정 — 언어를 한국어로 바꾸면 한국어로 뜬다', () => {
  beforeEach(() => speak('ko'));

  it('격자 머리와 탭이 한국어로 바뀐다', async () => {
    seedAgents([agentView()]);
    render(<AgentsSettings />);
    await screen.findByTestId('agent-card-forge');
    expect(screen.getByRole('heading', { name: '에이전트' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: '에이전트와 팀' })).toBeTruthy();
  });

  it('상세의 세 묶음 제목이 한국어로 바뀐다', async () => {
    seedAgents([agentView()]);
    render(<AgentsSettings />);
    await openDetail();
    for (const title of ['프로필', '실행', '권한']) {
      expect(screen.getByRole('heading', { name: title }), title).toBeTruthy();
    }
  });

  it('러너 실행·중지가 한국어로 바뀐다', async () => {
    seedAgents([agentView()]);
    render(<AgentsSettings />);
    await openDetail();
    expect(await screen.findByRole('button', { name: '러너 중지' })).toBeTruthy();
    expect(screen.getByText('자동 기동 대상이다 — 중지를 걸어 둔 적이 없다.')).toBeTruthy();
  });

  it('중지 안내의 굵은 마디가 한국어로도 <strong> 이다', async () => {
    seedAgents([agentView()]);
    render(<AgentsSettings />);
    await openDetail();
    const note = (await screen.findByText(/러너를 지금 끊지 않는다/)).closest('p')!;
    const strongs = [...note.querySelectorAll('strong')].map((el) => el.textContent);
    expect(strongs).toContain('중지');
    expect(strongs).toContain('실행');
  });

  it('이름 규칙 오류가 한국어로 바뀐다', async () => {
    seedAgents([]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-create'));
    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByRole('button', { name: '에이전트 만들기' }));
    expect((await screen.findByRole('alert')).textContent).toContain('2~32자');
  });
});

/**
 * **경계를 잰다 — 이 PR 이 어디까지 옮겼나.**
 *
 * `lastTurnLabel` 은 접두만 사전을 지나고 경과(`11분 전`)는 `lib/lastTurn.ts` 의 것이다.
 * 그 함수는 이 PR 의 범위 밖이고(`en.ts` 머리말의 '남은 것' 표: `Intl.RelativeTimeFormat`
 * 으로 옮길지 먼저 정해야 한다), 그래서 영어 화면에도 `Last activity: 11분 전` 이 뜬다.
 *
 * **그 어긋남을 시험이 감추지 않는 것**이 여기서 중요하다. 행 전체에 한국어가 없다고
 * 쓰면 다음 사람이 `lastTurnAgo` 도 옮긴 줄 알게 된다 — 사이드바 축이 `3분째` 를 빼고
 * 잰 것과 같은 규율이다.
 */
/**
 * **한 줄이 두 출처에서 온다 — 그 둘이 어긋나지 않는 것을 잰다.**
 *
 * 접두(`Last activity:`)는 **사전**이 내고 경과(`11 minutes ago`)는 **`Intl`** 이 낸다
 * (`lib/time.ts`: *"숫자는 `Intl` 이, 뜻은 사전이"*). 두 작업이 각자 반쪽을 옮겼고
 * (`#622` 가 경과를, `#641` 이 접두를) 여기서 만났다.
 *
 * 반쪽만 옮겨진 상태(`Last activity: 11분 전`)가 실제로 며칠 존재했다 — 컴파일도
 * 회귀선도 조용했고 **화면을 열어야만 보였다.** 그래서 이 축은 사전을 읽지 않고
 * 화면을 렌더해서 잰다.
 */
describe('에이전트 설정 — 시간 표기가 한 줄에서 만난다', () => {
  it('접두와 경과가 같은 언어로 뜬다', async () => {
    const lastTurnAt = new Date(Date.now() - 11 * 60_000).toISOString();
    seedAgents([agentView({ lastTurnAt })]);
    render(<AgentsSettings />);
    await openDetail();
    const row = await screen.findByTestId(`agent-last-turn-${AGENT_ID}`);
    // 접두는 사전에서, 경과는 `Intl` 에서 — 둘 다 영어다.
    expect(row.textContent).toBe('Last activity: 11 minutes ago');
    // 반쪽만 옮겨진 옛 상태가 다시 나타나지 않는다.
    expect(row.textContent).not.toContain('분 전');

    cleanup();
    speak('ko');
    seedAgents([agentView({ lastTurnAt })]);
    render(<AgentsSettings />);
    await openDetail();
    expect((await screen.findByTestId(`agent-last-turn-${AGENT_ID}`)).textContent)
      .toBe('마지막 활동: 11분 전');
  });

  /** 한 번도 안 돈 것은 **'죽었다'가 아니다** — `yet` 이 그 사실을 진다. */
  it("'활동 없음'이 두 언어 모두 '모른다'를 남긴다", () => {
    expect(en['agents.detail.noActivity']).toBe('No activity yet');
    expect(ko['agents.detail.noActivity']).toBe('활동 없음');
  });
});

/**
 * **복수형이 이 화면에서도 실제로 갈린다.** 뒤처진 러너를 한 번에 재기동하는 것은
 * 되돌리기 어려운 조작이고(진행 중인 턴을 기다린다), 그 이름의 개수가 곧 영향 범위다 —
 * `1 runners` 가 뜨면 그 문장이 급조된 것으로 읽히고 사람은 숫자를 다시 확인하지 않는다.
 */
describe('에이전트 설정 — 개수를 말하는 문장의 복수형', () => {
  it('영어는 1대와 2대가 다른 낱말이다', () => {
    const t = translator('en');
    expect(t('agents.stale.restart', { count: 1 })).toBe('Restart the outdated runner (1)');
    expect(t('agents.stale.restart', { count: 2 })).toBe('Restart all outdated runners (2)');
    expect(t('agents.stale.unknownVersion', { count: 1 })).toContain('1 runner of unknown version');
    expect(t('agents.stale.unknownVersion', { count: 3 })).toContain('3 runners of unknown version');
  });

  it('한국어는 수에 따라 명사가 안 바뀐다', () => {
    const t = translator('ko');
    expect(t('agents.stale.restart', { count: 1 })).toContain('(1)');
    expect(t('agents.stale.restart', { count: 7 })).toContain('(7)');
    expect(t('agents.stale.unknownVersion', { count: 7 })).toContain('러너 7대');
  });
});

/**
 * **옮기면서 사실을 잃지 않았다.** 이 화면의 오류·안내는 *"무엇이 잘못됐고 어떻게
 * 고치는가"* 를 말한다 — 낱말이 아니라 **그 사실이 두 언어에 다 있는지**를 잰다.
 */
describe('에이전트 설정 — 옮기면서 사실을 잃지 않는다', () => {
  it('끊김이 두 언어 모두 「그래서 살아 있는지 모른다」까지 말한다', () => {
    // `Disconnected` 한 단어로 줄이면 사람이 그것을 '오프라인'으로 읽는다.
    expect(en['agents.detail.disconnected'].length).toBeGreaterThan('Disconnected'.length + 10);
    expect(en['agents.detail.disconnected']).toContain('unknown');
    expect(ko['agents.detail.disconnected']).toContain('알 수 없다');
  });

  it('PAT 0개 안내가 두 언어 모두 「왜 없어졌나」까지 말한다', () => {
    // 켜진 에이전트의 0개는 러너가 못 뜬다는 뜻이고, 그 사유(비활성화가 전부 폐기했다)를
    // 함께 말해야 사람이 "고장 났나"로 읽지 않는다.
    expect(en['agents.pat.noneNeedsMint']).toContain('mint one');
    expect(en['agents.pat.noneNeedsMint']).toContain('disabling revokes them all');
    expect(ko['agents.pat.noneNeedsMint']).toContain('새로 발급');
    expect(ko['agents.pat.noneNeedsMint']).toContain('전부 폐기');
    // 꺼진 에이전트에서 0개는 **정상이다** — 그래서 재발급을 권하지 않는다.
    expect(en['agents.pat.none']).not.toContain('mint');
    expect(ko['agents.pat.none']).not.toContain('발급');
  });

  it('클립보드 실패가 두 언어 모두 「다음에 무엇을 하나」를 말한다', () => {
    // 오류만 적고 끝내면 사람은 막힌다(`#177`).
    expect(en['agents.runner.copyFailedSelected']).toContain('⌘C');
    expect(ko['agents.runner.copyFailedSelected']).toContain('⌘C');
    expect(en['agents.runner.copyFailedManual']).toContain('by hand');
    expect(ko['agents.runner.copyFailedManual']).toContain('손으로');
  });

  /**
   * **끄기 안내는 비대칭을 말한다** — 끄는 것은 되돌릴 수 있지만 PAT 는 안 돌아온다.
   * 뒤엣것을 자르면 사람은 이것을 되돌릴 수 있는 조작으로만 읽는다.
   */
  it('비활성화 안내가 두 언어 모두 「PAT 는 안 돌아온다」를 말한다', () => {
    expect(en['agents.disable.noteEnabled']).toContain('does not bring them back');
    expect(ko['agents.disable.noteEnabled']).toContain('복구되지 않아');
  });

  /**
   * **번역하지 않은 것이 번역되지 않았다.** `admin`·`PAT`·`harness`·`daemon`·`attach` 는
   * 이 제품의 고유어이고, 옮기면 사람이 문서·터미널·서버 오류에서 보는 말과 화면의 말이
   * 갈라진다(`en.ts` 의 agents 머리말).
   */
  it('제품 고유어는 두 언어에서 같은 글자다', () => {
    const pairs: [keyof typeof en, string][] = [
      ['agents.run.defaultsNotAdmin', 'admin'],
      ['agents.pat.none', 'PAT'],
      ['agents.run.harnessDefault', 'harness'],
      ['agents.runner.daemonScope', 'daemon'],
      ['agents.permissions.ownerNone', 'attach'],
    ];
    for (const [key, word] of pairs) {
      expect(en[key], `en.${key}`).toContain(word);
      expect(ko[key], `ko.${key}`).toContain(word);
    }
  });

  /**
   * **저장·전송용 값은 라벨에 그대로 선다.** `auto`/`readonly` 는 API·설정 파일에도
   * 나오는 값이라, 라벨이 그 값을 앞에 세우는 것이 두 언어 모두의 규약이다
   * (`sidebar.notify` 가 `all`/`mentions`/`none` 을 안 옮긴 것과 같다).
   */
  it('mentionPermission 값이 두 언어 모두 라벨 앞에 그대로 있다', () => {
    expect(en['agents.permissions.mentionAuto'].startsWith('auto —')).toBe(true);
    expect(ko['agents.permissions.mentionAuto'].startsWith('auto —')).toBe(true);
    expect(en['agents.permissions.mentionReadonly'].startsWith('readonly —')).toBe(true);
    expect(ko['agents.permissions.mentionReadonly'].startsWith('readonly —')).toBe(true);
  });
});
