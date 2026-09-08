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

// 목록 **맨 아래** 메시지에서 `⋯` 메뉴가 잘려 누를 수 없던 결함.
//
// 메시지 툴바는 `placement="bottom"` 이라 메뉴가 트리거 아래로 열리는데, 마지막 메시지에서는
// 그 아래가 메시지 목록(`overflow-y: auto`)의 테두리 밖이다. 화면 밖이 아니라 **스크롤 상자
// 밖**이라 뷰포트만 보는 계산으로는 잡히지 않았다 — 목록을 스크롤해 그 메시지를 위로 올려야만
// 항목을 누를 수 있었다.
//
// **jsdom 한계**: 레이아웃이 없어 모든 `getBoundingClientRect` 가 0 이다. 그래서 배치를
// 직접 만들어 준다 — 요소마다 `data-rect` 로 좌표를 붙이고 그 값을 돌려주게 스텁한다.
// 재는 값이 가짜여도 **재고 나서 어느 쪽으로 여는가** 라는 판단은 진짜 코드가 한다.
describe('자리가 없으면 반대쪽으로 연다', () => {
  const stubRects = () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const spec = this.dataset.rect ?? this.closest<HTMLElement>('[data-rect]')?.dataset.rect;
      const [top, bottom] = (spec ?? '0 0').split(' ').map(Number) as [number, number];
      return { top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
  };

  /** 스크롤 상자(0~300) 안, 지정한 자리에 선 트리거로 메뉴를 연다. */
  const openInScroller = (triggerTop: number) => {
    render(
      <div data-rect="0 300" style={{ overflowY: 'auto' }}>
        <div data-rect={`${triggerTop} ${triggerTop + 20}`}>
          <Menu
            renderTrigger={(props) => <button {...props}>me</button>}
            items={items}
            placement="bottom"
          />
        </div>
      </div>,
    );
    fireEvent.click(screen.getByText('me'));
    return screen.getByRole('menu');
  };

  afterEach(() => { vi.restoreAllMocks(); });

  it('스크롤 상자 아래 테두리에 걸리면 위로 뒤집는다', () => {
    stubRects();
    // 트리거 아래는 300-296=4px 뿐이고 간격만으로 다 쓴다. 메뉴는(스텁에서 20px) 안 들어간다.
    const menu = openInScroller(276);
    expect(menu.className).toContain('bottom-full');
    expect(menu.className).not.toContain('top-full');
  });

  it('자리가 있으면 원래 방향(아래) 그대로 연다', () => {
    stubRects();
    // 트리거 아래로 280px 남는다 — 뒤집을 이유가 없다.
    const menu = openInScroller(0);
    expect(menu.className).toContain('top-full');
    expect(menu.className).not.toContain('bottom-full');
  });

  it('스크롤 상자가 없으면 화면 높이로 잰다 — 조상만 보고 0 으로 접지 않는다', () => {
    stubRects();
    render(
      <div data-rect="10 30">
        <Menu renderTrigger={(props) => <button {...props}>me</button>} items={items} placement="bottom" />
      </div>,
    );
    fireEvent.click(screen.getByText('me'));
    // jsdom 창은 768px 이라 아래가 넉넉하다.
    expect(screen.getByRole('menu').className).toContain('top-full');
  });
});
