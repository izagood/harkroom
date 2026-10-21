import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProviderLane, ProviderLaneError } from '../src/providerLane.js';

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

  it('opencode 에는 lane provider 블록이 `{env:}` 로 읽는 두 이름만 — 키는 `ANTHROPIC_*` 로 가지 않는다(ⓕ)', async () => {
    const t = await setup();
    const lane = createProviderLane({ mount: ok({ baseUrl: 'https://gateway.example', path: t.path }), turnSecretsDir: t.secretsDir });
    expect(await lane.envFor('m1', 'opencode')).toEqual({
      HARKROOM_PROVIDER_BASE_URL: 'https://gateway.example', HARKROOM_PROVIDER_TOKEN: 'tok-123',
    });
    // 포크(Kilo)는 아직 표에 없다 — 넣을 자리를 모르면 던진다.
    await expect(lane.envFor('m1', 'kilo')).rejects.toMatchObject({ code: 'harness_unsupported' });
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
