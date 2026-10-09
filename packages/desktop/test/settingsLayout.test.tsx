// 설정 폭 PR 1 — 바탕 원시(설정 폭 시안 v1, designer · jaebin 승인).
//
// 이 PR 은 **보이는 변화가 0** 이어야 한다: 화면은 아직 아무도 `layout` 을 넘기지 않으므로
// 옛 `width` 갈래(640 / wide)가 글자 하나 안 바뀌고 그대로 서야 한다. 새 원시는 옮기는 PR 들이
// 따라갈 것이다 — 여기서는 꼴별 상한·칸 자리·라벨 연결을 고정한다.
//
// jsdom 은 컨테이너 쿼리를 계산하지 않는다. 그래서 칸이 **실제로** 몇 단으로 서는지는 CSS 가
// 정하고(vite build 로 생성 확인), 여기서는 그 CSS 를 부르는 클래스가 제자리에 붙는지를 본다.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import {
  DangerZone, KvRow, SettingsColumns, SettingsPage, SettingsWrap,
} from '../src/components/settings/primitives';

afterEach(() => cleanup());

describe('SettingsPage — 옛 갈래는 그대로', () => {
  it('layout 을 안 주면 640px 왼쪽 정렬 그대로다(이 PR 의 보이는 변화 0)', () => {
    const { container } = render(<SettingsPage section="profile"><p>본문</p></SettingsPage>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toBe('max-w-[640px] px-10 py-10');
    expect(root.hasAttribute('data-settings-layout')).toBe(false);
  });

  it('width="wide" 도 그대로다', () => {
    const { container } = render(<SettingsPage section="claude-accounts" width="wide"><p>본문</p></SettingsPage>);
    expect((container.firstElementChild as HTMLElement).className).toBe('max-w-6xl px-10 py-10');
  });
});

describe('SettingsPage layout · SettingsWrap — 꼴별 상한과 가운데 정렬', () => {
  it.each([
    ['form', 'max-w-[880px]'],
    ['cards', 'max-w-[1680px]'],
    ['list', 'max-w-[2200px]'],
  ] as const)('%s 는 %s 에서 멈추고 가운데에 선다', (layout, max) => {
    const { container } = render(<SettingsPage section="profile" layout={layout} width="wide"><p>본문</p></SettingsPage>);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('data-settings-layout')).toBe(layout);
    const cls = root.className.split(/\s+/);
    expect(cls).toContain(max);
    expect(cls).toContain('mx-auto');
    // 칸 나누기가 재는 자 — 창이 아니라 이 겹의 폭(규칙 ④).
    expect(cls).toContain('@container/settings');
    // layout 이 있으면 width 는 무시된다.
    expect(cls).not.toContain('max-w-6xl');
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();
  });

  it('머리·본문이 따로 서도 같은 꼴이면 같은 상한이다(규칙 ② — 단추가 본문 끝에 맞는다)', () => {
    render(
      <>
        <SettingsWrap layout="cards" testId="head">머리</SettingsWrap>
        <SettingsWrap layout="cards" testId="body">본문</SettingsWrap>
      </>,
    );
    expect(screen.getByTestId('head').className).toBe(screen.getByTestId('body').className);
  });
});

describe('SettingsColumns — 칸 자리', () => {
  it('곁 칸이 없으면 칸을 나누지 않는다', () => {
    render(<SettingsColumns testId="cols" main={<p>주</p>} />);
    const cols = screen.getByTestId('cols');
    expect(cols.className).not.toMatch(/grid-cols-\[/);
    expect(cols.querySelector('[data-settings-col="side"]')).toBeNull();
  });

  it('주 + 곁: 900 부터 곁 칸 380 이 오른쪽에 선다. 좁으면 주 → 곁 순으로 쌓인다', () => {
    render(<SettingsColumns testId="cols" main={<p>주</p>} side={<p>곁</p>} />);
    const cols = screen.getByTestId('cols');
    expect(cols.className).toContain('@min-[900px]/settings:grid-cols-[minmax(0,1fr)_380px]');
    expect(cols.className).not.toContain('1.2fr');
    const order = [...cols.children].map((c) => c.getAttribute('data-settings-col'));
    expect(order).toEqual(['main', 'side']);
    const side = cols.querySelector('[data-settings-col="side"]')!;
    expect(side.className).toContain('@min-[900px]/settings:col-start-2');
  });

  it('카드가 셋이면 1560 부터 3단, 곁 칸은 셋째 줄로', () => {
    render(<SettingsColumns testId="cols" main={<p>주</p>} secondary={<p>둘째</p>} side={<p>곁</p>} />);
    const cols = screen.getByTestId('cols');
    expect(cols.className).toContain('@min-[1560px]/settings:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_400px]');
    expect([...cols.children].map((c) => c.getAttribute('data-settings-col'))).toEqual(['main', 'secondary', 'side']);
    const side = cols.querySelector('[data-settings-col="side"]')!;
    expect(side.className).toContain('@min-[1560px]/settings:col-start-3');
    expect(side.className).toContain('@min-[900px]/settings:row-span-2');
    expect(cols.querySelector('[data-settings-col="secondary"]')!.className).toContain('@min-[1560px]/settings:col-start-2');
  });

  /**
   * Tailwind 는 소스 글자를 훑어 클래스를 찾는다. 템플릿으로 이어 붙인 조각은 CSS 가 생기지
   * 않는다 — 이 PR 첫 판에서 900 칸 클래스가 그랬고, 테스트는 초록인데 화면에서 칸이 안 섰다.
   */
  it('컨테이너 쿼리 클래스를 템플릿 조각으로 잇지 않는다', () => {
    const src = readFileSync(resolve(__dirname, '../src/components/settings/primitives.tsx'), 'utf8');
    expect(src).not.toMatch(/\/settings:[^\s'"`]*\$\{/);
    expect(src).not.toMatch(/\]\$\{/);
  });
});

describe('KvRow — 라벨-값 두 열', () => {
  it('라벨 120 + 값 상한 440 — 칸이 넓어져도 둘이 벌어지지 않는다', () => {
    render(<KvRow testId="kv" label="모델"><span>opus</span></KvRow>);
    expect(screen.getByTestId('kv').className).toContain('grid-cols-[120px_minmax(0,440px)]');
  });

  it('htmlFor 를 주면 라벨을 눌러 입력으로 간다', () => {
    render(<KvRow label="작업 폴더" htmlFor="wd"><input id="wd" /></KvRow>);
    expect(screen.getByLabelText('작업 폴더').id).toBe('wd');
  });
});

describe('DangerZone — 되돌릴 수 없는 조작 한 카드', () => {
  it('기본 제목으로 이름 붙은 영역이고, 조작마다 한 칸이다', () => {
    render(
      <DangerZone testId="dz">
        <div>비활성화</div>
        <div>삭제</div>
      </DangerZone>,
    );
    const dz = screen.getByTestId('dz');
    // 이름은 사전에서 온다(로캘에 따라 '위험 구역' / 'Danger zone') — 제목 글자와 영역 이름이 같은지를 본다.
    const heading = screen.getByRole('heading', { level: 3 });
    expect(['위험 구역', 'Danger zone']).toContain(heading.textContent);
    expect(screen.getByRole('region', { name: heading.textContent! })).toBe(dz);
    expect(dz.className).toContain('border-danger-border');
    expect(screen.getByText('비활성화').parentElement!.children).toHaveLength(2);
  });

  it('제목을 바꿀 수 있다', () => {
    render(<DangerZone title="토큰"><div>폐기</div></DangerZone>);
    expect(screen.getByRole('region', { name: '토큰' })).toBeTruthy();
  });
});
