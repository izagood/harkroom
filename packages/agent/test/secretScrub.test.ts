import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubFile, scrubNeedles, scrubText } from '../src/secretScrub.js';
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
});
