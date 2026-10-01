// Kilo Code CLI 어댑터 (`kilo 7.8.1` 실측, 2026-10-01).
//
// **opencode 포크다**(실측): 로그 첫 줄에 `opencode` 가 찍히고, sqlite 스키마(session·part·
// permission)·`session list --format json` 출력·`-s <id>` 재개·`--agent`·`--auto` 가 그대로다.
// 그래서 표의 모양은 opencode 와 같고, **이름만** 다르다 — 실행 파일 `kilo`, XDG 아래 하위
// 디렉터리 `kilo`, 설정 파일 `kilo.jsonc`(`xdgApp`). 러너의 opencode 경로(`opencodeHome.ts`·
// `opencodeSessions.ts`)는 이 두 칸만 읽어 Kilo 에도 그대로 돈다.
//
// 측정(PTY 프로브 · 격리 XDG · 탐침 stdio MCP · rro 제공자):
// - 준비 4.3~5.4초. 첫 화면에 `Ask anything...`, 되살린 화면(`-s`)에는 그것이 없고 `ctrl+p` 만
//   있다 — opencode 와 같은 함정이라 같은 패턴을 쓴다.
// - 붙여넣기+`\r` 을 삼키지 않는다. MCP `type: local` + `{env:VAR}` 치환 확인(도구 호출이 탐침에 찍힘).
// - 재개 `-s <id>`: 세션 하나에 두 턴이 쌓였다(`select session_id, count(*) from message`).
// - **읽기 전용은 `--auto` 를 빼야 선다.** deny 에이전트와 `--auto` 를 같이 주면 화면에는
//   "denied by the harkroom-readonly agent" 가 뜨는데 bash 가 `completed` 로 실행돼 파일이
//   생겼다. `--agent harkroom-readonly` 단독이면 bash 가 막히고 MCP 는 된다.
//   (opencode 프리셋도 이미 그렇게 둘을 따로 준다 — 이 사실이 그 규칙의 회귀선이다.)
//
// 못 잰 것: Kilo Gateway 로그인(계정 없음 — BYOK 만 쟀다), 신뢰 관문(git 저장소 아님),
// `--variant` 값 집합, 스킬 링크 자리. Kilo 는 홈의 `~/.claude/skills`·`~/.agents/skills` 를
// 스스로 읽고, 캐시(`~/.cache/kilo`)는 XDG_CACHE_HOME 을 주지 않아 격리되지 않는다.
import { GATE_PATTERN } from './gate.js';
import type { HarnessAdapter } from './contract.js';
import { OPENCODE_ADAPTER } from './opencode.js';

export const KILO_ADAPTER: HarnessAdapter = {
  ...OPENCODE_ADAPTER,
  harness: 'kilo',
  command: 'kilo',
  screen: {
    // fixture: `test/fixtures/kilo-tui-ready.txt`·`kilo-tui-resumed.txt`.
    ready: /Ask anything|ctrl\+p/,
    gate: GATE_PATTERN,
    gateMeasured: false,
  },
  // 세션은 `<data>/kilo/kilo.db`. 목록 명령의 모양이 opencode 와 같다(실측).
  transcript: {
    kind: 'cli',
    list: ['session', 'list', '--format', 'json'],
    export: ['export', '<id>'],
    stats: ['stats'],
    parsed: false,
  },
  account: {
    configDirEnv: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'],
    pooled: false,
  },
  // 로그인(`auth.json`)은 기동 때 `kilo.db` 의 `credential` 로 "Imported" 복사된다(실측).
  // 그래서 링크한 auth.json 을 사람이 고쳐도 이미 들여온 값이 남을 수 있다 — 미측정.
  xdgApp: {
    dir: 'kilo',
    configFile: 'kilo.jsonc',
    schema: 'https://app.kilo.ai/config.json',
    userConfigFiles: ['kilo.jsonc', 'kilo.json'],
  },
};
