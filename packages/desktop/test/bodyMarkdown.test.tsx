import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { setExternalOpener } from '../src/lib/openExternal';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

// #216 — 본문의 마크다운을 구조로 그리는 자리의 회귀선.
//
// 여기서 지키는 것은 "이쁘게 보인다" 가 아니라 **세 가지 손실이 없다** 는 것이다:
//
// 1. **문법이 화면에 남지 않는다.** `##` 나 `**` 가 그대로 보이면 렌더링이 안 된 것이다.
// 2. **글자가 사라지지 않는다.** 문법으로 오인해 `_` 를 지우거나 빈 줄을 삼키면 그건
//    렌더링이 아니라 훼손이다 — 사람이 쓴 것과 다른 것을 보여 준 것이다.
// 3. **경계가 흔들리지 않는다.** 코드 안에서는 마크다운이 작동하지 않고, 강조 안에서는
//    멘션이 그대로 살아 있고, raw HTML 은 어떤 경로로도 엘리먼트가 되지 않는다.
//
// 이걸 바꾸면 무엇이 사라지는지: 3번을 지우면 본문 렌더링이 신뢰 경계를 잃는다. 본문은
// 에이전트도 쓰는 텍스트이고, 이 파일이 없으면 다음에 누가 편해 보이는 마크다운
// 라이브러리로 갈아 끼우면서 `dangerouslySetInnerHTML` 을 같이 들여올 것이다.

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

const bodyText = () => screen.getByTestId('message-body').textContent ?? '';

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

describe('블록 구조가 구조로 그려진다', () => {
  it('# 로 시작하는 줄은 제목이다 — 그리고 # 는 화면에 남지 않는다', () => {
    show('## 확인한 사실\n본문 한 줄');

    const h = screen.getByTestId('md-heading');
    expect(h.getAttribute('data-level')).toBe('2');
    expect(h.textContent).toBe('확인한 사실');
    expect(bodyText()).not.toContain('#');
  });

  it('제목은 <h1> 이 아니라 role=heading 이다 — 메시지가 문서 개요의 자리를 주장하지 않는다', () => {
    // 한 채널에 <h1> 이 스무 개 서면 개요가 거짓이 된다. 그래서 절대 레벨이 아니라
    // aria-level 로 상대 깊이만 말한다. 이 줄을 지우면 다음 사람이 <h1> 로 바꿔 놓는다.
    show('# 제목');

    const h = screen.getByTestId('md-heading');
    expect(h.tagName).toBe('DIV');
    expect(h.getAttribute('role')).toBe('heading');
    expect(Number(h.getAttribute('aria-level'))).toBeGreaterThan(1);
  });

  it('- 로 시작하는 줄들은 하나의 목록이다 — 글머리표는 글자가 아니라 목록이 만든다', () => {
    show('- 첫째\n- 둘째');

    const list = screen.getByTestId('md-list');
    expect(list.tagName).toBe('UL');
    expect(screen.getAllByTestId('md-list-item').map((li) => li.textContent)).toEqual(['첫째', '둘째']);
    expect(bodyText()).not.toContain('-');
  });

  it('번호 목록은 <ol> 이고 시작 번호를 지킨다', () => {
    // `3.` 으로 시작한 목록을 1 부터 다시 세면 사람이 쓴 번호가 사라진다.
    show('3. 셋째\n4. 넷째');

    const list = screen.getByTestId('md-list');
    expect(list.tagName).toBe('OL');
    expect(list.getAttribute('start')).toBe('3');
  });

  it('들여쓴 항목은 **중첩 목록**이 된다 — 들여쓰기를 흉내낸 여백이 아니다', () => {
    // padding 으로만 밀면 스크린리더가 읽어 주는 "3개 중 2번째" 와 깊이가 사라진다.
    // 그건 구조를 그린 게 아니라 구조처럼 보이게 칠한 것이다.
    show('1. 바깥\n   - 안쪽 하나\n   - 안쪽 둘\n2. 다시 바깥');

    const lists = screen.getAllByTestId('md-list');
    expect(lists).toHaveLength(2);
    const outer = lists.find((l) => l.tagName === 'OL')!;
    const inner = lists.find((l) => l.tagName === 'UL')!;
    // 중첩의 증거는 "두 개가 있다" 가 아니라 "안쪽이 바깥 항목 **안에** 있다" 다.
    expect(outer.contains(inner)).toBe(true);
    expect(inner.closest('li')!.textContent).toContain('바깥');
    expect(outer.children).toHaveLength(2);
  });

  it('> 로 시작하는 줄은 인용이고, 빈 줄에서 끝난다', () => {
    show('> 인용된 말\n> 이어지는 말\n\n인용이 아닌 말');

    const quote = screen.getByTestId('md-quote');
    expect(quote.tagName).toBe('BLOCKQUOTE');
    expect(quote.textContent).toBe('인용된 말\n이어지는 말');
    // 빈 줄이 인용을 끊지 않으면 인용이 아닌 문장이 인용 안으로 끌려 들어간다.
    expect(quote.textContent).not.toContain('인용이 아닌 말');
  });

  it('--- 만 있는 줄은 가로줄이다 — 글머리표가 아니다', () => {
    show('위\n\n---\n\n아래');

    expect(screen.getByTestId('md-rule').tagName).toBe('HR');
    expect(screen.queryByTestId('md-list')).toBeNull();
  });
});

describe('강조가 강조로 그려진다', () => {
  it('** 는 <strong>, ~~ 는 <s>, * 는 <em> 이다 — 기호는 남지 않는다', () => {
    show('**굵게** 와 *기울임* 과 ~~취소~~');

    expect(screen.getByTestId('md-strong').textContent).toBe('굵게');
    expect(screen.getByTestId('md-em').textContent).toBe('기울임');
    expect(screen.getByTestId('md-strike').textContent).toBe('취소');
    // 굵기만 필요하면 font-bold 로 끝나지만, 그러면 스크린리더에 아무것도 전달되지 않는다.
    expect(screen.getByTestId('md-strong').tagName).toBe('STRONG');
    expect(bodyText()).toBe('굵게 와 기울임 과 취소');
  });

  it('중첩은 조각마다의 태그 중첩으로 나온다 — 안쪽은 두 태그를 모두 받는다', () => {
    // 강조는 **조각 단위 상태**(strong/em/strike 세 축)로 들고 다니고 태그는 조각마다
    // 씌운다. 그래서 `**굵고 _기울고_ 다시**` 는 `<strong>` 하나가 아니라 셋으로 나오고,
    // 가운데 것만 `<em>` 을 하나 더 받는다. 보이는 것과 읽히는 것은 같고, 대신 파서에
    // 여는 태그 스택을 두지 않아도 중첩이 공짜로 나온다 — 그 단순함이 여기서 사는 값이다.
    show('**굵고 _기울고_ 다시 굵게**');

    const strongs = screen.getAllByTestId('md-strong');
    expect(strongs.map((s) => s.textContent).join('')).toBe('굵고 기울고 다시 굵게');
    const em = screen.getByTestId('md-em');
    expect(em.textContent).toBe('기울고');
    // 안쪽 조각은 굵기도 함께 받는다. 이게 깨지면 기울인 부분만 굵기가 풀린다.
    expect(strongs.some((s) => s.contains(em))).toBe(true);
  });

  it('닫히지 않은 ** 는 강조가 아니다 — 그대로 글자로 남는다', () => {
    // 닫는 짝을 낙관하면 뒤 본문 전체가 굵어지고, 사람에게는 메시지가 깨진 것으로 보인다.
    // `splitCode` 의 "닫히지 않은 펜스는 코드가 아니다" 와 같은 규칙이다.
    show('**여기서 열고 닫지 않았다');

    expect(screen.queryByTestId('md-strong')).toBeNull();
    expect(bodyText()).toBe('**여기서 열고 닫지 않았다');
  });

  it('식별자 안의 _ 는 기울임이 아니다 — 글자를 지우지 않는다', () => {
    // 이게 없으면 `kMDItemLastUsedDate` 류가 아니라 실제로 우리가 매일 쓰는
    // `snake_case` 이름에서 `_` 가 소리 없이 사라진다. 렌더링이 내용을 바꾼 것이다.
    show('NSOSPLastRootDirectory 와 my_var_name 은 그대로다');

    expect(screen.queryByTestId('md-em')).toBeNull();
    expect(bodyText()).toBe('NSOSPLastRootDirectory 와 my_var_name 은 그대로다');
  });

  it('띄어 쓴 * 는 강조를 열지 않는다', () => {
    show('a * b * c');

    expect(screen.queryByTestId('md-em')).toBeNull();
    expect(bodyText()).toBe('a * b * c');
  });
});

describe('[글자](주소) 는 링크가 되지만, 열 수 있는 것만 된다', () => {
  it('http(s) 는 링크가 되고 보이는 글자는 라벨이다', () => {
    show('[murmur 저장소](https://github.com/izagood/murmur) 를 봐');

    const a = screen.getByTestId('body-link');
    expect(a.textContent).toBe('murmur 저장소');
    expect(a.getAttribute('href')).toBe('https://github.com/izagood/murmur');
    expect(a.getAttribute('data-link-kind')).toBe('external');
    // 문법은 남지 않는다.
    expect(bodyText()).toBe('murmur 저장소 를 봐');
  });

  it('열 수 없는 스킴은 **누를 것이 생기지 않는다** — 막는 것이 아니다', () => {
    // 허용 목록(`classifyLink`)이 그대로 신뢰 경계다. 이 줄을 지우면 본문에 쓴 글자가
    // 임의 스킴을 여는 버튼이 된다.
    show('[누르지 마](javascript:alert(1))');

    expect(screen.queryByTestId('body-link')).toBeNull();
    // 링크가 안 됐다고 글자를 삼키지도 않는다 — 사람이 쓴 것이 그대로 보인다.
    expect(bodyText()).toBe('[누르지 마](javascript:alert(1))');
  });
});

describe('경계 — 마크다운이 침범하지 않는 곳', () => {
  it('코드 블록 안의 ** 와 ## 와 - 는 마크다운이 아니다', () => {
    show('```\n## 제목이 아니다\n**굵지 않다**\n- 목록이 아니다\n```');

    expect(screen.queryByTestId('md-heading')).toBeNull();
    expect(screen.queryByTestId('md-strong')).toBeNull();
    expect(screen.queryByTestId('md-list')).toBeNull();
    // 코드 안에서는 문법이 **글자로 보여야** 한다 — 그게 코드의 뜻이다.
    expect(screen.getByTestId('code-block').textContent)
      .toBe('## 제목이 아니다\n**굵지 않다**\n- 목록이 아니다');
  });

  it('인라인 코드 안의 * 는 강조를 열지 않는다', () => {
    show('`*.tmp` 와 `**/*.html` 은 그냥 패턴이다');

    expect(screen.queryByTestId('md-em')).toBeNull();
    expect(screen.queryByTestId('md-strong')).toBeNull();
    expect(screen.getAllByTestId('inline-code').map((c) => c.textContent))
      .toEqual(['*.tmp', '**/*.html']);
  });

  it('목록 항목 안의 인라인 코드는 항목 안에 남는다 — 줄이 조각나도 목록은 목록이다', () => {
    // `splitCode` 는 한 줄을 여러 조각으로 쪼갠다(`- ` + 코드 + 나머지). 줄로 다시
    // 꿰매지 않으면 이 줄은 목록으로 보이지 않는다.
    show('- `pnpm test` 로 확인한다');

    const li = screen.getByTestId('md-list-item');
    expect(li.textContent).toBe('pnpm test 로 확인한다');
    expect(li.querySelector('code')).not.toBeNull();
  });

  it('굵은 글씨 안의 @handle 은 여전히 멘션이다', () => {
    // 멘션이 마지막에 얹히기 때문에 따라오는 결과다. 이게 깨지면 강조를 쓴 문장에서만
    // 멘션이 조용히 죽고, 사람은 알림이 갔다고 착각한다.
    show('**@fizz 이거 봐**');

    const mention = screen.getByTestId('mention-fizz');
    expect(screen.getByTestId('md-strong').contains(mention)).toBe(true);
  });

  it('제목 안의 링크도 링크다', () => {
    show('## https://example.com/x 를 보라');

    expect(screen.getByTestId('md-heading').contains(screen.getByTestId('body-link'))).toBe(true);
  });

  it('raw HTML 은 어떤 경로로도 엘리먼트가 되지 않는다', () => {
    // 마크다운을 붙였다고 HTML 통과 경로가 생기면 안 된다. 여기서 나오는 것은 문자열이
    // 아니라 구조체이고, 렌더러는 구조체만 엘리먼트로 바꾼다.
    show('## <img src=x onerror=alert(1)>\n**<script>bad()</script>**');

    const body = screen.getByTestId('message-body');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('script')).toBeNull();
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(body.textContent).toContain('<script>bad()</script>');
  });
});

describe('사람이 쓴 줄바꿈은 마크다운보다 세다', () => {
  it('빈 줄은 문단을 끊지 않는다 — 개행 글자가 사라지지 않는다', () => {
    // 마크다운 표준은 빈 줄에서 문단을 나누고 여백을 스타일로 준다. 여기서 그러면
    // `whitespace-pre-wrap` 이 이미 만든 여백에 문단 여백이 한 번 더 붙어 간격이 두 배가
    // 되고, 더 나쁜 것은 그 빈 줄이 본문에서 사라진다는 것이다.
    const plain = '첫 줄\n두 번째 줄\n\n빈 줄 뒤 세 번째';
    show(plain);

    expect(bodyText()).toBe(plain);
  });

  it('마크다운이 없는 본문은 문단 하나로 끝난다 — 예전과 똑같이 그려진다', () => {
    show('그냥 한 줄');

    expect(screen.getAllByTestId('md-paragraph')).toHaveLength(1);
    expect(screen.queryByTestId('md-heading')).toBeNull();
    expect(bodyText()).toBe('그냥 한 줄');
  });
});
