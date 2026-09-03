import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { setExternalOpener } from '../src/lib/openExternal';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

// #216 — 본문의 코드를 코드로 그리는 자리의 회귀선.
//
// 여기서 지키는 것은 보기 좋음이 아니라 **경계**다. 본문은 에이전트도 쓰는 신뢰할 수 없는
// 텍스트이므로, 코드 구간에서는 다른 어떤 인식도(링크·멘션) 작동하지 않아야 하고 raw HTML
// 은 어떤 경로로도 엘리먼트가 되지 않아야 한다. 그래서 3·4·5번은 "코드로 보인다"가 아니라
// "**다른 것이 되지 않는다**"를 확인한다.

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone'), a1: acc('a1', 'fizz', 'agent') },
  });
  // 링크가 실수로 만들어져 눌리더라도 진짜 브라우저로 나가지 않게 막아 둔다.
  setExternalOpener({ open: vi.fn(async () => undefined) });
  setController({ openMessage: vi.fn(async () => undefined) } as unknown as ControllerType);
});
afterEach(() => {
  cleanup();
  setExternalOpener(null);
  setController(null);
});

describe('코드가 코드로 그려진다', () => {
  it('백틱 하나로 감싼 것은 인라인 코드다', () => {
    show('설정은 `pnpm typecheck` 로 확인해');

    const code = screen.getByTestId('inline-code');
    expect(code.tagName).toBe('CODE');
    expect(code.textContent).toBe('pnpm typecheck');
    // 백틱은 결과에 남지 않는다 — 문법이 화면에 보이면 렌더링이 안 된 것과 같다.
    expect(screen.getByTestId('message-body').textContent).not.toContain('`');
  });

  it('펜스 블록은 블록으로 그려지고 개행이 유지된다', () => {
    show('이거 봐\n```\nline1\nline2\n```\n끝');

    const block = screen.getByTestId('code-block');
    expect(block.tagName).toBe('PRE');
    expect(block.textContent).toBe('line1\nline2');
    // 앞뒤 평문은 그대로 남는다 — 블록이 메시지를 삼키면 안 된다.
    const body = screen.getByTestId('message-body').textContent ?? '';
    expect(body).toContain('이거 봐');
    expect(body).toContain('끝');
  });

  it('언어 표시는 보여 주기만 한다 — 강조기를 들이지 않는다', () => {
    show('```ts\nconst a = 1;\n```');

    expect(screen.getByTestId('code-lang').textContent).toBe('ts');
    expect(screen.getByTestId('code-block').getAttribute('data-lang')).toBe('ts');
    // 강조기가 없으므로 코드 안에는 토큰별 엘리먼트가 생기지 않는다.
    expect(screen.getByTestId('code-block').querySelectorAll('span').length).toBe(0);
  });
});

describe('코드 안에서는 다른 인식이 작동하지 않는다', () => {
  it('코드 블록 안의 URL 은 링크가 되지 않는다', () => {
    show('```\ncurl https://evil.example.com/x\n```');

    expect(screen.queryByTestId('body-link')).toBeNull();
    expect(screen.getByTestId('code-block').textContent).toContain('https://evil.example.com/x');
  });

  it('인라인 코드 안의 URL 도 링크가 되지 않는다', () => {
    show('`https://evil.example.com/x` 를 치면 된다');

    expect(screen.queryByTestId('body-link')).toBeNull();
    expect(screen.getByTestId('inline-code').textContent).toBe('https://evil.example.com/x');
  });

  it('코드 블록 안의 @handle 은 멘션 강조가 되지 않는다', () => {
    show('```\ngit commit -m "@fizz 가 시켰다"\n```');

    expect(screen.queryByTestId('mention-fizz')).toBeNull();
    expect(screen.getByTestId('code-block').textContent).toContain('@fizz');
  });

  it('코드 밖의 링크와 멘션은 그대로 살아 있다', () => {
    show('@fizz 여기 https://example.com/a 보고 `ls` 실행해');

    expect(screen.getByTestId('mention-fizz')).toBeTruthy();
    expect(screen.getByTestId('body-link').textContent).toBe('https://example.com/a');
    expect(screen.getByTestId('inline-code').textContent).toBe('ls');
  });
});

describe('raw HTML 은 통과하지 않는다', () => {
  it('코드 안의 HTML 문자열은 텍스트로 보인다 — 엘리먼트가 만들어지지 않는다', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const { container } = show(`\`\`\`html\n${payload}\n\`\`\``);

    // 실재 확인: 엘리먼트가 하나도 생기지 않았다.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // 그리고 사람은 글자 그대로 본다.
    expect(screen.getByTestId('code-block').textContent).toBe(payload);
  });

  it('인라인 코드의 HTML 문자열도 같다', () => {
    const payload = '<script>fetch("/steal")</script>';
    const { container } = show(`이런 걸 조심해: \`${payload}\``);

    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByTestId('inline-code').textContent).toBe(payload);
  });
});

describe('애매한 입력은 평문으로 둔다', () => {
  it('닫히지 않은 펜스는 평문으로 남는다', () => {
    show('```sh\nrm -rf /\n뒤에 할 말이 더 있다');

    // 블록으로 그리면 여기부터 뒤가 전부 코드가 되어 메시지가 사라진 것처럼 보인다.
    expect(screen.queryByTestId('code-block')).toBeNull();
    const body = screen.getByTestId('message-body').textContent ?? '';
    expect(body).toContain('```sh');
    expect(body).toContain('뒤에 할 말이 더 있다');
  });

  it('짝이 없는 백틱 하나는 뒤의 본문을 삼키지 않는다', () => {
    show('`ls 만 치면 안 되고 뒤에 경로가 필요하다');

    expect(screen.queryByTestId('inline-code')).toBeNull();
    expect(screen.getByTestId('message-body').textContent)
      .toBe('`ls 만 치면 안 되고 뒤에 경로가 필요하다');
  });
});

describe('코드가 없는 본문', () => {
  it('지금과 똑같이 그려진다 — 개행도 글자 하나도 잃지 않는다', () => {
    // 여러 줄인 것이 요점이다. 코드 토크나이저가 본문을 줄로 나눠 보므로, 다시 합칠 때
    // 개행을 잃으면 코드가 없는 평범한 메시지가 조용히 망가진다.
    const plain = '평범한 첫 줄\n두 번째 줄\n\n빈 줄 뒤 세 번째';
    show(plain);

    expect(screen.getByTestId('message-body').textContent).toBe(plain);
    expect(screen.queryByTestId('inline-code')).toBeNull();
    expect(screen.queryByTestId('code-block')).toBeNull();
  });
});
