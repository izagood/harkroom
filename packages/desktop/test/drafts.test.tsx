import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';
import { draftsStorage, undoSendStorage } from '../src/lib/prefs';

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

beforeEach(() => {
  localStorage.clear();
  // 반드시 clear 뒤다 — 같은 localStorage 에 사는 값이라 순서가 바뀌면 조용히 지워진다.
  // 이 파일이 검증하는 것은 보냄 취소 창이 아니다(#223) — 창을 끄고 즉시 전송 경로를 본다.
  // 창 자체는 undoSend.test.tsx 가 단독으로 지킨다.
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      a1: acc('a1', 'fizz', 'agent'),
      a2: acc('a2', 'fixit', 'agent'),
      u2: acc('u2', 'rusalka'),
    },
  });
  const c = new Controller(fakeApi());
  setController(c);
});
afterEach(() => {
  cleanup();
  setController(null as unknown as Controller);
});

describe('초안 보관', () => {
  it('채널 A 에 쓰고 B 로 옮기면 입력창이 비어 있다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    
    typeInto('hello world');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello world');
    
    const current = draftsStorage.load();
    expect(current['channel-A']).toBe('hello world');
    
    cleanup();
    render(<Composer onSend={onSend} scopeKey="channel-B" />);
    
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('B 에서 A 로 돌아오면 A 의 초안이 그대로다', async () => {
    const onSend = vi.fn();
    
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    typeInto('hello from A');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello from A');
    
    cleanup();
    render(<Composer onSend={onSend} scopeKey="channel-B" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    
    cleanup();
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello from A');
  });

  it('A 초안과 스레드 초안이 서로 섞이지 않는다', async () => {
    const onSend = vi.fn();
    
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    typeInto('channel A draft');
    
    cleanup();
    render(<Composer onSend={onSend} scopeKey="thread:123" />);
    typeInto('thread draft');
    
    cleanup();
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('channel A draft');
    
    cleanup();
    render(<Composer onSend={onSend} scopeKey="thread:123" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('thread draft');
  });

  it('전송 성공 후 그 스코프의 초안이 사라진다', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    
    typeInto('hello world');
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    
    const current = draftsStorage.load();
    expect(current['channel-A']).toBeUndefined();
  });

  it('전송 실패 시 사용자가 친 본문이 남는다', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('fail'));
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    
    typeInto('hello world');
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello world');
    });
  });

  it('앱 재시작(보관소에서 복원)에도 초안이 남는다', async () => {
    const onSend = vi.fn();
    
    localStorage.setItem('murmur.drafts', JSON.stringify({ 'channel-A': 'persisted draft' }));

    // 보관소 읽기는 **앱 기동 시점**이다(controller.start 가 부른다) — 컴포저가 보관소를
    // 직접 뒤지지 않는다. 그래서 재시작을 흉내내려면 하이드레이션을 명시적으로 부른다.
    useAppStore.getState().hydrateDrafts();
    render(<Composer onSend={onSend} scopeKey="channel-A" />);

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('persisted draft');
  });

  it('로그아웃하면 보관된 초안이 전부 사라진다', async () => {
    const onSend = vi.fn();
    
    localStorage.setItem('murmur.drafts', JSON.stringify({
      'channel-A': 'draft A',
      'channel-B': 'draft B',
      'thread:123': 'thread draft',
    }));
    useAppStore.getState().hydrateDrafts();
    expect(Object.keys(useAppStore.getState().drafts)).toHaveLength(3);

    // 로그아웃이 실제로 부르는 경로(appStore.clearDrafts)를 탄다. 초판은
    // draftsStorage.clear() 를 직접 불러 **헬퍼가 동작하는지만** 봤고, 로그아웃이 그것을
    // 부르는지는 검사하지 않았다 — 보안 결정이 정확히 그 틈에 있었다.
    useAppStore.getState().clearDrafts();

    // 인메모리와 보관소 **둘 다** 비어야 한다. 보관소만 지우면 스토어에 문장이 남고,
    // 스토어만 지우면 다음 기동에 되살아난다.
    expect(Object.keys(useAppStore.getState().drafts)).toHaveLength(0);
    expect(localStorage.getItem('murmur.drafts')).toBeNull();
  });

  it('채널을 바꾸면 멘션 자동완성 목록이 닫힌다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    
    typeInto('@fi');
    expect(screen.queryAllByRole('option')).toHaveLength(2);
    
    cleanup();
    render(<Composer onSend={onSend} scopeKey="channel-B" />);
    
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('초안을 비우면 보관소에 빈 값이 남지 않는다', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="channel-A" />);
    
    typeInto('some text');
    expect(draftsStorage.load()['channel-A']).toBe('some text');
    
    typeInto('');
    
    const current = draftsStorage.load();
    expect(current['channel-A']).toBeUndefined();
  });
});