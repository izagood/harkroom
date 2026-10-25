// codex 승인 명령 규칙·턴 hook 갖추기(`codexRules.ts`) — 판 고정·쓰기 자리·hook 신뢰(fail-closed)·argv.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_HOOK_SPEC_ENV, decodeCodexHookSpec, parseCodexRulesFile } from '@harkroom/shared/providerLane';
import {
  codexHomeOutsideWritable, codexHookCommand, codexHooksPath, codexRulesPath, codexRulesVersionOk, CodexRulesError,
  prepareCodexRules, withHookTrust, type CodexHookListEntry, type CodexRulesDeps,
} from '../src/codexRules.js';
import { buildTurnCommand } from '../src/turn.js';

const RULE = 'Bash(gh pr list -R cli/cli --limit 3)';
const OTHER = 'Bash(kubectl get pods)';
const BIN = '/opt/harkroom/harkroom-operator';

let root: string;
let home: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-rules-'));
  home = join(root, 'codex-home');
  work = join(root, 'work');
  await mkdir(home, { recursive: true });
  await mkdir(work);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** codex `hooks/list` 흉내 — config 에 적힌 hash 가 지금 hash 와 같으면 trusted. */
function fakeCodex(hash = 'sha256:abc', version: string | null = 'codex-cli 0.154.0') {
  const calls: string[] = [];
  const deps: CodexRulesDeps = {
    version: async () => version,
    writableRoots: (ws) => [ws],
    listHooks: async (h) => {
      calls.push('list');
      const hooks = await readFile(codexHooksPath(h), 'utf8').catch(() => null);
      if (hooks === null) return [];
      const config = await readFile(join(h, 'config.toml'), 'utf8').catch(() => '');
      const key = `${codexHooksPath(h)}:pre_tool_use:0:0`;
      const trusted = config.includes(`[hooks.state.${JSON.stringify(key)}]`) && config.includes(`trusted_hash = ${JSON.stringify(hash)}`);
      const entry: CodexHookListEntry = { key, sourcePath: codexHooksPath(h), eventName: 'preToolUse', currentHash: hash, trustStatus: trusted ? 'trusted' : 'untrusted' };
      return [entry];
    },
  };
  return { deps, calls };
}

const prepare = (deps: CodexRulesDeps, reach: string[] | null = [RULE, OTHER], rules: string[] = [RULE]) =>
  prepareCodexRules({ codexHome: home, workspaceDir: work, operatorBin: BIN, rules, reach }, deps);

describe('prepareCodexRules', () => {
  it('hook 을 쓰고 신뢰를 적은 뒤 다시 확인하고, 규칙 파일(합)과 턴 env(채널 규칙)를 낸다', async () => {
    const { deps, calls } = fakeCodex();
    const env = await prepare(deps);
    expect(calls).toEqual(['list', 'list']);
    expect(parseCodexRulesFile(await readFile(codexRulesPath(home), 'utf8'))).toEqual([RULE, OTHER]);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('trusted_hash = "sha256:abc"');
    expect(decodeCodexHookSpec(env[CODEX_HOOK_SPEC_ENV])).toEqual({ rules: [RULE], reach: [RULE, OTHER], codexHome: home });
    // 두 번째 턴은 이미 trusted — 한 번만 묻고 config 를 다시 쓰지 않는다.
    const before = (await stat(join(home, 'config.toml'))).mtimeMs;
    calls.length = 0;
    await prepare(deps);
    expect(calls).toEqual(['list']);
    expect((await stat(join(home, 'config.toml'))).mtimeMs).toBe(before);
  });

  it('hook 신뢰를 확인하지 못하면 던지고 규칙 파일을 남기지 않는다(fail-closed)', async () => {
    const { deps } = fakeCodex();
    await prepare(deps);
    const broken: CodexRulesDeps = { ...deps, listHooks: async () => [] };
    await expect(prepare(broken)).rejects.toBeInstanceOf(CodexRulesError);
    await expect(stat(codexRulesPath(home))).rejects.toThrow();
    const stillUntrusted: CodexRulesDeps = { ...deps, listHooks: async (h) => (await deps.listHooks(h, work)).map((e) => ({ ...e, trustStatus: 'modified' })) };
    await expect(prepare(stillUntrusted)).rejects.toBeInstanceOf(CodexRulesError);
  });

  it('W5 잰 판 밖·판을 못 읽음이면 규칙 파일을 쓰지 않고 남은 것도 지운다', async () => {
    await prepare(fakeCodex().deps);
    for (const v of ['codex-cli 0.155.0', null, 'codex 0.154.0']) {
      await writeFile(codexRulesPath(home), 'prefix_rule(pattern = ["ls"], decision = "allow")\n');
      expect(await prepare(fakeCodex('sha256:abc', v).deps)).toEqual({});
      await expect(stat(codexRulesPath(home))).rejects.toThrow();
    }
  });

  it('옛 서버(합 없음)·codex 홈이 쓰기 자리 안이면 규칙 파일을 쓰지 않는다', async () => {
    expect(await prepare(fakeCodex().deps, null)).toEqual({});
    await expect(stat(codexRulesPath(home))).rejects.toThrow();
    const inside: CodexRulesDeps = { ...fakeCodex().deps, writableRoots: () => [root] };
    expect(await prepare(inside)).toEqual({});
    await expect(stat(codexRulesPath(home))).rejects.toThrow();
  });
});

describe('codexHomeOutsideWritable', () => {
  it('쓰기 자리 아래·위·같은 자리면 거짓, 밖이면 참', async () => {
    expect(await codexHomeOutsideWritable(home, [work])).toBe(true);
    expect(await codexHomeOutsideWritable(home, [root])).toBe(false);
    expect(await codexHomeOutsideWritable(home, [join(home, 'sub')])).toBe(true);
    await mkdir(join(home, 'sub'));
    expect(await codexHomeOutsideWritable(home, [join(home, 'sub')])).toBe(false);
    expect(await codexHomeOutsideWritable(join(root, 'missing'), [work])).toBe(false);
  });
});

describe('hook 명령·신뢰 절', () => {
  it('hook 은 빈 env 로 뜨고 판정 값만 이름으로 다시 싣는다 — 다리 열쇠·API 키 이름이 없다', () => {
    const cmd = codexHookCommand(BIN);
    expect(cmd.startsWith('/usr/bin/env -i ')).toBe(true);
    expect(cmd).toContain(`${CODEX_HOOK_SPEC_ENV}="$${CODEX_HOOK_SPEC_ENV}"`);
    expect(cmd).not.toMatch(/BRIDGE|LANE_API_KEY|TURN_GRANT|RUNNER/);
    expect(cmd.endsWith('hook pretool --codex || exit 2')).toBe(true);
  });

  it('신뢰 절은 표시 사이를 바꿔 넣고, 같으면 쓰지 않는다', () => {
    const a = withHookTrust('[projects."/w"]\ntrust_level = "trusted"\n', '/h/hooks.json:pre_tool_use:0:0', 'sha256:1')!;
    expect(a).toContain('[projects."/w"]');
    expect(withHookTrust(a, '/h/hooks.json:pre_tool_use:0:0', 'sha256:1')).toBeNull();
    const b = withHookTrust(a, '/h/hooks.json:pre_tool_use:0:0', 'sha256:2')!;
    expect(b.match(/hooks\.state/g)).toHaveLength(1);
    expect(b).toContain('sha256:2');
  });

  it('판 표기', () => {
    expect(codexRulesVersionOk('codex-cli 0.154.0\n')).toBe(true);
    expect(codexRulesVersionOk('codex-cli 0.154.1')).toBe(false);
  });
});

describe('codex 턴 argv', () => {
  const base = {
    harness: 'codex' as const, mode: 'mention' as const, mentionPermission: 'auto' as const, sessionId: 's', isFirstTurn: false,
    systemPrompt: '', promptCtx: '', operatorBin: BIN, codexHome: '/h', mcpConfigPath: '/m.json',
  };
  it('열쇠 턴은 tty 실행을 끄고, 신뢰를 건너뛰는 플래그는 어디에도 없다 · 규칙 env 를 하네스 env 에 싣는다', () => {
    const plan = buildTurnCommand({ ...base, turnKeys: { bridge: 'a'.repeat(64), shell: 'b'.repeat(64) }, commandRuleEnv: { [CODEX_HOOK_SPEC_ENV]: 'v' } } as Parameters<typeof buildTurnCommand>[0]);
    expect(plan.args.join(' ')).toContain('features.unified_exec_tty=false');
    expect(plan.args.join(' ')).not.toContain('bypass-hook-trust');
    expect(plan.env[CODEX_HOOK_SPEC_ENV]).toBe('v');
  });
});
