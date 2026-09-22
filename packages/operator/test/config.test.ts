// 오퍼레이터 로컬 설정과 시크릿 — 스펙 2026-09-20 §3 능력. 머신 종속 값(작업 디렉터리·계정
// 풀)은 서버가 아니라 여기 산다: A컴퓨터의 워크스페이스 경로가 B컴퓨터에 있을 이유가 없다.
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readConfig, rememberOperatorId, writeConfig, type OperatorConfig } from '../src/config.js';
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
