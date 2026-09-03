import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { Workspace } from '../src/components/Workspace';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc, chan, fakeApi, msg, grp } from './helpers/fakeApi';

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', true),
    accounts: {
      u1: acc('u1', 'me', 'human', true),
      u2: acc('u2', 'someone', 'human', false),
      a1: acc('a1', 'fizz', 'agent', false, { ownerAccountId: 'u1' }),
      a2: acc('a2', 'buzz', 'agent', false, { ownerAccountId: 'u2' }),
      a3: acc('a3', 'gone', 'agent', false, { ownerAccountId: null, disabled: true }),
      // 비활성 **사람**. 에이전트로 두면 admin 에게는 설정으로 가서 디렉터리 경로를 못 본다.
      u4: acc('u4', 'ghost', 'human', false, { disabled: true }),
    },
    groups: [grp('g1', 'oncall', 'On-call')],
  });
});
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('멘션 클릭 (#279)', () => {
  let onOpenDirectory: ReturnType<typeof vi.fn>;
  let onOpenSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onOpenDirectory = vi.fn();
    onOpenSettings = vi.fn();
  });

  const showWithCallbacks = (body: string) =>
    render(
      <MessageItem
        message={msg('m1', 'c1', 1, body, 'u2')}
        onOpenDirectory={onOpenDirectory}
        onOpenSettings={onOpenSettings}
      />,
    );

  it('존재하는 사람 멘션이 버튼이고 누르면 디렉터리가 그 계정으로 열린다', () => {
    showWithCallbacks('@someone 안녕');

    const mention = screen.getByTestId('mention-someone');
    expect(mention.tagName).toBe('BUTTON');
    fireEvent.click(mention);

    expect(onOpenDirectory).toHaveBeenCalledWith('u2');
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('존재하지 않는 handle 은 버튼이 아니다', () => {
    showWithCallbacks('@notexist 안녕');

    // 강조되지 않는 것과 같은 판정이다 — 멘션 조각 자체가 만들어지지 않는다.
    expect(screen.queryByTestId('mention-notexist')).toBeNull();
    expect(screen.getByTestId('message-body').querySelectorAll('button')).toHaveLength(0);
  });

  it('에이전트 멘션을 admin 이 누르면 설정이 그 에이전트로 열린다', () => {
    showWithCallbacks('@fizz 이거 봐줘');

    const mention = screen.getByTestId('mention-fizz');
    expect(mention.tagName).toBe('BUTTON');
    fireEvent.click(mention);

    expect(onOpenSettings).toHaveBeenCalledWith('agents', 'a1');
    expect(onOpenDirectory).not.toHaveBeenCalled();
  });

/**
    * #299: 이전에는 `GET /accounts/agents` 가 `requireAdmin` 이라 소유자가 설정으로 가면
    * 403 을 받고 빈 화면을 보냈다. 이제 라우트가 열렸고, 소유자도 자기 에이전트를
    * 설정에서 볼 수 있다. 아래 테스트가 그 새 동작을 확인한다.
    */
  it('소유자(admin 아님)가 에이전트 멘션을 누르면 설정이 그 에이전트로 열린다', () => {
    useAppStore.getState().set({
      me: acc('u2', 'owner', 'human', false),
      accounts: {
        u1: acc('u1', 'admin', 'human', true),
        u2: acc('u2', 'owner', 'human', false),
        a2: acc('a2', 'buzz', 'agent', false, { ownerAccountId: 'u2' }),
      },
    });
    showWithCallbacks('@buzz 이거 봐줘');

    const mention = screen.getByTestId('mention-buzz');
    expect(mention.tagName).toBe('BUTTON');
    fireEvent.click(mention);

    expect(onOpenSettings).toHaveBeenCalledWith('agents', 'a2');
    expect(onOpenDirectory).not.toHaveBeenCalled();
  });

  it('소유자가 설정으로 가면 에이전트가 선택된 화면이다', async () => {
    useAppStore.getState().set({ me: acc('u2', 'owner', 'human', false) });
    const api = fakeApi();
    // 서버가 소유자에게 하는 응답. 목록 필터가 적용되어 자기 에이전트만 온다.
    // 소유자에게는 PAT·메모리도 열린다(#253 의 표) — 그래서 그 조회도 나간다. 목을
    // 빠뜨리면 화면이 터지는데, 그 터짐이야말로 "조회가 실제로 나간다"는 증거다.
    const listPats = vi.fn().mockResolvedValue([]);
    const agentMemory = vi.fn().mockResolvedValue([]);
    setController({
      listAgents: vi.fn().mockResolvedValue([
        { id: 'a2', handle: 'buzz', kind: 'agent', ownerAccountId: 'u2', harness: 'claude-code' },
      ]),
      agentDefaults: vi.fn().mockRejectedValue(new Error('forbidden')),
      listPats, agentMemory,
      api,
    } as unknown as Controller);

    render(<AgentsSettings targetId="a2" />);

    // #299: 이제 목록이 오고, targetId 로 그 에이전트가 선택된다.
    await waitFor(() => expect(screen.getByDisplayValue('buzz')).toBeTruthy());
    // 패널이 그려지는 것으로 끝나면 안 된다 — 조회가 실제로 나가야 내용이 채워진다.
    await waitFor(() => expect(listPats).toHaveBeenCalledWith('a2'));
    await waitFor(() => expect(agentMemory).toHaveBeenCalledWith('a2'));
  });

  it('소유자도 admin 도 아니면 디렉터리로 열린다', () => {
    useAppStore.getState().set({
      me: acc('u3', 'stranger', 'human', false),
      accounts: {
        u1: acc('u1', 'admin', 'human', true),
        u3: acc('u3', 'stranger', 'human', false),
        a1: acc('a1', 'fizz', 'agent', false, { ownerAccountId: 'u1' }),
      },
    });
    showWithCallbacks('@fizz 이거 봐줘');

    fireEvent.click(screen.getByTestId('mention-fizz'));

    expect(onOpenDirectory).toHaveBeenCalledWith('a1');
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('접근 가능한 이름이 동작을 말한다 — @handle 만이 아니다', () => {
    showWithCallbacks('@someone 안녕');

    const name = screen.getByTestId('mention-someone').getAttribute('aria-label')!;
    expect(name).toBe('someone 프로필 열기');
    // `@handle` 만인 이름은 무엇이 일어날지 말하지 않는다.
    expect(name).not.toBe('@someone');
    expect(name).not.toBe('someone');
    // 그 이름으로 실제로 잡힌다(스크린리더가 부르는 그 이름이다).
    expect(screen.getByRole('button', { name: 'someone 프로필 열기' })).toBeTruthy();
  });

  it('이름이 실제로 열리는 곳을 말한다 — admin 과 소유자는 설정, 그 외는 프로필', () => {
    showWithCallbacks('@fizz 안녕');
    expect(screen.getByTestId('mention-fizz').getAttribute('aria-label'))
      .toBe('fizz 에이전트 설정 열기');
    cleanup();

    // admin 이 아닌 사람이 보면 디렉터리로 열린다 — 이름도 그렇게 말해야 한다.
    useAppStore.getState().set({ me: acc('u3', 'stranger', 'human', false) });
    showWithCallbacks('@fizz 안녕');
    expect(screen.getByTestId('mention-fizz').getAttribute('aria-label'))
      .toBe('fizz 프로필 열기');
    cleanup();

    // 소유자도 설정으로 간다(#299) — 이름이 "설정 열기"라야 한다.
    useAppStore.getState().set({
      me: acc('u1', 'owner', 'human', false),
      accounts: {
        u1: acc('u1', 'owner', 'human', false),
        a1: acc('a1', 'fizz', 'agent', false, { ownerAccountId: 'u1' }),
      },
    });
    showWithCallbacks('@fizz 안녕');
    expect(screen.getByTestId('mention-fizz').getAttribute('aria-label'))
      .toBe('fizz 에이전트 설정 열기');
  });

  /**
   * 키보드 경로. `<button>` 이면 브라우저가 탭 순서와 Enter/Space 활성화를 준다 — jsdom 은
   * Enter 를 click 으로 바꿔 주지 않으므로 그 **전제**(포커스를 받고 click 으로 동작한다)를
   * 확인한다. 같은 자리를 `<span>` 으로 되돌리면 포커스 단언이 빨개진다.
   */
  it('키보드로 도달·실행된다 (span 은 도달하지 못한다)', () => {
    showWithCallbacks('@someone 안녕 @oncall');

    const mention = screen.getByTestId('mention-someone') as HTMLElement;
    mention.focus();
    expect(document.activeElement).toBe(mention);
    fireEvent.click(mention);
    expect(onOpenDirectory).toHaveBeenCalledWith('u2');

    // 갈 곳이 없는 것(집합)은 포커스를 받지 않는다 — 탭으로 지나가지도 않는다.
    const group = screen.getByTestId('mention-oncall') as HTMLElement;
    group.focus();
    expect(document.activeElement).not.toBe(group);
  });

  it('집합 멘션은 버튼이 아니다 — 디렉터리에 집합의 행이 없다', () => {
    showWithCallbacks('@oncall 안녕');

    const mention = screen.getByTestId('mention-oncall');
    expect(mention.tagName).toBe('SPAN');
    expect(mention.getAttribute('data-group')).toBe('true');
  });

  it('신호를 넘기지 않으면 멘션은 버튼이 아니다 — 죽은 버튼을 만들지 않는다', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '@someone 안녕', 'u2')} />);
    expect(screen.getByTestId('mention-someone').tagName).toBe('SPAN');
  });
});

/**
 * 배선을 **`Workspace` 를 통째로 띄워** 확인한다(#279).
 *
 * 위의 단위 테스트는 `MessageItem` 에 콜백을 손으로 넘긴다 — 그래서 초판이 `Workspace` 에서
 * `ChannelPane` 으로 두 신호를 **넘기지 않은** 것을 하나도 잡지 못했다. 앱에서는 모든 멘션이
 * 눌러도 아무 일이 없는 버튼이었고 테스트는 9건 전부 초록이었다. `searchEntryPoint` 가
 * 같은 이유로 이 화면을 통째로 띄운다(#258 의 재마운트 결함이 그 틈에서 나왔다).
 */
describe('멘션 클릭 배선 — Workspace 를 통째로 (#279)', () => {
  let onOpenSettings: ReturnType<typeof vi.fn>;

  const mount = (body: string, extra: Record<string, unknown> = {}) => {
    const api = fakeApi();
    setController({
      api,
      openChannel: vi.fn().mockResolvedValue(undefined),
      openThread: vi.fn(),
      closeThread: vi.fn(),
      startDm: vi.fn(),
      logout: vi.fn(),
      notifyTyping: vi.fn(),
      refreshAccounts: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      loadOlder: vi.fn(),
      goBack: vi.fn().mockResolvedValue(false),
      goForward: vi.fn().mockResolvedValue(false),
    } as unknown as Controller);
    useAppStore.getState().set({
      channels: [chan('c1', 'general')],
      connected: true,
      activeChannelId: 'c1',
      messages: { c1: [msg('m1', 'c1', 1, body, 'u2')] },
      ...extra,
    });
    onOpenSettings = vi.fn();
    return render(<Workspace onLogout={vi.fn()} onOpenSettings={onOpenSettings} />);
  };

  beforeEach(() => { localStorage.clear(); });

  it('사람 멘션을 누르면 디렉터리가 그 계정이 강조된 상태로 열린다', async () => {
    mount('@someone 안녕');

    const mention = screen.getByTestId('mention-someone');
    expect(mention.tagName).toBe('BUTTON');
    fireEvent.click(mention);

    const dialog = await screen.findByRole('dialog', { name: '디렉터리' });
    expect(dialog).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('directory-row-u2').getAttribute('data-selected')).toBe('true'));
    // 다른 행은 강조되지 않는다 — "그 계정으로 열렸다" 가 아무 행에나 붙으면 뜻이 없다.
    expect(screen.getByTestId('directory-row-u2')).toBeTruthy();
    expect(screen.queryByTestId('directory-row-u1')).toBeNull();
  });

  it('admin 이 에이전트 멘션을 누르면 설정이 그 에이전트로 열린다', () => {
    mount('@fizz 이거 봐줘');

    fireEvent.click(screen.getByTestId('mention-fizz'));

    expect(onOpenSettings).toHaveBeenCalledWith('agents', 'a1');
  });

  // 비활성 계정도 열린다 — 디렉터리가 `비활성` 배지를 그린다(#94·#251).
  it('비활성 계정 멘션도 열리고 디렉터리에 비활성 배지가 보인다', async () => {
    mount('@ghost 아직 있나');

    const mention = screen.getByTestId('mention-ghost');
    expect(mention.tagName).toBe('BUTTON');
    fireEvent.click(mention);

    await screen.findByRole('dialog', { name: '디렉터리' });
    await waitFor(() =>
      expect(screen.getByTestId('directory-row-u4').getAttribute('data-selected')).toBe('true'));
    expect(screen.getByTestId('directory-disabled-u4').textContent).toContain('비활성');
  });

  /**
   * 8. 소유자 경로도 **`Workspace` 를 통째로 띄워** 확인한다(#299).
   *
   * 위 단위 테스트는 `MessageItem` 에 콜백을 손으로 넘긴다 — 그래서 `Workspace` 가
   * `onOpenSettings` 를 안 넘기는 배선 결함을 하나도 잡지 못한다. 소유자 분기는 admin
   * 분기와 **다른 조건**을 타므로, admin 경로만 통째로 확인해 두면 소유자 경로는
   * 여전히 죽어 있을 수 있다.
   */
  it('소유자가 에이전트 멘션을 누르면 설정이 그 에이전트로 열린다', () => {
    // a2(buzz)의 소유자는 u2 다. 그 사람으로 로그인한다 — admin 이 아니다.
    mount('@buzz 이거 봐줘', { me: acc('u2', 'someone', 'human', false) });

    fireEvent.click(screen.getByTestId('mention-buzz'));

    expect(onOpenSettings).toHaveBeenCalledWith('agents', 'a2');
  });

  it('소유자도 admin 도 아니면 통째 배선에서도 디렉터리로 간다', async () => {
    mount('@buzz 이거 봐줘', { me: acc('u3', 'stranger', 'human', false) });

    fireEvent.click(screen.getByTestId('mention-buzz'));

    await screen.findByRole('dialog', { name: '디렉터리' });
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('스레드 패널의 멘션도 같게 동작한다', () => {
    mount('@someone 안녕', { threadRootId: 'm1' });

    // 대화와 스레드에 같은 메시지가 그려진다 — 둘 다 버튼이어야 한다.
    const mentions = screen.getAllByTestId('mention-someone');
    expect(mentions.length).toBeGreaterThan(1);
    for (const m of mentions) expect(m.tagName).toBe('BUTTON');
  });
});
