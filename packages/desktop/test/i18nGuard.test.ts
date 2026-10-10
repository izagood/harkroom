import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { en } from '../src/i18n/en';

/**
 * **화면 글자는 사전을 지난다** — 코드에 박힌 글자를 막는 회귀선(i18n 검토 2026-10-10, P4).
 *
 * 설정 › 업데이트 화면이 제목만 한국어이고 칸·버튼·곁 문단이 영어로 박혀 있었다. `ko.ts` 가
 * `satisfies Catalog` 라 **키가 빠지는 것**은 tsc 가 막지만, **키를 안 거친 글자**는 아무도
 * 막지 않았다. 이 시험이 그 자리다.
 *
 * ## 무엇을 잡나
 *
 * TS 파서로 `src/**\/*.tsx` 를 읽어 (1) JSX 글자, (2) `label`·`title`·`placeholder`·`aria-label`·`alt`·
 * `description`·`hint` 속성에 문자열을 바로 쓴 것, (3) JSX `{…}` 안에 바로 쓴 문자열(삼항 갈래 포함)을
 * 모은다. 정규식이 아니라 파서인 까닭은 `jsxCommentText.test.ts` 와 같다 — 같은 글자가 주석·
 * className 안이면 정상이고, 그 둘을 가르는 것은 구문 트리뿐이다.
 *
 * **말이 아닌 것은 뺀다**: 공백 없는 한 낱말 중 소문자·숫자·`/ . : @ _ *` 가 든 것(`izagood/harkroom`·
 * `api-token`·`X-Api-Key`·`https://…` 같은 입력 예시), 그리고 제품·고유 이름(`BRANDS`). 한글은 언제나 잡는다 —
 * 영어로 고른 사람에게 그대로 보이기 때문이다.
 *
 * ## 허용 목록은 **줄이기만 한다**
 *
 * 지금 남은 자리는 `i18nHardcoded.allow.json` 에 파일별 글자로 동결했다(줄 번호가 아니라 글자라
 * 위아래 편집에 안 흔들린다). 새로 박으면 빨강이고, 사전으로 옮겼는데 목록에 남아 있어도 빨강이다 —
 * 그래야 목록이 낡지 않는다. 화면을 옮기는 PR(P3-x)은 그 파일의 줄을 지운다.
 */
const SRC = resolve(process.cwd(), 'src');

const ATTRS = new Set([
  'label', 'title', 'placeholder', 'aria-label', 'alt', 'description', 'hint',
  // 컴포넌트 prop 으로 화면 글을 넘기는 자리(P4b) — `<ConfirmDialog confirmLabel="Delete">` 가 이 틈으로 빠졌다.
  'ariaLabel', 'confirmLabel', 'cancelLabel', 'detail',
]);
/**
 * **객체 literal 의 속성**으로 화면 글을 넘기는 자리(P4b, designer·security 권장). 메뉴 항목
 * `{ label: 'Copy text', onSelect }` 은 JSX 속성이 아니라 객체 속성이라 P4 가드가 못 봤고, 캡처에서야
 * 영어로 남은 것이 드러났다(#1303). 메뉴·선택지·탭·확인창 설정이 다 이 꼴이다.
 */
const PROPS = new Set([...ATTRS, 'text', 'emptyText', 'confirm', 'cancel']);
/** 번역하지 않는 이름. 사람이 화면·문서·터미널에서 같은 글자로 본다. */
const BRANDS = new Set(['Harkroom', 'harkroom', 'Claude', 'Codex', 'OpenCode', 'Cursor', 'API', 'MCP', 'GitHub', 'Esc', 'DM', 'PAT', 'ID']);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'i18n' ? [] : tsxFiles(p);
    return p.endsWith('.tsx') && !/\.test\.tsx$/.test(p) ? [p] : [];
  });
}

function isLanguage(raw: string): boolean {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (/[가-힣]/.test(text)) return true;
  if (!/[A-Za-z]{2,}/.test(text)) return false;
  if (BRANDS.has(text)) return false;
  if (!/\s/.test(text) && (/[/.:@_*<>{}=0-9-]/.test(text) || !/[A-Z]/.test(text))) return false;
  return true;
}

function literalsIn(expr: ts.Expression): ts.StringLiteralLike[] {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr];
  if (ts.isParenthesizedExpression(expr)) return literalsIn(expr.expression);
  if (ts.isConditionalExpression(expr)) return [...literalsIn(expr.whenTrue), ...literalsIn(expr.whenFalse)];
  if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(expr.operatorToken.kind)) {
    return literalsIn(expr.right);
  }
  return [];
}

/** 파일 하나에서 사전을 안 거친 화면 글자. */
function hardcodedTexts(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const push = (text: string) => {
    const norm = text.replace(/\s+/g, ' ').trim();
    if (isLanguage(norm)) out.push(norm);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) push(node.text);
    else if (ts.isJsxAttribute(node) && node.initializer && ATTRS.has(node.name.getText(sf))) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) push(init.text);
      else if (ts.isJsxExpression(init) && init.expression) literalsIn(init.expression).forEach((l) => push(l.text));
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      literalsIn(node.expression).forEach((l) => push(l.text));
    } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && PROPS.has(node.name.text)) {
      literalsIn(node.initializer).forEach((l) => push(l.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function collect(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of tsxFiles(SRC)) {
    const texts = hardcodedTexts(file, readFileSync(file, 'utf8'));
    if (texts.length) found[relative(SRC, file)] = texts;
  }
  return found;
}

const allowed = JSON.parse(readFileSync(resolve(process.cwd(), 'test/i18nHardcoded.allow.json'), 'utf8')) as Record<string, string[]>;

describe('화면 글자는 사전을 지난다', () => {
  const found = collect();

  it('허용 목록 밖에 박힌 글자가 없다', () => {
    const extra: string[] = [];
    for (const [file, texts] of Object.entries(found)) {
      const pool = [...(allowed[file] ?? [])];
      for (const text of texts) {
        const i = pool.indexOf(text);
        if (i >= 0) pool.splice(i, 1);
        else extra.push(`${file}: ${JSON.stringify(text)}`);
      }
    }
    // 새로 박았다면 `t('…')` 로 옮겨라. 정말 말이 아니면(입력 예시·고유 이름) `isLanguage`·`BRANDS` 를 고친다.
    expect(extra).toEqual([]);
  });

  it('허용 목록에 이미 옮긴 글자가 남아 있지 않다 — 목록은 줄이기만 한다', () => {
    const stale: string[] = [];
    for (const [file, texts] of Object.entries(allowed)) {
      const pool = [...(found[file] ?? [])];
      for (const text of texts) {
        const i = pool.indexOf(text);
        if (i >= 0) pool.splice(i, 1);
        else stale.push(`${file}: ${JSON.stringify(text)}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('잡는 것과 안 잡는 것 — 판정이 이 모양이다', () => {
    const src = `export const A = () => (<div title="Close" aria-label={busy ? 'Saving…' : t('x')}>
      Check now {t('y')} <input placeholder="izagood/harkroom" /> <b>Harkroom</b> <i>터미널</i> {'·'}
      <span className="text-fg">{label}</span></div>);`;
    expect(hardcodedTexts('x.tsx', src)).toEqual(['Close', 'Saving…', 'Check now', '터미널']);
  });

  it('객체 속성·컴포넌트 prop 으로 넘긴 화면 글도 잡는다(P4b)', () => {
    const src = `const items = [{ label: 'Copy text', onSelect }, { label: t('x') }, { id: 'Not text' }];
      const C = () => <ConfirmDialog confirmLabel="Delete" cancelLabel={busy ? 'Wait' : t('y')} title={t('z')} />;`;
    expect(hardcodedTexts('x.tsx', src)).toEqual(['Copy text', 'Delete', 'Wait']);
  });
});

/**
 * **안 쓰는 키가 없다.** 사전에만 남은 문구는 번역가가 옮기고 리뷰어가 읽지만 화면에는 안 뜬다 —
 * 지운 화면의 흔적이다. 쓰임은 `src/` 에서 키 글자가 따옴표째 나오는지, 또는 키를 이어 붙여 만드는
 * 자리(`` `agents.scope.${x}` ``·`'nav.' + x`)의 머리로 시작하는지로 판정한다.
 */
describe('사전에 안 쓰는 키가 없다', () => {
  /** 화면은 안 쓰지만 남겨 두는 키 — 이유를 함께 적는다. */
  const KEEP = new Set([
    // 채널 빈 화면 팁이 이 메뉴 이름을 그대로 인용하는지 `i18n.test.tsx` 가 잰다(메뉴 이름의 정본).
    'sidebar.menu.edit',
  ]);

  it('모든 키가 src 어딘가에서 쓰인다', () => {
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'i18n') walk(p); }
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p);
    });
    walk(SRC);
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const prefixes = [...all.matchAll(/[`'"]([a-zA-Z][\w-]*(?:\.[\w-]+)*\.)(?:\$\{|['"]\s*\+)/g)].map((m) => m[1]!);
    const unused = Object.keys(en).filter((key) =>
      !KEEP.has(key)
      && !["'", '"', '`'].some((q) => all.includes(`${q}${key}${q}`))
      && !prefixes.some((p) => key.startsWith(p)));
    expect(unused).toEqual([]);
  });
});
