import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runnerLabel } from '../src/config.js';

/**
 * #174 의 배선 회귀선.
 *
 * `resolveAgentStateDir` 의 단위 테스트는 **경로를 계산하는 규칙**만 지킨다. 러너가 그
 * 경로를 실제로 쓰는지는 다른 사실이고, `main.ts` 는 top-level await 로 진짜 서버에
 * 붙으려 들어 import 로 확인할 수 없다(그 파일 맨 위 주석이 그 이유를 적는다).
 *
 * 그래서 여기서는 **소스를 읽는다.** 손으로 배선을 흉내낸 테스트는 러너가 세션 파일을
 * 옛 뿌리에서 열어도 초록으로 통과한다 — 그리고 그것이 정확히 이 이슈가 막으려는
 * 사고다(두 인스턴스가 한 `sessions.json` 을 밟으면 인스턴스 B 가 A 의 세션 id 를
 * 자기 워크스페이스에서 resume 하려 든다).
 */
const SRC = new URL('../src/', import.meta.url).pathname;
const readSrc = (name: string) => readFile(join(SRC, name), 'utf8');

describe('#174 러너가 인스턴스 경로를 실제로 쓴다', () => {
  it('main.ts 가 인스턴스를 경로 계산에 넘긴다', async () => {
    const main = await readSrc('main.ts');
    expect(main).toMatch(/resolveAgentStateDir\([\s\S]{0,200}?config\.agentInstance/);
  });

  /**
   * 요구 4 — 세션 파일·MCP 설정·avcs 워크스페이스가 **계산된 경로에서** 온다.
   * 러너가 이 셋 중 하나라도 자기가 이어 붙이면 그 하나만 인스턴스 밖에 남을 수 있다.
   */
  it('세션 파일·MCP 설정·워크스페이스 뿌리를 러너가 직접 이어 붙이지 않는다', async () => {
    const main = await readSrc('main.ts');
    expect(main).toContain('new SessionStore(sessionsPath)');
    expect(main).toContain('writeMcpConfigOnce(mcpDir');
    expect(main).toMatch(/workspaceBaseDir,/);
    // 상태 경로를 여기서 조립하는 흔적이 없어야 한다. `join(config.stateDir, ...)` 은
    // **레거시 경로 한 곳**만 허용한다 — 그것은 옛 파일의 존재를 경고하기 위한 것이고
    // 상태를 쓰는 경로가 아니다.
    expect(main).not.toMatch(/join\(\s*agentStateDir/);
    const legacyOnly = main.replace(/const legacySessionsPath = join\(config\.stateDir, 'sessions\.json'\);\n/, '');
    expect(legacyOnly).not.toMatch(/join\(\s*config\.stateDir/);
  });

  /** 요구 5 — 기동 로그에 handle 과 인스턴스가 함께 적힌다. */
  it('기동 로그가 runnerLabel 로 handle 과 인스턴스를 적는다', async () => {
    const main = await readSrc('main.ts');
    expect(main).toContain('runnerLabel(me.handle, config.agentInstance)');
    // 상태 디렉터리도 적는다 — 운영자가 격리가 실제로 걸렸는지 로그에서 확인해야 한다.
    expect(main).toMatch(/console\.log\(`상태 디렉터리: \$\{agentStateDir\}`\)/);
  });

  it('runnerLabel 은 인스턴스가 없어도 default 를 적는다', () => {
    expect(runnerLabel('forge', undefined)).toBe('@forge[default]');
    expect(runnerLabel('forge', 'a')).toBe('@forge[a]');
    // 두 인스턴스의 라벨이 달라야 `ps` 로 구분할 수 있다.
    expect(runnerLabel('forge', 'a')).not.toBe(runnerLabel('forge', 'b'));
  });
});

/**
 * 요구 6 — **`hasOwnPostSince` 는 고치지 않는다.** 인스턴스별로 자기 발화를 가르려 하면
 * 판정이 두 벌이 되고, at-least-once 는 이 저장소가 이미 택한 성질이다(README 가 중복
 * 답장 가능성을 적는다). 그러므로 인스턴스 값은 턴 로직에 **닿지 않아야** 한다.
 *
 * 이름을 훑는 방식으로 지키는 이유: "닿지 않는다"는 성질은 호출로 표현할 수 없다. 인자를
 * 하나 더 받게 되는 순간 여기가 빨개진다.
 */
describe('#174 인스턴스 값이 턴 로직에 닿지 않는다', () => {
  const ALLOWED = new Set(['config.ts', 'main.ts', 'stateDir.ts']);

  it('인스턴스를 아는 파일은 설정·기동·경로 계산 셋뿐이다', async () => {
    const files = (await readdir(SRC, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.ts'));

    const leaked: string[] = [];
    for (const entry of files) {
      const rel = join(entry.parentPath.slice(SRC.length), entry.name);
      if (ALLOWED.has(rel)) continue;
      const text = await readFile(join(entry.parentPath, entry.name), 'utf8');
      // 주석의 언급은 괜찮다 — 값이 흐르는 것만 문제다. 그래서 식별자 형태만 본다.
      if (/\bagentInstance\b|MURMUR_AGENT_INSTANCE/.test(stripComments(text))) leaked.push(rel);
    }
    expect(leaked).toEqual([]);
  });

  it('prompt.ts 의 발화 판정은 인자로 messages·meId·sinceSeq 만 받는다', async () => {
    const prompt = await readSrc('prompt.ts');
    expect(prompt).toContain(
      'export function hasOwnPostSince(messages: MessageRow[], meId: string, sinceSeq: number): boolean',
    );
    expect(prompt).toContain(
      'export function countOwnPostsSince(messages: MessageRow[], meId: string, sinceSeq: number): number',
    );
  });
});

/** 주석·문자열이 아닌 코드만 남긴다. 완전한 파서가 아니라 이 검사에 필요한 만큼이다. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
