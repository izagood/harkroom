// 스펙 2026-09-20 §5: **러너는 서버를 모른다.** 서버 URL 도 PAT 도 러너 소스에 없다 — 있어야
// 할 것은 오퍼레이터 소켓과 자기 id·secret, 그리고 하네스에 물려줄 `mcp-bridge` 명령뿐이다.
// 이 파일은 그 경계가 다시 열리지 않는지 지킨다(데스크탑의 `noRunnerLaunch.test.ts` 와 같은
// 종류의 회귀선).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const SRC = join(__dirname, '..', 'src');
const files = walk(SRC).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
const rel = (f: string) => f.slice(SRC.length + 1);

/** 주석은 뺀다 — 이 저장소는 주석에 옛 모양을 많이 인용하고, 그것은 배선이 아니다. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('러너는 서버를 모른다', () => {
  it('HARKROOM_URL·HARKROOM_PAT 을 읽는 코드가 없다', () => {
    const hits = files.filter((f) => /HARKROOM_(URL|PAT)\b/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(hits.map(rel)).toEqual([]);
  });
  it('서버 WS(/agent-relay)도 MCP HTTP 엔드포인트(mcpUrl)도 조립하지 않는다', () => {
    const hits = files.filter((f) => /agent-relay|mcpUrl\(|StreamableHTTPClientTransport/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(hits.map(rel)).toEqual([]);
  });
  it('Bearer 헤더를 만드는 코드가 없다 — 인증은 오퍼레이터의 일이다', () => {
    const hits = files.filter((f) => /Bearer \$\{|authorization:/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(hits.map(rel)).toEqual([]);
  });
});
