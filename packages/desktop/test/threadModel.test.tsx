// 스레드 × 에이전트 모델 지정(서버 079, jaebin 승인 결정 1~13) — 데스크톱 화면 회귀선.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentPickableModel, ThreadAgentModelView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { ThreadModelCollapsed, ThreadModelRow, threadAgentIds } from '../src/components/ThreadModelRow';
import { AgentPickableSection } from '../src/components/settings/AgentPickableSection';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { formatModelValue, isModelShortcut, picksToSend } from '../src/lib/threadModels';

const A1 = '00000000-0000-4000-8000-0000000000a1';
const row = (over: Partial<ThreadAgentModelView> = {}): ThreadAgentModelView => ({
  threadRootId: 'r1', agentId: A1, harness: 'claude-code', model: 'opus', effort: 'xhigh',
  setBy: 'u1', setAt: '2026-10-01T00:00:00.000Z', stale: false, setByKind: 'human', currentHarness: 'claude-code', ...over,
});

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

let api: ReturnType<typeof fakeApi>;
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), [A1]: acc(A1, 'fizz', 'agent'), u2: acc('u2', 'rusalka'), a2: acc('a2', 'lead', 'agent') },
  });
  api = fakeApi({
    agentModelOptions: vi.fn(async () => ({
      harness: 'claude-code' as const, model: 'sonnet', effort: 'medium',
      models: [{ id: 'opus', efforts: ['low', 'high', 'xhigh'] }, { id: 'sonnet', efforts: ['low', 'high'] }],
    })),
  });
  setController(new Controller(api));
});
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  setController(null as unknown as Controller);
});

describe('lib/threadModels', () => {
  it('칩 값은 빈 축을 적지 않고, 둘 다 비면 기본(null)이다', () => {
    expect(formatModelValue({ model: 'opus', effort: null })).toBe('opus');
    expect(formatModelValue({ model: 'opus', effort: 'xhigh' })).toBe('opus · xhigh');
    expect(formatModelValue({ model: null, effort: null })).toBeNull();
  });
  it('작성창의 `기본` 은 보내지 않는다 — 보내면 스레드 지정을 푼다', () => {
    expect(picksToSend({ a: { model: null, effort: null }, b: { model: 'opus', effort: null } }))
      .toEqual([{ agentId: 'b', model: 'opus', effort: null }]);
  });
  it('⌘⇧M 만 받는다 — ⌘M(최소화)은 아니다', () => {
    const k = (o: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', code: '', ...o });
    expect(isModelShortcut(k({ metaKey: true, shiftKey: true, key: 'M', code: 'KeyM' }))).toBe(true);
    expect(isModelShortcut(k({ metaKey: true, key: 'm', code: 'KeyM' }))).toBe(false);
  });
  it('스레드에 나온 에이전트: 작성자·본문이 부른 에이전트·지정이 있는 에이전트', () => {
    const isAgent = (id: string) => id === A1 || id === 'a9';
    const ids = threadAgentIds([
      { authorId: 'u1', body: `<@${A1}> 봐 줘` } as never,
    ], isAgent, ['a9']);
    expect(ids).toEqual([A1, 'a9']);
  });
});

describe('작성창 "부를 상대" 모델 칩 (결정 1·C·12·13)', () => {
  it('에이전트에만 칩이 서고, 고른 모델이 그 글과 함께 간 뒤 기본으로 돌아간다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@fizz @rusalka 고도화해 줘');
    expect(screen.getByTestId('model-chip-fizz').textContent).toContain('기본');
    expect(screen.queryByTestId('model-chip-rusalka')).toBeNull();
    // 힌트는 자동완성으로 **부른 직후에만** 선다(designer 검토 4) — 손으로 친 글에는 없다.
    expect(screen.queryByTestId('model-chip-hint')).toBeNull();

    fireEvent.click(screen.getByTestId('model-chip-fizz'));
    await waitFor(() => expect(screen.getByTestId('model-agent-default').textContent).toContain('sonnet · medium'));
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'opus' } });
    fireEvent.change(screen.getByTestId('effort-select'), { target: { value: 'xhigh' } });
    fireEvent.click(screen.getByTestId('model-apply'));
    await waitFor(() => expect(screen.getByTestId('model-chip-fizz').textContent).toContain('opus · xhigh'));

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]![2]).toEqual([{ agentId: A1, model: 'opus', effort: 'xhigh' }]);
    // 결정 12: 보낸 뒤 채널 작성창의 칩은 기본이다.
    typeInto('@fizz 다음 글');
    expect(screen.getByTestId('model-chip-fizz').textContent).toContain('기본');
  });

  it('고르지 않으면 셋째 인자를 넘기지 않는다 — 부르는 쪽 모양이 지금과 같다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@fizz 안녕');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]).toHaveLength(2);
  });

  it('자동완성으로 부른 직후에만 칩을 강조하고 ⌘⇧M 힌트를 세우고, 다음 글자에 거둔다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fi');
    fireEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-handle') === 'fizz')!);
    expect(screen.getByTestId('model-chip-hint')).toBeTruthy();
    expect(screen.getByTestId('model-chip-fizz').className).toContain('ring-2');
    typeInto('@fizz 고도화');
    expect(screen.queryByTestId('model-chip-hint')).toBeNull();
  });

  it('스레드에서 이어받은 값은 옅게·`스레드` 꼬리로 서고, [스레드 지정 풀기]는 보낼 때 실제로 푼다', async () => {
    useAppStore.getState().set({ threadAgentModels: { r1: [row()] } });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="thread:r1" />);
    typeInto('@fizz 이어서');
    const chip = screen.getByTestId('model-chip-fizz');
    expect(chip.getAttribute('data-inherited')).toBe('true');
    expect(chip.textContent).toContain('스레드 지정');
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId('model-reset').textContent).toBe('스레드 지정 풀기'));
    fireEvent.click(screen.getByTestId('model-reset'));
    await waitFor(() => expect(screen.getByTestId('model-chip-fizz').textContent).toContain('기본'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0]![2]).toEqual([{ agentId: A1, model: null, effort: null }]);
  });

  it('⌘⇧M 은 마지막으로 부른 에이전트의 고르개를 연다', async () => {
    render(<Composer onSend={vi.fn()} />);
    const box = typeInto('@fizz 봐 줘');
    fireEvent.keyDown(box, { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('model-picker')).toBeTruthy());
  });

  it('스레드 작성창은 스레드 지정을 이어받아 보이고, 자동완성에도 옅게 적는다(결정 13)', () => {
    useAppStore.getState().set({ threadAgentModels: { r1: [row()] } });
    render(<Composer onSend={vi.fn()} scopeKey="thread:r1" />);
    typeInto('@fi');
    expect(screen.getByTestId('mention-thread-model').textContent).toContain('opus · xhigh');
    typeInto('@fizz 이어서');
    expect(screen.getByTestId('model-chip-fizz').textContent).toContain('opus · xhigh');
  });
});

describe('스레드 머리 모델 줄 (결정 1·A·9·10)', () => {
  const thread = [{ id: 'r1', authorId: 'u1', body: `<@${A1}> 해 줘`, threadRootId: null } as never];

  it('지정이 없으면 줄 대신 `모델 · 모두 기본` 칩 하나로 접히고, 누르면 열린다', () => {
    useAppStore.getState().set({ threadAgentModels: { r1: [] } });
    const { rerender } = render(<>
      <ThreadModelCollapsed rootId="r1" expanded={false} onToggle={() => {}} />
      <ThreadModelRow channelId="c1" rootId="r1" thread={thread} expanded={false} />
    </>);
    expect(screen.getByTestId('thread-models-collapsed').textContent).toBe('모델 · 모두 기본');
    expect(screen.queryByTestId('thread-models')).toBeNull();
    rerender(<ThreadModelRow channelId="c1" rootId="r1" thread={thread} expanded />);
    expect(screen.getByTestId('model-chip-fizz').textContent).toContain('기본');
  });

  it('지정이 있으면 줄이 서고, 적용하면 그 스레드의 지정을 바꾼다(다음 턴부터)', async () => {
    useAppStore.getState().set({ threadAgentModels: { r1: [row({ effort: null })] } });
    render(<ThreadModelRow channelId="c1" rootId="r1" thread={thread} expanded={false} />);
    expect(screen.getByTestId('model-chip-fizz').textContent).toContain('opus');
    fireEvent.click(screen.getByTestId('model-chip-fizz'));
    await waitFor(() => expect(screen.getByTestId('model-picker').textContent).toContain('다음 턴부터'));
    fireEvent.click(screen.getByTestId('model-reset'));
    await waitFor(() => expect(api.setThreadAgentModel).toHaveBeenCalledWith('c1', 'r1', A1, null, null));
  });

  it('에이전트가 정한 지정은 꼬리가 `@lead 지정` 이다(087 결정 7) — 사람 지정은 `스레드 지정`', () => {
    useAppStore.getState().set({ threadAgentModels: { r1: [row({ setBy: 'a2', setByKind: 'agent' })] } });
    const { rerender } = render(<ThreadModelRow channelId="c1" rootId="r1" thread={thread} expanded={false} />);
    expect(screen.getByTestId('model-chip-agent-set').textContent).toBe('@lead 지정');
    // 정한 계정을 모르면 사람 지정으로 떨어뜨리지 않는다.
    useAppStore.getState().set({ threadAgentModels: { r1: [row({ setBy: null, setByKind: 'agent' })] } });
    rerender(<ThreadModelRow channelId="c1" rootId="r1" thread={thread} expanded={false} />);
    expect(screen.getByTestId('model-chip-agent-set').textContent).toBe('에이전트 지정');
    useAppStore.getState().set({ threadAgentModels: { r1: [row()] } });
    rerender(<ThreadModelRow channelId="c1" rootId="r1" thread={thread} expanded={false} />);
    expect(screen.queryByTestId('model-chip-agent-set')).toBeNull();
    expect(screen.getByTestId('model-chip-fizz').textContent).toContain('스레드 지정');
  });

  it('하네스가 바뀐 지정은 취소선과 안내로 남는다 — 지우지 않는다', () => {
    useAppStore.getState().set({ threadAgentModels: { r1: [row({ stale: true, currentHarness: 'codex' })] } });
    render(<ThreadModelRow channelId="c1" rootId="r1" thread={thread} expanded={false} />);
    expect(screen.getByTestId('model-chip-fizz').getAttribute('data-stale')).toBe('true');
    // 빨강이 아니라 경고 색이고, 무엇으로 바뀌었는지와 [다시 고르기]가 있다(designer 검토 3).
    const note = screen.getByTestId('thread-models-stale');
    expect(note.className).toContain('text-warning');
    expect(note.className).not.toContain('danger');
    expect(note.textContent).toContain('codex');
    expect(screen.getByTestId('model-trigger-fizz').textContent).toBe('다시 고르기');
  });
});

describe('설정 › 에이전트: 다른 에이전트가 고를 수 있는 모델 (087 결정 3·9·11)', () => {
  const agent = { id: A1, handle: 'fizz', ownerAccountId: 'u1' } as never;
  const withOptions = (pickable: Array<{ model: string; efforts: string[] }>) => {
    vi.mocked(api.agentModelOptions).mockImplementation(async () => ({
      harness: 'claude-code' as const, model: 'sonnet', effort: 'medium', pickable,
      models: [{ id: 'opus', efforts: ['low', 'high', 'xhigh'] }, { id: 'sonnet', efforts: ['low', 'high'] }],
    }));
  };

  it('줄은 (모델·effort 묶음)이고, 서버 jsonb 와 같은 모양으로 저장한다', async () => {
    withOptions([{ model: 'opus', efforts: ['high'] }]);
    render(<AgentPickableSection agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('pickable-row-opus')).toBeTruthy());
    // 하네스가 밝힌 effort 만 고를 칸으로 선다.
    expect(screen.getByLabelText('opus 에 effort xhigh 허용')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('opus 에 effort low 허용'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByTestId('pickable-add'));
    // 새 줄은 effort 없이 시작한다(비싼 effort 는 손으로 켠다).
    expect(screen.getByTestId('pickable-row-sonnet').textContent).toContain('effort 는 못 고른다');
    fireEvent.click(screen.getByTestId('pickable-save'));
    // 하네스 순서(낮은 것부터)를 지킨다 — 누른 순서가 아니다.
    await waitFor(() => expect(api.setAgentPickableModels).toHaveBeenCalledWith(
      A1, [{ model: 'opus', efforts: ['low', 'high'] }, { model: 'sonnet', efforts: [] }], false));
  });

  it('좁힌 뒤 목록 밖 에이전트 지정이 남으면 풀지 묻고, [풀기]는 clearOutside 로 다시 저장한다', async () => {
    withOptions([{ model: 'opus', efforts: ['high'] }, { model: 'sonnet', efforts: [] }]);
    vi.mocked(api.setAgentPickableModels)
      .mockImplementationOnce(async (_id: string, models: AgentPickableModel[]) => ({ models, outside: 2, cleared: 0 }))
      .mockImplementationOnce(async (_id: string, models: AgentPickableModel[]) => ({ models, outside: 0, cleared: 2 }));
    render(<AgentPickableSection agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('pickable-row-sonnet')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('sonnet 빼기'));
    fireEvent.click(screen.getByTestId('pickable-save'));
    const ask = await screen.findByTestId('pickable-outside');
    expect(ask.textContent).toContain('2곳');
    expect(ask.textContent).toContain('사람이 정한 지정은 건드리지 않는다');
    fireEvent.click(screen.getByTestId('pickable-clear'));
    await waitFor(() => expect(api.setAgentPickableModels).toHaveBeenLastCalledWith(A1, [{ model: 'opus', efforts: ['high'] }], true));
    expect((await screen.findByTestId('pickable-cleared')).textContent).toContain('2곳');
    expect(screen.queryByTestId('pickable-outside')).toBeNull();
  });

  it('[그대로 둔다]는 아무것도 보내지 않고 물음만 닫는다', async () => {
    withOptions([{ model: 'opus', efforts: [] }]);
    vi.mocked(api.setAgentPickableModels).mockImplementationOnce(async (_id: string, models: AgentPickableModel[]) => ({ models, outside: 1, cleared: 0 }));
    render(<AgentPickableSection agent={agent} />);
    await waitFor(() => expect(screen.getByTestId('pickable-row-opus')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('opus 빼기'));
    fireEvent.click(screen.getByTestId('pickable-save'));
    fireEvent.click(await screen.findByTestId('pickable-keep'));
    expect(screen.queryByTestId('pickable-outside')).toBeNull();
    expect(api.setAgentPickableModels).toHaveBeenCalledTimes(1);
  });

  it('못 읽으면 빈 목록으로 그리지 않는다 — 저장 단추도 없다', async () => {
    vi.mocked(api.agentModelOptions).mockImplementation(async () => { throw new Error('offline'); });
    render(<AgentPickableSection agent={agent} />);
    expect((await screen.findByRole('alert')).textContent).toContain('불러오지 못했다');
    expect(screen.queryByTestId('pickable-save')).toBeNull();
  });
});
