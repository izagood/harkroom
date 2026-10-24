// pi API 키 연결(lane) — 스레드 홈·로그인 판정·models.json·판 관문·조립.
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTurnCommand } from '../src/turn.js';
import {
  ensurePiHome, ensurePiLaneThread, PI_LANE_PROVIDER, piLaneLoginPresent, piLaneModelsJson, piLaneThreadHome, writePiLaneModels,
} from '../src/piHome.js';
import { createProviderLane, piLaneVersionOk, PROVIDER_LANE_ARGV_ONLY_KEYS, providerLaneKeys, ProviderLaneError } from '../src/providerLane.js';

const tmp = () => mkdtemp(join(tmpdir(), 'pi-lane-'));

describe('pi lane 홈', () => {
  it('lane 루트는 사람의 로그인·제공자·설정을 물려받지 않는다', async () => {
    const root = await tmp();
    const source = join(root, 'human');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'auth.json'), '{"openai":{"key":"human"}}');
    await writeFile(join(source, 'models.json'), '{"providers":{}}');
    await writeFile(join(source, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt' }));
    const lane = join(root, 'lane');
    await ensurePiHome({ piHome: lane, mcpServers: {}, sourceDir: source, lane: true });
    expect(await lstat(join(lane, 'auth.json')).catch(() => null)).toBeNull();
    expect(await lstat(join(lane, 'models.json')).catch(() => null)).toBeNull();
    expect(JSON.parse(await readFile(join(lane, 'settings.json'), 'utf8'))).toEqual({});
  });

  it('전에 링크해 둔 로그인·제공자는 링크만 뗀다(사람 파일은 그대로)', async () => {
    const root = await tmp();
    const source = join(root, 'human');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'auth.json'), '{"x":1}');
    const lane = join(root, 'lane');
    await mkdir(lane, { recursive: true });
    await symlink(join(source, 'auth.json'), join(lane, 'auth.json'));
    await ensurePiHome({ piHome: lane, mcpServers: {}, sourceDir: source, lane: true });
    expect(await lstat(join(lane, 'auth.json')).catch(() => null)).toBeNull();
    expect(await readFile(join(source, 'auth.json'), 'utf8')).toBe('{"x":1}');
  });

  it('스레드 홈은 키마다 고정이고 서로 다르다 — 루트의 settings·mcp 를 600 으로 베낀다', async () => {
    const root = await tmp();
    await ensurePiHome({ piHome: root, mcpServers: { harkroom: { command: 'op', args: ['mcp-bridge'] } }, lane: true });
    expect(piLaneThreadHome(root, 'a')).toBe(piLaneThreadHome(root, 'a'));
    expect(piLaneThreadHome(root, 'a')).not.toBe(piLaneThreadHome(root, 'b'));
    const home = await ensurePiLaneThread(root, 'a');
    expect(home).toBe(piLaneThreadHome(root, 'a'));
    expect(await readFile(join(home, 'mcp.json'), 'utf8')).toBe(await readFile(join(root, 'mcp.json'), 'utf8'));
    expect((await stat(join(home, 'mcp.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it('로그인 판정: 없음·빈 {} 은 아니고, 내용이 있거나 깨졌거나 링크면 있다', async () => {
    const home = await tmp();
    expect(await piLaneLoginPresent(home)).toBe(false);
    await writeFile(join(home, 'auth.json'), '{}\n');
    expect(await piLaneLoginPresent(home)).toBe(false);
    await writeFile(join(home, 'auth.json'), '{"harkroom-lane":{"type":"api_key","key":"x"}}');
    expect(await piLaneLoginPresent(home)).toBe(true);
    await writeFile(join(home, 'auth.json'), 'not json');
    expect(await piLaneLoginPresent(home)).toBe(true);
    const other = await tmp();
    await writeFile(join(other, 'real.json'), '{}');
    await symlink(join(other, 'real.json'), join(other, 'auth.json'));
    expect(await piLaneLoginPresent(other)).toBe(true);
  });

  it('models.json 에는 키 값이 아니라 `!cat <경로>` 만 간다. https 또는 로컬만, 경로·모델에 특수 문자를 거절한다', async () => {
    const doc = JSON.parse(piLaneModelsJson({ baseUrl: 'https://gateway.example', keyPath: '/secrets/turn/k', models: ['Org/model-1'] }));
    expect(doc).toEqual({
      providers: {
        [PI_LANE_PROVIDER]: { baseUrl: 'https://gateway.example/v1', api: 'openai-completions', apiKey: '!cat /secrets/turn/k', models: [{ id: 'Org/model-1' }] },
      },
    });
    expect(() => piLaneModelsJson({ baseUrl: 'http://gateway.example', keyPath: '/k', models: ['m'] })).toThrow();
    expect(() => piLaneModelsJson({ baseUrl: 'http://127.0.0.1:9', keyPath: '/k', models: ['m'] })).not.toThrow();
    for (const keyPath of ['/k; rm -rf ~', '/k $(id)', 'relative/k', "/k'x"]) {
      expect(() => piLaneModelsJson({ baseUrl: 'https://g.example', keyPath, models: ['m'] })).toThrow();
    }
    expect(() => piLaneModelsJson({ baseUrl: 'https://g.example', keyPath: '/k', models: ['m {x}'] })).toThrow();
    const home = await tmp();
    const p = await writePiLaneModels(home, { baseUrl: 'https://g.example', keyPath: '/k', models: ['m'] });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });

  it('lane 키는 조립 전용이다 — 자식 env 로 가는 이름이 없다', () => {
    expect([...(providerLaneKeys('pi') ?? [])].sort()).toEqual([...(PROVIDER_LANE_ARGV_ONLY_KEYS.pi ?? [])].sort());
  });

  it('판 관문은 잰 판(1.4.0)만 받는다', () => {
    expect(piLaneVersionOk('1.4.0\n')).toBe(true);
    expect(piLaneVersionOk('1.4.1')).toBe(false);
    expect(piLaneVersionOk('pi 1.4.0')).toBe(false);
    expect(piLaneVersionOk(null)).toBe(false);
  });

  it('createProviderLane: pi 는 주소와 키 파일 경로만 돌려준다 — 판이 다르면 키를 받기 전에 멈춘다', async () => {
    const secrets = await tmp();
    await mkdir(join(secrets, 'lease'), { recursive: true });
    const keyPath = join(secrets, 'lease', 'k');
    await writeFile(keyPath, 'sk-fake\n');
    let mounted = 0;
    let version = '1.4.0';
    const lane = createProviderLane({
      turnSecretsDir: secrets,
      mount: async () => { mounted++; return { status: 200, body: JSON.stringify({ lane: { baseUrl: 'https://gateway.example', path: keyPath } }) }; },
      harnessVersion: async () => version,
    });
    const env = await lane.envFor('m1', 'pi');
    expect(Object.keys(env).sort()).toEqual([...(providerLaneKeys('pi') ?? [])].sort());
    expect(JSON.stringify(env)).not.toContain('sk-fake');
    expect(Object.values(env)).toContain('https://gateway.example');
    version = '1.5.0';
    await expect(lane.envFor('m2', 'pi')).rejects.toBeInstanceOf(ProviderLaneError);
    expect(mounted).toBe(1);
  });
});

describe('pi lane 턴 조립', () => {
  it('주소·키 경로는 자식 env 에 없고, 홈은 그 스레드 홈이다', () => {
    const plan = buildTurnCommand({
      harness: 'pi', mode: 'mention', sessionId: 'sid', isFirstTurn: true, systemPrompt: 'SYS', systemPromptFile: '/state/sys.txt',
      promptCtx: '', model: `${PI_LANE_PROVIDER}/m`, effort: 'high', mentionPermission: 'auto', mcpConfigPath: '/state/mcp.json',
      operatorBin: '/bin/op', codexHome: '/state/codex', claudeConfigDir: null, piHome: '/state/pi-provider-lane/threads/h',
      workspaceDir: '/work/repo',
      providerEnv: { HARKROOM_PI_LANE_BASE_URL: 'https://gateway.example', HARKROOM_PI_LANE_KEY_FILE: '/state/lease/k' },
    } as Parameters<typeof buildTurnCommand>[0]);
    expect(JSON.stringify(plan.env)).not.toContain('gateway.example');
    expect(JSON.stringify(plan.env)).not.toContain('/state/lease/k');
    expect(plan.env.PI_CODING_AGENT_DIR).toBe('/state/pi-provider-lane/threads/h');
    expect(plan.args).toContain('--no-approve');
    expect(plan.args).toContain(`${PI_LANE_PROVIDER}/m`);
    expect(plan.args.join(' ')).toContain('/state/pi-provider-lane/threads/h/sessions');
  });
});
