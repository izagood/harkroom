# harkroom mobile

폰에서 harkroom 을 **메신저처럼** 쓰고, 그 안에서 **다른 머신에서 도는 에이전트를 부른다.**

계획서: [`docs/plans/2026-09-22-mobile-flutter.md`](../../docs/plans/2026-09-22-mobile-flutter.md)

## 이 앱이 하지 않는 것

**오퍼레이터가 아니라 대화 클라이언트다.** 에이전트를 *돌리는* 일은 전부 데스크탑
(`packages/desktop`)에 있다 — 러너 띄우기·죽이기, Claude 계정 로그인, 오퍼레이터 등록,
터미널. 폰에는 그 기계가 없다.

애매한 화면이 나오면 이 문장으로 돌아온다.

## 왜 `apps/` 인가 — 그리고 왜 지금은 여기 혼자인가

`apps/` 는 **돌아가는 것**이고 `packages/` 는 **그것들이 가져다 쓰는 것**이다. 나누는 축은
언어가 아니라 역할이라, Dart 로 쓰인 이 앱도 `apps/` 가 제자리다.

지금 `apps/` 에 이것 하나뿐인 이유는 **나머지가 아직 안 옮겨졌기 때문**이다. 전면 재배치
(`packages/{server,desktop,agent,operator}` → `apps/*`)는 열린 PR 들이 머지된 뒤로 미뤘다
(PR #885 에 그때 쓸 레시피가 있다). 모바일만 먼저 온 것은 **새로 만드는 것이라 옮길 이력이
없어서**다 — 나중에 한 번 더 옮기는 것보다 처음부터 최종 자리에 두는 편이 싸다.

`packages/*` 글롭 밖이라 **pnpm 은 이 디렉터리를 모른다.** `pnpm -r test` 도
`pnpm -r typecheck` 도 여기를 돌지 않는다. 그것이 의도다 — 여기는 pub 의 땅이다.
다만 그 때문에 저장소 전역 검사가 이 디렉터리를 빠뜨리기 쉬우니,
`packages/server/test/repoHygiene.test.ts` 의 `CODE_ROOTS` 가 `apps` 를 함께 훑는다.

## 돌리기

```sh
brew install --cask flutter     # 3.47.5 에서 확인했다
brew install cocoapods          # 네이티브 플러그인에 필요하다
xcodebuild -downloadPlatform iOS  # **시뮬레이터 런타임** (8.5GB, 한 번만)

cd apps/mobile
flutter pub get
flutter test                    # 위젯·단위 시험
flutter run                     # iOS 시뮬레이터
```

`xcodebuild -showsdks` 에 iOS SDK 가 보여도 **시뮬레이터 런타임은 따로**다. 없으면
`flutter build ios` 가 *"iOS 26.5 is not installed"* 로 죽는다 — SDK 가 없다는 말이 아니다.

### 기기에서 도는 시험 (`integration_test/`)

```sh
xcrun simctl boot "iPhone 17 Pro"   # 아무 시뮬레이터나 띄워 두고
flutter test integration_test/app_boots_test.dart
```

**위젯 시험만으로는 모자란다.** 160개가 전부 초록인데도 시뮬레이터에 처음 띄웠을 때
첫 화면이 빨간 오류였다(`No MaterialLocalizations found` — 기기 언어가 한국어였다).
위젯 시험은 기본 로케일이 영어라 그 경로를 한 번도 안 지났다. 로케일·플러그인 채널
(Keychain·파일 고르기)·ATS 는 **진짜 런타임에서만** 드러난다.

#### 실서버에 붙어 한 바퀴 (`live_tour_test.dart`)

로그인 → 채널 목록 → 보내기 → 실시간 수신 → 리액션 → 스레드 → 첨부 → `@` 부르기 → ask 답하기 →
받은 것. **진짜 워크스페이스에 쓰고 버릴 계정으로** 돈다(초대 토큰으로 `POST /auth/register`).
자격증명은 `--dart-define` 으로 넣고, 없으면 통째로 건너뛴다 — CI 는 이것을 돌리지 않는다.
돌리는 법은 파일 머리에 있다.

**가짜 서버 시험만으로는 모자랐다.** 처음 실서버에 붙였을 때 채널 목록이 **늘 비어 있었다**
(서버는 `{"channels":[…]}` 로 감싸 주는데 앱은 맨 배열로 읽었고, 가짜 서버가 맨 배열을 줬다).
가짜 서버의 응답 모양은 실서버와 같아야 한다 — 다르면 시험이 틀린 앱을 초록으로 만든다.

CI 는 [`.github/workflows/mobile.yml`](../../.github/workflows/mobile.yml) 이고 `apps/mobile/` 이
바뀔 때만 깬다.

## 지금 서 있는 것

스켈레톤 단계다. 아직 **서버에 붙지 않는다**(연결·로그인은 P0).

| 무엇 | 어디 |
|---|---|
| 문구 — 첫 줄부터 i18n 키 | `lib/i18n/` |
| 서버 주소 판정 (`http://` 거절) | `lib/connect/server_url.dart` |
| 연결 화면 | `lib/connect/connect_screen.dart` |
| 테마 한 벌 (화면도 시험도 이것을 읽는다) | `lib/theme.dart` |

## 규칙 두 개

### 1. 화면 코드에 사람이 읽을 문자열을 쓰지 않는다

전부 `lib/i18n/` 의 키다. `en` 이 원본이고(저장소 관례: 주석은 한국어, UI 문자열은 영어)
**`ko` 를 비워 두지 않는다** — 빈 자리는 "번역이 없다"가 아니라 "덜 만든 화면"으로 읽힌다.

새 문구는 세 곳이다: `strings.dart` 의 getter · `en.dart`/`ko.dart` · `stringsToMap`.
앞의 둘은 컴파일러가 강제하고 마지막 하나는 `test/i18n_test.dart` 가 본다.

### 2. ATS 예외를 넣지 않는다

iOS 는 평문 `http://`·`ws://` 를 막는다. `Info.plist` 에 `NSAllowsArbitraryLoads` 도
`NSAllowsLocalNetworking` 도 **넣지 않는다** — "개발 중에만" 은 배포까지 따라가고, 그때
폰은 밖에서 평문으로 토큰을 흘린다.

대신 연결 화면이 `http://` 를 **저장하기 전에** 거절하며 이유를 말한다. ATS 는 사유 없는
"연결 실패" 만 돌려주므로, 그것만 믿으면 사람은 오타인지 서버가 죽은 건지 iOS 가 막은 건지
구별할 수 없다.

## 서명 자료는 커밋하지 않는다

**저장소는 공개다.** `.gitignore` 가 `*.p8`·`*.p12`·`*.mobileprovision`·`*.cer` 를 막지만,
막는 것과 올리지 않는 것은 다르다. 커밋 전에 `git status` 로 목록을 본다.

## TestFlight 로 올리기

번들 id 는 **`com.harkroom.app`** 이다(테스트 대상은 `.RunnerTests`). App Store Connect 에 앱
레코드를 만든 뒤로는 바꿀 수 없다.

- **서명**: Release 만 Manual(`Apple Distribution` + 프로파일 `Harkroom Mobile App Store`),
  Debug·Profile 은 자동 서명 그대로다. 매핑은 `ios/ExportOptions.plist`(`app-store-connect`).
- **빌드 번호**: App Store Connect 의 최대값 + 1 이다(`tool/next-build-number.mjs`). CI 의
  `run_number` 를 쓰지 않는다 — 워크플로마다 1 부터 세서 이미 올라간 번호와 부딪힌다.
- **로컬**: `tool/release-ios.sh`(E2E → `flutter build ipa` → 서명 체인 검사 → `altool --validate-app`
  → `--upload-app`). 서명 자료는 `~/.harkroom-signing`(또는 `HARKROOM_SIGNING_DIR`)에 둔다:
  `AuthKey_<KEY_ID>.p8` 와 `values.txt`(`ASC_KEY_ID=`·`ASC_ISSUER_ID=`·`ASC_APP_ID=`).
- **CI**: `.github/workflows/testflight.yml`. 사람이 누르거나 `mobile-v*` 태그를 밀 때만 돌고,
  **PR 에서는 돌지 않는다.** CI 에서는 E2E 를 건너뛰고 캐시를 쓰지 않는다. secret 목록은 그 파일 머리에 있다.
  환경 `testflight` 에 사람이 걸 것:
  - 필수 승인자
  - 배포 대상 제한: `mobile-v*` 태그와 수동 실행용 `main`
  - 태그 ruleset: `mobile-v*` 는 승인자만 만들 수 있게
- **API 키는 이 저장소 전용**으로 새로 만든다. 역할은 **App Manager** 면 된다(수동 서명이라 Admin 이
  필요 없다). 다른 앱과 키를 같이 쓰지 않아야 한쪽이 새도 이 키만 폐기하면 된다. CI 용 p12 도 로컬과 다른
  비밀번호로 다시 내보낸다 — 배포 인증서는 팀 전체의 것이다.
- 수출 규정은 `ITSAppUsesNonExemptEncryption = false`(OS 의 HTTPS 만 쓴다), 개인정보 매니페스트는
  `ios/Runner/PrivacyInfo.xcprivacy`, 사진 권한 문구는 `ios/Runner/{en,ko}.lproj/InfoPlist.strings` 다.
- 아이콘 원본은 `assets/icon/AppIcon.svg` 다. 1024 는 **알파 채널이 없어야** 업로드가 통과한다.

**테스터에게 알릴 것**: 버그를 신고하며 찍는 스크린샷에는 **워크스페이스 주소가 보인다**(부팅 실패
화면·설정 등). 공개된 곳에 올리기 전에 주소를 가린다.
