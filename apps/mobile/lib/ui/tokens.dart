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
    required this.ink,
    required this.ink2,
    required this.bg,
    required this.soft,
    required this.line,
    required this.fg,
    required this.mute,
    required this.accent,
    required this.accentSoft,
    required this.onAccent,
    required this.link,
    required this.mentionSoft,
    required this.warn,
    required this.warnSoft,
    required this.err,
    required this.errSoft,
    required this.ok,
    required this.okSoft,
  });

  /// 머리·주 버튼의 먹색. 데스크탑 레일과 같은 톤이다.
  final Color ink;
  final Color ink2;
  final Color bg;

  /// 칩·자리표시·눌린 탭처럼 바탕과 살짝만 갈라야 하는 면.
  final Color soft;
  final Color line;
  final Color fg;

  /// 메타(시각·부제·읽은 채널).
  final Color mute;

  /// **강조는 이것 하나다.** 안 읽음 배지·보내기·내 차례에만 쓴다.
  final Color accent;
  final Color accentSoft;

  /// 주황 **위의** 글자(배지 숫자·보내기 화살표). 밝은 판은 흰색이고 굵게 쓴다(3.7:1). 다크 판의
  /// 밝은 주황 위 흰 글자는 2.6:1 이라 먹색으로 뒤집는다(6.9:1) — designer #976 판정 ①.
  final Color onAccent;
  final Color link;
  final Color mentionSoft;
  final Color warn;
  final Color warnSoft;
  final Color err;
  final Color errSoft;
  final Color ok;
  final Color okSoft;

  /// designer 재설계 §2 의 제안 팔레트 그대로다.
  static const light = HarkroomTokens(
    ink: Color(0xFF18181B),
    ink2: Color(0xFF27272C),
    bg: Color(0xFFFFFFFF),
    soft: Color(0xFFF4F3F1),
    line: Color(0xFFE8E6E3),
    fg: Color(0xFF1B1A19),
    mute: Color(0xFF76716B),
    accent: Color(0xFFE4572E),
    accentSoft: Color(0xFFFDEBE4),
    onAccent: Color(0xFFFFFFFF),
    link: Color(0xFF2563C9),
    mentionSoft: Color(0xFFE8F0FD),
    warn: Color(0xFF8A5A00),
    warnSoft: Color(0xFFFFF1CC),
    err: Color(0xFFB42318),
    errSoft: Color(0xFFFDECEA),
    ok: Color(0xFF1F8A4C),
    okSoft: Color(0xFFE6F6EC),
  );

  /// 다크 판(designer #976 판정 ①). 먹색 면은 **바탕보다 한 단 밝게** 들뜬다 — 밝은 판의
  /// 먹색을 그대로 쓰면 다크 바탕(`#1C1B19`)과 거의 같아 스낵바·머리·떠 있는 버튼이 묻힌다.
  /// 상태 색은 옅은 면 대신 어두운 면 + 밝은 글자, 주황은 한 단 밝힌다(데스크탑 다크의 `#ff7a4a`).
  static const dark = HarkroomTokens(
    ink: Color(0xFF2A2A2F),
    ink2: Color(0xFF34343A),
    bg: Color(0xFF1C1B19),
    soft: Color(0xFF2A2826),
    line: Color(0xFF34312E),
    fg: Color(0xFFEBE7E2),
    mute: Color(0xFF9A938B),
    accent: Color(0xFFFF7A4A),
    accentSoft: Color(0xFF3A2219),
    onAccent: Color(0xFF18181B),
    link: Color(0xFF7AA7F0),
    mentionSoft: Color(0xFF1E2A3D),
    warn: Color(0xFFF0B43C),
    warnSoft: Color(0xFF33290F),
    err: Color(0xFFFF8A80),
    errSoft: Color(0xFF3A1D1B),
    ok: Color(0xFF5CCF86),
    okSoft: Color(0xFF16301F),
  );

  @override
  HarkroomTokens copyWith() => this;

  /// 색 사이를 보간하지 않는다 — 밝기를 바꾸는 순간 한 번에 바뀌는 것이 맞고, 중간색은
  /// 어느 판에도 없는 색이다.
  @override
  HarkroomTokens lerp(HarkroomTokens? other, double t) => t < 0.5 ? this : (other ?? this);
}

/// 글자 크기 단계. **화면이 숫자를 적지 않는다** — 단계가 늘어나면 한 화면 안에서 크기가
/// 제각각이 되고, 그것이 "Material 기본값"으로 보이던 이유의 절반이다.
abstract final class HarkroomType {
  /// 홈 머리의 커뮤니티 이름.
  static const double homeTitle = 17;

  /// 화면 머리 제목.
  static const double screenTitle = 15;

  /// 화면 머리 부제(멤버 수·주제·채널 이름).
  static const double screenSubtitle = 11;

  /// 메시지 본문. 줄 간격 1.4 — 촘촘하되 한국어 받침이 겹치지 않는 선.
  static const double body = 15;
  static const double bodyHeight = 1.4;

  /// 이름 옆 시각·부제·회색 메타.
  static const double meta = 12;

  /// 섹션 머리("채널" 같은 묶음 이름).
  static const double section = 12;

  /// 목록 줄의 이름(채널 이름).
  static const double row = 15;
}

/// 간격·크기. 화면 가장자리는 16 그대로다(지금과 같다).
abstract final class HarkroomSize {
  static const double gutter = 16;

  /// 목록 한 줄. 지금 약 56 → 44. 탭 영역 최소(44pt, Apple HIG)와 같아서 더 줄이지 않는다.
  static const double row = 44;

  /// 메시지 아바타. 둥근 **사각**이다 — 사람·에이전트 둘 다 같은 모양으로 두고, 에이전트는
  /// 이름 옆 표지로 가른다(모양으로 가르면 모양을 외워야 한다).
  static const double avatar = 36;
  static const double avatarRadius = 8;

  /// 목록 줄 안의 작은 아바타(인박스·DM 줄).
  static const double avatarSmall = 28;
}

extension HarkroomTokensContext on BuildContext {
  /// 토큰. 테마에 **반드시** 들어 있다(`harkroomTheme` 가 넣는다) — 없으면 시험이 테마를
  /// 안 쓴 것이고, 그때 조용히 기본값으로 떨어지면 시험이 배포되는 것과 다른 앱을 본다.
  HarkroomTokens get tokens => Theme.of(this).extension<HarkroomTokens>()!;
}
