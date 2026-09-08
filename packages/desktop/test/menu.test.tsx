import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Menu } from '../src/components/Menu';

// #488 B3 — 메뉴 항목의 **포커스 표시**와 **여백**을 고정한다.
//
// 결함은 둘이었다. 하나는 항목을 클릭하면 브라우저 기본 포커스 링(굵은 파란 사각형)이
// 남는 것 — `Menu.tsx` 에 포커스 스타일이 하나도 없어 OS 기본이 그대로 나왔다. 다른 하나는
// 항목이 `py-1.5` 라 줄이 눌려 보인 것.
//
// **jsdom 의 한계를 먼저 적는다**: jsdom 은 `:focus-visible` 을 판정하지 못하고
// (포커스가 키보드에서 왔는지 마우스에서 왔는지 추적하지 않는다), Tailwind 클래스를
// 실제 CSS 로 계산하지도 않는다 — `getComputedStyle(item).outlineColor` 는 어느
// 경우에나 같은 값을 준다. 그래서 "마우스 뒤에는 안 보이고 키보드에서는 보인다"를
// 렌더 결과로 잴 수 없다. 대신 그 구분을 **만들어 내는 계약**, 곧 항목이
// `focus-visible:` 접두사로 링을 켠다는 사실을 클래스 문자열로 고정한다. 링이 `focus:`
// 로 후퇴하거나 `outline-none` 만 남으면 이 테스트가 잡는다.

afterEach(() => { cleanup(); });

const items = [
  { label: '내 프로필', onSelect: vi.fn() },
  { label: 'Settings', shortcut: '⌘,', onSelect: vi.fn() },
];

/** 메뉴를 열고 항목 버튼들을 준다. */
const openMenu = (extra?: { header?: React.ReactNode }) => {
  render(
    <Menu
      renderTrigger={(props) => <button {...props}>me</button>}
      items={items}
      header={extra?.header}
    />,
  );
  fireEvent.click(screen.getByText('me'));
  return screen.getAllByRole('menuitem');
};

describe('메뉴 항목의 포커스 링(#488 B3)', () => {
  it('시스템 기본에 기대지 않고 자기 포커스 스타일을 갖는다', () => {
    const [first] = openMenu();
    const cls = first!.className;

    // 기본 링을 끈다 — 이것이 없으면 파란 사각형이 그대로 나온다.
    expect(cls).toContain('outline-none');
    // 그리고 우리 링을 다시 켠다. `outline-none` 만 있으면 접근성이 깨진 상태다.
    expect(cls).toMatch(/focus-visible:outline-\d/);
  });

  it('링을 focus 가 아니라 focus-visible 에서만 켠다', () => {
    const [first] = openMenu();
    const cls = first!.className;

    // 마우스 클릭 뒤 링이 남지 않는 것은 오직 `:focus-visible` 이 만든다.
    // (jsdom 이 그 판정을 못 하므로 클래스로 고정한다 — 파일 머리의 한계 설명 참고.)
    expect(cls).toContain('focus-visible:outline');
    // `focus:` 로 켜면 마우스 클릭에도 링이 남는다 — 되돌아가지 않게 막는다.
    expect(cls).not.toMatch(/(^|\s)focus:outline-(?!none)/);
  });

  it('링 색이 앱의 강조 토큰이다 — 하드코딩한 색이 아니다', () => {
    const [first] = openMenu();
    const cls = first!.className;

    expect(cls).toContain('focus-visible:outline-accent');
    // Tailwind 팔레트 색이 직접 박히면 라이트/다크 한쪽에서 어긋난다.
    expect(cls).not.toMatch(/outline-(blue|indigo|sky|zinc|red|orange)-\d{2,3}/);
  });

  it('굵기 지정만으로는 링이 안 보인다 — outline-style 을 solid 로 되돌린다', () => {
    const [first] = openMenu();
    // v4 의 `outline-none` 은 `--tw-outline-style: none` 을 남기고 `outline-2` 는
    // 그 변수에서 스타일을 읽는다. 되돌리는 클래스가 없으면 2px 가 계산상 `none` 이라
    // 화면에 아무것도 안 그려진다 — 통과하는 것처럼 보이는 회귀를 여기서 막는다.
    expect(first!.className).toContain('focus-visible:outline-solid');
  });
});

describe('메뉴 항목의 여백(#488 B3)', () => {
  it('머리와 같은 가로 축(px-3)에 선다', () => {
    const header = <div data-testid="menu-header">나</div>;
    const menuItems = openMenu({ header });
    const headerBox = screen.getByTestId('menu-header').parentElement!;

    // 항목만 넓히면 이름이 머리의 이름보다 밀려 두 줄이 어긋난다. 같은 축이어야 한다.
    expect(headerBox.className).toContain('px-3');
    for (const item of menuItems) expect(item.className).toContain('px-3');
  });

  it('줄이 눌려 보이지 않게 세로 여백을 머리와 같은 8px 축으로 준다', () => {
    const [first] = openMenu();
    // `py-1.5`(6px) 가 좁아 보이던 값이다. 머리의 `pb-2` 와 같은 `py-2`(8px) 를 쓴다.
    expect(first!.className).toContain('py-2');
    expect(first!.className).not.toContain('py-1.5');
  });
});

describe('프리미티브의 다른 계약이 그대로다', () => {
  it('항목을 고르면 onSelect 가 불리고 메뉴가 닫힌다', () => {
    const onSelect = vi.fn();
    render(
      <Menu
        renderTrigger={(props) => <button {...props}>me</button>}
        items={[{ label: '내 프로필', onSelect }]}
      />,
    );
    fireEvent.click(screen.getByText('me'));
    fireEvent.click(screen.getByRole('menuitem', { name: '내 프로필' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('단축키는 접근성 이름에서 빠진다', () => {
    openMenu();
    // 이름은 `Settings` 이지 `Settings ⌘,` 가 아니다 — `aria-hidden` 이 그것을 만든다.
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy();
  });
});

/**
 * 하단 메시지의 `⋯` 메뉴가 목록 밑단에서 잘리던 결함.
 *
 * 메뉴는 `absolute` 라 스레드 목록(`flex-1 overflow-y-auto`)이 자른다. 그 목록은 화면
 * 바닥이 아니라 **작성칸 위**에서 끝나므로, 창 안에 들어가는 메뉴도 목록 밖으로 넘으면
 * 잘린다 — 그래서 재는 경계가 `window.innerHeight` 가 아니라 자르는 조상의 상자다.
 *
 * jsdom 은 모든 상자를 0 으로 주고 레이아웃을 하지 않으므로 상자를 **직접 심는다**:
 * 자르는 통(`overflow-y: auto`)과 트리거는 `data-rect` 로, 메뉴는 높이만 준다.
 * 진짜 그리기를 재는 것이 아니라 **어느 상자를 보고 어느 방향을 고르는가**를 고정한다.
 */
describe('잘리는 쪽으로는 열지 않는다', () => {
  const rectOf = (top: number, bottom: number): DOMRect =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  /** `data-rect="top,bottom"` 을 심은 요소와 메뉴에만 상자를 준다. 나머지는 0(=안 잼). */
  const stubLayout = (menuHeight: number): void => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') return rectOf(0, menuHeight);
      const attr = this.getAttribute('data-rect');
      if (attr) {
        const [top, bottom] = attr.split(',').map(Number) as [number, number];
        return rectOf(top, bottom);
      }
      return rectOf(0, 0);
    });
  };

  /** 자르는 통 안에 메뉴를 놓고 연다. `listBottom` 이 목록이 끝나는 자리(작성칸 위)다. */
  const openInList = (opts: { listBottom: number; triggerTop: number; menuHeight: number }) => {
    stubLayout(opts.menuHeight);
    render(
      <div data-rect={`0,${opts.listBottom}`} style={{ overflowY: 'auto' }}>
        <Menu
          renderTrigger={(props) => <button {...props} data-rect={`${opts.triggerTop},${opts.triggerTop + 20}`}>me</button>}
          items={items}
          placement="bottom"
        />
      </div>,
    );
    fireEvent.click(screen.getByText('me'));
    return screen.getByRole('menu');
  };

  afterEach(() => { vi.restoreAllMocks(); });

  it('아래에 자리가 있으면 소비자가 준 방향 그대로 아래로 연다', () => {
    const menu = openInList({ listBottom: 400, triggerTop: 10, menuHeight: 300 });
    expect(menu.className).toContain('top-full');
    expect(menu.className).not.toContain('bottom-full');
  });

  it('목록 밑단에 걸리면 위로 뒤집는다 — 창 안이어도 목록 밖이면 잘린다', () => {
    // 창(jsdom 기본 768)에는 들어가지만 목록(400)에는 안 들어가는 자리. 뷰포트만 보는
    // 구현은 여기서 뒤집지 않고, 그것이 스크린샷의 결함이었다.
    const menu = openInList({ listBottom: 400, triggerTop: 360, menuHeight: 300 });
    expect(menu.className).toContain('bottom-full');
    expect(menu.className).not.toContain('top-full');
  });

  it('위아래 어디에도 안 들어가면 넓은 쪽에 붙이고 메뉴 안에서 굴린다', () => {
    // 아래 26px · 위 146px. 뒤집어도 300px 이 안 들어가므로 넓은 쪽을 골라 잘라 둔다 —
    // 잘려 나간 항목은 있는 줄도 모르지만 굴러가는 항목은 손이 닿는다.
    const menu = openInList({ listBottom: 200, triggerTop: 150, menuHeight: 300 });
    expect(menu.className).toContain('bottom-full');
    expect(menu.style.maxHeight).toBe('146px');
    expect(menu.style.overflowY).toBe('auto');
  });

  it('자리가 넉넉하면 높이를 자르지 않는다', () => {
    const menu = openInList({ listBottom: 400, triggerTop: 10, menuHeight: 300 });
    expect(menu.style.maxHeight).toBe('');
  });
});
