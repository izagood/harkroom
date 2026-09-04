import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AccountView, AgentView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Directory } from '../src/components/Directory';
import { Sidebar } from '../src/components/Sidebar';
import { acc } from './helpers/fakeApi';

const fakeController = (refreshAccounts = vi.fn(async () => undefined)) => {
  const c = { refreshAccounts };
  setController(c as unknown as Controller);
  return c;
};

/**
 * admin 전용 정보를 가진 에이전트. `AgentView extends AccountView` 이므로 **이런 객체가
 * `accounts` 에 그대로 들어올 수 있다** — 타입은 harness 유출을 막아 주지 않는다.
 * 6번 회귀선이 이 fixture 를 필요로 한다.
 */
const agentWithSecrets = (id: string, handle: string): AgentView => ({
  ...acc(id, handle, 'agent'),
  instructions: '비밀 지시문',
  harness: 'claude-code',
  model: 'opus-secret',
  effort: 'high',
  workingDir: '/Users/secret/workspace',
  mentionPermission: 'auto',
  // #181: 소유자는 **null 이 정상 상태**다. 여기에 값을 넣으면 소유자 handle 이 목록에
  // 한 번 더 나타나 이 파일의 다른 회귀선들이 세는 수를 바꾼다 — 소유자 표시는 아래
  // 전용 회귀선이 따로 본다.
  ownerAccountId: null,
  runnerVersion: 'deadbeef',
  // #176 이 AgentView 에 더한 필수 필드. #226 브랜치가 그 앞에서 갈라져 fixture 에 없었다.
  lastTurnAt: null,
  stopRequestedAt: null,
  stopAckedAt: null,
});

const put = (...list: AccountView[]): void => {
  useAppStore.getState().set({ accounts: Object.fromEntries(list.map((a) => [a.id, a])) });
};

beforeEach(() => {
  useAppStore.getState().reset();
  fakeController();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open = () => render(<Directory open onClose={vi.fn()} />);

describe('Directory (#226)', () => {
  it('사람과 에이전트를 모두 그린다', async () => {
    put(acc('u1', 'alice'), agentWithSecrets('a1', 'scribe'));
    open();
    await waitFor(() => expect(screen.getByText('@alice')).toBeTruthy());
    expect(screen.getByText('@scribe')).toBeTruthy();
  });

  // #181: 소유자도 `Identity` 를 통과해 나온다 — 디렉터리가 따로 그리지 않는다.
  it('에이전트 행에 소유자가 함께 보인다', async () => {
    put(acc('u1', 'alice'), { ...agentWithSecrets('a1', 'scribe'), ownerAccountId: 'u1' });
    open();
    const agents = await waitFor(() => screen.getByRole('region', { name: 'Agents' }));
    expect(within(agents).getByText('@alice')).toBeTruthy();
  });

  /**
   * #365: 사람의 `badge` 가 아무것도 그리지 않게 되면서 **디렉터리 사람 행의 아바타도
   * 사라졌다.** 그 사라짐을 여기서 못 박는다 — 회귀선이 없으면 아무도 모르는 변화가 된다.
   *
   * **이 자리를 `variant="avatar"` 로 바꾸면 안 된다.** 같은 한 호출이 에이전트에게는
   * 소유자 표시(#181·#226)를 내는 자리라, avatar 로 바꾸면 소유자가 통째로 사라진다.
   * 그래서 두 사실을 **한 테스트에서 함께** 본다: 한쪽만 단언하면 다른 쪽을 바꿔도 초록이다.
   */
  it('#365 사람 행에는 아바타가 없고, 같은 자리가 에이전트에게는 소유자를 낸다', async () => {
    put(
      // 사진을 **걸어 둔** 사람이다 — 사진이 없어서 안 보이는 것과 자리가 없어서 안 보이는
      // 것을 가른다. 사진이 있는데도 상자가 없어야 이 자리가 정말 비었다는 뜻이다.
      acc('u1', 'alice', 'human', false, { avatarAttachmentId: 'att-1' }),
      { ...agentWithSecrets('a1', 'scribe'), ownerAccountId: 'u1' },
    );
    open();

    const people = await waitFor(() => screen.getByRole('region', { name: 'People' }));
    const row = within(people).getByTestId('directory-row-u1');
    expect(row.querySelector('[data-testid="identity-avatar"]')).toBeNull();
    // 이니셜 폴백도 없다. displayName·handle 은 'alice' 라 대문자 한 글자와 섞이지 않는다.
    expect(within(row).queryByText('A')).toBeNull();
    // 정보는 사라지지 않았다 — 핸들·표시 이름·kind 배지가 그대로 남아 행을 설명한다.
    expect(within(row).getByText('@alice')).toBeTruthy();
    expect(within(row).getByTestId('directory-kind-u1')).toBeTruthy();

    // 같은 `variant="badge"` 호출이 에이전트 행에서는 소유자를 낸다. 이것이 이 자리를
    // avatar 로 바꾸지 않은 이유다.
    const agents = screen.getByRole('region', { name: 'Agents' });
    expect(within(agents).getByText('@alice')).toBeTruthy();
  });

  // 섹션이 갈려 있어야 "이 handle 이 사람인가 에이전트인가"를 화면이 답한다. 한 목록에
  // 섞어 두면 이름만 보고는 구분할 수 없다.
  it('사람과 에이전트가 구분돼 보인다', async () => {
    put(acc('u1', 'alice'), agentWithSecrets('a1', 'scribe'));
    open();
    await waitFor(() => expect(screen.getByText('@alice')).toBeTruthy());

    const people = screen.getByRole('region', { name: 'People' });
    const agents = screen.getByRole('region', { name: 'Agents' });
    expect(within(people).getByText('@alice')).toBeTruthy();
    expect(within(people).queryByText('@scribe')).toBeNull();
    expect(within(agents).getByText('@scribe')).toBeTruthy();
    expect(within(agents).queryByText('@alice')).toBeNull();
  });

  // displayName 이 handle 을 포함하지 않게 둔다. 둘이 같은 문자열이면 displayName 만
  // 보는 구현도 이 테스트를 통과해 버려, 검색이 handle 을 본다는 것을 아무것도 지키지 못한다.
  it('검색이 handle 로 찾는다', async () => {
    put(
      { ...acc('u1', 'alice'), displayName: 'Wonder Land' },
      { ...acc('u2', 'bob'), displayName: 'Robert Lee' },
    );
    open();
    await waitFor(() => expect(screen.getByText('@alice')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('디렉터리 검색'), { target: { value: 'bob' } });
    expect(screen.getByText('@bob')).toBeTruthy();
    expect(screen.queryByText('@alice')).toBeNull();
  });

  // handle 과 displayName 은 다른 문자열이다. 한쪽만 보면 "이름은 아는데 handle 은 모르는"
  // 사람을 영원히 못 찾는다.
  it('검색이 displayName 으로도 찾는다', async () => {
    put(
      { ...acc('u1', 'alice'), displayName: 'Alice Kim' },
      { ...acc('u2', 'bob'), displayName: 'Bob Lee' },
    );
    open();
    await waitFor(() => expect(screen.getByText('@alice')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('디렉터리 검색'), { target: { value: 'kim' } });
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.queryByText('@bob')).toBeNull();
  });

  // 비활성 계정은 목록에서 빠지지 않는다 — 빼면 "이 사람이 없다"와 "꺼져 있다"가 같은
  // 화면이 된다. 남기되 꺼져 있다는 것이 읽혀야 한다.
  it('비활성 계정이 꺼져 있다는 것이 보인다', async () => {
    put(acc('u1', 'alice'), { ...acc('u2', 'ghost'), disabled: true });
    open();
    await waitFor(() => expect(screen.getByText('@ghost')).toBeTruthy());

    const ghostRow = screen.getByTestId('directory-row-u2');
    expect(within(ghostRow).getByTestId('directory-disabled-u2').textContent).toBe('비활성');
    const aliceRow = screen.getByTestId('directory-row-u1');
    expect(within(aliceRow).queryByTestId('directory-disabled-u1')).toBeNull();
  });

  // 이 화면은 **모든 사용자가 본다**. harness·model·workingDir·소유자는
  // `GET /accounts/agents`(requireAdmin)의 것이고 여기로 새면 안 된다.
  it('harness·소유자 같은 admin 전용 정보가 화면에 없다', async () => {
    put(acc('u1', 'alice'), agentWithSecrets('a1', 'scribe'));
    open();
    await waitFor(() => expect(screen.getByText('@scribe')).toBeTruthy());

    const shown = document.body.textContent ?? '';
    for (const secret of ['claude-code', 'opus-secret', '/Users/secret/workspace', 'deadbeef', '비밀 지시문']) {
      expect(shown).not.toContain(secret);
    }
  });

  // 실패를 빈 목록으로 삼키면 "서버가 죽었다"가 "아무도 없다"로 보인다.
  it('조회 실패를 빈 목록으로 삼키지 않는다', async () => {
    fakeController(vi.fn(async () => { throw new Error('boom'); }));
    open();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('불러오지 못했다');
    expect(alert.textContent).toContain('boom');
    expect(screen.queryByText('이 워크스페이스에 아직 계정이 없다')).toBeNull();
  });

  it('정말 비어 있으면 실패가 아니라 비었다고 말한다', async () => {
    open();
    await waitFor(() => expect(screen.getByText('이 워크스페이스에 아직 계정이 없다')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('사이드바에서 디렉터리로 갈 수 있다', () => {
    put(acc('u1', 'alice'));
    useAppStore.getState().set({ me: acc('u1', 'alice') });
    const onOpenDirectory = vi.fn();
    render(
      <Sidebar
        onOpenDirectory={onOpenDirectory} onOpenChannelDirectory={vi.fn()}
        onOpenInbox={vi.fn()} onOpenSaved={() => {}}
        onLogout={vi.fn()}
        onOpenSettings={vi.fn()}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Directory'));
    expect(onOpenDirectory).toHaveBeenCalled();
  });
});
