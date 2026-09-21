# MCP stdio 브릿지 실측 — 하네스의 요청 직렬성 (계획 Task 4.1)

**날짜:** 2026-09-21 · **머신:** macOS(arm64) · **claude-code** 2.1.278 · **codex** 로컬 설치본

## 물음

`harkroom-operator mcp-bridge`(stdio ↔ 오퍼레이터 링크)가 **하네스의 동시 요청**을 받아야 하는가.
서버의 `inbox.poll` 은 최대 25초 long-poll 이라, 하네스가 그 요청을 연 채 다른 도구를 부르면
브릿지가 요청을 id 로 다중화해야 하고, 그러지 않으면 단순 파이프로 충분하다.

## 방법

stdio MCP 서버 하나(`slow` 20초 대기, `fast` 즉시)를 각 하네스에 `--mcp-config`(claude) /
`-c mcp_servers.*`(codex) 로 붙이고, **같은 턴에서 둘을 동시에 부르라**고 지시했다. 서버는
요청·응답 시각을 파일에 적는다(하네스가 MCP 서버의 stderr 를 삼키므로 stderr 로는 안 보인다).

## 결과 — 둘 다 **직렬**

| 하네스 | REQ slow | RES slow | REQ fast | RES fast |
|---|---|---|---|---|
| claude-code | 6.11s | 26.11s | 26.79s | 26.79s |
| codex | 11.87s | 31.87s | 31.97s | 31.97s |

`fast` 의 요청은 `slow` 의 응답이 돌아온 **뒤에** 열렸다. 모델이 두 tool_use 를 한 메시지에
냈다고 답해도(claude: "두 호출은 같은 턴에서 동시에 발행됨") 하네스는 stdio 위에서 한 번에
한 요청만 연다. 즉 25초 long-poll 이 열려 있는 동안 다른 도구 호출은 그 뒤에 줄을 선다.

## 결론

- 브릿지는 **단순 파이프로 충분**했다. 이미 만든 id 다중화(`mcpBridge.ts`)는 해롭지 않으니 둔다 —
  하네스가 언젠가 병렬로 열면 그때 자동으로 맞는다. 다중화를 **걷어내지는 않는다**.
- 러너가 하네스 안에서 `inbox.poll` 을 부르지 않는 지금 구조(폴링은 러너 코어가 링크로, 하네스는
  `message.post` 같은 짧은 호출만)와도 맞는다 — long-poll 이 도구 호출을 막는 일은 없다.

## 곁에서 나온 결함

- codex 의 `-c mcp_servers.<name>.env=…` 값은 **TOML** 이다. JSON 표기(`{"K":"v"}`)를 넘기면
  `in \`mcp_servers.timing.env\`` 로 설정 전체가 거절된다. `turn.ts::codexMcpFlags` 가 그렇게
  만들고 있었다 → TOML 인라인 표(`{ "K" = "v" }`)로 고쳤다(같은 커밋).

스파이크 코드는 지웠다(계획대로). 재현은 위 방법 절로 충분하다.
