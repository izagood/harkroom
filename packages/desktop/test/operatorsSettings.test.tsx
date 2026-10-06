/**
 * 설정 › Operators — 스펙 2026-09-20 §3(등록)·§2 책임표.
 *
 * 앱이 러너를 띄우지 않게 된 뒤로 사람이 앱에서 하는 일은 둘이다: **오퍼레이터를 등록**
 * (1회용 코드를 받아 그 머신에서 `harkroom-operator register` 에 넣는다)하고, 등록된
 * 것을 **본다·폐기한다**. 여기서 재는 것은 그 두 흐름이 컨트롤러의 표면에 닿는가와,
 * 코드가 화면에 **한 번만** 보인다는 사실을 화면이 말하는가다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { OperatorView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { OperatorsSettings } from '../src/components/settings/OperatorsSettings';
import { acc } from './helpers/fakeApi';
import { usePrefsStore } from '../src/state/prefsStore';

beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

const op = (id: string, name: string, extra: Partial<OperatorView> = {}): OperatorView => ({
  id, name, ownerAccountId: 'u1', createdAt: '2026-09-21T00:00:00Z', lastSeenAt: null, revokedAt: null,
  online: false, version: null, ...extra,
});

function fakeController(operators: OperatorView[] = []) {
  const c = {
    operators: vi.fn(async () => operators),
    api: { baseUrl: 'https://example.com' },
    operatorCapabilities: vi.fn(async (id: string) => (id === 'op-1'
      ? { agentIds: ['a-1', 'a-2'], harnesses: { 'claude-code': { installed: true, loggedIn: true }, codex: { installed: false, loggedIn: false } } }
      : Promise.reject(new Error('offline')))),
    operatorRegisterCode: vi.fn(async () => ({ code: 'hkreg_abc', expiresAt: '2026-09-21T00:05:00Z' })),
    revokeOperator: vi.fn(async () => undefined),
    renameOperator: vi.fn(async (id: string, label: string | null) => {
      const found = operators.find((o) => o.id === id)!;
      return { ...found, label };
    }),
  };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  useAppStore.getState().reset();
  // `member` 도 기본으로 `operator.register` 를 갖는다(스펙 §7 결정 2) — 관리자가 아니어도 이 화면은 열린다.
  useAppStore.getState().set({ me: acc('u1', 'me') });
});
afterEach(() => cleanup());

describe('OperatorsSettings', () => {
  it('등록된 오퍼레이터를 이름·연결 상태와 함께 나열한다', async () => {
    fakeController([op('op-1', 'jaebin-mbp', { online: true }), op('op-2', 'gpu-box')]);
    render(<OperatorsSettings />);
    await screen.findByText('jaebin-mbp');
    expect(screen.getByText('gpu-box')).toBeTruthy();
    expect(screen.getByTestId('operator-online-op-1').textContent).toContain('연결됨');
    expect(screen.getByTestId('operator-online-op-2').textContent).toContain('끊김');
  });

  it('등록 코드를 발급하면 코드와 넣을 명령이 보이고, 한 번만 보인다고 말한다', async () => {
    const c = fakeController();
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '등록 코드 발급' }));
    await waitFor(() => {
      expect(c.operatorRegisterCode).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText(/hkreg_abc/).length).toBeGreaterThan(0);
    });
    // 코드를 어디에 넣는지 — 사람이 다음에 할 일이 화면에 있어야 한다.
    expect(screen.getByTestId('operator-register-command').textContent).toContain('harkroom-operator register');
    expect(screen.getByTestId('operator-register-command').textContent).toContain('hkreg_abc');
    expect(screen.getByText(/지금만 보인다/)).toBeTruthy();
  });

  /**
   * **삭제는 한 번 묻고 간다**(UX ④c — 폐기·빼기·Remove 를 "삭제" 하나로). 누르자마자 지우지
   * 않는다: 확인 창이 서고, 취소하면 아무 일도 없고, 확인해야 컨트롤러에 닿는다.
   */
  it('삭제는 확인을 거쳐 컨트롤러에 닿고 목록을 다시 읽는다', async () => {
    const c = fakeController([op('op-1', 'old-box')]);
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'old-box 삭제' }));
    expect(c.revokeOperator).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    expect(screen.queryByTestId('confirm-ok')).toBeNull();
    expect(c.revokeOperator).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'old-box 삭제' }));
    fireEvent.click(screen.getByTestId('confirm-ok'));
    await waitFor(() => {
      expect(c.revokeOperator).toHaveBeenCalledWith('op-1');
      expect(c.operators).toHaveBeenCalledTimes(2);
    });
  });

  it('등록 능력이 없는 사람에게는 등록 버튼이 없다 — 목록은 본다', async () => {
    useAppStore.getState().set({ me: acc('u2', 'guest', 'human', false, { role: 'guest', capabilities: [] }) });
    fakeController([op('op-1', 'someone')]);
    render(<OperatorsSettings />);
    await screen.findByText('someone');
    expect(screen.queryByRole('button', { name: '등록 코드 발급' })).toBeNull();
  });
});

describe('오퍼레이터 능력(스펙 §3)', () => {
  it('붙어 있는 오퍼레이터는 로컬 설정의 에이전트 수와 하네스를 보이고, 끊긴 것은 능력 줄이 없다', async () => {
    fakeController([op('op-1', 'jaebin-mbp', { online: true }), op('op-2', 'gpu-box')]);
    render(<OperatorsSettings />);
    const caps = await screen.findByTestId('operator-caps-op-1');
    expect(caps.textContent).toContain('에이전트 2개');
    expect(caps.textContent).toContain('claude-code: 설치·로그인됨');
    expect(caps.textContent).toContain('codex: 없음');
    expect(screen.queryByTestId('operator-caps-op-2')).toBeNull();
  });
});

describe('이 머신 등록은 이 페이지에 없다 (UX ⑥b-2)', () => {
  afterEach(() => { delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__; });
  /** 이 머신 등록은 설정 › 이 기기 › 이 머신의 오퍼레이터로 옮겼다 — 여기엔 다른 머신의 코드 발급만. */
  it('Tauri 표면이 있어도 이 머신 등록 버튼은 없고, 그 자리를 안내한다', async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(), metadata: { currentWindow: { label: 'main' } } };
    fakeController();
    render(<OperatorsSettings />);
    await screen.findByText('등록 코드 발급');
    expect(screen.queryByText('이 머신을 등록')).toBeNull();
    expect(screen.getByText(/이 기기 › 이 머신의 오퍼레이터/)).toBeTruthy();
  });
  it('새 자리로 가는 버튼이 있다(onOpenSection 을 받으면)', async () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: vi.fn(), metadata: { currentWindow: { label: 'main' } } };
    fakeController();
    const onOpenSection = vi.fn();
    render(<OperatorsSettings onOpenSection={onOpenSection} />);
    fireEvent.click(await screen.findByTestId('operators-open-this-operator'));
    expect(onOpenSection).toHaveBeenCalledWith('this-operator');
  });
});

/**
 * 이름 바꾸기(스레드 e12e6780, designer 시안). 이름 옆 연필(또는 이름 글자) → 그 자리 입력칸.
 * Enter·칸 밖 = 저장, Esc = 취소, 비우면 호스트명으로, 바꾼 줄만 둘째 줄에 호스트명, 같은 이름은 경고만.
 */
describe('오퍼레이터 이름 바꾸기', () => {
  it('연필을 누르고 Enter 로 저장하면 새 이름이 서고 둘째 줄에 원래 호스트명이 붙는다', async () => {
    const c = fakeController([op('op-1', 'NO-202509-002.local', { online: true })]);
    render(<OperatorsSettings />);
    expect(screen.queryByTestId('operator-hostname-op-1')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'NO-202509-002.local 이름 바꾸기' }));
    const input = screen.getByTestId('operator-name-input-op-1') as HTMLInputElement;
    expect(input.value).toBe('NO-202509-002.local');
    // 편집 중에는 Delete 대신 Cancel·Save 가 선다.
    expect(screen.queryByRole('button', { name: 'NO-202509-002.local 삭제' })).toBeNull();
    fireEvent.change(input, { target: { value: '  회사 맥북 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(c.renameOperator).toHaveBeenCalledWith('op-1', '회사 맥북'));
    expect((await screen.findByTestId('operator-name-op-1')).textContent).toBe('회사 맥북');
    expect(screen.getByTestId('operator-hostname-op-1').textContent).toContain('NO-202509-002.local');
    // 연결 상태는 목록을 읽은 때의 값을 지킨다(응답의 online 으로 덮지 않는다).
    expect(screen.getByTestId('operator-online-op-1').textContent).toContain('연결됨');
    // 지우기 버튼은 어느 기계인지 틀리지 않게 호스트명까지 읽힌다.
    expect(screen.getByRole('button', { name: '회사 맥북 (NO-202509-002.local) 삭제' })).toBeTruthy();
  });

  it('Esc 는 요청 없이 닫고, 바뀐 것 없이 칸 밖을 눌러도 요청하지 않는다', async () => {
    const c = fakeController([op('op-1', 'box')]);
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByTestId('operator-name-op-1'));
    const input = screen.getByTestId('operator-name-input-op-1');
    fireEvent.change(input, { target: { value: '다른 이름' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('operator-name-input-op-1')).toBeNull();
    fireEvent.click(screen.getByTestId('operator-name-op-1'));
    fireEvent.blur(screen.getByTestId('operator-name-input-op-1'));
    expect(c.renameOperator).not.toHaveBeenCalled();
    expect(screen.queryByTestId('operator-name-input-op-1')).toBeNull();
  });

  it('바꾼 줄은 「호스트명으로」로 되돌리고, 비우고 저장해도 null 로 간다', async () => {
    const c = fakeController([op('op-1', 'vm.local', { label: 'work VM' }), op('op-2', 'other', { label: 'x' })]);
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'work VM 이름 바꾸기' }));
    fireEvent.click(screen.getByTestId('operator-use-hostname-op-1'));
    await waitFor(() => expect(c.renameOperator).toHaveBeenCalledWith('op-1', null));
    expect((await screen.findByTestId('operator-name-op-1')).textContent).toBe('vm.local');
    expect(screen.queryByTestId('operator-hostname-op-1')).toBeNull();

    fireEvent.click(screen.getByTestId('operator-name-op-2'));
    const input = screen.getByTestId('operator-name-input-op-2');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(c.renameOperator).toHaveBeenCalledWith('op-2', null));
  });

  it('같은 이름은 경고만 하고 저장은 된다', async () => {
    const c = fakeController([op('op-1', 'a', { label: '맥북' }), op('op-2', 'b')]);
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByTestId('operator-name-op-2'));
    const input = screen.getByTestId('operator-name-input-op-2');
    fireEvent.change(input, { target: { value: '맥북' } });
    expect(screen.getByTestId('operator-name-dup-op-2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(c.renameOperator).toHaveBeenCalledWith('op-2', '맥북'));
  });

  it('보이지 않는 글자·탭·특수 공백은 서버와 같은 정리를 거쳐 보낸다 — 정리하면 같은 이름이면 요청하지 않는다', async () => {
    const c = fakeController([op('op-1', 'box', { label: '맥북' })]);
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByTestId('operator-name-op-1'));
    const input = screen.getByTestId('operator-name-input-op-1');
    fireEvent.change(input, { target: { value: '맥\u200B북 ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByTestId('operator-name-input-op-1')).toBeNull();
    expect(c.renameOperator).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('operator-name-op-1'));
    fireEvent.change(screen.getByTestId('operator-name-input-op-1'), { target: { value: '회사\t\u00A0맥북\u202E' } });
    fireEvent.keyDown(screen.getByTestId('operator-name-input-op-1'), { key: 'Enter' });
    await waitFor(() => expect(c.renameOperator).toHaveBeenCalledWith('op-1', '회사 맥북'));
  });

  it('저장 전에 정리가 안 된 옛 이름도 보이지 않는 글자 없이 그린다', async () => {
    fakeController([op('op-1', 'box', { label: '\u202E맥북\u200B' })]);
    render(<OperatorsSettings />);
    expect((await screen.findByTestId('operator-name-op-1')).textContent).toBe('맥북');
  });

  it('키보드는 연필에서만 멈춘다 — 이름 글자 버튼은 Tab 순서에서 빠진다', async () => {
    fakeController([op('op-1', 'box')]);
    render(<OperatorsSettings />);
    expect((await screen.findByTestId('operator-name-op-1')).getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('button', { name: 'box 이름 바꾸기' }).getAttribute('tabindex')).toBeNull();
  });

  it('이름을 바꾼 줄을 지울 때 확인창 제목에 호스트명이 함께 선다 — 바꾸지 않은 줄은 호스트명 하나', async () => {
    fakeController([op('op-1', 'jaebin-mbp', { label: '작업용 맥북' }), op('op-2', 'udc-vm')]);
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '작업용 맥북 (jaebin-mbp) 삭제' }));
    expect(screen.getByText("'작업용 맥북 (jaebin-mbp)' 오퍼레이터를 삭제할까?")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: 'udc-vm 삭제' }));
    expect(screen.getByText("'udc-vm' 오퍼레이터를 삭제할까?")).toBeTruthy();
  });

  it('능력 줄은 항목 단위로만 접힌다', async () => {
    fakeController([op('op-1', 'box', { online: true })]);
    render(<OperatorsSettings />);
    const caps = await screen.findByTestId('operator-caps-op-1');
    const items = Array.from(caps.children);
    expect(items.length).toBe(3); // 에이전트 수 + 하네스 둘
    for (const el of items) expect(el.className).toContain('whitespace-nowrap');
  });

  it('저장에 실패하면 입력을 그대로 두고 빨간 줄로 알린다', async () => {
    const c = fakeController([op('op-1', 'box')]);
    c.renameOperator.mockRejectedValueOnce(new Error('boom'));
    render(<OperatorsSettings />);
    fireEvent.click(await screen.findByTestId('operator-name-op-1'));
    const input = screen.getByTestId('operator-name-input-op-1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '새 이름' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
    expect((screen.getByTestId('operator-name-input-op-1') as HTMLInputElement).value).toBe('새 이름');
  });
});
