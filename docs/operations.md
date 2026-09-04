# 운영 절차 — 백업과 복구

- 기준일: 2026-09-01
- 대상: self-host 운영자(docker compose 기준)
- 성격: [`design.md`](design.md)가 설계, [`roadmap.md`](roadmap.md)가 현황이라면 이 문서는 **손으로 밟는 절차**다.

## 1. 무엇이 어디에 사는가

백업 계획은 상태의 위치에서 시작한다. murmur의 상태는 세 곳에 있고, **성격이 다르다.**

| 상태 | 어디에 | 백업 대상인가 |
|---|---|---|
| 채팅·멤버십·inbox·투영 커서·idempotency·세션/PAT 해시·**감사 추적** | Postgres 볼륨 `pgdata` | **필수.** 이것만 잃으면 워크스페이스가 사라진다 |
| avcs 오브젝트(intent·operation·decision·lease) | **avcs 서버의 저장소** (별도 프로세스) | 필수지만 **murmur의 책임이 아니다.** murmur는 그 로그의 관찰자다(§3 참조) |
| 에이전트 세션·avcs 워크스페이스 | `<AGENT_STATE_DIR>/<handle>/` (로컬 디스크) | 권장. `sessions.json` (스레드별 세션 레코드)과 각 스레드의 avcs 워크스페이스가 포함된다. 이 디렉터리를 정기적으로 백업하거나 복제하면, 러너 재설치 시 스레드별 대화·avcs 상태를 그대로 이어받을 수 있다 |
| 첨부 파일 *(계획)* | 로컬 볼륨 `attachments` | 도입되면 필수. `pgdata`와 **함께** 떠야 한다(§4) |

백업하지 **않는** 것 — 잃어도 재구성되기 때문이다:

- WS 티켓, presence 카운터, 레이트 리밋 카운터: 전부 인메모리다. 재시작하면 리셋되고, 클라이언트 재연결이 presence를 다시 세운다.
- 데스크탑의 토큰(`localStorage`): 재로그인으로 복구된다.
- 투영된 시스템 메시지: `pgdata`에 있지만 **원본은 avcs 로그다.** 커서를 되돌리면 다시 만들어진다(§3-A).

## 2. 백업 절차

Postgres는 논리 덤프로 뜬다. `-Fc`(custom format)는 **단일 트랜잭션 스냅샷**이므로 메시지와
투영 커서가 서로 어긋난 시점으로 잡히지 않는다 — 이 정합성이 §3의 복구 안전성의 전제다.

```bash
# 서비스를 멈추지 않고 뜬다(pg_dump는 읽기 일관 스냅샷을 잡는다)
docker compose exec -T postgres \
  pg_dump -U murmur -Fc murmur > "murmur-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

첨부 볼륨이 도입되면 **두 대상을 가깝게** 뜬다(순서 위험은 §4):

```bash
docker compose stop server                      # 쓰기를 멈춘다
docker compose exec -T postgres pg_dump -U murmur -Fc murmur > murmur.dump
docker run --rm -v murmur_attachments:/data -v "$PWD":/backup alpine \
  tar czf /backup/attachments.tgz -C /data .
docker compose start server
```

avcs 서버는 자기 절차를 따른다. murmur 덤프만 있으면 채팅은 온전하지만, **작업 층(avcs)은
복구되지 않는다** — 투영된 시스템 메시지는 남고 그것이 가리키는 오브젝트는 사라진 상태가 된다.

에이전트 세션·avcs 워크스페이스는 `AGENT_STATE_DIR` (기본 `~/.murmur-agent`) 를 백업한다.
`pnpm --filter @murmur/agent start` 를 다시 띄울 때 이 디렉터리가 있으면 스레드별 대화·avcs
상태를 그대로 이어받는다. 백업 시점 이후에 생긴 스레드는 당연히 없다.

## 3. 복구 절차

`server`를 **먼저 멈춘다.** 살아 있으면 복구 중에 쓰기가 들어가고, 부팅 시 마이그레이션이
돌아 스키마가 덤프와 어긋난다.

```bash
docker compose stop server
docker compose exec -T postgres dropdb -U murmur --if-exists murmur
docker compose exec -T postgres createdb -U murmur murmur
docker compose exec -T postgres pg_restore -U murmur -d murmur --no-owner < murmur.dump
docker compose start server        # 부팅 시 누락 마이그레이션이 적용된다
```

마지막 줄에 기댈 수 있는 이유: `runMigrations`가 advisory lock으로 직렬화되고 적용 여부를
`schema_migrations`로 판정한다. **오래된 스키마의 덤프를 새 서버로 복구해도 부팅이 그 차이를
메운다.** 반대 방향(새 스키마 덤프 → 오래된 서버)은 지원하지 않는다.

### 3-A. murmur만 되돌린 경우 — 안전하다

투영 커서가 과거로 가고, 워커가 이미 투영했던 구간을 다시 읽는다. 시스템 메시지는
`(repo, oid)` UNIQUE로 중복되지 않고, 커서 전진이 메시지 삽입과 같은 트랜잭션에 있다.
→ 워커가 조용히 따라잡고 끝난다.

근거(테스트): `projection.test.ts` → *"is idempotent: rerun from cursor 0 does not duplicate"*.

사람이 쓴 메시지는 avcs에 없으므로 **덤프 시점 이후의 대화는 돌아오지 않는다.** 그건 복구의
성질이고 결함이 아니다.

### 3-B. avcs를 murmur 커서보다 오래된 상태로 되돌린 경우 — 위험하다

커서가 로그보다 앞서면 `fetchSince`가 줄 것이 없고, 커서는 후퇴하지 않는다. 크래시는 없지만
**avcs 로그가 커서를 다시 넘어설 때까지 그 사이의 객체가 조용히 건너뛰어진다.** 채널에는
아무 일도 없어 보이므로 알아차리기 어렵다.

근거(테스트): `projection.test.ts` → *"stalls without crashing when the cursor is ahead of the avcs log"*.

**대처**: avcs를 되돌렸다면 해당 repo의 커서를 그 지점 이하로 맞춘다. 재투영은 멱등이므로
0으로 내려도 안전하다.

```sql
update projection_cursor set last_log_index = 0 where repo = 'org/repo';
```

**avcs 데이터가 아예 사라진 경우도 같다.** 개발·도그푸딩에서 avcs 서버의 데이터 디렉터리가
스크래치패드처럼 휘발성 위치에 있으면 정리 한 번으로 로그가 빈 상태가 되는데, murmur 커서는
그대로 남아 있다 — 위와 같은 사일런트 스킵이다. 커서를 0으로 내리면 복구된다.

원칙: **avcs와 murmur를 되돌릴 때는 avcs를 murmur보다 뒤로 두지 않는다.** 어쩔 수 없다면
커서를 함께 내린다.

### 3-C. 감사 추적은 복구되지만 되돌려지지 않는다

`audit_log`는 `pgdata`에 있으므로 덤프에 포함된다. 다만 트리거가 `update`/`delete`를 막으므로
**복구 후에 감사 행을 정리할 수 없다.** 보존 정책이 필요하면 트리거를 의도적으로 내리고
지운 뒤 다시 세운다 — 그 의도성이 append-only 장치의 목적이다.

## 4. 첨부 볼륨의 순서 위험 (도입 시)

`pgdata`와 `attachments`는 **다른 시점으로 뜰 수 있다.** DB가 더 새로우면 메시지가 존재하지
않는 파일을 가리키고(다운로드 404), 볼륨이 더 새로우면 아무도 참조하지 않는 파일이 남는다.
둘 중 **후자가 안전하다** — 그래서 순서는 `볼륨 → DB`가 아니라 `server 정지 → 둘 다 → 시작`이다.
정지 없이 뜬다면 볼륨을 먼저 뜬다.

## 5. 복구 리허설 체크리스트

복구는 **해 본 적 있을 때만** 절차다. 다음을 실제로 밟아 확인한다.

- [ ] 덤프를 **다른 데이터베이스 이름**으로 복구해 본다(운영 DB를 건드리지 않고 검증)
- [ ] 복구본으로 서버를 띄우고 `GET /readyz` 200, `GET /healthz`의 `avcs.connected` 확인
- [ ] 로그인 → 채널 목록 → 메시지 히스토리가 보이는지
- [ ] 에이전트 PAT로 `inbox.poll` 1회가 정상 응답하는지
- [ ] repo 바인딩 채널에서 새 avcs 객체가 투영되는지(커서가 전진하는지)

## 6. AVCS_BASE_URL — 투영 활성화와 그 상태 읽기

murmur 는 avcs 서버를 폴링해 intent·operation·decision 같은 객체를 채널 메시지로
투영한다. 이 투영은 기본적으로 **비활성**이고, 환경변수 하나로 켠다:

```bash
AVCS_BASE_URL=https://your-avcs-server.example.com
```

**`AVCS_BASE_URL` 이 없을 때 무엇이 꺼지는지는 이 절 하나에만 적는다**(#371).
루트 `README.md` 와 `docs/design.md` 는 여기를 가리키기만 한다 — 같은 목록을 여러 곳에
두면 한 곳만 낡고, 낡은 쪽을 읽은 사람이 손해를 본다.

### 꺼지는 것은 하나다 — 투영 워커

`AVCS_BASE_URL` 을 읽는 자리는 코드 전체에 **셋**뿐이다:

| 자리 | 하는 일 |
|---|---|
| `packages/server/src/config.ts:27` | `env.AVCS_BASE_URL ?? null` 을 `config.avcsBaseUrl` 로 읽는다 |
| `packages/server/src/main.ts:20` | 값이 **있을 때만** `ProjectionWorker` 를 만들고 `start()` 한다 |
| `packages/server/src/main.ts:30` | 없으면 기동 경고 한 줄을 남긴다(`warnIfProjectionDisabled`) |

그래서 꺼지는 것은 **투영 워커 하나**다. 없어지는 라우트도, 404 가 되는 경로도 없다 —
전부 200 으로 답하고 **결과가 비어 있을 뿐**이다. 그것이 이 절이 필요한 이유다.

| 기능 | 워커가 없을 때 | 그렇게 되는 근거 |
|---|---|---|
| avcs 객체 → 채널 시스템 메시지 투영 | 아무것도 들어오지 않는다 | 그 메시지의 유일한 작성자가 `avcs/projection.ts:94` |
| 사이드바 ACTIVE WORK 의 리스 목록 | `GET /leases` 가 늘 `{leases: []}` | `active_lease` 의 유일한 작성자가 `projection.ts:156` |
| `murmur_projection_cursor` 메트릭 | 시계열이 **아예 없다**(0 이 아니라 없음) | `projection_cursor` 의 유일한 작성자가 `projection.ts:184` |
| `GET /healthz` 의 `avcs.connected` | 항상 `false` | `main.ts:38` 이 `DISABLED_PROJECTION_STATUS` 로 답한다 |
| `murmur` 시스템 계정 | 만들어지지 않는다 | `ensureSystemAccount` 호출이 `main.ts:24`, 즉 `if` 블록 안이다 |
| 채팅 전부 — 채널·스레드·DM·검색·첨부·반응·WS·PAT·MCP·러너 릴레이 | **그대로 동작한다** | `buildServer.ts` 가 라우트 모듈에 avcs 클라이언트를 넘기지 않는다 |

### 말없이 성공하는 자리 — 여기가 사람을 속인다

투영이 꺼져 있어도 **성공 응답을 주면서 아무 일도 하지 않는** 경로가 둘 있다. 둘 다
화면에 표시가 없으므로 미리 알고 있어야 한다.

- **MCP `work.link`** (`packages/server/src/mcp/mcpPlugin.ts:290`) — repo 가 바인딩된
  채널만 있으면 `{ ok: true }` 를 주고 `work_thread` 행까지 쓴다. 그 행을 읽는 곳은
  `projection.ts:109` 하나뿐이라 **투영이 꺼져 있으면 아무도 영원히 읽지 않는다.**
  에이전트는 작업을 스레드에 묶었다고 믿는다.
- **채널에 repo 바인딩** (`POST /channels` · `PATCH /channels/:id`, 데스크탑은
  `Sidebar.tsx:529` 의 Repository 입력) — 값이 저장되고 사이드바와 채널 헤더에 배지까지
  뜬다. 그 폼에는 아무 경고가 없다. 바인딩을 소비하는 곳은 `projection.ts:223` 뿐이다.

이 둘은 **문서가 아니라 코드로 닫을 일**이다(성공 응답에 경고를 싣거나, 폼 옆에 투영
상태를 붙이거나). 지금 알아챌 수 있는 자리는 아래 사이드바 배너 하나뿐이다.

### 꺼져 있을 때 보이는 것

- 서버 기동 로그에 경고 한 줄: `avcs projection is disabled — set AVCS_BASE_URL to enable it`
  (`avcs/projection.ts:301`)
- `GET /projection/status` 가 `state: "unconfigured"` 를 준다
- 사이드바 ACTIVE WORK 에 "투영이 설정되지 않았다 / AVCS_BASE_URL 로 켠다"
  (`LeasePanel.tsx:67`, `Sidebar.tsx:1279` 에서 그려진다)

이 세 자리가 **모두 필요한 이유**: 예전에는 투영이 꺼져 있어도 화면이 평소와 똑같이
"No active work" 였다. 아무 일도 안 일어나는 것과 아무도 보고 있지 않은 것이 같은
그림이라 도그푸딩 중에 투영이 끊긴 것을 며칠 동안 아무도 몰랐다
(`docs/design.md` §4: "없다"와 "못 읽었다"를 한 화면에 두지 않는다).

### 켜져 있을 때 — `GET /projection/status`

로그인이 필요하다(`requireAccount`). 응답은 워커의 원자료에 `state` 하나를 더한 것이다:

| 필드 | 뜻 |
|---|---|
| `state` | `unconfigured` · `stalled` · `ok` |
| `configured` | `AVCS_BASE_URL` 이 있어 워커가 떴는가 |
| `repo` | 마지막으로 폴링한 저장소 |
| `lastLogIndex` | 커서 위치 |
| `lastPolledAt` | 마지막 폴링 시각(ms) — **살아 있음의 신호** |
| `lastAdvancedAt` | 커서가 마지막으로 전진한 시각(ms) |
| `lastError` | 마지막 실패 메시지(200자). 성공 폴링이 지운다 |

`state` 판정:

- `unconfigured` — `AVCS_BASE_URL` 이 없다
- `stalled` — 켜져 있는데 `lastPolledAt` 이 없거나 **5분**보다 오래됐거나 `lastError` 가 있다
- `ok` — 그 외

> **커서가 안 움직이는 것은 장애가 아니다.** 아무도 커밋하지 않는 조용한 저장소도
> `lastAdvancedAt` 이 그대로다. 그것을 장애로 부르면 정상인 저장소가 영영 빨갛고,
> 사람은 곧 이 표시를 무시하게 된다. 신호는 `lastAdvancedAt` 이 아니라
> **`lastPolledAt`** 이다 — 우리가 물어보고 있는가.

### 사이드바 ACTIVE WORK 가 말하는 네 가지

앱은 기동 시 한 번, 이후 60초마다 이 상태를 다시 읽는다.

| 상황 | 표시 |
|---|---|
| 상태를 못 읽었다(요청 실패) | "투영 상태를 읽지 못했다" + 사유 |
| 아직 첫 응답 전 | "투영 상태를 확인하는 중…" |
| `unconfigured` | "투영이 설정되지 않았다" + `AVCS_BASE_URL` |
| `stalled` | "투영이 N분 전부터 멈춰 있다" (+ `lastError`) |
| `ok` + 빈 목록 | "No active work" |
| `ok` + 항목 | 저장소별 리스 목록 |

"No active work" 는 **상태를 읽었고 정상일 때만** 쓴다. 나머지는 왜 비어 있는지를
먼저 말한다.

### `/healthz` 와의 차이

`GET /healthz` 의 `avcs.connected` 는 **avcs 서버에 붙었는가**이고,
`/projection/status` 는 **투영이 돌고 있는가**다. 다른 사실이라 한 객체에 싣지 않는다 —
붙어 있어도 폴링이 멈출 수 있고, 잠깐 끊겨도 투영은 곧 따라잡는다.

**`/healthz` 만으로는 "투영을 끈 것"과 "켰는데 못 붙은 것"을 구분할 수 없다** — 둘 다
`connected: false` 다(`main.ts:38`). 그 구분은 `/projection/status` 의 `state` 가 한다:
끈 것은 `unconfigured`, 켰는데 안 도는 것은 `stalled` 다. 감시를 붙인다면 `/healthz` 가
아니라 이쪽을 봐야 한다.

### 끊긴 곳: `.avcs` 가 `git clean` 에 지워진다

투영이 켜져 있어도 브리지 쪽에서 `.avcs` 디렉터리가 지워지면 로그가 흐르지 않는다.
이것은 이 저장소 밖(avcs 브리지)의 일이라 여기서 고치지 않는다 — 위 표시가 그때
`stalled` 로 보이게 하는 것이 murmur 쪽의 몫이다.

## 7. 관측 지점

문제가 났을 때 먼저 볼 곳:

| 무엇 | 어디 |
|---|---|
| 요청 실패율·지연 | `GET /metrics` → `murmur_http_requests_total{status=...}`, `murmur_http_request_duration_seconds` |
| 지금 몇 명이 붙어 있나 | `murmur_ws_connections` |
| **투영이 멈췄나** | `murmur_projection_cursor{repo=...}` — 값이 오르지 않으면 §3-B의 사일런트 스킵을 의심한다 |
| **에이전트가 답하지 않나** | `murmur_agent_oldest_unread_seconds{handle=...}` — 값이 커지면 그 에이전트의 **러너 프로세스가 죽었을 가능성이 가장 크다**. 서버는 정상이고 다른 지표도 정상인 채로 사용자만 답을 못 받는 상태다(2026-09-01 실제 발생). **답할 의무가 있는 계정만 센다** — 사람과, 정의(`agent_config`)가 없는 에이전트 계정은 없다(아래 §7) |
| avcs 연결 상태 | `GET /healthz` → `avcs.connected` |
| 누가 무엇을 바꿨나 | `GET /audit` (admin) |
| 개별 요청 | 컨테이너 stdout(`LOG_LEVEL`, 기본 info) |

스크레이프에는 인증이 필요하다. 만료 없는 **에이전트 PAT**를 쓰는 것이 실용적이다
(사람 세션 토큰은 14일에 만료된다).

## 8. 에이전트가 답하지 않을 때

2026-09-01 실측: 사용자가 `@fizz`를 불렀는데 답이 없었다. **서버·DB·투영 전부 정상이었고
러너 프로세스가 죽어 있었다.** 그 상태에서 보이는 것과 안 보이는 것:

| 어디 | 무엇이 보이나 |
|---|---|
| 데스크탑 | **아무것도.** 부른 상대가 조용한 것만 보인다 — 러너가 죽었다는 신호가 UI에 없다 |
| 사이드바 presence | 에이전트는 WS를 물지 않으므로 **원래부터 회색**이다. 살았는지 죽었는지 구분되지 않는다 |
| `GET /healthz`·`/metrics` 기본 지표 | 전부 정상 |
| **`murmur_agent_oldest_unread_seconds`** | **값이 계속 커진다** ← 유일한 신호 |

### 지표에 없는 계정 — 그것이 의도다

`kind='agent'` 라도 **정의(`agent_config` 행)가 없는 계정은 이 지표에 나오지 않는다.** 둘이 있다:

- `murmur` — avcs 투영용 시스템 계정. 투영 워커가 만들고 러너가 없다.
- 정의 없이 만들어진 계정(옛 테스트 계정 등) — 답할 러너가 없고 앞으로도 없다.

사용자는 사이드바에 보이니 자연스럽게 부른다. 그 미처리를 지표에 넣으면 **영원히 쌓이며 절대
내려오지 않는다** — 경보가 반복되고, 사람이 경보를 무시하게 되고, 그때 진짜 러너가 죽으면
아무도 안 본다. 그래서 뺀다. **"부름이 처리되지 않는다"가 문제인 것은 답할 의무가 있는
상대일 때뿐이다.**

정의 없는 에이전트를 사용자가 계속 부른다면 지표가 아니라 그 계정을 정리하거나 정의를 붙이는
것이 답이다(UI 의 Add/Edit agent).

확인 순서:
1. `GET /metrics`에서 그 핸들의 값을 본다. 커지고 있으면 러너 쪽이다.
   **값이 아예 없으면** 그 계정에 정의가 없는 것이다(위 문단) — 러너 문제가 아니다.
2. 러너가 감독 하에 있는지 본다: `launchctl list | grep dev.murmur.agent`.
   PID 자리가 `-`면 죽어 있고 재시작을 못 하는 상태다.
3. 로그를 본다: `/tmp/murmur-runner/<handle>.log`(stdout), `.err.log`(stderr).
4. 러너가 뜨면 쌓인 것을 처리한다. 설계가 at-least-once이므로 **늦게라도 답한다** —
   inbox 항목은 읽음 처리 전까지 남는다.

### 답할 러너가 없는 계정 (지표에는 안 나온다)

`kind='agent'`이지만 정의(harness)가 없는 계정이 있다 — `murmur`(avcs 투영용 시스템 계정)과
과거 검증에 쓴 테스트 계정들. 사이드바에 DM으로 보이므로 사용자가 자연스럽게 부르지만
답할 주체가 없다.

**지표는 이들을 세지 않는다**(답할 의무가 있는 계정만 센다). 그래서 값이 아예 없다.
그 자체가 신호다 — 사용자는 부른 상대가 조용한 것을 보는데 지표에는 아무것도 없다.
확인:

```sql
select a.handle, c.harness
from account a left join agent_config c on c.account_id = a.id
where a.kind = 'agent';
```

`harness`가 비어 있으면 murmur가 실행할 수 없는 계정이다. 답은 지표를 고치는 것이 아니라
그 계정을 정리하거나 정의를 붙이는 것이다(UI의 Add/Edit agent).

## 8-0. 데스크탑 앱이 띄우는 러너 (#250)

감독(8-1) 대신 **앱**에 맡기는 길이 있다. 앱은 **내가 소유한**(`ownerAccountId` 가 내 계정)
에이전트만 띄운다 — 남이 소유했거나 소유자가 없는 에이전트는 지금까지처럼 사람이 띄운다.

설정 → 연결에서 둘을 정한다:

| 설정 | 뜻 |
|---|---|
| Auto-start runners | 앱 시작 시 대상 러너를 띄운다(기본 켬) |
| murmur repository path | 러너를 돌릴 저장소 경로. **비어 있으면 아무것도 띄우지 않는다** |

경로에 기본값을 지어내지 않는다 — 번들된 앱은 자기가 어느 디렉터리에 체크아웃돼 있는지
알 수 없고, 짐작한 경로로 자식을 띄우면 "왜 러너가 안 뜨지"의 원인이 사람이 볼 수 없는 곳에
숨는다. 비어 있으면 설정 → 에이전트 상세의 러너 절이 그 사실을 말한다.

**명령은 설정에서 바꿀 수 없다.** 앱은 `pnpm --filter @murmur/agent start` 하나만 띄운다 —
Tauri 의 shell 스코프(`src-tauri/capabilities/default.json`)에 그 명령과 그 인자만 허용해
뒀기 때문이다. 사람이 편집할 수 있는 명령은 곧 그 스코프를 와일드카드로 열어야 한다는
뜻이고, 그러면 웹뷰가 임의 명령을 실행할 수 있는 표면이 된다. 다른 명령으로 띄워야 하면
손으로 띄운다(설정 → 에이전트의 "러너 실행" 명령 틀) — 그 러너는 앱에서
'외부에서 실행 중'으로 보인다.

### 함정: GUI 로 띄운 앱의 `PATH` (8-1 과 같은 함정이다)

macOS 에서 Finder/Dock 으로 띄운 앱의 `PATH` 는 로그인 셸의 것이 아니라
`/usr/bin:/bin:/usr/sbin:/sbin` 정도라 **`pnpm` 을 못 찾는다** — launchd 감독(8-1)이 겪는
그 함정과 같은 것이다. `#305` 가 이것을 두 겹으로 메운다:

1. **앱이 로그인 셸의 `PATH` 를 한 번 읽어 캐시한다.** `sh -lc 'echo $PATH'` 를 `PATH` 를
   얻기 위해서만 돌리고(러너를 이 셸로 띄우는 것이 아니다), 그 값을 자식 `PATH` 로 넘긴다.
   프로세스 생애 동안 한 번만 읽는다 — 값은 바뀌지 않고, 러너 수만큼 셸을 띄울 이유가 없다.
2. **그것이 안 되면 설정 → 연결의 `pnpm path`** 를 쓴다. `pnpm` 실행 파일의 **절대 경로만**
   받고(`.../pnpm` 으로 끝나지 않으면 저장을 거절한다), 그 **디렉터리**가 자식 `PATH` 앞에
   붙는다. 인자는 앱이 고정한다 — 명령 전체를 사람이 정하게 하면 그것이 임의 실행 표면이다.

| 설정 | 뜻 |
|---|---|
| pnpm path | `pnpm` 실행 파일의 절대 경로. 비어 있으면 로그인 셸의 `PATH` 로 찾는다 |

둘 다 안 되면 **띄우지 않고** 상태가 '기동 실패' 로 남으며 사유가 화면에 붙는다:
"러너 명령을 찾을 수 없다 — … 설정 → 연결에서 pnpm 의 절대 경로를 지정하라". 조용히 앱의
`PATH` 로 시도하지 않는다 — 그것이 이 함정의 원래 실패 모습이다.

**셸 스코프는 여전히 와일드카드가 아니다.** `capabilities/default.json` 의 `login-path`
항목은 `sh` 에 `["-lc", "echo $PATH"]` **그 인자 배열 하나만** 허용한다. `args: true` 나
정규식 인자로 바꾸는 순간 웹뷰가 임의 명령을 실행할 수 있게 되고, `test/runnerShellScope.test.ts`
가 그것을 막는다. 러너 명령을 `sh -lc` 로 **감싸는** 길은 그래서 여전히 쓰지 않는다.

### PAT 는 앱이 쥐고, 회전은 사람이 누를 때만

앱이 `POST /accounts/:id/pats` 로 발급받아 **OS 키체인**에 라벨과 함께 보관한다(라벨
`desktop:<기기 id>`). **기동마다 재발급하지 않는다** — 재발급하면 그 PAT 로 돌던 러너가
401 을 받고 물러나며 진행 중인 작업이 날아간다. 앱 업데이트 한 번에 돌던 러너가 전부
죽는 것이 이 결정이 막는 것이다.

설정 → 에이전트 상세의 **"PAT 재발급"** 을 누르면 이 순서로 일어난다:

1. 새 라벨(`desktop:<기기 id>#<epoch>`)로 **새 PAT 발급**
2. 키체인에 있던 **옛 라벨을 폐기**(`DELETE /accounts/:id/pats/:label`)
3. 자식 종료 → 새 PAT 로 재실행

발급이 먼저인 이유: 폐기가 먼저면 발급이 실패한 순간 쓸 수 있는 PAT 가 하나도 없고, 그
사이 돌던 러너는 이미 401 로 물러난다. 라벨을 새로 만드는 이유: 라벨은 **살아 있는 토큰
안에서 유일**해서(마이그레이션 010) 같은 라벨로 먼저 발급하는 것이 409 로 막힌다.

옛 PAT 로 돌던 러너(다른 머신의 것도 포함)는 다음 호출에서 401 을 받고 **종료 코드 78**로
스스로 물러난다 — 러너↔앱 통신 채널은 없고 서버가 진실의 원천이다. 앱은 자식이 78 로
죽은 것을 보고 '종료 (78: 자격증명 폐기 — 재발급 필요)' 로 표시한다.

### 상태 표시가 말하는 것

| 표시 | 뜻 |
|---|---|
| 실행 중 | 이 앱이 띄운 자식이 살아 있다 |
| 외부에서 실행 중 | 이미 러너가 붙어 있다(presence) — 앱은 띄우지 않았다 |
| 종료 (78: 자격증명 폐기 — 재발급 필요) | PAT 가 폐기·회전됐다. 재발급하면 다시 뜬다 |
| 종료 (기타: 코드 N) | 그 코드로 죽었다. 원인은 러너 로그를 본다 |
| 기동 실패 | 띄우지 못했다 — 사유가 옆에 붙는다(경로 미설정, 키체인 읽기 실패 등) |
| 꺼짐 | 이 앱이 띄운 자식이 없다 |

**키체인을 읽지 못하면 발급하지 않는다.** '없다'로 삼키면 앱은 새 PAT 를 발급하고 옛 것을
폐기하는데, 그 옛 PAT 로 지금 일하고 있는 러너가 죽는다 — 키체인 한 번의 실패로 회전
금지 결정이 무너진다. 그 경우 상태는 '기동 실패' 로 남고 사유를 말한다(키체인 잠김은 사람이
푸는 것이고, 조용한 재시도는 실패를 다시 숨긴다).

## 8-1. 러너를 감독 하에 두기 (macOS)

`~/Library/LaunchAgents/dev.murmur.agent.<handle>.plist`를 만들고
`launchctl load <경로>`. 세 가지가 함정이다:

- **`pnpm`을 거치지 말고 `tsx`를 직접 부른다.** pnpm을 감독하면 러너가 죽어도 pnpm이
  남아 launchd가 재시작하지 않는 경우가 생긴다.
- **`PATH`를 명시한다.** launchd는 로그인 셸의 PATH를 물려받지 않는다. 예전에는 이 함정이
  `claude` 하나였지만, 러너 재구축([`docs/specs/2026-09-01-runner-sessions-pty-design.md`](specs/2026-09-01-runner-sessions-pty-design.md))
  이후로는 PATH에 있어야 하는 실행 파일이 **에이전트의 harness 선택에 따라 늘어난다** —
  `codex`·`gemini`(harness 자체)뿐 아니라 `avcs`도 매 턴 필요하다(스레드별 workspace를
  만드는 `avcs workspace project`, 그리고 turn 이 등록하는 avcs MCP 서버가 `avcs mcp`를
  그대로 스폰한다). 이 중 하나라도 PATH에 없으면 "러너는 살아 있는데 답을 못 하는" 조용한
  실패가 된다 — 여러 harness를 섞어 쓸수록 launchd 환경에 빠뜨리기 쉬운 이름이 늘어난다는
  뜻이니, plist의 `PATH`에는 실제로 쓰는 harness 전부와 `avcs`가 있는 디렉터리를 넣는다.
- **`chmod 600`.** PAT가 plist에 평문으로 담긴다.

`KeepAlive`와 함께 `ThrottleInterval 10`을 둔다 — 즉시 재시작을 반복하면 CPU를 태운다.

붙인 뒤 **반드시 죽여서 확인한다**: `kill -9 <PID>` → `launchctl list`의 PID가 바뀌고
로그에 재접속이 찍히는지. 감독이 붙었다는 것과 감독이 동작한다는 것은 다른 사실이다.

리눅스는 같은 내용의 systemd 유닛(`Restart=always`, `RestartSec=10`,
`Environment=PATH=...`)으로 대체한다.

## 9. 클라이언트 주소가 보이지 않는다 (compose 기본 배포)

실측(2026-09-01): 감사 로그의 `ip` 가 전부 `192.168.65.1` 이었다 — **Docker 브리지 게이트웨이**다.
컨테이너 안에서는 모든 요청이 그 주소로 보이므로 실제 클라이언트 주소가 없다. 그 결과 둘이 생긴다.

| 무엇 | 지금 상태 |
|---|---|
| **레이트 리밋** | `req.ip` 로 키를 만드는데 그 값이 항상 같다 → **모든 클라이언트가 버킷 하나를 공유한다.** 한 사람이 로그인을 20번 실패하면 다른 사람도 5분간 막힌다 |
| **감사 로그 `ip`** | 전부 같은 값이라 정보가 없다. "어디서 들어왔나" 를 답하지 못한다 |

사용자가 한 명인 도그푸딩에서는 실질 영향이 없지만, **사람이 늘면 조용히 문제가 된다** —
설정값은 그대로인데 실제 방어와 기록이 다르게 동작하고, 어디에도 경고가 뜨지 않는다.

**고치는 방법**: 앞단에 리버스 프록시를 두고 `TRUST_PROXY=1` 을 켠다. 그러면 `X-Forwarded-For`
를 클라이언트 주소로 받아들여 리밋이 클라이언트별로 걸리고 감사 로그에 실제 주소가 남는다.

**프록시가 없는데 켜지 말 것.** 켜면 누구나 헤더를 위조해 리밋을 무한히 우회한다(요청마다
다른 값을 보내면 매번 새 버킷이다). 기본값이 끔인 이유이고, 끈 상태에서 헤더가 무시되는 것은
테스트로 고정돼 있다(`trustProxy.test.ts`).

macOS·Windows 의 Docker Desktop 에서는 프록시 없이 실제 주소를 보는 방법이 없다(포트 게시가
주소를 다시 쓴다). Linux 에서는 `network_mode: host` 로 우회할 수 있지만 포트 격리를 잃는다.

## 10. 아직 없는 것

- **자동화**: cron/타이머가 없다. 위 명령을 손으로 돌린다.
- **오프사이트 사본**: 덤프가 같은 호스트에 남는다. 호스트를 잃으면 백업도 잃는다.
- **PITR**: WAL 아카이빙이 없다. 복구 지점은 마지막 덤프뿐이다.
- **보존 정책**: 오래된 덤프를 지우는 규칙이 없다.

## 11. 비밀번호 복구

비밀번호를 분실한 경우 두 가지 복구 경로가 있다.

### 10-1. 자기 계정의 비밀번호 변경 (로그인 가능한 경우)

로그인한 사용자는 `POST /auth/password` 로 비밀번호를 변경할 수 있다.
현재 비밀번호를 함께 제출해야 하며, 변경 시 **다른 기기의 세션은 모두 무효화**된다.
이것은 비밀번호 변경의 흔한 이유가 "털린 것 같다"이기 때문이다.
현재 세션은 유지되어 사용자가 다시 로그인하지 않아도 된다.

### 10-2. 관리자 계정의 비밀번호 재설정 (로그인 불가능한 경우)

관리자가 비밀번호를 잊어버렸거나 잠긴 경우, 서버 호스트에서 운영 도구를 사용한다.

**사전 조건**: `DATABASE_URL` 환경변수가 설정되어 있어야 한다.

```bash
# 비밀번호는 argv 로 전달하지 않는다 — `ps` 로 다른 로컬 사용자에게 보인다.
# 셸 히스토리에도 남으니 필요하면 앞에 공백을 두거나 히스토리를 끄고 실행한다.
MURMUR_NEW_PASSWORD=<새 비밀번호> DATABASE_URL=<...> \
  pnpm --filter @murmur/server exec tsx scripts/reset-password.ts <handle>
```

이 도구는 다음을 수행한다:

- 해당 계정의 비밀번호를 새 값으로 변경
- **모든 세션을 삭제** (잠긴 상황을 푸는 도구이므로 옛 세션이 살아 있으면 안 된다)
- 감사 로그에 `password.changed` 행을 남김 (`via: operational_tool`). **actor 는 비어 있다** —
  이 도구를 누가 돌렸는지 서버는 알 수 없고, 모르는 것을 아는 척하지 않는다.

**이메일 컬럼이 없는 이유**: 이 저장소는 사람 계정에 이메일 컬럼이 설계상 없다.
그래서 비밀번호 재설정 링크를 이메일로 보내는 self-serve 복구는 불가능하다.
필요하면 운영자가 이 도구를 사용해야 한다. 백업·계정 정책을 세울 때 이 제약을
고려해야 한다.
