import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTurnCommand } from '../src/turn.js';
import { OMP_ADAPTER } from '../src/adapters/omp.js';
import {
  ensureOmpHome, ensureOmpThread, findOmpBinary, ompBinaryOk, OMP_OVERLAY, ompCwdViolations, ompDirs, ompLaneModelsYml, ompReadonlyToolList,
  ompSessionFile, ompThreadDirs, toOmpMcp, writeOmpLaneModels, writeOmpSessionHeader,
} from '../src/ompHome.js';
import { ompLaneVersionOk, providerLaneKeys, PROVIDER_LANE_ARGV_ONLY_KEYS } from '../src/providerLane.js';

const tmp = () => mkdtemp(join(tmpdir(), 'omp-home-'));

describe('ompHome — 저장소 설정 차단(security B4·C2·C4·G1)', () => {
  it('오버레이는 외부 출처·mcp-json 을 막고 xdev·설정 마법사·업데이트 확인을 끈다 — native 는 끄지 않는다(우리 mcp.json 이 native)', () => {
    for (const id of ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'agents-md', 'mcp-json']) expect(OMP_OVERLAY).toContain(`  - ${id}\n`);
    expect(OMP_OVERLAY).not.toMatch(/^\s+- native$/m);
    expect(OMP_OVERLAY).toMatch(/tools:\n {2}xdev: false/);
    expect(OMP_OVERLAY).toMatch(/startup:\n {2}setupWizard: false\n {2}checkUpdate: false/);
  });

  it('스레드 자리는 키마다 고정이고 서로 다르다 — 세션 헤더 cwd 와 같아야 재개된다', () => {
    expect(ompThreadDirs('/s/omp', 'a')).toEqual(ompThreadDirs('/s/omp', 'a'));
    expect(ompThreadDirs('/s/omp', 'a').cwd).not.toBe(ompThreadDirs('/s/omp', 'b').cwd);
    expect(ompThreadDirs('/s/omp', 'a').cwd.startsWith('/s/omp/cwd/')).toBe(true);
  });

  it('ensureOmpThread: cwd 는 git init 한 빈 폴더, agentDir 에는 공유 config·mcp 가 600 으로 복사된다', async () => {
    const root = await tmp();
    const home = join(root, 'omp-home');
    await ensureOmpHome({ ompHome: home, mcpServers: { harkroom: { command: '/bin/op', args: ['mcp-bridge'] } } });
    const t = await ensureOmpThread(home, 'thread-1');
    expect(await readdir(t.cwd)).toEqual(['.git']);
    expect(await readFile(join(t.agentDir, 'config.yml'), 'utf8')).toBe(OMP_OVERLAY);
    expect(JSON.parse(await readFile(join(t.agentDir, 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { harkroom: { command: '/bin/op', args: ['mcp-bridge'] } } });
    expect((await stat(join(t.agentDir, 'mcp.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(ompDirs(home).overlay)).mode & 0o777).toBe(0o600);
    expect(await ompCwdViolations(t.cwd, root)).toEqual([]);
  });

  it('ompCwdViolations: cwd 안의 파일과 위 폴더(상태 폴더까지)의 설정 이름을 다 잡는다', async () => {
    const root = await tmp();
    const t = await ensureOmpThread(join(root, 'omp-home'), 'x').catch(async () => {
      await ensureOmpHome({ ompHome: join(root, 'omp-home'), mcpServers: {} });
      return ensureOmpThread(join(root, 'omp-home'), 'x');
    });
    await writeFile(join(t.cwd, 'AGENTS.md'), 'planted');
    await mkdir(join(root, '.omp'));
    await writeFile(join(root, '.env'), 'K=V');
    const found = await ompCwdViolations(t.cwd, root);
    expect(found).toEqual(expect.arrayContaining([join(t.cwd, 'AGENTS.md'), join(root, '.omp'), join(root, '.env')]));
    await expect(ompCwdViolations('/elsewhere/cwd', root)).rejects.toThrow(/안에 없다/);
  });
});

describe('ompHome — 세션 헤더(omp 에는 --session-id 가 없다)', () => {
  it('헤더 한 줄을 600 으로 쓰고, 다시 불러도 덮지 않는다', async () => {
    const dir = await tmp();
    const p = await writeOmpSessionHeader(dir, 'sid-1', '/s/cwd', new Date('2026-10-24T10:00:00Z'));
    const line = JSON.parse((await readFile(p, 'utf8')).trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ type: 'session', id: 'sid-1', cwd: '/s/cwd' });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    await writeFile(p, `${JSON.stringify(line)}\n{"type":"message"}\n`);
    expect(await writeOmpSessionHeader(dir, 'sid-1', '/s/cwd')).toBe(p);
    expect((await readFile(p, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('ompSessionFile 은 id 로 기록 파일을 찾는다', async () => {
    const home = await tmp();
    await writeOmpSessionHeader(ompDirs(home).sessionsDir, 'sid-2', '/c');
    expect(await ompSessionFile(home, 'sid-2')).toMatch(/_sid-2\.jsonl$/);
    expect(await ompSessionFile(home, 'nope')).toBeNull();
  });
});

describe('ompHome — 읽기 전용·MCP·lane(security R·K1~K3)', () => {
  it('읽기 전용 목록은 내장 읽기 도구 + 우리 서버 글롭(밑줄 하나)뿐이다 — mcp__* 는 없다', () => {
    const list = ompReadonlyToolList(OMP_ADAPTER.readonlyTools!);
    expect(list).toBe('read,grep,glob,mcp__harkroom_*');
    expect(list).not.toContain('mcp__*');
  });

  it('toOmpMcp 는 모르는 갈래를 버린다', () => {
    expect(toOmpMcp({ a: { command: 'x' }, b: { type: 'http', url: 'https://h' }, c: {} as never })).toEqual({
      a: { command: 'x' }, b: { type: 'http', url: 'https://h' },
    });
  });

  it('models.yml 에는 키 값이 아니라 `!cat <경로>` 만 간다. https 또는 로컬만, 경로·모델에 특수 문자를 거절한다', async () => {
    const yml = ompLaneModelsYml({ baseUrl: 'https://gw.example/v1', keyPath: '/s/lease/key', models: ['Org/model-1'] });
    expect(yml).toContain(`apiKey: "!cat '/s/lease/key'"`);
    // macOS 앱 데이터 폴더(`Application Support`)의 빈칸은 받는다 — 작은따옴표 안이라 낱말로 안 갈린다.
    expect(ompLaneModelsYml({ baseUrl: 'https://g', keyPath: '/Users/u/Library/Application Support/app/turn-secrets/k', models: ['m'] }))
      .toContain(`apiKey: "!cat '/Users/u/Library/Application Support/app/turn-secrets/k'"`);
    expect(() => ompLaneModelsYml({ baseUrl: 'https://g', keyPath: "/k'; id; '", models: ['m'] })).toThrow(/경로/);
    expect(yml).toContain('api: openai-completions');
    expect(() => ompLaneModelsYml({ baseUrl: 'http://gw.example', keyPath: '/k', models: ['m'] })).toThrow(/https/);
    expect(() => ompLaneModelsYml({ baseUrl: 'http://127.0.0.1:8080', keyPath: '/k', models: ['m'] })).not.toThrow();
    expect(() => ompLaneModelsYml({ baseUrl: 'https://g', keyPath: '/k; rm -rf /', models: ['m'] })).toThrow(/경로/);
    expect(() => ompLaneModelsYml({ baseUrl: 'https://g', keyPath: '/k', models: ['m"\n'] })).toThrow(/모델/);
    const dir = await tmp();
    const p = await writeOmpLaneModels(dir, { baseUrl: 'https://g', keyPath: '/k', models: ['m'] });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });

  it('lane 키는 조립 전용이다 — 자식 env 로 가는 이름이 없다(K3)', () => {
    expect([...(providerLaneKeys('omp') ?? [])].sort()).toEqual([...(PROVIDER_LANE_ARGV_ONLY_KEYS.omp ?? [])].sort());
  });

  it('판 관문은 잰 판(`omp/18.12.6`)만 받는다(C1)', () => {
    expect(ompLaneVersionOk('omp/18.12.6\n')).toBe(true);
    expect(ompLaneVersionOk('omp/18.12.7')).toBe(false);
    expect(ompLaneVersionOk(null)).toBe(false);
  });
});

describe('omp 턴 조립', () => {
  const base = {
    harness: 'omp' as const, mode: 'mention' as const, sessionId: 'sid', isFirstTurn: true, systemPrompt: 'SYS',
    systemPromptFile: '/state/sys.txt', promptCtx: '', model: 'harkroom-lane/m', effort: 'high', mentionPermission: 'auto' as const,
    mcpConfigPath: '/state/mcp.json', operatorBin: '/bin/op', codexHome: '/state/codex', claudeConfigDir: null,
    ompHome: '/state/omp-home', ompThread: { cwd: '/state/omp-home/cwd/h/cwd', agentDir: '/state/omp-home/cwd/h/agent' },
    workspaceDir: '/work/repo',
  };

  // #1536(opencode lane 채널별 셸 규칙 D2)은 xdg 하네스에만 건다 — omp lane 턴에 `--agent` 가 붙거나 env 에 lane 값이 새면 안 된다.
  it('lane 턴에 채널 lane 에이전트를 줘도 omp 는 `--agent` 를 안 붙이고, 주소·키 경로는 자식 env 에 없다', () => {
    const plan = buildTurnCommand({
      ...base, laneAgent: 'harkroom-lane-ch', providerEnv: { HARKROOM_OMP_LANE_BASE_URL: 'https://gateway.example/v1', HARKROOM_OMP_LANE_KEY_FILE: '/state/lane-turn/k' },
    } as Parameters<typeof buildTurnCommand>[0]);
    expect(plan.args).not.toContain('--agent');
    expect(plan.args).not.toContain('harkroom-lane-ch');
    expect(JSON.stringify(plan.env)).not.toContain('gateway.example');
    expect(JSON.stringify(plan.env)).not.toContain('/state/lane-turn/k');
  });

  it('빈 cwd·오버레이·세션 자리·작업 폴더를 argv 로 못박고 첫 턴부터 --resume 이다', () => {
    const plan = buildTurnCommand(base);
    expect(plan.command).toBe('omp');
    expect(plan.cwd).toBe('/state/omp-home/cwd/h/cwd');
    const a = plan.args;
    const after = (flag: string) => a[a.indexOf(flag) + 1];
    expect(after('--resume')).toBe('sid');
    expect(after('--cwd')).toBe('/state/omp-home/cwd/h/cwd');
    expect(after('--add-dir')).toBe('/work/repo');
    expect(after('--config')).toBe('/state/omp-home/overlay.yml');
    expect(after('--session-dir')).toBe('/state/omp-home/agent/sessions');
    expect(after('--append-system-prompt')).toBe('/state/sys.txt');
    expect(a).toEqual(expect.arrayContaining(['--no-extensions', '--no-title']));
    expect(a).not.toContain('--tools');
    expect(plan.env.HOME).toBe('/state/omp-home/home');
    expect(plan.env.PI_CODING_AGENT_DIR).toBe('/state/omp-home/cwd/h/agent');
  });

  it('읽기 전용은 --tools 닫힌 목록 — 목록이 없으면 조립을 거절한다', () => {
    expect(() => buildTurnCommand({ ...base, mentionPermission: 'readonly' })).toThrow(/허용 도구 목록/);
    const plan = buildTurnCommand({ ...base, mentionPermission: 'readonly', readonlyToolList: 'read,grep,glob,mcp__harkroom_*' });
    expect(plan.args[plan.args.indexOf('--tools') + 1]).toBe('read,grep,glob,mcp__harkroom_*');
  });

  it('스레드 자리가 없거나 cwd 가 작업 폴더 안이면 조립을 거절한다(B4)', () => {
    expect(() => buildTurnCommand({ ...base, ompThread: undefined })).toThrow(/B4/);
    expect(() => buildTurnCommand({ ...base, ompThread: { cwd: '/work/repo/x', agentDir: '/a' } })).toThrow(/작업 폴더 안/);
    expect(() => buildTurnCommand({ ...base, ompThread: { cwd: '/work/repo', agentDir: '/a' } })).toThrow(/작업 폴더 안/);
  });
});

describe('omp 판 고정(C1)', () => {
  it('고정한 해시가 아닌 실행 파일·표에 없는 플랫폼은 거절한다', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'omp'), '#!/bin/sh\necho omp/18.12.6\n', { mode: 0o755 });
    expect(await findOmpBinary(`/nonexistent:${dir}`)).toMatch(/\/omp$/);
    expect(await ompBinaryOk(join(dir, 'omp'), 'darwin-arm64')).toBe(false);
    expect(await ompBinaryOk(join(dir, 'omp'), 'plan9-mips')).toBe(false);
    expect(await findOmpBinary('/nonexistent')).toBeNull();
  });
});

describe('omp 준비 표시(실측 fixture, 18.12.6)', () => {
  it('첫 화면과 되살린 화면 둘 다 상태줄의 `%`·`K` 칸에서 준비로 읽힌다', async () => {
    for (const name of ['omp-tui-ready.txt', 'omp-tui-resumed.txt']) {
      const screen = await readFile(join(import.meta.dirname, 'fixtures', name), 'utf8');
      expect(OMP_ADAPTER.screen.ready.test(screen)).toBe(true);
    }
    // 배너만 그려진 화면(상태줄 전)은 준비가 아니다.
    expect(OMP_ADAPTER.screen.ready.test('▄▀▀▄ █▀▄▀▄ █▀▀▄\n v18.12.6\n Tip: You can /btw')).toBe(false);
  });
});
