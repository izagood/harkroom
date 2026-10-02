import 'package:flutter/material.dart';

import 'ui/tokens.dart';

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
///
/// ## 색은 `HarkroomTokens` 에서만 온다
///
/// 씨앗색 하나로 뽑던 남보라를 버리고(designer 재설계 §2), Material 부품이 읽는
/// `ColorScheme` 을 **토큰으로 손수 채운다.** `primary` 는 먹색이다 — 주 버튼·선택된 탭처럼
/// "여기가 기본"인 자리는 먹색이고, 주황(`secondary`)은 안 읽음·보내기·내 차례에만 쓴다.
/// 씨앗색에 맡기면 Material 이 그 사이 색을 지어내 화면마다 다른 보라가 생긴다.
ThemeData harkroomTheme(Brightness brightness) {
  final k = brightness == Brightness.dark ? HarkroomTokens.dark : HarkroomTokens.light;
  final dark = brightness == Brightness.dark;
  final scheme = ColorScheme(
    brightness: brightness,
    // 다크에서 먹색 버튼은 바탕에 묻힌다 — 그때는 글자색을 주 색으로 쓴다.
    primary: dark ? k.fg : k.surfaceInverse,
    onPrimary: dark ? k.surfaceInverse : Colors.white,
    secondary: k.accent,
    onSecondary: k.fgOnStrong,
    // 손으로 채우는 이상 **컨테이너 색도 빠짐없이** 채운다 — 비워 두면 Material 이 먹색
    // 바탕을 지어내 "내 차례" 카드가 검은 면에 검은 글자가 됐다(첫 갤러리에서 그랬다).
    // 강조 면(내 차례)은 주황의 옅은 판이다.
    primaryContainer: k.accentSurface,
    onPrimaryContainer: k.fg,
    secondaryContainer: k.surfaceRaised,
    onSecondaryContainer: k.fg,
    tertiary: k.warning,
    onTertiary: Colors.white,
    tertiaryContainer: k.warningSurface,
    onTertiaryContainer: k.warning,
    error: k.danger,
    onError: Colors.white,
    errorContainer: k.dangerSurface,
    onErrorContainer: k.danger,
    surface: k.surface,
    onSurface: k.fg,
    onSurfaceVariant: k.fgMuted,
    surfaceContainerHighest: k.surfaceRaised,
    surfaceContainerHigh: k.surfaceRaised,
    surfaceContainer: k.surfaceRaised,
    surfaceContainerLow: k.surface,
    surfaceContainerLowest: k.surface,
    outline: k.fgMuted,
    outlineVariant: k.border,
  );
  return ThemeData(
    colorScheme: scheme,
    brightness: brightness,
    scaffoldBackgroundColor: k.surface,
    splashFactory: InkRipple.splashFactory,
    extensions: [k],
    dividerTheme: DividerThemeData(color: k.border, thickness: 1, space: 1),
    // **제목은 왼쪽이다.** 가운데 제목은 iOS 기본이지만, 부제(멤버 수·채널 이름)를 붙이면
    // 두 줄이 가운데서 흔들린다. Slack·데스크탑 모두 왼쪽이다.
    appBarTheme: AppBarTheme(
      centerTitle: false,
      backgroundColor: k.surface,
      foregroundColor: k.fg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleSpacing: HarkroomSize.gutter,
      titleTextStyle: TextStyle(
          fontSize: HarkroomType.name, fontWeight: FontWeight.w600, color: k.fg),
      shape: Border(bottom: BorderSide(color: k.border)),
    ),
    // 목록 줄 44. 기본 ListTile 은 56 안팎이라 한 화면에 들어가는 채널이 적었다.
    listTileTheme: ListTileThemeData(
      // 한 줄 줄은 44 에 맞고, 두 줄 줄(인박스)은 위아래 6 을 숨 쉰다 — 0 으로 두면 두 줄이
      // 서로 붙어 한 덩어리로 읽힌다(첫 갤러리에서 그랬다).
      minVerticalPadding: 6,
      contentPadding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter),
      minTileHeight: HarkroomSize.row,
      titleTextStyle: TextStyle(fontSize: HarkroomType.body, color: k.fg),
      subtitleTextStyle: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted),
      iconColor: k.fgMuted,
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: k.surface,
      surfaceTintColor: Colors.transparent,
      indicatorColor: k.surfaceRaised,
      height: 60,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => TextStyle(
            fontSize: 11,
            fontWeight: s.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w400,
            color: s.contains(WidgetState.selected) ? k.fg : k.fgMuted,
          )),
      iconTheme: WidgetStateProperty.resolveWith(
          (s) => IconThemeData(color: s.contains(WidgetState.selected) ? k.fg : k.fgMuted)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      isDense: true,
      hintStyle: TextStyle(color: k.fgMuted),
      border: OutlineInputBorder(borderSide: BorderSide(color: k.border)),
      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: k.border)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(backgroundColor: scheme.primary, foregroundColor: scheme.onPrimary),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: k.fg,
        side: BorderSide(color: k.border),
      ),
    ),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: k.fg)),
    cardTheme: CardThemeData(
      color: k.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(color: k.border),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: k.surfaceInverse,
      contentTextStyle: const TextStyle(color: Colors.white),
      actionTextColor: const Color(0xFFFFB59C),
      behavior: SnackBarBehavior.floating,
    ),
    // 탭의 숫자 배지도 **주황**이다. 기본은 오류 빨강이라 "인박스에 3개"가 "오류 3개"로 읽혔다.
    badgeTheme: BadgeThemeData(
      backgroundColor: k.accent,
      textColor: k.fgOnStrong,
      textStyle: const TextStyle(fontWeight: FontWeight.w600),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: k.fgMuted),
  );
}
