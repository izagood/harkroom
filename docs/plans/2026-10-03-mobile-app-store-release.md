# 모바일 App Store 정식 배포 — TestFlight 다음

`origin/main` v0.3.177 (`27054263`) 기준. [모바일 계획서](2026-09-22-mobile-flutter.md)의
마지막 단계(P3 TestFlight)를 잇는다. 지금은 main 에 앱 코드가 머지될 때마다
`.github/workflows/testflight.yml` 이 **내부 테스트까지** 자동으로 올린다(#1005).

**이 문서는 계획이다. 코드는 없다.** jaebin 승인 뒤 §6 의 단계를 하나씩 따로 PR 로 넘긴다.
검토: §3 스토어 등록물 — designer, §2 개인정보·§4 심사 계정 — security. 두 검토 의견(2026-10-03)을
반영했다 — 보안 조건은 **SEC-n**, 디자인 의견은 **DSN-n** 으로 적고, 구현 PR 은 이 번호로 대조받는다.

## 1. 한 문장

**외부 사람이 App Store 에서 받아, 자기 워크스페이스 서버 주소를 넣고 로그인해 쓰는 앱**을
낸다. 심사관은 우리가 주는 **데모 서버·계정**으로만 앱을 볼 수 있다 — 이 점이 심사의 축이다.

## 2. 출시를 막는 것 (blocker) — 소스로 확인

판정: ✅ 있음 · ⚠️ 일부 · ❌ 없음. "근거"는 이 커밋에서 직접 본 자리다.

| # | 지침 | 요구 | 지금 | 근거 | 할 일 |
|---|---|---|---|---|---|
| B1 | 1.2 사용자 생성 콘텐츠 | 불쾌한 콘텐츠 **신고** 수단 | ❌ | `apps/mobile/lib` 에 신고 UI·서버에 신고 라우트 없음 | 메시지 길게 누르기 → [신고]. 서버 `POST /messages/:id/report` + 관리자 큐(desktop) |
| B2 | 1.2 | 악용하는 사용자 **차단** | ❌ | 차단·뮤트 라우트 없음(`channelRoutes` 의 `prefs` 는 채널 단위) | 계정 차단(내 화면에서 그 사람 글·DM 숨김). 서버 `account_block` |
| B3 | 1.2 | 필터링·24시간 내 조치 약속, 연락처 | ❌ | — | 운영 문서 + 지원 URL 에 신고 처리 약속. 워크스페이스 관리자의 글 삭제·멤버 제거는 이미 있음(`DELETE /channels/:id/members/:accountId`) |
| B4 | 5.1.1(v) 계정 삭제 | 앱에서 계정을 만들면 앱 안에서 삭제 | ⚠️ | 앱은 **가입이 없다**(로그인만, `login_screen.dart`). 서버 `/auth/register` 는 있으나 앱이 안 부른다. 사람 계정 비활성화·삭제 라우트 **없음**(`disabled_at` 은 에이전트만, `accountRoutes.ts:473`) | 엄밀히는 비대상이지만 심사관이 자주 요구한다 → **[계정 삭제 요청]**을 넣는다(§2.1) |
| B5 | 5.1.1(i) 개인정보 처리방침 | 앱 안 + ASC 에 URL | ❌ | 앱에 링크 없음 | 정책 게시(jaebin) + 「나」 화면에 링크 |
| B6 | 5.1.2 / ASC | 개인정보 라벨(App Privacy) | ❌ | ASC 입력은 사람 몫 | §2.2 초안대로 입력 |
| B7 | 5.1.2 매니페스트 | `PrivacyInfo.xcprivacy` | ⚠️ | 있음(UserID·OtherUserContent·Photos, 추적 없음). **이름·메시지 본문·기기 토큰(푸시)·이메일일 수 있는 로그인 id** 가 빠져 있음 | §2.2 표 한 벌로 라벨과 함께 보강(SEC-6) + ITMS-91053 이 오면 required-reason 대응 |
| B8 | 수출 규정 | 암호화 신고 | ✅ | `ITSAppUsesNonExemptEncryption=false` (HTTPS·Keychain 만 — 면제) | 없음. ASC 질문에도 "면제" |
| B9 | 2.1 정보 완전성 | 심사용 데모 서버·계정 | ❌ | 서버 주소를 넣어야 시작하는 앱 | §4 — 심사 전용 테넌트 + 계정 + 데모 에이전트 |
| B10 | 4.7 / 1.2 AI 콘텐츠 | AI 생성 글임을 알아보게 | ⚠️ | 에이전트 글에 배지(`message_tile.dart:479` `t.agentBadge`) | 배지는 충분. 「나」·설명에 "에이전트 답은 AI 가 만든다" 한 줄 + 신고(B1)가 에이전트 글에도 |
| B11 | 2.1 / 4.2 최소 기능 | 앱만으로 쓸모 | ✅ | 메신저 기능 전부(S1~S7) | 데모 계정이 이걸 보여 줘야 함(B9) |
| B12 | 5.1.1(iv) 권한 문구 | 사진·카메라 사용 이유 | ✅ | `NSCameraUsageDescription`·`NSPhotoLibraryUsageDescription`, ko 현지화 | 없음 |
| B13 | 2.5.x 푸시 | 푸시를 필수로 걸지 않음 | ✅ | 「나」에서 켜고 끔(`pushTurnOn`) | Time Sensitive 사용 사유를 심사 메모에 |
| B14 | 2.3.x | iPad 지원 시 iPad 스크린샷·레이아웃 | ⚠️ | `TARGETED_DEVICE_FAMILY = "1,2"` | **결정 D1**: iPhone 전용으로 내리거나 iPad 13" 스크린샷까지 |
| B15 | 3.1 / 2.1 | 앱 밖 웹뷰가 결제·로그인 우회 아님 | ✅ | 미리보기 웹뷰는 같은 서버 서명 URL 만(`artifact_preview.dart`) | 없음 |

### 2.1 계정 삭제를 어떻게 넣나 (B4)

앱은 가입을 안 받고 워크스페이스 관리자가 초대한다. 계정의 주인은 **각 워크스페이스 서버**다.
그래서 "Harkroom 계정"이라는 하나가 없고, 커뮤니티마다 따로 있다.

「나 › 커뮤니티」 각 줄에 **[이 커뮤니티에서 계정 삭제]**. 서버 `DELETE /accounts/me`.

- **SEC-1 (필수) 막는 자리는 `deleted_at` 이다.** 세션 인증은 `deleted_at` 만 보고
  (`auth/plugin.ts:97` `a.deleted_at is null`), 로그인은 둘 다 안 본다(`authRoutes.ts:241`).
  `disabled_at` 만 찍으면 지운 계정이 다시 로그인된다. 그래서:
  - 삭제는 `deleted_at` + `disabled_at` 을 함께 찍는다(에이전트 삭제 `agents.ts:501` 과 같은 꼴).
  - 로그인 쿼리에 `deleted_at is null and disabled_at is null` 을 더한다.
  - 같은 트랜잭션에서 `session` 행 삭제(→ `push_device` 도 같이 정리) · 남은 PAT 폐기 · `password_hash = null`.
- **SEC-2 익명화 범위.** display_name, 아바타(**파일 바이트까지** 지운다 — 행만 지우면 안 된다),
  `login_id`(이메일일 수 있다 — 무작위 값으로 바꾼다), handle 은 `deleted-<id 앞 8자>` 로 바꾼다
  (재사용 방지는 유지하고 실명은 지운다). 본문은 `<@id>` 로 이름을 풀므로 과거 글은 깨지지 않는다.
- **SEC-3 재인증.** 비밀번호를 다시 받는다 — 세션 토큰 하나가 털려도 계정이 영영 사라지면 안 된다.
  앱은 확인을 한 번 더 받고, 성공하면 그 커뮤니티의 Keychain(세션·최근 찾은 말)을 기존 로그아웃 경로로 지운다.
- **SEC-4 (필수) 소유 에이전트가 있으면 거절한다.** 지우는 사람이 주인인 에이전트는 자기 PAT 로 계속 돈다.
  "먼저 넘기거나 지워라"고 이유를 돌려준다(같이 삭제하지 않는다). 마지막 관리자도 거절한다.
- **SEC-5 본문·첨부**는 워크스페이스 기록이므로 관리자 정책(남김/지움)을 따른다. **hosted(gate)에서
  우리가 운영자일 때의 기본값**(남김/지움, 보관 기간)은 처리방침 초안에서 정한다.

### 2.2 App Privacy 라벨 = PrivacyInfo 한 표 (SEC-6)

라벨(ASC 입력)과 `PrivacyInfo.xcprivacy` 를 **이 표 하나에서** 만든다 — 둘이 어긋나지 않게.
추적 없음. 전부 **앱 기능 · 사용자와 연결됨**. 진단 없음(pubspec 에 분석·크래시 SDK 없음).

| 데이터 | Apple 분류 | xcprivacy 키 | 지금 |
|---|---|---|---|
| 이름(display name) | Name | `NSPrivacyCollectedDataTypeName` | ❌ 추가 |
| 로그인 id(이메일일 수 있는 곳 — gate 가입) | Email Address | `NSPrivacyCollectedDataTypeEmailAddress` | ❌ 추가 |
| 사용자 id | User ID | `NSPrivacyCollectedDataTypeUserID` | ✅ |
| 메시지 본문 | Emails or Text Messages | `NSPrivacyCollectedDataTypeEmailsOrTextMessages` | ❌ 추가 |
| 첨부 파일 | Other User Content | `NSPrivacyCollectedDataTypeOtherUserContent` | ✅ |
| 사진 | Photos or Videos | `NSPrivacyCollectedDataTypePhotosorVideos` | ✅ |
| 푸시 기기 토큰 | Device ID(보수적으로) | `NSPrivacyCollectedDataTypeDeviceID` | ❌ 추가 |

데이터는 **사용자가 넣은 워크스페이스 서버**로만 간다 — 운영자가 우리(hosted, gate)인 경우와
자가 호스팅을 처리방침에서 나눈다.

## 3. 스토어 등록물 (designer 검토)

| 항목 | 안 | 비고 |
|---|---|---|
| 앱 이름 (30자) | Harkroom | ASC 레코드 이미 있음(Apple ID 6818047851). 상표 리스크는 옛 개명 논의 참고 |
| 부제 (30자) | en **"Team chat with AI agents"**(24자) / ko **"AI 에이전트와 함께 쓰는 팀 채팅"** | DSN-6: "agents" 하나로는 고객 상담원으로 읽힌다 |
| 설명 | 접기 전 첫 세 줄 안에 ko "Harkroom 커뮤니티(서버 주소)가 있어야 쓸 수 있습니다. 관리자에게 초대를 받거나 직접 서버를 여세요." / en "Requires a Harkroom community (server address). Get an invite from your admin, or host your own." — 심사 거절(2.1)·별점 방어 | DSN-4: 앱 UI 용어 "커뮤니티"(`connectTitle`)와 맞춘다 |
| 키워드 (100자) | en `ai,assistant,bot,automation,coding,devops,self-hosted,messenger,collaboration,inbox,thread` / ko `메신저,협업,에이전트,AI,봇,자동화,업무,스레드,인박스,셀프호스팅` | DSN-5: 이름·부제 낱말은 빼고 쉼표 뒤 공백 없이, 로케일마다. 타사 상표 없음(D3) |
| 홍보 문구 (170자) | 심사 없이 바꿀 수 있는 칸 — 릴리스마다 | |
| 스크린샷 | **6.9" iPhone(1320×2868) 세로만**(D1=iPhone 전용 전제, 아니면 iPad 13" 2064×2752 추가). 순서(검색엔 앞 3장만 보인다): ① 에이전트가 답하는 스레드 ② ask 카드 ③ 인박스 상태 보드 ④ 홈·채널 목록 ⑤ 에이전트 탭. 라이트 4 + 다크 1까지. 로그인·빈 화면 금지(2.3.3). 각 장 위 한 줄 제목 띠(D6) | DSN-1·2·3, 아래 §3.1 |
| 앱 미리보기 영상 | 안 함(1차) | |
| 아이콘 | `AppIcon.appiconset/Icon-App-1024x1024@1x.png` 1024px, 알파 없음 — 있음(원본 `assets/icon/AppIcon.svg`) | designer 확인 |
| 지원 URL | `<site>/support` (소개 사이트 #962 자리 결정과 묶임). **연락처(메일)와 B3 신고 처리 약속이 실제로 있어야 한다** — 빈 페이지는 거절 사유. en·ko 로케일마다 | DSN-9, 👤 |
| 마케팅 URL | `<site>` (소개 사이트) | 선택 |
| 개인정보 처리방침 URL | `<site>/privacy` | jaebin 게시 |
| 연령 등급 | 질문지 답으로 정해진다. 사용자 간 채팅(UGC)·AI 생성 답이 있으므로 새 체계(4+/9+/13+/16+/18+)에서 **13+ 또는 16+** 예상. 1.2 조치(B1~B3)가 전제 | 👤 질문지 |
| 카테고리 | 1차 Productivity, 2차 Business | |
| 가격·지역 | 무료, 인앱결제 없음. 지역은 전체(한국 포함) — 한국은 사업자 정보 공개 요구(전자상거래법) 확인 | jaebin |
| 저작권·판매자 | 판매자 이름은 **개발자 계정의 법적 이름**으로 나온다. "2026 Harkroom" 을 쓸 수 있는지는 계정 종류에 달렸다 | DSN-8, 👤 R0 |

### 3.1 스크린샷 찍는 법 (DSN-1·3)

- 기존 `integration_test/gallery_test.dart` 는 **개발용 고정 데이터**(내부 채널·에이전트 이름)라 그대로 찍으면
  내부 사정이 스토어에 보인다. 갤러리는 PR 전후 비교용이라 바꾸지 않는다.
  → **스토어 전용 `integration_test/store_screens_test.dart`** 를 따로 만든다: 지어낸 팀(예: "Northwind Studio"),
  가상 인물 3~4명, 일반 이름 에이전트(`@writer`·`@reviewer`), 서버 `team.example.com`. en·ko 로케일 고정으로 따로 찍는다.
- 시뮬레이터는 Pro Max 계열, 상태 표시줄 고정:
  `xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100`.
- 제목 띠(D6)는 designer 템플릿 + 저장소 스크립트로 합성한다. ASC 업로드는 D4 대로 손으로.

## 4. 심사용 데모 (security 검토)

**심사 테넌트는 자격이 공개된 것으로 간주하고 설계한다.** 심사 계정은 사실상 외부인 손에 들어간
계정이고, 데모 에이전트에게는 프롬프트 주입 경로다.

- **전용 테넌트** 하나(gate 로 생성, 예: `review` 커뮤니티). 프로덕션 테넌트와 DB·자격 분리.
- 계정 1개(사람, 일반 멤버). **관리자 아님 · 초대 발급 권한 없음**(남이 그 테넌트로 들어오는 길을 막는다).
- 비밀번호는 **제출마다 새로 발급하고 ASC 심사 메모를 갱신**한다(한 번 돌리고 끝내면 다음 업데이트 심사 때
  메모가 낡는다). 외부 TestFlight 베타 심사도 같은 계정을 쓴다. 비밀은 비밀 보관소에 둔다.
- 시드: 채널 2~3개 + 미리 쓴 대화. **가상 인물·가상 회사만** — 우리 운영 에이전트·실제 대화는 절대 섞지 않는다.
  스토어 스크린샷(§3.1)과 **같은 규칙**이다: 실제 handle·내부 채널 이름·실제 호스트 이름이 나오면 안 된다(서버 주소도 예시 도메인 꼴로).
- **데모 에이전트 1개**(심사관이 부르면 실제로 답해야 한다).
  - **SEC-7 (필수) jaebin 머신의 오퍼레이터에서 돌리지 않는다.** 같은 uid 면 에이전트가 operator 비밀
    (MCP OAuth 토큰·다른 에이전트의 MCP 헤더)을 읽을 수 있다. 격리된 원격 operator/컨테이너에서 돌린다.
  - 하네스 도구는 **harkroom 발화만** 허용한다(Bash·파일·웹·다른 MCP 없음). 지시문은 좁게.
  - 동시 턴 상한과 별도로 **일일 호출 수·비용 상한**을 둔다.
- 이 테넌트의 신고(B1)는 **우리 관리자 계정**(jaebin 이 정하는 운영 계정 하나)의 큐로 간다 — 테넌트 생성 때 그 계정을 관리자로 넣는다.
- 심사 메모(영문): 서버 주소·계정·"에이전트는 다른 컴퓨터에서 도는 AI 이고, 앱은 호출만 한다"·Time Sensitive 사용 사유.

## 5. 빌드·출시 경로

| 항목 | 규칙 |
|---|---|
| 버전 (`CFBundleShortVersionString`) | `pubspec.yaml` 의 `version:` 앞부분. **1.0.0** 으로 첫 출시, 이후 기능 = minor, 수정 = patch. 서버·desktop 버전과 **독립** |
| 빌드 번호 | 지금처럼 ASC 최대값 + 1(`tool/next-build-number.mjs`). 바꾸지 않는다 |
| main 머지 | 지금처럼 → TestFlight **내부** 그룹(자동) |
| `mobile-v*` 태그 | 같은 빌드를 **외부 테스트 그룹**에 붙임(베타 심사 자동 제출) — CI 에 단계 추가 |
| 정식 심사 제출 | 사람이 ASC 에서 빌드 선택 → 제출. CI 는 메타데이터(설명·키워드·스크린샷)를 저장소의 파일에서 올리는 것까지만(선택, D4) |
| 출시 | **단계적 출시(7일 phased release)** 켬, 수동 출시(심사 통과 뒤 사람이 누름) |
| 되돌림 | 앱은 되돌릴 수 없다 → 단계적 출시 일시정지 + 핫픽스 빌드. 서버 호환 하한(`MIN_SERVER_VERSION` 대응)을 앱에도 둔다 |
| `aps-environment` | Release 는 `production`(이미 `RunnerRelease.entitlements`) |

## 6. 단계와 사람이 할 일

👤 = jaebin 만 할 수 있음(계정·법·돈). 🤖 = 에이전트 PR.

| 단계 | 내용 | 누가 |
|---|---|---|
| R0 | ASC **유료 앱 계약 불필요**(무료) — 다만 무료 앱 계약·**세금·은행은 무료면 불필요**, DSA(EU) 거래자 지위 신고 필요 | 👤 |
| R0 | App ID 에 Push·**Time Sensitive Notifications** 켜고 프로파일 재생성 | 👤 |
| R0 | 개인정보 처리방침·이용약관·지원 페이지 게시(초안은 🤖 가 씀 — hosted 기본 보관 정책 SEC-5, 연락처·신고 약속 DSN-9) | 👤 게시 / 🤖 초안 |
| R0 | 개발자 계정 종류 확인 → 판매자 이름·저작권 표기(DSN-8) | 👤 |
| R1 | 서버: 신고·차단·`DELETE /accounts/me`(SEC-1~4) + 관리자 신고 큐 | 🤖 (서버 먼저 릴리스), security 대조 |
| R2 | 모바일: 신고·차단·계정 삭제(SEC-3)·처리방침 링크·AI 고지 한 줄·`PrivacyInfo` 보강(SEC-6)·Keychain `this_device_only` 이전·연결 화면 안내 한 줄 + [커뮤니티가 없나요?] 링크(DSN-7) | 🤖 |
| R2 | (D1 에 따라) iPhone 전용으로 내리기 또는 iPad 점검 | 🤖 |
| R3 | 심사 테넌트·계정·데모 에이전트(§4, SEC-7) | 👤 테넌트 생성·비밀·격리 operator 자리 / 🤖 시드 스크립트·에이전트 정의 |
| R4 | CI: 태그 → 외부 그룹, (D4) 메타데이터 업로드 | 🤖 |
| R5 | `store_screens_test.dart` 로 스크린샷 + 제목 띠 합성 + 등록물 문구(§3.1) | 🤖 + designer 판정 |
| R6 | ASC 입력: App Privacy·연령 등급·가격/지역·심사 메모 → 외부 베타 심사 | 👤 |
| R7 | 정식 심사 제출 → 단계적 출시 | 👤 |

## 7. 남은 후보 — 출시 전 / 뒤로

| 후보 | 판정 | 이유 |
|---|---|---|
| 기능 바 2단계(진행 중) | **뒤로**(1.0.x) | 심사 요건 아님. 진행 중인 것은 머지되면 자연히 들어감 |
| S6 후속(툴팁, openDmWith 커뮤니티 대조) | **출시 전**(L1 보안 대조만) | 다른 커뮤니티로 DM 이 열리는 것은 개인정보 사고 |
| 푸시 P2 NSE(알림 내용 복호화·미리보기) | **뒤로** | 지금 미리보기는 기본 꺼짐(`prefs.preview` false)이라 심사·개인정보에 문제없음 |
| Keychain `this_device_only` | **출시 전** | 백업·새 기기로 세션 토큰이 따라가지 않게. 대상 `session_store.dart` · `recent_search_store.dart`. 이미 저장된 항목은 **읽기 → 지우기 → 새 옵션으로 쓰기** 이전 단계를 넣고 업그레이드 설치로 시험한다 |
| 쓰던 글 디스크 보관(S8) | **뒤로** | 편의 기능 |

## 8. 결정할 것 (jaebin)

- **D1** iPad: iPhone 전용(`TARGETED_DEVICE_FAMILY = 1`)으로 첫 출시? (추천: 예 — iPad 레이아웃·스크린샷 비용을 뒤로)
- **D2** 계정 삭제를 B4 처럼 넣을지(추천: 넣는다 — 거절 한 번이 한 주다)
- **D3** 키워드에 Claude·Codex 같은 타사 상표를 넣을지(추천: 안 넣는다 — 2.3.7)
- **D4** 스토어 메타데이터를 저장소 파일 + CI 로 올릴지, ASC 에서 손으로 할지(추천: 1차는 손, 뒤에 자동화)
- **D5** 심사 데모 에이전트를 어느 오퍼레이터에서 돌릴지. jaebin 머신은 안 된다(SEC-7).
  추천: **홈랩 k8s 의 전용 컨테이너 operator 하나**(심사 테넌트 전용, 다른 에이전트 없음, 비밀 마운트 없음,
  harkroom 발화 도구만). 원격 operator 계획(보류 중)의 결정을 기다리지 않도록 이 용도만 따로 띄운다.
- **D6** 스크린샷에 한 줄 제목 띠를 넣을지(추천: 넣는다 — 띠 없이 올리면 R5 가 반나절 준다)
