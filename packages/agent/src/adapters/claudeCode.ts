// claude-code 어댑터. **지금 프로덕션이 쓰는 값을 그대로 옮긴 것**이고, 그 동일성은
// `test/adapterParity.test.ts` 가 지킨다 — 여기 값을 고치면 그 테스트가 먼저 빨개진다.
import { GATE_PATTERN } from './gate.js';
import type { HarnessAdapter } from './contract.js';

export const CLAUDE_CODE_ADAPTER: HarnessAdapter = {
  harness: 'claude-code',

  // 하네스 값(`'claude-code'`)은 제품 이름이고 실행 파일은 `claude` 다. codex 는 둘이 같아
  // 이 구분이 드러나지 않는다 — 그래서 표에 필드로 둔다.
  command: 'claude',

  // 멘션 턴도 TUI 다(2026-09-08 실행 모델 교체). `-p` 를 붙이면 프롬프트를 stdin 파일로
  // 줘야 하고, 그 순간 fd 0 이 PTY 가 아니게 되어 사람이 그 턴에 끼어들 수 없다.
  executionModel: { mention: 'tui', interactive: 'tui' },

  screen: {
    // 입력줄을 **비분리 공백(U+00A0)** 으로 채운다. 메뉴는 `❯1.`·`❯No,exit` 처럼 보통 문자가
    // 붙으므로 이 조합이 채팅 입력창에만 있는 긍정 신호다(`pty.ts` 의 판례).
    ready: /[❯›]\u00a0/,
    gate: GATE_PATTERN,
    // `--permission-mode auto` 의 classifier 확인 화면을 실물로 봤다(2026-09-09).
    gateMeasured: true,
  },

  // `<CLAUDE_CONFIG_DIR>/.claude.json` 의 `projects[dir].hasTrustDialogAccepted`.
  // 계정 config 디렉터리를 따라가므로 **계정마다** 적어야 한다.
  trust: { kind: 'claude-json', root: 'account-config-dir', file: '.claude.json' },

  // `--mcp-config <path> --strict-mcp-config`. 파일 하나로 끝난다.
  mcpRegistration: 'config-file',
  // `--append-system-prompt-file`. argv 로 넘기지 않는 이유는 `ps` 노출이다(#92).
  systemPromptDelivery: 'flag-file',
  // 러너가 첫 턴도 `--session-id <uuid>` 로 미리 발급한다.
  allowsNullSessionOnFirstTurn: false,
  supportedMentionPermissions: ['auto', 'readonly'],

  // `<CLAUDE_CONFIG_DIR>/projects/<프로젝트>/<세션id>.jsonl`. `harnessErrors.ts` 가 이
  // JSONL 을 읽어 마지막 API 에러·기록 성장(정지 판정)을 재고, `claudeUsage.ts`(데몬)가
  // 같은 파일에서 5시간 창의 토큰과 `quotaLimits` 를 센다.
  transcript: { dirUnderConfig: 'projects', layout: 'flat', fileName: '<id>.jsonl', parsed: true },

  // 계정 하나 = `CLAUDE_CONFIG_DIR` 하나. 목록·로그인·사용량·페일오버 표면이 다 있다.
  account: { configDirEnv: 'CLAUDE_CONFIG_DIR', pooled: true },

  effort: { via: 'flag', flag: '--effort' },
  // claude 는 `.claude/skills/<slug>/SKILL.md` 를 읽는다. 지금 `syncSkills` 는 하네스를 보지
  // 않고 두 하네스의 자리를 **모두** 링크한다(합집합) — 어느 쪽이 어느 하네스의 것인지는
  // 이 표가 말하고, 그 합집합이 현재 동작과 같은지는 패리티 테스트가 지킨다.
  skillDirs: ['.claude/skills'],
  interactiveHandoff: true,
};
