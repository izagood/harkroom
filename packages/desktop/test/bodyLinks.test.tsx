import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { messagePermalink } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { setExternalOpener } from '../src/lib/openExternal';
import { MessageItem } from '../src/components/MessageItem';
import { Notice } from '../src/components/Notice';
import { acc, msg } from './helpers/fakeApi';

// #214 — 본문의 URL 을 링크로 만드는 자리의 회귀선.
//
// 여기서 지키는 것은 편의가 아니라 **신뢰 경계**다: 사용자와 에이전트가 쓴 글자가 클릭
// 가능한 동작이 되는 순간부터, 무엇을 링크로 만들지 정하는 허용 목록이 방어선 전부다.
// 그래서 스킴 테스트들은 "열리지 않는다"가 아니라 "**링크가 되지 않는다**"를 확인한다 —
// 누를 것 자체가 생기지 않아야 실수로 여는 경로가 남지 않는다.

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

/** OS 로 넘어간 URL 만 모은다. 열지는 않는다 — 테스트가 진짜 브라우저를 띄우면 안 된다. */
const spyOpener = (impl: (url: string) => Promise<void> = async () => undefined) => {
  const open = vi.fn(impl);
  setExternalOpener({ open });
  return open;
};

const spyController = () => {
  const c = { openMessage: vi.fn(async () => undefined) };
  setController(c as unknown as ControllerType);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone'), a1: acc('a1', 'fizz', 'agent') },
  });
});
afterEach(() => {
  cleanup();
  setExternalOpener(null);
  setController(null);
});

describe('링크가 되는 URL', () => {
  it('https 주소를 링크로 만들고, 누르면 OS 로 넘긴다', async () => {
    const open = spyOpener();
    show('여기 봐 https://example.com/a?b=1');

    const link = screen.getByTestId('body-link');
    expect(link.textContent).toBe('https://example.com/a?b=1');
    fireEvent.click(link);

    await waitFor(() => expect(open).toHaveBeenCalledWith('https://example.com/a?b=1'));
  });

  it('http 주소도 같다 — 사내 도구는 아직 평문 http 로 뜬다', async () => {
    const open = spyOpener();
    show('http://localhost:3000/runs/7 확인');

    fireEvent.click(screen.getByTestId('body-link'));

    await waitFor(() => expect(open).toHaveBeenCalledWith('http://localhost:3000/runs/7'));
  });

  it('문장 끝 마침표는 주소가 아니다', () => {
    spyOpener();
    show('자세히는 https://example.com/docs.');

    expect(screen.getByTestId('body-link').textContent).toBe('https://example.com/docs');
    // 마침표는 글자로 남는다 — 지우면 본문이 원문과 달라진다.
    expect(screen.getByTestId('message-body').textContent).toBe('자세히는 https://example.com/docs.');
  });
});

describe('허용 목록 밖의 스킴은 링크가 되지 않는다', () => {
  it('javascript: 는 링크가 아니라 글자로 남는다', () => {
    show('javascript:alert(1) 눌러봐');

    expect(screen.queryByTestId('body-link')).toBeNull();
    expect(screen.getByTestId('message-body').textContent).toBe('javascript:alert(1) 눌러봐');
  });

  it('file: 도 링크가 되지 않는다', () => {
    show('file:///etc/passwd 여기');

    expect(screen.queryByTestId('body-link')).toBeNull();
    expect(screen.getByTestId('message-body').textContent).toBe('file:///etc/passwd 여기');
  });

  // 정규화가 지키는 것은 금지 방향만이 아니다 — 대문자 스킴의 **정상 주소가 살아남는
  // 것**도 정규화가 한다. 손수 문자열을 잘라 비교하면 'HTTPS:' 가 허용 목록에 없어
  // 멀쩡한 링크가 조용히 글자로 떨어진다. 그 방향의 회귀선이 없으면 `new URL` 을
  // 걷어내도 테스트가 초록이다.
  it('대문자 HTTPS 주소도 링크로 살아남는다', () => {
    show('HTTPS://Example.COM/a 봐');

    const link = screen.getByTestId('body-link');
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('HTTPS://Example.COM/a');
  });

  it('JaVaScRiPt: 처럼 대소문자를 섞어도 링크가 되지 않는다', () => {
    // 판정 전에 정규화하지 않으면 여기서 뚫린다 — 금지 목록이 늘 지는 자리다.
    show('JaVaScRiPt:alert(1) 과 DATA:text/html,<b>x</b> 와 VBScript:msgbox(1)');

    expect(screen.queryByTestId('body-link')).toBeNull();
    expect(screen.getByTestId('message-body').textContent)
      .toBe('JaVaScRiPt:alert(1) 과 DATA:text/html,<b>x</b> 와 VBScript:msgbox(1)');
  });
});

describe('murmur:// 는 OS 로 보내지 않는다', () => {
  const id = '11111111-2222-4333-8444-555555555555';

  it('앱 안에서 openMessage 로 연다', async () => {
    const open = spyOpener();
    const c = spyController();
    show(`결정은 여기 ${messagePermalink(id)}`);

    fireEvent.click(screen.getByTestId('body-link'));

    await waitFor(() => expect(c.openMessage).toHaveBeenCalledWith(id));
    // OS 는 murmur 를 모른다 — 셸로 넘기면 아무 일도 일어나지 않는다.
    expect(open).not.toHaveBeenCalled();
  });

  it('uuid 가 아닌 murmur:// 는 링크가 되지 않는다', () => {
    show('murmur://message/not-a-uuid 와 murmur://open/whatever');

    expect(screen.queryByTestId('body-link')).toBeNull();
  });
});

describe('멘션 강조를 깨지 않는다', () => {
  it('링크와 멘션이 한 줄에 같이 있어도 둘 다 산다', () => {
    spyOpener();
    show('@fizz https://example.com/a 봐줘');

    expect(screen.getByTestId('mention-fizz').textContent).toBe('@fizz');
    expect(screen.getByTestId('body-link').textContent).toBe('https://example.com/a');
    expect(screen.getByTestId('message-body').textContent).toBe('@fizz https://example.com/a 봐줘');
  });
});

describe('여는 데 실패하면 사람에게 보인다', () => {
  it('링크가 열리지 않으면 알림이 뜬다', async () => {
    // 조용히 삼키면 사람은 앱이 멈춘 줄 알고 같은 링크를 계속 누른다(#178).
    spyOpener(async () => { throw new Error('no browser'); });
    render(<Notice />);
    show('https://example.com/a');

    fireEvent.click(screen.getByTestId('body-link'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/example\.com/);
  });
});
