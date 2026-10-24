// codex API 키 연결(provider lane). 값이 어디로 가는지(env 하나·argv 에는 이름만), 셸 env 걷기 셋, 판 관문, 로그인 파일 fail-closed.
// 근거는 `providerLane.ts::codexLaneArgs` 주석의 실측(codex-cli 0.154.0, 가짜 Responses 서버·가짜 키).
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_LANE_BASE_URL_ENV, CODEX_LANE_KEY_ENV, codexLaneArgs, codexLaneVersionOk, createProviderLane, laneModelMissing } from '../src/providerLane.js';
import { buildTurnCommand, laneEnvAllowed } from '../src/turn.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'codex-lane-'));
  const dir = join(root, 'turn-secrets', 'lease-1');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'secret-1');
  await writeFile(path, 'tok-codex\n');
  const codexHome = join(root, 'codex-provider-lane');
  await mkdir(codexHome, { recursive: true });
  return { root, secretsDir: join(root, 'turn-secrets'), path, codexHome };
}

const ok = (lane: unknown) => async () => ({ status: 200, body: JSON.stringify({ lane }) });

describe('codex lane envFor', () => {
  it('키와 주소 둘만 돌려준다 — 판은 잰 판, 홈에 로그인 파일 없음', async () => {
    const t = await setup();
    const lane = createProviderLane({
      mount: ok({ baseUrl: 'https://gateway.example/', path: t.path }), turnSecretsDir: t.secretsDir,
      harnessVersion: async () => 'codex-cli 0.154.0\n', codexHome: t.codexHome,
    });
    expect(await lane.envFor('m1', 'codex')).toEqual({ [CODEX_LANE_KEY_ENV]: 'tok-codex', [CODEX_LANE_BASE_URL_ENV]: 'https://gateway.example' });
  });

  // 2026-10-25 jaebin: 판으로 막지 않는다 — 잰 판 밖이면 키 받기까지 가고 경고 한 줄을 남긴다(security G1).
  it('잰 판 밖이거나 못 읽어도 판으로 막지 않는다 — 경고를 남긴다', async () => {
    const t = await setup();
    let mounted = 0;
    const versions = ['codex-cli 0.154.1', 'codex-cli 0.153.0', '0.154.0', 'codex-cli 0.154.0-alpha', null, 'garbage'];
    for (const v of versions) {
      const lane = createProviderLane({
        mount: async () => { mounted++; return { status: 200, body: '{}' }; },
        turnSecretsDir: t.secretsDir, harnessVersion: async () => v, codexHome: t.codexHome,
      });
      // 시험 서버는 lane 을 주지 않는다 — 판 다음 단계(키 받기)까지 갔다는 표지가 `lane_unset` 이다.
      await expect(lane.envFor('m1', 'codex')).rejects.toMatchObject({ code: 'lane_unset' });
      expect(lane.takeNotice('m1')).toContain('0.154.0');
    }
    expect(mounted).toBe(versions.length);
    expect(codexLaneVersionOk('codex-cli 0.154.0')).toBe(true);
  });

  it('lane 홈에 auth.json 이 있으면 `harness_login_present` — 계정 로그인으로 돌 길을 남기지 않는다', async () => {
    const t = await setup();
    await writeFile(join(t.codexHome, 'auth.json'), '{}');
    let mounted = 0;
    const lane = createProviderLane({
      mount: async () => { mounted++; return ok({ baseUrl: 'https://gateway.example', path: t.path })(); }, turnSecretsDir: t.secretsDir,
      harnessVersion: async () => 'codex-cli 0.154.0', codexHome: t.codexHome,
    });
    await expect(lane.envFor('m1', 'codex')).rejects.toMatchObject({ code: 'harness_login_present' });
    // 띄우지 않을 턴은 임대를 받지 않는다(security n1).
    expect(mounted).toBe(0);
  });

  it('lane 홈을 모르면 띄우지 않는다', async () => {
    const t = await setup();
    const lane = createProviderLane({
      mount: ok({ baseUrl: 'https://gateway.example', path: t.path }), turnSecretsDir: t.secretsDir, harnessVersion: async () => 'codex-cli 0.154.0',
    });
    await expect(lane.envFor('m1', 'codex')).rejects.toMatchObject({ code: 'no_turn_secrets_dir' });
  });
});

describe('codex lane 조립', () => {
  const base = {
    harness: 'codex' as const, mode: 'mention' as const, sessionId: null, isFirstTurn: true,
    systemPrompt: 'SYS', promptCtx: 'CTX', model: 'ExampleOrg/example-model', effort: null,
    mentionPermission: 'auto' as const, mcpConfigPath: '/mcp.json', operatorBin: '/opt/harkroom/harkroom-operator',
    codexHome: '/state/codex-provider-lane', systemPromptFile: '/state/system-prompt.txt', stdinFile: null, claudeConfigDir: null,
  };
  const providerEnv = { [CODEX_LANE_KEY_ENV]: 'tok-codex', [CODEX_LANE_BASE_URL_ENV]: 'https://gateway.example' };

  it('키는 env 하나로만 — argv 에는 env 이름만, 주소 운반용 이름은 자식 env 에서 뺀다', () => {
    const plan = buildTurnCommand({ ...base, providerEnv });
    expect(plan.env[CODEX_LANE_KEY_ENV]).toBe('tok-codex');
    expect(CODEX_LANE_BASE_URL_ENV in plan.env).toBe(false);
    expect(plan.env.CODEX_HOME).toBe('/state/codex-provider-lane');
    expect(plan.args.join('\n')).not.toContain('tok-codex');
    // 남은 이름은 모두 허용 목록이거나 러너가 그 턴에 얹은 것이다.
    const runnerSet = new Set([CODEX_LANE_KEY_ENV, 'CODEX_HOME', 'HARKROOM_TURN_CAUSE', 'HARKROOM_TURN_ID']);
    expect(Object.keys(plan.env).filter((k) => !laneEnvAllowed(k) && !runnerSet.has(k))).toEqual([]);
  });

  it('provider·셸 env 걷기 셋·자동 업데이트 끄기를 싣는다 — 모델은 gateway 원문 그대로', () => {
    const { args } = buildTurnCommand({ ...base, providerEnv });
    const overrides = args.filter((_, i) => args[i - 1] === '-c');
    for (const o of codexLaneArgs('https://gateway.example').filter((_, i, a) => a[i - 1] === '-c')) expect(overrides).toContain(o);
    expect(overrides).toContain('model_provider="harkroom-lane"');
    expect(overrides).toContain('model_providers.harkroom-lane.base_url="https://gateway.example/v1"');
    expect(overrides).toContain('model_providers.harkroom-lane.env_key="HARKROOM_LANE_API_KEY"');
    expect(overrides).toContain('model_providers.harkroom-lane.wire_api="responses"');
    // TUI 는 셸 스냅숏이 정책을 우회했다(실측) — 정책·스냅숏·로그인 셸 셋이 다 있어야 한다.
    expect(overrides).toContain('shell_environment_policy.ignore_default_excludes=false');
    expect(overrides).toContain('shell_environment_policy.exclude=["HARKROOM_LANE_API_KEY","HARKROOM_LANE_BASE_URL"]');
    expect(overrides).toContain('features.shell_snapshot=false');
    expect(overrides).toContain('allow_login_shell=false');
    expect(overrides).toContain('check_for_update_on_startup=false');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'ExampleOrg/example-model']);
  });

  it('lane 이 아니면 provider 덮어쓰기가 없다', () => {
    const { args, env } = buildTurnCommand({ ...base });
    expect(args.some((a) => a.startsWith('model_provider'))).toBe(false);
    expect(CODEX_LANE_KEY_ENV in env).toBe(false);
  });

  it('주소가 없으면 조립을 거절한다 — 기본 provider 로 뜨지 않는다', () => {
    expect(() => buildTurnCommand({ ...base, providerEnv: { [CODEX_LANE_KEY_ENV]: 'tok-codex' } })).toThrow(/주소가 없다/);
  });
});

describe('codex lane 모델', () => {
  it('lane codex 는 모델이 비었거나 문법에 안 맞으면 `bad_model` 로 멈춘다 — 기본 모델 이름이 gateway 로 가지 않게', () => {
    for (const m of [null, undefined, '', '   ', 'a b', 'x{y}']) expect(laneModelMissing(true, 'codex', m)).toBe(true);
    expect(laneModelMissing(true, 'codex', 'ExampleOrg/example-model')).toBe(false);
    // lane 이 아니거나 다른 하네스면 보지 않는다(opencode 는 `opencodeLaneModelMissing` 이 따로 본다).
    expect(laneModelMissing(false, 'codex', null)).toBe(false);
    expect(laneModelMissing(true, 'claude-code', null)).toBe(false);
  });
});
