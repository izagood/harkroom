# 모바일 클라이언트 — Flutter, 메신저 한 벌

`origin/main` v0.2.18 (`bd5df1e`) 기준. 2026-09-21 스레드에서 합의한 것을 적는다.

## 1. 무엇을 만드나

**폰에서 harkroom 을 메신저처럼 쓰고, 그 안에서 다른 머신에서 도는 에이전트를 부른다.**

한 문장에 두 가지가 들어 있고 둘 다 중요하다.

- **메신저처럼** — 채널·스레드·말풍선·읽음·리액션. 데스크탑의 3컬럼 관제탑이 아니다.
- **다른 머신에서 도는** — 폰은 에이전트를 **돌리지 않는다.** 호출하고 결과를 본다.

### 명시적 비목표

| 안 만드는 것 | 왜 |
|---|---|
| 터미널 패널 | 폰에서 PTY 를 읽는 것은 메신저가 아니다. 서버 경유라 기술적으로는 가능하지만(`/agent-sessions/{id}/attach`) 이번 범위 밖이다 |
| 러너 제어 (spawn·kill·목록) | `daemon_spawn_runner` 계열은 "이 기계에서 돌린다"는 일이다. 폰에 그 기계가 없다 |
| Claude 계정 로그인 / 오퍼레이터 등록 | 같은 이유. 그 자격증명은 에이전트를 돌리는 기계에 있다 |
| 푸시 알림 | 다음 단계. 서버에 발송 경로가 **아예 없다**(§8) |
| Android | 다음 단계. 이 맥에 SDK 도 없다 |
| 데스크탑을 Flutter 로 옮기기 | 하지 않는다. §3 |

**모바일은 오퍼레이터가 아니라 대화 클라이언트다.** 이 한 줄이 화면 설계의 축이다 —
애매할 때마다 여기로 돌아온다.

## 2. 결정된 것 (jaebin, 2026-09-21)

| # | 물음 | 답 |
|---|---|---|
| 1 | Flutter 의 자리 | 저장소 루트에 `mobile/` 을 새로 만들고 **모바일 전용 두 번째 클라이언트**. 데스크탑은 Tauri+React 그대로 |
| 2 | 범위 | "에이전트를 호출해서 쓰는 정도" + **메신저 같은 느낌**. 터미널 없음 |
| 3 | 푸시 | 다음에 |
| 4 | 타겟·배포 | **iOS 먼저, TestFlight 까지** |
| 5 | 타입 동기화 | (a) 필요한 것만 **수기 Dart 모델** + 테스트로 방어 |

## 3. 왜 `mobile/` 이 `packages/` 밖인가

`pnpm-workspace.yaml` 의 `packages: [packages/*]` 가 그 디렉터리를 워크스페이스 멤버로
빨아들인다. Flutter 패키지에는 `package.json` 이 없으므로 pnpm 이 무시하기는 하지만,
**같은 이름의 두 규약이 한 디렉터리에 겹치는 것 자체가 함정이다** — `pnpm -r test` 가
mobile 을 건너뛰는 것이 우연이 되고, 어느 날 누가 `packages/mobile/package.json` 을
만들면 조용히 워크스페이스에 들어온다.

루트에 두면 경계가 눈에 보인다: `packages/` 는 pnpm·TypeScript, `mobile/` 은 pub·Dart.
`pnpm-workspace.yaml` 을 **고치지 않는다** — 고칠 필요가 없다는 것이 이 배치의 근거다.

```
harkroom/
  packages/        # pnpm 워크스페이스 (shared·server·desktop·agent·daemon)
  mobile/          # Flutter 앱 — pub 이 관리한다. pnpm 이 모른다
    lib/
    ios/
    test/
    pubspec.yaml
```

## 4. 붙는 표면 — 코드로 확인한 것

| 사실 | 근거 |
|---|---|
| REST 약 80개, 전부 JSON + `Authorization: Bearer <token>` | `packages/desktop/src/lib/api.ts` |
| 실시간은 `/ws` 하나. 접속마다 **단기 1회용 티켓**(`POST /ws-ticket`) | `packages/desktop/src/lib/ws.ts` |
| **서버를 고치지 않아도 네이티브가 붙는다** | WS 핸드셰이크의 origin 검사가 `!origin` 이면 통과(`packages/server/src/ws/socketLifetime.ts:26`). 네이티브 Dart 클라이언트는 `Origin` 헤더를 보내지 않는다. CORS 기본값도 `true`(`buildServer.ts:288`) |
| 실시간 이벤트는 태그 유니온 `WsServerEvent` 30종 가까이 | `packages/shared/src/index.ts:2162` |
| 에이전트 호출 = **멘션이 든 메시지를 올리는 것** | 새 엔드포인트가 필요 없다. `POST /channels/{id}/messages` 하나 |

### iOS 에서 막히는 것 하나 — ATS

iOS 는 기본적으로 평문 `http://`·`ws://` 를 **막는다**(App Transport Security). 자체
호스트 서버가 LAN IP 나 평문 HTTP 로 떠 있으면 앱은 "연결 실패" 만 말하고 이유를 못 댄다.

- 원칙: **서버를 HTTPS 로 둔다.** 이것이 맞는 길이다.
- 개발 중에만: `ios/Runner/Info.plist` 에 `NSAllowsLocalNetworking` 을 켠다(LAN 한정).
  `NSAllowsArbitraryLoads` 는 **켜지 않는다** — TestFlight 심사에서 사유를 요구받고,
  무엇보다 폰이 밖에서 평문으로 토큰을 흘리게 된다.
- 연결 화면은 `http://` 주소를 받으면 **저장하기 전에 말한다**: "iOS 는 평문 연결을 막는다".
  조용히 실패하지 않는 것이 이 항목의 전부다.

## 5. 단계

각 단계의 "끝났다" 는 **화면에서 확인할 수 있는 한 문장**으로 적는다.

### P0 — 붙는다 (서버 무변경)

Flutter 스켈레톤, 연결·로그인, 커뮤니티 보관, 채널 목록, 메시지 읽기, WS 실시간 반영.

- 저장: `flutter_secure_storage`(iOS Keychain). 데스크탑의 판단을 그대로 베낀다 —
  **키는 계정 id, URL 이 아니다**(`lib/session.ts` 주석: 같은 서버가 여러 URL 로 닿으면
  URL 키는 같은 커뮤니티를 목록에 두 번 세운다). 저장 실패 시 **평문으로 내려가지 않고**
  사람에게 알린다(#212 의 결정).
- WS: `ws.ts` 의 상태 기계를 그대로 옮긴다 — 지수 백오프(1s→15s), 티켓 401/403 과 close
  `4401`·`4403` 은 **재시도하지 않고 포기**, 그 외는 네트워크로 보고 재시도. 이 구분이
  없으면 폐기된 세션이 영원히 재접속을 돈다.
- **끝났다**: 폰에서 로그인해 채널을 열고, 데스크탑에서 친 말이 **새로고침 없이** 폰에 뜬다.

### P1 — 메신저가 된다

스레드, 작성, **멘션 자동완성**, 리액션, 읽음 위치, 첨부 보기, inbox.

- 멘션 자동완성은 **서버의 멘션 판정과 같은 규칙**을 읽어야 한다. 서버는 인용 줄(`>`)과
  코드 블록 안의 `@handle` 을 부르지 않는다(#298·#592). 규칙이 갈라지면 **강조되지 않은
  것이 몰래 에이전트를 깨우거나, 강조된 것이 아무도 안 깨운다.**

  지금은 `mentionScanText`·`MENTION_PATTERN`·`splitCode` 가 **`@harkroom/shared` 에
  한 벌로 있고** 서버와 데스크탑이 그 하나를 함께 읽는다. Dart 는 **세 번째 사본**이 된다 —
  공유가 막아 주던 것이 여기서 처음 뚫린다. 그래서 이 함수만큼은 시험을 사본이 아니라
  **표**로 쓴다: 같은 입력/기대 쌍을 `mobile/test/` 와 TS 쪽이 같은 JSON 에서 읽는다(§7).
- 첨부는 보기만 — 이미지 미리보기 + 내려받기. 올리기는 P2.
- **끝났다**: 폰에서 `@agent 이거 해 줘` 를 치면 그 머신의 에이전트가 깨어나고, 답이 폰에 뜬다.

### P2 — 에이전트의 말을 제대로 읽는다

`MessageRow.kind` 와 `meta` 가 이미 형식을 갖고 있다. 평문으로 흘리면 폰에서만 정보가 준다.

| 무엇 | 모바일에서 |
|---|---|
| `meta.kind === 'ask'` | **선택지 버튼.** 눌러서 답한다(`POST /channels/{c}/messages/{m}/ask-answer`) |
| `kind === 'progress'` | 말풍선이 아니라 **한 줄 상태**로 접는다(데스크탑 `ProgressRow` 와 같은 판단) |
| `kind === 'wake'` | **대기 줄** — `meta.wake.wakeAt` 을 폰의 시간대로 읽는다 |
| `meta.kind === 'report'` | `checks`/`files`/`remaining` 카드. `checks` 가 비면 카드를 그리지 않고 본문만 |
| `meta.kind === 'failure'` | 실패 카드 |
| 첨부 올리기 | 사진·파일 |

**`ask` 답하기는 P2 로 미룰 수 없다는 의견을 적어 둔다.** 에이전트는 갈림길에서 묻고, 답이
없으면 **그 턴은 거기서 멈춘다**(`isAskOpen`). 답할 수 없는 모바일에서 에이전트를 부르면
"불렀는데 조용한" 상태가 정상이 된다 — P1 의 "에이전트를 호출해서 쓴다"가 반쪽이 된다.
**제안: `ask` 답하기만 P1 로 끌어올린다.** 나머지 카드는 P2 그대로.

- **끝났다**: 에이전트가 폰에서 물어보고, 폰에서 고른 답으로 그 턴이 이어진다.

### P3 — TestFlight

서명·번들 id·App Store Connect. §9.

### 범위 밖 (다음에)

푸시(§8), Android, 터미널.

## 6. 화면 — 메신저 모양

데스크탑의 3컬럼(레일·사이드바·채널)을 폰에 접지 않는다. 접으면 셋 다 좁아진다.

```
[커뮤니티/채널 목록]  →  [채널]  →  [스레드]
        ↑ 탭: 채널 · 받은 것(inbox) · 나
```

- 루트는 **탭 3개**: 채널 · 받은 것 · 나(프로필·연결·설정).
- 채널 → 스레드는 **화면 밀어 넣기**(push). 데스크탑처럼 옆 패널로 열지 않는다.
- 스레드 요약 줄은 데스크탑이 이미 서버에서 받는 재료를 쓴다 — `replyCount`,
  `activityCount`, `openAskHumanCount`, `openAskAccountIds`, `lastReplyAt`.
  **판정은 클라이언트가 한다**(`threadState()` 와 같은 선: 서버는 사실만 싣는다).
- 설정 화면에는 **데스크탑 설정의 대부분이 없다**. 있는 것: 프로필·상태·연결한 커뮤니티·
  알림(P3 이후)·언어. 없는 것: 에이전트 등록, Claude 계정, 오퍼레이터, MCP, 스킬.
  **없는 것을 회색으로 그리지 않는다** — 폰에서 할 수 없는 일이지 잠긴 일이 아니다.

## 7. Dart 모델 — 수기, 그리고 갈라짐을 어떻게 막나

결정 5 는 (a) 수기다. P0 에 필요한 타입은 10개 남짓이다: `MeView` `AccountView`
`ChannelRow` `MessageRow` `AttachmentRow` `ReactionRow` `InboxEntry` `WsServerEvent`
(필요한 갈래만) `AskMeta` `WakeMeta`.

수기의 값은 빠르다는 것이고, 값은 **서버가 바뀌면 모른다**는 것이다. 그래서 방어를 둘 둔다.

1. **모르는 필드·모르는 태그는 버리지 않고 견딘다.** `WsServerEvent` 는 태그 유니온이니
   Dart 에서 모르는 `type` 은 **무시하고 로그만** 남긴다(끊지 않는다). `meta` 는
   `Map<String, dynamic>` 으로 들고 있다가 아는 `kind` 만 읽는다 — 데스크탑이 정한
   *"모르는 `meta` 는 평문으로 흘린다"* 와 같은 규약이다.
2. **골든 테스트.** `mobile/test/golden/` 에 실제 서버 응답 JSON 을 박아 두고 파서를
   건다. 서버가 필드를 바꾸면 이 시험이 먼저 빨개진다 — 사람이 앱에서 발견하기 전에.

갈라지기 시작하면(= 골든이 자주 깨지면) 그때 서버에 OpenAPI 를 붙이고 생성으로 간다.
**지금 하지 않는 이유**: 서버 라우트가 zod 로 되어 있어 스키마 노출 자체가 별도 작업이고,
P0 에서 그것을 하면 모바일이 한 화면도 못 띄운 채 서버 PR 부터 나간다.

## 8. 푸시가 없다는 사실 (다음 단계지만 지금 적는다)

서버에 APNs·FCM·web-push 흔적이 **하나도 없다**. 데스크탑은 앱이 떠 있는 동안 WS 이벤트를
받아 OS 알림을 띄우는 구조이고, **폰은 백그라운드에서 WS 가 살지 않는다.**

그래서 P0~P2 의 앱은 **열어야 보이는 물건**이다. 이것은 결함이 아니라 이번 범위의 정의이고,
사람이 그것을 알고 쓰는 것과 모르고 쓰는 것은 다르다 — 첫 실행에 한 번 말한다.

푸시를 넣을 때 필요한 것(미리 적어 둔다): 디바이스 토큰 테이블, 발송 경로, APNs 인증 키,
"어떤 이벤트가 알림이 되는가" 의 규칙(= inbox 에 행이 생길 때). 전부 서버 작업이다.

## 9. CI 와 TestFlight

### CI

`.github/workflows/mobile.yml` 을 **따로** 만든다. `ci.yml` 에 잡을 더하지 않는다 —
`ci.yml` 은 모든 PR 에서 돌고, 서버 PR 마다 Flutter 를 받아 올 이유가 없다.

```yaml
on:
  pull_request:
    paths: ['mobile/**', '.github/workflows/mobile.yml']
```

- `flutter analyze` + `flutter test` 는 ubuntu 에서 돈다(빠르고 싸다).
- `flutter build ios --no-codesign` 은 macOS 러너다. macOS 는 과금 배수가 붙으므로
  `paths` 필터가 있는 이 워크플로 안에만 둔다.
- 액션은 **40자 SHA 로 핀한다** — 이 저장소의 규약이다(`ci.yml` 상단 주석).

### TestFlight — 내가 못 하는 것

아래는 사람의 계정과 결정이 필요하다. 코드로 대신할 수 없다.

| 필요한 것 | 누가 |
|---|---|
| Apple Developer Program 등록 | jaebin |
| 번들 id 확정 (예: `com.<도메인>.harkroom`) | jaebin — 한 번 정하면 못 바꾼다 |
| App Store Connect 앱 레코드 | jaebin |
| 서명 인증서·프로비저닝 | jaebin (또는 Xcode 자동 서명) |
| 배포 자동화(fastlane·API 키) | 이건 내가 짠다. 단, 비밀은 GitHub Secrets 에 |

**저장소는 공개다.** 인증서·키·프로비저닝 파일은 절대 커밋하지 않는다. `mobile/.gitignore`
에 `ios/Runner.xcworkspace/xcuserdata/`, `*.mobileprovision`, `*.p8`, `*.p12` 를 넣는다.

## 10. 열린 것

1. **`ask` 답하기를 P1 로 올릴 것인가** (§5 의 제안). 내 의견은 올린다.
2. **언어.** 데스크탑은 `i18n/{en,ko}.ts` 로 en 이 원본이다. 모바일도 처음부터 두 벌로
   갈 것인가, 한국어 한 벌로 시작할 것인가. 나중에 키로 바꾸는 것은 비싸다 —
   **처음부터 키로 가는 것**을 권한다(번역은 ko 만 채워도 된다).
3. **서버 주소.** 개발·시험에 어느 서버를 붙일지. HTTPS 인지(§4 의 ATS).
