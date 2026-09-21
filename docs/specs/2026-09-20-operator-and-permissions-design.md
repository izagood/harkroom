# 오퍼레이터와 권한 — 데스크탑을 프론트로 되돌리고 데몬을 실행의 유일한 접점으로 세운다

2026-09-20. 대상: `packages/daemon`(→ `packages/operator`), `packages/server`, `packages/agent`,
`packages/desktop`. 검토는 그림 6장짜리 별도 페이지(jaebin 의 아티팩트, 저장소 밖)로 했고
이 문서가 그 확정본이다. 2026-09-21 승인 — §11 의 결정 9개는 전부 제안대로.

`design.md` §2 「daemon 과 server 의 경계 — 두 층은 붙지 않는다」를 **뒤집는다.** 그 결정의
근거 셋에 §8 에서 각각 답한다. 권한 부분은 murmur 의 2026-09-19 제안(`harkroom://message/c5932bb4-8d9c-4f94-aa42-334b8cf5c258`)을
그대로 흡수하고, 오퍼레이터가 생기면서 새로 필요해진 권한과 교차 불변식(§7)을 더한다.

## 1. 왜 — 서버를 옮겼는데 에이전트가 흔들린 이유는 역할 배분이다

2026-09-20 실측. 서버를 `http://localhost:3400` 에서 `https://<host>`(Cloudflare
프록시 뒤)으로 옮기자 터미널 관찰·개입이 깨졌다. 러너 로그에 `520`·`ECONNRESET`·`503 no
healthy upstream` 이 남았고, 릴레이 소켓(`/agent-relay`)에 heartbeat 가 없어 끊긴 사실을 양쪽
모두 몰랐다(그 방어는 `b485b9d8` 로 먼저 넣었다). 그런데 그것은 증상이다. 원인은 이렇다:

| 컴포넌트 | 실제로 소유하고 있던 것 |
|---|---|
| **데스크탑** | 서버 URL(`api.baseUrl`) · 러너 PAT(OS 키체인 `harkroom.runner.pat.<agentId>`) · **어떤 러너를 띄울지의 결정**(`Controller.start` → `RunnerLauncher.startAll`) · 데몬에 unix 소켓으로 명령 |
| **데몬** | 프로세스 소유만. 서버도 PAT 도 모른다 — `runners.ts`: *"러너에 넘기는 것은 `{ HARKROOM_PAT, HARKROOM_URL, PATH }` 세 개뿐"* |
| **러너** | 데스크탑이 spawn 시점에 넘긴 env 로 서버에 직접 붙는다(MCP + 릴레이 WS, 러너마다 2개) |

**데스크탑은 프론트가 아니라 컨트롤 플레인이었다.** 로컬 서버일 때는 셋이 한 머신이라 이
결합이 비용이 아니었다 — `localhost:3400` 은 안 바뀌고, 앱이 꺼지면 어차피 다 꺼진다. 서버가
원격이 되는 순간 "같은 머신"이라는 전제만 남고 이점은 사라진다:

- `HARKROOM_URL` 이 spawn 시점 env 에 **얼어붙는다.** 서버를 바꿔도 이미 뜬 러너는 옛 주소를
  본다(로그에 두 주소가 섞여 있었다).
- 앱이 꺼지거나 세션이 끊기면 러너 재기동 결정이 **사라진다.** 데몬은 서버를 모르므로 스스로
  복구할 수 없다.
- PAT 이 데스크탑 키체인에 있고 데몬이 unix 소켓이라 **핸드폰은 러너를 띄울 길이 없다.**
- 러너 13개 × 서버 연결 2개 = 26개가 **각자 끊기고 각자 재접속**한다.

`design.md` §5 는 이미 *"에이전트는 앱 안에 살지 않는다. 앱은 사람용 클라이언트일 뿐"* 이라고
적어 뒀다. 목표였고 구현이 미달이었다. 이 설계는 방향을 바꾸는 것이 아니라 **문서가 가리키던
곳으로 구현을 끌어오는** 것이다.

## 2. 목표 구조 — 방향 B

```
프론트 (데스크탑 A · 데스크탑 B · 모바일 v2)      상태를 소유하지 않는다 · 어디서든 · 여러 개
        │ REST + /ws (사람 세션 토큰)
        ▼
서버 — 워크스페이스의 사실                          계정 · 채널 · 메시지 · 에이전트 정의
   배정: 에이전트 → 오퍼레이터 · 권한 · 감사         /operator (WS) · /mcp · /agent-attach · /ws
        ▲ outbound WS ×1 (오퍼레이터 토큰, 양방향 heartbeat)
오퍼레이터 @A컴퓨터 · @B컴퓨터 · @에이전트 전용 서버   머신당 하나 · 내가 원하는 곳 어디든
        │ unix 소켓
        ▼
러너                                                서버 URL 도 PAT 도 없다
```

B컴퓨터의 데스크탑에서 `@murmur` 를 부르면 서버가 배정을 보고 A컴퓨터의 오퍼레이터로 보낸다.
**머신당 서버 연결이 하나**이고 그 하나만 건강하면 된다. 오퍼레이터가 없는 머신(핸드폰)도
프론트로는 같은 경험을 얻는다.

### 책임표

| 컴포넌트 | 소유 | 아는 것 | 모르는 것(의도) |
|---|---|---|---|
| **프론트** | 화면 · 초안 · 기기 선호 | 서버 URL, 사람 세션 토큰 | PAT, 러너, 오퍼레이터의 존재(로컬 진단 제외) |
| **서버** | 워크스페이스의 사실 — 계정·채널·메시지·에이전트 정의·**배정**·**권한**·감사 | 어느 오퍼레이터가 어느 에이전트를 도는가 | 러너 프로세스, 머신 경로, 자격증명 파일 |
| **오퍼레이터** | 이 머신의 프로세스 · 능력 · 시크릿 · **머신 종속 설정**(작업 디렉터리, 계정 풀) | 서버(들), 배정, 러너 생사 | 세션 상태(`sessions.json` 은 러너의 것), 누가 불렸나 |
| **러너** | 세션 · PTY · 워크스페이스 | 오퍼레이터(unix 소켓) | 서버 URL, PAT, 커뮤니티 |

`daemonProtocol.ts` 의 *"daemon 이 소유하는 것은 프로세스이지 세션이 아니다"* 는 그대로다.
오퍼레이터가 새로 갖는 것은 능력·배정·시크릿이지 세션 상태가 아니고, `sessions.json` 의
writer 는 계속 러너 하나다.

## 3. 오퍼레이터 — 이름·신원·능력·배정

### 이름: `operator` (확정)

역할이 "프로세스 소유자"에서 "서버가 든 의도(배정)를 이 머신에서 실현하는 것"으로 바뀐다.
사용자가 쓴 말 그대로이고, k8s operator 패턴(desired state 를 reconcile)과 동형이며, 한국어
문장에 자연스럽고("오퍼레이터가 러너를 띄운다"), murmur 의 "호스트 테넌시" 어휘와 짝이 된다 —
**호스트**=머신, **오퍼레이터**=그 머신의 프로세스. 탈락: `outpost`(은유라 매번 풀어 써야 한다),
`agentd`(역할이 커진 것을 이름이 말하지 않고 `harkroom-agent` 와 헷갈린다).

`packages/daemon` → `packages/operator`, 실행 파일 `harkroom-operator`, 소켓
`operator-v1.sock`, 앱 데이터 디렉터리 `app.harkroom.operator`. 프로토콜 버전은 새로 시작한다 —
소켓 파일명에 세대가 박히는 규칙(`daemonEndpoint.ts` D3)을 그대로 쓴다.

### 신원 — 오퍼레이터는 사람의 기기다

```sql
create table operator (
  id               uuid primary key,
  owner_account_id uuid not null references account(id) on delete cascade,
  name             text not null,            -- 사람이 붙인 이름: "맥북", "빌드 서버"
  token_hash       text not null unique,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz,
  revoked_at       timestamptz
);
```

사람 세션 토큰과도 에이전트 PAT 과도 다른 종류다. **등록 흐름:** 사람이 프론트에서 [기기 등록]
→ 서버가 일회용 등록 코드 발급(5분, `operator.register` 필요) → 그 머신에서
`harkroom-operator register <서버URL> <코드>`(데스크탑이 있으면 앱이 unix 소켓으로 대신 부른다)
→ 오퍼레이터가 코드를 장기 토큰으로 교환 → OS 키체인. 키체인의 기존
`harkroom.runner.device` 항목이 이 개념의 씨앗이다.

폐기는 `revoked_at`. 폐기되면 채널이 `4401` 로 끊기고 오퍼레이터는 재시도하지 않는다(로그에
"재등록 필요"). 그 오퍼레이터의 배정은 남되 "폐기됨"으로 보인다.

### 커뮤니티 격리 — 인스턴스로 강제한다

오퍼레이터는 여전히 **머신당 하나**다. 커뮤니티(=서버) 여럿에 붙어야 하는데 `design.md` §2-6 은
격리를 스코핑 조건으로 코드에서 강제하는 것을 거부했다. 답은 데스크탑이 이미 쓰는 방법이다 —
`communities.ts` 가 커뮤니티마다 `Controller` 인스턴스를 두듯, 오퍼레이터도 **커뮤니티마다
독립된 연결 객체·시크릿·상태 디렉터리**를 둔다. 잘못 읽는 것이 "잘못된 객체를 잡는 일"이라
격리가 구조로 강제된다. 러너 상태는 이미 에이전트 계정 id(서버별 UUID)로 갈라져 있어
(`~/.harkroom-agent/<handle>-<agentId>`) 추가 스코핑이 없다.

### 능력 — 이 머신이 무엇을 돌릴 수 있는가

머신 종속 값(작업 디렉터리, claude 계정 풀)은 서버 `agent_config` 에서 나와 **오퍼레이터 로컬
설정**으로 간다. A컴퓨터의 murmur 워크스페이스 경로가 B컴퓨터에 있을 이유가 없다.
`agent_config.working_dir` 은 남기되 **기본값**의 뜻으로만 쓴다(로컬 설정이 없을 때).

```jsonc
// <app data>/app.harkroom.operator/operator.json
{
  "communities": {
    "https://<host>": {
      "agents": {
        "4527ba9a-…": { "workingDir": "~/dev/harkroom", "claudePool": "work" },
        "fbccf9f8-…": { "workingDir": "~/dev/rcms" }
      }
    }
  }
}
```

연결 시 `hello` 에 능력을 싣는다: 돌릴 수 있는 에이전트 id 목록, 하네스 가용성
(`claude-code`·`codex` 설치·로그인 여부). 서버는 이것을 **연결이 살아 있는 동안만** 인메모리로
든다(확정 — 능력은 오퍼레이터가 살아 있을 때의 사실이지 기록이 아니다; 테이블에 남기면 꺼진
머신의 능력이 UI 에 계속 보인다). 로컬 설정은 그 머신의 데스크탑이 unix 소켓으로 편집한다 —
`claudeAccounts.ts` 가 `pools.json` 을 다루는 것과 같은 경계이고 같은 근거(*"웹뷰에는 로컬을
다룰 표면이 없다 — 데몬이 이미 그 경계다"*).

### 배정 — 이 에이전트는 어느 오퍼레이터가 도는가

```sql
create table agent_assignment (
  agent_id     uuid primary key references account(id) on delete cascade,
  operator_id  uuid not null references operator(id) on delete cascade,
  assigned_by  uuid not null references account(id),
  assigned_at  timestamptz not null default now()
);
```

에이전트당 **하나**다. 프론트는 등록된 능력 목록에서만 고를 수 있으므로 없는 환경을 고를 수
없다. 배정은 **양쪽의 동의**다 — 서버 쪽(소유자/관리자가 고른다) ∧ 오퍼레이터 쪽(로컬 설정에
그 에이전트가 있다 = 능력 등록). 한쪽만으로는 성립하지 않는다.

배정을 바꾸면(확정 — drain): 서버가 이전 오퍼레이터에 `unassign{drain:true}` → 진행 중인 턴은
끝까지, 새 부름은 받지 않음 → 러너 종료 → 새 오퍼레이터에 `assign` → spawn. 두 오퍼레이터가
같은 에이전트를 동시에 돌리는 순간을 만들지 않는다(같은 에이전트에 러너가 둘이면 멘션을 나눠
집어 간다 — `design.md` §1). drain 에는 **상한**을 둔다(§9 위험 참조).

## 4. 서버 ↔ 오퍼레이터 채널

`GET /operator`, WebSocket, `Authorization: Bearer <오퍼레이터 토큰>`. 오퍼레이터가 outbound 로
건다 — 러너가 릴레이로 하던 것과 같은 방향, 같은 이유(포트를 열지 않는다, 인증 표면 하나).
프레임은 JSON 이고 러너에 관한 것은 `runnerId` 로 다중화한다. 타입은 `@harkroom/shared` 에
`operatorProtocol.ts` 로 둔다(`daemonProtocol.ts` 와 같은 서브패스 이유).

| 방향 | 프레임 | 뜻 |
|---|---|---|
| 오퍼레이터 → 서버 | `hello{capabilities, runners[], sessions[]}` | 연결·재연결마다. 능력 + 지금 살아 있는 러너·세션 전부(기존 `announce` 원칙: 서버는 끊기면 잊는다) |
| | `runner.started{agentId, runnerId}` / `runner.exited{runnerId, code, reason?}` | 프로세스 생사 — 지금 데몬 장부가 아는 것 |
| | `session.started` / `session.ended` / `session.updated` | 러너의 세션 사실을 그대로 중계. 오퍼레이터는 해석하지 않는다 |
| | `pty.output{runnerId, sessionId, bytes}` | PTY 바이트 — 불투명 우체국 그대로 |
| | `interactive.opened` / `interactive.error` | 기존 프레임에 `runnerId` 만 붙는다 |
| | *(ws pong)* | 서버 ping 에 자동 응답 |
| 서버 → 오퍼레이터 | `assign{agentId, definition}` | 이 에이전트를 돌려라. 정의(하네스·지시문·모델)는 서버 것, 머신 값은 로컬 설정에서 |
| | `unassign{agentId, drain}` | 그만 돌려라. `drain` 이면 진행 중 턴은 끝까지 |
| | `runner.kill{runnerId}` | 사람이 관제에서 누른 종료 |
| | `pty.input` / `pty.resize` / `viewer.count` / `session.cancel` | 기존 릴레이 프레임 + `runnerId` |
| | `interactive.open{runnerId, …}` | [터미널 열기] |
| | *(ws ping, 30초)* | 미응답 1회면 끊는다(`heartbeat.ts`, `wsHeartbeatMs` 와 같은 값). **오퍼레이터도 ping 부재로 서버 죽음을 판정한다** — 이 채널은 신규라 heartbeat 없는 구 서버가 존재하지 않는다 |

멘션 하나의 왕복: 러너의 `inbox.poll`(25초 long-poll)이 오퍼레이터를 거쳐 서버 `/mcp` 에 대기
→ 프론트가 `message.post` → 서버가 fan-out 게이트(§6)로 `invoke_scope` 를, `agent_assignment`
로 라우팅을 판정 → poll 응답이 오퍼레이터를 거쳐 러너로 → 턴 시작, `session.started` 가 반대
방향으로 → `message.post`(답)가 오퍼레이터 토큰 + `agentId` 로 서버에 → `/ws
message.created` 가 프론트로. **오퍼레이터는 실어 나르기만 한다.** 프론트는 어느 머신에서
돌았는지 모른 채 답을 받는다.

## 5. 러너는 서버를 모른다 — 세 경로, 세 방식

러너와 서버 사이의 트래픽 셋을 전부 오퍼레이터로 통과시키되 **같은 방식으로 통과시키지
않는다.** 성질이 다르기 때문이다.

| 경로 | 러너 ↔ 오퍼레이터 | 오퍼레이터 ↔ 서버 | 왜 이렇게 |
|---|---|---|---|
| **제어** | spawn(env 에 URL·PAT 없음) | 채널 프레임(`assign`·생사) | 러너는 지시의 대상이지 상대가 아니다 |
| **MCP** | stdio 브릿지 → unix 소켓 | HTTPS `/mcp`, 오퍼레이터 토큰 + `X-Harkroom-Agent` | 요청/응답이라 WS 에 터널링하지 않는다. 서버 MCP 핸들러 무변경, 인증 계층만 |
| **PTY** | unix 소켓 위의 바이트 프레임 | 채널에 `{runnerId, sessionId}` 로 다중화 | 장수명 스트림 — 오늘 실측에서 흔들린 것이 정확히 이것 |

### MCP — stdio 브릿지, 포트를 열지 않는다

러너가 만드는 `mcp.json` 의 `harkroom` 항목이 HTTP URL 에서 **stdio 명령**으로 바뀐다:

```json
"harkroom": {
  "command": "harkroom-operator",
  "args": ["mcp-bridge", "--runner", "<runnerId>"],
  "env": { "HARKROOM_RUNNER_SECRET": "<spawn 시 1회 발급>" }
}
```

브릿지는 JSON-RPC 를 오퍼레이터 unix 소켓으로 넘기고, 오퍼레이터는 서버 `/mcp` 에 HTTPS 로
전달하며 `Authorization` 을 오퍼레이터 토큰으로, `X-Harkroom-Agent` 를 그 러너의 에이전트 id 로
바꾼다. 서버는 (오퍼레이터, 에이전트) 쌍이 `agent_assignment` 에 있는지 보고 `req.account` 를
그 에이전트로 세운다. `--strict-mcp-config` 의 "목록은 우리가 만든다" 불변식은 그대로 산다.
claude-code 와 codex 모두 stdio MCP 를 지원하므로 하네스 쪽 변경은 없다. 러너 코어 자신이 부르는
REST(`/agent/config` 등)는 같은 unix 소켓에 `http.forward{method, path, body}` 요청 하나로
싣고, 오퍼레이터가 MCP 와 **같은 인증 치환**(오퍼레이터 토큰 + `X-Harkroom-Agent`)으로 서버
REST 에 전달한다 — 프레임은 다르고 규칙은 하나다. 러너용 REST 표면을 오퍼레이터에 따로 만들지
않는다.

**배정이 곧 인가.** 오퍼레이터가 돌리는 에이전트에는 **PAT 이 필요 없어진다.** PAT 은
`design.md` §1 의 **외부 접속형**(오퍼레이터 없이 직접 붙는 에이전트)에만 남는다. 오늘 러너
13개가 각자 들고 있던 평문 PAT 이 사라진다.

### PTY — 릴레이가 오퍼레이터로 올라간다

`packages/agent/src/relay.ts`(러너→서버 WS)의 몫이 둘로 갈린다: 러너→오퍼레이터는 unix 소켓
위의 프레임, 오퍼레이터→서버는 채널 다중화. 서버 `relay.ts` 허브는
`addRunner(agentAccountId, socket)` 에서 `addOperator(operatorId, socket)` + 에이전트별 세션
맵으로 바뀐다. **뷰어 쪽(`/agent-attach` 티켓, 프론트의 xterm)은 무변경**이다 — 프론트는
세션 id 로 attach 할 뿐 어느 오퍼레이터 뒤에 있는지 모른다.

## 6. 권한 설계

murmur 의 제안을 그대로 채택한다 — 실물 코드(`requireAdmin` 호출부, `checkOwnerOrAdmin`,
fan-out)를 확인한 위에 짜였고 요구 3·4 를 정확히 표현한다.

### 오늘 — 축이 `is_admin` 하나

채널·팀·에이전트 생성, 초대가 전부 `requireAdmin`(`channelRoutes.ts:64,79,627,806`,
`teamRoutes.ts`, `accountRoutes.ts:219`, `/invites`)이고, **에이전트를 깨워 턴을 돌리는 것은
아무도 게이트하지 않는다**(채널 가시성 + `disabled` 뿐, `services/messages.ts` fan-out).
`owner_account_id` 는 들여다보는 것(`checkOwnerOrAdmin`)과 러너를 띄우는 기기만 게이트한다.
"내 에이전트"는 실행 쪽에선 사실이고 호출 쪽에선 아직 아니다 — 이것이 요구 4 의 뿌리다.

### 세 층

**(1) 역할 — 메타권한만.** `account.role ∈ owner|admin|member|guest`. 정하는 것은 딱 하나:
누가 권한을 줄 수 있나. owner 는 admin 임명, admin 은 grant 부여, member/guest 는 못 준다.
행위 자체는 역할이 정하지 않는다. `guest` 는 v2(확정) — private 채널로 흉내 난다.

**(2) capability grant — 행위.**

```sql
create table account_grant (
  account_id  uuid not null references account(id) on delete cascade,
  capability  text not null,
  scope       text not null default '',  -- ''=커뮤니티 전역, 'channel:<id>' 등 대상 한정.
                                         -- null 이 아닌 이유: PK 에 넣으려면 값이 있어야 한다
  granted_by  uuid not null references account(id),
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz,
  primary key (account_id, capability, scope)
);
```

| capability | 여는 것 | 비고 |
|---|---|---|
| `channel.create` · `channel.manage` · `channel.auto_mention` | 채널 생성 / 남의 채널 수정·삭제 / auto-mention 설정 | `channel` 에 `created_by` 추가 필요 |
| `team.create` · `team.manage` | 팀 생성 / 남의 팀 수정·명단·팀장 | |
| `agent.create` · `agent.manage` | 에이전트 생성 / 남의 에이전트 설정·**배정**·삭제 | `agent.create` 는 member 기본 부여 **안 함**(확정 — 요구 4 "권한 부여 받으면"; 에이전트 하나 = 러너 하나 = 호스트 비용) |
| `agent.privileged` | `mcp_server` 레지스트리 관리 | admin |
| `member.invite` · `audit.read` | 초대 / 감사 열람 | |
| `operator.register` | 자기 기기를 오퍼레이터로 등록 | **신규.** member 기본 부여(확정) — 자기 에이전트를 자기 기기에서 돌리는 것은 에이전트를 가진 사람의 기본 행위. 관리자는 `operator.manage` 로 폐기할 수 있다 |
| `operator.manage` | 남의 오퍼레이터 조회·폐기 | **신규.** admin |

scope 는 첫 판에 `channel.manage`·`team.manage` 에만 쓴다.

**(3) 소유는 grant 가 아니다.** 내가 만든 채널·팀·에이전트·오퍼레이터는 grant 없이 내가
관리한다(`created_by`/`owner_account_id`). `*.manage` grant 는 남의 것까지 여는 것이다. 이게
있어야 요구 4 가 grant 폭발 없이 성립한다.

왜 역할과 권한을 나누나 — 역할만 두면 "채널은 만들되 에이전트는 못 만드는 사람"(요구 3)을
표현 못 하고, 권한만 두면 "누가 줄 수 있나"를 표현 못 한다.

판정은 함수 하나로 모은다:

```
can(actor, cap, target) = isOwnerOf(target) ∨ hasGrant(actor, cap, scope(target)) ∨ role ≥ admin
```

grant 변경은 전부 `audit_log`(003)에. 권한을 준 기록이 없으면 사고를 못 되짚는다.

### 에이전트 — `owner_account_id` 하나가 셋을 겸하고 있었다

| 필드 | 뜻 | 값 |
|---|---|---|
| `owner_account_id` | 설정·터미널·**배정** 소유 | 있다 |
| **`invoke_scope`** | 누가 깨울 수 있나 | `owner` \| `list`(→ `agent_invoker(agent_id, account_id)` 명단) \| `channel` \| `community` |
| **`credential_scope`** | 무슨 자격증명을 쥐나 | `personal` \| `community` \| `none` |

**불변식(요구 4-2·4-3), 양방향:**

```
credential_scope = 'personal'  ⟺  invoke_scope = 'owner'
```

개인 자격증명을 쥔 에이전트는 소유자만 부를 수 있고, 소유자만 부를 수 있게 한 에이전트에만
개인 MCP 가 붙는다. 서버가 `PATCH` 에서 조합을 거절하고, **오퍼레이터도 spawn 전에 다시
검사한다** — 오퍼레이터는 서버만 믿지 않는다(murmur 원칙 그대로, 주체만 러너에서
오퍼레이터로).

**MCP 는 이름만 서버에 둔다.** `mcp_server(name, credential_kind: community|personal)`
레지스트리를 `agent.privileged` 가 관리하고, 에이전트의 `mcp_servers` 는 그 이름의
부분집합이다. 정의와 토큰은 서버 DB 를 지나지 않는다 — **오퍼레이터**가 자기 머신의
`CLAUDE_CONFIG_DIR` 에서 그 이름의 정의를 꺼내 생성 `mcp.json` 에 합친다(B 에서 `mcp.json` 을
만드는 주체가 오퍼레이터이므로 자연스럽다). 공용 github 은 `community`, slack 은 `personal`.

**넓히기는 일방통행으로 막는다.** `owner → community` 로 여는 `PATCH` 는 거절한다 — 그
에이전트의 메모리·세션 기록·워크스페이스에 개인 데이터가 이미 눕는다. 넓히려면 새 에이전트를
만든다. 좁히기는 자유.

**기존 에이전트 backfill(확정):** `invoke_scope=community`, `credential_scope=none`. 현행 동작
유지이고, 오늘 에이전트에 붙은 개인 MCP 는 없으므로 `none` 이 정확하다. 추측 소유자 backfill 은
안 한다(008 판례).

### 팀·위임·auto-mention 과의 합성

팀 멘션(047), 팀장 위임(050), auto-mention(035)은 전부 "소유자가 아닌 무언가가 부르는 것"이다.
→ `invoke_scope != 'community'` 인 에이전트는 팀원·auto-mention 대상이 될 수 없고, **넣는
시점에 400** 으로 거절한다. 런타임에 조용히 건너뛰면 팀장이 "다섯 중 넷만 응답"을 디버깅한다.
(`disabled` 를 런타임에 거르는 것과 다른 선택인 이유: `disabled` 는 되돌아오는 상태고
`invoke_scope` 는 설계값이다.)

**게이트 자리는 한 곳** — `services/messages.ts` 의 fan-out, 비활성 에이전트를 거르는 그 자리.
멘션·@channel·집합·팀·위임이 전부 지나간다. 막힌 부름은 조용히 삼키지 않는다:
`meta.mentionChainCapped` 와 같은 모양으로 `meta.mentionDenied` 에 남겨 부른 사람에게 보인다.

## 7. 권한 × 실행 위치 — 교차 불변식

권한 모델과 오퍼레이터 모델은 직교한다 — **fan-out 게이트는 누가 깨울 수 있나**, **배정은
어디서 도나**. 그런데 `credential_scope` 가 둘을 잇는다. 개인 자격증명은 **그 사람의 머신**에
있기 때문이다.

```
credential_scope = 'personal'
  ⟹  agent_assignment.operator.owner_account_id = agent.owner_account_id
```

개인 MCP 를 쥔 에이전트는 **소유자 자신의 오퍼레이터**에만 배정할 수 있다. 서버가 배정
요청에서 거절하고, 오퍼레이터가 `assign` 을 받았을 때 `credential_scope='personal'` 인데 자기
소유자와 에이전트 소유자가 다르면 spawn 하지 않고 `runner.exited{reason}` 로 알린다.

| | 소유자의 오퍼레이터 | 다른 사람의 오퍼레이터(능력 등록됨) | 에이전트 전용 서버(관리자 소유) |
|---|---|---|---|
| `personal` | 허용 | **거절** | **거절** |
| `community` | 허용 | 허용(`agent.manage`) | 허용(`agent.manage`) |
| `none` | 허용 | 허용(`agent.manage`) | 허용(`agent.manage`) |

**호스트 테넌시와의 관계.** murmur 의 9/9 3편(같은 uid 러너끼리 평문 자격증명 공유)은 B 에서
**범위가 줄지만 사라지지 않는다.** harkroom PAT 은 러너에서 없어진다(배정이 곧 인가). 남는 것은
개인 MCP 토큰 — `CLAUDE_CONFIG_DIR` 은 여전히 러너 상태 디렉터리 옆에 있다. 그래서 순서는
murmur 가 적은 그대로다: `mcp_server` 레지스트리 + `credential_scope` 는 호스트 테넌시
(`owner_account_id NOT NULL`, isolation 신고) 뒤에 켠다.

## 8. 기존 설계 문서와의 관계

### 뒤집는 결정 — 하나

`design.md` §2 「daemon 과 server 의 경계」: *"daemon 은 서버를 모르고 서버는 daemon 을
모른다."* 근거 셋에 각각 답한다.

| 근거 | 답 |
|---|---|
| ① **닿는 범위** — unix 소켓은 그 기계 안이다 | 오퍼레이터가 서버에 **outbound WS** 로 붙는다. 러너가 릴레이로 하던 것과 같은 방향·같은 이유. 이제 다른 기계·다른 사람의 앱도 서버를 통해 이 오퍼레이터에 닿는다 |
| ② **어휘** — daemon 이 서버 어휘를 가지면 진실이 두 곳에 산다 | 오퍼레이터의 어휘를 **셋으로 제한**한다: 능력·프로세스·배정 수신. "누가 불렸나·처리됐나"는 여전히 서버만 안다. 러너의 `inbox.poll` 은 오퍼레이터를 **지나갈 뿐** 오퍼레이터가 해석하지 않는다 |
| ③ **커뮤니티 격리** — daemon 은 기계마다 하나라 커뮤니티마다가 아니다 | 여전히 기계마다 하나다. 격리는 스코핑 조건이 아니라 **인스턴스**로 강제한다(§3). 러너 상태는 이미 서버별 UUID 로 갈라져 있다 |

`design.md` §2 의 그 절은 이 문서를 가리키도록 고쳐 쓴다 — 단계 2 의 일부다.

### 유지되는 결정

| 결정 | 출처 | 이 설계에서 |
|---|---|---|
| 서버는 러너를 띄우지 않는다 | §1, PTY 스펙 §2 탈락안 B | **유지.** 오퍼레이터가 띄운다 |
| 러너는 포트를 열지 않는다 | PTY 스펙 §2 탈락안 C | **유지·확장.** 오퍼레이터도 포트를 열지 않는다(unix 소켓 + outbound WS + stdio 브릿지) |
| daemon 이 소유하는 것은 프로세스이지 세션이 아니다 | `daemonProtocol.ts` | **유지.** `sessions.json` writer 는 러너 하나 |
| 커뮤니티 = 서버 = 별개 배포 | §2-6, §6 | **유지·재사용.** 단일 커뮤니티/인스턴스는 열린 질문이 아니다 — murmur 4장 1번의 답 |
| "에이전트는 앱 안에 살지 않는다" | §5 업데이트 모델 | **비로소 실현** |

### 범위 표시

- **모바일 앱**은 §6 대로 v2. 이 설계는 "모바일이 붙을 수 있는 구조"까지다.
- **"에이전트 전용 원격 서버"** 는 §6 의 "상주형(서버 호스팅)"과 **다르다.** 그쪽은
  workspace-server 가 에이전트를 돌리는 것, 이쪽은 별도 머신의 헤드리스 오퍼레이터. §6 에 그
  구분을 적는다.
- `operations.md` §8 의 launchd 경로("앱이 안 도는 머신의 길")는 **러너가 아니라 오퍼레이터**를
  감독하는 것으로 바뀐다. 에이전트마다 plist 하나가 아니라 머신에 하나.

## 9. 실패 처리와 위험

### 실패 처리

| 상황 | 동작 | 사람에게 보이는 것 |
|---|---|---|
| **오퍼레이터 오프라인** | 배정은 남는다. 멘션은 inbox 에 쌓인다(at-least-once, 기존). 돌아오면 밀린 것을 처리한다 | 에이전트 presence = **배정된 오퍼레이터 연결 ∧ 러너 생존**. `operations.md` §8 의 "사이드바 presence 는 원래부터 회색" 문제가 이것으로 닫힌다 |
| **채널 끊김**(프록시가 조용히 걷어감) | 양방향 heartbeat(30초) → 최대 60초 안에 양쪽이 안다. 오퍼레이터 백오프 재접속, `hello` 에 러너·세션 전부 announce → 서버 레지스트리 재구성 | 재접속 창 동안 터미널 패널은 "오퍼레이터 연결 끊김". 붙으면 이어진다 |
| **재배정 중 턴 진행** | `unassign{drain:true}` — 진행 중 턴은 끝까지, 새 부름은 안 받음 | 배정 UI 에 "이전 오퍼레이터에서 턴 종료 대기 중" |
| **서버 재시작** | 오퍼레이터 재접속 + announce. "서버 재시작 = 전원 끊김"(§5) 그대로 | 잠깐 끊겼다 이어진다 |
| **오퍼레이터 크래시** | 러너는 `detached` 로 산다(기존 데몬 원칙). 재기동 시 장부로 고아 입양(기존 `adopt`) → 서버에 announce | 입양 전까지 그 러너의 세션은 서버에 없다 — 터미널만 잠시 못 연다 |
| **토큰 폐기** | 채널 `4401`. 재시도하지 않는다 | 배정 UI 에 "폐기됨" |
| **같은 에이전트에 러너 둘** | 서버가 배정 하나로 막는다. 오퍼레이터는 여전히 장부 + `kill(pid,0)` 로 로컬 중복을 막는다(§1) | — |

### 위험

- **drain 이 영원히 안 끝난다.** 인터랙티브 턴이나 `awaitingHuman` 상태의 멘션 턴은 사람이
  답하기 전엔 끝나지 않는다. drain 에 **상한(기본 10분)** 을 두고 넘으면 SIGTERM 으로 회수한다
  — 고아 회수와 같은 경로(SIGTERM → 유예 → SIGKILL). 배정 UI 가 남은 시간을 보여 준다.
- **오퍼레이터 토큰 하나가 배정된 에이전트 전부의 인가다.** 오늘 데스크탑 키체인의 PAT 13개와
  위험의 총량은 같지만 **한 개로 모였다.** OS 키체인 보관은 그대로이고, 폐기 한 번으로 전부
  끊을 수 있다는 것이 반대편의 이점이다. 토큰 수명은 열린 질문(§12).
- **stdio 브릿지가 long-poll 을 붙잡는다.** `inbox.poll` 은 25초 대기다. 하네스가 JSON-RPC 를
  직렬로만 보낸다면 문제 없지만, 병렬로 보내면 브릿지 안에서 요청 다중화가 필요하다. 단계 4
  첫 작업으로 실측한다 — Phase 1 의 교훈(단위 테스트 21개 통과, 실물 즉사) 그대로.
- **키체인 마이그레이션.** 기존 `harkroom.runner.pat.<agentId>` 항목은 단계 4 이후 쓸모가
  없어진다. 지우는 것은 사람이 한다(운영 문서에 절차) — 자동 삭제는 "돌아갈 길"을 없앤다.
- **이름 바꾸기의 파급.** `packages/daemon` 개명은 사이드카 번들 이름·앱 데이터 경로·키체인
  서비스명·Tauri capability 까지 닿는다. 단계 2 의 첫 PR 을 **개명만**으로 자르고 동작 변화
  0 을 확인한 뒤 다음으로 간다.

## 10. 테스트

각 단계의 회귀선. 실물 e2e 는 `roadmap.md` §5 의 원칙대로 **따로 돈다** — 단위·계약 테스트가
초록이어도 실물로 확인하기 전엔 닫지 않는다.

| 단계 | 서버 | 오퍼레이터 | 러너 · 데스크탑 | 실물 |
|---|---|---|---|---|
| 1 권한 | `can()` 단위(역할·grant·소유·scope 조합) · `requireCap` 이 `requireAdmin` 과 **같은 판정**을 내는 대조 테스트(전 라우트) · grant 부여/회수가 `audit_log` 에 남는다 | — | — | 기존 e2e 전부 그대로 통과 |
| 2 오퍼레이터 | 등록 코드 → 토큰 교환 · `/operator` 인증(폐기 토큰 `4401`) · `hello` 능력이 목록에 보이고 끊기면 사라진다 · `assign` 이 배정 하나로 제한된다 · 재배정이 `unassign`→`assign` 순서를 지킨다 | 커뮤니티 인스턴스 격리(두 서버에 붙어 상태가 안 섞인다) · 로컬 설정 없는 에이전트는 능력에 안 실린다 · `assign` 받으면 spawn, `unassign{drain}` 이면 새 부름 거부 | 데스크탑: 러너 기동 코드가 **없다**(`runnerShellScope.test.ts` 식 회귀선) | B컴퓨터에서 A컴퓨터 배정 에이전트를 불러 답을 받는다. 데스크탑을 꺼도 러너가 뜬다 |
| 3 릴레이 | `addOperator` 다중화: 러너 둘의 바이트가 섞이지 않는다 · 오퍼레이터 끊김 → 그 러너 세션 전부 `runner-offline` · heartbeat wedge 테스트(`agentRelayHeartbeat.test.ts` 를 채널로 옮김) | 러너 unix 프레임 → 채널 프레임 변환 왕복 | 러너: `relay.ts` 가 서버 URL 을 **모른다** | 원격에서 터미널 관찰·개입이 60초 안에 복구된다 |
| 4 MCP | `/mcp` 가 오퍼레이터 토큰 + `X-Harkroom-Agent` 로 배정을 확인하고 미배정이면 403 · PAT 경로는 그대로 산다(외부 접속형) | 브릿지 JSON-RPC 왕복 · long-poll 중 다른 요청(실측 결과에 따라) | 러너 env·디스크 어디에도 `HARKROOM_PAT` 이 없다 | 멘션 → 답 왕복이 PAT 없이 된다 |
| 5 스코프 | `PATCH` 가 불변식 위반 조합을 거절 · fan-out 게이트가 `invoke_scope` 로 거르고 `mentionDenied` 를 남긴다 · 팀원 추가가 `invoke_scope!=community` 를 400 · 배정이 교차 불변식을 거절 | spawn 전 재검사 | — | slack(personal) 에이전트를 남이 불러도 안 깨어나고 표시가 보인다 |
| 6 헤드리스 | — | launchd/systemd 템플릿으로 뜬 오퍼레이터가 앱 없이 등록·배정·실행 | — | 앱 없는 머신에 오퍼레이터 하나로 에이전트 N개 |

## 11. 페이즈

매 단계가 **단독으로 배포 가능**하고 이전 단계 없이는 켜지지 않도록 자른다. 1 과 2 는
독립이라 병렬(확정). 5 는 1·4 둘 다 뒤. 6 은 2 뒤.

| 단계 | 내용 | 완료 정의 |
|---|---|---|
| **0** | `/agent-relay` heartbeat — `b485b9d8` 로 완료 | 테스트 2건 초록, 전체 122 파일 통과 |
| **1** | `account.role` + `account_grant` + `can()` + `requireAdmin` → `requireCap()` 교체. `channel.created_by` 추가, 소유 기반 통과 | 동작 변화 0(admin 은 전부 통과). 기존 테스트 전부 초록 + grant 부여/회수/감사 테스트 |
| **2** | `packages/daemon` → `operator` 개명(첫 PR, 동작 변화 0). `operator` 테이블·등록·토큰. `/operator` 채널(제어 프레임만). `agent_assignment` + 배정 UI. 능력 등록. 오퍼레이터가 spawn env(URL·PAT) 주입을 맡음. **데스크탑에서 러너 기동 코드 제거.** `design.md` §2 절 갱신 | B컴퓨터 데스크탑에서 A컴퓨터 배정 에이전트를 불러 답을 받는다. 데스크탑을 꺼도 러너가 뜬다. 앱에 PAT 이 없다 |
| **3** | 릴레이를 오퍼레이터 채널에 다중화. 러너→오퍼레이터 unix 프레임. `/agent-relay` 폐기 | 머신당 서버 WS 1개. 터미널 관찰·개입이 원격에서 끊기지 않고 60초 안에 복구된다 |
| **4** | stdio MCP 브릿지(첫 작업: long-poll 실측). 서버 `/mcp` 에 오퍼레이터 인증 + 배정 확인. 러너에서 `HARKROOM_URL`·`HARKROOM_PAT` 제거 | 러너 프로세스 env·디스크 어디에도 PAT 이 없다. PAT 은 외부 접속형에만 남는다 |
| **5** | `invoke_scope`·`credential_scope`·`agent_invoker`·`mcp_server` 레지스트리·fan-out 게이트·교차 불변식 | slack(personal) MCP 를 붙인 에이전트를 남이 불러도 깨어나지 않고 `mentionDenied` 가 보인다. 그 에이전트를 남의 오퍼레이터에 배정하면 거절된다 |
| **6** | 헤드리스 오퍼레이터 — launchd/systemd 템플릿이 오퍼레이터를 감독. `operations.md` §8 갱신 | 앱 없는 머신에 오퍼레이터 하나로 에이전트 N개가 돈다 |

## 12. 범위 밖과 열린 질문

범위 밖:
- 모바일 앱 자체(§6 v2). 여기서는 구조만 연다.
- 상주형(서버 호스팅) 에이전트(§6 v2). 오퍼레이터는 서버가 아니다.
- 멀티테넌시(§6). 커뮤니티는 여전히 인스턴스 하나.
- 오퍼레이터 사이의 직접 통신. 전부 서버를 거친다.

열린 질문(이 문서가 답하지 않는 것):
- **오퍼레이터 토큰의 수명.** 무기한 + 폐기만인지, 갱신 주기를 두는지. 데스크탑 세션 토큰의
  정책을 따르는 것이 자연스럽다. 단계 2 설계 시 정한다.
- **한 사람이 오퍼레이터를 여럿 가질 때의 기본 배정.** 새 에이전트를 만들면 어디에 배정되는가
  — "만든 자리의 오퍼레이터"가 답일 것 같지만 핸드폰에서 만들면 자리가 없다. 첫 판은 **미배정**
  으로 두고 UI 가 고르게 한다.
- **MCP 브릿지의 스트리밍**(§9 위험). 단계 4 첫 작업의 실측이 답한다.
