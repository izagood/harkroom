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

## 번들 id 는 아직 자리표다

지금 `com.example.harkroom` 이다(`ios/Runner.xcodeproj/project.pbxproj`).

**App Store Connect 에 앱 레코드를 만들기 전까지는 바꿀 수 있다.** 그 뒤로는 못 바꾼다 —
앱을 새로 만들어야 한다. 그래서 이것은 계획서 §9 에서 jaebin 과 **함께** 정하고, 그때 한 번에
고친다. 그 전까지 자리표를 그럴듯한 이름으로 바꿔 두지 않는다 — 자리표는 자리표로 보여야
누가 정해야 한다는 것이 눈에 남는다.
