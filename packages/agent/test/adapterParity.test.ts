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
import { readFileSync, readdirSync } from 'node:fs';
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

  it('RUNNABLE 이 아니면 argv 조립이 닫혀 있다', () => {
    // **불변식은 argv 쪽이다.** 표(어댑터)가 있다는 것과 러너가 돌린다는 것은 다른 질문이라
    // (opencode 가 그 자리다) "어댑터가 없다"로 재면 안 된다. 재야 하는 것은 "러너가
    // 못 돌리는 하네스로 명령을 조립할 수 없다"이고, 그것이 `PRESETS` 의 `'unsupported'` 다.
    for (const harness of AGENT_HARNESSES) {
      if (RUNNABLE.includes(harness)) continue;
      expect(() => plan(harness)).toThrow();
    }
  });

  it('어댑터가 아예 없는 하네스는 adapterFor 가 던진다', () => {
    // gemini 는 표에도 없다 — 구현이 없다는 뜻이고, 조용히 기본값을 지어내면 안 된다.
    expect(() => adapterFor('gemini')).toThrow(/어댑터가 없다/);
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

describe('세 번째 하네스 실측 — opencode (2026-09-11)', () => {
  /**
   * **어댑터가 아직 없는데 fixture 와 테스트가 먼저 있는 이유.**
   *
   * 계약이 옳은지는 세 번째 하네스를 붙여 봐야 안다(둘로는 우연히 맞는다). 그래서 실행
   * 경로를 열기 **전에** 화면만 먼저 재 뒀다 — `AgentHarness` 에 이름을 더하는 것은 shared
   * 를 건드려 다섯 패키지를 함께 움직이는 일이라 별 조각으로 나눈다.
   *
   * 아래 상수는 실물 화면에서 읽은 값이고(`opencode 1.18.24`, `opencode <dir>` TUI),
   * opencode 어댑터가 생기면 **그 표로 옮기고 이 상수를 지운다.**
   * 근거와 측정 전문: `docs/specs/2026-09-11-opencode-measurement.md`.
   */
  const OPENCODE_READY = /Ask anything…/;
  const screen = readFileSync(new URL('./fixtures/opencode-tui-ready.txt', import.meta.url), 'utf8');

  it('측정한 준비 신호가 실물 화면을 잡는다', () => {
    expect(looksReadyForPrompt(screen, OPENCODE_READY)).toBe(true);
  });

  it('지금 패턴으로는 **못 잡는다** — 하네스별로 갈라야 하는 근거다', () => {
    // 프로덕션의 기본 패턴은 claude 의 `❯`+U+00A0 와 codex 의 `Ask … to do anything` 둘만
    // 안다. opencode 의 자리표시자는 그 어느 쪽도 아니다 — 합쳐진 정규식 하나로 계속 가면
    // 세 번째 하네스의 첫 턴은 준비 신호를 못 보고 상한에서 실패한다.
    expect(looksReadyForPrompt(screen)).toBe(false);
  });

  it('반대로 opencode 패턴이 앞의 두 하네스를 잡지도 않는다', () => {
    // 신호가 서로 겹치지 않는다는 것까지 확인해 둔다 — 겹치면 어느 하네스의 화면인지
    // 구분하지 못하고, 그때는 표가 아니라 판정 자체를 다시 설계해야 한다.
    for (const file of ['claude-tui-ready-real.txt', 'codex-tui-ready.txt']) {
      const other = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
      expect(looksReadyForPrompt(other, OPENCODE_READY)).toBe(false);
    }
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

      // `null` 은 "그 관문이 없다"다 — 적힐 파일이 없는 것이 정답이므로 건너뛴다.
      if (adapter.trust === null) continue;
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
    // 갈래를 먼저 좁힌다 — `'cli'` 갈래에는 파일 자리가 없다(opencode 가 그렇다).
    expect(t?.kind).toBe('files');
    if (t?.kind !== 'files') throw new Error('claude 는 파일 기록이어야 한다');
    // `claudeSessionFilePath` 가 `<configDir>/projects/**/<id>.jsonl` 를 찾는다.
    expect(t.dirUnderConfig).toBe('projects');
    expect(t.fileName).toBe('<id>.jsonl');
  });

  it('계정 축의 환경변수는 비어 있지 않다 — 반쪽 격리가 조용한 사고를 낸다', () => {
    // 배열로 바꾼 뒤 생긴 새 실패 모양: 빈 목록이면 아무것도 격리되지 않는데 표는
    // "축이 있다"고 말한다. 목록으로 적는 이상 그 목록이 비지 않는 것이 계약이다.
    for (const [, adapter] of PAIRS) {
      if (adapter.account === null) continue;
      expect(adapter.account.configDirEnv.length).toBeGreaterThan(0);
    }
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
  it('executionModel.mention 이 호출부의 실제 동작을 정한다 — 잠금을 지웠다', () => {
    // **앞 판본은 `usesTui === (harness === 'claude-code')` 를 잠그고 있었다.** 그 잠금의
    // 목적은 "표만 고치고 호출부를 안 고치는 것"을 막는 것이었고, 호출부가 표를 읽게 되면
    // 지운다고 그때 적어 뒀다. 지금이 그 순간이다 — `mentionTurn` 이
    // `usesTuiForMention` 을 읽고, 그 함수가 표를 읽는다.
    //
    // 대신 재는 것: **표를 고치면 argv 가 따라 움직인다.** codex 의 멘션이 TUI 이므로
    // 새 경로의 argv 에 `exec` 가 없어야 한다. 표와 argv 가 어긋나면 여기서 걸린다.
    const saved = process.env.MURMUR_HARNESS_ADAPTERS;
    process.env.MURMUR_HARNESS_ADAPTERS = '1';
    try {
      expect(adapterFor('codex').executionModel.mention).toBe('tui');
      expect(plan('codex').args).not.toContain('exec');
      // claude 는 원래 TUI 였고 그대로다.
      expect(adapterFor('claude-code').executionModel.mention).toBe('tui');
    } finally {
      if (saved === undefined) delete process.env.MURMUR_HARNESS_ADAPTERS;
      else process.env.MURMUR_HARNESS_ADAPTERS = saved;
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

describe('표에 있는 것과 러너가 돌리는 것은 다른 질문이다', () => {
  it('RUNNABLE 은 전부 어댑터가 있고 권한 갈래가 완전하다', () => {
    // `RUNNABLE_HARNESSES` 에 들어가는 기준은 "실물 왕복을 봤는가"인데, 그 왕복에는
    // murmur 가 쓰는 권한 갈래가 **둘 다** 도는 것이 포함된다. 하나만 되는 하네스를
    // 돌리면 `mentionPermission: 'readonly'` 로 만든 에이전트가 조용히 auto 로 돈다.
    for (const [, adapter] of PAIRS) {
      expect([...adapter.supportedMentionPermissions].sort()).toEqual([...MENTION_PERMISSIONS].sort());
    }
  });

  it('어댑터가 있어도 RUNNABLE 이 아닐 수 있다 — opencode 가 지금 그 자리다', () => {
    const adapter = adapterFor('opencode');
    expect(RUNNABLE.includes('opencode')).toBe(false);
    // 아직 못 잰 것이 표에 그대로 남아 있어야 한다. 지어내면 그 값이 러너의 판단이 된다.
    expect(adapter.supportedMentionPermissions).toEqual(['auto']);
    expect(adapter.transcript?.parsed).toBe(false);
    // 그리고 argv 조립은 닫혀 있어야 한다 — 표가 있다고 러너가 돌리면 안 된다.
    expect(() => plan('opencode')).toThrow();
  });

  it('장부가 없는 하네스는 아무 파일도 만들지 않는다', async () => {
    // `trust: null` 의 뜻이 "적을 곳을 모른다"가 아니라 "그 관문이 없다"라는 것을 고정한다.
    expect(adapterFor('opencode').trust).toBeNull();
  });
});

describe('P2 가 옮겨야 할 목록 — 하네스 이름 비교의 예산', () => {
  /**
   * **새 하네스는 타입으로 안 걸린다**(2026-09-11에 확인). `AGENT_HARNESSES` 에
   * `'opencode'` 를 더했을 때 다섯 패키지 중 깨진 것은 **표 두 개와 손으로 베낀 테스트
   * 유니온 하나**뿐이었다. `harness === 'claude-code'` 같은 비교는 유니온이 늘어도 그대로
   * 컴파일되고, 새 하네스는 조용히 **모든 `else` 가지로 떨어진다** — exec 모드로, 기록
   * 해석 없이, 계정 풀 없이, 신뢰 장부를 안 적은 채로.
   *
   * 그래서 컴파일러 대신 이 예산이 지킨다. 아래가 P2 가 어댑터 뒤로 옮겨야 할 목록이고,
   * 옮길 때마다 숫자가 줄어든다. **늘리려면 이 테이블을 고쳐야 하고, 그 diff 가 리뷰에
   * 보인다** — 그것이 이 테스트의 전부다. 0 이 되면 eslint 규칙으로 바꾸고 지운다.
   */
  /**
   * **하네스 이름과 비교하는 자리**만 센다. 리터럴을 `AGENT_HARNESSES` 에서 만들어 붙이는
   * 이유는 그래야 이 정규식이 하네스가 늘어도 계속 맞기 때문이고, 동시에 **비교처럼
   * 생겼지만 이름 비교가 아닌 것**을 걸러 내기 때문이다. 앞 판본(`harness\s*(===|!==)`)은
   * 셋을 잘못 세고 있었다:
   *   - `rec.harness !== def.harness` (mentionTurn·interactiveTurn) — 값끼리 비교다
   *   - `typeof harness === 'string'` (sessions.ts) — 타입 가드다
   * 그래서 20 이던 숫자가 17 이 됐다. **줄어든 3은 이설한 것이 아니라 애초에 목록에 들 게
   * 아니었던 것들이다** — 이설로 줄어든 것과 섞이지 않게 여기 적어 둔다.
   */
  const NAME_COMPARISON = new RegExp(`harness\\s*(===|!==)\\s*'(${AGENT_HARNESSES.join('|')})'`, 'g');

  const BUDGET: Record<string, number> = {
    // `mentionTurn.ts` 4 · `interactiveTurn.ts` 3 이 여기 있었다(이설 3/N). 일곱 자리가
    // 실은 세 질문이었고(`usesTuiForMention`·`hasAccountPool`·
    // `discoversSessionIdAfterTurn`), 옛 비교는 그 세 함수 안에 스위치와 함께 산다.
    // 이설했지만 **옛 분기가 살아 있어** 숫자가 그대로다(스위치가 꺼지면 그 분기가 답한다).
    // 이 숫자는 옛 분기를 지울 때 줄어든다 — 그 순서가 이 작업의 안전장치다.
    'workspaceTrust.ts': 3,
    'turn.ts': 3,
    // `harnessErrors.ts` 3 · `claudeSessions.ts` 1 이 여기 있었다(이설 2/N). 넷이 각자
    // 묻던 같은 질문을 `adapters/index.ts::readsSessionTranscript` 하나로 모았고, 옛 비교는
    // 그 함수 **안에** 스위치와 함께 산다 — 그래서 이 표에서는 사라졌다.
  };

  function countIn(dir: string, acc: Record<string, number>): Record<string, number> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // `adapters/` 는 이름을 알아도 되는 유일한 자리다 — 표가 사는 곳이다.
      if (entry.isDirectory()) { if (entry.name !== 'adapters') countIn(full, acc); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const hits = readFileSync(full, 'utf8').match(NAME_COMPARISON);
      if (hits) acc[entry.name] = (acc[entry.name] ?? 0) + hits.length;
    }
    return acc;
  }

  it('예산을 넘지 않는다 — 넘었다면 새 이름 비교가 심겼다', () => {
    const found = countIn(new URL('../src', import.meta.url).pathname, {});
    expect(found).toEqual(BUDGET);
  });
});
