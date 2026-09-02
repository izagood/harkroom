import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, fakeApi } from './helpers/fakeApi';

/** 지금 강조된 후보의 handle. 목록 정렬은 여기서 검증할 대상이 아니다. */
const highlighted = () => {
  const opt = screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true');
  return opt!.textContent!.replace(/^@/, '').replace('agent', '');
};

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  // selectionStart 는 jsdom 이 change 로 갱신하지 않는다 — 커서를 끝에 두는 것을 직접 흉내낸다.
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

beforeEach(() => {
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

describe('mention autocomplete', () => {
  it('offers matching agents once an @ is typed', () => {
    render(<Composer onSend={vi.fn()} />);

    typeInto('@fi');

    expect(screen.getByRole('option', { name: /fizz/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /fixit/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /rusalka/ })).toBeNull();
  });

  // 에이전트를 부르는 것이 murmur 의 목적이지만, 사람도 멘션 대상이다.
  it('offers humans too', () => {
    render(<Composer onSend={vi.fn()} />);

    typeInto('@rus');

    expect(screen.getByRole('option', { name: /rusalka/ })).toBeTruthy();
  });

  it('shows nothing before an @ is typed', () => {
    render(<Composer onSend={vi.fn()} />);

    typeInto('안녕하세요');

    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('inserts the clicked handle into the draft', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('이거 @fi');

    fireEvent.click(screen.getByRole('option', { name: /fizz/ }));

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('이거 @fizz ');
  });

  // Enter 가 두 뜻을 가진다. 목록이 열려 있으면 '고르기'다 — 여기서 전송이 새면 반쯤 쓴
  // 멘션이 그대로 채널에 올라간다.
  it('takes Enter as a pick while the list is open, not as send', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@fi');
    const first = highlighted();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(`@${first} `);
  });

  it('sends on Enter when no list is open', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('그냥 문장');

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('그냥 문장', []);
  });

  it('moves the highlight with the arrow keys', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fi');
    const first = highlighted();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
    const second = highlighted();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(second).not.toBe(first);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(`@${second} `);
  });

  // Escape 로 닫은 뒤에는 Enter 가 다시 전송이어야 한다 — 아니면 멘션을 포기한 사용자가
  // 메시지를 못 보낸다.
  it('closes on Escape and hands Enter back to send', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@fi');

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('@fi', []);
  });

  it('closes the list after a pick so the next Enter sends', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@fi');
    const first = highlighted();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith(`@${first} `, []);
  });

  it('clears the draft after sending', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('보낸다');

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  // 후보가 없으면 창이 뜨면 안 되고, Enter 도 막히면 안 된다.
  it('does not hold Enter hostage when nothing matches', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    typeInto('@zzzz');

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('@zzzz', []);
  });

  // murmur 에서 @ 를 치는 주된 이유가 에이전트 호출이다. 사람이 먼저 오면 매번 화살표를
  // 눌러야 한다.
  it('puts agents above humans in the list', () => {
    useAppStore.getState().set({
      accounts: {
        u1: acc('u1', 'me'),
        h: acc('h', 'aaa-human'),
        a: acc('a', 'zzz-agent', 'agent'),
      },
    });
    render(<Composer onSend={vi.fn()} />);

    typeInto('@');

    expect(screen.getAllByRole('option')[0]!.textContent).toContain('zzz-agent');
  });

  // 전송이 실패하면 쓴 글이 돌아와야 한다. 사라지면 사용자는 무엇을 잃었는지도 모른다.
  it('puts the draft back when sending fails', async () => {
    const onSend = vi.fn(async () => { throw new Error('offline'); });
    render(<Composer onSend={onSend} />);
    typeInto('보내려던 글');

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('보내려던 글'));
  });

  it('does not offer the author themselves', () => {
    render(<Composer onSend={vi.fn()} />);

    typeInto('@me');

    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  // 재현 테스트: 부트 후 서버에 새 계정이 생겼을 때, @ 를 쳐서 자동완성을 여는 것만으로
  // 그 새 계정이 후보에 나타난다.
  it('refreshes accounts when autocomplete opens', async () => {
    const api = fakeApi({
      accounts: vi.fn(async () => [
        acc('u1', 'me'),
        acc('a1', 'fizz', 'agent'),
        acc('new', 'newagent', 'agent'), // 서버에 있지만 로컬에 없는 새 계정
      ]),
    });
    const c = new Controller(api);
    setController(c);
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'me'), a1: acc('a1', 'fizz', 'agent') },
    });

    render(<Composer onSend={vi.fn()} />);
    typeInto('@new');

    await waitFor(() => expect(useAppStore.getState().accounts.new).toBeDefined());
    expect(screen.getByRole('option', { name: /newagent/ })).toBeTruthy();
  });

  // refreshAccounts 는 실패를 스스로 삼키지 않고 거부된 프로미스를 그대로 돌려준다
  // (컨트롤러 내부 호출부가 전부 swallow() 로 감싸는 이유). 여는 쪽이 `.catch` 없이 부르면
  // 서버가 잠깐 끊길 때마다 unhandled rejection 이 난다 — 동기 try/catch 로는 못 잡는다.
  it('디렉터리 갱신이 실패해도 unhandled rejection 없이 캐시된 목록으로 동작한다', async () => {
    const api = fakeApi({ accounts: vi.fn(async () => { throw new Error('네트워크 끊김'); }) });
    setController(new Controller(api));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      render(<Composer onSend={vi.fn()} />);
      typeInto('@fi');
      // 거부가 마이크로태스크 큐를 빠져나가 unhandled 로 보고될 틈을 준다.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    // 갱신이 실패해도 부트 때 받아 둔 후보는 그대로 보여야 한다.
    expect(screen.getByRole('option', { name: /fizz/ })).toBeTruthy();
  });

  // 가드 테스트: 자동완성을 짧은 간격으로 여러 번 열어도 디렉터리 요청이 한 번만 나간다.
  it('does not refetch accounts rapidly when autocomplete opens repeatedly', async () => {
    const api = fakeApi({
      accounts: vi.fn(async () => [
        acc('u1', 'me'),
        acc('a1', 'fizz', 'agent'),
      ]),
    });
    const c = new Controller(api);
    setController(c);

    render(<Composer onSend={vi.fn()} />);
    typeInto('@fi');
    typeInto('@fi');
    typeInto('@fi');

    await Promise.resolve();
    expect(api.accounts).toHaveBeenCalledTimes(1);
  });
});
