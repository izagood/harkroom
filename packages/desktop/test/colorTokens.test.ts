import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * #112 요구 6 — **색 유틸리티가 화면 코드에 남아 있지 않다.**
 *
 * 이 회귀선이 지키는 것은 보기 좋음이 아니라 **한 벌**이다. `zinc-800` 하나가 남으면 그
 * 자리만 모드를 따라가지 않고, 라이트에서 검은 조각이 하나 남거나 다크에서 흰 조각이
 * 하나 남는다. 그리고 그런 잔여물은 **새로 들어오는 코드**로 계속 생긴다 — 오늘도 여러
 * 데스크탑 PR 이 `zinc-` 클래스를 들고 main 에 들어왔고, 이 스캔이 그것을 잡았다.
 *
 * 그래서 "치환했다"가 아니라 "지금 없다"를 단언한다. 새 화면이 옛 클래스를 들고 오면
 * 그 PR 에서 빨개진다.
 */
// `import.meta.url` 은 jsdom 환경에서 패키지 밖을 가리킨다 — vitest 의 cwd(패키지 루트)를 쓴다.
const SRC = `${resolve(process.cwd(), 'src')}/`;

/** 역할 색으로 옮긴 계열. 화면 코드에 이 이름이 남아 있으면 안 된다. */
const BANNED_FAMILIES = ['zinc', 'red', 'amber', 'indigo', 'green', 'slate'];

/**
 * 유틸리티가 붙을 수 있는 속성. `bg-red-500` 같은 클래스만 잡고 `text-red` 처럼 숫자가
 * 없는 것은 잡지 않는다 — 숫자 등급이 곧 "팔레트를 직접 부르고 있다"는 신호다.
 */
const UTILITY = new RegExp(
  String.raw`(?<![\w-])(?:[a-z-]+:)*(bg|text|border|ring|placeholder|divide|from|to|via|outline|caret|accent|shadow|fill|stroke|decoration)-(${BANNED_FAMILIES.join('|')})-\d{2,3}(?:/\d{1,3})?(?![\w-])`,
  'g',
);

/**
 * 남긴 예외. **줄 단위로 적는다** — 파일 전체를 면제하면 그 파일에 새로 들어오는 색까지
 * 조용히 통과한다.
 *
 * `Identity.tsx` 의 팔레트는 **역할 색이 아니라 정체성 색**이다. handle 을 해싱해 아바타
 * 색을 고르는 목록이고, 열두 색이 서로 구분되는 것 자체가 기능이다(누구인지 한눈에
 * 알아보게 한다). 역할 토큰으로 바꾸면 열두 사람이 같은 색이 되어 그 기능이 사라진다.
 * 모드와 무관하게 흰 글자와 대비되는 500~600 계열이라 다크에서도 그대로 읽힌다.
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: 'components/Identity.tsx',
    contains: "'bg-red-500', 'bg-orange-500', 'bg-amber-600', 'bg-lime-600',",
    why: '아바타의 정체성 색 팔레트 — 역할 색이 아니다',
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** 예외 목록에 정확히 그 줄로 적혀 있는가. 파일만 맞고 내용이 다르면 예외가 아니다. */
function isAllowed(relative: string, line: string): boolean {
  return ALLOWED.some((a) => relative === a.file && line.includes(a.contains));
}

/** 한 줄에서 클래스 문자열 후보를 뽑는다(따옴표 둘 다 — 조건부 클래스는 홑따옴표를 쓴다). */
function classStrings(line: string): string[] {
  return [
    ...line.matchAll(/"([^"]*)"/g),
    ...line.matchAll(/'([^']*)'/g),
  ].map((m) => m[1]!).filter((s) => /(?:^|\s)(?:hover:)?(?:bg|text|border|ring)-[a-z]/.test(s));
}

/** 그 문자열에서 `<variant><prop>-<token>` 의 토큰 이름들. 팔레트 등급은 잡히지 않는다. */
function tokensOf(cls: string, prop: string, variant = ''): Set<string> {
  const re = new RegExp(String.raw`(?<![\w:-])${variant}${prop}-([a-z-]+)(?![\w-])`, 'g');
  return new Set([...cls.matchAll(re)].map((m) => m[1]!));
}

describe('색 유틸리티가 semantic 토큰으로 치환됐다 (#112)', () => {
  const files = sourceFiles(SRC);

  it('스캔 대상이 실제로 있다 — 목록이 비면 아래 단언이 아무것도 지키지 않는다', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('zinc·red·amber·indigo·green·slate 유틸리티가 남아 있지 않다', () => {
    const leaks: string[] = [];
    for (const file of files) {
      const relative = file.slice(SRC.length);
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        const found = line.match(UTILITY);
        if (!found || isAllowed(relative, line)) return;
        leaks.push(`${relative}:${i + 1} ${found.join(' ')}`);
      });
    }
    expect(leaks, `역할 토큰으로 바꿔라(packages/desktop/src/index.css 참고):\n${leaks.join('\n')}`)
      .toEqual([]);
  });

  /**
   * 스캔이 실제로 무언가를 잡을 수 있는지 확인한다. 정규식을 `/$^/` 로 만들어도 위 단언은
   * 초록이다 — 그러면 이 회귀선은 아무것도 지키지 않는다.
   */
  it('스캔이 옛 클래스를 실제로 잡는다', () => {
    expect('flex bg-zinc-800 text-fg'.match(UTILITY)).toEqual(['bg-zinc-800']);
    expect('hover:bg-red-100 border-amber-300'.match(UTILITY))
      .toEqual(['hover:bg-red-100', 'border-amber-300']);
    // 토큰 클래스는 잡지 않는다 — 잡으면 치환한 코드가 스스로 빨개진다.
    expect('bg-surface-sunken text-fg-muted border-danger-border'.match(UTILITY)).toBeNull();
  });

  it('예외로 적어 둔 줄은 실제로 그 파일에 있다 — 죽은 예외를 남기지 않는다', () => {
    for (const a of ALLOWED) {
      const text = readFileSync(join(SRC, a.file), 'utf-8');
      expect(text, `${a.file} 에 예외로 적은 줄이 없다: ${a.contains}`).toContain(a.contains);
    }
  });

  /**
   * 치환이 만들어 내는 **가장 흔한 사고 둘**을 잡는다. 개수만 세는 회귀선은 이것을 놓친다:
   * 클래스는 전부 토큰이고 스캔은 초록인데, 화면에서는 글자가 안 보이고 hover 가 아무 일도
   * 하지 않는다. 실제로 이 브랜치의 치환에서 다섯 자리가 이렇게 됐다.
   *
   * (a) 같은 클래스 문자열에서 면과 글자가 **같은 토큰** — 글자가 면에 묻힌다.
   * (b) `bg-X hover:bg-X` — 마우스를 올려도 달라지는 것이 없다.
   */
  it('한 클래스 문자열 안에서 면과 글자가 같은 토큰이 아니다', () => {
    const bad: string[] = [];
    for (const file of files) {
      const relative = file.slice(SRC.length);
      readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        for (const cls of classStrings(line)) {
          const bg = tokensOf(cls, 'bg');
          const fg = tokensOf(cls, 'text');
          const shared = [...bg].filter((t) => fg.has(t));
          if (shared.length) bad.push(`${relative}:${i + 1} ${shared.join(',')}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('hover 가 원래 값과 같은 토큰이 아니다 — 아무 일도 하지 않는 hover 를 남기지 않는다', () => {
    const bad: string[] = [];
    for (const file of files) {
      const relative = file.slice(SRC.length);
      readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        for (const cls of classStrings(line)) {
          for (const prop of ['bg', 'text', 'border', 'ring'] as const) {
            const base = tokensOf(cls, prop);
            const hover = tokensOf(cls, prop, 'hover:');
            const shared = [...base].filter((t) => hover.has(t));
            if (shared.length) bad.push(`${relative}:${i + 1} ${prop}-${shared.join(',')}`);
          }
        }
      });
    }
    expect(bad).toEqual([]);
  });

  /**
   * `dark:` variant 를 화면에 뿌리지 않는다(#112 결정 1). 클래스마다 다크 짝을 다는 것은
   * 색을 두 벌 유지하는 것이고, 한쪽만 고치는 사고가 화면 어딘가에서만 조용히 난다.
   */
  it('화면 코드에 dark: variant 가 없다', () => {
    const leaks: string[] = [];
    for (const file of files) {
      const relative = file.slice(SRC.length);
      readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        if (/(?<![\w-])dark:[a-z-]/.test(line)) leaks.push(`${relative}:${i + 1}`);
      });
    }
    expect(leaks).toEqual([]);
  });
});
