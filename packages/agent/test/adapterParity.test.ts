// 어댑터 표가 **지금 프로덕션과 같은 답을 내는가**.
//
// 이 파일이 이 조각의 전부다. 어댑터를 들이는 커밋은 호출부를 하나도 바꾸지 않으므로
// (`src/adapters/index.ts` 머리 주석의 3단계 중 1단계), 표가 옳다는 증거는 테스트뿐이다.
// 그 증거가 없으면 다음 조각에서 호출부를 옮기는 순간 무엇이 달라졌는지 알 수 없다.
//
// **가능한 곳에서는 값이 아니라 행동으로 잰다.** 예를 들어 `effort` 는 태그를 비교하지 않고
// 그 태그로부터 기대 argv 를 만들어 `buildTurnCommand` 의 실제 출력과 대조한다 — 태그만
// 비교하면 표와 프로덕션이 같은 오해를 공유해도 초록이다.
//
// 행동으로 잴 수 없는 두 자리(`executionModel.mention`, `account.pooled`)는 **잠금**으로
// 둔다: 그 사실이 아직 호출부의 지역 표현(`mentionTurn.ts` 의 `usesTui`)이라 표에서 끌어낼
// 수 없기 때문이다. 잠금은 두 곳이 함께 움직이도록 강제하는 것이 목적이고, 호출부가 표를
// 읽게 되는 조각에서 **행동 테스트로 교체하고 지운다**(그 커밋의 할 일 목록에 이 줄이 있다).
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_HARNESSES, RUNNABLE_HARNESSES, MENTION_PERMISSIONS, type AgentHarness } from '@murmur/shared';

import { ADAPTERS, adapterFor, harnessAdaptersEnabled, type HarnessAdapter } from '../src/adapters/index.js';
import { buildTurnCommand, type BuildTurnCommandOptions } from '../src/turn.js';
import { looksLikeGate, looksReadyForPrompt } from '../src/pty.js';
import { readLastApiError } from '../src/harnessErrors.js';
import { ensureWorkspaceTrusted } from '../src/workspaceTrust.js';
import { syncSkills } from '../src/mentionTurn.js';

const RUNNABLE = RUNNABLE_HARNESSES as readonly AgentHarness[];

/** 어댑터가 있는 하네스만 도는 표. `[하네스, 어댑터]` 짝으로 준다. */
const PAIRS: [AgentHarness, HarnessAdapter][] = RUNNABLE.map((h) => [h, adapterFor(h)]);

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'adapter-parity-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function plan(harness: AgentHarness, over: Partial<BuildTurnCommandOptions> = {}) {
  const adapter = adapterFor(harness);
  return buildTurnCommand({
    harness,
    mode: 'mention',
    // 첫 턴에 id 를 못 받는 하네스만 null 로 준다 — 그 조합이 유효한 유일한 자리다.
    sessionId: adapter.allowsNullSessionOnFirstTurn ? null : '11111111-1111-4111-8111-111111111111',
    isFirstTurn: true,
    systemPrompt: '',
    promptCtx: '',
    model: null,
    effort: null,
    mentionPermission: 'auto',
    mcpConfigPath: join(dir, 'mcp.json'),
    pat: 'pat-value',
    murmurUrl: 'http://localhost:3400',
    codexHome: join(dir, 'codex-home'),
    claudeConfigDir: null,
    ...over,
  });
}

describe('스위치는 기본으로 꺼져 있다', () => {
  // 이 조각의 안전이 이 한 줄에 걸려 있다 — claude 경로를 남기는 것이 결정이었다.
  it('MURMUR_HARNESS_ADAPTERS 가 없으면 꺼짐', () => {
    expect(harnessAdaptersEnabled({})).toBe(false);
  });

  it('오타로는 켜지지 않는다', () => {
    for (const raw of ['0', 'yes', 'on', 'TRUE', '']) {
      expect(harnessAdaptersEnabled({ MURMUR_HARNESS_ADAPTERS: raw })).toBe(false);
    }
    for (const raw of ['1', 'true']) {
      expect(harnessAdaptersEnabled({ MURMUR_HARNESS_ADAPTERS: raw })).toBe(true);
    }
  });
});

describe('표의 범위가 turn.ts::PRESETS 와 같다', () => {
  it('AGENT_HARNESSES 전부에 항목이 있다', () => {
    for (const harness of AGENT_HARNESSES) expect(ADAPTERS[harness]).toBeDefined();
  });

  it('구현 없는 하네스는 양쪽이 함께 거절한다', () => {
    // `PRESETS.gemini === 'unsupported'` 와 짝을 이룬다. 한쪽만 열리면 러너가 없는 구현을
    // 가리키고, 그 실패는 turn 조립 한참 뒤에 드러난다.
    for (const harness of AGENT_HARNESSES) {
      if (RUNNABLE.includes(harness)) continue;
      expect(() => adapterFor(harness)).toThrow(/어댑터가 없다/);
      expect(() => plan(harness)).toThrow();
    }
  });
});

describe('T0 — 실행 조립', () => {
  it('command 가 실제로 띄우는 실행 파일과 같다', () => {
    for (const [harness, adapter] of PAIRS) {
      expect(plan(harness).command).toBe(adapter.command);
    }
  });

  it('allowsNullSessionOnFirstTurn 이 실제 거절과 일치한다', () => {
    for (const [harness, adapter] of PAIRS) {
      const build = () => plan(harness, { sessionId: null, isFirstTurn: true });
      if (adapter.allowsNullSessionOnFirstTurn) expect(build).not.toThrow();
      else expect(build).toThrow();
    }
  });

  it('mcpRegistration 태그가 실제 argv 모양과 일치한다', () => {
    for (const [harness, adapter] of PAIRS) {
      const args = plan(harness).args;
      const hasConfigFile = args.includes('--mcp-config');
      const hasOverrides = args.some((a, i) => a === '-c' && (args[i + 1] ?? '').startsWith('mcp_servers.'));
      expect(hasConfigFile).toBe(adapter.mcpRegistration === 'config-file');
      expect(hasOverrides).toBe(adapter.mcpRegistration === 'cli-overrides');
    }
  });

  it('systemPromptDelivery 태그가 실제 argv 모양과 일치한다', async () => {
    const file = join(dir, 'sysprompt.txt');
    await writeFile(file, '지시문');
    for (const [harness, adapter] of PAIRS) {
      const args = plan(harness, { systemPrompt: '지시문', systemPromptFile: file }).args;
      expect(args.includes('--append-system-prompt-file')).toBe(adapter.systemPromptDelivery === 'flag-file');
    }
  });

  it('effort 태그로부터 기대 argv 를 만들어 대조한다', () => {
    for (const [harness, adapter] of PAIRS) {
      const args = plan(harness, { effort: 'high' }).args;
      if (adapter.effort === null) {
        expect(args.join(' ')).not.toContain('high');
        continue;
      }
      if (adapter.effort.via === 'flag') {
        const at = args.indexOf(adapter.effort.flag);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(args[at + 1]).toBe('high');
      } else {
        expect(args).toContain(`${adapter.effort.key}="high"`);
      }
    }
  });

  it('supportedMentionPermissions 의 갈래가 서로 다른 argv 를 낸다', () => {
    for (const [harness, adapter] of PAIRS) {
      expect([...adapter.supportedMentionPermissions].sort()).toEqual([...MENTION_PERMISSIONS].sort());
      const auto = plan(harness, { mentionPermission: 'auto' }).args.join(' ');
      const readonly = plan(harness, { mentionPermission: 'readonly' }).args.join(' ');
      expect(auto).not.toBe(readonly);
    }
  });
});

describe('T0 — 화면 계약', () => {
  /** 실물 화면 fixture 와 프로덕션이 기대하는 준비 판정(`acceptance-cli.test.ts` 와 같은 목록). */
  const SCREENS: { file: string; ready: boolean }[] = [
    { file: 'claude-tui-ready.txt', ready: true },
    { file: 'claude-tui-ready-real.txt', ready: true },
    { file: 'codex-tui-ready.txt', ready: true },
    { file: 'claude-tui-login-menu.txt', ready: false },
    { file: 'claude-tui-trust-modal.txt', ready: false },
    { file: 'claude-tui-onboarding-theme.txt', ready: false },
    { file: 'claude-tui-bypass-warning.txt', ready: false },
    { file: 'claude-tui-settings-approval.txt', ready: false },
  ];

  const screenText = (file: string) => readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
  /** 어댑터들의 준비 신호를 합친 것. 프로덕션의 기본 패턴이 이 합집합과 같아야 한다. */
  const unionReady = new RegExp(PAIRS.map(([, a]) => a.screen.ready.source).join('|'));

  it('어댑터 준비 신호의 합집합이 프로덕션 기본 판정과 같다', () => {
    for (const { file, ready } of SCREENS) {
      const text = screenText(file);
      // 프로덕션(기본 패턴)과 어댑터 합집합이 **같은 답**을 내야 한다. 그리고 그 답이
      // 실물 화면에 대한 기대와도 같아야 한다 — 셋이 어긋나면 어느 쪽이 틀렸는지 드러난다.
      expect(looksReadyForPrompt(text)).toBe(ready);
      expect(looksReadyForPrompt(text, unionReady)).toBe(ready);
    }
  });

  it('각 하네스의 입력창은 자기 어댑터의 신호로 잡힌다', () => {
    // 합집합만 재면 한 하네스의 패턴이 죽어도 다른 하네스가 가려 준다.
    const own: [AgentHarness, string][] = [
      ['claude-code', 'claude-tui-ready-real.txt'],
      ['codex', 'codex-tui-ready.txt'],
    ];
    for (const [harness, file] of own) {
      expect(looksReadyForPrompt(screenText(file), adapterFor(harness).screen.ready)).toBe(true);
    }
  });

  it('관문 판정이 프로덕션과 같다', () => {
    for (const { file } of SCREENS) {
      const text = screenText(file);
      // 아래 테스트가 두 어댑터의 gate 가 같은 값임을 잠그므로 하나를 대표로 쓴다.
      const viaAdapter = looksLikeGate(text, adapterFor('claude-code').screen.gate, unionReady);
      expect(viaAdapter).toBe(looksLikeGate(text));
    }
  });

  it('두 어댑터가 같은 관문 패턴을 가리킨다 — 갈리는 순간 gateMeasured 를 다시 본다', () => {
    const [first, ...rest] = PAIRS.map(([, a]) => a.screen.gate);
    for (const gate of rest) expect(gate).toBe(first);
    // codex 의 관문은 실측이 없다 — 그 사실이 표에 남아 있어야 나중에 "재 봤다"와 구분된다.
    expect(adapterFor('codex').screen.gateMeasured).toBe(false);
    expect(adapterFor('claude-code').screen.gateMeasured).toBe(true);
  });
});

describe('T0 — 신뢰 장부', () => {
  it('어댑터가 말한 파일이 실제로 적히는 파일이다', async () => {
    for (const [harness, adapter] of PAIRS) {
      const configDir = join(dir, harness, 'config');
      const codexHome = join(dir, harness, 'codex-home');
      const workspaceDir = join(dir, harness, 'workspace');
      await mkdir(workspaceDir, { recursive: true });

      await ensureWorkspaceTrusted({ harness, workspaceDir, claudeConfigDir: configDir, codexHome });

      const root = adapter.trust.root === 'account-config-dir' ? configDir : codexHome;
      const written = await readFile(join(root, adapter.trust.file), 'utf8');
      // 장부의 갈래까지 확인한다 — 파일 이름만 맞고 내용이 다른 형식이면 하네스가 못 읽는다.
      if (adapter.trust.kind === 'claude-json') {
        expect(JSON.parse(written).projects[workspaceDir].hasTrustDialogAccepted).toBe(true);
      } else {
        expect(written).toContain(`[projects."${workspaceDir}"]`);
        expect(written).toContain('trust_level = "trusted"');
      }
    }
  });

  it('다른 하네스의 장부는 만들지 않는다', async () => {
    // 뿌리가 갈려 있다는 사실을 잠근다: claude 는 계정마다, codex 는 러너마다 적는다.
    const configDir = join(dir, 'only-codex', 'config');
    const codexHome = join(dir, 'only-codex', 'codex-home');
    const workspaceDir = join(dir, 'only-codex', 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    await ensureWorkspaceTrusted({ harness: 'codex', workspaceDir, claudeConfigDir: configDir, codexHome });

    await expect(readFile(join(configDir, '.claude.json'), 'utf8')).rejects.toThrow();
  });
});

describe('T1 — 세션 기록', () => {
  it('parsed 가 거짓인 하네스는 기록이 있어도 읽지 않는다', async () => {
    // 같은 자리에 **claude 형식의** 기록을 두고 두 하네스로 읽어 본다. 형식이 아니라
    // 하네스로 갈린다는 현재 동작을 그대로 잰다(`harnessErrors.ts` 의 이른 반환).
    const projectsDir = join(dir, 'projects');
    const sessionId = '22222222-2222-4222-8222-222222222222';
    await mkdir(join(projectsDir, 'proj'), { recursive: true });
    await writeFile(
      join(projectsDir, 'proj', `${sessionId}.jsonl`),
      `${JSON.stringify({ isApiErrorMessage: true, timestamp: new Date().toISOString(), message: { content: 'rate limit' } })}\n`,
    );

    for (const [harness, adapter] of PAIRS) {
      const got = await readLastApiError(harness, sessionId, { projectsDir });
      if (adapter.transcript?.parsed) expect(got).toEqual({ text: 'rate limit' });
      else expect(got).toBeNull();
    }
  });

  it('claude 기록의 자리 규칙이 표와 같다', () => {
    const t = adapterFor('claude-code').transcript;
    expect(t).not.toBeNull();
    // `claudeSessionFilePath` 가 `<configDir>/projects/**/<id>.jsonl` 를 찾는다.
    expect(t?.dirUnderConfig).toBe('projects');
    expect(t?.fileName).toBe('<id>.jsonl');
  });
});

describe('T3 — 스킬 자리', () => {
  it('어댑터들의 skillDirs 합집합이 실제로 링크되는 자리와 같다', async () => {
    const stateDir = join(dir, 'state');
    const workspaceDir = join(dir, 'ws');
    await mkdir(workspaceDir, { recursive: true });

    await syncSkills(stateDir, workspaceDir, async () => [{ slug: 'demo', body: '# demo' }]);

    const union = PAIRS.flatMap(([, a]) => a.skillDirs);
    for (const rel of union) {
      const entries = await readdir(join(workspaceDir, rel));
      expect(entries).toContain('demo');
    }
    // 합집합 **밖**에는 만들지 않는다 — 예전 구현이 만들던 `.codex/skills` 가 그 자리다.
    await expect(readdir(join(workspaceDir, '.codex', 'skills'))).rejects.toThrow();
  });
});

describe('잠금 — 호출부가 표를 읽게 되면 지운다', () => {
  it('executionModel.mention 이 mentionTurn 의 usesTui 와 같다', () => {
    // `mentionTurn.ts` 의 `const usesTui = def.harness === 'claude-code'` 를 그대로 옮긴 것이다.
    // 표만 고치고 호출부를 안 고치면 여기서 걸린다. 호출부가 표를 읽게 되는 조각에서 이
    // 테스트는 "codex 멘션 플랜의 stdinFile 이 null 이다" 같은 행동 테스트로 바뀐다.
    for (const [harness, adapter] of PAIRS) {
      expect(adapter.executionModel.mention === 'tui').toBe(harness === 'claude-code');
    }
  });

  it('account.pooled 가 지금 풀 표면이 있는 하네스와 같다', () => {
    // 계정 풀 관리(목록·로그인·사용량·페일오버)가 claude 전용이라는 현재 사실.
    for (const [harness, adapter] of PAIRS) {
      expect(adapter.account?.pooled === true).toBe(harness === 'claude-code');
    }
  });

  it('interactiveHandoff 가 지금 거절 대상과 같다', () => {
    // `interactiveTurn.ts::CODEX_HANDOFF_REJECTION` 이 codex 에만 있다.
    expect(adapterFor('codex').interactiveHandoff).toBe(false);
    expect(adapterFor('claude-code').interactiveHandoff).toBe(true);
  });
});
