// opencode 격리 홈 — **무엇을 물려받고 무엇을 안 받는가**가 이 파일의 전부다(2026-09-22).
//
// 셋 다 실물에서 데인 자리다:
//
// 1. `provider`·`model` 을 안 물려받으면 opencode 가 **무료 티어로 떨어져 거절**당한다
//    (`Error from provider (Console): OpenCode's free tier can only be used from within OpenCode`).
// 2. `mcp` 를 물려받으면 **운영자 개인 MCP 가 에이전트 턴에 붙는다** — claude 에 늘
//    `--strict-mcp-config` 를 붙이는 것과 같은 자리(스펙 §7). opencode 에는 그 플래그가
//    없으므로 **격리 홈을 우리가 쓰는 것**이 그 역할을 한다.
// 3. 로그인 자리는 `<data>/**opencode**/auth.json` 으로 한 단계 깊다.
import { mkdtemp, mkdir, readdir, readFile, writeFile, lstat, readlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ensureOpencodeHome, opencodeConfigFile, opencodeDirs, opencodeLaneModelMissing, laneRunModel, OPENCODE_LANE_AGENT, OPENCODE_LANE_PERMISSION, OPENCODE_READONLY_AGENT, providerLaneModelId, PROVIDER_LANE_MODEL_KEEP, stripJsonc, toOpencodeMcp,
  opencodeLaneHome, laneSkillPermission, laneOpencodeBashTable, opencodeLaneAgentName, opencodeLaneAgentMatches,
  opencodeConfigLockPath, withConfigLock,
} from '../src/opencodeHome.js';
import { allXdgApps, xdgAppFor } from '../src/adapters/index.js';

const BRIDGE = { harkroom: { type: 'stdio' as const, command: '/opt/harkroom/harkroom-operator', args: ['mcp-bridge'] } };

async function fixture(): Promise<{ home: string; sourceConfig: string; sourceData: string }> {
  const root = await mkdtemp(join(tmpdir(), 'oc-home-'));
  const sourceDir = join(root, 'user-config');
  const sourceData = join(root, 'user-data');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(sourceData, { recursive: true });
  await writeFile(join(sourceDir, 'opencode.json'), JSON.stringify({
    provider: { rro: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gateway.example/v1' } } },
    model: 'rro/some/model',
    // 사람의 개인 MCP — **여기서 끝나야 한다.**
    mcp: { gmail: { type: 'local', command: ['gmail-mcp'] } },
  }));
  await writeFile(join(sourceData, 'auth.json'), '{"rro":{"type":"api","key":"x"}}');
  return { home: join(root, 'runner-home'), sourceConfig: join(sourceDir, 'opencode.json'), sourceData };
}

describe('오퍼레이터의 표를 opencode 모양으로 번역한다', () => {
  it('stdio 는 `local` 이고 명령이 **배열 하나**다 — 브릿지가 그 모양으로 붙는다', () => {
    expect(toOpencodeMcp(BRIDGE)).toEqual({
      harkroom: { type: 'local', command: ['/opt/harkroom/harkroom-operator', 'mcp-bridge'], enabled: true },
    });
  });

  it('env 는 `environment` 로 옮긴다 — 이름만 다르고 뜻이 같다', () => {
    const got = toOpencodeMcp({ x: { type: 'stdio', command: 'x', args: [], env: { K: 'v' } } });
    expect(got.x).toMatchObject({ type: 'local', environment: { K: 'v' } });
  });

  it('http·sse 는 `remote` 로 간다', () => {
    const got = toOpencodeMcp({ y: { type: 'http', url: 'https://e/mcp', headers: { A: 'b' } } });
    expect(got.y).toEqual({ type: 'remote', url: 'https://e/mcp', enabled: true, headers: { A: 'b' } });
  });

  it('모르는 갈래는 **버린다** — 잘못 만든 항목 하나가 설정 전체를 거절시킨다', () => {
    // codex 의 `invalid transport` 사고가 그것이었다: 항목 하나가 틀리자 MCP 가 통째로 죽고
    // harkroom 도 함께 사라져, 에이전트가 오류 없이 돌다가 답을 못 했다.
    expect(toOpencodeMcp({ bad: {} as never })).toEqual({});
  });
});

describe('격리 홈이 물려받는 것과 안 받는 것', () => {
  it('provider·model 은 물려받고 **mcp 는 안 받는다**', async () => {
    const { home, sourceConfig, sourceData } = await fixture();
    await ensureOpencodeHome({ opencodeHome: home, mcpServers: BRIDGE, sourceConfig, sourceData });

    const config = JSON.parse(await readFile(opencodeConfigFile(home), 'utf8')) as Record<string, any>;
    expect(config.provider?.rro).toBeDefined();
    expect(config.model).toBe('rro/some/model');
    // 사람의 개인 MCP 는 한 줄도 넘어오지 않는다. 우리 표만 있다.
    //
    // **이 단언이 잡는 것**(뮤테이션으로 확인): 병합 순서가 뒤집혀 사람 설정이 우리 표를
    // 이기는 경우. 물려받을 키 목록에 `mcp` 가 들어가는 것만으로는 새지 않는다 —
    // 우리 `mcp` 가 spread **뒤에** 오기 때문이다. 그 순서가 계약이다.
    expect(Object.keys(config.mcp)).toEqual(['harkroom']);
  });

  it('읽기 전용 에이전트를 함께 적는다 — 권한 보증은 이 표가 한다', async () => {
    const { home, sourceConfig, sourceData } = await fixture();
    await ensureOpencodeHome({ opencodeHome: home, mcpServers: BRIDGE, sourceConfig, sourceData });

    const config = JSON.parse(await readFile(opencodeConfigFile(home), 'utf8')) as Record<string, any>;
    const agent = config.agent[OPENCODE_READONLY_AGENT];
    expect(agent.permission).toEqual({ edit: 'deny', bash: 'deny', webfetch: 'deny' });
    // 모델을 안 적으면 **그 에이전트만** 기본(무료 티어)으로 떨어진다(실측).
    expect(agent.model).toBe('rro/some/model');
  });

  it('로그인은 `<data>/opencode/auth.json` 에 링크한다 — 한 단계 깊다', async () => {
    const { home, sourceConfig, sourceData } = await fixture();
    await ensureOpencodeHome({ opencodeHome: home, mcpServers: BRIDGE, sourceConfig, sourceData });

    const target = join(opencodeDirs(home).XDG_DATA_HOME, 'opencode', 'auth.json');
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readlink(target)).toBe(join(sourceData, 'auth.json'));
  });

  it('두 번 불러도 같다 — 매 턴 불린다', async () => {
    const { home, sourceConfig, sourceData } = await fixture();
    await ensureOpencodeHome({ opencodeHome: home, mcpServers: BRIDGE, sourceConfig, sourceData });
    const first = await readFile(opencodeConfigFile(home), 'utf8');
    await ensureOpencodeHome({ opencodeHome: home, mcpServers: BRIDGE, sourceConfig, sourceData });
    expect(await readFile(opencodeConfigFile(home), 'utf8')).toBe(first);
  });

  it('사람 설정이 아예 없어도 뜬다 — 그때는 물려받을 것이 없을 뿐이다', async () => {
    const { home, sourceData } = await fixture();
    await ensureOpencodeHome({
      opencodeHome: home, mcpServers: BRIDGE, sourceConfig: join(home, '없는-파일.json'), sourceData,
    });
    const config = JSON.parse(await readFile(opencodeConfigFile(home), 'utf8')) as Record<string, any>;
    expect(config.provider).toBeUndefined();
    expect(Object.keys(config.mcp)).toEqual(['harkroom']);
  });
});

describe('Kilo(opencode 포크) — 같은 루트, 다른 이름표', () => {
  const KILO = xdgAppFor('kilo')!;

  async function kiloFixture(): Promise<{ home: string; sourceConfig: string; sourceData: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kilo-home-'));
    const sourceDir = join(root, 'user-config');
    const sourceData = join(root, 'user-data');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(sourceData, { recursive: true });
    // Kilo 의 사람 설정은 **JSONC** 다(처음 뜰 때 `kilo.jsonc` 를 만든다 — 실측).
    await writeFile(join(sourceDir, 'kilo.jsonc'), [
      '{',
      '  // 사람이 단 주석',
      '  "$schema": "https://app.kilo.ai/config.json",',
      '  "provider": { "rro": { "options": { "baseURL": "https://gateway.example/v1" } } }, /* 끝 */',
      '  "model": "rro/some/model",',
      '}',
    ].join('\n'));
    await writeFile(join(sourceData, 'auth.json'), '{"rro":{"type":"api","key":"x"}}');
    return { home: join(root, 'runner-home'), sourceConfig: join(sourceDir, 'kilo.jsonc'), sourceData };
  }

  it('설정은 `<config>/kilo/kilo.jsonc`, 로그인은 `<data>/kilo/auth.json` 이다', async () => {
    const { home, sourceConfig, sourceData } = await kiloFixture();
    await ensureOpencodeHome({ opencodeHome: home, mcpServers: BRIDGE, sourceConfig, sourceData, app: KILO });

    const file = opencodeConfigFile(home, KILO);
    expect(file).toBe(join(opencodeDirs(home).XDG_CONFIG_HOME, 'kilo', 'kilo.jsonc'));
    const config = JSON.parse(await readFile(file, 'utf8')) as Record<string, any>;
    // 주석·끝 쉼표가 있는 사람 설정에서도 제공자를 물려받는다 — 못 읽으면 조용히 기본 모델로 돈다.
    expect(config.model).toBe('rro/some/model');
    expect(config.provider?.rro).toBeDefined();
    expect(Object.keys(config.mcp)).toEqual(['harkroom']);
    expect(config.agent[OPENCODE_READONLY_AGENT].permission).toEqual({ edit: 'deny', bash: 'deny', webfetch: 'deny' });

    const auth = join(opencodeDirs(home).XDG_DATA_HOME, 'kilo', 'auth.json');
    expect(await readlink(auth)).toBe(join(sourceData, 'auth.json'));
  });

  it('opencode 와 한 루트에 함께 산다 — 서로의 설정을 덮지 않는다', async () => {
    const { home, sourceConfig, sourceData } = await kiloFixture();
    for (const app of allXdgApps()) {
      await ensureOpencodeHome({ opencodeHome: home, mcpServers: BRIDGE, sourceConfig, sourceData, app });
    }
    expect(allXdgApps().map((a) => a.dir).sort()).toEqual(['kilo', 'opencode']);
    await lstat(opencodeConfigFile(home)); // opencode 것
    await lstat(opencodeConfigFile(home, KILO)); // kilo 것
  });

  it('JSONC 를 벗길 때 문자열 안의 `//` 는 건드리지 않는다', () => {
    expect(JSON.parse(stripJsonc('{"u":"https://a.example/v1", // x\n "b":[1,2,],}'))).toEqual({ u: 'https://a.example/v1', b: [1, 2] });
  });
});

// 전용 제공사 경로(security ⓕ): provider 블록은 그 에이전트 홈에만, 키는 자식 env 로만.
describe('lane 러너의 opencode 홈', () => {
  it('사람의 provider·모델·로그인을 물리지 않고 lane 블록 하나만 연다 — 주소·키 칸은 공유 설정에 없다', async () => {
    const f = await fixture();
    await ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData,
      providerLane: { model: 'harkroom-lane/example-model' },
    });
    const text = await readFile(opencodeConfigFile(f.home), 'utf8');
    const cfg = JSON.parse(text);
    expect(Object.keys(cfg.provider)).toEqual(['harkroom-lane']);
    expect(cfg.provider['harkroom-lane']).toEqual({
      npm: '@ai-sdk/anthropic',
      name: 'Harkroom provider lane',
      models: { 'example-model': { name: 'example-model' } },
    });
    // 다른 provider(무료 티어·사람 로그인)로 돌지 않는다.
    expect(cfg.enabled_providers).toEqual(['harkroom-lane']);
    expect(cfg.autoupdate).toBe(false);
    expect(cfg.model).toBe('harkroom-lane/example-model');
    expect(cfg.agent[OPENCODE_READONLY_AGENT].model).toBe('harkroom-lane/example-model');
    expect(cfg.agent[OPENCODE_LANE_AGENT]).toEqual({ mode: 'primary', permission: OPENCODE_LANE_PERMISSION, model: 'harkroom-lane/example-model' });
    expect(text).not.toContain('gateway.example');
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('{env:');
    // 홈 표지 자리(`OPENCODE_TEST_HOME`)는 비어 있다.
    expect(await readdir(opencodeLaneHome(f.home))).toEqual([]);
    expect(cfg.mcp).toEqual({ harkroom: expect.objectContaining({ type: 'local' }) });
    expect(cfg.mcp.gmail).toBeUndefined();
    // 사람 로그인을 링크하지 않는다(ⓒ).
    expect(await lstat(join(opencodeDirs(f.home).XDG_DATA_HOME, 'opencode', 'auth.json')).catch(() => null)).toBeNull();
  });

  // 홈 스위치는 작업 폴더의 `.claude/skills`·`.agents/skills` 도 끈다 — 러너가 깐 스킬은 원본 자리를 `skills.paths` 로 열고, 그 이름만 허락한다(security c).
  it('lane 은 러너 스킬 자리만 `skills.paths` 로 열고, 권한은 그 이름만 allow 다', async () => {
    const f = await fixture();
    const skillsDir = join(f.home, '..', 'runner-skills');
    for (const [slug, name] of [['a', 'deploy-check'], ['b', '"quoted-name"'], ['c', 'bad*name']]) {
      await mkdir(join(skillsDir, slug!), { recursive: true });
      await writeFile(join(skillsDir, slug!, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\nbody\n`);
    }
    await ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData,
      providerLane: { model: 'harkroom-lane/example-model', skillsDir },
    });
    const cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
    expect(cfg.skills).toEqual({ paths: [skillsDir] });
    expect(cfg.agent[OPENCODE_LANE_AGENT].permission.skill).toEqual({ '*': 'deny', 'deploy-check': 'allow', 'quoted-name': 'allow' });
    // 다른 권한 칸은 그대로다.
    expect({ ...cfg.agent[OPENCODE_LANE_AGENT].permission, skill: undefined }).toEqual({ ...OPENCODE_LANE_PERMISSION, skill: undefined });
    expect(laneSkillPermission([])).toEqual({ '*': 'deny' });
  });

  // W4(사람 홈 표지 회귀선): 1.18.32 실측에서 막힌 길(홈 지시·스킬·opencode.json·플러그인·작업 폴더 스킬 링크)을 설정 쪽에서 다시 열지 않는다.
  it('lane 설정은 홈 표지 자리를 비워 두고, 지시·플러그인 칸을 쓰지 않으며, 스킬 자리는 러너 것 하나다', async () => {
    const f = await fixture();
    const skillsDir = join(f.home, '..', 'runner-skills');
    await ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData,
      providerLane: { model: 'harkroom-lane/example-model', skillsDir },
    });
    const cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
    for (const k of ['instructions', 'plugin', 'plugins']) expect(cfg[k]).toBeUndefined();
    expect(cfg.skills).toEqual({ paths: [skillsDir] });
    expect(cfg.agent[OPENCODE_LANE_AGENT].permission.skill['*']).toBe('deny');
    expect(await readdir(opencodeLaneHome(f.home))).toEqual([]);
    expect(cfg.autoupdate).toBe(false);
  });

  // 1.18.32 실측: 규칙은 뒤의 것이 이긴다 · 쓰기 판정 경로는 git 뿌리 기준이라 앞에 무엇이 붙을 수 있다.
  it('lane 에이전트 권한 표: 맨 앞이 `*` deny 이고 셸·웹·하위 에이전트·밖 폴더는 열지 않는다', () => {
    const perm = OPENCODE_LANE_PERMISSION as Record<string, unknown>;
    expect(Object.keys(perm)[0]).toBe('*');
    expect(perm['*']).toBe('deny');
    for (const k of ['bash', 'webfetch', 'websearch', 'task', 'external_directory', 'doom_loop', 'question']) expect(perm[k]).toBeUndefined();
    expect(Object.values(perm).some((v) => v === 'ask' || (typeof v === 'object' && Object.values(v as object).includes('ask')))).toBe(false);
    const edit = perm.edit as Record<string, string>;
    expect(Object.keys(edit)[0]).toBe('*');
    for (const x of ['.claude/*', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', '.opencode/*', 'opencode.json', 'opencode.jsonc']) {
      expect(edit[x]).toBe('deny');
      expect(edit[`*/${x}`]).toBe('deny');
    }
  });

  it('lane 이 아닌 러너에는 lane 에이전트를 적지 않는다', async () => {
    const f = await fixture();
    await ensureOpencodeHome({ opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData });
    const cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
    expect(cfg.agent[OPENCODE_LANE_AGENT]).toBeUndefined();
  });

  // n6: 설정 파일은 에이전트당 하나다. 동시 턴이 서로 다른 모델이면 나중 턴이 앞 턴의 모델을 지우지 않아야 한다.
  it('lane 모델 목록은 쌓인다 — 앞 턴의 모델이 남고, 상한을 넘으면 오래된 것부터 빠진다', async () => {
    const f = await fixture();
    const write = (model: string) => ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData, providerLane: { model },
    });
    await write('harkroom-lane/model-a');
    await write('harkroom-lane/model-b');
    let cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
    expect(Object.keys(cfg.provider['harkroom-lane'].models)).toEqual(['model-a', 'model-b']);
    expect(cfg.model).toBe('harkroom-lane/model-b');
    for (let i = 0; i < PROVIDER_LANE_MODEL_KEEP + 2; i += 1) await write(`harkroom-lane/m-${i}`);
    cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
    const ids = Object.keys(cfg.provider['harkroom-lane'].models);
    expect(ids).toHaveLength(PROVIDER_LANE_MODEL_KEEP);
    expect(ids.at(-1)).toBe(`m-${PROVIDER_LANE_MODEL_KEEP + 1}`);
    expect(ids).not.toContain('model-a');
  });

  it('lane 이 아니던 때 남은 로그인 **링크만** 뗀다 — 사람 파일은 그대로', async () => {
    const f = await fixture();
    await ensureOpencodeHome({ opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData });
    const link = join(opencodeDirs(f.home).XDG_DATA_HOME, 'opencode', 'auth.json');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData, providerLane: { model: null },
    });
    expect(await lstat(link).catch(() => null)).toBeNull();
    expect(await readFile(join(f.sourceData, 'auth.json'), 'utf8')).toContain('rro');
  });

  it('모델을 모르거나 쓸 수 없는 글자면 목록을 비운다 — 그 턴은 실패하고 다른 provider 로 안 떨어진다', async () => {
    const f = await fixture();
    await ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData, providerLane: { model: 'rro/{env:HOME}' },
    });
    const cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
    expect(cfg.provider['harkroom-lane'].models).toEqual({});
    expect(cfg.model).toBeUndefined();
    expect(cfg.enabled_providers).toEqual(['harkroom-lane']);
  });

  it('모델 이름에 `{env:}`·`{file:}` 가 섞이면 받지 않는다 — opencode 가 본문 전체에서 바꿔 넣는다', () => {
    expect(providerLaneModelId('harkroom-lane/example-model')).toBe('example-model');
    expect(providerLaneModelId('harkroom-lane/{env:HARKROOM_PROVIDER_TOKEN}')).toBeNull();
    // 2026-10-23: gateway 모델 id 는 조직 이름을 앞에 단다. `/` 를 막아 lane 목록이 비었고 opencode 가 「Connect a provider」 창에 섰다.
    expect(providerLaneModelId('harkroom-lane/ExampleOrg/example-model-2.7')).toBe('ExampleOrg/example-model-2.7');
    // `/` 는 마디 사이에만 — 빈 마디·끝 `/`·중괄호는 여전히 거절이다.
    for (const bad of ['harkroom-lane/a//b', 'harkroom-lane/a/', 'harkroom-lane//a', 'harkroom-lane/a/{file:/etc/passwd}', `harkroom-lane/${'a'.repeat(129)}`]) {
      expect(providerLaneModelId(bad)).toBeNull();
    }
    expect(providerLaneModelId('harkroom-lane/{file:/etc/passwd}')).toBeNull();
    expect(providerLaneModelId('harkroom-lane/')).toBeNull();
    expect(providerLaneModelId(null)).toBeNull();
    // 원문도 같은 문법으로 잰다.
    expect(providerLaneModelId('ExampleOrg/example-model')).toBe('ExampleOrg/example-model');
    expect(providerLaneModelId('{env:HARKROOM_PROVIDER_TOKEN}')).toBeNull();
  });
});

// 2026-10-24 jaebin: 모델 칸에는 gateway 가 받는 원문(`ExampleOrg/example-model`)을 적는다. `harkroom-lane/` 머리는 러너가 opencode 를
// 띄울 때만 안에서 붙인다. 머리가 붙은 옛 값도 그대로 돈다. 비었거나 쓸 수 없는 글자일 때만 띄우기 전에 `bad_model` 로 실패한다.
describe('opencode lane 모델 — 원문을 받고 머리는 러너가 붙인다', () => {
  it('원문·옛 머리 붙은 값 모두 받는다 — 비었거나 문법에 안 맞을 때만 참', () => {
    expect(opencodeLaneModelMissing(true, true, 'ExampleOrg/example-model')).toBe(false);
    expect(opencodeLaneModelMissing(true, true, 'harkroom-lane/ExampleOrg/example-model')).toBe(false);
    expect(opencodeLaneModelMissing(true, true, null)).toBe(true);
    expect(opencodeLaneModelMissing(true, true, '  ')).toBe(true);
    expect(opencodeLaneModelMissing(true, true, 'ExampleOrg/{env:HOME}')).toBe(true);
    expect(opencodeLaneModelMissing(false, true, null)).toBe(false);
    expect(opencodeLaneModelMissing(true, false, null)).toBe(false);
  });
  it('laneRunModel: opencode 는 안에서만 `harkroom-lane/<원문>`, claude 는 원문, lane 이 아니면 그대로', () => {
    expect(laneRunModel(true, true, 'ExampleOrg/example-model')).toBe('harkroom-lane/ExampleOrg/example-model');
    expect(laneRunModel(true, true, 'harkroom-lane/ExampleOrg/example-model')).toBe('harkroom-lane/ExampleOrg/example-model');
    expect(laneRunModel(true, true, 'ExampleOrg/{file:/etc/passwd}')).toBeNull();
    expect(laneRunModel(true, false, 'ExampleOrg/example-model')).toBe('ExampleOrg/example-model');
    expect(laneRunModel(true, false, 'harkroom-lane/ExampleOrg/example-model')).toBe('ExampleOrg/example-model');
    expect(laneRunModel(false, true, 'harkroom-lane/x')).toBe('harkroom-lane/x');
  });
  it('lane 설정의 모델 목록에는 원문 id 가 든다(원문·옛 값 같은 결과)', async () => {
    for (const model of ['ExampleOrg/example-model', 'harkroom-lane/ExampleOrg/example-model']) {
      const f = await fixture();
      await ensureOpencodeHome({ opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData, providerLane: { model } });
      const cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
      expect(cfg.provider['harkroom-lane'].models).toEqual({ 'ExampleOrg/example-model': { name: 'ExampleOrg/example-model' } });
      expect(cfg.model).toBe('harkroom-lane/ExampleOrg/example-model');
    }
  });
});

// D2(채널별 lane 정의): 명령 전체 규칙만 옮긴다 — opencode 접두 패턴은 claude 쪽 판정보다 넓게 맞는다.
describe('opencode lane 채널 칸', () => {
  const CH = '309886fb-1c00-4084-bf9d-fb3d14ae647d';
  const OTHER = 'a42006a1-72c4-4375-ae8b-cfb5a4f06c7e';

  it('명령 전체 규칙만 allow 로 — 접두·와일드카드·셸 글자 규칙은 빼고, 맨 앞은 * deny(T1·T2)', () => {
    const table = laneOpencodeBashTable([
      'Bash(gh pr list -R example/repo --limit 5)', 'Bash(gh run list -R example/repo:*)', 'Bash(ls *.txt)', 'Bash(echo a?)',
      'Bash(gh pr list | sh)', 'Bash(echo ok > f)', 'Bash(echo $(id))', 'WebFetch', 'Bash()', 'Bash(  git status  )',
    ]);
    expect(Object.keys(table)[0]).toBe('*');
    expect(table).toEqual({ '*': 'deny', 'gh pr list -R example/repo --limit 5': 'allow', 'git status': 'allow' });
  });

  it('이름의 채널 부분은 uuid 모양만(U3)', () => {
    expect(opencodeLaneAgentName(CH)).toBe(`harkroom-lane-${CH}`);
    for (const bad of ['general', `${CH}x`, '../x', CH.toUpperCase()]) expect(opencodeLaneAgentName(bad)).toBeNull();
  });

  it('이 채널 칸만 지금 규칙으로 다시 쓰고(줄어든 것 포함), 다른 채널 칸은 남긴다 — 모두 primary 만(U1·U2)', async () => {
    const f = await fixture();
    const write = (id: string, toolAllows: string[]) => ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData,
      providerLane: { model: 'ExampleOrg/example-model', channel: { id, toolAllows } },
    });
    await write(CH, ['Bash(git status)', 'Bash(git log -1)']);
    await write(OTHER, ['Bash(git diff)']);
    let cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
    expect(cfg.agent[`harkroom-lane-${CH}`].permission.bash).toEqual({ '*': 'deny', 'git status': 'allow', 'git log -1': 'allow' });
    expect(cfg.agent[`harkroom-lane-${OTHER}`].permission.bash).toEqual({ '*': 'deny', 'git diff': 'allow' });
    for (const name of Object.keys(cfg.agent).filter((n) => n.startsWith('harkroom-lane'))) expect(cfg.agent[name].mode).toBe('primary');
    expect(cfg.agent['harkroom-lane'].permission.bash).toBeUndefined();
    // 거둠: 이 채널 규칙이 줄면 칸도 준다.
    await write(CH, ['Bash(git status)']);
    cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
    expect(cfg.agent[`harkroom-lane-${CH}`].permission.bash).toEqual({ '*': 'deny', 'git status': 'allow' });
    expect(await opencodeLaneAgentMatches(f.home, CH, ['Bash(git status)'])).toBe(true);
    expect(await opencodeLaneAgentMatches(f.home, CH, ['Bash(git status)', 'Bash(git log -1)'])).toBe(false);
    expect(await opencodeLaneAgentMatches(f.home, 'general', [])).toBe(false);
  });

  it('손으로 넓힌 다른 채널 칸(와일드카드·맨 앞 deny 아님)은 다시 쓸 때 버린다', async () => {
    const f = await fixture();
    await ensureOpencodeHome({ opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData, providerLane: { model: null } });
    const file = opencodeConfigFile(f.home);
    const cfg = JSON.parse(await readFile(file, 'utf8'));
    cfg.agent[`harkroom-lane-${OTHER}`] = { mode: 'primary', permission: { bash: { '*': 'deny', 'gh *': 'allow' } } };
    cfg.agent[`harkroom-lane-${CH}`] = { mode: 'primary', permission: { bash: { 'git status': 'allow' } } };
    await writeFile(file, JSON.stringify(cfg));
    await ensureOpencodeHome({ opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData, providerLane: { model: null } });
    const after = JSON.parse(await readFile(file, 'utf8'));
    expect(after.agent[`harkroom-lane-${OTHER}`]).toBeUndefined();
    expect(after.agent[`harkroom-lane-${CH}`]).toBeUndefined();
  });
});

// security F1: 채널 칸은 한 파일에 여럿이다 — 읽기-고치기-쓰기를 잠금으로 감싸, 겹친 턴이 남의 옛 칸(거둔 규칙)을 되쓰지 않게 한다.
describe('opencode lane 설정 잠금', () => {
  const A = '309886fb-1c00-4084-bf9d-fb3d14ae647d';
  const B = 'a42006a1-72c4-4375-ae8b-cfb5a4f06c7e';

  it('겹친 두 채널 쓰기 뒤에도 A 에서 거둔 규칙이 되살아나지 않는다(여러 번, 순서를 바꿔)', async () => {
    const f = await fixture();
    const write = (id: string, toolAllows: string[]) => ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData,
      providerLane: { model: 'ExampleOrg/example-model', channel: { id, toolAllows } },
    });
    for (let i = 0; i < 12; i++) {
      await write(A, ['Bash(git status)', 'Bash(git log -1)']);
      const narrow = write(A, ['Bash(git status)']);
      const other = write(B, [`Bash(git diff --stat ${i})`]);
      await Promise.all(i % 2 ? [other, narrow] : [narrow, other]);
      const cfg = JSON.parse(await readFile(opencodeConfigFile(f.home), 'utf8'));
      expect(cfg.agent[`harkroom-lane-${A}`].permission.bash).toEqual({ '*': 'deny', 'git status': 'allow' });
      expect(cfg.agent[`harkroom-lane-${B}`].permission.bash).toEqual({ '*': 'deny', [`git diff --stat ${i}`]: 'allow' });
    }
    // 잠금 파일은 남지 않는다.
    expect(await lstat(opencodeConfigLockPath(f.home)).catch(() => null)).toBeNull();
  });

  it('살아 있는 주인이 잡은 잠금은 시한까지 기다리다 던진다 — 쓰지 않는다', async () => {
    const f = await fixture();
    await mkdir(f.home, { recursive: true });
    await writeFile(opencodeConfigLockPath(f.home), `${process.pid} ${Date.now()}\n`);
    await expect(ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData,
      providerLane: { model: null, channel: { id: A, toolAllows: ['Bash(git status)'] } }, lockTimeoutMs: 100,
    })).rejects.toThrow(/잠금/);
    expect(await opencodeLaneAgentMatches(f.home, A, ['Bash(git status)'])).toBe(false);
  });

  it('설정은 바꿔 끼워 쓴다 — 쓸 때마다 다른 inode, 임시 파일은 남지 않는다(security F2)', async () => {
    const f = await fixture();
    const write = () => ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData,
      providerLane: { model: null, channel: { id: A, toolAllows: ['Bash(git status)'] } },
    });
    await write();
    const before = (await stat(opencodeConfigFile(f.home))).ino;
    await write();
    expect((await stat(opencodeConfigFile(f.home))).ino).not.toBe(before);
    const dir = join(opencodeConfigFile(f.home), '..');
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect((await stat(opencodeConfigFile(f.home))).mode & 0o777).toBe(0o600);
  });

  it('주인이 죽었거나 시한이 지난 잠금은 걷는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lock-'));
    const lock = join(dir, '.config.lock');
    await writeFile(lock, '999999 0\n');
    expect(await withConfigLock(lock, async () => 'ok', { timeoutMs: 200 })).toBe('ok');
    await writeFile(lock, `${process.pid} 0\n`);
    await utimes(lock, new Date(0), new Date(0));
    expect(await withConfigLock(lock, async () => 'ok2', { timeoutMs: 200, staleMs: 1_000 })).toBe('ok2');
  });
});
