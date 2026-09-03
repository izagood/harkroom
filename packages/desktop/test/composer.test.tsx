import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { acc, accountsResult, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/** 지금 강조된 후보의 handle. 목록 정렬은 여기서 검증할 대상이 아니다. */
// 핸들은 **속성**에서 읽는다. textContent 에서 뽑으면 장식이 하나 늘 때마다 깨진다 —
// 예전 헬퍼는 `.replace('agent','')` 로 장식을 지우고 있었고, 그 장식이 아이덴티티
// 컴포넌트로 바뀌자 실제로 깨졌다.
const highlighted = () => {
  const opt = screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true');
  return opt!.getAttribute('data-handle')!;
};

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  // selectionStart 는 jsdom 이 change 로 갱신하지 않는다 — 커서를 끝에 두는 것을 직접 흉내낸다.
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

beforeEach(() => {
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

describe('mention autocomplete', () => {
  // 비활성화된 계정(#94)은 부를 수 없다 — 러너의 PAT 가 폐기됐으므로 불러도 답할 사람이 없다.
  // 다만 디렉터리에서 **빼지는 않는다**: 같은 목록이 과거 메시지의 작성자 이름을 푸는 표라서
  // 빼면 그 에이전트가 쓴 메시지가 작성자를 잃는다(shared 의 AccountView.disabled 주석).
  // 그래서 후보에서 거르는 책임이 이쪽에 있고, 이 테스트가 그 경계를 지킨다.
  it('비활성화된 계정은 멘션 후보에 나오지 않는다 (디렉터리에는 남아 있다)', () => {
    useAppStore.getState().set({
      accounts: {
        u1: acc('u1', 'me'),
        a1: acc('a1', 'fizz', 'agent'),
        a2: { ...acc('a2', 'fizzbot', 'agent'), disabled: true },
      },
    });
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fizz');

    const options = screen.queryAllByRole('option').map((el) => el.textContent ?? '');
    expect(options.some((t) => t.includes('fizz'))).toBe(true);
    expect(options.some((t) => t.includes('fizzbot'))).toBe(false);
    // 디렉터리 자체에는 남아 있어야 한다 — 이력 렌더링이 이 표를 본다.
    expect(useAppStore.getState().accounts.a2).toBeDefined();
  });

  it('offers matching agents once an @ is typed', () => {
    render(<Composer onSend={vi.fn()} />);

    typeInto('@fi');

    expect(screen.getByRole('option', { name: /fizz/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /fixit/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /rusalka/ })).toBeNull();
  });

  /**
   * #277 경계. 후보 목록의 `Identity` 는 **핸들 옆** 자리이므로 `badge` 다 — 거터가 아니다.
   * 여기를 `avatar` 로 바꾸면 소유자(#181)가 조용히 사라진다. 부르기 직전이 "누구의
   * 에이전트인가"가 가장 필요한 순간이고, 사라진 정보는 화면에 아무 흔적을 남기지 않는다.
   */
  it('#277: 후보 목록의 에이전트에 소유자 핸들이 함께 나온다', () => {
    useAppStore.getState().set({
      accounts: {
        u1: acc('u1', 'me'),
        u2: acc('u2', 'rusalka'),
        a1: { ...acc('a1', 'fizz', 'agent'), ownerAccountId: 'u2' },
      },
    });
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fizz');

    const opt = screen.getByRole('option', { name: /fizz/ });
    expect(opt.textContent).toContain('@rusalka');
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
      accounts: vi.fn(async () => accountsResult([
        acc('u1', 'me'),
        acc('a1', 'fizz', 'agent'),
        acc('new', 'newagent', 'agent'), // 서버에 있지만 로컬에 없는 새 계정
      ])),
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
      accounts: vi.fn(async () => accountsResult([
        acc('u1', 'me'),
        acc('a1', 'fizz', 'agent'),
      ])),
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

describe('focus blur dismiss', () => {
  // #142: 포커스가 컴포저 밖으로 나가면 목록이 닫힌다.
  it('closes when focus moves outside the composer', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fi');

    expect(screen.queryAllByRole('option')).toHaveLength(2);

    const container = screen.getByText('@fi').closest('.relative')!;
    const outsideElement = document.createElement('button');
    outsideElement.textContent = 'outside';
    document.body.appendChild(outsideElement);
    outsideElement.focus();

    fireEvent.blur(container, { relatedTarget: outsideElement });

    expect(screen.queryAllByRole('option')).toHaveLength(0);

    outsideElement.remove();
  });

  // #142: relatedTarget 이 null 이라도 닫힌다 (창 포커스 상실 등)
  it('closes when relatedTarget is null (window blur)', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fi');

    expect(screen.queryAllByRole('option')).toHaveLength(2);

    const container = screen.getByText('@fi').closest('.relative')!;
    fireEvent.blur(container, { relatedTarget: null });

    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  // #142: 포커스가 컴포저 안의 다른 컨트롤로 옮겨가면 닫히지 않는다.
  it('does not close when focus moves to an internal control', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fi');

    expect(screen.queryAllByRole('option')).toHaveLength(2);

    const container = screen.getByText('@fi').closest('.relative')!;
    const optionButton = screen.getByRole('option', { name: /fizz/ });
    fireEvent.blur(container, { relatedTarget: optionButton });

    expect(screen.queryAllByRole('option')).toHaveLength(2);
  });

  // #142: 후보 클릭이 여전히 후보를 고른다 (회귀선)
  it('still allows picking a candidate by clicking', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('이거 @fi');

    fireEvent.click(screen.getByRole('option', { name: /fizz/ }));

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('이거 @fizz ');
  });
});

describe('바깥 클릭 dismiss', () => {
  // #142: blur 경로와 중복이 아니다 — 포커스를 받지 않는 요소를 클릭하면 포커스가
  // 이동하지 않아 blur 가 발생하지 않는다. 그 구멍을 document mousedown 이 덮는다.
  // 워커 산출물에 이 경로의 테스트가 없었다(구현은 있었다).
  it('closes when a non-focusable area outside the composer is clicked', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fi');

    expect(screen.queryAllByRole('option')).toHaveLength(2);

    // div 는 포커스를 받지 않으므로 blur 가 나지 않는다 — mousedown 만 발생한다.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    fireEvent.mouseDown(outside);

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    outside.remove();
  });

  it('keeps the list open when the click is inside the composer', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fi');

    const container = screen.getByText('@fi').closest('.relative')!;
    fireEvent.mouseDown(container);

    expect(screen.queryAllByRole('option')).toHaveLength(2);
  });
});
