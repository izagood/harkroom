// omp(oh-my-pi, pi 포크) 어댑터 (`omp 18.12.6`, 공식 바이너리 `omp-darwin-arm64` 실측, 2026-10-24).
//
// 측정(researcher 실측 세 차례 · PTY 120×40 · 격리 `HOME`·`PI_CODING_AGENT_DIR` · 가짜 OpenAI 호환 서버 · 탐침 stdio MCP):
// - **TUI 가 기본**이다(`omp`). 준비 표시는 상태줄의 `<모델> >` 뒤 컨텍스트 칸 `0.0%`·`128K`(470~512ms, 3회).
//   되살린 화면(`--resume <id>`)에도 같은 칸이 있다. pi 의 `0.0%/197k` 꼴과 다르다.
// - 붙여넣기(`ESC[200~…201~`) 뒤 0.3초에 `\r` 을 넣어도 삼키지 않았다. MCP 가 붙기 전 첫 입력을 피하려고
//   pi 와 같은 하한 1초를 둔다.
// - MCP 는 설정 파일뿐이다(`<agentdir>/mcp.json`, claude 와 같은 `mcpServers` 모양). **`tools.xdev: false`**
//   를 줘야 도구가 모델에 함수로 선언된다(기본은 `xd://` 경로 뒤에 숨는다) — 오버레이가 준다(`ompHome.ts`).
//   이름은 `mcp__<서버>_<도구>`(**밑줄 하나**, pi 는 둘). stdio 자식에게 env 를 통째로 넘긴다(pi 와 같다).
// - 세션: omp 는 `--session-id` 가 없다. 러너가 첫 턴 전에 uuid 를 발급해 헤더 한 줄 파일을
//   `--session-dir` 에 미리 쓰고 매 턴 `--resume <uuid>` 로 띄운다(`ompHome.ts::writeOmpSessionHeader`).
//   깨지는 조건은 **헤더의 `cwd` 가 실제 cwd 와 다를 때** 하나였다 → 빈 cwd 를 스레드마다 고정한다.
// - 지시문: `--append-system-prompt <text|file>` — 파일이면 내용을 붙인다(문서).
// - **권한 승인 장치가 TUI 에 기본으로 꺼져 있다**(기본 yolo). 읽기 전용은 허용 도구 목록 `--tools` 로 건다.
//   pi 와 달리 MCP 글롭이 먹는다(`mcp__harkroom_*` → bash 는 `Tool bash not found`, 파일 안 생김).
// - 저장소 설정(`.omp/`·`.mcp.json`·`.claude/.mcp.json`·`.env`)을 신뢰를 묻지 않고 읽는다 — 그래서 cwd 를
//   **저장소 밖 `git init` 한 빈 폴더**로 두고 작업 저장소는 `--add-dir` 로 붙인다(security B4·C2·G1).
//
// 못 잰 것: 관문 화면(`--approval-mode` 를 쓰지 않으므로 뜨지 않아야 한다), ACP 권한 경로, 실제 모델 품질.
import { GATE_PATTERN } from './gate.js';
import type { HarnessAdapter } from './contract.js';

export const OMP_ADAPTER: HarnessAdapter = {
  harness: 'omp',
  command: 'omp',
  executionModel: { mention: 'tui', interactive: 'tui' },

  screen: {
    // 상태줄의 컨텍스트 칸 — `0.0%` 와 `128K` 가 한 줄에 같이 선다. fixture: `test/fixtures/omp-tui-ready.txt`·`omp-tui-resumed.txt`.
    ready: /\d+(?:\.\d+)?%[^\n]*?\b\d+(?:\.\d+)?[KM]\b/,
    gate: GATE_PATTERN,
    gateMeasured: false,
    readyMinMs: 1000,
  },

  // 저장소 설정을 아예 안 보게 cwd 를 빈 폴더로 옮긴다(B4) — 들일지 묻는 화면도, 적어 둘 장부도 없다.
  trust: null,

  mcpRegistration: 'account-config',
  systemPromptDelivery: 'flag-file',
  allowsNullSessionOnFirstTurn: false,
  supportedMentionPermissions: ['auto', 'readonly'],

  // 기록은 `<session-dir>/<시각>_<id>.jsonl`. 읽지 않으므로 정지 판정은 화면 바이트로 선다.
  transcript: null,

  // `HOME` 도 옮긴다(C3) — 로그·`run/session-owners`·natives 캐시가 `$HOME/.omp` 에 남고, natives 는 실행 코드로 실린다.
  account: { configDirEnv: ['PI_CODING_AGENT_DIR', 'HOME'], pooled: false },
  xdgApp: null,
  readonlyTools: {
    builtins: ['read', 'grep', 'glob'],
    mcpServers: ['harkroom'],
    // MCP 글롭이 먹으므로 하네스에게 이름을 묻지 않는다(`ompHome.ts::ompReadonlyToolList`).
    list: null,
  },

  // `--thinking off|minimal|low|medium|high|xhigh|max|auto` — harkroom 의 다섯 값이 그대로 들어 있다(문서).
  effort: { via: 'flag', flag: '--thinking' },
  skillDirs: [],
  interactiveHandoff: false,
};
