import { tmpdir } from 'node:os';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPtyRecorder, PTY_RECORD_MAX_BYTES } from '../src/ptyRecorder.js';
import { runPtyTurn } from '../src/pty.js';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'helpers/fake-harness.mjs');

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ptyrec-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function onlyFile(d: string): Promise<string> {
  const files = await readdir(d);
  expect(files).toHaveLength(1);
  return join(d, files[0]!);
}

describe('openPtyRecorder', () => {
  it('폴더가 없거나 상대 경로면 끔(null)이다', () => {
    expect(openPtyRecorder(null, { label: 'x', cols: 80, rows: 24 })).toBeNull();
    expect(openPtyRecorder('rel/dir', { label: 'x', cols: 80, rows: 24 })).toBeNull();
  });

  it('asciicast v2: 헤더 한 줄 + 출력·크기 바꿈 줄, 명령·환경은 헤더에 없다', async () => {
    let t = 1_000_000;
    const rec = openPtyRecorder(join(dir, 'rec'), { label: 'claude', cols: 120, rows: 40 }, () => t)!;
    t += 500; rec.output('\x1b[2Jhello 한글');
    t += 250; rec.resize(100, 30);
    rec.close();
    rec.output('after close');
    const file = await onlyFile(join(dir, 'rec'));
    expect(file).toMatch(/-claude-\d+\.cast$/);
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ version: 2, width: 120, height: 40, timestamp: 1000, env: { TERM: 'xterm-256color' } });
    expect(lines.slice(1)).toEqual([[0.5, 'o', '\x1b[2Jhello 한글'], [0.75, 'r', '100x30']]);
  });

  it('파일은 0600, 폴더는 0700 으로 만든다', async () => {
    const rec = openPtyRecorder(join(dir, 'rec'), { label: 'codex', cols: 80, rows: 24 })!;
    rec.close();
    expect((await stat(join(dir, 'rec'))).mode & 0o777).toBe(0o700);
    expect((await stat(await onlyFile(join(dir, 'rec')))).mode & 0o777).toBe(0o600);
  });

  it('하네스 이름이 경로 조각이 되지 않는다', async () => {
    openPtyRecorder(dir, { label: '../../evil name', cols: 80, rows: 24 })!.close();
    expect(await onlyFile(dir)).toMatch(/-______evil_name-\d+\.cast$/);
  });

  it('상한을 넘는 출력부터는 적지 않는다', async () => {
    const rec = openPtyRecorder(dir, { label: 'big', cols: 80, rows: 24 })!;
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 40; i++) rec.output(chunk);
    rec.close();
    expect((await stat(await onlyFile(dir))).size).toBeLessThanOrEqual(PTY_RECORD_MAX_BYTES);
  });
});

describe('runPtyTurn 녹화', () => {
  const plan = { command: process.execPath, args: [fake], env: { FAKE_MODE: 'ok' } as Record<string, string>, stdinFile: null };

  it('recordDir 를 주면 그 턴의 출력이 파일에 남는다', async () => {
    const r = await runPtyTurn(plan, { cwd: process.cwd(), timeoutMs: 10_000, recordDir: dir });
    expect(r.exitCode).toBe(0);
    const body = await readFile(await onlyFile(dir), 'utf8');
    const out = body.trim().split('\n').slice(1).map((l) => JSON.parse(l) as [number, string, string]);
    expect(out.every(([, kind]) => kind === 'o')).toBe(true);
    expect(out.map(([, , d]) => d).join('')).toContain('done');
  });

  it('recordDir 가 없으면(기본) 아무 파일도 만들지 않는다', async () => {
    await runPtyTurn(plan, { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(await readdir(dir)).toEqual([]);
  });
});
