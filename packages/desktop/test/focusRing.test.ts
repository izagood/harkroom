// @vitest-environment node
//
// **포커스 링은 앱의 강조색이다**(정본 문서 `docs/desktop-remaining-gaps.html` B3).
//
// 문서가 진단한 것: *"네이티브 select · 네이티브 체크박스, 그리고 디렉터리 검색창의 시스템
// 파란 포커스 링 — 앱의 색이 아닌 파랑이 화면에 들어오는 유일한 곳이다."*
//
// ## 왜 렌더가 아니라 컴파일된 CSS 를 재는가
//
// 이 규칙의 결함은 **CSS 계산 결과에만** 나타난다. jsdom 은 `:focus-visible` 을 계산하지
// 않고 outline 을 그리지도 않으므로, 컴포넌트를 세워 className 을 보는 방식으로는 "링이
// 실제로 그려지는가"에 답할 수 없다. 특히 아래 v4 함정은 **클래스 이름이 전부 맞는데도**
// 링이 안 그려지는 종류라, 이름을 세는 회귀선은 그것을 통째로 놓친다.
//
// 그래서 Tailwind 를 실제로 돌려 산출 CSS 를 뽑고 그 위에서 단언한다 — `vite build` 가
// 만드는 것과 같은 파이프라인이다(같은 `compile()` API 를 `@tailwindcss/vite` 가 쓴다).
import { describe, expect, it } from 'vitest';
import { compile } from 'tailwindcss';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const TAILWIND_INDEX = resolve(dirname(require.resolve('tailwindcss/package.json')), 'index.css');
const SRC = resolve(process.cwd(), 'src');

/**
 * `@import "tailwindcss"` 를 실제 패키지의 `index.css` 로 잇는다. 이것을 주지 않으면
 * `compile()` 이 import 를 못 풀고, preflight(`*` 규칙)가 결과에서 빠진다 — 그러면 아래
 * `--tw-outline-style` 관련 단언이 재는 대상 자체가 사라진다.
 */
async function loadStylesheet(id: string, base: string) {
  const path = id === 'tailwindcss' ? TAILWIND_INDEX : resolve(base, id);
  return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
}

/**
 * 화면이 실제로 쓰는 포커스 유틸리티들. `Menu.tsx`·`Rail.tsx` 의 조합을 그대로 넣어
 * 그 자리의 산출 CSS 도 같은 빌드에서 함께 확인한다.
 */
const CANDIDATES = [
  'outline-none',
  'outline-2',
  'focus-visible:outline-solid',
  'focus-visible:outline-2',
  'focus-visible:outline-accent',
  'focus-visible:-outline-offset-1',
  'focus-visible:-outline-offset-2',
];

async function buildCss(source: string): Promise<string> {
  const compiled = await compile(source, { base: SRC, loadStylesheet });
  return compiled.build(CANDIDATES);
}

/** 셀렉터가 정확히 그것인 규칙의 본문. 유틸리티 클래스 규칙과 섞이지 않게 앞을 막는다. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(String.raw`(?:^|[}\n])\s*${escaped}\s*\{([^}]*)\}`, 'm').exec(css);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : null;
}

describe('포커스 링이 앱의 강조색이다 (#488 B3)', () => {
  it('전역 `:focus-visible` 규칙이 컴파일 결과에 있다', async () => {
    const css = await buildCss(readFileSync(resolve(SRC, 'index.css'), 'utf8'));
    const body = ruleBody(css, ':focus-visible');
    expect(body, '`index.css` 의 전역 `:focus-visible` 규칙이 산출 CSS 에 없다').not.toBeNull();
    expect(body).toContain('outline');
  });

  /**
   * **색은 시맨틱 토큰이어야 한다.** 하드코딩한 값을 쓰면 라이트에서 고른 색이 다크에서
   * 안 맞는다 — 이 저장소가 화면 코드에서 색 이름을 없앤 이유가 그것이다. 그리고 파란
   * 링(브라우저 기본)으로 되돌아가는 것을 잡는 것이 이 항목의 본래 목적이다.
   */
  it('링 색이 강조 토큰이다 — 하드코딩한 색도, 파랑도 아니다', async () => {
    const css = await buildCss(readFileSync(resolve(SRC, 'index.css'), 'utf8'));
    const body = ruleBody(css, ':focus-visible')!;
    expect(body).toMatch(/var\(--(?:app|color)-accent\)/);
    // 16진 색·명명색이 직접 적혀 있으면 잡는다.
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).not.toMatch(/\b(?:blue|highlight|auto)\b/i);
  });

  /**
   * **키보드 포커스는 반드시 보여야 한다.** `outline: none` 만 주는 것은 파란 링을 지우는
   * 동시에 키보드로 옮기는 사람에게서 "지금 어디에 있는지"를 통째로 빼앗는 접근성 파괴다.
   */
  it('링을 지우지 않는다 — 굵기가 실제로 남아 있다', async () => {
    const css = await buildCss(readFileSync(resolve(SRC, 'index.css'), 'utf8'));
    const body = ruleBody(css, ':focus-visible')!;
    expect(body).not.toMatch(/outline\s*:\s*(?:none|0)\b/);
    expect(body).toMatch(/2px/);
  });

  /**
   * **`focus` 가 아니라 `focus-visible` 이다.** #511 이 고친 결함이 이것이다 — `focus` 로
   * 두면 마우스 클릭 뒤에도 사각형이 남는다. 전역 규칙이 그 실수를 하면 결함이 앱 전체로
   * 되살아나므로, `index.css` 에 맨 `:focus` 규칙이 생기는 것을 소스에서 직접 막는다.
   */
  it('전역 규칙은 `focus` 가 아니라 `focus-visible` 을 쓴다', async () => {
    const source = readFileSync(resolve(SRC, 'index.css'), 'utf8');
    // 주석을 걷어낸 뒤 본다 — 주석은 `focus` 를 설명으로 여러 번 말한다.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toContain(':focus-visible');
    // `:focus` 뒤에 `-visible` 이 오지 않는 셀렉터가 있으면 잡는다.
    expect(code).not.toMatch(/:focus(?!-visible)/);
  });

  /**
   * ## Tailwind v4 함정 — 이 회귀선의 핵심
   *
   * `Menu.tsx` 의 주석이 적어 둔 것: v4 의 `outline-none` 은 `--tw-outline-style: none` 을
   * 남기고, `outline-2` 는 **굵기만** 정하면서 스타일을 `outline-style: var(--tw-outline-style)`
   * 로 그 변수에서 읽는다. 그래서 유틸리티로 둘만 쓰면 `focus-visible` 에서도 스타일이
   * `none` 으로 계산되어 링이 **아예 안 그려진다** — 클래스 이름은 전부 맞는데도.
   *
   * 전역 규칙은 유틸리티가 아니라 평범한 CSS 라 `outline` 단축 속성으로 스타일을 직접
   * 적어 그 변수를 **거치지 않는다**. 그 사실을 산출 CSS 에서 확인한다: 전역 규칙 본문에
   * `var(--tw-outline-style)` 이 없어야 한다. 있으면 누가 유틸리티 방식으로 바꿔 놓은
   * 것이고, 그 순간 링이 조용히 사라진다.
   */
  it('전역 규칙은 `--tw-outline-style` 을 거치지 않는다 — v4 함정을 비켜 간다', async () => {
    const css = await buildCss(readFileSync(resolve(SRC, 'index.css'), 'utf8'));
    const body = ruleBody(css, ':focus-visible')!;
    expect(body).not.toContain('--tw-outline-style');
    expect(body).toMatch(/outline\s*:\s*2px\s+solid/);
  });

  /** 함정이 **실재한다**는 것을 같은 빌드에서 보여 둔다. 이 단언이 깨지면 위 주석이 낡은 것이다. */
  it('함정이 실재한다 — `outline-2` 는 스타일을 변수에서 읽고 `outline-none` 이 그것을 none 으로 만든다', async () => {
    const css = await buildCss(readFileSync(resolve(SRC, 'index.css'), 'utf8'));
    expect(ruleBody(css, '.outline-2')).toContain('outline-style: var(--tw-outline-style)');
    expect(ruleBody(css, '.outline-none')).toContain('--tw-outline-style: none');
    // 그래서 되돌리는 클래스가 필요하다 — `Menu.tsx`·`Rail.tsx` 가 쓰는 그것.
    expect(ruleBody(css, '.focus-visible\\:outline-solid:focus-visible'))
      .toContain('--tw-outline-style: solid');
  });

  /**
   * ## 이미 자기 링을 가진 자리와 충돌하지 않는다
   *
   * 특이성으로 갈린다. 전역 규칙의 셀렉터는 `:focus-visible` 하나라 (0,1,0) 이고,
   * `Menu.tsx`·`Rail.tsx` 의 유틸리티는 `.focus-visible\:...:focus-visible` 처럼
   * **클래스 + 의사 클래스**라 (0,2,0) 이다. 클래스 쪽이 이기므로 그 두 곳은 자기 offset
   * (-1px·-2px)을 그대로 유지한다. `outline` 은 박스 모델에 참여하지 않는 단일 속성이라
   * "두 겹으로 그려지는" 일 자체가 불가능하고, 이긴 선언 하나만 그려진다.
   */
  it('그 두 곳의 유틸리티가 전역 규칙보다 특이성이 높다', async () => {
    const css = await buildCss(readFileSync(resolve(SRC, 'index.css'), 'utf8'));
    // 전역: 의사 클래스 하나 → (0,1,0)
    expect(ruleBody(css, ':focus-visible')).not.toBeNull();
    // 그 자리: 클래스 하나 + 의사 클래스 하나 → (0,2,0). 둘 다 산출에 있어야 비교가 성립한다.
    for (const selector of [
      '.focus-visible\\:outline-accent:focus-visible',
      '.focus-visible\\:-outline-offset-1:focus-visible',
      '.focus-visible\\:-outline-offset-2:focus-visible',
    ]) {
      expect(ruleBody(css, selector), `${selector} 가 산출 CSS 에 없다`).not.toBeNull();
    }
  });

  /**
   * 두 파일이 자기 offset 을 **계속 갖고 있다**는 것을 소스에서 확인한다. 전역 규칙이
   * 그 자리를 대신할 수 있다고 보고 누가 지우면, 링이 잘리는 자리로 되돌아간다 —
   * 항목이 메뉴 테두리에·칸이 62px 레일에 꽉 차서 바깥 링은 잘리고 서로 겹친다.
   */
  it('`Menu`·`Rail` 은 자기 안쪽 offset 을 유지한다', () => {
    const menu = readFileSync(resolve(SRC, 'components/Menu.tsx'), 'utf8');
    const rail = readFileSync(resolve(SRC, 'components/Rail.tsx'), 'utf8');
    expect(menu).toContain('focus-visible:-outline-offset-1');
    expect(rail).toContain('focus-visible:-outline-offset-2');
    // 링을 되돌리는 클래스도 함께 남아 있어야 한다(v4 함정).
    expect(menu).toContain('focus-visible:outline-solid');
    expect(rail).toContain('focus-visible:outline-solid');
  });

  /**
   * ## 링이 잘리는 자리 — 전역 기본값은 안쪽에 그린다
   *
   * 바깥으로 밀어낸 링은 `overflow-hidden` 컨테이너 안에서 잘린다. 전역 **기본값**은
   * 어디에 놓일지 모르는 요소를 받으므로 잘릴 수 없는 쪽(음수 offset)으로 둔다.
   */
  it('전역 링은 안쪽에 그린다 — overflow 컨테이너에서 잘리지 않게', async () => {
    const css = await buildCss(readFileSync(resolve(SRC, 'index.css'), 'utf8'));
    const body = ruleBody(css, ':focus-visible')!;
    expect(body).toMatch(/outline-offset\s*:\s*-\d/);
  });

  /**
   * 이 파일이 재는 방식이 **실제로 무언가를 잡을 수 있는지** 확인한다. 규칙을 지운
   * 입력으로 컴파일했을 때 초록이면 위 단언들은 아무것도 지키지 않는다(RED 확인의 고정판).
   */
  it('전역 규칙을 지우면 실제로 빨개진다', async () => {
    const source = readFileSync(resolve(SRC, 'index.css'), 'utf8');
    const without = source.replace(/:focus-visible\s*\{[^}]*\}/, '');
    expect(without).not.toBe(source);
    const css = await buildCss(without);
    expect(ruleBody(css, ':focus-visible')).toBeNull();
  });
});
