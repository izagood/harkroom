/**
 * 기억 목록의 **화면**(#139 4단계).
 *
 * 판정 자체(무엇이 묶이고 무엇이 걸러지나)는 `memoryList.test.ts` 가 잰다. 여기서 재는
 * 것은 그 결과가 실제로 화면에 서는가, 그리고 **접기가 무엇을 가리지 않는가** 다.
 *
 * ## 왜 이 화면을 다시 지었나
 *
 * 앞판은 서버가 준 목록을 그대로 전부 펼쳤다. 실측(2026-09-14, `@murmur` 81개)에서 그
 * 칸 하나가 1440px 화면 아홉 장 반이 되어, PAT·권한 설정이 그 아래로 밀려났다. 목록이
 * 해야 할 일 셋 — 훑고, 찾고, 지우고 — 이 셋 다 그 화면에서는 되지 않았다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import type { AgentDefaults, AgentView, PatView } from '@harkroom/shared';
import { MAX_MEMORY_ITEMS_PER_ACCOUNT } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

const agent = (handle: string): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false, role: 'member', assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [],
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  claudeLane: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null,
});

const mem = (slug: string, value: string, day = 3) => ({
  slug, value, updatedAt: new Date(Date.UTC(2026, 8, day)).toISOString(),
});

const fakeController = (memories: ReturnType<typeof mem>[]) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => [agent('rusalka')]),
    listPats: vi.fn(async (): Promise<PatView[]> => []),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    agentMemory: vi.fn(async () => memories),
    deleteAgentMemory: vi.fn(async (): Promise<void> => undefined),
    fetchAvatar: vi.fn(async (): Promise<Blob> => new Blob(['png'])),
  };
  setController(c as unknown as Controller);
  return c;
};

/** 이 파일의 축은 한국어 문구로 쓰여 있다 — 두 언어로 뜨는지는 `i18n.test.tsx` 가 잰다. */
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

const open = async () => {
  render(<AgentsSettings />);
  fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
};

describe('접힌 줄이 기본이다', () => {
  it('값은 접혀 있고, 누르면 그 자리에서 펼친다', async () => {
    fakeController([mem('mem/worktree-traps', '# 워크트리에서 데인 것\n훅이 avcs 라 느리다')]);
    await open();

    // 요약(첫 줄)은 접힌 채로도 보인다 — 무엇인지 알아야 펼칠지 고를 수 있다.
    expect(await screen.findByText('워크트리에서 데인 것')).toBeTruthy();
    // 본문은 아직 없다.
    expect(screen.queryByText(/훅이 avcs 라 느리다/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'mem/worktree-traps 펼치기' }));
    expect(screen.getByText(/훅이 avcs 라 느리다/)).toBeTruthy();
    // 펼치면 손잡이의 이름이 반대가 된다 — 같은 이름이면 지금 상태를 읽을 수 없다.
    expect(screen.getByRole('button', { name: 'mem/worktree-traps 접기' })).toBeTruthy();
  });

  /**
   * 하나만 열리는 방식이면 다음을 열 때마다 앞의 것이 닫혀 **견주기가 끊긴다.** 이 화면의
   * 일이 바로 견주며 지울 것을 고르는 것이라, 여럿이 함께 열려야 한다.
   */
  it('여럿을 함께 펼칠 수 있다', async () => {
    fakeController([mem('mem/a-one', '# 첫째\n알파'), mem('mem/b-two', '# 둘째\n베타')]);
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'mem/a-one 펼치기' }));
    fireEvent.click(screen.getByRole('button', { name: 'mem/b-two 펼치기' }));
    expect(screen.getByText(/알파/)).toBeTruthy();
    expect(screen.getByText(/베타/)).toBeTruthy();
  });

  /**
   * 한도에 닿았을 때 사람이 하는 일은 훑으며 지우는 것이다. 지우기를 펼친 뒤에만 보이게
   * 두면 그때마다 펼치게 되어 접은 값이 도로 사라진다.
   */
  it('접힌 줄에서도 바로 지울 수 있다', async () => {
    const c = fakeController([mem('mem/a-one', '# 첫째')]);
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'mem/a-one 기억 지우기' }));
    expect(c.deleteAgentMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('정말 지운다'));
    expect(c.deleteAgentMemory).toHaveBeenCalledWith('id-rusalka', 'mem/a-one');
  });
});

describe('core 는 목록에서 떨어져 위에 선다', () => {
  /**
   * `core` 는 **매 턴 통째로 프롬프트에 실린다** — 길이가 곧 비용이다. 목록의 한 줄로
   * 두면 화면이 그 차이를 말하지 않고, 맨 위에 오는 것도 이름순의 우연이 된다.
   */
  it('core 카드가 따로 서고 길이와 한도를 함께 말한다', async () => {
    fakeController([mem('core', '가'.repeat(4000)), mem('mem/a-one', '# 첫째')]);
    await open();

    const card = await screen.findByTestId('memory-core');
    expect(within(card).getByText('core')).toBeTruthy();
    expect(within(card).getByText('매 턴 실림')).toBeTruthy();
    expect(within(card).getByText('4,000 / 8,000자')).toBeTruthy();
    // 목록 쪽에는 core 줄이 없다 — 두 벌로 서면 같은 것이 둘로 보인다.
    expect(screen.queryByTestId('memory-row-core')).toBeNull();
  });

  it('core 가 없으면 카드도 없다 — 없는 것을 지어내지 않는다', async () => {
    fakeController([mem('mem/a-one', '# 첫째')]);
    await open();

    expect(await screen.findByTestId('memory-row-mem/a-one')).toBeTruthy();
    expect(screen.queryByTestId('memory-core')).toBeNull();
  });
});

describe('찾기와 묶기', () => {
  const many = [
    mem('mem/pr-1-x', '# PR 하나', 1),
    mem('mem/pr-2-x', '# PR 둘', 2),
    mem('mem/pr-3-x', '# PR 셋', 3),
    mem('mem/worktree-traps', '# 워크트리에서 데인 것', 4),
  ];

  it('같은 접두어가 셋 이상이면 한 줄로 접히고 개수를 말한다', async () => {
    fakeController(many);
    await open();

    const group = await screen.findByTestId('memory-group-mem/pr-');
    expect(within(group).getByText('3개')).toBeTruthy();
    // 접혀 있으므로 그 안의 줄은 아직 없다.
    expect(screen.queryByTestId('memory-row-mem/pr-1-x')).toBeNull();

    fireEvent.click(group);
    expect(screen.getByTestId('memory-row-mem/pr-1-x')).toBeTruthy();
  });

  it('검색은 본문도 본다 — 그리고 걸린 묶음은 펼쳐서 준다', async () => {
    fakeController(many);
    await open();

    fireEvent.change(await screen.findByLabelText('slug·본문에서 찾기'), { target: { value: 'PR 둘' } });
    // 셋 미만으로 줄었으므로 묶음이 아니라 낱줄로 선다.
    expect(screen.queryByTestId('memory-group-mem/pr-')).toBeNull();
    expect(screen.getByTestId('memory-row-mem/pr-2-x')).toBeTruthy();
    expect(screen.queryByTestId('memory-row-mem/worktree-traps')).toBeNull();
  });

  /** **"기억이 없다" 와 다르다** — 없는 것이 아니라 이 검색어에 걸리는 것이 없다. */
  it('아무것도 안 걸리면 "없다" 가 아니라 "찾는 기억이 없다" 다', async () => {
    fakeController(many);
    await open();

    fireEvent.change(await screen.findByLabelText('slug·본문에서 찾기'), { target: { value: 'zzz' } });
    expect(screen.getByText('찾는 기억이 없다')).toBeTruthy();
    expect(screen.queryByText('기억이 없다')).toBeNull();
  });

  it('기본은 수정순이고 이름순으로 바꿀 수 있다', async () => {
    fakeController([mem('mem/a-one', '# 첫째', 1), mem('mem/z-two', '# 둘째', 9)]);
    await open();

    const slugs = () => screen.getAllByText(/^mem\//).map((e) => e.textContent);
    expect(await screen.findByTestId('memory-row-mem/z-two')).toBeTruthy();
    expect(slugs()).toEqual(['mem/z-two', 'mem/a-one']);

    fireEvent.click(screen.getByRole('button', { name: '이름순' }));
    expect(slugs()).toEqual(['mem/a-one', 'mem/z-two']);
  });
});

describe('한도', () => {
  /**
   * 200개에 닿으면 새 기억이 **조용히 거절된다**(`services/memory.ts` 의 `too_many`).
   * 앞판 화면에는 몇 개인지조차 없어서, 사람은 막힌 뒤에야 그 사실을 알았다.
   */
  it('몇 개인지와 한도를 늘 띄운다', async () => {
    fakeController([mem('core', '값'), mem('mem/a-one', '# 첫째')]);
    await open();

    expect(await screen.findByTestId('memory-count'))
      .toHaveProperty('textContent', `2 / ${MAX_MEMORY_ITEMS_PER_ACCOUNT}`);
  });

  it('한도에 가까우면 경고색으로 바뀐다 — 차고 나서 알면 늦다', async () => {
    const lots = Array.from({ length: 190 }, (_, i) => mem(`mem/x${i}-y`, `# ${i}`));
    fakeController(lots);
    await open();

    const count = await screen.findByTestId('memory-count');
    expect(count.className).toContain('text-warning');
    expect(count.getAttribute('title')).toContain('한도에 가깝다');
  });

  it('여유가 있으면 경고색이 아니다', async () => {
    fakeController([mem('mem/a-one', '# 첫째')]);
    await open();

    expect((await screen.findByTestId('memory-count')).className).not.toContain('text-warning');
  });
});
