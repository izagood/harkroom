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
import type { MemoryAudit } from '../src/lib/memoryList';

const agent = (handle: string): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false, role: 'member', assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [],
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, deleted: false, runnerVersion: null,
  claudeLane: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null,
});

const mem = (slug: string, value: string, day = 3) => ({
  slug, value, updatedAt: new Date(Date.UTC(2026, 8, day)).toISOString(),
});

/** 보관된 기억(서버 097) — 사람 목록 API 는 이것도 함께 준다. */
const archived = (slug: string, value: string, day = 4) => ({
  ...mem(slug, value), archivedAt: new Date(Date.UTC(2026, 8, day)).toISOString(),
});

/** 정리 후보(#1186). 기본은 후보 없음 — 옛 시험들은 칩 없이 그린다. */
const emptyAudit = (): MemoryAudit => ({
  core: null, neverRead: [], stale: [], brokenLinks: [], similar: [], similarBody: [], undescribed: [],
  flagged: [], expiringJournal: [], truncated: false, items: { active: 0, limit: 200, archived: 0 },
});
let audit: MemoryAudit | null = null;
/** 되살리기에서 자리가 있는 수 — 그 뒤의 것은 `too_many`. */
let unarchiveRoom = Infinity;

const fakeController = (memories: (ReturnType<typeof mem> & { archivedAt?: string })[]) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => [agent('rusalka')]),
    listPats: vi.fn(async (): Promise<PatView[]> => []),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    agentMemory: vi.fn(async (_id: string) => memories),
    agentMemoryAudit: vi.fn(async () => audit),
    agentMemoryRevisions: vi.fn(async () => []),
    archiveAgentMemories: vi.fn(async (_id: string, slugs: string[]) => slugs.map((slug) => ({ slug, result: 'ok' }))),
    unarchiveAgentMemories: vi.fn(async (_id: string, slugs: string[]) => slugs.map((slug, i) => (
      { slug, result: i < unarchiveRoom ? 'ok' : 'too_many' }))),
    deleteAgentMemory: vi.fn(async (): Promise<void> => undefined),
    fetchAvatar: vi.fn(async (): Promise<Blob> => new Blob(['png'])),
  };
  setController(c as unknown as Controller);
  return c;
};

/** 이 파일의 축은 한국어 문구로 쓰여 있다 — 두 언어로 뜨는지는 `i18n.test.tsx` 가 잰다. */
beforeEach(() => {
  audit = null;
  unarchiveRoom = Infinity;
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

const open = async () => {
  render(<AgentsSettings />);
  fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
  fireEvent.click(await screen.findByTestId('agent-tab-memory'));
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
   * 줄의 기본 버튼은 **보관**이다(Memory 탭 결정 2 — 되살릴 수 있다). 되돌릴 수 없는 지우기는
   * 펼친 안쪽에만 있다.
   */
  it('접힌 줄에서는 보관하고, 지우기는 펼친 안쪽에만 있다', async () => {
    const c = fakeController([mem('mem/a-one', '# 첫째')]);
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'mem/a-one 보관' }));
    expect(c.archiveAgentMemories).toHaveBeenCalledWith('id-rusalka', ['mem/a-one']);

    expect(screen.queryByRole('button', { name: 'mem/a-one 기억 지우기' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'mem/a-one 펼치기' }));
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
    fakeController([mem('core', '가'.repeat(2000)), mem('mem/a-one', '# 첫째')]);
    await open();

    const card = await screen.findByTestId('memory-core');
    expect(within(card).getByText('core')).toBeTruthy();
    expect(within(card).getByText('매 턴 실림')).toBeTruthy();
    // 한도는 core 전용 3,000자다(서버가 강제한다) — 일반 기억의 8,000 이 아니다.
    expect(within(card).getByText('2,000 / 3,000자')).toBeTruthy();
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

  /**
   * 사람 목록 API 는 보관된 것도 함께 준다. 서버 상한은 보관을 빼고 세므로, 섞어 세면
   * `213 / 200` 처럼 있을 수 없는 숫자가 뜨고 사람은 무엇을 지워야 하는지 헤맨다.
   */
  it('숫자는 보관된 것을 빼고 센다 — 보관 수는 따로 말한다', async () => {
    fakeController([
      mem('core', '값'), mem('mem/a-one', '# 첫째'),
      archived('mem/old-one', '# 옛것 하나'), archived('mem/old-two', '# 옛것 둘'),
    ]);
    await open();

    const count = await screen.findByTestId('memory-count');
    expect(count.textContent).toBe(`2 / ${MAX_MEMORY_ITEMS_PER_ACCOUNT} · 보관 2`);
  });

  it('보관된 것이 아무리 많아도 한도 경고를 켜지 않는다', async () => {
    const lots = Array.from({ length: 190 }, (_, i) => archived(`mem/x${i}-y`, `# ${i}`));
    fakeController([mem('mem/a-one', '# 첫째'), ...lots]);
    await open();

    const count = await screen.findByTestId('memory-count');
    expect(count.className).not.toContain('text-warning');
    expect(count.textContent).toContain(`1 / ${MAX_MEMORY_ITEMS_PER_ACCOUNT}`);
  });

  it('여유가 있으면 경고색이 아니다', async () => {
    fakeController([mem('mem/a-one', '# 첫째')]);
    await open();

    expect((await screen.findByTestId('memory-count')).className).not.toContain('text-warning');
  });
});

describe('보관된 기억', () => {
  it('살아 있는 목록에 섞이지 않고 맨 아래 접힌 보관함에 선다', async () => {
    fakeController([mem('mem/a-one', '# 첫째'), archived('mem/old-one', '# 옛것 하나')]);
    await open();

    expect(await screen.findByTestId('memory-row-mem/a-one')).toBeTruthy();
    // 접혀 있다 — 보관한 줄은 아직 없다.
    expect(screen.queryByTestId('memory-row-mem/old-one')).toBeNull();

    const box = screen.getByTestId('memory-archived');
    expect(within(box).getByText('보관함')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: '보관한 기억 펼치기' }));
    const row = within(box).getByTestId('memory-row-mem/old-one');
    // 칸 이름이 이미 「보관함」이다 — 줄마다 「보관됨」을 되풀이하지 않는다(PR 1 nit 2).
    expect(within(row).queryByTestId('memory-archived-badge')).toBeNull();
    expect(within(row).getByRole('button', { name: 'mem/old-one 되살리기' })).toBeTruthy();
  });

  it('검색어가 보관함에만 걸리면 위 목록은 "결과 없음" 이 아니라 보관함에 있다고 말한다', async () => {
    fakeController([mem('mem/a-one', '# 첫째'), archived('mem/old-one', '# 옛것 하나')]);
    await open();

    fireEvent.change(await screen.findByLabelText('slug·본문에서 찾기'), { target: { value: '옛것' } });
    expect(screen.getByTestId('memory-no-match').textContent).toBe('쓰는 중에는 없음 · 보관함에 1');
  });

  it('core 밖이 모두 보관돼도 보관함을 찾을 수 있다', async () => {
    fakeController([mem('core', '# 코어'), archived('mem/old-one', '# 옛것 하나')]);
    await open();

    fireEvent.change(await screen.findByLabelText('slug·본문에서 찾기'), { target: { value: '옛것' } });
    expect(within(screen.getByTestId('memory-archived')).getByTestId('memory-row-mem/old-one')).toBeTruthy();
  });

  it('검색하면 보관함도 걸린 것만 연 채로 보인다', async () => {
    fakeController([
      mem('mem/a-one', '# 첫째'),
      archived('mem/old-one', '# 옛것 하나'), archived('mem/old-two', '# 다른 것'),
    ]);
    await open();

    fireEvent.change(await screen.findByLabelText('slug·본문에서 찾기'), { target: { value: '옛것' } });
    const box = screen.getByTestId('memory-archived');
    expect(within(box).getByTestId('memory-row-mem/old-one')).toBeTruthy();
    expect(within(box).queryByTestId('memory-row-mem/old-two')).toBeNull();
  });

  it('보관된 것이 없으면 보관함도 없다', async () => {
    fakeController([mem('mem/a-one', '# 첫째')]);
    await open();

    expect(await screen.findByTestId('memory-row-mem/a-one')).toBeTruthy();
    expect(screen.queryByTestId('memory-archived')).toBeNull();
    expect(screen.queryByTestId('memory-archived-count')).toBeNull();
  });
});

describe('정리할 것 (#1186 audit)', () => {
  it('칩 숫자는 기억 수다 — 짝 둘이 한 기억을 나눠도 한 번만 센다', async () => {
    audit = {
      ...emptyAudit(),
      similar: [['mem/a-one', 'mem/a-two']],
      similarBody: [{ pair: ['mem/a-one', 'mem/a-two'], similarity: 0.8 }, { pair: ['mem/a-one', 'mem/b-x'], similarity: 0.6 }],
      neverRead: ['mem/b-x'],
    };
    fakeController([mem('mem/a-one', '# 1'), mem('mem/a-two', '# 2'), mem('mem/b-x', '# 3'), mem('mem/c-y', '# 4')]);
    await open();

    expect((await screen.findByTestId('memory-chip-pairs')).textContent).toBe('비슷한 짝 3');
    expect(screen.getByTestId('memory-chip-neverRead').textContent).toBe('한 번도 안 쓰임 1');
    // 0 인 칩은 없다.
    expect(screen.queryByTestId('memory-chip-stale')).toBeNull();

    // 칩을 누르면 그 후보만 보인다.
    fireEvent.click(screen.getByTestId('memory-chip-neverRead'));
    expect(screen.getByTestId('memory-row-mem/b-x')).toBeTruthy();
    expect(screen.queryByTestId('memory-row-mem/c-y')).toBeNull();
    // 줄에도 이유가 붙는다.
    expect(within(screen.getByTestId('memory-row-mem/b-x')).getByTestId('memory-reason-neverRead')).toBeTruthy();
  });

  it('짝 목록이 잘렸으면 짝 칩은 "+" 를 붙인다', async () => {
    audit = { ...emptyAudit(), similar: [['mem/a-one', 'mem/a-two']], truncated: true };
    fakeController([mem('mem/a-one', '# 1'), mem('mem/a-two', '# 2')]);
    await open();

    expect((await screen.findByTestId('memory-chip-pairs')).textContent).toBe('비슷한 짝 2+');
  });

  it('보관된 기억을 가리키는 링크는 깨짐이 아니라 [되살리기] 다', async () => {
    audit = {
      ...emptyAudit(),
      brokenLinks: [{ slug: 'mem/a-one', target: 'mem/old-one' }, { slug: 'mem/a-two', target: 'mem/nowhere' }],
    };
    const c = fakeController([mem('mem/a-one', '# 1'), mem('mem/a-two', '# 2'), archived('mem/old-one', '# 옛')]);
    await open();

    // 진짜 없는 것만 깨진 링크로 센다.
    expect((await screen.findByTestId('memory-chip-brokenLinks')).textContent).toBe('깨진 링크 1');
    expect(within(screen.getByTestId('memory-row-mem/a-two')).getByTestId('memory-reason-brokenLinks')).toBeTruthy();
    expect(within(screen.getByTestId('memory-row-mem/a-one')).queryByTestId('memory-reason-brokenLinks')).toBeNull();

    fireEvent.click(within(screen.getByTestId('memory-row-mem/a-one')).getByTestId('memory-points-archived'));
    expect(c.unarchiveAgentMemories).toHaveBeenCalledWith('id-rusalka', ['mem/old-one']);
  });

  it('여러 개를 골라 한 번에 보관한다', async () => {
    const c = fakeController([mem('mem/a-one', '# 1'), mem('mem/b-two', '# 2'), mem('mem/c-three', '# 3')]);
    await open();

    fireEvent.click(await screen.findByLabelText('mem/a-one 고르기'));
    fireEvent.click(screen.getByLabelText('mem/c-three 고르기'));
    expect(screen.getByTestId('memory-picked-bar').textContent).toContain('2개 고름');
    fireEvent.click(screen.getByTestId('memory-archive-picked'));
    expect(c.archiveAgentMemories).toHaveBeenCalledWith('id-rusalka', ['mem/a-one', 'mem/c-three']);
    expect((await screen.findByTestId('memory-notice')).textContent).toBe('2개를 보관했습니다');
  });

  it('되살리기가 자리에 막히면 몇 개인지 말하고 그것은 고른 채로 둔다', async () => {
    unarchiveRoom = 1;
    const c = fakeController([
      mem('mem/a-one', '# 1'), archived('mem/old-one', '# 옛1'), archived('mem/old-two', '# 옛2'),
    ]);
    await open();

    fireEvent.click(within(await screen.findByTestId('memory-archived')).getByRole('button', { name: '보관한 기억 펼치기' }));
    fireEvent.click(screen.getByLabelText('mem/old-one 고르기'));
    fireEvent.click(screen.getByLabelText('mem/old-two 고르기'));
    fireEvent.click(screen.getByTestId('memory-unarchive-picked'));
    expect(c.unarchiveAgentMemories).toHaveBeenCalled();
    const notice = await screen.findByTestId('memory-notice');
    expect(notice.textContent).toContain('1개를 되살렸습니다');
    expect(notice.textContent).toContain(`1개는 자리가 없어 되살리지 못했습니다(쓰는 중 ${MAX_MEMORY_ITEMS_PER_ACCOUNT}/${MAX_MEMORY_ITEMS_PER_ACCOUNT})`);
    expect(screen.getByTestId('memory-picked-bar').textContent).toContain('1개 고름');
  });

  it('보관함이 300 을 넘게 되면 누르기 전에 밀려날 수를 말한다', async () => {
    const lots = Array.from({ length: 299 }, (_, i) => archived(`mem/z${i}q`, `# ${i}`));
    fakeController([mem('mem/a-one', '# 1'), mem('mem/b-two', '# 2'), ...lots]);
    await open();

    fireEvent.click(await screen.findByLabelText('mem/a-one 고르기'));
    expect(screen.queryByTestId('memory-archive-overflow')).toBeNull();
    fireEvent.click(screen.getByLabelText('mem/b-two 고르기'));
    expect(screen.getByTestId('memory-archive-overflow').textContent).toContain('가장 오래 보관한 1개');
  });

  it('audit 를 못 받아도 목록은 뜬다(옛 서버)', async () => {
    const c = fakeController([mem('mem/a-one', '# 1')]);
    c.agentMemoryAudit.mockRejectedValue(new Error('404'));
    await open();

    expect(await screen.findByTestId('memory-row-mem/a-one')).toBeTruthy();
    expect(screen.queryByTestId('memory-chips')).toBeNull();
  });

  it('보관 뒤 다시 읽는 동안 목록·칩을 비우지 않는다 — 눌러 둔 칩 필터가 튀지 않는다(n1)', async () => {
    audit = { ...emptyAudit(), neverRead: ['mem/b-x', 'mem/b-y'] };
    const c = fakeController([mem('mem/a-one', '# 1'), mem('mem/b-x', '# 2'), mem('mem/b-y', '# 3')]);
    await open();

    fireEvent.click(await screen.findByTestId('memory-chip-neverRead'));
    let release!: () => void;
    c.agentMemory.mockImplementationOnce(() => new Promise((r) => { release = () => r([]); }) as never);
    fireEvent.click(screen.getByRole('button', { name: 'mem/b-x 보관' }));
    await screen.findByTestId('memory-notice');
    // 새 목록이 아직 안 왔다 — 이전 목록과 칩이 그대로이고 필터도 그대로다.
    expect(screen.getByTestId('memory-chip-neverRead').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('memory-row-mem/b-y')).toBeTruthy();
    expect(screen.queryByTestId('memory-row-mem/a-one')).toBeNull();
    expect(screen.queryByText('불러오는 중…')).toBeNull();
    release();
  });

  it('한 줄 보관이 300 을 넘기면 이유를 버튼 옆 글로 말한다(n2)', async () => {
    const lots = Array.from({ length: 300 }, (_, i) => archived(`mem/z${i}q`, `# ${i}`));
    const c = fakeController([mem('mem/a-one', '# 1'), ...lots]);
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'mem/a-one 보관' }));
    expect(c.archiveAgentMemories).not.toHaveBeenCalled();
    expect(screen.getByTestId('memory-row-overflow').textContent).toBe('오래된 1개가 밀려납니다');
    fireEvent.click(screen.getByText('그래도 보관'));
    expect(c.archiveAgentMemories).toHaveBeenCalledWith('id-rusalka', ['mem/a-one']);
  });

  it('고른 것이 검색에 가려지면 막대가 그 수를 말한다(n4)', async () => {
    fakeController([mem('mem/a-one', '# 첫째'), mem('mem/b-two', '# 둘째')]);
    await open();

    fireEvent.click(await screen.findByLabelText('mem/a-one 고르기'));
    expect(screen.queryByTestId('memory-picked-hidden')).toBeNull();
    fireEvent.change(screen.getByLabelText('slug·본문에서 찾기'), { target: { value: '둘째' } });
    expect(screen.getByTestId('memory-picked-hidden').textContent).toBe('필터에 안 걸린 1개 포함');
  });

  it('보관이 도는 중에 다른 에이전트로 바꾸면 늦은 결과가 그 칸을 덮지 않는다(security n1)', async () => {
    const c = fakeController([]);
    c.listAgents.mockResolvedValue([agent('rusalka'), agent('vodnik')]);
    c.agentMemory.mockImplementation(async (id: string) => (
      id === 'id-rusalka' ? [mem('mem/a-one', '# 루살카')] : [mem('mem/v-one', '# 보드닉')]) as never);
    let release!: () => void;
    c.archiveAgentMemories.mockImplementationOnce(() => new Promise((r) => {
      release = () => r([{ slug: 'mem/a-one', result: 'ok' }]);
    }) as never);
    await open();

    fireEvent.click(await screen.findByRole('button', { name: 'mem/a-one 보관' }));
    fireEvent.click(screen.getByTestId('agent-back'));
    fireEvent.click(await screen.findByTestId('agent-card-vodnik'));
    fireEvent.click(await screen.findByTestId('agent-tab-memory'));
    expect(await screen.findByTestId('memory-row-mem/v-one')).toBeTruthy();

    release();
    await new Promise((r) => setTimeout(r, 0));
    // 루살카를 다시 읽지 않고, 보드닉 칸에 루살카의 줄·알림이 서지 않는다.
    expect(c.agentMemory.mock.calls.filter(([id]) => id === 'id-rusalka')).toHaveLength(1);
    expect(screen.getByTestId('memory-row-mem/v-one')).toBeTruthy();
    expect(screen.queryByTestId('memory-row-mem/a-one')).toBeNull();
    expect(screen.queryByTestId('memory-notice')).toBeNull();
  });
});

