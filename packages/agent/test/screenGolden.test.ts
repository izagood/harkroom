// Rust 화면 엔진(`crates/harkroom-screen`)이 이 TS 판정과 같은 답을 내는지 맞추는 골든(S3a, Rust 전환).
//
// 이 시험이 **정본(TS)의 답**을 `crates/harkroom-screen/golden/screen.json` 에 적힌 것과 비교한다. 다르면 빨강 —
// TS 판정(어댑터 화면 패턴·`classifyScreen`·`screenAnswerLines`·`screenShowsProgress`)을 바꿨다면
// `UPDATE_SCREEN_GOLDEN=1 npx vitest run test/screenGolden.test.ts` 로 다시 쓰고, Rust 쪽 `cargo test` 가 같은 파일로 따라오는지 본다.
// 패턴 원문도 적어 두어, TS 패턴이 바뀌면 Rust 표(번역본)가 낡았다는 것을 Rust 시험이 잡는다.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../src/adapters/index.js';
import { classifyScreen, screenAnswerLines } from '../src/screenIdle.js';
import { screenShowsProgress } from '../src/screenLife.js';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless as unknown as typeof import('@xterm/headless');

const FIXTURES = join(import.meta.dirname, 'fixtures');
const GOLDEN = join(import.meta.dirname, '..', '..', '..', 'crates', 'harkroom-screen', 'golden', 'screen.json');
const HARNESSES = ['claude-code', 'codex', 'opencode', 'kilo', 'pi', 'omp'] as const;
const PAIRED = ['codex', 'opencode', 'kilo', 'pi', 'omp'] as const;
/** 가짜 작업 폴더 — 답 줄에서 폴더 조각을 거르는 갈래를 함께 고정한다. */
const CWD = '/home/example/.harkroom-agent/00000000-aaaa-4bbb-8ccc-000000000001/workspaces/harkroom-00000000-aaaa-4bbb-8ccc-000000000001-0f0f0f0f';

const fx = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const src = (r: RegExp | undefined): string | null => (r ? `/${r.source}/${r.flags}` : null);

function screenOf(h: (typeof HARNESSES)[number]) {
  const a = ADAPTERS[h];
  if (a === 'unsupported') throw new Error(h);
  return a.screen;
}

/**
 * 번역이 까다로운 갈래만 겨눈 한 줄 표본 — fixture 가 안 밟는 곳(앞보기·`\\b`·`\\d`·`^` 여러 줄)을 정본 판정으로 고정한다.
 * `\u00a0` 는 claude 입력창의 비분리 공백, `٣` 는 아랍 숫자(JS `\\d` 는 ASCII 만 받는다).
 */
const LINE_PROBES = [
  '❯\u00a0hello ✔', '❯ hello ✔', '❯✔ Dark mode', '❯1.Dark mode ✔', '  ❯ 1. Yes', 'x ❯ 2. no', 'top\n  › 3. Maybe',
  'Enter to confirm · Esc to cancel', 'Enterto continue', 'Do you want to proceed?', 'Connect a provider',
  'ctx 12%/200k', 'ctx 12%/200kb', 'ctx ٣%/200k', '42% of 1.5M', '42% of 1.5Mb', '42%x1K', 'Working…', '⠋ 12s >', '─── ⠙ Working',
  'Ask Codex to do anything', 'Ask anything', 'ctrl+p', 'esc to interrupt', 'esc interrupt',
];

/** 진행 판정(`screenShowsProgress`) 표본 — 제어열만·깜빡이 표시만·글자 섞임. */
const PROGRESS_SAMPLES = [
  '', ' ', '\x1b[H\r\x1b[9B\x1b[38;5;246m⏺\x1b[39m\x1b[40;1H\x1b[22;2H', '\x1b[22;2H ', '\x1b]0;title\x07', '\x1b]8;;http://x\x1b\\',
  'a', '\x1b[2K12s', '⏺ Reading file', '●', '\x1b[?2026h\x1b[?2026l', '\r\n', '\x1b(B', '한글', '\x1b[38;2;1;2;3m', '\x1b[3',
];

/** 원 바이트(제어열이 든) fixture 를 지금 러너와 같은 headless 터미널(120×40)에 그린 화면 글. */
async function renderXterm(raw: string): Promise<string> {
  const t = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  await new Promise<void>((done) => t.write(raw, done));
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < t.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
  t.dispose();
  return out.join('\n');
}

async function build() {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt')).sort();
  const patterns = Object.fromEntries(HARNESSES.map((h) => {
    const s = screenOf(h);
    return [h, { ready: src(s.ready), busy: src(s.busy), gate: src(s.gate) }];
  }));
  const classify = fixtures.flatMap((f) => HARNESSES.map((h) => {
    const s = screenOf(h);
    return { fixture: f, harness: h, state: classifyScreen(fx(f), { ready: s.ready, gate: s.gate, busy: s.busy }) };
  }));
  const answers = PAIRED.flatMap((h) => {
    const s = screenOf(h);
    const facts = { ready: s.ready, busy: s.busy };
    const ended = fx(`${h}-tui-ended.txt`);
    const before = fx(`${h}-tui-busy.txt`);
    return [
      { harness: h, fixture: `${h}-tui-ended.txt`, before: `${h}-tui-busy.txt`, cwd: null, lines: screenAnswerLines(ended, facts, before) },
      { harness: h, fixture: `${h}-tui-ended.txt`, before: null, cwd: CWD, lines: screenAnswerLines(ended, facts, null, CWD) },
    ];
  });
  // 제어열이 든 fixture 는 화면 글이 아니라 PTY 바이트다 — 에뮬레이터를 거친 결과를 골든으로 둔다(Rust 는 vt100 으로 그려 같은지 본다).
  const rendered = [];
  for (const f of fixtures.filter((x) => fx(x).includes('\x1b'))) {
    const text = await renderXterm(fx(f));
    rendered.push({
      fixture: f, text,
      states: Object.fromEntries(HARNESSES.map((h) => { const s = screenOf(h); return [h, classifyScreen(text, { ready: s.ready, gate: s.gate, busy: s.busy })]; })),
    });
  }
  const probes = LINE_PROBES.map((text) => ({
    text,
    states: Object.fromEntries(HARNESSES.map((h) => { const s = screenOf(h); return [h, classifyScreen(text, { ready: s.ready, gate: s.gate, busy: s.busy })]; })),
  }));
  const progress = PROGRESS_SAMPLES.map((text) => ({ text, progress: screenShowsProgress(text) }));
  return { note: 'generated by packages/agent/test/screenGolden.test.ts — do not edit by hand', fixtures, patterns, classify, answers, rendered, probes, progress };
}

describe('Rust 화면 엔진 골든', () => {
  it('정본(TS) 판정이 golden/screen.json 과 같다', async () => {
    const now = `${JSON.stringify(await build(), null, 1)}\n`;
    if (process.env.UPDATE_SCREEN_GOLDEN === '1') writeFileSync(GOLDEN, now);
    expect(readFileSync(GOLDEN, 'utf8')).toBe(now);
  });
});
