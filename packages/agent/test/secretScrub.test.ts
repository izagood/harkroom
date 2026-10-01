import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubFile, scrubNeedles, scrubPath, scrubText, SCRUB_MAX_DEPTH, SCRUB_MAX_FILE_BYTES } from '../src/secretScrub.js';
import { truncateSync } from 'node:fs';
import { harnessTailNotice } from '../src/prompt.js';
import { codexRolloutFileFor } from '../src/codexSessions.js';
import { mkdirSync } from 'node:fs';

// 비밀 보관소 D7 — 하네스 기록 가리기. 스레드 bc98df3a. 토큰 모양 리터럴은 조립한다(gitleaks).
const VALUE = `ghp_${'d'.repeat(36)}`;
const MULTI = ['-----BEGIN TEST KEY-----', 'S'.repeat(40), 'T'.repeat(40), '-----END TEST KEY-----'].join('\n');

describe('secretScrub', () => {
  it('평문·JSON 안의 평문·URL·base64 를 가리고, 8바이트 미만은 보지 않는다', () => {
    const needles = scrubNeedles(Buffer.from(VALUE));
    const line = JSON.stringify({ a: `x ${VALUE} y`, b: Buffer.from(VALUE).toString('base64'), c: encodeURIComponent(`${VALUE}!`) });
    const { text, replaced } = scrubText(line, needles);
    expect(replaced).toBe(3);
    expect(text).not.toContain(VALUE);
    expect(JSON.parse(text).a).toBe('x *** y');
    expect(scrubNeedles(Buffer.from('short'))).toEqual([]);
  });

  it('여러 줄 값은 jsonl 의 이스케이프된 통째와 줄 하나를 다 가리고, 줄은 JSON 으로 남는다', () => {
    const needles = scrubNeedles(Buffer.from(MULTI));
    const jsonl = [
      JSON.stringify({ type: 'tool_result', content: `cat k.pem\n${MULTI}\n` }),
      JSON.stringify({ type: 'assistant', text: `the second line is ${'S'.repeat(40)}` }),
    ].join('\n');
    const { text } = scrubText(jsonl, needles);
    expect(text).not.toContain('S'.repeat(40));
    expect(text).not.toContain('T'.repeat(40));
    for (const l of text.split('\n')) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('파일을 바꿔 쓰되 mode 를 지키고, 심링크는 건드리지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-scrub-'));
    const f = join(dir, 's.jsonl');
    writeFileSync(f, `${JSON.stringify({ t: VALUE })}\n`);
    chmodSync(f, 0o600);
    expect(await scrubFile(f, scrubNeedles(Buffer.from(VALUE)))).toBe(1);
    expect(readFileSync(f, 'utf8')).toBe(`${JSON.stringify({ t: '***' })}\n`);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const target = join(dir, 'target.txt');
    writeFileSync(target, VALUE);
    symlinkSync(target, join(dir, 'link.jsonl'));
    expect(await scrubFile(join(dir, 'link.jsonl'), scrubNeedles(Buffer.from(VALUE)))).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(VALUE);
    expect(await scrubFile(join(dir, 'missing.jsonl'), scrubNeedles(Buffer.from(VALUE)))).toBe(0);
  });

  it('codex rollout 은 파일 이름의 세션 id 로 찾는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-codex-'));
    const id = '0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
    mkdirSync(join(dir, '2026', '10', '01'), { recursive: true });
    const f = join(dir, '2026', '10', '01', `rollout-2026-10-01T09-00-00-${id}.jsonl`);
    writeFileSync(f, '{}\n');
    expect(await codexRolloutFileFor(dir, id)).toBe(f);
    expect(await codexRolloutFileFor(dir, '0199a2b3-c4d5-7e6f-8a9b-000000000000')).toBeNull();
  });

  it('T1: 세션 디렉터리 아래 tool-results·subagents 파일도 가리고, 심링크·깊이 상한 밖은 건드리지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hk-sess-'));
    const sess = join(root, '11111111-2222-4333-8444-555555555555');
    mkdirSync(join(sess, 'tool-results'), { recursive: true });
    mkdirSync(join(sess, 'subagents'), { recursive: true });
    const tool = join(sess, 'tool-results', 'toolu_01.txt');
    const sub = join(sess, 'subagents', 'agent-1.jsonl');
    writeFileSync(tool, `long output\n${VALUE}\nmore`);
    writeFileSync(sub, `${JSON.stringify({ text: VALUE })}\n`);
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, VALUE);
    symlinkSync(outside, join(sess, 'tool-results', 'link.txt'));
    symlinkSync(root, join(sess, 'loop'));
    let deep = sess;
    for (let i = 0; i < SCRUB_MAX_DEPTH; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'too-deep.txt'), VALUE);
    const n = await scrubPath(sess, scrubNeedles(Buffer.from(VALUE)));
    expect(n).toBe(2);
    expect(readFileSync(tool, 'utf8')).toBe('long output\n***\nmore');
    expect(readFileSync(sub, 'utf8')).not.toContain(VALUE);
    expect(readFileSync(outside, 'utf8')).toBe(VALUE);
    expect(readFileSync(join(deep, 'too-deep.txt'), 'utf8')).toBe(VALUE);
    expect(await scrubPath(join(root, 'nope'), scrubNeedles(Buffer.from(VALUE)))).toBe(0);
  });

  it('64MB 를 넘는 파일은 건너뛰되 경로를 알린다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-big-'));
    const big = join(dir, 'big.txt');
    writeFileSync(big, '');
    truncateSync(big, SCRUB_MAX_FILE_BYTES + 1);   // 희소 파일 — 디스크를 쓰지 않는다
    const skipped: string[] = [];
    expect(await scrubPath(dir, scrubNeedles(Buffer.from(VALUE)), (p) => skipped.push(p))).toBe(0);
    expect(skipped).toEqual([big]);
  });

  it('실패 통지의 PTY 꼬리: 마운트한 값은 가리고, 화면 폭에서 접힌 값이면 출력을 싣지 않는다', () => {
    const needles = scrubNeedles(Buffer.from(VALUE));
    expect(harnessTailNotice(`$ cat k\r\n${VALUE}\r\ndone`, '', needles)).toBe('$ cat k\n(가림)\ndone');
    const wrapped = `$ cat k\r\n${VALUE.slice(0, 20)}\r\n${VALUE.slice(20)}\r\ndone`;
    expect(harnessTailNotice(wrapped, '', needles)).toBe('(마지막 출력에 비밀 값이 섞여 있어 싣지 않았다)');
    expect(harnessTailNotice('plain output', '', needles)).toBe('plain output');
    // U1 ① claude TUI 가 들여쓰기·⎿ 를 붙여 접은 값
    const tui = `⏺ Bash(cat k)\r\n  ⎿  ${VALUE.slice(0, 18)}\r\n     ${VALUE.slice(18)}\r\n`;
    expect(harnessTailNotice(tui, '', needles)).toBe('(마지막 출력에 비밀 값이 섞여 있어 싣지 않았다)');
    // U1 ② 꼬리 버퍼가 앞을 잘라 값의 뒤 절반으로 시작하는 꼬리
    const cut = `${VALUE.slice(VALUE.length / 2)}\r\n$ done`;
    expect(harnessTailNotice(cut, '', needles)).toBe('(마지막 출력에 비밀 값이 섞여 있어 싣지 않았다)');
  });
});
