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
import { mkdtemp, mkdir, readFile, writeFile, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ensureOpencodeHome, opencodeConfigFile, opencodeDirs, opencodeLaneModelMissing, OPENCODE_READONLY_AGENT, providerLaneModelId, PROVIDER_LANE_MODEL_KEEP, stripJsonc, toOpencodeMcp,
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
  it('사람의 provider·모델·로그인을 물리지 않고 lane 블록 하나만 연다 — 값은 `{env:}` 참조뿐이다', async () => {
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
      options: { baseURL: '{env:HARKROOM_PROVIDER_BASE_URL}/v1', apiKey: '{env:HARKROOM_PROVIDER_TOKEN}' },
      models: { 'example-model': { name: 'example-model' } },
    });
    // 다른 provider(무료 티어·사람 로그인)로 돌지 않는다.
    expect(cfg.enabled_providers).toEqual(['harkroom-lane']);
    expect(cfg.model).toBe('harkroom-lane/example-model');
    expect(cfg.agent[OPENCODE_READONLY_AGENT].model).toBe('harkroom-lane/example-model');
    expect(text).not.toContain('gateway.example');
    expect(cfg.mcp).toEqual({ harkroom: expect.objectContaining({ type: 'local' }) });
    expect(cfg.mcp.gmail).toBeUndefined();
    // 사람 로그인을 링크하지 않는다(ⓒ).
    expect(await lstat(join(opencodeDirs(f.home).XDG_DATA_HOME, 'opencode', 'auth.json')).catch(() => null)).toBeNull();
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

  it('모델을 모르거나 lane 모델이 아니면 목록을 비운다 — 그 턴은 실패하고 다른 provider 로 안 떨어진다', async () => {
    const f = await fixture();
    await ensureOpencodeHome({
      opencodeHome: f.home, mcpServers: BRIDGE, sourceConfig: f.sourceConfig, sourceData: f.sourceData, providerLane: { model: 'rro/some/model' },
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
  });
});

// 2026-10-23 watcher: lane 을 claude-code 로 켠 뒤 하네스만 opencode 로 바꿔 모델이 `ExampleOrg/…` 로 남았다. 띄우면 「Connect a
// provider」 창에서 10분 서 있다가 정지로 접혔다 — 러너는 띄우기 전에 까닭 코드로 실패해야 한다.
describe('opencode lane 모델이 lane 모양이 아니면 띄우지 않는다', () => {
  it('lane·opencode·lane 모양 아님 → 참', () => {
    expect(opencodeLaneModelMissing(true, true, 'ExampleOrg/example-model')).toBe(true);
    expect(opencodeLaneModelMissing(true, true, null)).toBe(true);
  });
  it('lane 모양이거나, lane 이 아니거나, 설정 파일로 모델을 고르지 않는 하네스(claude)면 거짓', () => {
    expect(opencodeLaneModelMissing(true, true, 'harkroom-lane/ExampleOrg/example-model')).toBe(false);
    expect(opencodeLaneModelMissing(false, true, 'ExampleOrg/example-model')).toBe(false);
    expect(opencodeLaneModelMissing(true, false, 'ExampleOrg/example-model')).toBe(false);
  });
});
