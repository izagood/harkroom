# 투영 URL 을 앱에서 켠다 — avcs base URL 을 설정 가능하게

`#537` 후속. 그 이슈는 투영 고장에서 설정으로 가는 문을 고치고 `Connection › Projection`
행을 세웠다. 그 행은 **읽기만 한다** — 켜려면 여전히 VM 에 붙어 `AVCS_BASE_URL` 을 넣고
서버를 재시작해야 한다. 고칠 곳을 정확히 가리키는데 거기서 고칠 수 없다.

실측(2026-09-07, v0.1.21 설치본): `http://<host>:3400` 의 Projection
행이 `투영이 설정되지 않았다 · AVCS_BASE_URL 로 켠다`.

## 0. 결정 (브레인스토밍 2026-09-07)

| 결정 | 근거 |
|---|---|
| **즉시 적용(핫 스왑)** | 재시작을 요구하면 "앱에서 켠다"가 반만 참이다 |
| **env 는 기본값, 앱(DB)이 덮어쓴다.** 출처를 화면에 적고, 지우면 env 로 복귀 | 출처를 안 적으면 "왜 내 env 가 안 먹나"를 화면에서 알 수 없다 |
| **읽기·쓰기 모두 `requireAdmin`** | `/settings/agent-defaults` 선례. 상태(`requireAccount`)와 설정은 다른 표면이다 |
| **저장 전 probe 없음** | 틀린 URL 은 이미 `stalled` + `lastError` 로 정확히 나온다. probe 는 "무엇을 성공으로 볼지" 판정을 하나 더 만든다 |
| **SSRF 차단 목록 없음, 감사 로그로 남긴다** | 이 워크스페이스의 admin 은 이미 셸을 돌리는 에이전트를 만든다. 새 권한이 아니다 |

## 1. 구조 — `ProjectionSupervisor` (신규 모듈)

지금 `worker` 는 `main.ts:19-26` 에서 **부팅 시 한 번** 만들어지고 끝난다. 그 가변성을
담을 자리가 없다. 새 모듈이 워커를 **최대 하나** 쥔다.

```ts
// packages/server/src/avcs/supervisor.ts
export class ProjectionSupervisor {
  status(): ProjectionWorkerStatus;        // 워커 없으면 DISABLED_PROJECTION_STATUS
  reconfigure(url: string | null): Promise<void>;
  stop(): Promise<void>;                   // SIGTERM 경로. 여기서는 기다린다
}
```

- **`ProjectionWorker` 를 손대지 않는다.** "워커가 있다 = `configured`" 라는 그 파일의
  불변식(`projection.ts:66-69`)이 그대로 산다
- **`main.ts` 가 아니라 별 모듈인 이유:** 그 파일은 최상위 await 로 서버를 띄우는
  스크립트라 임포트만으로 포트를 잡는다 — 그 안의 판정은 시험할 수 없다. 같은 이유로
  `warnIfProjectionDisabled` 가 이미 빠져 있다
- 같은 URL 이면 **교체하지 않는다.** 교체하면 커서·long-poll 이 다시 걸려, 아무것도
  바꾸지 않은 저장이 폴링을 한 번 끊는다
- 동시 저장은 프로미스 체인으로 직렬화한다 (`this.chain = this.chain.then(...)`)

접근안 B(`main.ts` 에 콜백)는 생명주기 판정이 시험 불가한 자리에 남고, C(워커 자체를
재설정 가능하게)는 위 불변식을 뒤집어 변경 반경이 더 크다.

## 2. 정지를 기다리지 않는다

**제약:** `stop()` 은 루프를 await 하고, 루프는 `waitForChange(…, pollMs)` 에 걸려 있다
(`pollMs = 25_000`, `projection.ts:176`). 실패 사이클이면 백오프가 최대 `60_000`
(`projection.ts:232`). **`await stop()` 은 최악 85 초 블록**되므로 PUT 핸들러가 기다릴
수 없다.

**해법:** 옛 워커에 정지 신호만 보내고(`void old.stop()`) 새 워커를 바로 세운다.

**겹침이 안전한 근거는 이미 코드에 있다.** `runOnce` 가 커서를 `for update` 로 잠그고
`currentSince !== since` 면 배치를 폐기한다(`projection.ts:118-124`) — 그 주석이 "다른
실행이 이미 커서를 전진시켰다"를 이미 다루는 사정으로 적어 뒀다. 옛 워커가 자기
`this.runtime` 에 쓰는 것도 무해하다: `status()` 는 supervisor 가 쥔 **새** 워커에게 묻는다.

**대가:** 재설정 직후 최대 85 초간 옛 루프가 하나 더 산다. 없애려면 `waitForChange` 에
`AbortSignal` 을 넣어야 하고 그것은 `AvcsServerClient` 계약 변경이다(§8).

## 3. 판정 한 벌 — `resolveProjectionUrl` (shared)

```ts
export type ProjectionUrlSource = 'app' | 'env';

export function resolveProjectionUrl(envUrl: string | null, appUrl: string | null): {
  url: string | null;
  /** url 이 null 이면 source 도 null — 출처 없는 값에 출처를 붙이지 않는다. */
  source: ProjectionUrlSource | null;
} {
  if (appUrl) return { url: appUrl, source: 'app' };
  if (envUrl) return { url: envUrl, source: 'env' };
  return { url: null, source: null };
}
```

`shared` 에 두는 이유는 `projectionState` 와 같다: 판정이 양쪽에 살면 화면과 API 가 같은
상태를 다른 말로 부른다.

## 4. DB — `041_projection_config.sql`

```sql
create table projection_config (
  id boolean primary key default true check (id),
  -- null 이면 '앱에서 정한 것이 없다' → env 로 떨어진다.
  -- 빈 문자열을 '없음'으로 쓰지 않는다: 지우기와 오타 저장이 같은 값이 된다.
  avcs_base_url text check (avcs_base_url is null or length(avcs_base_url) > 0)
);
insert into projection_config (id) values (true);
```

`id boolean primary key check (id)` 는 `017_agent_defaults.sql` 관용구. 행이 둘이면
"투영 URL 이 무엇인가"에 답이 둘이 된다. 확인 시점 원격 브랜치에 `041` 이상은 없다.

## 4-1. 투영 상태는 (서버, repo)에 속한다

`projection_cursor`·`active_lease` 는 `repo` 하나가 아니라 `(repo, avcs_base_url)` 로
키가 잡힌다(`042_projection_state_per_server.sql`) — 로그 인덱스는 그 로그에 상대적이다.
핫 스왑으로 URL 이 바뀌면 새 워커는 새 서버 아래의 자기 행을 보고, 옛 서버의 커서·리스는
그대로 남는다.

## 5. API

```
GET /settings/projection      requireAdmin
  200 { url, source: 'app'|'env'|null, appUrl, envUrl }

PUT /settings/projection      requireAdmin
  { url: string | null }      // null = 지우기 → env 복귀
  200  (GET 과 같은 모양)
  400  invalid_request
```

- **`appUrl`·`envUrl` 을 둘 다 준다** — 지우기가 무엇으로 복귀하는지 화면이 말해야 한다
- **`url: null` 이 지우기다.** 키를 빼는 것으로 표현하면 `JSON.stringify` 가 `undefined` 를
  버리는 것과 구분되지 않아 지우기가 '손대지 않음'으로 조용히 바뀐다
- 검증: `z.string().url().max(512)` + 프로토콜 `http:`/`https:`. `url()` 만으로는 `file:` 이
  통과한다. 후행 슬래시는 정규화하지 않는다 — `client.ts:162` 가 이미 자른다
- **`/projection/status` 는 안 바꾼다.** `requireAccount` 표면이라 URL 을 실으면 인프라
  설정이 전원에게 나간다

**`buildServer` 는 supervisor 클래스를 알지 않는다.** 라우트가 필요한 것은 둘뿐이다:

```ts
projection?: { envBaseUrl: string | null; reconfigure(url: string | null): Promise<void> };
```

`?` 인 이유: 이 표면 없이 서버를 띄우는 기존 테스트가 많다. 없으면 두 라우트를 등록하지
않는다 — 등록해 두고 500 을 내는 것보다 **404 가 정직하다**.

## 6. 화면 — `Connection › Projection`

```
Projection    izagood/murmur · 투영이 돌고 있다
              출처: 앱에서 설정               [편집]  [지우기]
```

- 상태 줄(`ProjectionRow`)은 그대로 `/projection/status` 를 읽는다. 출처·편집 줄은
  `/settings/projection` 을 읽는 **별 조각**이다 — 두 사실의 출처가 다르다
- **비-admin 에게는 출처·편집 줄을 그리지 않는다.** `AgentDefaultsSettings` 의
  `if (!isAdmin) return;` 과 같다 — 403 을 오류로 그리면 잘못 없는 화면에 붉은 글이 뜬다
- 세 상태를 구별한다: `null`(안 읽음) / `'error'`(못 읽음) / 값
- **저장 후 투영 상태를 직접 다시 읽는다.** 데스크탑은 60 초 주기로 갱신하므로
  (`controller.ts:166-168`) 그 주기에 맡기면 방금 켠 투영이 최대 1 분간 꺼진 것처럼
  보이고 사용자는 저장이 실패했다고 읽는다. 재조회는 `Controller` 의 공개 메서드로 낸다 —
  컴포넌트가 `api.projectionStatus()` 를 직접 부르면 `refreshProjectionStatus` 가 지키는
  규칙(**실패를 삼키지 않는다**, `controller.ts:212-217`)을 한 벌 더 적게 된다
- 워커는 사이클 맨 위에서 `lastPolledAt` 을 찍으므로(`projection.ts:190`) 재조회 시점에
  이미 답이 나온다 — 정상이면 `ok`, URL 이 틀렸으면 첫 실패의 `lastError`

**`PROJECTION_UNCONFIGURED_DETAIL`** 은 `'AVCS_BASE_URL 로 켠다'` → `'앱 설정이나
AVCS_BASE_URL 로 켠다'`. 앱에서 켤 수 있게 되면 그 문장이 유일한 방법을 말하지 않는다.
이 상수는 MCP `work.link` 응답도 쓴다.

## 7. 파일별 변경 지점

| 파일 | 변경 |
|---|---|
| `shared/src/index.ts` | `resolveProjectionUrl` + 타입. `ProjectionRuntime.configured` 주석 갱신. `PROJECTION_UNCONFIGURED_DETAIL` 문구 |
| `server/db/migrations/041_projection_config.sql` | 신규 |
| `server/services/projectionConfig.ts` | 신규 — `get`·`set` |
| `server/avcs/supervisor.ts` | 신규 — `ProjectionSupervisor` |
| `server/routes/settingsRoutes.ts` | `GET`·`PUT /settings/projection` + `recordAudit('projection.url.updated')` |
| `server/buildServer.ts` | `ServerDeps.projection` 추가 |
| `server/main.ts` | `let worker` → supervisor. 부팅 시 `resolveProjectionUrl(env, db)` |
| `desktop/lib/api.ts` | `projectionConfig()`·`setProjectionConfig(url)` |
| `desktop/state/controller.ts` | 투영 상태 재조회 공개 메서드 |
| `desktop/components/settings/ConnectionSettings.tsx` | 출처·편집 줄 |

## 8. 테스트

**shared** — 앱 값이 env 를 이긴다 / 앱 없으면 env / 둘 다 없으면 `source: null`

**supervisor** (가짜 워커 주입)
- URL 있으면 워커를 세운다 / 없으면 `DISABLED_PROJECTION_STATUS`
- `reconfigure(null)` → 워커가 사라진다
- `reconfigure(같은 URL)` → **같은 인스턴스가 남는다**
- **정지를 기다리지 않는다** — `stop()` 이 영원히 안 끝나는 가짜를 줘도 새 워커가 선다.
  이 회귀선이 §2 의 85 초를 지킨다
- 동시 `reconfigure` 두 번 → 교체된 워커는 하나
- `stop()` 은 기다린다 — SIGTERM 이 워커를 남기지 않는다

**라우트** — 비-admin 403 / `ftp://` 400 / 잘못된 URL 400 / `null` 은 지우기 /
성공 시 `reconfigure` 가 그 URL 로 불린다 / 감사에 `before`·`after` /
`deps.projection` 없으면 404

**데스크탑** — 비-admin 에게 편집 줄 없음(403 을 붉은 글로 그리지 않는다) / 세 상태 구별 /
출처를 `env`·`app` 다른 말로 적는다 / 지우기는 `null` /
**저장 후 투영 상태를 다시 읽는다**(§6)

## 9. 성공 기준

VM 에 붙지 않고, 설치본 앱 `설정 › Connection` 에서 URL 을 넣어 Projection 행이
`izagood/murmur · 투영이 돌고 있다` 로 바뀐다. 서버 재시작 없이. `[지우기]` 로 env 복귀도
같은 자리에서.

## 10. 하지 않는 것

- **probe·자동 롤백** / **SSRF 차단 목록** — 결정 4·5
- **앱에서 서버 재시작** — 핫 스왑이 그것을 불필요하게 만드는 것이 요점이다
- **avcs 인증 토큰** — `httpAvcsClient(baseUrl)` 은 토큰을 쓰지 않는다(`client.ts:161`).
  필요해지면 `AvcsServerClient` 계약 변경이라 별 작업
- **`stop()` 인터럽트** — §2 의 85 초 겹침을 없애지만 커서 락이 이미 정확성을 지킨다
- **repo 바인딩 UI** — repo 목록은 계속 채널 바인딩에서 온다(`listBoundRepos`)
