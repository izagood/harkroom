import 'package:flutter/material.dart';

/// 앱의 색·글자·간격. **값은 여기 한 곳에만 산다** — 화면은 이름으로만 집는다.
///
/// ## 왜 Material 기본값을 걷어 내나
///
/// 지금까지는 `colorSchemeSeed: indigo` 하나로 모든 색을 뽑았다. 그러면 머리·배지·버튼이
/// 전부 **남보라 계열의 비슷한 색**이 되고, 사람이 "어디를 봐야 하나"를 색으로 알 수 없다.
/// 데스크탑은 먹색 레일 + 주황 강조 하나로 그 신호를 준다(designer 모바일 재설계 §2).
/// 모바일도 같은 두 색만 쓴다: **주황은 "지금 손이 갈 곳"(안 읽음 배지·보내기)에만.**
/// 여기저기 쓰면 강조가 강조이기를 멈춘다.
///
/// 상태 색(경고·오류·성공)은 **면을 칠하지 않고** 옅은 바탕 + 진한 글자로 쓴다. 다크 모드에서
/// 짙은 빨강 면이 화면을 덮던 것(지난 검토)을 같은 토큰으로 피한다.
@immutable
class HarkroomTokens extends ThemeExtension<HarkroomTokens> {
  const HarkroomTokens({
    required this.surfaceInverse,
    required this.surfaceInverse2,
    required this.fgOnInverse,
    required this.accentOnInverse,
    required this.surface,
    required this.surfaceRaised,
    required this.surfaceSunken,
    required this.surfaceHover,
    required this.field,
    required this.border,
    required this.fg,
    required this.fgMuted,
    required this.fgSubtle,
    required this.fgOnStrong,
    required this.link,
    required this.accent,
    required this.accentHover,
    required this.accentText,
    required this.accentSurface,
    required this.accentBrand,
    required this.danger,
    required this.dangerSurface,
    required this.warning,
    required this.warningSurface,
    required this.success,
    required this.successSurface,
    required this.fgAgent,
    required this.surfaceAgent,
    required this.borderAgent,
    required this.stateTurn,
    required this.stateRunning,
    required this.stateWaiting,
    required this.stateDone,
    required this.stateStuck,
  });

  /// 머리·주 버튼의 먹색 면. 데스크탑 레일과 같은 톤이다.
  final Color surfaceInverse;

  final Color surfaceInverse2;

  /// 먹색 면(스낵바·떠 있는 막대) 위의 글자. 그 면이 두 모드 모두 어두우므로 같은 값이다.
  final Color fgOnInverse;

  /// 먹색 면 위의 강조 글자(스낵바 동작). [fgOnInverse] 처럼 두 모드 같은 값이다.
  final Color accentOnInverse;
  /// 화면 바탕.
  final Color surface;

  /// 칩·시트·눌린 탭처럼 바탕 위로 한 단 들뜬 면.
  final Color surfaceRaised;

  /// 섹션·목록 머리처럼 바탕보다 한 단 가라앉은 면.
  final Color surfaceSunken;

  /// 누르는 중·고른 줄.
  final Color surfaceHover;

  /// 입력 칸 바탕.
  final Color field;

  final Color border;
  final Color fg;
  /// 메타(시각·부제·읽은 채널).
  final Color fgMuted;

  /// 메타보다 한 단 더 물러난 글자(자리표시 등).
  final Color fgSubtle;

  /// 진한 면(주황·먹색) **위의** 글자(배지 숫자·보내기 화살표). 밝은 판은 흰색이고 굵게 쓴다. 다크 판의
  /// 밝은 주황 위 흰 글자는 2.6:1 이라 먹색으로 뒤집는다(6.9:1) — designer #976 판정 ①.
  final Color fgOnStrong;

  final Color link;
  /// **강조는 이것 하나다.** 안 읽음 배지·보내기·내 차례에만 쓴다.
  final Color accent;

  final Color accentHover;
  /// 바탕 위에 글자로 쓰는 주황(면보다 한 단 진하다 — 대비).
  final Color accentText;

  final Color accentSurface;
  /// 로고·큰 표지용 주황.
  final Color accentBrand;

  final Color danger;
  final Color dangerSurface;
  final Color warning;
  final Color warningSurface;
  final Color success;
  final Color successSurface;
  /// 에이전트 표지. 사람과 같은 모양에 색만 가른다(채도를 뺀 청록 회색).
  final Color fgAgent;

  final Color surfaceAgent;
  final Color borderAgent;
  /// 상태 점: 내 차례 = 강조.
  final Color stateTurn;

  final Color stateRunning;
  final Color stateWaiting;
  final Color stateDone;
  /// 막힘 = 위험 색.
  final Color stateStuck;


  /// A · Paper 밝은 판. 이름은 데스크탑 역할 이름과 같다 — 두 앱이 같은 이름으로 같은 자리를 칠한다.
  static const light = HarkroomTokens(
    surfaceInverse: Color(0xFF1B1A19),
    surfaceInverse2: Color(0xFF2B2927),
    fgOnInverse: Color(0xFFEBE7E2),
    accentOnInverse: Color(0xFFFF9B76),
    surface: Color(0xFFFBFAF8),
    surfaceRaised: Color(0xFFFFFFFF),
    surfaceSunken: Color(0xFFF3F1EE),
    surfaceHover: Color(0xFFE7E2DB),
    field: Color(0xFFFFFFFF),
    border: Color(0xFFE6E2DC),
    fg: Color(0xFF1B1A19),
    fgMuted: Color(0xFF6B665F),
    fgSubtle: Color(0xFF8E8880),
    fgOnStrong: Color(0xFFFFFFFF),
    link: Color(0xFF2563C9),
    accent: Color(0xFFCC4A22),
    accentHover: Color(0xFFB6421F),
    accentText: Color(0xFFB6421F),
    accentSurface: Color(0xFFFDEBE4),
    accentBrand: Color(0xFFE4572E),
    danger: Color(0xFFB42318),
    dangerSurface: Color(0xFFFDECEA),
    warning: Color(0xFF8A5A00),
    warningSurface: Color(0xFFFFF1CC),
    success: Color(0xFF1B7D45),
    successSurface: Color(0xFFE6F6EC),
    fgAgent: Color(0xFF4E5A56),
    surfaceAgent: Color(0xFFF1F4F2),
    borderAgent: Color(0xFFCFD8D4),
    stateTurn: Color(0xFFCC4A22),
    stateRunning: Color(0xFF4E5A56),
    stateWaiting: Color(0xFFA8A39B),
    stateDone: Color(0xFF5E8A6E),
    stateStuck: Color(0xFFB42318),
  );

  /// 다크 판(designer #976 판정 ①). 먹색 면은 **바탕보다 한 단 밝게** 들뜬다 — 밝은 판의
  /// 먹색을 그대로 쓰면 다크 바탕(`#1C1B19`)과 거의 같아 스낵바·머리·떠 있는 버튼이 묻힌다.
  /// 상태 색은 옅은 면 대신 어두운 면 + 밝은 글자, 주황은 한 단 밝힌다(데스크탑 다크의 `#ff7a4a`).
  static const dark = HarkroomTokens(
    surfaceInverse: Color(0xFF2E2B28),
    surfaceInverse2: Color(0xFF3D3934),
    fgOnInverse: Color(0xFFEBE7E2),
    accentOnInverse: Color(0xFFFF9B76),
    surface: Color(0xFF1C1B19),
    surfaceRaised: Color(0xFF262422),
    surfaceSunken: Color(0xFF171614),
    surfaceHover: Color(0xFF2E2B28),
    field: Color(0xFF262422),
    border: Color(0xFF34312E),
    fg: Color(0xFFEBE7E2),
    fgMuted: Color(0xFF9A938B),
    fgSubtle: Color(0xFF7A746C),
    fgOnStrong: Color(0xFF1C1B19),
    link: Color(0xFF7AA7F0),
    accent: Color(0xFFFF7A4A),
    accentHover: Color(0xFFFF9B76),
    accentText: Color(0xFFFF9B76),
    accentSurface: Color(0xFF3A2219),
    accentBrand: Color(0xFFFF7A4A),
    danger: Color(0xFFFF8A80),
    dangerSurface: Color(0xFF3A1D1B),
    warning: Color(0xFFF0B43C),
    warningSurface: Color(0xFF33290F),
    success: Color(0xFF5CCF86),
    successSurface: Color(0xFF16301F),
    fgAgent: Color(0xFF8FA39D),
    surfaceAgent: Color(0xFF1F2422),
    borderAgent: Color(0xFF333C39),
    stateTurn: Color(0xFFFF7A4A),
    stateRunning: Color(0xFF8FA39D),
    stateWaiting: Color(0xFF716B64),
    stateDone: Color(0xFF6EA882),
    stateStuck: Color(0xFFFF8A80),
  );

  @override
  HarkroomTokens copyWith() => this;

  /// 색 사이를 보간하지 않는다 — 밝기를 바꾸는 순간 한 번에 바뀌는 것이 맞고, 중간색은
  /// 어느 판에도 없는 색이다.
  @override
  HarkroomTokens lerp(HarkroomTokens? other, double t) => t < 0.5 ? this : (other ?? this);
}

/// 글자 단계. **화면이 숫자를 적지 않는다** — 단계가 늘어나면 한 화면 안에서 크기가
/// 제각각이 되고, 그것이 "Material 기본값"으로 보이던 이유의 절반이다. A · Paper 는 4 단만 둔다.
/// 굵기는 w400·w500·w600 셋뿐이다(w700 없음).
abstract final class HarkroomType {
  /// 홈 머리의 커뮤니티 이름. w600.
  static const double title = 20;
  static const double titleHeight = 1.25;
  static const double titleSpacing = -0.4; // -0.02em

  /// 화면 머리 제목. w600.
  static const double name = 17;
  static const double nameHeight = 1.3;
  static const double nameSpacing = -0.17; // -0.01em

  /// 메시지 본문·목록 줄. 줄 간격 1.5 — 한국어 받침이 겹치지 않고 숨 쉴 틈이 있는 선.
  /// 목록 줄 이름은 같은 크기에 w600 이다.
  static const double body = 15;
  static const double bodyHeight = 1.5;

  /// 시각·부제·섹션 머리. w500(섹션 머리는 w600).
  static const double meta = 12;
  static const double metaHeight = 1.35;
}

/// 간격·크기. 화면 가장자리는 16 그대로다(지금과 같다).
abstract final class HarkroomSize {
  static const double gutter = 16;

  /// 목록 한 줄. 지금 약 56 → 44. 탭 영역 최소(44pt, Apple HIG)와 같아서 더 줄이지 않는다.
  static const double row = 44;

  /// 메시지 아바타. 둥근 **사각**이다 — 사람·에이전트 둘 다 같은 모양으로 두고, 에이전트는
  /// 이름 옆 표지로 가른다(모양으로 가르면 모양을 외워야 한다).
  static const double avatar = 36;
  static const double avatarRadius = 10;

  /// 목록 줄 안의 작은 아바타(인박스·DM 줄).
  static const double avatarSmall = 28;
}

/// 모서리. 선언만 — 화면에 입히는 것은 다음 PR 이다.
abstract final class HarkroomRadius {
  static const double sm = 4;
  static const double row = 8;
  static const double card = 12;
  static const double compose = 14;
  static const double avatar = 10;
  static const double avatarSmall = 6;
  static const double full = 999;
}

/// 그림자. 떠 있는 면(메뉴·시트)은 그림자 + 1px 테두리를 같이 쓴다 — 다크에서는 그림자만으로
/// 면이 갈리지 않는다. 선언만.
abstract final class HarkroomShadow {
  static List<BoxShadow> float(Brightness b) => b == Brightness.dark
      ? const [BoxShadow(offset: Offset(0, 8), blurRadius: 24, color: Color(0x73000000))]
      : const [BoxShadow(offset: Offset(0, 8), blurRadius: 24, color: Color(0x141B1A19))];

  /// [float] 와 같이 쓰는 테두리.
  static BorderSide floatBorder(Brightness b) =>
      BorderSide(color: b == Brightness.dark ? const Color(0xFF34312E) : const Color(0xFFE6E2DC));

  /// 입력 칸. 다크에서는 그림자를 안 쓴다.
  static List<BoxShadow> compose(Brightness b) => b == Brightness.dark
      ? const []
      : const [BoxShadow(offset: Offset(0, 1), blurRadius: 2, color: Color(0x0D1B1A19))];

  /// [compose] 와 같이 쓰는 입력 칸의 1px 선. 다크는 그림자 없이 이 선만 남는다.
  static BorderSide composeBorder(Brightness b) =>
      BorderSide(color: b == Brightness.dark ? const Color(0xFF3D3934) : const Color(0xFFE0DBD4));
}

/// 움직임. 선언만.
abstract final class HarkroomMotion {
  static const Duration fast = Duration(milliseconds: 120);
  static const Duration base = Duration(milliseconds: 180);
  static const Duration sheet = Duration(milliseconds: 240);
  static const Curve ease = Cubic(0.2, 0, 0, 1);
}

extension HarkroomTokensContext on BuildContext {
  /// 토큰. 테마에 **반드시** 들어 있다(`harkroomTheme` 가 넣는다) — 없으면 시험이 테마를
  /// 안 쓴 것이고, 그때 조용히 기본값으로 떨어지면 시험이 배포되는 것과 다른 앱을 본다.
  HarkroomTokens get tokens => Theme.of(this).extension<HarkroomTokens>()!;
}
