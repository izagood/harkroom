// 앱은 스크롤되는 **문서**가 아니라 창을 꽉 채우는 **고정 셸**이다. 그 사실을 지키는 회귀선.
//
// 왜 필요한가(2026-09-10 실측 사고): 앱 루트가 `100vh`(`h-screen`)로 서 있었고 `html`·`body`
// 에는 높이가 없었다. 웹뷰 배율 1.111 이 걸리자 루트가 보이는 높이보다 ~11% 길어졌고, 넘친
// 부분은 **스크롤바도 없이 화면 밖으로 나갔다** — 사람에게는 입력창이 사라진 것으로 보였다.
// 창을 줄이면 다시 보여서 원인을 짚기까지 시간이 걸렸다.
//
// 화면을 눈으로 봐야만 알 수 있는 결함이라 테스트가 잡을 수 있는 것은 **구조**뿐이다:
// 높이 체인이 CSS 에 있고(`html`→`body`→`#root`), 앱 루트가 뷰포트 단위를 다시 쓰지 않는 것.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('고정 셸 — 높이는 CSS 체인에서 온다', () => {
  it('index.css 가 html·body·#root 의 높이와 overflow 를 못박는다', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf-8');
    // 선택자 셋이 한 규칙에 모여 있어야 체인이 끊기지 않는다 — 하나만 100% 여도 그 아래가 auto 다.
    const rule = /html,\s*body,\s*#root\s*\{[^}]*\}/m.exec(css)?.[0] ?? '';
    expect(rule).toMatch(/height:\s*100%/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  it('화면 루트가 뷰포트 단위를 쓰지 않는다 — 배율이 걸리면 그 값이 보이는 높이와 어긋난다', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf-8');
      // className 안의 뷰포트 높이 유틸리티만 본다(주석의 언급은 회귀가 아니다).
      for (const m of text.matchAll(/className=\{?["'`][^"'`]*\b(h-screen|min-h-screen|h-\[100vh\])\b/g)) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
