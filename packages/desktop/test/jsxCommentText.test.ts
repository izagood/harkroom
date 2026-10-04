import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

/**
 * **JSX 자식 자리에 `{}` 없이 쓴 주석은 주석이 아니라 글자다.**
 *
 * `return ( /* … *\/ <div>` 의 주석은 JS 식 자리라 사라진다. 그런데 누가 그 `<div>` 를
 * `<Provider>` 로 감싸면 같은 줄이 **JSX 자식**이 되어 화면에 글자로 찍힌다 — 타입 검사도
 * 빌드도 조용하다. #1115 가 `ChannelPane` 을 `GalleryScopeContext.Provider` 로 감쌌을 때
 * 바로 그렇게 #task 맨 위에 주석이 찍히고, 그 글자가 가로줄의 형제가 되어 채널 본문이
 * 밀려 사라졌다(v0.3.163~v0.3.182, jaebin 보고 2026-10-05).
 *
 * 그래서 소스를 TS 파서로 읽어 **`/*`·`//` 로 시작하는 JsxText 가 없다**를 단언한다.
 * 정규식이 아니라 파서를 쓰는 까닭: 같은 글자가 `{/* … *\/}` 안이나 문자열 안에 있으면
 * 정상이라, 그 둘을 가르는 것은 구문 트리뿐이다.
 */
const SRC = resolve(process.cwd(), 'src');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

/** 파일 하나에서 주석처럼 생긴 JSX 글자를 찾아 `파일:줄` 로 돌려준다. */
function leakedComments(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const t = node.text.trim();
      if (t.startsWith('/*') || t.startsWith('//')) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${relative(process.cwd(), file)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('JSX 자식 자리의 주석', () => {
  it('src 의 어떤 .tsx 도 주석을 글자로 그리지 않는다', () => {
    const leaks = tsxFiles(SRC).flatMap((f) => leakedComments(f, readFileSync(f, 'utf8')));
    expect(leaks).toEqual([]);
  });

  it('검사가 이빨이 있다 — Provider 안의 맨몸 주석은 잡고, {} 안·식 자리 주석은 놓아준다', () => {
    const bad = 'const A = () => (<P>\n  /* 설명 */\n  <div />\n</P>);';
    const line = 'const A = () => (<P>\n  // 설명\n  <div />\n</P>);';
    const ok = 'const A = () => (\n  /* 설명 */\n  <P>{/* 설명 */}<div /></P>);';
    expect(leakedComments('x.tsx', bad)).toHaveLength(1);
    expect(leakedComments('x.tsx', line)).toHaveLength(1);
    expect(leakedComments('x.tsx', ok)).toEqual([]);
  });
});
