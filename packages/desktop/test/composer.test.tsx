import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Composer } from '../src/components/Composer';
// 판정이 갈라지지 않았는지 보려면 **본문을 실제로 렌더해** 대조해야 한다(#278).
import { MessageBody } from '../src/components/MessageBody';
import { Controller, setController } from '../src/state/controller';
import { acc, accountsResult, fakeApi, grp } from './helpers/fakeApi';
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


/**
 * 보내기 전에 "부를 상대" 를 보여 준다(#278).
 *
 * 이 줄이 막으려는 것은 **알림이 갔다는 착각**이다. 그래서 이 블록의 중심은 어떤 항목이
 * 보이는지가 아니라 **판정이 `MessageBody` 강조와 같은 함수에서 나오는지**다 — 판정이
 * 갈라지면 이 줄이 오히려 거짓말의 근거가 된다.
 */
describe('부를 상대 미리보기 (#278)', () => {
  /** 이 줄에 실제로 올라온 handle 들. 장식(집합·채널 전체)이 늘어도 깨지지 않게 속성에서 읽는다. */
  const listed = (): string[] => {
    const line = screen.queryByTestId('body-mentions');
    if (!line) return [];
    return [...line.querySelectorAll('[data-handle]')].map((el) => el.getAttribute('data-handle')!);
  };

  it('본문에 존재하는 handle 이 있으면 목록에 나온다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('안녕 @fizz');
    expect(listed()).toEqual(['fizz']);
  });

  it('존재하지 않는 handle 은 목록에 없다 — 이메일도 멘션이 아니다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('안녕 @notexist');
    expect(screen.queryByTestId('body-mentions')).toBeNull();

    // 선행 문자 규칙(`MENTION_PATTERN`)이 이메일을 걸러 낸다. 여기서 새 정규식을 쓰면
    // `me@fizz.com` 이 fizz 를 부르는 것처럼 보인다 — shared 의 주석이 경계하는 거짓말이다.
    typeInto('보낼 곳은 me@fizz.com 이야');
    expect(screen.queryByTestId('body-mentions')).toBeNull();
  });

  it('본문이 비거나 멘션이 없으면 줄 자체가 렌더되지 않는다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('안녕');
    expect(screen.queryByTestId('body-mentions')).toBeNull();
    typeInto('');
    expect(screen.queryByTestId('body-mentions')).toBeNull();
  });

  /**
   * 케이스 표. 이 줄의 판정과 `MessageBody` 강조가 **같은 함수**(`splitMentions`)에서 나오는지
   * 를 같은 입력·같은 결과로 단언한다. 컴포저가 자기 정규식을 복제하면(예전 초판이 그랬다)
   * 이메일·`@channel`·대소문자에서 결과가 갈라지고 이 표가 빨개진다.
   */
  const CASES: string[] = [
    '@fizz 안녕',
    '@Fizz 와 @fizz 는 한 사람',
    '보낼 곳은 me@fizz.com 이야',
    '@notexist 는 아무도 아니다',
    '@channel 공지',
    '@oncall 서버 문제',
    '@fizz @rusalka @oncall 모두',
    '멘션 없음',
  ];

  it('판정이 MessageBody 강조와 같은 함수에서 나온다 (케이스 표)', () => {
    const accounts = {
      u1: acc('u1', 'me'),
      a1: acc('a1', 'fizz', 'agent'),
      u2: acc('u2', 'rusalka'),
    };
    const groups = [grp('g1', 'oncall', 'On-call')];
    useAppStore.getState().set({ accounts, groups, me: acc('u1', 'me') });

    for (const body of CASES) {
      // `MessageBody` 가 실제로 칠한 handle 들. 단위 함수를 직접 부르지 않는 이유: 컴포저와
      // 본문이 **같은 인자**를 넘기는지까지 봐야 한다. 같은 함수를 써도 인자가 다르면
      // (자기 계정을 빼거나 `@channel` 을 빼면) 판정은 갈라진다.
      const body1 = render(<MessageBody body={body} messageId="m1" />);
      const painted = [...document.querySelectorAll('[data-testid^="mention-"]')]
        .map((el) => el.getAttribute('data-testid')!.replace('mention-', ''));
      body1.unmount();

      const composer = render(<Composer onSend={vi.fn()} />);
      typeInto(body);
      const shown = listed();
      composer.unmount();
      useAppStore.getState().setDraft('', '');

      // 자기 자신은 이 줄에서만 빠진다(서버가 알림에서 작성자를 걸러 낸다). 그 하나를
      // 빼면 두 판정은 **완전히 같아야 한다**.
      expect(shown, `본문: ${body}`).toEqual([...new Set(painted)].filter((h) => h !== 'me'));
    }
  });

  it('자기 멘션은 본문에서는 칠해지고 이 줄에는 없다 (서버가 작성자를 알림에서 뺀다)', () => {
    const body1 = render(<MessageBody body="@me 나에게" messageId="m1" />);
    expect(document.querySelector('[data-testid="mention-me"]')).toBeTruthy();
    body1.unmount();

    render(<Composer onSend={vi.fn()} />);
    typeInto('@me 나에게');
    expect(screen.queryByTestId('body-mentions')).toBeNull();
  });

  it('고정 멘션 칩과 이 줄은 다른 요소다 — 겹쳐도 둘 다 남고, 칩을 지워도 이 줄은 본문 기준이다', () => {
    render(<Composer onSend={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Add mention/ }));
    fireEvent.click(screen.getAllByRole('option').find((o) => o.getAttribute('data-handle') === 'fizz')!);
    expect(screen.queryAllByTestId('sticky-mention')).toHaveLength(1);

    // 같은 handle 을 본문에도 쓴다. 뜻이 다른 두 줄이므로 **둘 다** 그 handle 을 보여야 한다.
    typeInto('@fizz 안녕');
    expect(listed()).toEqual(['fizz']);
    expect(screen.queryAllByTestId('sticky-mention')).toHaveLength(1);

    // 칩을 지운다. 이 줄의 근거는 본문이므로 그대로 남아야 한다.
    fireEvent.click(screen.getByRole('button', { name: 'Remove @fizz' }));
    expect(screen.queryAllByTestId('sticky-mention')).toHaveLength(0);
    expect(listed()).toEqual(['fizz']);
  });

  it('집합 handle 은 (집합) 표시와 함께 나온다', () => {
    useAppStore.getState().set({ groups: [grp('g1', 'oncall', 'On-call')] });
    render(<Composer onSend={vi.fn()} />);
    typeInto('@oncall 서버 문제가 있어');

    const line = screen.getByTestId('body-mentions');
    expect(line.querySelector('[data-handle="oncall"]')!.getAttribute('data-kind')).toBe('group');
    expect(line.textContent).toContain('(집합)');
  });

  /**
   * `@channel`(#225)은 계정이 없어도 대상이다 — `splitMentions` 가 칠하고 서버가 채널 전체에
   * 알림을 넣는다. 이 줄이 계정만 보고 걸렀을 때 `@channel` 을 쓴 사람만 자기가 누구를
   * 부르는지 못 보게 됐다.
   */
  it('@channel 은 (채널 전체) 로 나온다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@channel 공지합니다');

    const line = screen.getByTestId('body-mentions');
    expect(line.querySelector('[data-handle="channel"]')!.getAttribute('data-kind')).toBe('channel');
    expect(line.textContent).toContain('(채널 전체)');
  });

  it('channel 이라는 계정이 있으면 그 사람이고 채널 전체가 아니다 (계정이 이긴다)', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'me'), u3: acc('u3', 'channel') },
    });
    render(<Composer onSend={vi.fn()} />);
    typeInto('@channel 공지합니다');

    const line = screen.getByTestId('body-mentions');
    expect(line.querySelector('[data-handle="channel"]')!.getAttribute('data-kind')).toBe('account');
    expect(line.textContent).not.toContain('(채널 전체)');
  });

  /**
   * #298 — 코드 블록 안의 handle 은 알림이 가지 않으므로 이 줄에도 나오지 않는다.
   *
   * 순수 함수(`bodyRecipients`)만 보는 단언은 `Composer` 가 그 함수를 부르지 않게 되어도
   * 초록이다. 그래서 여기서는 **작성창에 실제로 타이핑해** 그 줄을 읽는다.
   */
  it('코드 블록 안의 handle 은 이 줄에 나오지 않는다 (#298)', () => {
    useAppStore.getState().set({ groups: [grp('g1', 'oncall', 'On-call')] });
    render(<Composer onSend={vi.fn()} />);

    typeInto('```\n@fizz @oncall\n```');
    expect(listed()).toEqual([]);

    // 코드 밖은 그대로 살아 있다 — 위 단언이 이 줄 자체가 죽은 것을 통과시키지 않는다.
    typeInto('@fizz 이거 봐\n```\n@oncall\n```');
    expect(listed()).toEqual(['fizz']);

    typeInto('`@fizz` 라고 적어');
    expect(listed()).toEqual([]);
  });

  it('이 줄의 항목은 누를 수 없다 — 지우려면 본문을 고친다', () => {
    render(<Composer onSend={vi.fn()} />);
    typeInto('@fizz @rusalka 안녕');
    const line = screen.getByTestId('body-mentions');
    expect(line.querySelectorAll('button')).toHaveLength(0);
  });
});
