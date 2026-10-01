// pi 코딩 에이전트 어댑터 (`pi 0.99.2`, npm `@earendil-works/pi-coding-agent` 실측, 2026-10-01).
//
// 측정(PTY 프로브 · 격리 `PI_CODING_AGENT_DIR` · 탐침 stdio MCP · BYOK 제공자):
// - **TUI 가 기본**이다(`pi`). 준비 표시는 상태줄의 컨텍스트 칸 `0.0%/197k`(0.2~0.4초). 되살린
//   화면(`--session-id <있는 id>`)에도 같은 칸이 있다 — fixture 둘이 그 사실을 든다.
// - 붙여넣기+`\r` 을 삼키지 않는다(준비 0.2초 뒤 0.3초에 넣어도 됐다). 그래도 MCP 가 붙기 전
//   첫 입력이 들어가는 것을 피하려고 하한 1초를 둔다(direct 도구는 첫 프롬프트가 10초까지 기다린다).
// - MCP 는 설정 파일뿐이다(`<dir>/mcp.json`, claude 와 같은 `mcpServers` 모양). 도구는
//   `mcp__<server>__<tool>`(영숫자·`_` 밖은 `_`). `exposure: "direct"` 를 줘야 모델에 바로 선언된다.
//   **stdio 자식에게 env 를 통째로 넘긴다**(실측 — 브릿지 링크 env 가 그대로 닿았다. codex 와 다르다).
// - 세션: `--session-id <uuid>` 가 "그 id 를 쓰고 없으면 만든다" — 러너가 첫 턴에 미리 발급하고
//   같은 인자로 이어 간다(두 턴이 한 jsonl 에 쌓였다). claude 의 "already in use" 같은 함정이 없다.
// - 지시문: `--append-system-prompt <파일>` 이 **파일 내용을** 붙인다(실측 — 경로는 기록에 안 남고
//   지시한 토큰이 답에 나왔다). argv 에는 경로만 오른다.
// - **권한 승인 장치가 없다.** 읽기 전용은 허용 도구 목록(`--tools`)으로 건다 — jaebin 결정(10-01).
//   `--tools read,grep,find,ls` 에서 쓰기·셸이 실제로 막혔고(파일 안 생김), MCP 는 **정확한 이름**을
//   적었을 때만 살았다(`mcp__harkroom__*` 는 안 먹는다) → `readonlyTools`.
//
// 못 잰 것: 신뢰 관문(프로젝트에 `.pi/` 가 있을 때 — `--no-approve` 로 아예 안 묻게 한다),
// 첫 기동의 fd·rg 내려받기가 막힌 망에서 어떻게 되는지, 스킬 링크 자리.
import { GATE_PATTERN } from './gate.js';
import type { HarnessAdapter } from './contract.js';

export const PI_ADAPTER: HarnessAdapter = {
  harness: 'pi',
  command: 'pi',
  executionModel: { mention: 'tui', interactive: 'tui' },

  screen: {
    // fixture: `test/fixtures/pi-tui-ready.txt`·`pi-tui-resumed.txt`.
    ready: /\d+(?:\.\d+)?%\/\d+(?:\.\d+)?[kM]\b/,
    gate: GATE_PATTERN,
    gateMeasured: false,
    readyMinMs: 1000,
  },

  // 프로젝트 신뢰는 `.pi/` 의 실행 가능한 자원(확장 등)을 들일지의 질문이다. 러너는 그것을 들이지
  // 않는다 — `--no-approve`(`turn.ts`). 그래서 적어 둘 장부가 없다.
  trust: null,

  mcpRegistration: 'account-config',
  systemPromptDelivery: 'flag-file',
  allowsNullSessionOnFirstTurn: false,
  supportedMentionPermissions: ['auto', 'readonly'],

  // 기록은 `<dir>/sessions/--<cwd>--/<시각>_<id>.jsonl` — 파일 이름에 시각이 붙어 `'files'` 갈래의
  // `<id>.jsonl` 모양에 안 맞는다. 읽지 않으므로 정지 판정은 화면 바이트로 선다.
  transcript: null,

  account: { configDirEnv: ['PI_CODING_AGENT_DIR'], pooled: false },
  xdgApp: null,
  readonlyTools: {
    builtins: ['read', 'grep', 'find', 'ls'],
    mcpServers: ['harkroom'],
    list: ['mcp', 'list', '--json'],
  },

  // `--thinking off|minimal|low|medium|high|xhigh|max` — harkroom 의 다섯 값이 그대로 들어 있다(`--help`).
  effort: { via: 'flag', flag: '--thinking' },
  skillDirs: [],
  interactiveHandoff: false,
};
