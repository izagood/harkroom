import 'package:flutter/material.dart';

import 'tokens.dart';

/// 공통 부품. 화면들이 같은 것을 **각자 다시 짓지 않게** 한 곳에 둔다 — 뒤의 PR(상태 화면·
/// 메시지 줄·탭 구조)이 모두 이것을 쓴다.

/// 둥근 사각 아바타. 사진이 없으면 **이름의 첫 글자 + id 로 정해지는 색**이다.
///
/// 색을 이름이 아니라 **id 로** 고른다: 이름(handle)은 바뀐다. 바뀔 때마다 아바타 색이
/// 바뀌면 사람은 다른 사람인 줄 안다.
class HarkroomAvatar extends StatelessWidget {
  const HarkroomAvatar({
    super.key,
    required this.id,
    required this.name,
    this.size = HarkroomSize.avatar,
  });

  final String id;
  final String name;
  final double size;

  /// 흰 글자가 읽히는 진한 색만 둔다(대비 4.5:1 이상).
  static const palette = <Color>[
    Color(0xFFE53935),
    Color(0xFF2E7D32),
    Color(0xFF1565C0),
    Color(0xFF6A1B9A),
    Color(0xFFC2185B),
    Color(0xFF00695C),
    Color(0xFFAD5A00),
    Color(0xFF37474F),
  ];

  /// id 하나에 색 하나. `String.hashCode` 는 실행마다 바뀔 수 있어(Dart 는 보장하지 않는다)
  /// 직접 센다 — 앱을 다시 켰더니 색이 바뀌면 같은 문제다.
  static Color colorFor(String id) {
    var h = 0;
    for (final c in id.codeUnits) {
      h = (h * 31 + c) & 0x7fffffff;
    }
    return palette[h % palette.length];
  }

  /// 첫 글자. `@` 같은 기호로 시작하면 건너뛴다. 영문은 대문자로.
  static String initialOf(String name) {
    for (final rune in name.runes) {
      final ch = String.fromCharCode(rune);
      if (RegExp(r'[\p{L}\p{N}]', unicode: true).hasMatch(ch)) return ch.toUpperCase();
    }
    return '?';
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      // 아바타는 이름 옆에 있다 — 읽어 주면 이름을 두 번 읽는다.
      excludeSemantics: true,
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: colorFor(id),
          borderRadius: BorderRadius.circular(HarkroomSize.avatarRadius * size / HarkroomSize.avatar),
        ),
        child: Text(
          initialOf(name),
          style: TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.w600,
            fontSize: size * 0.38,
            height: 1,
          ),
        ),
      ),
    );
  }
}

/// 안 읽은 수. **0 이면 아무것도 그리지 않는다** — 빈 배지는 "뭔가 있다"는 거짓 신호다.
/// 주황이다 — 강조색을 쓰는 몇 안 되는 자리다.
class UnreadBadge extends StatelessWidget {
  const UnreadBadge({super.key, required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const SizedBox.shrink();
    final k = context.tokens;
    return Container(
      key: Key('unread-$count'),
      constraints: const BoxConstraints(minWidth: 20),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
      decoration: BoxDecoration(color: k.accent, borderRadius: BorderRadius.circular(10)),
      child: Text(
        // 세 자리가 넘으면 줄인다 — 정확한 수보다 "많다"가 더 읽힌다.
        count > 99 ? '99+' : '$count',
        textAlign: TextAlign.center,
        style: const TextStyle(
            color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600, height: 1.1),
      ),
    );
  }
}

/// 화면 머리의 제목 + 부제. `AppBar(title: ScreenTitle(...))` 로 쓴다.
///
/// 부제가 없으면 한 줄이다. 있으면 **제목 15 굵게 / 부제 11 회색** — 두 줄이 한 덩어리로
/// 읽혀야 머리가 높아지지 않는다.
class ScreenTitle extends StatelessWidget {
  const ScreenTitle({super.key, required this.title, this.subtitle});

  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final head = Text(
      title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(fontSize: HarkroomType.screenTitle, fontWeight: FontWeight.w700, color: k.fg),
    );
    final sub = subtitle;
    if (sub == null || sub.isEmpty) return head;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        head,
        Text(
          sub,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: HarkroomType.screenSubtitle, color: k.mute),
        ),
      ],
    );
  }
}

/// 상태 띠의 종류. 색이 아니라 **뜻**으로 고른다 — 화면이 색을 고르면 같은 뜻이 화면마다
/// 다른 색이 된다.
enum BandTone { warn, error, info }

/// 머리 바로 아래 한 줄 띠(끊김·세션 저장 실패 같은 것). 오른쪽에 행동 하나를 둘 수 있다.
///
/// **면을 칠하지 않는다**: 옅은 바탕 + 진한 글자. 짙은 빨강 면은 "앱이 고장났다"로 읽히는데,
/// 띠가 말하는 것은 대개 "기다리면 낫는다"다.
class StatusBand extends StatelessWidget {
  const StatusBand({
    super.key,
    required this.text,
    this.tone = BandTone.warn,
    this.actionLabel,
    this.onAction,
    this.onClose,
  });

  final String text;
  final BandTone tone;
  final String? actionLabel;
  final VoidCallback? onAction;

  /// 사람이 지울 수 있는 띠면 닫기 단추를 단다. 끊김 띠처럼 상태가 풀려야 사라지는 것은 단지 않는다.
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final (Color fg, Color bg) = switch (tone) {
      BandTone.warn => (k.warn, k.warnSoft),
      BandTone.error => (k.err, k.errSoft),
      BandTone.info => (k.fg, k.soft),
    };
    return Semantics(
      liveRegion: true,
      container: true,
      child: Material(
        color: bg,
        child: Padding(
          padding: EdgeInsets.fromLTRB(HarkroomSize.gutter, 6, onClose == null ? 12 : 0, 6),
          child: Row(
            children: [
              Expanded(
                child: Text(text, style: TextStyle(color: fg, fontSize: HarkroomType.meta)),
              ),
              if (actionLabel != null && onAction != null)
                TextButton(
                  onPressed: onAction,
                  style: TextButton.styleFrom(
                    foregroundColor: fg,
                    minimumSize: const Size(44, 32),
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
                  ),
                  child: Text(actionLabel!),
                ),
              if (onClose != null)
                IconButton(
                  icon: Icon(Icons.close, size: 18, color: fg),
                  onPressed: onClose,
                  tooltip: MaterialLocalizations.of(context).closeButtonTooltip,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 목록의 섹션 머리("채널" 같은 묶음 이름). 12 굵게, 위에 가는 선.
class SectionHeader extends StatelessWidget {
  const SectionHeader({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Container(
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 10, HarkroomSize.gutter, 4),
      alignment: Alignment.centerLeft,
      child: Text(
        label,
        style: TextStyle(fontSize: HarkroomType.section, fontWeight: FontWeight.w700, color: k.fg),
      ),
    );
  }
}
