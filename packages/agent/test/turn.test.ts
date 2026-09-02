import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTurnCommand, preassignsSessionId, writeMcpConfigOnce } from '../src/turn.js';

// murmurUrl 은 **서버 베이스 URL이다, MCP 엔드포인트가 아니다** — main.ts::loadConfig 가
// 실제로 주는 값(`http://localhost:3400` 류, `/mcp` 없음)과 맞춘다. 예전엔 여기 이미
// `/mcp` 가 붙은 값을 fixture 로 썼는데, 그러면 CODEX_PRESET.mcp 가 `/mcp` 를 안 붙이는
// 결함이 있어도(실물 검증에서 발견 — turn.ts::mcpUrl 참고) 값이 우연히 맞아떨어져 테스트가
// 그 결함을 못 잡았다. 프로덕션이 실제로 주는 모양으로 고쳐야 이 종류의 결함을 다시 잡는다.
const base = {
  systemPrompt: 'SYS', promptCtx: 'CTX', model: null, effort: null,
  mentionPermission: 'auto' as const, mcpConfigPath: '/mcp.json', pat: 'murp_x',
  murmurUrl: 'http://localhost:3401',
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

  // 실물 확인(codex-cli 0.148.0): `codex exec`/`codex exec resume` 에는 이 플래그가 있지만
  // `codex resume`(인터랙티브)에는 **없다** — 넘기면 `error: unexpected argument` 로 파싱이
  // 깨져 인터랙티브 턴이 통째로 안 뜬다. `-s` 가 exec 에만 있고 exec resume 에는 없던 것과
  // 같은 모양의 비대칭이라, 그때처럼 실물이 깨뜨리기 전에 여기서 막는다.
  it('인터랙티브 턴 argv 에는 --skip-git-repo-check 가 들어가지 않는다 — codex resume 은 이 플래그를 안 받는다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'interactive', sessionId: 's', isFirstTurn: false });
    expect(p.args).not.toContain('--skip-git-repo-check');
  });

  // 인터랙티브 턴은 화면 앞에 사람이 있다 — exec 서브커맨드도, sandbox 오버라이드도, 프롬프트
  // 위치인자도 없어야 한다(spec §4·§6). 이 조각들을 빠뜨리면 codex resume 이 비대화형처럼
  // 동작하거나(sandbox_mode 가 남아 승인 흐름이 안 뜸), 사람이 입력할 자리에 옛 프롬프트가 끼어든다.
  it('인터랙티브 턴은 exec·sandbox·프롬프트 위치인자를 전부 생략한다 — 순수 resume', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'interactive', sessionId: 'sid-1', isFirstTurn: false });
    expect(p.args[0]).toBe('resume');
    expect(p.args[1]).toBe('sid-1');
    expect(p.args).not.toContain('exec');
    expect(p.args.join(' ')).not.toContain('sandbox_mode');
    expect(p.args.join(' ')).not.toContain('CTX'); // promptCtx 는 mention 전용(브리프 인터페이스 주석)
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
