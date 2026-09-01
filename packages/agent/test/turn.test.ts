import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnCommand, writeMcpConfigOnce } from '../src/turn.js';

const base = {
  systemPrompt: 'SYS', promptCtx: 'CTX', model: null, effort: null,
  mentionPermission: 'auto' as const, mcpConfigPath: '/mcp.json', pat: 'murp_x',
};

describe('buildTurnCommand — claude', () => {
  it('첫 멘션 턴: session-id 할당 + bypassPermissions + PAT 는 env 로만', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.command).toBe('claude');
    expect(p.args).toEqual(expect.arrayContaining(['-p', '--session-id', 'uuid-1', '--permission-mode', 'bypassPermissions', '--mcp-config', '/mcp.json', '--append-system-prompt', 'SYS', 'CTX']));
    expect(p.args).not.toContain('-r');
    expect(p.env.MURMUR_PAT).toBe('murp_x');
    expect(p.args.join(' ')).not.toContain('murp_x');   // argv 에 PAT 금지 (spec §7)
  });

  it('resume 멘션 턴: -r <id>, readonly 는 plan 모드', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: false, mentionPermission: 'readonly' });
    expect(p.args).toEqual(expect.arrayContaining(['-r', 'uuid-1', '--permission-mode', 'plan']));
    expect(p.args).not.toContain('--session-id');
  });

  it('인터랙티브 턴: -p 없음, 권한 플래그 없음 — 사람이 답한다 (spec §6)', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'interactive', sessionId: 'uuid-1', isFirstTurn: false });
    expect(p.args).not.toContain('-p');
    expect(p.args).not.toContain('--permission-mode');
    expect(p.args).toEqual(expect.arrayContaining(['-r', 'uuid-1']));
  });

  it('영구 설정을 바꾸는 플래그가 절대 없다 (spec §6)', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args).not.toContain('--dangerously-skip-permissions');
  });

  // 브리프의 케이스에는 없지만, strict-mcp-config 가 이 설계의 존재 이유 중 하나다(spec §7) —
  // 없으면 운영자의 전역 MCP 목록(Slack·Gmail·Drive 등, task-1 스파이크 실측)이 함께 상속된다.
  // 멘션·인터랙티브 어느 쪽에서 빠져도 같은 구멍이라 두 모드 다 확인한다.
  it('claude 는 멘션·인터랙티브 어느 모드든 --strict-mcp-config 를 항상 받는다', () => {
    const mention = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 's', isFirstTurn: false });
    const interactive = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'interactive', sessionId: 's', isFirstTurn: false });
    expect(mention.args).toContain('--strict-mcp-config');
    expect(interactive.args).toContain('--strict-mcp-config');
  });
});

describe('buildTurnCommand — codex', () => {
  it('첫 턴은 sessionId 없이도 조립된다 — codex 는 id 를 사전 할당할 수 없다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: null, isFirstTurn: true });
    expect(p.command).toBe('codex');
    expect(p.args[0]).toBe('exec');
    expect(p.args).not.toContain('resume');
  });

  it('resume 턴은 exec resume <id>', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 'sid-9', isFirstTurn: false });
    expect(p.args.slice(0, 3)).toEqual(['exec', 'resume', 'sid-9']);
  });

  it('권한은 sandbox 단독이다 — codex exec 에 -a 는 없다 (실측)', () => {
    const auto = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(auto.args).toEqual(expect.arrayContaining(['-s', 'workspace-write']));
    expect(auto.args).not.toContain('-a');
    expect(auto.args).not.toContain('danger-full-access');
    const ro = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false, mentionPermission: 'readonly' });
    expect(ro.args).toEqual(expect.arrayContaining(['-s', 'read-only']));
  });

  it('MCP 는 턴별 -c 오버라이드다 — codex mcp add 는 config.toml 을 영구 변경한다 (spec §6)', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args.join(' ')).toContain('-c mcp_servers.');
    expect(p.args).not.toContain('mcp');           // `codex mcp add` 경로로 새지 않는다
    expect(p.args.join(' ')).not.toContain('murp_'); // PAT 는 env 로만
  });

  // 인터랙티브 턴은 화면 앞에 사람이 있다 — exec 서브커맨드도, sandbox 플래그도, 프롬프트
  // 위치인자도 없어야 한다(spec §4·§6). 이 조각들을 빠뜨리면 codex resume 이 비대화형처럼
  // 동작하거나(-s 가 남아 승인 흐름이 안 뜸), 사람이 입력할 자리에 옛 프롬프트가 끼어든다.
  it('인터랙티브 턴은 exec·sandbox·프롬프트 위치인자를 전부 생략한다 — 순수 resume', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'interactive', sessionId: 'sid-1', isFirstTurn: false });
    expect(p.args[0]).toBe('resume');
    expect(p.args[1]).toBe('sid-1');
    expect(p.args).not.toContain('exec');
    expect(p.args).not.toContain('-s');
    expect(p.args.join(' ')).not.toContain('CTX'); // promptCtx 는 mention 전용(브리프 인터페이스 주석)
  });

  // buildTurnCommand 의 opts 에는 murmurUrl 이 없다 — 있는 값(mcpConfigPath, pat)만으로는
  // codex 의 `-c mcp_servers.murmur.url=...` 을 채울 수 없다(claude 는 파일에 이미 구워
  // 넣혀 있어 필요 없지만 codex 는 파일을 안 읽는다). 그래서 murmurUrl 을 선택 인자로 열어
  // 뒀고, 없으면 murmur 등록을 조용히 틀리게 하느니 avcs 만 등록한다 — 정직한 기능 후퇴.
  it('murmurUrl 을 안 주면 codex 는 avcs 만 등록하고 murmur 는 뺀다 — 조용히 틀린 URL 을 넣지 않는다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args.join(' ')).toContain('mcp_servers.avcs.command');
    expect(p.args.join(' ')).not.toContain('mcp_servers.murmur');
  });

  it('murmurUrl 을 주면 -c mcp_servers.murmur.url 과 bearer_token_env_var 가 붙는다 — PAT 값 자체는 여전히 안 붙는다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false, murmurUrl: 'http://localhost:3401/mcp' });
    expect(p.args.join(' ')).toContain('mcp_servers.murmur.url="http://localhost:3401/mcp"');
    expect(p.args.join(' ')).toContain('mcp_servers.murmur.bearer_token_env_var="MURMUR_PAT"');
    expect(p.args.join(' ')).not.toContain('murp_x');
  });
});

describe('buildTurnCommand — gemini', () => {
  it('미지원을 명확한 에러로 거절한다 — -r 이 uuid 를 받지 않는다 (실측)', () => {
    expect(() => buildTurnCommand({ ...base, harness: 'gemini', mode: 'mention', sessionId: 's', isFirstTurn: false }))
      .toThrow(/gemini/);
  });
});

describe('buildTurnCommand — 잘못된 호출 상태', () => {
  // sessionId null 은 "codex 의 첫 멘션 턴"이라는 정확히 하나의 경우에만 유효하다
  // (sessions.ts 의 SessionRecord 주석: null 은 "아직 첫 턴을 못 돌렸다"). 그 밖의 조합—
  // resume 인데 id 가 없다, claude 인데 id가 없다 — 는 호출자가 세션을 먼저 확보하지
  // 않은 결함이다. 결함을 조용히 삼켜 이상한 명령을 조립하느니 여기서 크게 던진다.
  it('resume 턴(isFirstTurn=false)인데 sessionId 가 null 이면 던진다 — 호출자 결함', () => {
    expect(() => buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: null, isFirstTurn: false })).toThrow();
    expect(() => buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: null, isFirstTurn: false })).toThrow();
  });

  it('claude 는 첫 턴이라도 sessionId 가 null 이면 던진다 — claude 는 러너가 미리 uuid 를 발급해야 한다', () => {
    expect(() => buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: null, isFirstTurn: true })).toThrow();
  });

  it('인터랙티브 턴은 codex 라도 sessionId 가 null 이면 던진다 — 이어받을 세션이 없다', () => {
    expect(() => buildTurnCommand({ ...base, harness: 'codex', mode: 'interactive', sessionId: null, isFirstTurn: true })).toThrow();
  });
});

describe('buildTurnCommand — 빈 문자열 인자 금지', () => {
  // 일부 CLI 는 빈 문자열 위치인자를 진짜 값으로 취급해 이상하게 실패한다(예: 빈 프롬프트를
  // "질문"으로 읽음). promptCtx·systemPrompt 가 둘 다 비어 있으면 그 자리를 통째로 뺀다.
  it('promptCtx 와 systemPrompt 가 둘 다 비어 있으면 그 자리를 아예 뺀다(claude)', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 's', isFirstTurn: false, systemPrompt: '', promptCtx: '' });
    expect(p.args).not.toContain('');
    expect(p.args).not.toContain('--append-system-prompt');
  });

  it('promptCtx 와 systemPrompt 가 둘 다 비어 있으면 그 자리를 아예 뺀다(codex)', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false, systemPrompt: '', promptCtx: '' });
    expect(p.args).not.toContain('');
  });
});

describe('writeMcpConfigOnce', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('murmur(http, 플레이스홀더 PAT) + avcs(stdio, avcs mcp) 둘만 담은 파일을 쓴다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const path = await writeMcpConfigOnce(dir, 'http://localhost:3401');
    const config = JSON.parse(await readFile(path, 'utf8'));
    expect(config.mcpServers.murmur).toEqual({
      type: 'http', url: 'http://localhost:3401/mcp', headers: { Authorization: 'Bearer ${MURMUR_PAT}' },
    });
    expect(config.mcpServers.avcs).toEqual({ type: 'stdio', command: 'avcs', args: ['mcp'] });
    expect(Object.keys(config.mcpServers)).toHaveLength(2); // murmur + avcs 만 — strict-mcp-config 와 짝
  });

  // 실값이 아니라 플레이스홀더이므로 파일 자체는 비밀이 아니다(spec §7) — 그래도 실수로
  // 실제 PAT 문자열이 섞여 들어가는 회귀를 여기서 잡는다.
  it('생성된 파일에 실제 PAT 값은 절대 들어가지 않는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const path = await writeMcpConfigOnce(dir, 'http://localhost:3401');
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('${MURMUR_PAT}');
    expect(raw).not.toMatch(/murp_[a-zA-Z0-9]/);
  });

  // 러너가 세션마다 한 번씩만 부르는 게 이상적이지만, main.ts 가 실수로 두 번 불러도(예:
  // 재시도 경로) 깨지면 안 된다 — 두 번째 호출도 같은 결과를 내고 에러를 던지지 않는다.
  it('두 번 불러도 에러 없이 같은 내용을 낸다 — 멱등', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-cfg-'));
    const first = await writeMcpConfigOnce(dir, 'http://localhost:3401');
    const second = await writeMcpConfigOnce(dir, 'http://localhost:3401');
    expect(second).toBe(first);
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'));
  });
});
