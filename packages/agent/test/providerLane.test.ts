import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProviderLane, kiloLaneVersionOk, laneScrubsSubprocessEnv, PROVIDER_LANE_FIXED_ENV, LANE_MCP_CONFIG_FILE, opencodeLaneVersionOk, ProviderLaneError, sweepLaneTurnDir, writeLaneMcpConfig, writeOpencodeLaneTurnConfig } from '../src/providerLane.js';

async function setup(value = 'tok-123\n') {
  const root = await mkdtemp(join(tmpdir(), 'lane-'));
  const dir = join(root, 'turn-secrets', 'lease-1');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'secret-1');
  await writeFile(path, value);
  return { root, secretsDir: join(root, 'turn-secrets'), path };
}

const ok = (lane: unknown) => async () => ({ status: 200, body: JSON.stringify({ lane }) });

describe('providerLane.envFor', () => {
  it('claude 에는 base URL·키 두 개만 — 끝 줄바꿈은 뗀다', async () => {
    const t = await setup();
    const lane = createProviderLane({ mount: ok({ baseUrl: 'https://gateway.example/', path: t.path }), turnSecretsDir: t.secretsDir });
    expect(await lane.envFor('m1', 'claude-code')).toEqual({
      ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_AUTH_TOKEN: 'tok-123',
    });
  });

  // Y1~Y3: opencode 에는 키 값을 env 로 주지 않는다 — 턴 파일 경로 하나만 주고, 그 파일은 키 파일을 `{file:…}` 로 가리킨다.
  it('opencode 에는 턴 파일 경로(`OPENCODE_CONFIG`) 하나만 — 키 값은 env 에도 턴 파일에도 없다', async () => {
    const t = await setup();
    const laneTurnDir = join(t.root, 'state', 'lane-turn');
    const lane = createProviderLane({
      mount: ok({ baseUrl: 'https://gateway.example/', path: t.path }), turnSecretsDir: t.secretsDir,
      stateDir: join(t.root, 'state'), harnessVersion: async () => '1.18.32',
    });
    const env = await lane.envFor('m-1', 'opencode');
    expect(Object.keys(env)).toEqual(['OPENCODE_CONFIG']);
    expect(env.OPENCODE_CONFIG).toBe(join(laneTurnDir, 'm-1.json'));
    const text = await readFile(env.OPENCODE_CONFIG!, 'utf8');
    expect(text).not.toContain('tok-123');
    expect(JSON.parse(text)).toEqual({
      provider: { 'harkroom-lane': { options: { baseURL: 'https://gateway.example/v1', apiKey: `{file:${await realpathOf(t.path)}}` } } },
    });
    expect((await stat(env.OPENCODE_CONFIG!)).mode & 0o777).toBe(0o600);
    expect((await stat(laneTurnDir)).mode & 0o777).toBe(0o700);
    // 표에 없는 하네스는 넣을 자리를 모르니 던진다.
    await expect(lane.envFor('m1', 'gemini')).rejects.toMatchObject({ code: 'harness_unsupported' });
  });

  // kilo: 턴 파일을 `KILO_CONFIG` 로 받는다(7.8.17 실측).
  it('kilo 에는 턴 파일 경로(`KILO_CONFIG`) 하나만 — 키 값은 env 에도 턴 파일에도 없고, 끝나면 거둔다', async () => {
    const t = await setup();
    const state = join(t.root, 'state');
    const lane = createProviderLane({
      mount: ok({ baseUrl: 'https://gateway.example/', path: t.path }), turnSecretsDir: t.secretsDir, stateDir: state, harnessVersion: async () => '7.8.17',
    });
    const env = await lane.envFor('m-2', 'kilo');
    expect(Object.keys(env)).toEqual(['KILO_CONFIG']);
    const text = await readFile(env.KILO_CONFIG!, 'utf8');
    expect(text).not.toContain('tok-123');
    expect(JSON.parse(text)).toEqual({
      provider: { 'harkroom-lane': { options: { baseURL: 'https://gateway.example/v1', apiKey: `{file:${await realpathOf(t.path)}}` } } },
    });
    await lane.release(env);
    expect(await readdir(join(state, 'lane-turn'))).toEqual([]);
  });

  it('kilo 판이 잰 목록(7.8.17)과 정확히 같지 않거나 못 읽으면 `harness_version` — 키를 받지 않는다', async () => {
    const t = await setup();
    let mounted = 0;
    for (const v of ['7.8.18', '7.8.1', '7.9.0', null, 'kilo 7.8.17', '7.8.17-beta', '1.18.32']) {
      const lane = createProviderLane({
        mount: async () => { mounted++; return { status: 200, body: JSON.stringify({ lane: { baseUrl: 'https://gateway.example', path: t.path } }) }; },
        turnSecretsDir: t.secretsDir, stateDir: join(t.root, 'st'), harnessVersion: async () => v,
      });
      await expect(lane.envFor('m1', 'kilo')).rejects.toMatchObject({ code: 'harness_version' });
    }
    expect(mounted).toBe(0);
    expect(kiloLaneVersionOk('7.8.17\n')).toBe(true);
  });

  // lane 턴은 프로젝트 설정을 읽지 않는다 — 실물 회귀는 `kiloLaneProjectConfig.real.test.ts`.
  it('lane kilo 고정 env 는 프로젝트 설정·사람 홈 지시·스킬을 끈다(이름은 KILO_*)', () => {
    expect(PROVIDER_LANE_FIXED_ENV.kilo).toEqual({
      KILO_DISABLE_PROJECT_CONFIG: '1', KILO_DISABLE_CLAUDE_CODE: '1', KILO_DISABLE_EXTERNAL_SKILLS: '1', KILO_DISABLE_AUTOUPDATE: '1',
    });
  });

  it('턴이 끝나면 그 턴 파일을 거두고, 턴 파일 자리 밖 경로는 건드리지 않는다(security L2 n1)', async () => {
    const t = await setup();
    const state = join(t.root, 'state');
    const lane = createProviderLane({
      mount: ok({ baseUrl: 'https://gateway.example', path: t.path }), turnSecretsDir: t.secretsDir, stateDir: state, harnessVersion: async () => '1.18.32',
    });
    const env = await lane.envFor('m-9', 'opencode');
    await lane.release(env);
    expect(await readdir(join(state, 'lane-turn'))).toEqual([]);
    await lane.release({ OPENCODE_CONFIG: t.path });
    expect(await readFile(t.path, 'utf8')).toBe('tok-123\n');
    await lane.release({ ANTHROPIC_AUTH_TOKEN: 'x' });
  });

  it('opencode 판이 잰 목록과 정확히 같지 않거나 못 읽으면 `harness_version` — 키를 받지 않는다(security F1)', async () => {
    const t = await setup();
    let mounted = 0;
    for (const v of ['1.18.33', '1.19.0', '1.18.31', '2.0.0', null, 'garbage', 'opencode 1.18.32', '1.18.32-beta']) {
      const lane = createProviderLane({
        mount: async () => { mounted++; return { status: 200, body: JSON.stringify({ lane: { baseUrl: 'https://gateway.example', path: t.path } }) }; },
        turnSecretsDir: t.secretsDir, stateDir: join(t.root, 'st'), harnessVersion: async () => v,
      });
      await expect(lane.envFor('m1', 'opencode')).rejects.toMatchObject({ code: 'harness_version' });
    }
    expect(mounted).toBe(0);
    expect(opencodeLaneVersionOk('1.18.32\n')).toBe(true);
  });

  it('판은 턴마다 묻는다 — 러너가 사는 사이 opencode 가 스스로 바뀌면 다음 턴이 막힌다', async () => {
    const t = await setup();
    let current = '1.18.32';
    let asked = 0;
    const lane = createProviderLane({
      mount: ok({ baseUrl: 'https://gateway.example', path: t.path }), turnSecretsDir: t.secretsDir, stateDir: join(t.root, 'st'),
      harnessVersion: async () => { asked++; return current; },
    });
    await lane.envFor('m1', 'opencode');
    current = '1.18.33';
    await expect(lane.envFor('m2', 'opencode')).rejects.toMatchObject({ code: 'harness_version' });
    expect(asked).toBe(2);
  });

  it('lane opencode 고정 env 는 자동 업데이트를 끈다', () => {
    expect(PROVIDER_LANE_FIXED_ENV.opencode).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
  });

  it('턴 파일 자리가 없으면 opencode lane 은 실패한다', async () => {
    const t = await setup();
    const lane = createProviderLane({ mount: ok({ baseUrl: 'https://gateway.example', path: t.path }), turnSecretsDir: t.secretsDir, harnessVersion: async () => '1.18.32' });
    await expect(lane.envFor('m1', 'opencode')).rejects.toMatchObject({ code: 'no_turn_secrets_dir' });
  });

  it('설정이 없다는 답(lane null)은 던진다 — 계정 로그인으로 떨어지지 않는다', async () => {
    const t = await setup();
    const lane = createProviderLane({ mount: ok(null), turnSecretsDir: t.secretsDir });
    await expect(lane.envFor('m1', 'claude-code')).rejects.toMatchObject({ code: 'lane_unset' });
  });

  it('오퍼레이터의 거절 코드를 그대로 싣는다', async () => {
    const t = await setup();
    const lane = createProviderLane({
      mount: async () => ({ status: 409, body: JSON.stringify({ error: { code: 'no_lease' } }) }), turnSecretsDir: t.secretsDir,
    });
    await expect(lane.envFor('m1', 'claude-code')).rejects.toMatchObject({ code: 'no_lease' });
  });

  it('턴 비밀 루트 밖 경로는 읽지 않는다', async () => {
    const t = await setup();
    const outside = join(t.root, 'elsewhere');
    await writeFile(outside, 'stolen');
    const lane = createProviderLane({ mount: ok({ baseUrl: 'https://gateway.example', path: outside }), turnSecretsDir: t.secretsDir });
    await expect(lane.envFor('m1', 'claude-code')).rejects.toMatchObject({ code: 'bad_path' });
  });

  it('평문 http 원격 주소는 받지 않는다', async () => {
    const t = await setup();
    const lane = createProviderLane({ mount: ok({ baseUrl: 'http://gateway.example', path: t.path }), turnSecretsDir: t.secretsDir });
    await expect(lane.envFor('m1', 'claude-code')).rejects.toMatchObject({ code: 'bad_base_url' });
  });

  it('여러 줄 값·키를 모르는 하네스·링크 오류는 던진다', async () => {
    const multi = await setup('a\nb');
    await expect(createProviderLane({ mount: ok({ baseUrl: 'https://gateway.example', path: multi.path }), turnSecretsDir: multi.secretsDir })
      .envFor('m1', 'claude-code')).rejects.toMatchObject({ code: 'bad_value' });
    const t = await setup();
    await expect(createProviderLane({ mount: ok({ baseUrl: 'https://gateway.example', path: t.path }), turnSecretsDir: t.secretsDir })
      .envFor('m1', 'codex')).rejects.toBeInstanceOf(ProviderLaneError);
    await expect(createProviderLane({ mount: async () => { throw new Error('down'); }, turnSecretsDir: t.secretsDir })
      .envFor('m1', 'claude-code')).rejects.toMatchObject({ code: 'operator_unreachable' });
  });
});

describe('ProviderLaneError', () => {
  it('허용 목록 밖 코드는 unknown 으로 접고, 문장에도 코드만 싣는다', () => {
    const e = new ProviderLaneError('https://gateway.example/x');
    expect(e.code).toBe('unknown');
    expect(e.message).not.toContain('gateway.example');
    expect(new ProviderLaneError('no_lease').code).toBe('no_lease');
  });
});

describe('providerLane 결과 통지(2a)', () => {
  it('성공은 ok, 실패는 접힌 코드로 알린다 — 실패해도 던지는 것은 그대로', async () => {
    const t = await setup();
    const seen: unknown[] = [];
    const good = createProviderLane({ mount: ok({ baseUrl: 'https://gateway.example', path: t.path }), turnSecretsDir: t.secretsDir, report: (o, c) => seen.push([o, c]) });
    await good.envFor('m1', 'claude-code');
    const bad = createProviderLane({ mount: async () => ({ status: 502, body: JSON.stringify({ error: { code: 'https://x' } }) }), turnSecretsDir: t.secretsDir, report: (o, c) => seen.push([o, c]) });
    await expect(bad.envFor('m1', 'claude-code')).rejects.toBeInstanceOf(ProviderLaneError);
    expect(seen).toEqual([[true, undefined], [false, 'unknown']]);
  });
});

// L1(2026-10-24 실측 claude 2.1.309): lane 턴은 하위 프로세스 env 를 걷는다 — 그러면 harkroom 브릿지가 러너 secret 을 잃으므로
// lane 전용 MCP 설정의 harkroom `env` 칸으로 준다. 브릿지가 쓰는 이름만, 0600, 러너 상태 폴더에(security X1·X2).
describe('writeLaneMcpConfig', () => {
  async function source(servers: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), 'lane-mcp-'));
    const path = join(dir, 'operator-mcp.json');
    await writeFile(path, JSON.stringify({ mcpServers: servers }));
    return { dir, path };
  }
  const harkroom = { command: '/x/harkroom-operator', args: ['mcp-bridge'] };

  it('harkroom 항목 env 에 러너 secret 만 싣고, 0600 으로 상태 폴더에 쓴다 — lane 키·다른 항목은 건드리지 않는다', async () => {
    const { dir, path } = await source({ harkroom, avcs: { command: 'avcs', args: ['mcp'] } });
    const out = await writeLaneMcpConfig(dir, path, { HARKROOM_RUNNER_SECRET: 'sec-1', ANTHROPIC_AUTH_TOKEN: 'lane-key', HARKROOM_RUNNER_ID: 'r1' });
    expect(out).toBe(join(dir, LANE_MCP_CONFIG_FILE));
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(await readFile(out, 'utf8')) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    expect(doc.mcpServers.harkroom?.env).toEqual({ HARKROOM_RUNNER_SECRET: 'sec-1' });
    expect(JSON.stringify(doc)).not.toContain('lane-key');
    expect(doc.mcpServers.avcs).toEqual({ command: 'avcs', args: ['mcp'] });
  });

  it('러너 secret 이 없거나 harkroom 항목이 없으면 던진다 — 조용히 브릿지가 끊긴 채 띄우지 않는다', async () => {
    const a = await source({ harkroom });
    await expect(writeLaneMcpConfig(a.dir, a.path, {})).rejects.toThrow(/HARKROOM_RUNNER_SECRET/);
    const b = await source({ avcs: { command: 'avcs' } });
    await expect(writeLaneMcpConfig(b.dir, b.path, { HARKROOM_RUNNER_SECRET: 's' })).rejects.toThrow(/harkroom/);
  });

  it('env 를 걷는 하네스만 이 길을 탄다', () => {
    expect(laneScrubsSubprocessEnv('claude-code')).toBe(true);
    expect(laneScrubsSubprocessEnv('opencode')).toBe(false);
  });
});

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}

// Z2: 턴 파일은 공유 설정 **뒤에** 합쳐진다 — 여기 권한·에이전트·MCP 칸이 있으면 lane 권한을 덮는다.
describe('writeOpencodeLaneTurnConfig', () => {
  it('provider 주소·키 파일 참조 말고는 아무 칸도 쓰지 않는다(권한 칸 없음)', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'lt-')), 'lane-turn');
    const path = await writeOpencodeLaneTurnConfig(dir, 'm1', { baseUrl: 'https://gateway.example', keyPath: '/secrets/k' });
    const doc = JSON.parse(await readFile(path, 'utf8'));
    expect(Object.keys(doc)).toEqual(['provider']);
    expect(Object.keys(doc.provider)).toEqual(['harkroom-lane']);
    expect(Object.keys(doc.provider['harkroom-lane'])).toEqual(['options']);
    expect(doc.provider['harkroom-lane'].options).toEqual({ baseURL: 'https://gateway.example/v1', apiKey: '{file:/secrets/k}' });
    // 받는 칸이 주소·키 경로 둘뿐이다 — 다른 것을 넣을 길이 없다.
    expect(writeOpencodeLaneTurnConfig.length).toBe(3);
  });

  it('중괄호·줄바꿈이 섞인 값·상대 경로는 거절한다(opencode 가 본문의 `{env:}`·`{file:}` 를 바꿔 넣는다)', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'lt-')), 'lane-turn');
    await expect(writeOpencodeLaneTurnConfig(dir, 'm1', { baseUrl: 'https://g.example/{env:HOME}', keyPath: '/k' })).rejects.toMatchObject({ code: 'bad_base_url' });
    await expect(writeOpencodeLaneTurnConfig(dir, 'm1', { baseUrl: 'https://g.example', keyPath: '/k}{file:/etc/passwd' })).rejects.toMatchObject({ code: 'bad_path' });
    await expect(writeOpencodeLaneTurnConfig(dir, 'm1', { baseUrl: 'https://g.example', keyPath: 'rel/k' })).rejects.toMatchObject({ code: 'bad_path' });
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it('기동 때 남은 턴 파일을 걷는다', async () => {
    const state = await mkdtemp(join(tmpdir(), 'lt-'));
    const dir = join(state, 'lane-turn');
    await writeOpencodeLaneTurnConfig(dir, 'old', { baseUrl: 'https://g.example', keyPath: '/k' });
    await sweepLaneTurnDir(state);
    expect(await readdir(dir)).toEqual([]);
    await sweepLaneTurnDir(join(state, 'missing'));
  });
});
