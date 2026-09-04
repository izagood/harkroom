import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_ENV_DENYLIST, assertHarnessContract, buildTurnCommand, preassignsSessionId, writeMcpConfigOnce, writePromptFile, writeSystemPromptFile } from '../src/turn.js';

// murmurUrl 은 **서버 베이스 URL이다, MCP 엔드포인트가 아니다** — main.ts::loadConfig 가
// 실제로 주는 값(`http://localhost:3400` 류, `/mcp` 없음)과 맞춘다. 예전엔 여기 이미
// `/mcp` 가 붙은 값을 fixture 로 썼는데, 그러면 CODEX_PRESET.mcp 가 `/mcp` 를 안 붙이는
// 결함이 있어도(실물 검증에서 발견 — turn.ts::mcpUrl 참고) 값이 우연히 맞아떨어져 테스트가
// 그 결함을 못 잡았다. 프로덕션이 실제로 주는 모양으로 고쳐야 이 종류의 결함을 다시 잡는다.
const base = {
  systemPrompt: 'SYS', promptCtx: 'CTX', model: null, effort: null,
  mentionPermission: 'auto' as const, mcpConfigPath: '/mcp.json', pat: 'murp_x',
  murmurUrl: 'http://localhost:3401',
  // 프로덕션(`mentionTurn.ts`)은 매 턴 `writeSystemPromptFile` 로 파일을 쓰고 그 경로를
  // 반드시 넘긴다 — fixture 가 null 로 두면 프로덕션이 절대 타지 않는 경로를 검증하게 된다.
  systemPromptFile: '/state/system-prompt.txt',
  // stdinFile 도 필수 필드다 — 기본값은 null(인터랙티브·resume 경로).
  stdinFile: null,
};

// 실물 검증에서 드러난 회귀 — pty.spawn 에 env 를 넘기면 node-pty 가 부모 env 와 **병합하지
// 않고 대체**한다(unixTerminal.js: `opt.env = opt.env || process.env`). buildTurnCommand 가
// `{ MURMUR_PAT }` 하나만 돌려주던 때는 이 값이 그대로 자식의 전체 env 가 되어 PATH·HOME 이
// 사라지고 harness 를 못 찾거나 로그인 자격증명을 못 읽어 모든 실물 턴이 즉시 실패했다
// (turn.ts::childEnv). 이 테스트는 그 반환값 자체(생성자 출력)를 겨눈다 — `p.env.MURMUR_PAT`
// 만 보던 예전 단언들은 `{ MURMUR_PAT: 'x' }` 하나짜리 env 로도 통과했으므로 이 결함을 못
// 잡았다.
describe('buildTurnCommand — env 는 부모를 물려받는다 (실물 검증에서 드러난 회귀)', () => {
  it('PATH·HOME 등 부모 env 를 물려주고 MURMUR_PAT 만 덮어쓴다', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.env.PATH).toBe(process.env.PATH);
    if (process.env.HOME) expect(p.env.HOME).toBe(process.env.HOME);
    expect(p.env.MURMUR_PAT).toBe('murp_x');
  });
});

describe('buildTurnCommand — claude', () => {
  // 지시문이 argv 로 직접 전달되면 다른 로컬 사용자가 ps 로 볼 수 있다.
  // --append-system-prompt-file 로 파일로 전달하고, 그 파일은 world-readable 이면 안 된다.
  it('첫 멘션 턴: 지시문은 argv 에 직접 없고 파일로 전달된다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-prompt-'));
    const filePath = await writeSystemPromptFile(dir, 'SYS');
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true, systemPromptFile: filePath });
    expect(p.command).toBe('claude');
    expect(p.args).not.toContain('--append-system-prompt');
    expect(p.args).not.toContain('SYS');
    expect(p.args).toContain('--append-system-prompt-file');
    expect(p.args).toContain(filePath);
    expect(p.args).not.toContain('-r');
    expect(p.env.MURMUR_PAT).toBe('murp_x');
    await rm(dir, { recursive: true, force: true });
  });

  it('지시문 파일의 내용은 systemPrompt 와 같고 퍼미션은 0600 이다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sys-prompt-'));
    const filePath = await writeSystemPromptFile(dir, 'SYS');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('SYS');
    const stat = await import('node:fs/promises').then(m => m.stat(filePath));
    expect(stat.mode & 0o777).toBe(0o600);
    await rm(dir, { recursive: true, force: true });
  });

  // argv 폴백을 남기지 않는다 — `murmurUrl` 과 같은 처우다. 조용히 넘어가는 경로를 두면 그
  // 경로가 결국 쓰이고, 여기서는 그게 곧 지시문이 `ps` 로 새는 것이다(#92).
  it('지시문이 있는데 파일 경로가 없으면 조립 자체가 실패한다', () => {
    expect(() => buildTurnCommand({
      ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true,
      systemPromptFile: null,
    })).toThrow(/파일로만 받는다/);
  });

  // 지시문 본문이 argv 어디에도 없어야 한다 — 플래그만 확인하면 "파일도 넘기고 본문도
  // 넘기는" 조합을 놓친다.
  it('claude 멘션 argv 에 지시문 본문이 없다', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.args).not.toContain('SYS');
    expect(p.args.join(' ')).not.toContain('SYS');
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

  // #337: "세션 없는 스레드에서 [터미널 열기]" — 인터랙티브에도 첫 턴이 생겼다. resume(-r)
  // 으로 조립하면 존재한 적 없는 세션을 이어받으려다 "No conversation found" 로 죽고,
  // 반대로 이미 대화한 세션에 --session-id 를 다시 주면 "Session ID already in use" 로
  // 죽는다(둘 다 스파이크 실측) — isFirstTurn 이 두 갈래를 가르는 유일한 신호다.
  it('인터랙티브 첫 턴: --session-id <id> (비-p) — resume 이 아니다 (#337)', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'interactive', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.args).toEqual(expect.arrayContaining(['--session-id', 'uuid-1']));
    expect(p.args).not.toContain('-p');
    expect(p.args).not.toContain('-r');
    expect(p.args).not.toContain('--permission-mode');
    // 첫 턴도 PTY stdin 은 사람의 것이다 — stdin 파일 리다이렉션이 붙으면 안 된다.
    expect(p.stdinFile).toBeNull();
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

  // codex 만 필요한 --skip-git-repo-check 가 claude argv 에 붙으면 claude 는 모르는 플래그라
  // 턴이 뜨지 못한다. 표에 필드를 더할 때 다른 harness 로 새는 것을 이 테스트가 막는다.
  it('claude argv 에는 --skip-git-repo-check 가 절대 들어가지 않는다 — claude 에 없는 플래그다', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.args).not.toContain('--skip-git-repo-check');
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

  // `-s workspace-write` 는 `codex exec resume <id>` 에서 실제로 죽는다(실물 CLI 재현:
  // `error: unexpected argument '-s' found`) — `-s` 는 비-resume `codex exec` 에만 있다.
  // 그래서 권한은 `-s` 가 아니라 `-c sandbox_mode="…"` 하나로, 첫 턴·resume 턴 양쪽에 쓴다.
  it('권한은 -c sandbox_mode 다 — -s 는 어디에도 없다 (resume 에서 실제로 파싱 실패했다)', () => {
    const auto = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(auto.args.join(' ')).toContain('sandbox_mode="workspace-write"');
    expect(auto.args).not.toContain('-s');
    expect(auto.args).not.toContain('-a');
    expect(auto.args).not.toContain('danger-full-access');
    const ro = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false, mentionPermission: 'readonly' });
    expect(ro.args.join(' ')).toContain('sandbox_mode="read-only"');
    expect(ro.args).not.toContain('-s');
  });

  // "새 세션" 행과 "권한" 행이 직교하지 않았던 것이 이번 결함의 정체다 — 첫 턴에 통하던
  // 플래그가 resume 턴에서 파싱 오류를 냈다. 같은 기전을 쓰는지 직접 비교해 그 재발을 막는다.
  it('첫 턴과 resume 턴이 같은 권한 기전(-c sandbox_mode)을 쓴다 — 직교하지 않는 조합 재발 방지', () => {
    const firstTurn = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: null, isFirstTurn: true });
    const resumeTurn = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(firstTurn.args.join(' ')).toContain('sandbox_mode="workspace-write"');
    expect(resumeTurn.args.join(' ')).toContain('sandbox_mode="workspace-write"');
    expect(firstTurn.args).not.toContain('-s');
    expect(resumeTurn.args).not.toContain('-s');
  });

  it('MCP 는 턴별 -c 오버라이드다 — codex mcp add 는 config.toml 을 영구 변경한다 (spec §6)', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args.join(' ')).toContain('-c mcp_servers.');
    expect(p.args).not.toContain('mcp');           // `codex mcp add` 경로로 새지 않는다
    expect(p.args.join(' ')).not.toContain('murp_'); // PAT 는 env 로만
  });

  // avcs workspace 는 git 저장소가 아니다 — codex 가 "신뢰되지 않은 디렉터리"로 거부한다.
  // --skip-git-repo-check 로 이 검사를 건너뛰게 한다(avcs workspace 가 murmur 의 격리 경로라는
  // spec §3 설계 결정에 따른다). exec·resume 양쪽에 모두 필요하므로, 첫 턴·resume 턴 모두 확인한다.
  it('첫 멘션 턴 argv 에 --skip-git-repo-check 가 들어간다 — avcs workspace 가 git repo 가 아니다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: null, isFirstTurn: true });
    expect(p.args).toContain('--skip-git-repo-check');
  });

  it('resume 턴 argv 에도 --skip-git-repo-check 가 들어간다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args).toContain('--skip-git-repo-check');
  });

  // #337 스파이크(codex-cli 0.147.0 실측): `codex resume` 은 `--ignore-user-config` 를
  // 파싱 단계에서 거부한다 — 그 플래그 없이 열면 운영자 ~/.codex/config.toml 의 개인
  // MCP(Slack·Gmail·Drive)를 통째로 상속해, §7 이 멘션 턴에서 막은 구멍이 인터랙티브로
  // 다시 열린다. 그래서 codex 인터랙티브는 **명확한 에러로 거절한다**(스펙 §5-2 결정 8).
  // 이 거절이 "미구현" 으로 읽히지 않게 에러 문구가 이유(플래그·config 상속)를 말해야 한다.
  it('codex 인터랙티브 턴은 명확한 에러로 거절한다 — resume 이 --ignore-user-config 를 못 받는다 (§5-2 결정 8)', () => {
    expect(() => buildTurnCommand({ ...base, harness: 'codex', mode: 'interactive', sessionId: 's', isFirstTurn: false }))
      .toThrow(/--ignore-user-config.*config\.toml/s);
    // 첫 턴(세션 없음)도 같은 거절이다 — 맨 `codex` 로 여는 경로도 config 상속은 같다.
    expect(() => buildTurnCommand({ ...base, harness: 'codex', mode: 'interactive', sessionId: null, isFirstTurn: true }))
      .toThrow(/인터랙티브 턴은 지원하지 않는다/);
  });

  // --ignore-user-config 는 claude 의 --strict-mcp-config 와 같은 목적이다: 운영자의
  // ~/.codex/config.toml 에 등록된 MCP(Slack·Gmail·Drive 등)를 무시한다. 없으면 채널에서
  // 멘션할 수 있는 사람이 운영자 개인 계정에 도달한다. 이 플래그는 codex exec·exec resume 에만
  // 있고 codex resume(인터랙티브)에는 **없다** — 그걸로 인해 인터랙티브 턴이 파싱 오류로
  // 깨지는 것을 막는다.
  it('첫 멘션 턴 argv 에 --ignore-user-config 가 들어간다 — 운영자 전역 MCP 무시', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: null, isFirstTurn: true });
    expect(p.args).toContain('--ignore-user-config');
  });

  it('resume 턴 argv 에도 --ignore-user-config 가 들어간다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args).toContain('--ignore-user-config');
  });

  // claude 는 자체 --strict-mcp-config 로 처리하므로 codex 용 --ignore-user-config 가
  // claude argv 에 새면 안 된다 — 없는 플래그를 붙여 턴이 깨지는 것을 방지한다.
  it('claude argv 에는 --ignore-user-config 가 절대 들어가지 않는다 — claude 는 다른 플래그다', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args).not.toContain('--ignore-user-config');
  });

  // 러너는 더 이상 하네스 출력을 파싱하지 않는다 — 에이전트가 답하는 유일한 경로가 murmur
  // MCP 의 `message.post` 다(prompt.ts). murmur MCP 가 안 붙은 codex 턴은 에러 없이 그냥
  // 돌다가 답을 못 하고, 러너는 "답 없이 턴을 끝냈습니다"만 남긴다 — 원인 단서가 없는 조용한
  // 실패다. 그래서 murmurUrl 은 선택이 아니라 필수이고, codex 의 모든 턴에 반드시 붙는다.
  it('codex 턴의 argv 에는 murmur MCP 등록이 항상 들어 있다 — PAT 값 자체는 여전히 안 붙는다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false, murmurUrl: 'http://localhost:3401' });
    expect(p.args.join(' ')).toContain('mcp_servers.avcs.command');
    expect(p.args.join(' ')).toContain('mcp_servers.murmur.url="http://localhost:3401/mcp"');
    expect(p.args.join(' ')).toContain('mcp_servers.murmur.bearer_token_env_var="MURMUR_PAT"');
    expect(p.args.join(' ')).not.toContain('murp_x');
  });

  // 실물 검증에서 드러난 회귀 — murmurUrl 은 서버 베이스 URL 이지 MCP 엔드포인트가 아닌데
  // codex 쪽 조립이 `/mcp` 를 안 붙여, codex 가 `POST /`(베이스 URL)를 때려 서버의
  // `404 route not found` 로 MCP 연결 자체가 안 됐다. 증상은 조용했다 — exit 0, message.post
  // 못 부름, "(답 없이 턴을 끝냈습니다)"만 남았다. 위 테스트는 murmurUrl 에 이미 `/mcp` 가
  // 붙은 값을 넘겨 이 결함을 가렸다 — 이 테스트는 **베이스 URL 만 주고** 조립된 값이 실제
  // 엔드포인트(`/mcp`)와 같은지를 겨눈다.
  it('murmurUrl 에 이미 트레일링 슬래시가 있어도 /mcp 가 정확히 한 번만 붙는다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false, murmurUrl: 'http://localhost:3401/' });
    expect(p.args.join(' ')).toContain('mcp_servers.murmur.url="http://localhost:3401/mcp"');
    expect(p.args.join(' ')).not.toContain('http://localhost:3401//mcp');
  });

  // murmurUrl 을 빈 문자열로 넘기면 타입 체크는 통과하지만(string), 그대로 두면
  // `mcp_servers.murmur.url=""` 같은 값이 조용히 조립돼 위와 같은 조용한 실패로 이어진다 —
  // 런타임에서도 막는다.
  it('murmurUrl 이 빈 문자열이면 던진다 — 조용히 틀린 URL 을 조립하지 않는다', () => {
    expect(() => buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false, murmurUrl: '' })).toThrow();
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

  // #337: 인터랙티브 **첫 턴**이 생기면서 "인터랙티브 + null id" 를 통째로 거르던 초판
  // 불변식은 완화됐다 — 대신 resume(isFirstTurn=false)인데 id 가 없는 조합은 모드와
  // 무관하게 여전히 결함이다.
  it('인터랙티브 resume 인데 sessionId 가 null 이면 던진다 — 이어받을 세션이 없다', () => {
    expect(() => buildTurnCommand({ ...base, harness: 'claude-code', mode: 'interactive', sessionId: null, isFirstTurn: false })).toThrow(/세션 id/);
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

describe('preassignsSessionId', () => {
  // main.ts::runMentionTurn 이 새 SessionRecord 를 만들 때 이 값으로 sessionId 를
  // randomUUID() 로 채울지 null 로 둘지 정한다 — harness 이름 비교가 두 곳(여기·main.ts)에
  // 갈리지 않게 이 표 하나로만 결정한다.
  it('claude 는 러너가 미리 uuid 를 발급해야 한다', () => {
    expect(preassignsSessionId('claude-code')).toBe(true);
  });

  it('codex 는 첫 턴을 돌기 전엔 세션 id 가 없다', () => {
    expect(preassignsSessionId('codex')).toBe(false);
  });

  it('미지원 harness 는 명확히 던진다', () => {
    expect(() => preassignsSessionId('gemini')).toThrow(/gemini/);
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

describe('assertHarnessContract', () => {
  // RUNNABLE_HARNESSES 에 unsupported 인 harness 가 있으면 기동 시점에서 실패한다.
  // 이 테스트는 주입된 목록으로 검사한다(프로덕션 상수를 오염시키지 않음).
  // codex 를 함께 넣어도 통과한다 — 이 검사가 보는 것은 "PRESETS 에 구현이 있는가"이고
  // codex 는 구현돼 있다. RUNNABLE_HARNESSES 에 아직 없는 것은 별개의 판단(실물 resume
  // 왕복 미확인, docs/roadmap.md §5)이지 구현 부재가 아니다.
  it('PRESETS 에 구현이 있는 목록이면 통과한다', () => {
    expect(() => assertHarnessContract(['claude-code', 'codex'])).not.toThrow();
  });

  it('unsupported harness 가 있으면 던진다', () => {
    expect(() => assertHarnessContract(['claude-code', 'gemini'])).toThrow(/계약 불일치/);
    expect(() => assertHarnessContract(['gemini'])).toThrow(/계약 불일치/);
  });

  // 기본값(RUNNABLE_HARNESSES)으로도 통과해야 한다 — 이것이 회귀 방지선이다.
  it('기본값(RUNNABLE_HARNESSES)으로도 통과한다', () => {
    expect(() => assertHarnessContract()).not.toThrow();
  });
});

describe('buildTurnCommand — stdin 파일로 대화 본문 이동(#117)', () => {
  // stdinFile 이 있으면 plan.stdinFile 에 경로가 들어가고, argv 에는 아무것도 안 들어간다.
  // 이 수정은 argv 에 있으면 같은 머신의 다른 로컬 사용자가 `ps -ef` 로 스레드 내용을
  // 그대로 읽는 문제를 해결한다(#92, #117).
  it('claude mention: plan.args 에 대화 본문(promptCtx) 문자열이 없다', () => {
    const p = buildTurnCommand({
      ...base,
      harness: 'claude-code',
      mode: 'mention',
      sessionId: 'uuid-1',
      isFirstTurn: true,
      stdinFile: '/state/stdin-prompt.txt',
    });
    expect(p.args).not.toContain('CTX');
    expect(p.args.join(' ')).not.toContain('CTX');
  });

  it('claude mention: plan.args 에 지시문 문자열이 없다', () => {
    const p = buildTurnCommand({
      ...base,
      harness: 'claude-code',
      mode: 'mention',
      sessionId: 'uuid-1',
      isFirstTurn: true,
      stdinFile: '/state/stdin-prompt.txt',
    });
    expect(p.args).not.toContain('SYS');
    expect(p.args.join(' ')).not.toContain('SYS');
  });

  it('claude mention: plan.stdinFile 에 경로가 들어간다', () => {
    const p = buildTurnCommand({
      ...base,
      harness: 'claude-code',
      mode: 'mention',
      sessionId: 'uuid-1',
      isFirstTurn: true,
      stdinFile: '/state/stdin-prompt.txt',
    });
    expect(p.stdinFile).toBe('/state/stdin-prompt.txt');
  });

  it('claude mention: stdinFile 이 null 이면 plan.stdinFile 도 null', () => {
    const p = buildTurnCommand({
      ...base,
      harness: 'claude-code',
      mode: 'mention',
      sessionId: 'uuid-1',
      isFirstTurn: true,
      stdinFile: null,
    });
    expect(p.stdinFile).toBe(null);
  });

  // codex 도 stdin 파일을 통해 프롬프트를 받는다 — 지시문+본문 합쳐서.
  it('codex mention: plan.args 에 대화 본문·지시문 둘 다 없다', () => {
    const p = buildTurnCommand({
      ...base,
      harness: 'codex',
      mode: 'mention',
      sessionId: 'uuid-1',
      isFirstTurn: true,
      stdinFile: '/state/stdin-prompt.txt',
    });
    expect(p.args).not.toContain('CTX');
    expect(p.args).not.toContain('SYS');
    expect(p.args.join(' ')).not.toContain('CTX');
    expect(p.args.join(' ')).not.toContain('SYS');
  });

  it('codex mention: plan.stdinFile 에 경로가 들어간다', () => {
    const p = buildTurnCommand({
      ...base,
      harness: 'codex',
      mode: 'mention',
      sessionId: 'uuid-1',
      isFirstTurn: true,
      stdinFile: '/state/stdin-prompt.txt',
    });
    expect(p.stdinFile).toBe('/state/stdin-prompt.txt');
  });

  // 인터랙티브 모드는 stdinFile 이 null 이어야 한다 — PTY stdin 을 그대로 써야 한다.
  it('인터랙티브 턴: stdinFile 없이 plan.stdinFile 은 null 이다', () => {
    const p = buildTurnCommand({
      ...base,
      harness: 'claude-code',
      mode: 'interactive',
      sessionId: 'uuid-1',
      isFirstTurn: false,
    });
    expect(p.stdinFile).toBe(null);
  });
});

describe('writePromptFile — 0600 권한', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('stdin 용 프롬프트 파일 내용을 정확히 쓰고 퍼미션은 0600 이다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stdin-prompt-'));
    const filePath = await writePromptFile(dir, 'Hello World');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('Hello World');
    const stat = await import('node:fs/promises').then(m => m.stat(filePath));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('빈 문자열도 파일로 쓴다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stdin-prompt-'));
    const filePath = await writePromptFile(dir, '');
    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('');
  });
});

// #374 — 러너가 Claude Code 세션 안에서 뜨면(도그푸딩이 그렇다) 러너 env 에
// `CLAUDE_CODE_CHILD_SESSION` 이 들어 있고, `childEnv` 는 부모 env 를 통째로 복사하므로
// 그 마커가 자식 하네스까지 그대로 갔다. 마커를 물려받은 claude 는 전사 저장을 꺼서
// 세션 파일이 안 생기고, 그러면 다음 턴의 `-r <uuid>` resume 이 성립하지 않는다(#348 §2).
// 이 회귀선은 **부모에 있어도 자식에는 없다**를 두 모드 모두에서 고정한다.
describe('buildTurnCommand — 세션 저장을 끄는 마커는 자식에 물려주지 않는다 (#374)', () => {
  const saved = process.env.CLAUDE_CODE_CHILD_SESSION;
  const savedOther = process.env.CLAUDE_CODE_ENTRYPOINT;

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
    else process.env.CLAUDE_CODE_CHILD_SESSION = saved;
    if (savedOther === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = savedOther;
  });

  it('멘션 턴: 부모에 CLAUDE_CODE_CHILD_SESSION 이 있어도 자식 env 에는 없다', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
  });

  it('인터랙티브 턴: 같은 마커가 자식 env 에는 없다', () => {
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'interactive', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
  });

  // 과잉 삭제 회귀선. `CLAUDE*` 를 통째로 지우면 하네스가 정상 동작에 쓰는 것까지 뺏는다 —
  // denylist 는 실측된 키만 담는다는 규칙을 여기서 고정한다(HARNESS_ENV_DENYLIST 주석).
  it('근거 없는 다른 CLAUDE* 변수는 그대로 물려준다', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.env.CLAUDE_CODE_ENTRYPOINT).toBe('cli');
  });

  // denylist 자체가 비어 버리면 위 두 테스트는 부모 env 에 마커가 없는 기기에서 조용히
  // 통과한다(이 파일은 process.env 를 직접 심으므로 그럴 일은 없지만, 목록이 사라진 것을
  // 알려 주는 신호는 따로 필요하다).
  it('denylist 에 실측된 마커가 들어 있다', () => {
    expect([...HARNESS_ENV_DENYLIST]).toContain('CLAUDE_CODE_CHILD_SESSION');
  });
});
