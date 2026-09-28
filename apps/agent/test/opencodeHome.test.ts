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
  ensureOpencodeHome, opencodeConfigFile, opencodeDirs, OPENCODE_READONLY_AGENT, toOpencodeMcp,
} from '../src/opencodeHome.js';

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
