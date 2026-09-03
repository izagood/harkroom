import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { HandleGroupsSettings } from '../src/components/settings/HandleGroupsSettings';
import { Composer } from '../src/components/Composer';
import { acc, grp, fakeApi, fakeWsFactory } from './helpers/fakeApi';

/**
 * 핸들 집합 설정 화면(#285).
 *
 * 목록은 **스토어**에서 온다 — `GET /handle-groups` 는 admin 전용이라 비-admin 이
 * 읽기 전용 목록을 보려면 그 길밖에 없다(`HandleGroupsSettings` 의 주석). 그래서 이
 * 파일의 준비는 `set({ groups })` 이고, 화면이 목록 조회를 부르지 않는 것도 단언한다.
 */
const seed = (isAdmin: boolean) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me', 'human', isAdmin),
    accounts: {
      u1: acc('u1', 'me', 'human', isAdmin),
      u2: acc('u2', 'alice', 'human'),
      a1: acc('a1', 'bot', 'agent'),
    },
    groups: [grp('g1', 'oncall', 'On-call', 1)],
  });
};

beforeEach(() => seed(true));
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

function mount(overrides: Partial<Parameters<typeof fakeApi>[0]> = {}) {
  const api = fakeApi({
    getHandleGroup: vi.fn(async (id: string) => ({ group: grp(id, 'oncall', 'On-call', 1), members: ['u2'] })),
    ...overrides,
  });
  setController(new Controller(api, fakeWsFactory().makeWs));
  render(<HandleGroupsSettings />);
  return api as ReturnType<typeof fakeApi> & Record<string, ReturnType<typeof vi.fn>>;
}

const openGroup = async () => {
  fireEvent.click(screen.getByTestId('group-row-oncall'));
  await waitFor(() => expect(screen.getByRole('heading', { name: '@oncall' })).toBeTruthy());
};

describe('핸들 집합 설정 화면 (#285)', () => {
  it('1. 만들기가 생성 라우트를 부르고 목록(스토어)에 반영된다', async () => {
    const api = mount();

    fireEvent.change(screen.getByLabelText('집합 핸들'), { target: { value: 'release' } });
    fireEvent.change(screen.getByLabelText('집합 표시 이름'), { target: { value: 'Release' } });
    fireEvent.click(screen.getByText('만들기'));

    await waitFor(() => expect(api.createHandleGroup).toHaveBeenCalledWith({
      handle: 'release', displayName: 'Release',
    }));
    // 스토어까지 가야 작성창 후보가 함께 바뀐다 — 지역 상태만 고치면 두 목록이 갈라진다.
    await waitFor(() => expect(useAppStore.getState().groups.map((g) => g.handle)).toContain('release'));
  });

  it('1b. 구성원 추가·제거가 라우트를 부르고 구성원 수가 스토어에서 갱신된다', async () => {
    const api = mount({
      addHandleGroupMembers: vi.fn(async () => ({ members: ['u2', 'u1'] })),
      removeHandleGroupMembers: vi.fn(async () => ({ members: [] })),
    });
    await openGroup();

    fireEvent.change(screen.getByLabelText('구성원 추가'), { target: { value: 'u1' } });
    await waitFor(() => expect(api.addHandleGroupMembers).toHaveBeenCalledWith('g1', ['u1']));
    // 수는 추측(±1)이 아니라 라우트가 준 명단의 길이다.
    await waitFor(() => expect(useAppStore.getState().groups[0]!.memberCount).toBe(2));

    fireEvent.click(screen.getByLabelText('구성원 제거: alice'));
    await waitFor(() => expect(api.removeHandleGroupMembers).toHaveBeenCalledWith('g1', ['u2']));
    await waitFor(() => expect(useAppStore.getState().groups[0]!.memberCount).toBe(0));
  });

  it('1c. 삭제는 한 번 더 물은 뒤에 라우트를 부르고 목록에서 사라진다', async () => {
    const api = mount();
    await openGroup();

    fireEvent.click(screen.getByText('집합 삭제'));
    // 첫 누름은 확인 단계일 뿐이다 — 여기서 라우트가 가면 확인이 확인이 아니다.
    expect(api.deleteHandleGroup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('정말 지운다'));
    await waitFor(() => expect(api.deleteHandleGroup).toHaveBeenCalledWith('g1'));
    await waitFor(() => expect(useAppStore.getState().groups).toHaveLength(0));
  });

  it('2. 비-admin 에게는 편집 컨트롤이 렌더되지 않는다 (비활성 버튼이 아니라 부재)', async () => {
    seed(false);
    const api = mount();

    // 목록은 보인다 — 읽기 전용이라는 것이 "아무것도 안 보인다"는 뜻은 아니다.
    expect(screen.getByTestId('group-row-oncall')).toBeTruthy();
    expect(screen.getByText('On-call')).toBeTruthy();

    // 편집 수단은 **없다.** 비활성 버튼으로 두면 눌러 보고 나서야 알게 된다.
    expect(screen.queryByLabelText('집합 핸들')).toBeNull();
    expect(screen.queryByText('만들기')).toBeNull();
    expect(screen.queryByText('집합 삭제')).toBeNull();
    expect(screen.queryByText('이름 바꾸기')).toBeNull();
    expect(screen.queryByLabelText('구성원 추가')).toBeNull();

    // 구성원 명단 라우트도 admin 전용이다 — 부르면 403 이 사유로 화면에 뜬다.
    fireEvent.click(screen.getByTestId('group-row-oncall'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.getHandleGroup).not.toHaveBeenCalled();
  });

  it('6. 설정에서 이름을 바꾸면 작성창 후보의 이름도 바뀐다 (스토어 갱신)', async () => {
    const api = mount({
      updateHandleGroup: vi.fn(async (_id: string, patch: { displayName: string }) =>
        grp('g1', 'oncall', patch.displayName, 1)),
    });
    await openGroup();

    fireEvent.click(screen.getByText('이름 바꾸기'));
    fireEvent.change(screen.getByLabelText('새 표시 이름'), { target: { value: 'Pager duty' } });
    fireEvent.click(screen.getByText('저장'));

    await waitFor(() => expect(api.updateHandleGroup).toHaveBeenCalledWith('g1', { displayName: 'Pager duty' }));

    // 설정 화면을 걷어내고 작성창만 새로 그린다 — 두 화면이 이어지는 경로가 스토어
    // 하나임을 이렇게만 증명할 수 있다(같은 트리에 두면 리렌더가 우연히 맞을 수 있다).
    cleanup();
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@onc' } });

    const option = screen.getAllByRole('option').find((o) => o.getAttribute('data-handle') === 'oncall');
    expect(option!.textContent).toContain('Pager duty');
    expect(option!.textContent).not.toContain('On-call');
  });

  it('명단을 못 받으면 사유가 보이고 상세는 열리지 않는다 — "없다"와 "못 읽었다"는 다르다', async () => {
    mount({ getHandleGroup: vi.fn(async () => { throw new Error('nope'); }) });

    fireEvent.click(screen.getByTestId('group-row-oncall'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('nope'));
    // 구성원 0 명으로 열리면 "명단이 비었다"로 읽힌다.
    expect(screen.queryByText('구성원 (0)')).toBeNull();
  });
});
