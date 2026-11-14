// codex code mode 기록 꼴 hook 대조 — Rust `codex_code_mode_tests.rs` 와 같은 fixture 를 읽는다.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCodexWorkdir } from '../src/codexHook.js';
import { parseExecCell } from '../src/codexCodeMode.js';

type Case = { name: string; lines: unknown[]; input: Record<string, unknown>; expect: 'pass' | 'deny' };
const FIXTURE = fileURLToPath(new URL('../../shared/test/fixtures/codex-code-mode-hook.json', import.meta.url));

let root: string;
let home: string;
let transcript: string;
let fill: (v: unknown) => unknown;
const cases = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: Case[] }).cases;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-code-mode-'));
  home = join(root, 'codex-home');
  await mkdir(join(home, 'sessions'), { recursive: true });
  await mkdir(join(root, 'ws'));
  await mkdir(join(root, 'other'));
  const cwd = await realpath(join(root, 'ws'));
  const other = await realpath(join(root, 'other'));
  transcript = join(home, 'sessions', 'rollout.jsonl');
  fill = (v) => JSON.parse(JSON.stringify(v).replaceAll('{CWD}', cwd).replaceAll('{OTHER}', other).replaceAll('{TRANSCRIPT}', transcript)) as unknown;
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('공유 fixture — code mode 기록 꼴', () => {
  it('fixture 경우가 20개 이상이다', () => { expect(cases.length).toBeGreaterThanOrEqual(20); });
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await writeFile(transcript, `${c.lines.map((l) => JSON.stringify(fill(l))).join('\n')}\n`);
    const input = fill(c.input) as Record<string, unknown> & { tool_input: { command: string } };
    const got = await checkCodexWorkdir(input, input.tool_input.command, home, 1 << 20);
    expect(got === null ? 'pass' : 'deny').toBe(c.expect);
  });
});

describe('parseExecCell — 두 꼴만 받는다', () => {
  it('받는 꼴', () => {
    expect(parseExecCell('tools.exec_command({cmd:"a"})')?.cmd).toBe('a');
    expect(parseExecCell('  await tools.exec_command( { cmd : "a" , } ) ;\n')?.cmd).toBe('a');
    expect(parseExecCell('text(await tools.exec_command({cmd:"a"}))')?.cmd).toBe('a');
  });
  it.each([
    'text(tools.exec_command({cmd:"a"}))',
    'awaittools.exec_command({cmd:"a"})',
    'tools.exec_command({cmd:"a"});;',
    'tools.exec_command({cmd:"a"}) ; x',
    'tools . exec_command({cmd:"a"})',
    'tools.exec_command({workdir:"/w"})',
    'tools.exec_command({cmd:"a",})x',
    'tools.exec_command({cmd:"\\ud800"})',
  ])('거절 %s', (bad) => { expect(parseExecCell(bad)).toBeNull(); });
});
