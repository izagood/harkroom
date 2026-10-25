import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_LINK_ENV, RUNNER_TURN_KEY_ENV, TURN_KEY_PATTERN, TURN_KEYS_END_PATH, TURN_KEYS_PATH } from '@harkroom/shared/runnerLink';
import { buildTurnCommand, turnKeyDelivery } from '../src/turn.js';
import { endTurnKeys, issueTurnKeys, registerTurnKeys, TurnKeyRegisterError } from '../src/turnKeys.js';
import { writeOpencodeTurnMcpConfig, writeTurnMcpConfig } from '../src/providerLane.js';

const base = {
  systemPrompt: 'SYS', promptCtx: 'CTX', model: null, effort: null,
  mentionPermission: 'auto' as const, mcpConfigPath: '/mcp.json',
  operatorBin: '/opt/harkroom/harkroom-operator', codexHome: '/state/codex-home',
  systemPromptFile: '/state/system-prompt.txt', stdinFile: null, claudeConfigDir: null,
  mode: 'mention' as const, isFirstTurn: true,
};
const keys = { bridge: 'b'.repeat(64), shell: 'c'.repeat(64) };

describe('턴 열쇠 — 발급', () => {
  it('32바이트 hex 둘, 서로 다르다', () => {
    const k = issueTurnKeys();
    expect(k.bridge).toMatch(TURN_KEY_PATTERN);
    expect(k.shell).toMatch(TURN_KEY_PATTERN);
    expect(k.bridge).not.toBe(k.shell);
  });
});

describe('턴 열쇠 — relay 맡기기·끝내기', () => {
  it('200 이면 통과, 아니면 던진다(띄우지 않는다) — 문장에 열쇠 값이 없다', async () => {
    const sent: { path: string; body?: string }[] = [];
    await registerTurnKeys({ request: async (r) => { sent.push(r); return { status: 200 }; } }, { turnId: 't1', cause: 'm1', keys });
    expect(sent[0]!.path).toBe(TURN_KEYS_PATH);
    expect(JSON.parse(sent[0]!.body!)).toEqual({ turnId: 't1', cause: 'm1', keys });
    const err = await registerTurnKeys({ request: async () => ({ status: 404 }) }, { turnId: 't1', cause: null, keys }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnKeyRegisterError);
    expect(String((err as Error).message)).not.toContain(keys.bridge);
    await expect(registerTurnKeys({ request: async () => { throw new Error('closed'); } }, { turnId: 't1', cause: null, keys })).rejects.toBeInstanceOf(TurnKeyRegisterError);
  });
  it('끝내기는 실패를 삼킨다', async () => {
    const sent: string[] = [];
    await endTurnKeys({ request: async (r) => { sent.push(r.path); throw new Error('x'); } }, 't1');
    expect(sent).toEqual([TURN_KEYS_END_PATH]);
  });
});

describe('턴 열쇠 — 하네스 env', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env[RUNNER_LINK_ENV.secret] = 'runner-secret-value';
    process.env[RUNNER_TURN_KEY_ENV.shell] = 'stale';
    process.env[RUNNER_TURN_KEY_ENV.bridge] = 'stale';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('claude: runner secret 빠짐 · 셸 열쇠만 · 다리 열쇠는 env 에 없다(MCP 설정으로 간다)', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', sessionId: 'u1', turnKeys: keys });
    expect(p.env[RUNNER_LINK_ENV.secret]).toBeUndefined();
    expect(p.env[RUNNER_TURN_KEY_ENV.shell]).toBe(keys.shell);
    expect(p.env[RUNNER_TURN_KEY_ENV.bridge]).toBeUndefined();
    expect(p.args.join(' ')).not.toContain(keys.bridge);
  });
  it('codex: 다리 열쇠는 env 에 두고 이름만 env_vars 에 · 셸에서는 거른다 · argv 에 값이 없다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', sessionId: null, turnKeys: keys });
    expect(p.env[RUNNER_LINK_ENV.secret]).toBeUndefined();
    expect(p.env[RUNNER_TURN_KEY_ENV.shell]).toBe(keys.shell);
    expect(p.env[RUNNER_TURN_KEY_ENV.bridge]).toBe(keys.bridge);
    const argv = p.args.join(' ');
    expect(argv).not.toContain(keys.bridge);
    expect(argv).not.toContain(keys.shell);
    expect(p.args).toContain(`shell_environment_policy.exclude=${JSON.stringify([RUNNER_TURN_KEY_ENV.bridge])}`);
    // 셸 스냅숏·로그인 셸이 하네스 env 를 셸에 되살리지 못하게 둘 다 끈다(G2 실물 회귀).
    expect(p.args).toContain('features.shell_snapshot=false');
    expect(p.args).toContain('allow_login_shell=false');
    expect(p.args).toContain('features.code_mode=false');
    const envVars = p.args.find((a) => a.startsWith('mcp_servers.harkroom.env_vars='))!;
    expect(envVars).toContain(RUNNER_TURN_KEY_ENV.bridge);
  });
  it('열쇠 없는 턴: 러너 env 에 남은 열쇠 이름을 물려주지 않고 secret 은 그대로(옛 자격)', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', sessionId: 'u1' });
    expect(p.env[RUNNER_LINK_ENV.secret]).toBe('runner-secret-value');
    expect(p.env[RUNNER_TURN_KEY_ENV.shell]).toBeUndefined();
    expect(p.env[RUNNER_TURN_KEY_ENV.bridge]).toBeUndefined();
  });
  it('전달 길이 없는 하네스에 열쇠를 주면 조립을 거절한다', () => {
    expect(turnKeyDelivery('kilo')).toBe(false);
    expect(() => buildTurnCommand({ ...base, harness: 'kilo', sessionId: null, opencodeHome: '/state/kilo', turnKeys: keys })).toThrow(/다리 열쇠/);
  });
});

describe('턴 MCP 설정', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'turnmcp-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it('harkroom 항목 env 에 다리 열쇠만 얹고 0600 으로 쓴다', async () => {
    const src = join(dir, 'mcp.json');
    await writeFile(src, JSON.stringify({ mcpServers: { harkroom: { command: '/op', args: ['mcp-bridge'], env: { A: '1' } }, avcs: { command: 'avcs' } } }));
    const path = await writeTurnMcpConfig(join(dir, 'state'), src, '0f8e-1', keys.bridge);
    const doc = JSON.parse(await readFile(path, 'utf8'));
    expect(doc.mcpServers.harkroom.env).toEqual({ A: '1', [RUNNER_TURN_KEY_ENV.bridge]: keys.bridge });
    expect(doc.mcpServers.avcs).toEqual({ command: 'avcs' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(writeTurnMcpConfig(join(dir, 'state'), src, '../x', keys.bridge)).rejects.toThrow();
  });
  it('API 키 연결 턴만 harkroom 항목에 alwaysLoad — 구독형 턴은 미뤄 둔 그대로', async () => {
    const src = join(dir, 'mcp.json');
    await writeFile(src, JSON.stringify({ mcpServers: { harkroom: { command: '/op', args: ['mcp-bridge'] }, avcs: { command: 'avcs' } } }));
    const lane = JSON.parse(await readFile(await writeTurnMcpConfig(join(dir, 'state'), src, 't-lane', keys.bridge, { alwaysLoad: true }), 'utf8'));
    expect(lane.mcpServers.harkroom.alwaysLoad).toBe(true);
    expect(lane.mcpServers.avcs.alwaysLoad).toBeUndefined();
    const sub = JSON.parse(await readFile(await writeTurnMcpConfig(join(dir, 'state'), src, 't-sub', keys.bridge), 'utf8'));
    expect(sub.mcpServers.harkroom.alwaysLoad).toBeUndefined();
  });
});

describe('턴 열쇠 — opencode 전달(턴 설정 파일)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tk-oc-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const source = async () => {
    const p = join(dir, 'mcp.json');
    await writeFile(p, JSON.stringify({ mcpServers: { harkroom: { type: 'stdio', command: '/opt/op', args: ['mcp-bridge'] }, avcs: { type: 'stdio', command: 'avcs', args: ['mcp'] } } }));
    return p;
  };

  it('그 밖의 턴: harkroom 항목만 통째로 새 파일에, environment 에 다리 열쇠 · 0600', async () => {
    const path = await writeOpencodeTurnMcpConfig(dir, await source(), 't-1', keys.bridge, null);
    expect(path).toBe(join(dir, 'turn-mcp', 't-1.opencode.json'));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      mcp: { harkroom: { type: 'local', command: ['/opt/op', 'mcp-bridge'], enabled: true, environment: { [RUNNER_TURN_KEY_ENV.bridge]: keys.bridge } } },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('API 키 연결 턴: lane 턴 파일에 더해 쓴다 — provider 칸은 그대로', async () => {
    const lane = join(dir, 'lane.json');
    await writeFile(lane, JSON.stringify({ provider: { 'harkroom-lane': { options: { baseURL: 'https://gateway.example/v1' } } } }));
    expect(await writeOpencodeTurnMcpConfig(dir, await source(), 't-2', keys.bridge, lane)).toBe(lane);
    const doc = JSON.parse(await readFile(lane, 'utf8'));
    expect(doc.provider['harkroom-lane'].options.baseURL).toBe('https://gateway.example/v1');
    expect(doc.mcp.harkroom.environment[RUNNER_TURN_KEY_ENV.bridge]).toBe(keys.bridge);
  });

  it('하네스 env: OPENCODE_CONFIG 가 턴 파일 · 셸 열쇠만 · 다리 열쇠·링크 secret 없음 · 파일 없이 열쇠만 주면 던진다', () => {
    expect(turnKeyDelivery('opencode')).toBe(true);
    const plan = buildTurnCommand({ ...base, harness: 'opencode', sessionId: null, opencodeHome: '/state/oc', turnKeys: keys, opencodeTurnConfig: '/state/turn-mcp/t.opencode.json' });
    expect(plan.env.OPENCODE_CONFIG).toBe('/state/turn-mcp/t.opencode.json');
    expect(plan.env[RUNNER_TURN_KEY_ENV.shell]).toBe(keys.shell);
    expect(plan.env[RUNNER_TURN_KEY_ENV.bridge]).toBeUndefined();
    expect(plan.env[RUNNER_LINK_ENV.secret]).toBeUndefined();
    expect(() => buildTurnCommand({ ...base, harness: 'opencode', sessionId: null, opencodeHome: '/state/oc', turnKeys: keys })).toThrow();
  });
});
