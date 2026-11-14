import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_LINK_ENV, RUNNER_TURN_KEY_ENV } from '@harkroom/shared/runnerLink';
import { buildTurnCommand, turnKeyDelivery } from '../src/turn.js';
import { turnKeyDeliveryOf } from '../src/adapters/index.js';
import { piMcpListEnv } from '../src/queryEnv.js';
import { listToolsWithTurnKeys } from '../src/mentionTurn.js';

const keys = { bridge: 'b'.repeat(64), shell: 'c'.repeat(64) };
const base = {
  systemPrompt: 'SYS', promptCtx: 'CTX', model: null, effort: null,
  mentionPermission: 'auto' as const, mcpConfigPath: '/mcp.json',
  operatorBin: '/opt/harkroom/harkroom-operator', piHome: '/state/pi-home', codexHome: '/state/codex-home',
  systemPromptFile: '/state/system-prompt.txt', stdinFile: null, claudeConfigDir: null,
  mode: 'mention' as const, isFirstTurn: true, sessionId: '11111111-2222-4333-8444-555555555555',
};

describe('pi 턴 열쇠 — env 로 다리에 준다', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env[RUNNER_LINK_ENV.secret] = 'LINK-SECRET';
    process.env[RUNNER_LINK_ENV.socketPath] = '/s/op.sock';
    process.env[RUNNER_LINK_ENV.runnerId] = 'runner-1';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('pi 는 env-vars 전달이다', () => {
    expect(turnKeyDeliveryOf('pi')).toBe('env-vars');
    expect(turnKeyDelivery('pi')).toBe(true);
  });

  it('열쇠 턴: pi 자식 env 에 링크 열쇠가 없고 다리·셸 열쇠가 있다 · argv 에 값이 없다', () => {
    const p = buildTurnCommand({ ...base, harness: 'pi', turnKeys: keys });
    expect(p.env[RUNNER_LINK_ENV.secret]).toBeUndefined();
    expect(p.env[RUNNER_TURN_KEY_ENV.bridge]).toBe(keys.bridge);
    expect(p.env[RUNNER_TURN_KEY_ENV.shell]).toBe(keys.shell);
    expect(p.env[RUNNER_LINK_ENV.socketPath]).toBe('/s/op.sock');
    expect(Object.values(p.env)).not.toContain('LINK-SECRET');
    expect(p.args.join(' ')).not.toContain(keys.bridge);
  });

  it('pi mcp list env: 소켓·runnerId·다리 열쇠만 — 링크 열쇠·셸 열쇠 없음', () => {
    const env = piMcpListEnv('pi', { ...process.env, [RUNNER_TURN_KEY_ENV.shell]: 'SHELL-KEY', GH_TOKEN: 't' }, '/r/pi', keys.bridge);
    expect(env[RUNNER_TURN_KEY_ENV.bridge]).toBe(keys.bridge);
    expect(env[RUNNER_LINK_ENV.socketPath]).toBe('/s/op.sock');
    expect(env[RUNNER_LINK_ENV.runnerId]).toBe('runner-1');
    expect(env.PI_CODING_AGENT_DIR).toBe('/r/pi');
    expect(env[RUNNER_LINK_ENV.secret]).toBeUndefined();
    expect(env[RUNNER_TURN_KEY_ENV.shell]).toBeUndefined();
    expect(Object.values(env)).not.toContain('LINK-SECRET');
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

describe('도구 묻기용 턴 열쇠 — 맡기고 묻고 거둔다', () => {
  const turn = { turnId: 't1', cause: 'm1', keys };

  it('맡기기가 실패하면 묻지 않고 null(내장 도구로 닫음) — 링크 열쇠로 묻는 길이 없다', async () => {
    const list = vi.fn(async () => ({ harkroom: ['x'] }));
    const end = vi.fn(async () => undefined);
    const got = await listToolsWithTurnKeys({ registerTurnKeys: async () => { throw new Error('relay down'); }, endTurnKeys: end }, turn, 'k', list);
    expect(got).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('묻고 나면 열쇠를 거둔다 — 묻기가 던져도 거둔다', async () => {
    const order: string[] = [];
    const h = {
      registerTurnKeys: async () => { order.push('register'); },
      endTurnKeys: async (id: string) => { order.push(`end:${id}`); },
    };
    expect(await listToolsWithTurnKeys(h, turn, 'k', async () => { order.push('list'); return { harkroom: ['a'] }; })).toEqual({ harkroom: ['a'] });
    expect(order).toEqual(['register', 'list', 'end:t1']);
    order.length = 0;
    await expect(listToolsWithTurnKeys(h, turn, 'k', async () => { order.push('list'); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(order).toEqual(['register', 'list', 'end:t1']);
  });
});

describe('mentionTurn 배선', () => {
  const src = readFileSync(new URL('../src/mentionTurn.ts', import.meta.url), 'utf8');
  it('API 키 연결 pi 턴은 턴 열쇠 없이 띄우지 않는다(turn_key_missing)', () => {
    expect(src).toContain("if (deps.providerEnv && usesPiHome(def.harness) && !turnKeys) throw new ProviderLaneError('turn_key_missing');");
  });
  it('pi 도구 묻기는 턴 열쇠로만 — 열쇠가 없으면 묻지 않는다', () => {
    const call = src.slice(src.indexOf('const discovered = turnKeys'));
    const body = call.slice(0, call.indexOf(': null;'));
    expect(body).toContain('listToolsWithTurnKeys(');
    expect(body).toContain('piMcpListEnv(def.harness, process.env, turnPiHome, turnKeys.bridge)');
  });
});
