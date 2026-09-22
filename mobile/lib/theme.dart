import 'package:flutter/material.dart';

/// 앱의 테마. **한 벌만 둔다** — 화면도 시험도 여기를 읽는다.
///
/// ## 왜 `splashFactory` 를 명시하나
///
/// Material 3 의 기본 물결은 `InkSparkle` 이고, 그것은 **셰이더 자산**
/// (`shaders/ink_sparkle.frag`)을 읽는다. 이 앱은 iOS 부터이고 그 효과는 Android 의
/// 결이라 얻는 것이 없는데, 값은 둘 낸다:
///
/// 1. `flutter test` 의 백엔드(SkSL)가 그 자산을 못 읽어 **버튼을 누르는 시험마다
///    예외가 난다**(실측: Flutter 3.47.5 — *"does not contain appropriate runtime stage
///    data for current backend (SkSL). Found stages: Vulkan"*).
/// 2. `InkRipple` 이 iOS 에서 더 맞는 결이다. 셰이더를 안 읽는 것은 그 선택의 부산물이다.
///
/// **시험에서만 끄지 않는다.** 그러면 배포되는 것과 시험하는 것이 갈린다 — 그래서 이
/// 함수가 한 곳이고, 시험도 `MaterialApp(theme: harkroomTheme(...))` 로 같은 것을 쓴다.
ThemeData harkroomTheme(Brightness brightness) => ThemeData(
      colorSchemeSeed: Colors.indigo,
      brightness: brightness,
      splashFactory: InkRipple.splashFactory,
    );
