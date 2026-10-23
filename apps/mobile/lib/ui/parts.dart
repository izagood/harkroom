import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/app_scope.dart';
import '../theme.dart';
import 'tokens.dart';

/// 공통 부품. 화면들이 같은 것을 **각자 다시 짓지 않게** 한 곳에 둔다 — 뒤의 PR(상태 화면·
/// 메시지 줄·탭 구조)이 모두 이것을 쓴다.

/// 둥근 사각 아바타. 사진이 걸린 계정이면 **사진**을, 없으면 **이름의 첫 글자 + id 로 정해지는 색**이다.
///
/// 사진은 계정 표(`AppState.accounts`)의 `avatarAttachmentId` 로 찾는다 — 부르는 자리(열댓 곳)가 각자 사진을 넘기면
/// 한 곳만 빠뜨려도 그 자리만 글자로 남는다. 이 부품이 한동안 **사진을 아예 그리지 않았다**: 모델은 id 를 받는데
/// 그리는 곳이 안 써서, 데스크톱에서 사진을 올려도 모바일은 늘 글자였다(10-14 소유자 신고).
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

  /// 사진을 풀 최대 픽셀(가로·세로 각각). 그릴 크기 × dpr × 2 — 위 `ResizeImage` 주석.
  int decodePx(BuildContext context) => (size * MediaQuery.devicePixelRatioOf(context) * 2).round();

  /// 모서리 반지름. 크기에 **비례**한다(36px 에서 10px) — 데스크톱도 이 비율을 따른다.
  double get radius => HarkroomRadius.avatar * size / HarkroomSize.avatar;

  @override
  Widget build(BuildContext context) {
    // AppScope 가 없는 자리(시험·로그인 전 화면)에서는 글자만 그린다.
    final app = context.dependOnInheritedWidgetOfExactType<AppScope>()?.notifier;
    final attachmentId = app?.accounts[id]?.avatarAttachmentId;
    final api = app?.api;
    final initials = _initials();
    if (attachmentId == null || api == null) return initials;
    return Semantics(
      excludeSemantics: true,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        // 사진 뒤에 바탕을 깐다 — 투명 로고·SVG 가 채팅 바탕색에 녹지 않게. 데스크톱 `Identity` 가 사진 뒤에
        // `bg-surface-hover` 를 까는 것과 같다(designer n1). 테마가 없는 자리(시험)는 바탕 없이.
        child: ColoredBox(
          color: Theme.of(context).extension<HarkroomTokens>()?.surfaceHover ?? Colors.transparent,
          child: Image(
          key: ValueKey('avatar-photo-$attachmentId'),
          // **디코드를 그릴 크기에 묶는다**(security F1·designer n2). 서버는 래스터 아바타의 픽셀 수를 막지 않으므로
          // (옛 사진·옛 앱·PAT 로 올린 사진은 512 로 잘리지 않는다) 원본 해상도로 풀면 그 사람이 나오는 화면마다
          // 메모리가 터질 수 있다. `fit` 이라 가로세로 둘 다 상한 안에 들고 비율은 지킨다. 상한을 그릴 크기의 두 배로
          // 잡아, 2:1 까지의 사진은 `cover` 로 잘라도 짧은 변이 그릴 크기 × dpr 아래로 내려가지 않는다.
          image: ResizeImage(
            NetworkImage(api.avatarUrl(id, attachmentId), headers: api.authHeaders),
            width: decodePx(context),
            height: decodePx(context),
            policy: ResizeImagePolicy.fit,
          ),
          width: size,
          height: size,
          fit: BoxFit.cover,
          // 받는 동안·못 받으면 글자 — 빈 칸이 깜박이지 않게.
          frameBuilder: (context, child, frame, sync) => frame == null && !sync ? initials : child,
          errorBuilder: (context, error, stack) => initials,
          ),
        ),
      ),
    );
  }

  Widget _initials() {
    return Semantics(
      // 아바타는 이름 옆에 있다 — 읽어 주면 이름을 두 번 읽는다.
      excludeSemantics: true,
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: colorFor(id),
          borderRadius: BorderRadius.circular(radius),
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
      decoration: BoxDecoration(color: k.accent, borderRadius: BorderRadius.circular(HarkroomRadius.full)),
      child: Text(
        // 세 자리가 넘으면 줄인다 — 정확한 수보다 "많다"가 더 읽힌다.
        count > 99 ? '99+' : '$count',
        textAlign: TextAlign.center,
        style: TextStyle(
            color: k.fgOnStrong, fontSize: 11, fontWeight: FontWeight.w600, height: 1.1),
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
      style: TextStyle(fontSize: HarkroomType.name, fontWeight: FontWeight.w600, color: k.fg),
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
          style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted),
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
      BandTone.warn => (k.warning, k.warningSurface),
      BandTone.error => (k.danger, k.dangerSurface),
      BandTone.info => (k.fg, k.surfaceSunken),
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
        style: TextStyle(fontSize: HarkroomType.meta, fontWeight: FontWeight.w600, color: k.fg),
      ),
    );
  }
}

/// 보내기 버튼의 모양. **주황 원 + [HarkroomTokens.fgOnStrong] 화살표**다(재설계 §3.4) — 보내기는
/// 강조색을 쓰는 몇 안 되는 자리다. 채널·스레드 두 작성칸이 같은 것을 쓴다.
/// 작성칸 테두리. 둥근 칸, 쉴 때 1px 선 · 포커스일 때 1px 회색(개정판 3.4 — 주황 2px 테두리는
/// 보내기 버튼과 강조가 겹쳤다).
InputDecoration composerDecoration(BuildContext context, String hint) {
  // 칸에는 선을 긋지 않는다 — 둘레는 [ComposerPill] 이 그린다(하단 네비 D5). 선이 둘이면 알약 안에 알약이다.
  return InputDecoration(
    hintText: hint,
    isDense: true,
    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
    border: InputBorder.none,
    enabledBorder: InputBorder.none,
    focusedBorder: InputBorder.none,
  );
}

/// 작성칸이 자랄 수 있는 키의 몫 — 키보드 위 남은 높이의 40%(입력창 자동 높이, 2026-10-21).
///
/// 옛 규칙은 `maxLines: 5` 였다. 다섯 줄은 길게 쓰는 글에 너무 낮아 쓰는 내내 칸 안을 위아래로
/// 굴려야 했고, 줄 수로 못박으면 화면이 큰 기기에서도 똑같이 낮다. 그래서 줄이 아니라 **남은
/// 높이**로 상한을 잡는다. 40% 인 이유: 나머지 60% 에 대화가 남아야 무엇에 답하는지 보면서 쓴다.
const double composerGrowShare = 0.4;

/// 작성칸 글자 칸의 최대 키(px). 키보드가 오르내리면 [MediaQuery] 가 바뀌어 다시 잰다.
///
/// **[context] 는 화면 Scaffold 의 바깥 것이어야 한다**(채널·스레드 화면 State 의 context). 채널·스레드
/// Scaffold 는 키보드만큼 몸통을 줄이면서 그 안쪽 [MediaQuery] 의 `viewInsets` 를 0 으로 지운다 —
/// 안쪽 context 로 재면 키보드가 없는 것으로 보여 상한이 화면 전체의 40% 가 된다.
///
/// 한 줄 칸보다 작게는 내려가지 않는다 — 가로 화면에서 키보드가 화면 대부분을 덮어도 칸이
/// 한 줄은 지킨다(그보다 작으면 쓰는 글자가 잘린다).
double composerMaxHeight(BuildContext context) {
  final mq = MediaQuery.of(context);
  final free = mq.size.height - mq.viewInsets.bottom - mq.padding.top - mq.padding.bottom;
  return (free * composerGrowShare).clamp(composerMinHeight, double.infinity);
}

/// 한 줄 작성칸의 대략 키 — [composerDecoration] 의 위아래 여백 10+10 에 한 줄(약 24)을 더한 값.
const double composerMinHeight = 44;

/// 채널·스레드 작성칸이 같이 쓰는 **자라는 글자 칸.** 한 줄에서 시작해 줄이 늘면 위로 자라고
/// ([ComposerPill] 이 화면 아래에 붙어 있으므로 키가 늘면 위로 커진다), [composerMaxHeight] 를
/// 넘으면 그때부터 칸 안에서 굴러간다. 커서 줄은 [TextField] 가 스스로 보이게 굴린다.
///
/// `maxLines: null` + 바깥 상한이 요점이다 — `maxLines` 에 숫자를 주면 상한이 줄 수가 된다.
Widget composerField({
  required Key key,
  // 화면 Scaffold 바깥의 context — [composerMaxHeight] 의 주석.
  required BuildContext context,
  required TextEditingController controller,
  required FocusNode focusNode,
  required ValueChanged<String> onChanged,
  required InputDecoration decoration,
}) {
  return ConstrainedBox(
    constraints: BoxConstraints(maxHeight: composerMaxHeight(context)),
    child: TextField(
      key: key,
      controller: controller,
      focusNode: focusNode,
      onChanged: onChanged,
      minLines: 1,
      maxLines: null,
      textInputAction: TextInputAction.newline,
      decoration: decoration,
    ),
  );
}

/// 떠 있는 입력창 알약(하단 네비 D5, 2026-10-14). 채널·스레드가 같은 것을 쓴다.
///
/// 탭 바와 같은 바탕·그림자·테두리라 아래 막대와 한 묶음으로 읽힌다. 좌우 여백은 탭 바와 같은 12,
/// 아래는 6 — 탭 바가 있으면 탭 바 위 6, 키보드가 올라오면 키보드 위 6([floatingBarInset] 이 그 아래를 비운다).
class ComposerPill extends StatelessWidget {
  const ComposerPill({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final b = Theme.of(context).brightness;
    const shape = RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(HarkroomRadius.pill)));
    return Padding(
      key: const Key('composer-pill'),
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
      child: DecoratedBox(
        decoration: ShapeDecoration(
          shape: shape.copyWith(side: HarkroomShadow.floatBorder(b)),
          shadows: HarkroomShadow.float(b),
        ),
        child: Material(
          color: k.surface,
          shape: shape,
          clipBehavior: Clip.antiAlias,
          child: Padding(padding: const EdgeInsets.fromLTRB(2, 4, 4, 4), child: child),
        ),
      ),
    );
  }
}

/// [soft] 는 보낼 글이 없을 때의 흐린 모양(잠긴 모양과 같은 색).
ButtonStyle sendButtonStyle(BuildContext context, {bool soft = false}) {
  final k = context.tokens;
  return IconButton.styleFrom(
    backgroundColor: soft ? k.surfaceRaised : k.accent,
    foregroundColor: soft ? k.fgMuted : k.fgOnStrong,
    disabledBackgroundColor: k.surfaceRaised,
    disabledForegroundColor: k.fgMuted,
    minimumSize: const Size(40, 40),
  );
}

/// 반투명 머리(하단 네비 D3, 2026-10-14) — 전체 폭 띠, 바탕 72% + 흐림 14 + 아래 선 70%(시안 `.glass`).
///
/// 몸통이 그 밑으로 흐르려면 Scaffold 에 `extendBodyBehindAppBar: true` 를 주고 몸통은 [GlassBody] 로 감싼다.
class GlassAppBar extends StatelessWidget implements PreferredSizeWidget {
  const GlassAppBar({super.key, required this.bar});

  final AppBar bar;

  @override
  Size get preferredSize => bar.preferredSize;

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<bool>(
        valueListenable: ReduceTransparency.enabled,
        builder: (context, reduce, _) {
          final contrast = MediaQuery.highContrastOf(context);
          return _build(context, opaque: reduce || contrast, contrast: contrast);
        },
      );

  Widget _build(BuildContext context, {required bool opaque, required bool contrast}) {
    final k = context.tokens;
    final theme = Theme.of(context);
    // iOS 「투명도 줄이기」·「대비 증가」면 흐림을 걷고 불투명 머리로(designer g1) — 그 설정을 켠 사람은
    // 뒤가 비치는 면을 읽기 어려워서 켰다. 자리·높이는 그대로라 몸통 배치는 바뀌지 않는다.
    if (opaque) {
      return DecoratedBox(
        key: const Key('glass-app-bar'),
        // 「대비 증가」면 아래 선도 한 단 진하게(designer #1372 g1-1) — 옅은 선은 그 설정을 켠 사람에게 안 보인다.
        decoration: BoxDecoration(color: k.surface, border: Border(bottom: BorderSide(color: contrast ? k.fgSubtle : k.border))),
        child: Theme(
          data: theme.copyWith(
            appBarTheme: theme.appBarTheme.copyWith(
              backgroundColor: Colors.transparent,
              shape: const RoundedRectangleBorder(),
              systemOverlayStyle: statusBarStyle(theme.brightness),
            ),
          ),
          child: bar,
        ),
      );
    }
    return ClipRect(
      child: BackdropFilter(
        key: const Key('glass-app-bar-blur'),
        filter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14),
        child: DecoratedBox(
          key: const Key('glass-app-bar'),
          decoration: BoxDecoration(
            color: k.surface.withValues(alpha: 0.72),
            border: Border(bottom: BorderSide(color: k.border.withValues(alpha: 0.7))),
          ),
          child: Theme(
            // 바탕·선은 위 상자가 그린다 — AppBar 는 비운다.
            data: theme.copyWith(
              appBarTheme: theme.appBarTheme.copyWith(
                backgroundColor: Colors.transparent,
                shape: const RoundedRectangleBorder(),
                // 투명 AppBar 는 상태바를 흰 글자로 짐작한다 — 테마 밝기로 정한다(statusBarStyle).
                systemOverlayStyle: statusBarStyle(theme.brightness),
              ),
            ),
            child: bar,
          ),
        ),
      ),
    );
  }
}

/// iOS 「투명도 줄이기」(손쉬운 사용 › 디스플레이). Flutter 는 이 설정을 넘겨주지 않아서
/// (`AccessibilityFeatures` 에는 고대비만 있다) `harkroom/device` 채널로 직접 묻는다. 앱이 켜질 때와
/// 앞으로 돌아올 때마다 다시 읽는다 — 설정 앱에서 바꾸고 돌아오는 것이 바꾸는 유일한 길이다.
abstract final class ReduceTransparency {
  static final enabled = ValueNotifier<bool>(false);
  static const _device = MethodChannel('harkroom/device');

  /// 묻지 못하면(안드로이드·시험·옛 네이티브) 꺼진 것으로 본다 — 반투명이 기본 사양이다.
  static Future<void> refresh() async {
    try {
      enabled.value = await _device.invokeMethod<bool>('reduceTransparency') ?? false;
    } on Object {
      enabled.value = false;
    }
  }
}

/// 반투명 머리 밑의 몸통. [header](끊김 띠·모델 바처럼 늘 위에 서는 것)는 머리 바로 밑에 겹쳐 세우고,
/// [builder] 의 목록은 화면 맨 위부터 그려 머리·[header] 밑으로 흐르게 한다. [builder] 가 받는 `top` 이
/// 목록 위쪽에 비울 여백이다(머리 + [header] 높이) — 맨 위까지 굴려도 첫 줄이 가려지지 않는다.
class GlassBody extends StatefulWidget {
  const GlassBody({super.key, required this.header, required this.builder});

  final Widget header;
  final Widget Function(BuildContext context, double top) builder;

  @override
  State<GlassBody> createState() => _GlassBodyState();
}

class _GlassBodyState extends State<GlassBody> {
  final _headerKey = GlobalKey();
  double _header = 0;

  void _measure() {
    final h = _headerKey.currentContext?.size?.height ?? 0;
    if (mounted && h != _header) setState(() => _header = h);
  }

  @override
  Widget build(BuildContext context) {
    // 띠는 생겼다 사라진다(끊김) — 그릴 때마다 다음 프레임에 높이를 다시 잰다.
    WidgetsBinding.instance.addPostFrameCallback((_) => _measure());
    final top = MediaQuery.paddingOf(context).top;
    return Stack(
      children: [
        Positioned.fill(
          child: MediaQuery.removePadding(
            context: context,
            removeTop: true,
            child: Builder(builder: (context) => widget.builder(context, top + _header)),
          ),
        ),
        Positioned(top: top, left: 0, right: 0, child: KeyedSubtree(key: _headerKey, child: widget.header)),
      ],
    );
  }
}
