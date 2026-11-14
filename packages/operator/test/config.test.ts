// 오퍼레이터 로컬 설정과 시크릿 — 스펙 2026-09-20 §3 능력. 머신 종속 값(작업 디렉터리·계정
// 풀)은 서버가 아니라 여기 산다: A컴퓨터의 워크스페이스 경로가 B컴퓨터에 있을 이유가 없다.
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readConfig, readConfigForWrite, readLocalAgent, rememberOperatorId, runnerKindOf, updateConfig, writeConfig, type LocalAgentConfig, type OperatorConfig } from '../src/config.js';
import { MERGE_SCOPE_RE } from '@harkroom/shared/daemonProtocol';
import { fileSecrets } from '../src/secrets.js';

describe('operator.json', () => {
  it('없으면 빈 설정이다 — 던지지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    expect(await readConfig(join(dir, 'operator.json'))).toEqual({ communities: {} });
  });
  it('쓰고 읽으면 같고, 임시 파일이 남지 않는다(원자적)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    const path = join(dir, 'operator.json');
    const cfg: OperatorConfig = {
      communities: { 'https://example.com': { agents: { 'a-1': { workingDir: '~/dev/x', claudePool: 'work' } } } },
    };
    await writeConfig(path, cfg);
    expect(await readConfig(path)).toEqual(cfg);
    expect((await readdir(dir)).filter((n) => n !== 'operator.json')).toEqual([]);
  });
  it('깨진 파일은 빈 설정으로 읽되 덮어쓰지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    const path = join(dir, 'operator.json');
    await writeConfig(path, { communities: {} });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{not json', 'utf8');
    expect(await readConfig(path)).toEqual({ communities: {} });
    expect(await readFile(path, 'utf8')).toBe('{not json');
  });
  it('오퍼레이터 id 를 적고, 에이전트 표는 건드리지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    const path = join(dir, 'operator.json');
    await writeConfig(path, { communities: { 'https://example.com': { agents: { 'a-1': { workingDir: '~/x' } } } } });
    // 끝 슬래시는 같은 커뮤니티다 — 키를 정규화하지 않으면 섹션이 둘로 갈린다.
    await rememberOperatorId(path, 'https://example.com/', 'op-1');
    expect((await readConfig(path)).communities['https://example.com'])
      .toEqual({ agents: { 'a-1': { workingDir: '~/x' } }, operatorId: 'op-1' });
  });
  it('같은 값이면 다시 쓰지 않는다 — 붙을 때마다 부르는 자리다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    const path = join(dir, 'operator.json');
    await rememberOperatorId(path, 'https://example.com', 'op-1');
    const first = (await stat(path)).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    await rememberOperatorId(path, 'https://example.com', 'op-1');
    expect((await stat(path)).mtimeMs).toBe(first);
  });
});

describe('fileSecrets', () => {
  it('커뮤니티별 토큰을 0600 파일에 두고 되읽는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-sec-'));
    const secrets = fileSecrets(dir);
    expect(await secrets.getToken('https://example.com')).toBeNull();
    await secrets.setToken('https://example.com', 'hkop_abc');
    expect(await secrets.getToken('https://example.com')).toBe('hkop_abc');
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const mode = (await stat(join(dir, files[0]!))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  it('서버가 달라도 같은 이름을 쓰지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-sec-'));
    const secrets = fileSecrets(dir);
    await secrets.setToken('https://a.example.com', 'hkop_a');
    await secrets.setToken('https://b.example.com', 'hkop_b');
    expect(await secrets.getToken('https://a.example.com')).toBe('hkop_a');
    expect(await secrets.getToken('https://b.example.com')).toBe('hkop_b');
  });
});

describe('operator.json 읽고-고치고-쓰기(s21d)', () => {
  it('깨진 파일은 덮어쓰지 않는다 — updateConfig·rememberOperatorId 가 던지고 원문이 남는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    const path = join(dir, 'operator.json');
    await writeFile(path, '{"communities": {"x": ');
    await expect(readConfigForWrite(path)).rejects.toThrow('깨졌다');
    await expect(updateConfig(path, (c) => { c.communities.y = { agents: {} }; })).rejects.toThrow('깨졌다');
    await expect(rememberOperatorId(path, 'https://e.com', 'op-1')).rejects.toThrow('깨졌다');
    expect(await readFile(path, 'utf8')).toBe('{"communities": {"x": ');
    await writeFile(path, '[]');
    await expect(updateConfig(path, () => undefined)).rejects.toThrow('모양이 아니다');
    expect(await readFile(path, 'utf8')).toBe('[]');
  });
  it('동시 고치기 8개가 서로를 지우지 않는다(잠금) · 임시 파일·잠금이 남지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    const path = join(dir, 'operator.json');
    await Promise.all(Array.from({ length: 8 }, (_, i) => updateConfig(path, (c) => {
      const s = (c.communities['https://e.com'] ??= { agents: {} });
      s.agents[`a-${i}`] = { workingDir: `/w/${i}` };
    })));
    const cfg = await readConfig(path);
    expect(Object.keys(cfg.communities['https://e.com']!.agents)).toHaveLength(8);
    expect((await readdir(dir)).sort()).toEqual(['operator.json']);
  });
  it('edit 가 false 면 쓰지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    const path = join(dir, 'operator.json');
    await updateConfig(path, () => false);
    expect(await readdir(dir)).toEqual([]);
  });
  it('같은 ms 의 writeConfig 여럿도 임시 이름이 겹치지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cfg-'));
    const path = join(dir, 'operator.json');
    await Promise.all(Array.from({ length: 10 }, () => writeConfig(path, { communities: {} })));
    expect(await readdir(dir)).toEqual(['operator.json']);
    expect(await readConfig(path)).toEqual({ communities: {} });
  });
});

describe('MERGE_SCOPE_RE(s21d)', () => {
  it('저장소 칸 `.`·`..` 을 거절한다', () => {
    expect(MERGE_SCOPE_RE.test('izagood/.')).toBe(false);
    expect(MERGE_SCOPE_RE.test('izagood/..')).toBe(false);
    expect(MERGE_SCOPE_RE.test('izagood/..x')).toBe(true);
    expect(MERGE_SCOPE_RE.test('izagood/.github')).toBe(true);
    expect(MERGE_SCOPE_RE.test('izagood/*')).toBe(true);
  });
});

describe('runnerKindOf — 에이전트별 러너 구현(B4-5a)', () => {
  it('정확히 "rust" 일 때만 rust 다', () => {
    expect(runnerKindOf({ runner: 'rust' })).toBe('rust');
  });
  it('항목·칸이 없거나 node 거나 모르는 값이면 node 다', () => {
    expect(runnerKindOf(undefined)).toBe('node');
    expect(runnerKindOf({})).toBe('node');
    expect(runnerKindOf({ workingDir: '/w' })).toBe('node');
    expect(runnerKindOf({ runner: 'node' })).toBe('node');
    for (const v of ['Rust', 'RUST', ' rust', 'rs', '', 1, true, null, ['rust'], { kind: 'rust' }]) {
      expect(runnerKindOf({ runner: v } as unknown as LocalAgentConfig)).toBe('node');
    }
  });
  it('파일에서 읽은 그대로 판정한다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-runner-'));
    const path = join(dir, 'operator.json');
    await writeFile(path, JSON.stringify({ communities: { 'https://example.com': { agents: { a: { runner: 'rust' }, b: { runner: 'Rust' }, c: {} } } } }));
    const agents = (await readConfig(path)).communities['https://example.com']!.agents;
    expect([runnerKindOf(agents.a), runnerKindOf(agents.b), runnerKindOf(agents.c), runnerKindOf(agents.d)]).toEqual(['rust', 'node', 'node', 'node']);
  });
});

describe('README 의 operator.json 예시(B4-5d)', () => {
  it('JSON 으로 읽히고, runner:"rust" 칸만 rust 다', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('## 에이전트마다 Rust 러너 켜기'));
    const block = /```json\n([\s\S]*?)\n```/.exec(section);
    expect(block).not.toBeNull();
    const cfg = JSON.parse(block![1]!) as OperatorConfig;
    const agents = Object.values(cfg.communities)[0]!.agents;
    expect(Object.values(agents).map(runnerKindOf)).toEqual(['rust', 'node']);
  });
});

describe('readLocalAgent — 배정 직전 파일에서 다시 읽기', () => {
  it('손으로 고친 파일의 그 에이전트 칸을 지금 읽는다 · 없거나 깨졌으면 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-reread-'));
    const path = join(dir, 'operator.json');
    await writeFile(path, JSON.stringify({ communities: { 'https://example.com': { agents: { a: { workingDir: '/w' } } } } }));
    expect(readLocalAgent(path, 'https://example.com', 'a')).toEqual({ workingDir: '/w' });
    await writeFile(path, JSON.stringify({ communities: { 'https://example.com': { agents: { a: { workingDir: '/w', runner: 'rust' } } } } }));
    expect(readLocalAgent(path, 'https://example.com', 'a')).toEqual({ workingDir: '/w', runner: 'rust' });
    expect(readLocalAgent(path, 'https://example.com', 'b')).toBeUndefined();
    expect(readLocalAgent(path, 'https://other.example.com', 'a')).toBeUndefined();
    await writeFile(path, '{ broken');
    expect(readLocalAgent(path, 'https://example.com', 'a')).toBeUndefined();
  });
});
