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
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type {
  AgentDefaults, AgentTeamRow, AgentView, AskMeta, InboxEntry, MessageRow, OpenAskLink, PatView,
} from '@murmur/shared';
import { CATALOGS, LOCALES, translator, detectLocale, isLocale, type Locale } from '../src/i18n';
import { LOCALE_NAMES } from '../src/i18n';
import { AppearanceSettings } from '../src/components/settings/AppearanceSettings';
import { avatarErrorMessage } from '../src/lib/avatar';
import { ApiError } from '../src/lib/api';
import { accountOpen } from '../src/lib/accountOpen';
import { SweepShell } from '../src/components/Sweep';
import { en } from '../src/i18n/en';
import { ko } from '../src/i18n/ko';
import { interpolate } from '../src/i18n/format';
import { useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, Controller } from '../src/state/controller';
import { WaitChainSection } from '../src/components/WaitChainSection';
import { WaitChainLine } from '../src/components/WaitChain';
import { Sidebar } from '../src/components/Sidebar';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { GallerySettings } from '../src/components/settings/GallerySettings';
// 6번 묶음이 여는 화면 넷. **사전이 아니라 화면을 잰다** — 그 이유는 그 묶음 머리말에 있다.
import { Profile } from '../src/components/Profile';
import { AgentGrid } from '../src/components/settings/AgentGrid';
import { Composer } from '../src/components/Composer';
import { Inbox } from '../src/components/Inbox';
import { SkillsSettings } from '../src/components/settings/SkillsSettings';
import { AgentDefaultsSettings } from '../src/components/settings/AgentDefaultsSettings';
import { MessageItem } from '../src/components/MessageItem';
import { ProgressRow } from '../src/components/ProgressRow';
import { AgentExchange } from '../src/components/AgentExchange';
import { NotifiedGapRow } from '../src/components/NotifiedGapRow';
import { TypingLine } from '../src/components/TypingLine';
import { ThreadStateBadge } from '../src/components/ThreadStateBadge';
import { threadStateLabel, type ThreadState } from '../src/lib/threadState';
import { inboxRow } from '../src/lib/inboxRow';
import { fireEvent, within } from '@testing-library/react';
import { waitChainFromLinks } from '../src/lib/waitChain';
import { daemonFactRows } from '../src/lib/daemonFacts';
import {
  RunnerLauncher, STRANGER_ATTACHED,
  type LaunchableAgent, type RunnerSpawner,
} from '../src/lib/runnerLauncher';
import { CREDENTIAL_REJECTED_LINE, EXECUTABLE_NOT_FOUND_LINE, EX_CONFIG, HARNESS_LOGIN_REQUIRED_LINE } from '@murmur/shared';
import { fakeDaemon } from './helpers/fakeDaemon';
import type { Translate } from '../src/i18n';
import { acc, chan, msg, tm, inboxEntry, fakeApi, fakeWsFactory } from './helpers/fakeApi';
// 7번 묶음(러너·투영)이 재는 판정·화면들. **사전이 아니라 이 경로를 잰다** —
// 그 묶음 머리말이 왜인지 적었다.
import { runnerStatusLabel } from '../src/components/RunnerStatus';
import { PRESENCE_LABEL } from '../src/lib/presenceView';
import { projectionBanner } from '../src/lib/projectionBanner';
import { runnerCommandClipboardText } from '../src/lib/runnerCommand';
import { ProjectionBanner } from '../src/components/ProjectionBanner';
import { ProjectionUrl } from '../src/components/settings/ProjectionUrl';
import { writerDeniedText } from '../src/components/TerminalPanel';
import type { WriterDeniedReason } from '@murmur/shared';
import type { RunnerState, RunnerStatus } from '../src/lib/runnerLauncher';
import type { ProjectionStatus } from '@murmur/shared';
import { PROJECTION_UNCONFIGURED_HEADLINE } from '@murmur/shared';
import { SidebarFind } from '../src/components/SidebarFind';
import { StatusPicker } from '../src/components/StatusPicker';
import { StatusMark } from '../src/components/Identity';
import { SearchPalette } from '../src/components/SearchPalette';
import { TeamDetail } from '../src/components/settings/TeamDetail';
import { Rail } from '../src/components/Rail';
import { BootNotice, KEYCHAIN_NOTICE_DELAY_MS } from '../src/components/BootNotice';

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
  claudeLane: null,
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

// ---------------------------------------------------------------------------
// 7. 컴포넌트 갤러리 — **설명은 옮기고 견본은 안 옮긴다**
//
// 이 화면에는 성격이 다른 두 종류의 글이 있고(그 파일의 `base` 위 주석 · `en.ts` 의
// `gallery` 머리말), 그 경계가 **코드를 봐서는 안 보인다** — 둘 다 그냥 한국어
// 문자열이었기 때문이다. 그래서 여기서 잰다.
//
// 다음 사람이 견본까지 사전에 밀어 넣는 것을 막는 것이 이 묶음의 목적이다. 사전이
// 가짜 대화로 부풀고, 번역자가 그것을 옮겨야 할 것으로 읽게 된다.
// ---------------------------------------------------------------------------

describe('갤러리 — 설명은 사전을 지나고 견본은 안 지난다', () => {
  const seedGallery = () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me'), [FORGE]: acc(FORGE, 'forge', 'agent'), [CODEX]: acc(CODEX, 'codex', 'agent') },
    });
  };

  it('칸의 이름과 설명이 영어로 뜬다', () => {
    seedGallery();
    render(<GallerySettings />);
    expect(screen.getByText('Ask — for me')).toBeTruthy();
    expect(screen.getByText('The only card that gets the accent. It can be pressed.')).toBeTruthy();
    expect(screen.getByText('Wait chain — deadlock')).toBeTruthy();
  });

  it('언어를 바꾸면 설명이 한국어로 바뀐다', () => {
    speak('ko');
    seedGallery();
    render(<GallerySettings />);
    expect(screen.getByText('선택 — 나에게 온 것')).toBeTruthy();
    expect(screen.getByText('강조를 받는 유일한 카드. 누를 수 있다.')).toBeTruthy();
    expect(screen.getByText('대기 사슬 — 교착')).toBeTruthy();
  });

  /**
   * **이것이 이 묶음의 요점이다.** 영어로 열어도 카드 속 대화는 한국어로 남는다 —
   * 그것은 murmur 가 하는 말이 아니라 예시로 박아 둔 남의 말이고, 이 화면이 가르치는
   * 것은 그 내용이 아니라 **카드의 생김새**다.
   *
   * 어색해 보이지만 정직한 상태다. 이 축이 빨개진다면 누군가 견본을 사전에 넣었거나,
   * 반대로 견본을 영어로 다시 적어 **이 경계를 지운 것**이다.
   */
  it('영어로 열어도 카드 속 견본 대화는 한국어로 남는다', () => {
    seedGallery();
    const { container } = render(<GallerySettings />);
    expect(container.textContent).toContain('마이그레이션을 어떻게 넣을까?');
    expect(container.textContent).toContain('lint 를 다시 불러 줘');
    // 그 문장들이 사전에 새어 들지 않았다.
    const values = Object.values(en).map((v) => (typeof v === 'string' ? v : Object.values(v).join(' ')));
    for (const sample of ['마이그레이션', 'lint 를 다시', 'heartbeat.ts 를 읽는다']) {
      expect(values.some((v) => v.includes(sample)), `견본이 en 사전에 있다: ${sample}`).toBe(false);
    }
  });

  /**
   * `…` 는 **한 곳에서 온다**(`GallerySettings::ELLIPSIS`). 문장에 끼우는 쪽과 다른 색을
   * 입히려고 자르는 쪽이 같은 값을 써야 하고, 갈라지면 자르기가 조용히 실패해 문단이
   * 통째로 한 색이 된다 — 화면은 여전히 서므로 아무도 모른다.
   */
  it('이름이 빌 때의 안내가 두 언어로 뜨고 말줄임만 다른 색이다', () => {
    useActiveStore.getState().set({ me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me') } });
    render(<GallerySettings />);
    const p = screen.getByText(/name slots stay as/);
    expect(p.querySelector('.text-fg-subtle')?.textContent).toBe('…');

    cleanup();
    speak('ko');
    useActiveStore.getState().set({ me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me') } });
    render(<GallerySettings />);
    expect(screen.getByText(/이름 자리가/).querySelector('.text-fg-subtle')?.textContent).toBe('…');
  });
});

// ---------------------------------------------------------------------------
// 8. 대화 화면 — **사용자가 가장 많이 보는 자리가 두 언어로 뜬다**
//
// 이 묶음이 옮긴 것은 어휘 셋이다: 여덟 가지 말(`speech.*`) · 메시지 행의 살림
// (`message.*`) · `lib/` 판정 둘(`thread.*`·`inbox.*`).
//
// **화면을 렌더해서 잰다.** 사전을 직접 읽는 것으로는 부족하다는 것을 이 저장소가
// 이미 두 번 겪었다(`NOTIFY_LEVEL_LABEL`·`SkillsSettings` 의 세 칸 이름) — 사전이
// 갈려 있어도 **화면이 `t()` 를 안 지나면** 그 화면은 한 언어로 굳는다. 이 PR 이
// 찾은 굳음이 `threadState::THREAD_STATE_LABEL` 이고, 그 자리를 아래 `thread.*` 축이
// 렌더로 잰다.
//
// 다른 회귀선 열넷은 **한국어로 고정돼 있다**(각 파일의 `beforeEach` 주석) — 그것들이
// 재는 것은 언어가 아니라 그 언어로 표현된 규율이고, 언어를 재는 자리는 여기 하나다.
// ---------------------------------------------------------------------------

const ALPHA = 'a-alpha';

/** 요약 줄 하나가 서는 메시지 행. 사슬·상태·답글 수를 한 자리에서 그린다. */
function seedRow(over: Record<string, unknown> = {}): MessageRow {
  useActiveStore.getState().set({
    me: acc(ME, 'me'),
    accounts: {
      [ME]: acc(ME, 'me'),
      [FORGE]: acc(FORGE, 'forge', 'agent'),
      [CODEX]: acc(CODEX, 'codex', 'agent'),
      [ALPHA]: acc(ALPHA, 'alpha', 'agent'),
    },
    messages: { c1: [] },
    online: [FORGE, CODEX, ALPHA],
    connected: true,
  });
  return msg('m1', 'c1', 1, '루트', ALPHA, {
    replyCount: 2,
    participantIds: [ALPHA, FORGE],
    openAskHumanCount: 0,
    openAskAccountIds: [],
    failureCount: 0,
    lastKind: 'user',
    lastAuthorId: ALPHA,
    ...over,
  });
}

/** 선택 요청 하나. `to` 로 누구에게 갔는지를 정한다. */
const askMeta = (to: AskMeta['ask']['to'], over: Record<string, unknown> = {}) => ({
  kind: 'ask',
  ask: { options: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }], to, ...over },
} as unknown as Record<string, unknown>);

describe('여덟 가지 말 — 카드가 두 언어로 말한다', () => {
  beforeEach(() => {
    setController({ answerAsk: async () => undefined, openThread: async () => undefined } as unknown as Controller);
  });

  /**
   * **선택 요청의 머리글은 넷이 한 축에 선다** — 내가 · 그 에이전트가 · 사람 아무나 ·
   * 이미 끝났다. 넷이 서로 달라야 이 카드가 답하는 유일한 질문("누가 답해야 하나")이
   * 글자로 읽힌다. 언어를 바꿔도 그 넷이 여전히 넷이어야 한다.
   */
  it.each(LOCALES)('%s 에서 선택 카드의 머리글 넷이 서로 다르다', (locale) => {
    speak(locale);
    const heads = [
      { to: { kind: 'human' as const }, mine: true },
      { to: { kind: 'account' as const, accountId: CODEX }, mine: false },
      { to: { kind: 'human' as const }, mine: false },
      { to: { kind: 'human' as const }, mine: true, answered: true },
    ].map(({ to, mine, answered }) => {
      cleanup();
      const row = seedRow();
      if (!mine) useActiveStore.getState().set({ me: null });
      render(<MessageItem message={{ ...row, meta: askMeta(to, answered ? { answeredWith: 'o1' } : {}) }} />);
      return screen.getByTestId('ask-card').textContent ?? '';
    });
    // 넷이 서로 다르다 — 하나라도 겹치면 그 두 경우가 화면에서 구별되지 않는다.
    expect(new Set(heads).size).toBe(4);
  });

  it('선택 카드가 영어로 뜨고, 한국어로 바꾸면 따라온다', () => {
    const row = seedRow();
    render(<MessageItem message={{ ...row, meta: askMeta({ kind: 'human' }) }} />);
    expect(screen.getByTestId('ask-card').textContent).toContain('Pick one');

    cleanup();
    speak('ko');
    const ko1 = seedRow();
    render(<MessageItem message={{ ...ko1, meta: askMeta({ kind: 'human' }) }} />);
    expect(screen.getByTestId('ask-card').textContent).toContain('골라 줘');
  });

  /**
   * **답한 사람의 이름에 조사가 붙는다.** 옛 화면은 받침을 몰라 `이(가)` 로 둘 다
   * 적었는데, 조사가 번역기 안으로 들어가면서(`{name:이가}`) 이름을 보고 하나를 고른다.
   * 영어는 이 코드를 안 지난다 — 그것이 문법을 그 언어의 파일에만 두는 이유다.
   */
  it('답한 사람의 조사가 한국어에서만 붙는다', () => {
    speak('ko');
    const row = seedRow();
    render(<MessageItem message={{
      ...row,
      meta: askMeta({ kind: 'human' }, { answeredWith: 'o1', answeredBy: FORGE }),
    }} />);
    expect(screen.getByTestId('ask-card').textContent).toContain('forge 가 골랐다');

    cleanup();
    speak('en');
    const row2 = seedRow();
    render(<MessageItem message={{
      ...row2,
      meta: askMeta({ kind: 'human' }, { answeredWith: 'o1', answeredBy: FORGE }),
    }} />);
    const text = screen.getByTestId('ask-card').textContent ?? '';
    expect(text).toContain('forge picked');
    // 조사 표기가 영어로 새면 여기서 `{name:이가}` 가 그대로 보인다.
    expect(text).not.toMatch(/[가-힣]/);
  });

  /**
   * **실패는 두 언어 모두 「스스로 못 끝냈다」를 말한다**(규칙 03). `Failed` 로 접으면
   * 판정이 되는데, 이것은 에이전트가 **먼저 사람을 부르는 말**이다 — 1인칭의 무게가
   * 그 문장에 있어야 한다.
   */
  it('실패 카드가 두 언어 모두 못 끝냈다는 사실과 고치는 경로를 함께 낸다', () => {
    const failure = { kind: 'failure', failure: { retryable: true } } as unknown as Record<string, unknown>;
    const row = seedRow();
    render(<MessageItem message={{ ...row, meta: failure }} />);
    let card = screen.getByTestId('failure-card').textContent ?? '';
    expect(card).toContain('Could not finish it');
    // **고치는 경로가 같은 자리에**(규칙 05) — 문구를 옮기면서 그 버튼이 사라지지 않는다.
    expect(card).toContain('Call again');
    expect(card).not.toMatch(/[가-힣]/);

    cleanup();
    speak('ko');
    const row2 = seedRow();
    render(<MessageItem message={{ ...row2, meta: failure }} />);
    card = screen.getByTestId('failure-card').textContent ?? '';
    expect(card).toContain('끝내지 못했다');
    expect(card).toContain('다시 부르기');
  });

  /**
   * **완료 보고의 세 구획이 한 축에 선다** — 무엇을 했나 · 무엇이 바뀌었나 · 무엇이
   * 남았나. 셋이 서로 달라야 이 카드가 가장 오래 남고 다시 읽히는 말이 된다.
   *
   * 그리고 **항목은 사전을 안 지난다** — 그것은 에이전트가 한 말이지 앱의 말이 아니다.
   * 영어로 열어도 항목이 한국어로 남는 것이 정직한 상태다(갤러리의 견본과 같은 경계).
   */
  it.each(LOCALES)('%s 에서 보고의 세 머리는 옮겨지고 항목은 안 옮겨진다', (locale) => {
    speak(locale);
    const report = {
      kind: 'report',
      report: { checks: ['타입체크 통과'], files: ['src/a.ts'], remaining: ['문서 갱신'] },
    } as unknown as Record<string, unknown>;
    const row = seedRow();
    render(<MessageItem message={{ ...row, meta: report }} />);
    const card = screen.getByTestId('report-card');
    const heads = ['report-checks', 'report-files', 'report-remaining']
      .map((id) => card.querySelector(`[data-testid="${id}"]`)?.previousElementSibling?.textContent);
    expect(new Set(heads).size).toBe(3);
    // 항목은 에이전트가 한 말이라 두 언어 모두 그대로다.
    expect(card.textContent).toContain('타입체크 통과');
    expect(card.textContent).toContain('문서 갱신');
  });

  /**
   * **진행은 상[aspect]으로 갈린다** — 도는 것과 끝난 것이 다른 낱말이어야 한다.
   * 옛 코드는 `elapsed.replace(/째$/, '')` 로 한국어 어미를 잘라 영어에서 아무것도
   * 안 잘렸고, 그 결함을 `lib/time.ts` 가 고쳤다. 이제 **낱말 쪽도** 같은 축을 갖는다.
   */
  it.each(LOCALES)('%s 에서 도는 진행과 끝난 진행이 다른 낱말이다', (locale) => {
    speak(locale);
    const progress = (id: string) => msg(id, 'c1', 1, '무언가 한다', ALPHA, { kind: 'progress' });
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me'), [ALPHA]: acc(ALPHA, 'alpha', 'agent') },
    });
    render(<ProgressRow messages={[progress('p1')]} />);
    const running = screen.getByTestId('progress-row').textContent ?? '';
    cleanup();
    render(<ProgressRow messages={[progress('p2')]} endedAt={new Date().toISOString()} />);
    const ended = screen.getByTestId('progress-row').textContent ?? '';
    expect(running).not.toBe(ended);
  });

  /**
   * **접힌 줄은 결론을 먼저 말한다**(#488 C1). 결론이 없는 구간에서도 그 사실을
   * 말해야 하고(`yet` 이 진다), 횟수는 그 뒤에 붙는다.
   */
  it('주고받기 줄이 두 언어 모두 결론 · 횟수 · 마지막을 낸다', () => {
    const exchange = [
      msg('e1', 'c1', 1, 'a', FORGE),
      msg('e2', 'c1', 2, 'b', CODEX),
      msg('e3', 'c1', 3, 'c', FORGE),
    ];
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me'), [FORGE]: acc(FORGE, 'forge', 'agent'), [CODEX]: acc(CODEX, 'codex', 'agent') },
    });
    render(<AgentExchange messages={exchange} />);
    let line = screen.getByTestId('agent-exchange').textContent ?? '';
    // **`yet` 이 진다** — 빼면 "아무것도 안 정해진다"는 판정이 된다.
    expect(line).toContain('Nothing decided yet');
    expect(line).toContain('3 exchanges');
    expect(line).toMatch(/last /);
    expect(line).not.toMatch(/[가-힣]/);

    cleanup();
    speak('ko');
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me'), [FORGE]: acc(FORGE, 'forge', 'agent'), [CODEX]: acc(CODEX, 'codex', 'agent') },
    });
    render(<AgentExchange messages={exchange} />);
    line = screen.getByTestId('agent-exchange').textContent ?? '';
    expect(line).toContain('아직 정해진 것 없음');
    expect(line).toContain('3번 주고받음');
    expect(line).toContain('마지막');
  });
});

describe('메시지 행 — 살림이 두 언어로 뜬다', () => {
  beforeEach(() => {
    setController({ openThread: async () => undefined } as unknown as Controller);
  });

  /**
   * **답글 수의 복수형이 실제로 갈린다.** 여기 있던 `=== 1 ? 'reply' : 'replies'` 가
   * 이 PR 이 옮긴 손수 복수형이고, 그것이 사용자가 물은 그 축이다. 한국어가 한 갈래인
   * 것은 누락이 아니라 그 언어의 사실이므로 같은 축에서 함께 잰다.
   */
  it('영어는 1개와 2개가 다른 낱말이고 한국어는 하나다', () => {
    /**
     * **눈에 보이는 글자를 잰다.** `aria-label` 만 재면 안 잡힌다 — 접근 이름은 사전을
     * 지나는데 화면의 그 조각은 옛 손수 복수형을 그대로 들고 있을 수 있고, 실제로
     * RED 로 확인했다(2026-09-08): `=== 1 ? 'reply' : 'replies'` 를 되살려도 이름만
     * 재는 축은 **전부 초록이었다**. 그래서 화면 글자와 접근 이름을 **둘 다** 잰다.
     */
    const visible = (): string => screen.getByTestId('reply-summary-count').textContent ?? '';
    const label = (): string =>
      screen.getByRole('button', { name: /(replies|reply|답글)/ }).getAttribute('aria-label') ?? '';

    render(<MessageItem message={seedRow({ replyCount: 1 })} />);
    expect(visible()).toBe('1 reply');
    expect(label()).toContain('1 reply');

    cleanup();
    render(<MessageItem message={seedRow({ replyCount: 2 })} />);
    expect(visible()).toBe('2 replies');
    expect(label()).toContain('2 replies');

    cleanup();
    speak('ko');
    render(<MessageItem message={seedRow({ replyCount: 1 })} />);
    // **한국어는 한 갈래다** — 수에 따라 명사가 안 바뀌는 것이 그 언어의 사실이다.
    expect(visible()).toBe('답글 1개');
    cleanup();
    render(<MessageItem message={seedRow({ replyCount: 2 })} />);
    expect(visible()).toBe('답글 2개');
  });

  /**
   * **접근 이름이 조각을 그 언어의 방식으로 잇는다.** 상태와 마지막 시각이 각각 없을
   * 수 있어 틀이 넷인데, 한 틀에 빈 문자열을 끼우면 영어에서 `, 2 replies` 처럼 쉼표가
   * 앞에 남는다 — 눈으로는 안 보이고 귀로만 들리는 결함이다.
   */
  it('요약 줄의 접근 이름이 두 언어 모두 앞뒤에 쉼표를 흘리지 않는다', () => {
    for (const locale of LOCALES) {
      cleanup();
      speak(locale);
      // 상태도 시각도 없는 가장 짧은 틀. 여기서 쉼표가 남으면 나머지 셋도 남는다.
      const row = seedRow({ openAskHumanCount: null, openAskAccountIds: null, failureCount: null });
      render(<MessageItem message={row} />);
      // 요약 줄은 답글 수를 이름에 싣는 유일한 버튼이다 — testid 가 없으므로 그것으로 찾는다.
      const label = [...document.querySelectorAll('button')]
        .map((b) => b.getAttribute('aria-label'))
        .find((v) => v !== null && /(replies|답글)/.test(v))!;
      expect(label, `${locale} 의 접근 이름이 없다`).toBeTruthy();
      // 상태도 시각도 없으므로 **수만** 남아야 한다 — 쉼표가 남으면 틀을 한 벌로 접은 것이다.
      expect(label, `${locale} 의 접근 이름`).not.toMatch(/^\s*,|,\s*$/);
      expect(label, `${locale} 의 접근 이름에 빈 조각이 있다`).not.toContain(', ,');
    }
  });

  /**
   * **수신자 배지가 두 언어로 뜬다**(규칙 04). 이 배지 하나로 팀 스레드의 "무엇이 내
   * 일인가"가 풀리므로, 나에게 온 것과 남에게 간 것이 **서로 다른 글자**여야 한다.
   */
  it('수신자 배지가 두 언어 모두 나와 남을 가른다', () => {
    for (const locale of LOCALES) {
      cleanup();
      speak(locale);
      /**
       * **셋을 잰다.** 나에게 온 것 · 이름 있는 에이전트에게 간 것 · **사람 아무나에게
       * 간 것**(내가 사람이 아닐 때). 앞의 둘만 재면 안 잡힌다 — `audience.person` 은
       * 세 번째 경우에만 그려지고, RED 로 확인했다(2026-09-08): 그 문구를 `→ you` 로
       * 바꿔도 앞의 둘만 재는 축은 **초록이었다**.
       */
      const badge = (over: Record<string, unknown>, meNull = false): string => {
        cleanup();
        const row = seedRow(over);
        if (meNull) useActiveStore.getState().set({ me: null });
        render(<MessageItem message={row} />);
        return screen.getByTestId('audience-badge').textContent ?? '';
      };

      const forMe = badge({ meta: askMeta({ kind: 'human' }) });
      const forAgent = badge({ meta: askMeta({ kind: 'account', accountId: CODEX }) });
      const forPerson = badge({ meta: askMeta({ kind: 'human' }) }, true);

      expect(new Set([forMe, forAgent, forPerson]).size, `${locale} 의 수신자 배지`).toBe(3);
      // 화살표는 **두 언어 모두** 남는다 — 방향을 말하는 기호이고 이름과 떨어지면 뜻을 잃는다.
      for (const b of [forMe, forAgent, forPerson]) expect(b).toContain('→');
    }
  });

  /**
   * **덜 깬 부름은 수와 사유를 함께 말한다**(규칙 05). 수만 말하면 사람이 다음에 무엇을
   * 할지 모르고, 그러면 이 줄은 놀라게만 하고 끝난다. 영어 원본이 그 사유를 잃지 않는다.
   */
  it('덜 깬 부름이 두 언어 모두 수와 사유를 함께 낸다', () => {
    useActiveStore.getState().set({
      me: acc(ME, 'me'),
      accounts: { [ME]: acc(ME, 'me') },
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release', kind: 'group' } },
    });
    render(<NotifiedGapRow messageId="m1" />);
    let row = screen.getByTestId('notified-gap').textContent ?? '';
    expect(row).toContain('3');
    expect(row).toContain('2');
    // **사람이 다음에 할 일**이 문장에 있다 — 채널 멤버로 넣는 것.
    expect(row).toContain('channel members');
    expect(row).not.toMatch(/[가-힣]/);

    cleanup();
    speak('ko');
    render(<NotifiedGapRow messageId="m1" />);
    row = screen.getByTestId('notified-gap').textContent ?? '';
    expect(row).toContain('3명을 불렀는데 2명만 깼다');
    expect(row).toContain('채널 멤버로 넣어야');
  });

  /**
   * **집합과 팀의 사유가 갈린다** — 그 파일이 실측으로 갈라 둔 것이고, 한 문장으로
   * 접으면 꺼 둔 에이전트 때문에 뜬 줄이 "채널 멤버로 넣어라"고 말한다(규칙 05 가
   * 막는 헛된 개입). 영어에서도 그 갈림이 남아야 한다.
   */
  it.each(LOCALES)('%s 에서 집합·팀·섞인 것의 사유가 서로 다르다', (locale) => {
    speak(locale);
    // 섞어 부른 경우는 스토어에서 `kind: null` 이다 — 아무 쪽도 주장할 수 없다는 뜻이고,
    // 그 자리를 `mixed` 문구가 받는다(`NotifiedGapRow` 의 `gap.kind ?? 'mixed'`).
    const reasons = ([{ kind: 'group' as const }, { kind: 'team' as const }, { kind: null }]).map(({ kind }) => {
      cleanup();
      useActiveStore.getState().set({
        me: acc(ME, 'me'),
        accounts: { [ME]: acc(ME, 'me') },
        notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: null, kind } },
      });
      render(<NotifiedGapRow messageId="m1" />);
      /**
       * **사유 조각만 잰다.** 줄 전체를 재면 안 잡힌다 — 줄 머리(`집합`·`팀`·`부른
       * 명단`)가 이미 셋이라, 사유 셋을 한 문장으로 접어도 줄 전체는 여전히 셋이다.
       * RED 로 확인했다(2026-09-08): 팀의 사유를 집합의 것으로 바꿔도 줄 전체를 재는
       * 축은 **초록이었다**. 사유는 이 줄의 마지막 조각이다(`text-fg-muted`).
       */
      const spans = screen.getByTestId('notified-gap').querySelectorAll('span');
      return spans[spans.length - 1]?.textContent ?? '';
    });
    expect(new Set(reasons).size).toBe(3);
  });

  /**
   * **입력 중 줄의 두 갈래가 사전에서도 둘이다.** 이름을 부르는 갈래와 수만 세는
   * 갈래가 한 키로 묶이면 번역자가 `{names}` 나 `{count}` 중 하나를 지운다 — 그러면
   * 그 갈래에서 화면이 조용히 빈다.
   */
  it('입력 중 줄이 두 언어 모두 이름 갈래와 수 갈래를 낸다', () => {
    const seedTyping = (ids: string[]) => useActiveStore.getState().set({
      activeChannelId: 'c1',
      accounts: {
        [FORGE]: acc(FORGE, 'forge', 'agent'),
        [CODEX]: acc(CODEX, 'codex', 'agent'),
        [ALPHA]: acc(ALPHA, 'alpha', 'agent'),
      },
      typing: { c1: ids },
    });

    seedTyping([FORGE, CODEX]);
    render(<TypingLine />);
    expect(screen.getByTestId('typing-line').textContent).toContain('forge, codex');
    cleanup();
    seedTyping([FORGE, CODEX, ALPHA]);
    render(<TypingLine />);
    // 셋부터는 이름을 안 부르고 수만 센다 — 그 판단은 화면의 것이고 두 언어에 같다.
    expect(screen.getByTestId('typing-line').textContent).toBe('3 people are typing…');

    cleanup();
    speak('ko');
    seedTyping([FORGE, CODEX]);
    render(<TypingLine />);
    expect(screen.getByTestId('typing-line').textContent).toBe('forge, codex 입력 중…');
    cleanup();
    seedTyping([FORGE, CODEX, ALPHA]);
    render(<TypingLine />);
    expect(screen.getByTestId('typing-line').textContent).toBe('3명이 입력 중…');
  });
});

/**
 * **`lib/` 판정 둘 — 훅을 못 쓰는 자리가 언어를 굳히지 않는다.**
 *
 * 두 판정 다 화면이 아니라 순수 함수라 `useT` 를 못 쓰고, 그래서 **번역기를 필수 인자로
 * 맨 뒤에** 받는다(`lastTurnAgo`·`daemonFactRows` 와 같은 자리). 기본값을 주면 안 넘긴
 * 화면이 조용히 한 언어로 굳는데, 타입이 그것을 막는다 — 그 사실을 여기서 **문구로**
 * 한 번 더 잰다.
 */
describe('스레드 상태 — 판정이 두 언어로 말한다', () => {
  const all: ThreadState[] = ['my-turn', 'stuck', 'waiting', 'running', 'done'];

  it('다섯이 두 언어 모두 서로 다른 글자를 받는다', () => {
    for (const locale of LOCALES) {
      const t = translator(locale);
      const labels = all.map((s) => threadStateLabel(s, t));
      expect(new Set(labels).size, `${locale} 의 5단`).toBe(all.length);
    }
    // 두 언어가 실제로 갈린다 — 같으면 옮긴 것이 아니다.
    expect(threadStateLabel('my-turn', translator('en')))
      .not.toBe(threadStateLabel('my-turn', translator('ko')));
  });

  /**
   * **모듈 상수였던 자리를 렌더로 잰다.** `THREAD_STATE_LABEL` 이 `Record<..., string>`
   * 이라 로드 시점 언어로 굳어 있었고, 위 축(판정 함수를 직접 부르는 것)만으로는 그
   * 굳음을 못 잡는다 — 화면이 그 함수를 부르지 않고 옛 상수를 계속 읽어도 초록이기
   * 때문이다. 그래서 배지를 **실제로 그려서** 언어가 따라오는지 본다.
   */
  it('배지가 화면에서 언어를 따라온다 — 모듈 상수로 굳지 않는다', () => {
    render(<ThreadStateBadge state="my-turn" />);
    expect(screen.getByTestId('thread-state').textContent).toBe('Your turn');

    cleanup();
    speak('ko');
    render(<ThreadStateBadge state="my-turn" />);
    expect(screen.getByTestId('thread-state').textContent).toBe('내 차례');
  });
});

describe('인박스 줄 — 판정이 두 언어로 말한다', () => {
  const entry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
    id: 1, messageId: 'm1', reason: 'thread_reply', readAt: null, channelId: 'c1',
    authorId: ALPHA, body: '본문', meta: {}, createdAt: '2026-09-08T00:00:00.000Z',
    threadRootId: null, ...over,
  });

  /**
   * **여섯이 서로 다르다** — 그것이 이 판정의 존재 이유다(*"네 줄이 글자 하나까지
   * 똑같다"*). 언어를 바꿔도 여섯이 여전히 여섯이어야 한다.
   */
  it.each(LOCALES)('%s 에서 여섯 말표가 서로 다르다', (locale) => {
    const t = translator(locale);
    const labels = [
      inboxRow(entry({ meta: askMeta({ kind: 'human' }) }), ME, t).label,
      inboxRow(entry({ meta: askMeta({ kind: 'account', accountId: CODEX }) }), ME, t).label,
      inboxRow(entry({ meta: { kind: 'failure', failure: { retryable: true } } }), ME, t).label,
      inboxRow(entry({ meta: { kind: 'report', report: { checks: ['ok'] } } }), ME, t).label,
      inboxRow(entry({ reason: 'mention' }), ME, t).label,
      inboxRow(entry({ reason: 'thread_reply' }), ME, t).label,
    ];
    expect(new Set(labels).size).toBe(6);
  });

  it('말표가 두 언어로 갈리고 DM 만 그대로다', () => {
    const en1 = inboxRow(entry({ meta: { kind: 'failure', failure: { retryable: true } } }), ME, translator('en'));
    const ko1 = inboxRow(entry({ meta: { kind: 'failure', failure: { retryable: true } } }), ME, translator('ko'));
    expect(en1.label).toBe('Stuck');
    expect(ko1.label).toBe('막혔다');
    // `DM` 은 **이 제품의 고유어**다 — `waitChain.dm` 이 같은 판단을 이미 했다.
    expect(inboxRow(entry({ reason: 'dm' }), ME, translator('en')).label).toBe('DM');
    expect(inboxRow(entry({ reason: 'dm' }), ME, translator('ko')).label).toBe('DM');
  });

  /** **rank 는 언어를 안 탄다** — 말표만 바뀌고 정렬은 그대로여야 한다. */
  it.each(LOCALES)('%s 에서 rank 가 같다 — 정렬은 언어를 안 탄다', (locale) => {
    const t = translator(locale);
    expect(inboxRow(entry({ meta: askMeta({ kind: 'human' }) }), ME, t).rank).toBe(0);
    expect(inboxRow(entry({ meta: { kind: 'report', report: { checks: ['ok'] } } }), ME, t).rank).toBe(1);
    expect(inboxRow(entry({ reason: 'thread_reply' }), ME, t).rank).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// `lib/` 판정 — **사전만 읽지 않고 판정 함수를 두 언어로 부른다**
//
// 이 묶음이 앞의 것들과 다른 점: 위 축들은 화면을 렌더하거나 사전 값을 직접 읽는데,
// 여기서는 **판정 함수에 언어를 넘겨 나온 글자**를 잰다. `#619` 가 (a)(키만 낸다)를
// 버린 이유가 그것이다 — 키가 오는 것과 그것이 사람이 읽을 말이 되는 것은 다른 사실이고,
// 이 저장소의 판정 회귀선이 지키는 것은 뒤엣것이다.
// ---------------------------------------------------------------------------

describe('daemon 사실 — 판정이 두 언어로 말한다', () => {
  const enT = translator('en');
  const koT = translator('ko');
  /** 목업의 여섯 행이 나오는 관측. `daemonFacts.test.tsx` 의 `fullRunner` 와 같은 모양이다. */
  const runner = {
    agentId: 'forge', alive: true, adopted: false,
    pid: 48127, incarnationId: '3',
    startedAtMs: new Date(2026, 8, 7, 16, 5).getTime(),
    termSentAtMs: null,
  };
  const noStop = { requestedAtMs: null, ackedAtMs: null };
  const rows = (locale: Locale, t: typeof enT, now = runner.startedAtMs + 60_000) =>
    Object.fromEntries(
      daemonFactRows(runner, noStop, now, locale, t).map((r) => [r.key, r]),
    );

  it('라벨이 언어를 따른다 — 값 칸만 바뀌고 라벨이 안 바뀌면 표가 반쪽만 옮겨진 것이다', () => {
    const e = rows('en', enT);
    const k = rows('ko', koT);

    expect(e.liveness!.label).toBe('Liveness');
    expect(k.liveness!.label).toBe('생사');
    expect(e.uptime!.label).toBe('Uptime');
    expect(k.uptime!.label).toBe('가동');
    // `pid` 는 **두 언어가 같다** — 필드 이름이라 옮기지 않는다(`en.ts` 머리말).
    expect(e.pid!.label).toBe('pid');
    expect(k.pid!.label).toBe('pid');
  });

  /**
   * **`kill(pid, 0)` 이 두 언어에 다 남는다.** 어떻게 알았는지를 값에 적는 것이 이 구획의
   * 태도이고(`daemonFacts.test.tsx` 의 그 축), 옮기면서 그 호출 이름을 번역하면
   * 사람이 `ps` 와 daemon 로그에서 보는 말과 화면의 말이 갈라진다.
   */
  it('생사가 두 언어 모두 kill(pid, 0) 을 그대로 적는다', () => {
    expect(rows('en', enT).liveness!.value).toContain('kill(pid, 0)');
    expect(rows('ko', koT).liveness!.value).toContain('kill(pid, 0)');
    // `alive` 도 상태의 이름이라 안 옮긴다.
    expect(rows('en', enT).liveness!.value).toContain('alive');
    expect(rows('ko', koT).liveness!.value).toContain('alive');
  });

  /**
   * **경과가 같은 줄에서 언어를 따른다.** 가동 행은 사전의 틀(`{stamp} 부터 · {elapsed}`)과
   * `Intl` 이 만든 길이가 한 줄에서 만나는 자리다 — 둘 중 하나만 언어를 따르면 그 줄이
   * 두 언어로 뜬다(`agents.detail.lastTurn` 이 같은 축을 갖는 이유).
   */
  it('가동 행에서 틀과 경과가 같은 언어로 뜬다', () => {
    const now = runner.startedAtMs + 4 * 3_600_000 + 12 * 60_000;
    expect(rows('en', enT, now).uptime!.value).toContain('since');
    expect(rows('en', enT, now).uptime!.value).toContain('4h 12m');
    expect(rows('ko', koT, now).uptime!.value).toContain('부터');
    expect(rows('ko', koT, now).uptime!.value).toContain('4시간 12분');
  });

  /**
   * **주어가 두 언어에 다 있다** — `#443` 의 제약 1. 이것이 이 행의 존재 이유다:
   * 주어를 빼면 서버 쪽 사실과 daemon 쪽 사실이 서로를 반박하는 것처럼 읽힌다
   * (`daemonProtocol.ts::RunnerInfo.termSentAtMs` 의 표).
   */
  it('종료 요청이 두 언어 모두 **누가 했는지**로 시작한다', () => {
    const req = new Date(2026, 8, 8, 10, 23).getTime();
    const ask = (locale: Locale, t: typeof enT) => daemonFactRows(
      runner, { requestedAtMs: req, ackedAtMs: null }, req + 60_000, locale, t,
    ).find((r) => r.key === 'termination')!.value;

    expect(ask('en', enT)).toContain('A person');
    expect(ask('en', enT)).toContain('10:23');
    // **`yet` 이 진다** — 빠지면 '영영 못 읽는다'로 읽힌다.
    expect(ask('en', enT)).toContain('has not read it yet');
    expect(ask('ko', koT)).toContain('사람이 UI 에서');
    expect(ask('ko', koT)).toContain('러너가 아직 못 읽음');
  });

  /**
   * **제약 2 가 영어에서도 지켜진다.** `daemonFacts.test.tsx` 는 한국어 판정 낱말을
   * 재는데, 그 축이 지키는 것은 언어가 아니라 **문구의 성질**이다 — 경과는 적되
   * 이상하다고 판정하지 않는다. 영어 원본을 새로 썼으므로 영어로도 재야 한다.
   */
  it('시그널 행이 두 언어 모두 경과만 적고 판정하지 않는다', () => {
    const sent = new Date(2026, 8, 8, 10, 23).getTime();
    // 롱폴링 기본 예산(25초)을 한참 넘긴 4분 12초. **이래도 판정하지 않는다.**
    const late = sent + 4 * 60_000 + 12_000;
    const signal = (locale: Locale, t: typeof enT) => daemonFactRows(
      { ...runner, termSentAtMs: sent, alive: true }, noStop, late, locale, t,
    ).find((r) => r.key === 'signal')!.value;

    // 사실은 적는다.
    expect(signal('en', enT)).toContain('still alive');
    expect(signal('en', enT)).toContain('4m 12s');
    expect(signal('ko', koT)).toContain('아직 살아 있다');
    expect(signal('ko', koT)).toContain('4분 12초');
    // 판정은 안 한다 — 이 낱말이 들어오면 그 숫자가 어느 배포에서는 거짓이 된다.
    for (const verdict of ['abnormal', 'stuck', 'not responding', 'problem', 'failed', 'too ']) {
      expect(signal('en', enT).toLowerCase()).not.toContain(verdict);
    }
    for (const verdict of ['이상', '비정상', '멈췄', '문제', '실패', '너무']) {
      expect(signal('ko', koT)).not.toContain(verdict);
    }
  });
});

describe('러너 사유 — 판정이 두 언어로 말한다', () => {
  const enT = translator('en');
  const koT = translator('ko');

  const agent = (extra: Partial<LaunchableAgent> = {}): LaunchableAgent => ({
    id: 'a', handle: 'a', ownerAccountId: 'me', disabled: false,
    stopRequestedAt: null, harness: 'claude-code', ...extra,
  });

  /** 자식을 띄운 뒤 원하는 코드·꼬리로 죽인다 — `exitStateFor78` 을 **실제 경로로** 부른다. */
  async function 죽인다(a: LaunchableAgent, tail: string[], t: Translate) {
    let onExit: ((code: number | null, tailLines?: string[]) => void) | undefined;
    const spawner: RunnerSpawner = {
      spawn: async (req) => {
        onExit = req.onExit;
        return { kill: async () => {} };
      },
    };
    const launcher = new RunnerLauncher(
      {
        baseUrl: 'https://murmur.example',
        listPats: async () => [],
        mintPat: async (_id: string, label: string) => `murp_${label}`,
        revokePat: async () => ({ revoked: 1 }),
      },
      {
        read: async () => ({ ok: true as const, value: null }),
        write: async () => {},
        clear: async () => {},
        deviceId: async () => 'ab12cd34',
      },
      spawner,
      { read: async () => '/login/bin' },
      () => 0,
      fakeDaemon(),
      undefined,
      undefined,
      t,
    );
    await launcher.startAll({ agents: [a], myAccountId: 'me', liveAccountIds: new Set<string>() });
    onExit!(EX_CONFIG, tail);
    return launcher.getStates()[0]!;
  }

  /**
   * **이 축이 이 PR 의 핵심이다.** 러너 실패 사유 넷은 사람이 할 일이 각각 다르고
   * (`en.ts` 의 runner 머리말 표), 영어 원본이 그 갈림을 잃으면 사람은 셋 중 둘에서
   * 틀린 일을 한다. 그래서 **영어로도 넷이 서로 다른 말을 하는지**를 잰다.
   */
  it('78 의 네 갈래가 영어에서도 갈린다 — 사람이 할 일이 다르기 때문이다', async () => {
    const notFound = await 죽인다(agent(), [EXECUTABLE_NOT_FOUND_LINE], enT);
    const login = await 죽인다(agent(), [HARNESS_LOGIN_REQUIRED_LINE], enT);
    const rejected = await 죽인다(agent(), [CREDENTIAL_REJECTED_LINE], enT);
    const unknown = await 죽인다(agent(), ['something else entirely'], enT);

    // ① 설치한다 — **이름과 PATH 를 둘 다** 말한다(`#473`+`#476`).
    expect(notFound.status).toBe('needs_harness');
    expect(notFound.message).toContain('claude');
    expect(notFound.message).toContain('PATH');
    // **자격증명 이야기를 하지 않는다** — 그것이 `#473` 이 고친 결함이다.
    expect(notFound.message).not.toMatch(/PAT(?!H)/);

    // ② 로그인한다 — 그리고 **한 줄짜리 명령**을 준다.
    expect(login.status).toBe('needs_login');
    expect(login.message).toContain('logged in');
    expect(login.message).toContain('claude');
    expect(login.message).not.toMatch(/PAT(?!H)/);

    // ③ 재발급한다 — 여기서만 PAT 이야기를 한다.
    expect(rejected.status).toBe('needs_reissue');
    expect(rejected.message).toContain('PAT');

    // ④ **아무것도 단정하지 않는다.** 이 갈래가 `#473` 이 만든 것이고, 앞 셋 중
    //    하나로 접으면 사람이 다시 틀린 일을 한다.
    expect(unknown.status).toBe('stopped');
    expect(unknown.message).toContain('could not be told apart');
    expect(unknown.message).not.toContain('PATH');
    expect(unknown.message).not.toMatch(/PAT(?!H)/);
    // 종료 코드는 **숫자 그대로** 남는다 — 러너 로그에서 보는 그 숫자여야 한다.
    expect(unknown.message).toContain('78');
  });

  it('같은 갈래가 한국어로도 같은 사실을 말한다', async () => {
    const notFound = await 죽인다(agent(), [EXECUTABLE_NOT_FOUND_LINE], koT);
    const login = await 죽인다(agent(), [HARNESS_LOGIN_REQUIRED_LINE], koT);

    expect(notFound.status).toBe('needs_harness');
    expect(notFound.message).toContain('claude');
    expect(notFound.message).toContain('PATH');
    expect(login.status).toBe('needs_login');
    expect(login.message).toContain('로그인');
    // 상태가 같은데 문구가 같으면 옮긴 것이 아니다 — 두 언어가 실제로 갈리는지 본다.
    expect(notFound.message).not.toBe(
      (await 죽인다(agent(), [EXECUTABLE_NOT_FOUND_LINE], enT)).message,
    );
  });

  /**
   * **하네스 이름을 모를 때도 지어내지 않는다**(`#368`). 실행 파일 이름이 없으면
   * `이 에이전트의 하네스(...)` 가 주어가 되고, 하네스 이름조차 없으면 `알 수 없음` 이
   * 그 자리에 들어간다 — 괄호가 비면 사람이 버그로 읽는다.
   */
  it('모르는 하네스에서도 두 언어가 빈 괄호를 만들지 않는다', async () => {
    const e = await 죽인다(agent({ harness: undefined }), [EXECUTABLE_NOT_FOUND_LINE], enT);
    const k = await 죽인다(agent({ harness: undefined }), [EXECUTABLE_NOT_FOUND_LINE], koT);

    expect(e.message).toContain('unknown');
    expect(e.message).not.toContain('()');
    expect(k.message).toContain('알 수 없음');
    expect(k.message).not.toContain('()');
    // `harness` 는 **안 옮긴다** — 이 제품의 고유어다.
    expect(e.message).toContain('harness');
    expect(k.message).toContain('하네스');
  });

  /**
   * 장부에 없는데 서버에는 붙어 있다. **실패가 아니라는 것**이 이 문장의 요점이라
   * 두 언어 모두 그 사실(러너는 떴다)을 말해야 한다.
   */
  it('장부 밖 러너 문구가 두 언어 모두 「내 러너는 띄웠다」까지 말한다', () => {
    expect(STRANGER_ATTACHED(enT)).toContain('ledger');
    expect(STRANGER_ATTACHED(enT)).toContain('a new one was started');
    expect(STRANGER_ATTACHED(koT)).toContain('장부');
    expect(STRANGER_ATTACHED(koT)).toContain('새로 띄웠다');
    // `daemon` 은 고유어라 두 언어에서 같은 글자다.
    expect(STRANGER_ATTACHED(enT)).toContain('daemon');
    expect(STRANGER_ATTACHED(koT)).toContain('daemon');
  });

  /**
   * **물러나는 중은 침묵하지 않는다**(2026-09-08 사고). 그 침묵이 사고의 시작이었으므로
   * 두 언어 모두 *지금 무엇이 일어나는지*와 *다음에 무엇이 일어나는지*를 다 말한다.
   */
  it('물러나는 중 문구가 두 언어 모두 「끝나면 새로 띄운다」까지 말한다', () => {
    expect(en['runner.restart.waitingForRetirement']).toContain('finishing its turn');
    expect(en['runner.restart.waitingForRetirement']).toContain('a new one starts');
    expect(ko['runner.restart.waitingForRetirement']).toContain('물러나는 중');
    expect(ko['runner.restart.waitingForRetirement']).toContain('끝나면 새로 띄운다');
  });

  /**
   * **미룬 폐기는 대가를 말한다.** 지금 끊으면 그 턴이 답을 잃는다는 사실을 빼면
   * 사람은 공짜인 줄 알고 끊는다.
   */
  it('폐기 미룸 문구가 두 언어 모두 「그 턴은 답을 잃는다」까지 말한다', () => {
    expect(en['runner.reissue.revokeDeferred']).toContain('will not leave an answer');
    expect(ko['runner.reissue.revokeDeferred']).toContain('답을 남기지 못한다');
  });

  /**
   * **안 한 일과 그 이유가 함께 온다.** 키체인을 못 읽었을 때 발급으로 넘어가지 않는
   * 것이 요점이고, 그 이유(돌고 있는 러너를 죽일 수 있다)를 빼면 사람은 앱이 게으르다고
   * 읽는다.
   */
  it('키체인 실패 문구가 두 언어 모두 「왜 발급하지 않았나」를 말한다', () => {
    expect(en['runner.launch.keychainUnreadable']).toContain('kill a running runner');
    expect(ko['runner.launch.keychainUnreadable']).toContain('돌고 있는 러너를 죽일 수 있어');
  });
});

/**
 * **배선 축 — 컨트롤러가 언어를 굳히지 않는다.**
 *
 * 위 축들은 판정 함수에 언어를 **직접 넘겨** 문구를 재므로, 그 판정을 실제로 부르는
 * 자리(`Controller`)가 언어를 어떻게 고르는지는 못 본다. 그 자리는 화면이 아니라
 * 컨트롤러라 `useT` 를 못 쓰고, 그래서 **한 번 만든 번역기를 들고 있기 쉽다** —
 * 그러면 사람이 설정에서 언어를 바꿔도 러너 사유만 옛 언어로 남는다.
 *
 * **RED 로 확인했다**(2026-09-08): 컨트롤러가 넘기는 번역기를 `translator('en')` 로
 * 굳히면 이 축이 빨개진다. 그 프로브를 넣기 전에는 **전체 회귀선이 초록이었다** —
 * 이 축이 없으면 그 굳음을 아무도 못 잡는다는 뜻이라, 그래서 이 축을 더했다.
 */
describe('러너 사유 — 컨트롤러가 지금 언어로 말한다', () => {
  /** 자식을 못 띄우는 spawner. 사유가 러너 상태로 오르는 가장 짧은 경로다. */
  const brokenSpawner = (): RunnerSpawner => ({
    spawn: async () => { throw new Error('boom'); },
  });

  const runnerAgent = {
    id: 'a-forge', handle: 'forge', displayName: 'forge', kind: 'agent' as const,
    isAdmin: false, instructions: '', harness: 'claude-code' as const, model: null, effort: null,
    workingDir: null, mentionPermission: 'auto' as const, ownerAccountId: 'u1',
    disabled: false, runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
    claudeLane: null,
    lastTurnAt: null, status: 'available' as const, statusText: null,
    avatarAttachmentId: null,
  };

  /** 러너를 띄우려다 실패시키고, 그 사유 한 줄을 돌려준다. */
  async function 사유(locale: 'en' | 'ko'): Promise<string> {
    // 앞 호출이 남긴 러너 상태를 지운다 — 안 지우면 두 번째 호출이 첫 번째의 사유를
    // 그대로 읽어, 언어가 안 바뀌어도 초록이 된다(거짓 초록).
    useActiveStore.getState().reset();
    usePrefsStore.getState().setLocale(locale);
    const api = fakeApi({ listAgents: vi.fn(async () => [runnerAgent]) });
    const ws = fakeWsFactory();
    const c = new Controller(
      api,
      ws.makeWs,
      undefined,
      undefined,
      {
        read: async () => ({ ok: true as const, value: { label: 'desktop:x', token: 'murp_x' } }),
        write: async () => {},
        clear: async () => {},
        deviceId: async () => 'ab12cd34',
      },
      brokenSpawner(),
      { read: async () => '/login/bin' },
      undefined,
      fakeDaemon(),
    );
    await c.start();
    // **자동 기동은 `presence.snapshot` 에서 시작한다** — presence 가 도착한 그 순간이
    // "누가 이미 붙어 있는가"를 처음 아는 시점이기 때문이다(그 자리 주석). 그래서 이
    // 축도 그 이벤트를 실제로 흘려보내야 러너 상태가 생긴다.
    ws.callbacks.current!.onOpen();
    ws.callbacks.current!.onEvent({ type: 'presence.snapshot', online: [] });
    await vi.waitFor(() => {
      const states = useActiveStore.getState().runnerStates;
      expect(Object.values(states).some((s) => s.message)).toBe(true);
    });
    const states = useActiveStore.getState().runnerStates;
    return Object.values(states).map((s) => s.message).find(Boolean)!;
  }

  afterEach(() => { usePrefsStore.getState().setLocale('system'); });

  it('언어를 바꾸면 러너 실패 사유도 그 언어로 나온다', async () => {
    // 영어가 원본이다 — 그리고 사유는 **결과 상태**로 말한다(`The X was not Yed`).
    expect(await 사유('en')).toContain('did not start');
    // 한국어로 바꾸면 같은 사유가 한국어로 온다. 이 둘이 같은 글자면 컨트롤러가
    // 언어를 한 번만 읽고 굳힌 것이다.
    expect(await 사유('ko')).toContain('기동 실패');
  });
});

// ---------------------------------------------------------------------------
// 6. 화면 넷이 두 언어로 뜬다 — `Profile` · `AgentGrid` · `Composer` · `Inbox`
//
// **화면을 열어서 잰다.** 위 1번 묶음이 이미 사전을 재고 있으므로 여기서 사전을 또 읽는
// 것은 아무것도 더 지키지 않는다 — 사전이 갈려 있어도 **화면이 `t()` 를 안 지나면** 그
// 화면은 한 언어로 굳는다(사이드바 묶음의 머리말이 적은 그 이유 그대로다).
//
// 다른 회귀선 아홉(`profile`·`inbox`·`composer`·`scheduledSend`·… )은 **한국어로 고정**
// 돼 있다 — 그것들이 재는 것은 언어가 아니라 그 언어로 표현된 규율이고, 언어를 재는
// 자리는 이 파일 하나다.
// ---------------------------------------------------------------------------

const AGENT = 'a-mine';

/** 이 넷은 컨트롤러를 만진다 — 문자열만 재므로 부르는 것만 있으면 된다. */
function stubController() {
  setController({
    // `Composer` 는 채널이 있으면 예약 목록을 곧바로 조회한다 — 없으면 그 화면이 뜨다 만다.
    api: { inbox: async () => [], scheduledMessages: async () => [] },
    listAgents: async () => [],
    openMessage: async () => undefined,
    openChannel: async () => undefined,
    refreshAccounts: async () => undefined,
    notifyTyping: () => undefined,
  } as unknown as Controller);
}

function seedProfile() {
  const me = { ...acc(ME, 'me'), isAdmin: true };
  useActiveStore.getState().set({
    me,
    accounts: { [ME]: me, [AGENT]: acc(AGENT, 'mine', 'agent', false, { ownerAccountId: ME }) },
    online: [AGENT],
    connected: true,
    appVersion: '0.1.15',
  });
}

/** 격자 카드 하나. 정보 세 줄이 서려면 `place` 가 기본값(`settings`)이어야 한다. */
const gridAgent = (): AgentView => ({
  ...acc(AGENT, 'mine', 'agent'),
  harness: 'claude-code',
  model: null,
  runnerVersion: null,
  claudeLane: null,
  lastTurnAt: null,
  instructions: '',
  workingDir: null,
  mentionPermission: 'auto',
  stopRequestedAt: null,
  stopAckedAt: null,
} as unknown as AgentView);

describe('프로필 — 두 언어로 뜬다', () => {
  beforeEach(() => { stubController(); seedProfile(); });

  it('행 이름과 값이 영어로 뜬다', async () => {
    render(<Profile accountId={AGENT} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'mine profile' });
    expect(dialog.textContent).toContain('Kind');
    expect(dialog.textContent).toContain('Agent');
    // **생존은 `Presence` 다** — `Connection` 은 소켓 상태로 읽힌다(`en.ts` 의 profile 표).
    expect(dialog.textContent).toContain('Presence');
    expect(dialog.textContent).toContain('Online');
    // 겹창 전체에 한국어가 한 글자도 없다 — 빼 두는 자리가 없다.
    expect(dialog.textContent).not.toMatch(/[가-힣]/);
  });

  it('행 이름과 값이 한국어로 바뀐다', async () => {
    speak('ko');
    render(<Profile accountId={AGENT} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'mine 프로필' });
    expect(dialog.textContent).toContain('종류');
    expect(dialog.textContent).toContain('에이전트');
    expect(dialog.textContent).toContain('생존');
    expect(dialog.textContent).toContain('온라인');
  });

  /** `admin` 은 **두 언어에서 같은 글자다** — 이 제품의 고유어다(`en.ts` 머리말). */
  it('권한 값 admin 은 언어를 안 탄다', async () => {
    const me = { ...acc(ME, 'me'), isAdmin: true };
    useActiveStore.getState().set({ me, accounts: { [ME]: me } });
    render(<Profile accountId={ME} onClose={() => {}} />);
    expect((await screen.findByRole('dialog')).textContent).toContain('admin');
    cleanup();
    speak('ko');
    render(<Profile accountId={ME} onClose={() => {}} />);
    expect((await screen.findByRole('dialog')).textContent).toContain('admin');
  });
});

describe('에이전트 격자 — 두 언어로 뜬다', () => {
  const grid = () => (
    <AgentGrid
      agents={[gridAgent()]}
      selectedId={null}
      runnerStates={{}}
      online={[]}
      connected
      onPick={() => {}}
      onCreate={() => {}}
      canCreate
    />
  );

  it('검색줄과 카드 정보가 영어로 뜬다', () => {
    render(grid());
    expect(screen.getByLabelText('Search agents')).toBeTruthy();
    expect(screen.getByTestId('agent-grid').textContent).toContain('Harness');
    // 모델이 `null` 이면 **'모른다'가 아니라 '하네스가 고른다'** 다.
    expect(screen.getByTestId('agent-grid').textContent).toContain('harness default');
    // 버전을 모르는 러너는 **모른다고 적는다** — 칩을 안 그리면 "러너가 없다"와 같아진다.
    expect(screen.getByTestId('agent-version-mine').textContent).toBe('Version unknown');
  });

  it('검색줄과 카드 정보가 한국어로 바뀐다', () => {
    speak('ko');
    render(grid());
    expect(screen.getByLabelText('에이전트 검색')).toBeTruthy();
    expect(screen.getByTestId('agent-grid').textContent).toContain('하네스');
    expect(screen.getByTestId('agent-version-mine').textContent).toBe('버전 모름');
  });

  /**
   * **못 찾은 것과 아무것도 없는 것은 다른 사실이다**(design.md §4). 그 구별이 언어를
   * 건너 살아남는지 — 뼈대가 뜻을 옮겼지 낱말만 옮긴 것이 아님을 재는 축이다.
   */
  it('빈 목록과 못 찾은 것이 두 언어 모두 다른 문장이다', () => {
    const empty = (
      <AgentGrid
        agents={[]}
        selectedId={null}
        runnerStates={{}}
        online={[]}
        connected
        onPick={() => {}}
        onCreate={() => {}}
        canCreate
      />
    );
    render(empty);
    expect(screen.getByText('No agents yet')).toBeTruthy();
    cleanup();

    render(grid());
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No agent matches/)).toBeTruthy();
    cleanup();

    speak('ko');
    render(empty);
    expect(screen.getByText('아직 에이전트가 없다')).toBeTruthy();
    cleanup();
    render(grid());
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'zzz' } });
    expect(screen.getByText(/맞는 에이전트가 없다/)).toBeTruthy();
  });
});

describe('작성창 — 두 언어로 뜬다', () => {
  beforeEach(() => {
    stubController();
    useActiveStore.getState().set({
      me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me') }, connected: true,
    });
  });

  const composer = () => <Composer onSend={async () => {}} channelId="c1" scopeKey="c1" />;

  it('버튼 이름이 영어로 뜬다', () => {
    render(composer());
    expect(screen.getByText('Send')).toBeTruthy();
    expect(screen.getByLabelText('Send later')).toBeTruthy();
  });

  it('버튼 이름이 한국어로 바뀐다', () => {
    speak('ko');
    render(composer());
    expect(screen.getByText('전송')).toBeTruthy();
    expect(screen.getByLabelText('나중에 보내기')).toBeTruthy();
  });

  /**
   * **예약 겹창이 두 언어로 뜬다.** 이 겹창의 말이 화면 밖(모달) 이라 자칫 빠지는데,
   * 빠지면 그 자리만 한 언어로 굳는다.
   */
  it('예약 겹창이 두 언어로 뜬다', () => {
    render(composer());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send later'));
    expect(screen.getByText('Schedule this message')).toBeTruthy();
    expect(screen.getByLabelText('Send at')).toBeTruthy();

    cleanup();
    speak('ko');
    render(composer());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('나중에 보내기'));
    expect(screen.getByText('예약 발송')).toBeTruthy();
    expect(screen.getByLabelText('예약 시각')).toBeTruthy();
  });
});

describe('인박스 — 두 언어로 뜬다', () => {
  beforeEach(() => {
    stubController();
    useActiveStore.getState().set({
      me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me') },
      channels: [chan('c1', 'general')], messages: { c1: [] }, connected: true,
    });
  });

  it('필터 칩과 구획이 영어로 뜬다', async () => {
    render(<Inbox open onClose={() => {}} />);
    expect(screen.getByTestId('inbox-filter-blocking').textContent).toContain('Blocking you');
    expect(screen.getByTestId('inbox-filter-all').textContent).toContain('Everything');
    await waitFor(() => expect(screen.getByTestId('inbox-empty').textContent)
      .toBe('Nothing has called you'));
    // 자리의 이름이자 머리글이다 — 랜드마크로 찾을 수 있어야 한다.
    expect(screen.getByRole('complementary', { name: 'Inbox' })).toBeTruthy();
  });

  it('필터 칩과 구획이 한국어로 바뀐다', async () => {
    speak('ko');
    render(<Inbox open onClose={() => {}} />);
    expect(screen.getByTestId('inbox-filter-blocking').textContent).toContain('나를 막는 것');
    expect(screen.getByTestId('inbox-filter-all').textContent).toContain('전부');
    await waitFor(() => expect(screen.getByTestId('inbox-empty').textContent)
      .toBe('나를 부른 것이 없다'));
    expect(screen.getByRole('complementary', { name: '인박스' })).toBeTruthy();
  });

  /**
   * **사슬 구획의 이름은 `waitChain.*` 것이다** — 인박스가 그 이름을 제 손으로 다시
   * 적으면 스레드 패널과 갈린다(그 영역이 화면 이름이 아니라 판정 이름인 이유).
   * 두 언어 모두 그 사전의 말이 나오는지 잰다.
   */
  it('사슬 구획 이름이 사슬 사전에서 온다 — 인박스가 다시 적지 않는다', () => {
    render(<Inbox open onClose={() => {}} />);
    expect(screen.getByRole('region', { name: en['waitChain.sectionTitle'] as string })).toBeTruthy();
    cleanup();
    speak('ko');
    render(<Inbox open onClose={() => {}} />);
    expect(screen.getByRole('region', { name: ko['waitChain.sectionTitle'] as string })).toBeTruthy();
  });

  /**
   * **랜드마크 이름에 개수가 없다.** 구획 이름은 자리의 이름이고, 개수가 섞이면 목록이
   * 바뀔 때마다 이름이 달라져 자리를 이름으로 찾는 사람에게 매번 다른 구획이 된다.
   * 보이는 머리글은 개수를 단다 — 그 둘이 갈려 있는 것이 이 축이 지키는 것이다.
   */
  it('구획 이름에는 개수가 없고 머리글에는 있다', async () => {
    render(<Inbox open onClose={() => {}} />);
    const region = await screen.findByRole('region', { name: 'Called you' });
    expect(region.querySelector('h3')?.textContent).toContain('(0)');
  });
});

// ---------------------------------------------------------------------------
// 8. 설정 화면 넷 — **모듈 상수가 언어를 굳히지 않는다**
//
// 이 묶음이 가장 신경 쓰는 것은 `SkillsSettings` 에 실제로 있던 모양이다: 세 칸의
// 이름이 **모듈 상수**여서, 모듈이 처음 읽힐 때의 언어로 굳고 그 뒤 언어를 바꿔도
// 그 세 칸만 옛 언어로 남았다. 화면이 `t()` 를 지나도 그런 자리는 안 바뀐다는 것이
// 이 파일 머리말의 경고이고, 여기가 그 실례다.
//
// **그래서 사전을 읽지 않고 화면을 렌더해 언어를 바꿔 본다.** 사전 대조만으로는
// 굳은 상수를 절대 못 잡는다 — 사전은 갈려 있고 화면만 안 따라오기 때문이다.
// ---------------------------------------------------------------------------

describe('설정 화면 넷 — 언어를 바꾸면 따라온다', () => {
  const asAdmin = () => {
    useActiveStore.getState().set({
      me: { ...acc(ME, 'me'), isAdmin: true },
      accounts: { [ME]: { ...acc(ME, 'me'), isAdmin: true } },
    });
    setController({
      listSkills: vi.fn(async () => []),
      agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
        { harness: 'claude-code', model: null, effort: null }
      )),
    } as unknown as Controller);
  };

  /**
   * **모듈 상수였던 자리.** 세 칸의 이름이 언어를 따라오는지 본다 — 굳어 있으면
   * 영어로 열어도 `대기 중` 이 남는다.
   */
  it('스킬 세 칸의 이름이 언어를 따라온다 — 모듈 상수로 굳지 않는다', async () => {
    asAdmin();
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText(/^Pending \(/)).toBeTruthy());
    expect(screen.getByText(/^Approved \(/)).toBeTruthy();
    expect(screen.getByText(/^Disabled \(/)).toBeTruthy();
    // 굳은 상수가 남아 있으면 이 줄이 잡는다.
    expect(screen.queryByText(/^대기 중 \(/)).toBeNull();

    cleanup();
    speak('ko');
    asAdmin();
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText(/^대기 중 \(/)).toBeTruthy());
    expect(screen.queryByText(/^Pending \(/)).toBeNull();
  });

  /**
   * 확인 문구 셋도 `export` 상수였다. **회귀선 열한 곳이 그것을 import 해서 쓰므로**
   * 지우지 못하고 번역기를 인자로 받는 함수로 바꿨다(`lastTurnLabel` 의 선례).
   *
   * 그 셋이 **각각 다른 일**을 말하는 것도 함께 잰다(#325): 거부에는 파일 이야기가
   * 없고 비활성화에는 있다 — 없는 일을 경고하면 확인 문구를 아무도 안 읽는다.
   */
  it('확인 문구 셋이 두 언어 모두 각각 다른 일을 말한다', () => {
    expect(en['skills.confirm.reject']).not.toContain('file');
    expect(en['skills.confirm.disable']).toContain('file');
    expect(ko['skills.confirm.reject']).not.toContain('파일');
    expect(ko['skills.confirm.disable']).toContain('파일');
  });

  it('에이전트 기본값 화면이 언어를 따라온다', async () => {
    asAdmin();
    render(<AgentDefaultsSettings />);
    await waitFor(() => expect(screen.getAllByLabelText('Default harness').length).toBeGreaterThan(0));
    expect(screen.getAllByLabelText('Default model').length).toBeGreaterThan(0);

    cleanup();
    speak('ko');
    asAdmin();
    render(<AgentDefaultsSettings />);
    await waitFor(() => expect(screen.getAllByLabelText('기본 harness').length).toBeGreaterThan(0));
  });

  /**
   * **`harness`·`model`·`effort` 는 두 언어 모두 그대로 선다.** API 필드 이름이자
   * 설정 파일에 적히는 값이라, 화면이 다른 이름을 쓰면 사람이 둘을 못 잇는다
   * (`sidebar.notify` 가 `all`/`mentions`/`none` 을 안 옮긴 것과 같은 규칙).
   */
  it('기본값 화면의 필드 이름은 두 언어 모두 안 옮긴다', () => {
    for (const [key, word] of [
      ['defaults.field.harness', 'harness'],
      ['defaults.field.model', 'model'],
      ['defaults.field.effort', 'effort'],
    ] as [keyof typeof en, string][]) {
      expect(en[key], `en.${key}`).toContain(word);
      expect(ko[key], `ko.${key}`).toContain(word);
    }
  });

  /**
   * **어투를 `~다` 로 맞췄다.** 이 화면만 `~하세요`·`~습니다` 였고, 한 화면만
   * 높임말이면 같은 앱이 사람을 두 가지로 대한다. 뜻은 그대로 두고 어투만 바꿨다.
   */
  it('이름 바꾸기 문구가 사전의 다른 한국어와 같은 어투다', () => {
    for (const key of [
      'profileName.empty', 'profileName.length', 'profileName.invalidChars',
      'profileName.taken', 'profileName.unusable', 'profileName.failed',
    ] as (keyof typeof en)[]) {
      const v = ko[key] as string;
      expect(v, `ko.${key}`).not.toMatch(/(습니다|하세요)\.?$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. 러너·투영 — 모듈 상수로 굳지 않는다
//
// **이 묶음이 지키는 것은 사전의 내용이 아니라 그 값이 화면에 닿는 경로다.** 이 이전이
// 없앤 결함이 정확히 그것이었다: `runnerStatusLabel`·`PRESENCE_LABEL`·`STATE_LABEL`·
// `SOURCE_LABEL` 넷이 **모듈 로드 시점 언어로 굳은 문구**를 들고 있어, 화면이 `t()` 를
// 지나도 그 자리만 안 바뀌었다. 사이드바가 그것을 이미 감싸고 있었으므로(`sidebar.runner
// .state`) **틀만 영어가 되고 안의 라벨은 한국어로 남는** 반쪽 상태가 실제로 있었다.
//
// 그래서 축들이 **사전을 읽지 않는다** — 화면을 두 언어로 렌더하거나 판정 함수를 두
// 언어로 부른다. 사전만 읽으면 키가 있다는 것만 증명되고, 그 키가 화면에 닿는지는
// 증명되지 않는다(그것이 이 이전이 고친 바로 그 간극이다).
// ---------------------------------------------------------------------------

describe('러너 상태 이름 — 판정이 두 언어로 말한다', () => {
  const state = (over: Partial<RunnerState> = {}): RunnerState => ({
    agentId: 'a', status: 'running', exitCode: null, message: null, ...over,
  } as RunnerState);

  /**
   * **모듈 상수였다면 이 축이 못 잡는다.** 굳은 표는 두 언어로 불러도 같은 값을 내므로
   * `en !== ko` 가 거짓이 되어 여기서 빨개진다 — 그것이 이 이전의 RED 다.
   */
  it('여덟 상태가 두 언어에서 모두 다른 말이 된다 — 언어를 따라온다', () => {
    const ko = translator('ko');
    const en = translator('en');
    const statuses: RunnerStatus[] = [
      'running', 'adopted', 'restarting', 'needs_reissue',
      'needs_harness', 'needs_login', 'stopped', 'failed',
    ];
    for (const status of statuses) {
      const k = runnerStatusLabel(state({ status }), ko);
      const e = runnerStatusLabel(state({ status }), en);
      expect(k, status).not.toBe(e);
      // 그리고 **비어 있지 않다** — 없는 키를 부르면 뼈대가 키를 그대로 낸다.
      expect(e, status).not.toContain('runnerState.');
    }
  });

  /**
   * **`#473` 이 만든 갈림이 영어에도 남는다.** 78 을 셋이 나눠 쓰는데 사람이 할 일은
   * 재발급·설치·재로그인으로 전부 다르다 — 셋을 한 문구로 접으면 두 번은 틀린 일을 한다.
   */
  it('78 의 세 갈래가 두 언어 모두 서로 다른 일을 시킨다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = translator(locale);
      const three = (['needs_reissue', 'needs_harness', 'needs_login'] as RunnerStatus[])
        .map((status) => runnerStatusLabel(state({ status }), t));
      expect(new Set(three).size, locale).toBe(3);
      // 셋 다 **78 을 그대로 적는다** — 종료 코드는 숫자이고 러너 로그에서 보는 그 값이다.
      for (const line of three) expect(line, locale).toContain('78');
    }
    // 사람이 할 일이 각 문장 안에 있다(`#473`: 그것을 뺀 것이 그 이슈가 고친 결함이다).
    const en = translator('en');
    expect(runnerStatusLabel(state({ status: 'needs_harness' }), en)).toContain('install');
    expect(runnerStatusLabel(state({ status: 'needs_login' }), en)).toContain('log in');
    expect(runnerStatusLabel(state({ status: 'needs_reissue' }), en)).toContain('reissue');
  });

  /**
   * **'꺼짐'과 '코드 N 으로 죽었다'를 뭉치지 않는다**(그 모듈 주석). 앞은 정상이고 뒤는
   * 사람이 러너 로그를 볼 일이다 — 그리고 **코드를 지어내지 않고 그대로 보인다**.
   */
  it('정상 종료와 코드 있는 종료가 두 언어 모두 갈리고, 코드가 글자에 남는다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = translator(locale);
      const off = runnerStatusLabel(state({ status: 'stopped', exitCode: 0 }), t);
      const coded = runnerStatusLabel(state({ status: 'stopped', exitCode: 137 }), t);
      expect(off, locale).not.toBe(coded);
      expect(coded, locale).toContain('137');
      // `null`(신호로 죽었다)도 정상 쪽이다 — 코드가 없으면 지어내지 않는다.
      expect(runnerStatusLabel(state({ status: 'stopped', exitCode: null }), t), locale).toBe(off);
    }
  });

  /**
   * **사이드바가 이 값을 감싸서 쓴다**(`sidebar.runner.state`). 이 이전 전에는 틀만
   * 언어를 따르고 안의 라벨은 한국어로 굳어 **한 줄에 두 언어가 섞였다** — 이 축이
   * 그 자리를 화면에서 직접 잰다.
   */
  it('사이드바 DM 줄이 틀과 라벨을 같은 언어로 낸다', async () => {
    const label = (locale: Locale): string => {
      speak(locale);
      const t = translator(locale);
      return t('sidebar.runner.state', {
        label: runnerStatusLabel(state({ status: 'adopted' }), t),
      });
    };
    const koLine = label('ko');
    const enLine = label('en');
    expect(koLine).not.toBe(enLine);
    // 섞이지 않는다: 영어 줄에 한국어 글자가 없고, 그 반대도 없다.
    expect(enLine).not.toMatch(/[가-힣]/);
    expect(koLine).toMatch(/[가-힣]/);
  });
});

describe('생존 표시 — 표가 값이 아니라 키를 든다', () => {
  /**
   * **셋이 서로 다른 말을 한다**(`#443`). 그리고 그 셋이 **언어를 따라온다** — 표가
   * 문구를 들고 있었다면 두 언어가 같은 값을 내 여기서 빨개진다.
   */
  it('세 값이 두 언어 모두 서로 다르고, 언어를 따라온다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = translator(locale);
      expect(new Set(Object.values(PRESENCE_LABEL).map((k) => t(k))).size, locale).toBe(3);
    }
    const ko = translator('ko');
    const en = translator('en');
    for (const key of Object.values(PRESENCE_LABEL)) expect(ko(key)).not.toBe(en(key));
  });

  /**
   * **`unknown` 이 '오프라인'이라고 말하지 않는다** — 그것은 아는 척이고(그 모듈 주석),
   * 사람이 할 일이 갈린다: 오프라인이면 러너를 되살리고, 모르면 연결을 기다린다.
   * 그래서 **한 낱말로 끝내지 않는다**는 규율이 두 언어에 다 있어야 한다.
   */
  it("'모른다'가 두 언어 모두 문장에 남는다 — 한 낱말로 끝내지 않는다", () => {
    expect(translator('ko')(PRESENCE_LABEL.unknown)).toContain('알 수 없음');
    const en = translator('en')(PRESENCE_LABEL.unknown);
    expect(en).toContain('unknown');
    // `Disconnected` 만 두면 사람이 그것을 '오프라인'으로 읽는다 — 뒤가 붙어 있다.
    expect(en).not.toBe('Disconnected');
    expect(en.split(/\s+/).length).toBeGreaterThan(1);
  });
});

describe('투영 — 네 사정이 두 언어 모두 뭉개지지 않는다', () => {
  // `t` 를 여기서 채운다 — 각 축이 언어만 고르면 되도록. 그것이 이 묶음이 재는 축이다.
  const banner = (
    locale: Locale,
    input: Omit<Parameters<typeof projectionBanner>[0], 't'>,
  ) => projectionBanner({ ...input, t: translator(locale) });

  const stalled = (lastPolledAt: number | null): ProjectionStatus => ({
    state: 'stalled', configured: true, lastPolledAt, lastError: null,
  } as ProjectionStatus);

  /**
   * **이 이전이 가장 조심한 자리다.** 빈 목록 하나가 넷을 뭉갤 수 있고(꺼짐·멈춤·못
   * 읽음·정말 없음), 그러면 도그푸딩 중에 투영이 끊긴 것을 **아무도 모른다** — 화면이
   * 평소와 똑같기 때문이다. `#267` 이 그것을 회귀선으로 못 박았고, 이 축은 그 구별이
   * **언어를 건너** 살아남는지를 잰다.
   */
  it('띠 문장 셋이 두 언어 모두 서로 다르다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const texts = [
        banner(locale, { status: null, error: 'boom', ago: () => 'x' })!.text,
        banner(locale, { status: null, error: null, ago: () => 'x' })!.text,
        banner(locale, { status: stalled(Date.now()), error: null, ago: () => 'x' })!.text,
      ];
      expect(new Set(texts).size, locale).toBe(3);
    }
  });

  /**
   * **같은 사정이라도 띠와 목록은 다른 말을 한다**(#489 의 결함, 실측 2026-09-07).
   * 띠는 "고장났다"를, 목록 줄은 "그래서 이 목록을 어떻게 읽어야 하나"를 말한다 —
   * 같은 문구를 두 자리에 세우면 사용자 눈에는 그냥 중복이다.
   */
  it('띠와 목록 줄이 두 언어 모두 다른 문장이다', () => {
    for (const locale of ['ko', 'en'] as const) {
      for (const input of [
        { status: null, error: 'boom', ago: () => 'x' },
        { status: stalled(Date.now()), error: null, ago: () => 'x' },
      ]) {
        const b = banner(locale, input)!;
        expect(b.text, locale).not.toBe(b.listNote);
      }
    }
  });

  /**
   * **한 번도 못 폴링했으면 시간을 지어내지 않는다.** `projectionBanner.test.tsx` 가
   * 한국어로 재는 그 축을 여기서 **영어로도** 잰다 — 옮기면서 그 규율이 한 언어에만
   * 남았는지를 보는 자리다(뼈대가 뜻을 옮겼지 낱말만 옮긴 것이 아님).
   */
  it('폴링 기록이 없으면 두 언어 모두 숫자를 지어내지 않는다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const b = banner(locale, { status: stalled(null), error: null, ago: () => '10분 전' })!;
      expect(b.text, locale).not.toContain('10분 전');
      expect(b.text, locale).not.toMatch(/\d/);
      expect(b.listNote, locale).not.toMatch(/\d/);
    }
    // 그리고 **아는 경우에는 그 값을 그대로 싣는다** — 대조군이다. 없으면 위 축이
    // "경과를 아예 안 적는다"로도 초록이 된다.
    const known = banner('en', { status: stalled(Date.now()), error: null, ago: () => '10 minutes ago' })!;
    expect(known.text).toContain('10 minutes ago');
  });

  /**
   * **꺼짐만 사전을 안 지난다** — `packages/shared` 의 상수라 데스크탑 사전이 닿을 수
   * 없다(`runner.exit.notFound` 뒤의 `installHint()` 와 같은 경계). 그 사실을 회귀선에
   * 박아 둔다: 다음 사람이 "왜 이것만 한국어인가"를 결함으로 읽지 않도록, 그리고 그
   * 경계가 풀리는 날 이 축이 그 자리를 가리키도록.
   */
  it('꺼짐 문구는 shared 의 상수 그대로다 — 이 패키지 밖이라 아직 못 옮긴다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const b = banner(locale, {
        status: { state: 'unconfigured', configured: false, lastPolledAt: null, lastError: null } as ProjectionStatus,
        error: null,
        ago: () => 'x',
      })!;
      expect(b.text, locale).toBe(PROJECTION_UNCONFIGURED_HEADLINE);
      // **목록 줄은 이 파일의 말이라 사전을 지난다** — 둘의 출처가 다르다는 것이 요점이다.
      expect(b.listNote, locale).not.toBe(PROJECTION_UNCONFIGURED_HEADLINE);
    }
    // 그 목록 줄은 언어를 따라온다 — 위 `text` 가 안 따라오는 것과 대비된다.
    const koNote = banner('ko', {
      status: { state: 'unconfigured', configured: false, lastPolledAt: null, lastError: null } as ProjectionStatus,
      error: null, ago: () => 'x',
    })!.listNote;
    const enNote = banner('en', {
      status: { state: 'unconfigured', configured: false, lastPolledAt: null, lastError: null } as ProjectionStatus,
      error: null, ago: () => 'x',
    })!.listNote;
    expect(koNote).not.toBe(enNote);
  });

  /**
   * 화면까지 닿는지 잰다. 위 축들은 판정 함수를 직접 부르므로 **그 값이 띠에 실리는지**는
   * 증명하지 않는다 — 이 이전이 고친 결함이 정확히 "판정은 옮겼는데 화면이 안 따라온다"
   * 였으므로 한 축은 화면을 지나야 한다.
   */
  it('띠가 언어를 따라 뜬다', () => {
    useActiveStore.getState().reset();
    useActiveStore.getState().set({ projectionStatusError: 'boom' });
    speak('en');
    render(<ProjectionBanner />);
    expect(screen.getByTestId('strip-projection-unreadable').textContent).toContain('could not be read');
    cleanup();

    speak('ko');
    render(<ProjectionBanner />);
    expect(screen.getByTestId('strip-projection-unreadable').textContent).toContain('읽지 못했다');
  });
});

describe('투영 주소 줄 — 출처 표가 언어를 따라온다', () => {
  const mount = () => {
    useActiveStore.getState().reset();
    useActiveStore.getState().set({ me: acc('me', 'me', 'human', true) });
    setController({
      projectionConfig: async () => ({ url: 'http://a', appUrl: 'http://a', envUrl: null, source: 'app' }),
    } as unknown as Controller);
    render(<ProjectionUrl />);
  };

  /**
   * **출처 둘이 서로 다른 말을 한다**(그 화면 주석: 같은 말이면 "env 를 넣었는데 왜 안
   * 먹나"를 화면에서 알 수 없다). 그리고 표가 **키를 들어야** 언어를 따라온다 — 문구를
   * 들고 있었다면 아래 두 화면이 같은 글자를 낸다.
   */
  it('출처 줄이 두 언어로 뜬다 — 모듈 상수로 굳지 않는다', async () => {
    speak('en');
    mount();
    await waitFor(() => expect(screen.getByTestId('projection-source').textContent).toContain('Set in the app'));
    cleanup();

    speak('ko');
    mount();
    await waitFor(() => expect(screen.getByTestId('projection-source').textContent).toContain('앱에서 설정'));
  });

  /** **`AVCS_BASE_URL` 은 두 언어에서 같은 글자다** — 사람이 셸에 적는 그 이름이다. */
  it('환경변수 이름은 언어를 안 탄다', () => {
    for (const locale of ['ko', 'en'] as const) {
      expect(translator(locale)('projection.url.sourceEnv'), locale).toContain('AVCS_BASE_URL');
    }
  });

  /**
   * **지우기 안내가 둘로 갈린다 — 잃는 것이 다르기 때문이다.** env 값이 있으면 그리로
   * 돌아가고, 없으면 투영이 꺼진다. 한 문장으로 뭉치면 사람이 지우기 전에 무엇을 잃는지
   * 모른다. 그 갈림이 두 언어에 다 있어야 한다.
   */
  it('지우기 안내가 두 언어 모두 두 갈래로 갈린다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = translator(locale);
      const fallback = t('projection.url.hintFallback', { url: 'http://env' });
      const off = t('projection.url.hintOff');
      expect(fallback, locale).not.toBe(off);
      // 돌아갈 곳이 있으면 **그 주소를 적는다** — 어디로 가는지 말하지 않으면 안내가 아니다.
      expect(fallback, locale).toContain('http://env');
    }
  });
});

describe('터미널 패널 — 두 언어로 뜬다', () => {
  /**
   * **못 치는 이유 넷을 뭉개지 않는다**(`#369`). 원인마다 다음 행동이 다르다: 그 창을
   * 닫거나, 이어받거나, 러너를 올리거나, (구 서버면) 아무것도 단정하지 않는다.
   * "읽기 전용이다"만 적으면 넷 다 막다른 길로 보인다.
   */
  it('못 치는 이유 넷이 두 언어 모두 서로 다른 문장이다', () => {
    // **판정 함수를 지난다** — 사전을 직접 읽으면 이 축이 아무것도 안 지킨다.
    // 프로브로 확인했다: 표에서 두 사유가 같은 키를 가리키게 해도 사전에는 문장이
    // 넷 그대로 있어 초록이었다. 지키려는 것은 *"사전에 넷이 있다"* 가 아니라
    // **"네 사유가 서로 다른 말에 닿는다"** 이고, 그 배선이 표에 있다.
    const reasons: (WriterDeniedReason | null)[] = [
      'observe-only', 'other-writer', 'runner-outdated', null,
    ];
    for (const locale of ['ko', 'en'] as const) {
      const t = translator(locale);
      const four = reasons.map((r) => writerDeniedText(r, t));
      expect(new Set(four).size, locale).toBe(4);
    }
    // 그리고 넷 다 **언어를 따라온다** — 하나라도 굳으면 그 사유만 남의 언어로 뜬다.
    for (const r of reasons) {
      expect(writerDeniedText(r, translator('ko'))).not.toBe(writerDeniedText(r, translator('en')));
    }
  });

  /**
   * 관찰 전용 문구가 **원인을 그대로 말한다**(그 함수 주석). "관찰 전용"만 적으면 임의의
   * 제약으로 읽혀 "왜 안 되냐"가 결함으로 다시 올라온다 — 프롬프트를 파일로 받는다는
   * 사실이 이 제약의 전부이고, 그것을 아는 사람은 다른 길을 스스로 찾는다.
   */
  it('관찰 전용이 두 언어 모두 「왜」와 「그럼 어떻게」를 다 말한다', () => {
    expect(ko['terminal.writer.observeOnly']).toContain('파일');
    expect(ko['terminal.writer.observeOnly']).toContain('턴이 끝난 뒤');
    const e = en['terminal.writer.observeOnly'] as string;
    expect(e).toContain('from a file');
    expect(e).toContain('after the turn ends');
  });

  /**
   * **상태 셋이 서로 다르고, `runner-offline` 을 '끝났다'로 쓰지 않는다**(그 상수 주석).
   * 턴은 안 끝났고 소켓만 끊긴 것이라 다른 사실이다.
   */
  it('세션 상태 셋이 두 언어 모두 갈리고, 끊김을 종료라 하지 않는다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = translator(locale);
      const three = ['terminal.state.running', 'terminal.state.ended', 'terminal.state.runnerOffline']
        .map((k) => t(k as keyof typeof en));
      expect(new Set(three).size, locale).toBe(3);
    }
    expect(en['terminal.state.runnerOffline']).not.toBe(en['terminal.state.ended']);
  });

  /**
   * **보이는 글자와 접근 이름이 갈린다.** 옮기면서 한 키로 접었더니 `agentTerminal
   * .test.tsx` 의 `getByLabelText('터미널 닫기')` 가 빨개졌다 — 머리띠의 꼬리표라 보이는
   * 글자는 짧아야 하는데, 그 짧음이 스크린리더에서는 **무엇을** 닫는지를 잃는다.
   */
  it('닫기의 접근 이름이 보이는 글자보다 구체적이다 — 두 언어 모두', () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = translator(locale);
      const short = t('terminal.header.close');
      const action = t('terminal.header.closeAction');
      expect(action, locale).not.toBe(short);
      expect(action.length, locale).toBeGreaterThan(short.length);
    }
  });
});

describe('손으로 띄우는 명령 — 주석만 옮기고 명령은 안 옮긴다', () => {
  /**
   * **명령 자체는 언어를 안 탄다.** 셸에 그대로 들어가는 값이라 번역되면 붙여넣는 순간
   * 실패한다 — `runnerCommand.ts` 머리말이 없애는 그 상태다. 옮기는 것은 그 위의
   * 안내 주석 두 줄뿐이다.
   */
  it('두 언어에서 명령은 같고 주석만 다르다', () => {
    const koText = runnerCommandClipboardText('murp_x', translator('ko'));
    const enText = runnerCommandClipboardText('murp_x', translator('en'));
    expect(koText).not.toBe(enText);
    // 명령 줄들은 글자 하나까지 같다(`#125`: 화면과 클립보드가 같아야 한다).
    const commands = (text: string) => text.split('\n').filter((l) => !l.startsWith('#') && l !== '');
    expect(commands(koText)).toEqual(commands(enText));
    // 그리고 **토큰이 통째로** 실린다 — 자르면 "완성된 명령"처럼 보이는데 인증이 실패한다.
    for (const text of [koText, enText]) {
      expect(text).toContain('murp_x');
      expect(text).not.toContain('…');
    }
  });

  /** 주석 줄은 **`#` 로 시작한다** — 셸 주석이라, 번역이 그 기호를 잃으면 명령이 깨진다. */
  it('두 언어 모두 안내 줄이 셸 주석으로 남는다', () => {
    for (const locale of ['ko', 'en'] as const) {
      const t = translator(locale);
      expect(t('agents.runner.commandBundledNote'), locale).toMatch(/^#/);
      expect(t('agents.runner.commandDevNote'), locale).toMatch(/^#/);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. 채널·검색·팀 — **모듈 상수 셋이 언어를 굳히지 않는다**
//
// 이 묶음이 겨누는 것은 8번과 같은 결함 형태인데, 이 PR 이 그것을 **셋 더** 찾았다:
//
// | 자리 | 무엇이 굳었나 | 어떻게 풀었나 |
// |---|---|---|
// | `SidebarFind::KIND_LABEL` | 종류 꼬리표 셋 | 표는 남기고 **값만 사전 키로**(`NotifiedGapRow` 선례) |
// | `StatusPicker::LABELS` | 상태 이름 셋 | 같은 선례 — 값·라벨을 갈라 값(`available`…)은 안 옮긴다 |
// | `Identity::STATUS_MARKS` | 상태 이름 + 글리프 | 같은 선례. `StatusPicker` 와 **같은 키를 본다** |
// | `BootNotice::KEYCHAIN_WAIT_*` | 부팅 두 줄 | **함수로 내림**(`threadState::THREAD_STATE_LABEL` 선례) — `export` 는 남는다: 회귀선이 그것을 import 한다 |
//
// **그래서 사전을 읽지 않고 화면을 렌더해 언어를 바꿔 본다.** 사전 대조만으로는 굳은
// 상수를 절대 못 잡는다 — 사전은 갈려 있고 화면만 안 따라오기 때문이다(8번 머리말).
// ---------------------------------------------------------------------------

describe('굳은 모듈 상수 셋 — 언어를 바꾸면 화면이 따라온다', () => {
  /**
   * **`SidebarFind::KIND_LABEL` 이 굳어 있던 자리.** 한 글자를 치면 채널·사람·에이전트가
   * 함께 걸리고 각 줄에 종류 꼬리표가 붙는다 — 그 셋이 언어를 따라오는지 본다.
   *
   * 사람·에이전트 둘이 **`sidebar.members.kind*` 를 그대로 쓰는지**도 여기서 잰다:
   * 새 키를 만들었다면 그 값이 멤버 패널의 값과 갈릴 수 있고, 그러면 한 화면이 같은 말을
   * 두 벌 들게 된다(그 영역 머리말이 안 만든 이유로 적은 것).
   */
  it('사이드바 찾기의 종류 꼬리표 셋이 언어를 따라온다 — 모듈 상수로 굳지 않는다', () => {
    const seed = () => {
      useActiveStore.getState().set({
        me: acc(ME, 'me'),
        accounts: {
          [ME]: acc(ME, 'me'),
          h1: acc('h1', 'zeta'),
          a1: acc('a1', 'zebra', 'agent'),
        },
        channels: [chan('c1', 'zebra-deploy')],
      });
    };

    seed();
    render(<SidebarFind onOpenChannelDirectory={() => {}} />);
    fireEvent.change(screen.getByTestId('sidebar-find'), { target: { value: 'ze' } });
    const rows = () => screen.getByTestId('sidebar-find-results').textContent ?? '';
    expect(rows()).toContain('Channel');
    expect(rows()).toContain('Person');
    expect(rows()).toContain('Agent');
    // 굳은 상수가 남아 있으면 이 줄이 잡는다.
    expect(rows()).not.toContain('에이전트');

    cleanup();
    speak('ko');
    seed();
    render(<SidebarFind onOpenChannelDirectory={() => {}} />);
    fireEvent.change(screen.getByTestId('sidebar-find'), { target: { value: 'ze' } });
    expect(rows()).toContain('채널');
    expect(rows()).toContain('사람');
    expect(rows()).toContain('에이전트');
    expect(rows()).not.toContain('Agent');
  });

  /**
   * **`sidebar.members.kind*` 를 빌려 쓴 것이 실제로 같은 값인가.** 위 시험은 화면을
   * 재고 이 줄은 **키를 재서** 두 자리가 갈라지지 않았음을 못 박는다 — 다음 사람이
   * `sidebar.find.kindHuman` 을 새로 만들면 위 시험은 여전히 초록이고 이 줄만 빨개진다.
   */
  it('사람·에이전트 꼬리표는 멤버 패널과 같은 키다 — 한 화면이 같은 말을 두 벌 안 든다', () => {
    for (const catalog of [en, ko]) {
      expect(catalog['sidebar.members.kindHuman']).toBeDefined();
      expect(catalog['sidebar.members.kindAgent']).toBeDefined();
    }
    // 채널만 이 덩어리의 것이다. 나머지 둘을 새로 만들었다면 그 키가 사전에 있을 것이고,
    // `satisfies Catalog` 가 아니라 **여기서** 잡힌다.
    expect(Object.keys(en).filter((k) => k.startsWith('sidebar.find.kind')))
      .toEqual(['sidebar.find.kindChannel']);
  });

  /**
   * **`StatusPicker::LABELS` 와 `Identity::STATUS_MARKS` 가 둘 다 굳어 있던 자리.**
   *
   * 한 시험에서 두 화면을 함께 재는 것이 요점이다 — 두 상수가 **같은 세 상태**를 그리므로
   * 하나만 고치면 고르는 자리와 읽는 자리의 말이 갈린다(`status` 영역이 화면 이름을
   * 안 쓴 이유가 그것이다).
   */
  it('상태 이름 셋이 두 화면에서 함께 언어를 따라온다 — 모듈 상수로 굳지 않는다', () => {
    const seed = (status: 'available' | 'away' | 'dnd') => {
      const me = acc(ME, 'me', 'human', false, { status });
      useActiveStore.getState().set({ me, accounts: { [ME]: me } });
      setController({ setStatus: vi.fn(async () => undefined) } as unknown as Controller);
      return me;
    };

    /**
     * 두 화면을 **함께** 그린다 — 고르는 자리(`StatusPicker`)와 읽는 자리(`StatusMark`)가
     * 각자 모듈 상수를 들고 있었고, 하나만 고치면 둘의 말이 갈린다. 그것이 `status`
     * 영역이 화면 이름을 안 쓴 이유이므로, 회귀선도 한 자리에서 둘을 함께 재야 한다.
     */
    const both = (status: 'available' | 'away' | 'dnd') => {
      const me = seed(status);
      return render(
        <>
          <StatusPicker onDone={() => {}} />
          <StatusMark account={me} />
        </>,
      );
    };

    both('away');
    const picker = () => screen.getByTestId('status-picker').textContent ?? '';
    const mark = () => screen.getByTestId(`status-${ME}`).textContent ?? '';
    expect(picker()).toContain('Available');
    expect(picker()).toContain('Away');
    expect(picker()).toContain('Do not disturb');
    // 읽는 자리도 같은 언어여야 한다 — 한쪽만 고치면 여기가 빨개진다.
    expect(mark()).toContain('Away');
    expect(picker()).not.toContain('자리 비움');

    cleanup();
    speak('ko');
    both('away');
    expect(picker()).toContain('대화 가능');
    expect(picker()).toContain('자리 비움');
    expect(picker()).toContain('방해 금지');
    expect(mark()).toContain('자리 비움');
    expect(picker()).not.toContain('Away');
  });

  /**
   * **값과 라벨을 갈랐다.** `available`·`away`·`dnd` 는 서버로 가고 `data-status` 로도
   * 남는 **저장·전송용 값**이라 두 언어 모두 그대로다 — `sidebar.notify` 가 `all`/
   * `mentions`/`none` 을 안 옮긴 것과 같은 규율이고, 이 줄이 그 경계를 못 박는다.
   */
  it('상태 값은 두 언어 모두 안 옮긴다 — 서버로 가는 값이다', () => {
    const me = acc(ME, 'me', 'human', false, { status: 'dnd' });
    for (const locale of ['en', 'ko'] as const) {
      cleanup();
      speak(locale);
      useActiveStore.getState().set({ me, accounts: { [ME]: me } });
      render(<StatusMark account={me} />);
      expect(screen.getByTestId(`status-${ME}`).getAttribute('data-status'), locale).toBe('dnd');
    }
  });

  /**
   * **`BootNotice` 의 두 줄이 굳어 있던 자리이자, 부팅 시점 언어를 재는 자리다.**
   *
   * 이 화면은 세션도 못 읽은 시점에 뜬다 — `useT` 가 그때 무엇을 내는지가 물음이었다.
   * 실측 결론은 그 파일 주석에 있다(`prefsStorage.load()` 가 `localStorage` 동기 호출이라
   * 왕복이 없다). 그 사실을 **화면으로** 잰다: 언어를 정해 두고 부팅 화면을 띄우면
   * 그 언어로 뜨는가.
   */
  it('부팅 화면이 언어를 따라온다 — 세션 전에도 언어를 안다', () => {
    vi.useFakeTimers();
    try {
      render(<BootNotice wait="keychain" />);
      act(() => { vi.advanceTimersByTime(KEYCHAIN_NOTICE_DELAY_MS + 1); });
      const notice = () => screen.getByTestId('boot-notice').textContent ?? '';
      expect(notice()).toContain('Waiting for the OS keychain');
      // **할 일까지 말한다** — 사유만 남으면 `#460` 이 고친 것이 반쯤 되돌아간다.
      expect(notice()).toContain('system approval dialog');
      expect(notice()).not.toContain('키체인');

      cleanup();
      speak('ko');
      render(<BootNotice wait="keychain" />);
      act(() => { vi.advanceTimersByTime(KEYCHAIN_NOTICE_DELAY_MS + 1); });
      expect(notice()).toContain('OS 키체인의 승인을 기다리는 중');
      expect(notice()).toContain('대화상자');
      expect(notice()).not.toContain('keychain');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. 채널·검색·팀 — **옮기면서 사실을 잃지 않는다**
//
// 9번이 배선을 재고 이 묶음이 **뜻**을 잰다. 각 줄이 겨누는 것은 원래 한국어가 지고
// 있던 사실 하나이고, 영어가 그것을 빠뜨렸으면 빨개진다.
// ---------------------------------------------------------------------------

describe('채널 문서 — 409 가 두 언어 모두 세 사실을 다 말한다', () => {
  /**
   * 이 기능의 요점은 *"남의 것을 덮어쓰지 않으려고 내 것을 조용히 버리지 않는다"* 이고,
   * 그것이 사람에게 도달하려면 **세 사실**이 다 있어야 한다: 무엇이 일어났나 · 어디를
   * 보나 · 다시 누르면 무엇이 되나. 하나라도 빠지면 사람은 자기 글이 사라졌는지부터
   * 모른 채 저장을 다시 누른다.
   */
  it('무엇이 일어났나 · 어디를 보나 · 다시 누르면 무엇이 되나', () => {
    const conflict = en['channel.doc.conflict'] as string;
    expect(conflict).toMatch(/saved first/);
    expect(conflict).toMatch(/below/);
    expect(conflict).toMatch(/over it/);

    const koConflict = ko['channel.doc.conflict'] as string;
    expect(koConflict).toMatch(/먼저 고쳤다/);
    expect(koConflict).toMatch(/아래/);
    expect(koConflict).toMatch(/덮어쓴다/);
  });

  /**
   * **빈 문서와 못 받은 문서가 다른 문장이다**(design.md §4). 그 구별이 언어를 건너
   * 살아남는지 — `channel.doc.noneYet` 은 *"아직 안 썼다"* 이고 `loadFailed` 는
   * *"못 받았다"* 다. 하나로 합치면 사람이 남의 문서 위에 저장한다.
   */
  it('빈 문서와 못 받은 문서가 두 언어 모두 다른 문장이다', () => {
    for (const catalog of [en, ko]) {
      expect(catalog['channel.doc.noneYet']).not.toEqual(catalog['channel.doc.loadFailed']);
    }
    // `yet` 이 진다 — 빠지면 '영영 없다'로 읽힌다.
    expect(en['channel.doc.noneYet']).toMatch(/yet/);
    expect(ko['channel.doc.noneYet']).toMatch(/아직/);
    // 실패는 **화면이 지금 무엇을 모르는지**를 말한다(머리말의 `did not arrive`).
    expect(en['channel.doc.loadFailed']).toMatch(/did not arrive/);
  });
});

describe('빈 채널 안내 — 없는 동작을 권하지 않는다', () => {
  /**
   * **`답한다` 가 아니라 `inbox 로 들어간다`.** 답이 오는지는 러너가 떠 있는가에 달렸고
   * 이 화면은 그것을 모른다(`ChannelEmptyState` 주석 · `#125`). 영어가 `it replies` 로
   * 넘어가면 화면이 모르는 것을 단언하게 되므로 그 낱말을 못 박는다.
   */
  it('멘션 안내가 두 언어 모두 「답한다」고 말하지 않는다', () => {
    expect(en['channel.empty.tipMention']).toMatch(/inbox/);
    expect(en['channel.empty.tipMention']).not.toMatch(/repl(y|ies)/i);
    expect(ko['channel.empty.tipMention']).toMatch(/inbox/);
    expect(ko['channel.empty.tipMention']).not.toMatch(/답한다/);
  });

  /**
   * **가리킨 메뉴 항목의 이름이 실제 메뉴의 글자와 같아야 한다.** 안내가 가리킨 자리를
   * 사람이 메뉴에서 못 찾으면 그 안내는 없느니만 못하다 — 언어를 나누면 그 어긋남이
   * 조용히 생기는 자리가 정확히 여기다.
   */
  it('topic 안내가 가리키는 메뉴 항목이 두 언어 모두 실제 메뉴의 글자다', () => {
    expect(en['channel.empty.tipTopic']).toContain(en['sidebar.menu.edit'] as string);
    expect(ko['channel.empty.tipTopic']).toContain(ko['sidebar.menu.edit'] as string);
  });
});

describe('찾기 두 줄 — 같은 물음이 아니다', () => {
  /**
   * `SearchPalette`(⌘K)는 **메시지 본문**을 서버에 묻고, 사이드바 찾기 줄은 **이름**을
   * 스토어에서 훑는다(그 파일의 표). 두 빈 결과가 같은 문장이면 사람은 ⌘K 가 채널도
   * 찾아 준다고 읽는다 — 그 구별이 언어를 건너 살아남는지 잰다.
   */
  it('빈 결과 문장이 두 언어 모두 서로 다르다', () => {
    for (const catalog of [en, ko]) {
      expect(catalog['search.palette.empty']).not.toEqual(catalog['sidebar.find.none']);
    }
    // 팔레트는 **무엇을** 못 찾았는지 말한다 — 메시지만 뒤지기 때문이다.
    expect(en['search.palette.empty']).toMatch(/message/i);
    expect(ko['search.palette.empty']).toMatch(/메시지/);
  });

  /**
   * **`이 채널` 을 안 버린다.** 좁히는 것이 사람의 명시적 선택이라는 규약(`#221`)이
   * 그 한 마디에 걸려 있다 — 이름만 남기면 그것이 지금 보고 있는 곳이라는 사실이 사라진다.
   */
  it('좁힌 검색이 두 언어 모두 「지금 보는 채널」이라고 말한다', () => {
    expect(en['search.palette.scopeLabel']).toMatch(/this channel/);
    expect(en['search.palette.placeholderScoped']).toMatch(/this channel/);
    expect(ko['search.palette.scopeLabel']).toMatch(/이 채널/);
    expect(ko['search.palette.placeholderScoped']).toMatch(/이 채널/);
  });

  /** 팔레트가 실제로 두 언어로 뜨는지 — 사전만 보면 배선이 틀려도 초록이다. */
  it('팔레트가 두 언어로 뜬다', async () => {
    const openPalette = () => {
      useActiveStore.getState().set({
        accounts: { [ME]: acc(ME, 'me') },
        channels: [chan('c1', 'general')],
        activeChannelId: 'c1',
      });
      setController({
        api: { search: vi.fn(async () => ({ messages: [], hasMore: false })) },
      } as unknown as Controller);
      render(<SearchPalette open onClose={() => {}} />);
    };

    openPalette();
    expect(screen.getByText('In this channel (general)')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search everything')).toBeTruthy();

    cleanup();
    speak('ko');
    openPalette();
    expect(screen.getByText('이 채널 (general)')).toBeTruthy();
    expect(screen.getByPlaceholderText('전체에서 찾기')).toBeTruthy();
  });
});

describe('팀 상세 — 이름의 뜻을 두 언어가 다 말한다', () => {
  /**
   * 이름 칸 아래의 한 줄이 **세 사실**을 진다: 계정과 같은 네임스페이스 · `@이름` 이
   * 전원을 깨운다 · 사람 여럿은 Handle Groups. 하나라도 빠지면 이름을 정하는 사람이
   * 모르는 채로 정하고, 그 순간이 이 문장이 존재하는 유일한 이유다(그 자리 주석).
   */
  it('네임스페이스 · 전원이 깬다 · 집합은 저쪽 — 셋이 두 언어에 다 있다', () => {
    const e = en['agents.teams.nameNote'] as string;
    expect(e).toMatch(/namespace/);
    expect(e).toMatch(/every member/);
    expect(e).toMatch(/Handle Groups/);

    const k = ko['agents.teams.nameNote'] as string;
    expect(k).toMatch(/같은 이름 자리/);
    expect(k).toMatch(/전원이 깬다/);
    expect(k).toMatch(/Handle Groups/);
  });

  /**
   * **비활성 팀원이 왜 적히는가** — `Disabled` 한 낱말은 러너가 죽은 것인지 계정이 꺼진
   * 것인지 안 가른다. 이 줄이 말할 것은 **결과**다: 팀을 불러도 이 하나는 안 깬다.
   */
  it('비활성 팀원 줄이 두 언어 모두 「호출에서 빠진다」까지 말한다', () => {
    expect(en['agents.teams.memberDisabled']).toMatch(/left out when the team is called/);
    expect(ko['agents.teams.memberDisabled']).toMatch(/호출에서 빠진다/);
  });

  /**
   * 삭제 상자가 답해야 하는 것은 **무엇이 남는가** 다. `Are you sure?` 만으로는 사람이
   * 에이전트까지 사라지는 줄 알고 못 누른다.
   */
  it('팀 삭제 안내가 두 언어 모두 「에이전트는 남는다」를 말한다', () => {
    expect(en['agents.teams.deleteNote']).toMatch(/agents .*stay/);
    expect(ko['agents.teams.deleteNote']).toMatch(/에이전트는 그대로 있다/);
  });

  /**
   * **`admin` 은 두 언어에서 같은 글자다.** 이 제품의 고유어라 옮기면 사람이 문서·서버
   * 오류에서 보는 말과 화면의 말이 갈린다(`agents` 머리말). 초대 화면의 `관리자` 를
   * `admin` 으로 되돌린 것도 같은 규율이고, 그 자리를 함께 잰다.
   */
  it('admin 이 두 언어에서 같은 글자다', () => {
    for (const key of ['agents.teams.memberReadOnly', 'invite.notAdmin'] as (keyof typeof en)[]) {
      expect(en[key], `en.${key}`).toContain('admin');
      expect(ko[key], `ko.${key}`).toContain('admin');
      expect(ko[key], `ko.${key}`).not.toContain('관리자');
    }
  });

  /** 팀 상세가 실제로 두 언어로 뜬다 — 사전만 보면 배선이 틀려도 초록이다. */
  it('팀 상세가 두 언어로 뜬다', async () => {
    const team = tm('t1', 'release', 1);
    const open = () => {
      useActiveStore.getState().set({
        me: { ...acc(ME, 'me'), isAdmin: true },
        accounts: { [ME]: { ...acc(ME, 'me'), isAdmin: true } },
      });
      setController({
        getTeam: vi.fn(async () => ({ team, members: [] })),
      } as unknown as Controller);
      render(<TeamDetail team={team} agents={[]} onBack={() => {}} onChanged={() => {}} />);
    };

    open();
    await waitFor(() => expect(screen.getByText('No members')).toBeTruthy());
    expect(screen.getByLabelText('Edit team name')).toBeTruthy();
    expect(screen.getByTestId('team-back').textContent).toContain('Teams');

    cleanup();
    speak('ko');
    open();
    await waitFor(() => expect(screen.getByText('팀원이 없다')).toBeTruthy());
    expect(screen.getByLabelText('팀 이름 수정')).toBeTruthy();
    expect(screen.getByTestId('team-back').textContent).toContain('팀');
  });
});

describe('초대 화면 — 되돌릴 수 없는 것을 두 언어가 다 말한다', () => {
  /**
   * 이 화면의 세 사실은 전부 **되돌릴 수 없는 것**에 관한 말이다: 한 번만 보인다 ·
   * 한 번 쓰면 소진된다 · 지금 복사해야 한다. 하나라도 빠지면 사람이 토큰을 잃는다.
   */
  it('한 번만 보인다 · 소진된다 · 지금 복사한다 — 셋이 두 언어에 다 있다', () => {
    const e = `${en['invite.note']} ${en['invite.tokenWarning']} ${en['invite.tokenNextStep']}`;
    expect(e).toMatch(/once/);
    expect(e).toMatch(/used up/);
    expect(e).toMatch(/Copy it now/);

    const k = `${ko['invite.note']} ${ko['invite.tokenWarning']} ${ko['invite.tokenNextStep']}`;
    expect(k).toMatch(/한 번만/);
    expect(k).toMatch(/소진된다/);
    expect(k).toMatch(/지금 복사/);
  });

  /**
   * **다시 누르면 무엇을 잃는지**를 버튼이 말한다 — 그래서 버튼을 잠그지 않는다는 것이
   * 그 자리의 판단이고(초대는 여러 사람에게 하는 일이다), 그 대가를 라벨이 진다.
   */
  it('다시 발급 버튼이 두 언어 모두 「앞 토큰이 사라진다」를 말한다', () => {
    expect(en['invite.createAgain']).toMatch(/disappears/);
    expect(ko['invite.createAgain']).toMatch(/사라진다/);
  });

  /**
   * **어투를 `~다` 로 맞췄다.** 이 화면만 `~습니다`·`~세요` 였고, 한 화면만 높임말이면
   * 같은 앱이 사람을 두 가지로 대한다(`profileName` 이 세운 그 선례).
   */
  it('초대 화면의 한국어가 사전의 다른 한국어와 같은 어투다', () => {
    for (const key of [
      'invite.notAdmin', 'invite.note', 'invite.failed',
      'invite.tokenWarning', 'invite.tokenNextStep', 'invite.createAgain',
    ] as (keyof typeof en)[]) {
      const v = ko[key] as string;
      expect(v, `ko.${key}`).not.toMatch(/(습니다|하세요|세요)[.\s]*$/);
    }
  });
});

describe('레일 — 두 언어로 뜨고 칸 이름은 안 옮긴다', () => {
  const railProps = {
    panel: 'home' as const,
    onPanelChange: () => {},
    onOpenSaved: () => {},
    onOpenSettings: () => {},
    onOpenCommunityMark: () => {},
    onLogout: () => {},
  };

  /**
   * **칸 이름 넷은 두 언어 모두 그대로다.** `RAIL_CELLS` 의 그 값들은 62px 레일에서
   * 폭을 재어 고른 것이라(그 주석의 실측: `Agents` 가 11px 에서 32.89px), 언어마다
   * 길이가 갈리면 그 계산이 무너진다 — 옮기려면 **먼저 다시 재야 한다.**
   */
  it('칸 이름 넷이 두 언어에서 같은 글자다', () => {
    for (const locale of ['en', 'ko'] as const) {
      cleanup();
      speak(locale);
      useActiveStore.getState().set({ me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me') } });
      render(<Rail {...railProps} />);
      const rail = screen.getByTestId('rail').textContent ?? '';
      for (const name of ['Home', 'DM', 'Agents', 'Saved']) {
        expect(rail, `${locale}.${name}`).toContain(name);
      }
    }
  });

  /**
   * **배지의 수치는 이름이 진다** — 주황 원 하나는 스크린리더에 아무것도 아니다(문서).
   * 그 이름이 언어를 따라오는지, 그리고 칸 이름과 수치를 잇는 어순이 **사전의 것**인지
   * 잰다: 코드가 ` — ` 를 붙이면 그 자리가 한 언어의 어순으로 굳는다.
   */
  it('나를 막는 것의 수가 두 언어로 이름에 실린다', () => {
    const seedBlocking = () => {
      useActiveStore.getState().set({
        me: acc(ME, 'me'),
        accounts: { [ME]: acc(ME, 'me') },
        unread: [inboxEntry(1, 'm1', 'mention'), inboxEntry(2, 'm2', 'dm')],
      });
    };

    seedBlocking();
    render(<Rail {...railProps} />);
    expect(screen.getByTestId('rail-home').getAttribute('aria-label'))
      .toBe('Home — 2 waiting for you');

    cleanup();
    speak('ko');
    seedBlocking();
    render(<Rail {...railProps} />);
    expect(screen.getByTestId('rail-home').getAttribute('aria-label'))
      .toBe('Home — 나를 기다리는 것 2개');
  });
});

// ---------------------------------------------------------------------------
// 10. 사진·첨부 — **`if` 사슬을 표로 바꾼 자리**
//
// `avatarErrorMessage` 가 서버 코드별로 다른 문장을 냈는데, 그 갈래가 `if` 사슬이었다.
// 사슬은 **모르는 코드를 조용히 마지막 가지로 흘린다** — 서버가 새 코드를 내기 시작해도
// 아무도 모르고, 사람은 원인과 무관한 문장을 읽는다(`#658` 의 `writerDeniedText` 와 같은
// 모양이고 같은 방식으로 표가 됐다).
// ---------------------------------------------------------------------------

describe('사진 오류 — 원인별로 다른 말을 한다', () => {
  const err = (code: string) => new ApiError(400, code, code);

  /**
   * **원인이 다르면 문장이 다르다.** 앞 판은 무엇이 실패했든 한 문장이라, 서버가 죽었을
   * 때도 사람에게는 **자기 파일 탓**으로 보였고 파일을 바꿔 가며 다시 시도하게 만들었다.
   */
  it('네 코드가 두 언어 모두 서로 다른 문장을 받는다', () => {
    for (const locale of ['en', 'ko'] as const) {
      const t = translator(locale);
      const texts = ['not_an_image', 'too_large', 'svg_too_large', 'not_found']
        .map((c) => avatarErrorMessage(err(c), t));
      expect(new Set(texts).size, locale).toBe(4);
    }
  });

  /**
   * **모르는 코드는 그 코드를 그대로 보여 준다.** 표가 `undefined` 를 내는 자리이고,
   * 사람이 그 값을 그대로 옮겨 적어 물어볼 수 있어야 한다 — 사슬이었을 때는 그 코드가
   * 마지막 가지의 문장에 먹혀 사라졌다.
   */
  it('모르는 코드가 와도 그 코드가 문장에 남는다', () => {
    for (const locale of ['en', 'ko'] as const) {
      expect(avatarErrorMessage(err('brand_new_code'), translator(locale)), locale)
        .toContain('brand_new_code');
    }
  });

  /** 서버에 닿지도 못한 것은 **파일 문제가 아니다** — 그 사실이 문장에 있어야 한다. */
  it('연결 실패는 파일 탓으로 말하지 않는다', () => {
    expect(avatarErrorMessage(new Error('offline'), translator('en'))).toContain('server');
    expect(avatarErrorMessage(new Error('offline'), translator('ko'))).toContain('서버');
  });

  /** 형식 목록은 **옮기지 않는다** — 형식 이름이라 두 언어가 같은 글자를 받는다. */
  it('형식 목록은 두 언어 모두 그대로다', () => {
    for (const locale of ['en', 'ko'] as const) {
      expect(avatarErrorMessage(err('not_an_image'), translator(locale)), locale)
        .toContain('PNG');
    }
  });
});

// ---------------------------------------------------------------------------
// 11. 잔여 — **화면 문구의 마지막 묶음**
//
// 이 뒤로 `src/` 에 남는 한국어는 `throw new Error` 와 `console.error` 뿐이고, 그것은
// 사람에게 가는 말이 아니라 **개발자가 보는 계약 위반**이라 의도적으로 남긴다
// (`runnerLauncher` 가 세운 경계).
// ---------------------------------------------------------------------------

describe('잔여 — 훑기·계정 열기·멘션', () => {
  /**
   * **두 버튼이 다른 일을 한다.** `readAndNext` 는 읽음으로 표시하고 넘어가고,
   * `justNext` 는 표시하지 않고 넘어간다 — 한 낱말로 뭉치면 훑기의 요점이 사라진다.
   */
  it('훑기의 두 버튼이 화면에서 다른 말을 하고 언어를 따라온다', () => {
    const items = [{
      channelId: 'c1', label: '#general', newestSeq: 1, oldestAt: '2026-09-01T00:00:00.000Z',
      messages: [msg('m1', 'c1', 1, 'hi', FORGE)],
    }];
    const shell = () => (
      <SweepShell items={items} loading={false} error={null}
        onRetry={() => {}} onClose={() => {}} onMarkRead={async () => {}} />
    );
    render(shell());
    expect(screen.getByText(en['sweep.readAndNext'])).toBeTruthy();
    expect(screen.getByText(en['sweep.justNext'])).toBeTruthy();

    cleanup();
    speak('ko');
    render(shell());
    expect(screen.getByText(ko['sweep.readAndNext'])).toBeTruthy();
    expect(screen.getByText(ko['sweep.justNext'])).toBeTruthy();
  });

  /**
   * **가는 곳이 다르면 이름도 달라야 한다.** 스크린리더는 설정과 프로필의 차이를
   * 이름으로만 알 수 있다 — `lib/accountOpen.ts` 머리말이 그 둘을 한 함수로 모은 이유가
   * *"갈 곳과 이름이 어긋나지 않게"* 였고, 이 축이 그 짝을 잰다.
   */
  it('계정 열기 이름이 갈 곳을 가르고 언어를 따라온다', () => {
    const agent = { ...acc(FORGE, 'forge'), kind: 'agent' as const };
    const admin = { id: ME, isAdmin: true };
    const openers = { onOpenDirectory: () => {}, onOpenSettings: () => {} };
    for (const [locale, cat] of [['en', en], ['ko', ko]] as const) {
      const t = translator(locale);
      // admin 이면 설정으로, 문이 없으면 프로필로 — **갈 곳이 다르면 이름도 다르다.**
      const toConfig = accountOpen(agent, admin, openers, t)!;
      const toProfile = accountOpen(agent, admin, { onOpenDirectory: () => {} }, t)!;
      expect(toConfig.label, locale).not.toBe(toProfile.label);
      expect(toConfig.label, locale).toBe(
        (cat['accountOpen.agentConfig'] as string).replace('{handle}', 'forge'),
      );
      // handle 은 옮기지 않는다 — 이름이다.
      expect(toProfile.label, locale).toContain('forge');
    }
  });

  /** 못 찾은 계정은 **지우지 않고 말한다** — 지우면 문장에 구멍이 나고, id 는 못 읽는다. */
  it('모르는 계정 자리가 두 언어로 뜬다', () => {
    expect(translator('en')('mention.unknownAccount')).toBe('unknown');
    expect(translator('ko')('mention.unknownAccount')).toBe('알 수 없음');
  });
});

// ---------------------------------------------------------------------------
// 12. 언어 고르개 — **사람이 언어를 바꿀 수 있다**
//
// 사전과 배선은 진작 있었는데(`prefs.locale`·`setLocale`) **고를 자리가 없었다.**
// 옮기기가 다 끝나도 그 상태로는 반쪽이다 — 화면이 두 언어를 낼 줄 알아도 사람이
// 그것을 부를 방법이 없기 때문이다.
// ---------------------------------------------------------------------------

describe('언어 고르개', () => {
  it('고르면 화면이 그 언어로 바뀐다', () => {
    render(<AppearanceSettings />);
    // 기본은 영어다.
    expect(screen.getByText(en['appearance.language'])).toBeTruthy();

    fireEvent.click(screen.getByText(LOCALE_NAMES.ko));
    expect(usePrefsStore.getState().locale).toBe('ko');
    // 같은 화면이 다시 그려지며 한국어가 된다.
    expect(screen.getByText(ko['appearance.language'])).toBeTruthy();
  });

  /**
   * **언어 이름은 사전을 안 지난다.** 지나면 지금 언어로 번역되어 영어 화면에서
   * `Korean` 이 되고, **한국어를 찾는 사람이 자기 언어를 못 찾는다** — 고르개가
   * 있어야 하는 이유 자체를 무너뜨린다.
   */
  it('언어 이름은 어느 화면에서도 그 언어로 적힌다', () => {
    for (const locale of ['en', 'ko'] as const) {
      cleanup();
      speak(locale);
      render(<AppearanceSettings />);
      expect(screen.getByText('English'), locale).toBeTruthy();
      expect(screen.getByText('한국어'), locale).toBeTruthy();
    }
  });

  /**
   * `System` 은 언어가 아니라 **"내가 안 고르겠다"는 결정**이라 지금 언어로 말한다.
   *
   * 색 모드에도 같은 낱말이 서므로 **그 묶음 안에서** 찾는다 — 화면 전체에서 찾으면
   * 둘이 걸리고, 그 둘은 서로 다른 것을 뜻한다.
   */
  it("'시스템'은 지금 언어를 따른다", () => {
    const langGroup = () => screen.getByRole('radiogroup', {
      name: usePrefsStore.getState().locale === 'ko' ? ko['appearance.language'] : en['appearance.language'],
    });
    render(<AppearanceSettings />);
    expect(within(langGroup()).getByText(en['appearance.languageSystem'])).toBeTruthy();
    cleanup();
    speak('ko');
    render(<AppearanceSettings />);
    expect(within(langGroup()).getByText(ko['appearance.languageSystem'])).toBeTruthy();
  });
});
