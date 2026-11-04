import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/thread_plan.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../time.dart';
import '../ui/tokens.dart';
import 'message_link.dart';
import 'tab_nav.dart';
import 'thread_screen.dart';

/// 스레드 계획판 — 칩·버튼·시트(개선 시안 v3, 데스크톱 `ThreadPlanBand`·`PlanChip` 의 폰 판).
///
/// 파생 상태는 서버 값을 그대로 쓴다. 제목·목표·사유는 남이 쓴 글이라 **`Text` 로만** 그린다 — 마크다운·링크로 해석하지 않는다.
/// 펼침은 기억하지 않는다: 시트가 작성칸을 덮으므로 스레드에 들어올 때는 늘 닫혀 있다.

double _textWidth(BuildContext context, String text, TextStyle style) {
  final painter = TextPainter(
    text: TextSpan(text: text, style: DefaultTextStyle.of(context).style.merge(style)),
    textDirection: Directionality.of(context),
    textScaler: MediaQuery.textScalerOf(context),
    maxLines: 1,
  )..layout();
  final width = painter.width;
  painter.dispose();
  return width;
}

/// 스레드 요약 줄에 칩이 설 때의 자리 나누기(시안 v3) — 「답글 n개」와 칩은 남기고, 좁으면 시각부터 줄여 지운다.
/// 그래도 모자라면 참여자 아바타를 뒤에서부터 뺀다(320pt 에 아바타 셋 + 「· 막힘 n」 이면 실제로 모자란다).
class PlanSummaryLayout {
  const PlanSummaryLayout({required this.avatars, required this.replyMax, required this.chipMax});

  final int avatars;
  final double replyMax;
  final double chipMax;

  static const double avatarWidth = 21;
  static const double chipGap = 6;

  /// 순수 계산 — 폭과 잰 값만으로 정한다. 줄 하나가 어떤 글자 크기에서도 넘치지 않는다.
  static PlanSummaryLayout resolve({required double width, required double reply, required double chip, required int participants}) {
    final replyMax = math.min(reply, width * 0.5);
    final chipMax = math.max(0.0, width - replyMax - chipGap);
    final room = width - replyMax - chipGap - chip - 3;
    final avatars = room <= 0 ? 0 : math.min(participants, room ~/ avatarWidth);
    return PlanSummaryLayout(avatars: avatars, replyMax: replyMax, chipMax: chipMax);
  }

  static PlanSummaryLayout of(BuildContext context, double width, String reply, TextStyle replyStyle, PlanCounts p, int participants) => resolve(
        width: width,
        reply: _textWidth(context, reply, replyStyle) + 1,
        chip: PlanChip.widthOf(context, p),
        participants: participants,
      );
}

/// 계획 칩(D2) — 「계획 n/N」 + 작은 막대. **막힘만 빨강**이고 「· 막힘 n」 글자를 함께 단다.
/// [compact] 는 시트 머리처럼 「계획」 글자와 막대를 뺀 꼴이다. 단계가 없으면 부르는 쪽이 그리지 않는다.
class PlanChip extends StatelessWidget {
  const PlanChip({super.key, required this.progress, this.compact = false});

  final PlanCounts progress;
  final bool compact;

  /// 칩 하나가 차지하는 폭(말줄임 없을 때) — 좁은 요약 줄이 무엇을 줄일지 정할 때 쓴다.
  static double widthOf(BuildContext context, PlanCounts p) {
    final t = context.t;
    final base = t.planChip(p.done, p.total);
    final label = p.blocked > 0 ? '$base ${t.planChipBlocked(p.blocked)}' : base;
    return _textWidth(context, label, const TextStyle(fontSize: HarkroomType.meta, fontWeight: FontWeight.w500)) + 12 + 5 + 28;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final p = progress;
    final tone = planTone(p);
    final fg = switch (tone) {
      PlanTone.blocked => k.stateStuck,
      PlanTone.done => k.fgSubtle,
      _ => k.fgMuted,
    };
    final bar = switch (tone) {
      PlanTone.blocked => k.stateStuck,
      PlanTone.done => k.stateDone,
      _ => k.stateRunning,
    };
    final base = compact ? '${p.done}/${p.total}' : t.planChip(p.done, p.total);
    final label = p.blocked > 0 ? '$base ${t.planChipBlocked(p.blocked)}' : base;
    return Semantics(
      label: [t.planChipSemantics(p.done, p.total), if (p.blocked > 0) t.planBlockedSemantics(p.blocked)].join(', '),
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        decoration: BoxDecoration(
          color: tone == PlanTone.blocked ? k.dangerSurface : null,
          borderRadius: BorderRadius.circular(HarkroomRadius.sm + 2),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              softWrap: false,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: fg, fontSize: HarkroomType.meta, fontWeight: FontWeight.w500),
            ),
          ),
          if (!compact) ...[
            const SizedBox(width: 5),
            // 막대는 꾸밈이다(VoiceOver 는 위 라벨만 읽는다). 바탕에 묻히지 않게 1px 테두리를 둔다.
            Container(
              key: const Key('plan-chip-bar'),
              width: 28,
              height: 5,
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: k.surfaceSunken,
                borderRadius: BorderRadius.circular(HarkroomRadius.full),
                border: Border.all(color: k.border, width: 0.5),
              ),
              alignment: Alignment.centerLeft,
              child: FractionallySizedBox(
                widthFactor: p.total == 0 ? 0 : math.min(1, p.done / p.total),
                heightFactor: 1,
                child: ColoredBox(color: bar),
              ),
            ),
          ],
        ]),
      ),
    );
  }
}

/// 떠 있는 버튼의 높이(W9, 누르는 자리 44).
const double planButtonHeight = 44;

/// 버튼이 서 있는가. 계획이 없거나 단계가 없으면, 또는 키보드가 올라와 있으면 없다(입력하는 자리를 가리지 않게).
bool planButtonVisible(PlanCounts? progress, {required bool keyboardOpen}) => planTone(progress) != PlanTone.empty && !keyboardOpen;

/// 스레드 작성칸 위 오른쪽에 뜨는 계획판 버튼(시안 v3 W5·W9). 누르면 시트가 열린다.
///
/// **부를 길은 루트 행의 `planProgress` 뿐이다** — 옛 서버나 계획 없는 스레드에서는 버튼이 없고 GET 도 없다.
/// 판을 받는 곳은 이 버튼 하나다(데스크톱 R1). 칩은 판을 받은 뒤 개인 진행률을 쓴다(R2). 키보드 때 숨어도 판은 받는다.
class ThreadPlanButton extends StatefulWidget {
  const ThreadPlanButton({super.key, required this.rootId, required this.progress, required this.keyboardOpen});

  final String rootId;
  final PlanProgressMark? progress;

  /// 부르는 쪽이 Scaffold **바깥**에서 읽어 준다 — Scaffold 안의 `viewInsets` 는 0 으로 지워져 있다(`GlassBody` 주석).
  final bool keyboardOpen;

  @override
  State<ThreadPlanButton> createState() => _ThreadPlanButtonState();
}

class _ThreadPlanButtonState extends State<ThreadPlanButton> {
  /// 마지막으로 살펴본 rev·시각. 값이 바뀔 때만 다시 받는다 — 실패해도 매 프레임 두드리지 않는다.
  String? _checked;

  void _sync(AppState app) {
    final mark = widget.progress!;
    final key = '${widget.rootId}|${mark.rev}|${mark.updatedAt?.toIso8601String()}';
    if (key == _checked) return;
    _checked = key;
    if (!planNeedsFetch(app.threadPlans[widget.rootId], mark)) return;
    // 빌드 중에 알리면 "빌드 중 setState" 가 된다.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(app.loadThreadPlan(widget.rootId));
    });
  }

  @override
  Widget build(BuildContext context) {
    final mark = widget.progress;
    if (planTone(mark) == PlanTone.empty) {
      _checked = null;
      return const SizedBox.shrink();
    }
    final app = context.app;
    _sync(app);
    if (!planButtonVisible(mark, keyboardOpen: widget.keyboardOpen)) return const SizedBox.shrink();
    final t = context.t;
    final k = context.tokens;
    final plan = app.threadPlans[widget.rootId];
    final PlanCounts counts = plan != null && plan.progress.total > 0 ? plan.progress : mark!;
    void open() => openThreadPlanSheet(context, widget.rootId);
    return Semantics(
      button: true,
      excludeSemantics: true,
      label: [t.planChipSemantics(counts.done, counts.total), if (counts.blocked > 0) t.planBlockedSemantics(counts.blocked)].join(', '),
      hint: t.planOpenHint,
      onTap: open,
      child: Material(
        key: const Key('plan-button'),
        color: k.surfaceRaised,
        elevation: 3,
        shape: StadiumBorder(side: BorderSide(color: k.border)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: const Key('plan-button-open'),
          onTap: open,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: planButtonHeight, maxWidth: MediaQuery.sizeOf(context).width - 32),
            child: Padding(
              padding: const EdgeInsets.only(left: 10, right: 12),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                PlanStateMark(kind: planButtonKind(counts)),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    t.planChip(counts.done, counts.total),
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: k.fg, fontSize: 13, fontWeight: FontWeight.w600),
                  ),
                ),
                const SizedBox(width: 8),
                ExcludeSemantics(child: _ProgressBar(done: counts.done, total: counts.total)),
                if (counts.blocked > 0) ...[
                  const SizedBox(width: 6),
                  Text(t.planChipBlocked(counts.blocked), key: const Key('plan-button-blocked'), maxLines: 1, softWrap: false,
                      style: TextStyle(color: k.stateStuck, fontSize: 13, fontWeight: FontWeight.w600)),
                ],
                const SizedBox(width: 4),
                Icon(Icons.expand_less, size: 18, color: k.fgSubtle),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _ProgressBar extends StatelessWidget {
  const _ProgressBar({required this.done, required this.total});

  final int done;
  final int total;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Container(
      width: 36,
      height: 5,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: k.surfaceSunken,
        borderRadius: BorderRadius.circular(HarkroomRadius.full),
        border: Border.all(color: k.border, width: 0.5),
      ),
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: total == 0 ? 0 : math.min(1, done / total),
        heightFactor: 1,
        child: ColoredBox(color: k.success),
      ),
    );
  }
}

/// 알약 글자 — 데스크톱 `plan.pill.*` 와 같다.
String planPillLabel(Strings t, PlanPill p) => switch (p.key) {
      PlanPillKey.done => t.planPillDone(p.title),
      PlanPillKey.blocked => t.planPillBlocked(p.title, p.done, p.total),
      PlanPillKey.mine => t.planPillMine(p.title, p.n),
      PlanPillKey.active => t.planPillActive(p.title, p.n, p.done, p.total),
      PlanPillKey.waiting => t.planPillWaiting(p.title),
      PlanPillKey.waitingCount => t.planPillWaitingCount(p.title, p.done, p.total),
      PlanPillKey.count => t.planPillCount(p.title, p.done, p.total),
      PlanPillKey.plain => p.title,
    };

/// 상태 표지(V1·V2) — 채운 원 18pt + 흰 기호: 끝 ✓ · 진행 ▶ · 막힘 ! · 내 차례 사람. 빈 원: 시작 가능 ▷ · 대기 점선 · 볼 수 없음 성긴 점선.
/// 채운 것과 빈 것이 크기·면만으로 두 무리로 갈리고, 기호로 다시 갈린다. VoiceOver 는 글자로 읽는다.
class PlanStateMark extends StatelessWidget {
  const PlanStateMark({super.key, required this.kind, this.size = 18});

  final PlanRowKind kind;
  final double size;

  static String label(Strings t, PlanRowKind k) => switch (k) {
        PlanRowKind.done => t.planStateDone,
        PlanRowKind.active => t.planStateActive,
        PlanRowKind.blocked => t.planStateBlocked,
        PlanRowKind.mine => t.planRowMine,
        PlanRowKind.ready => t.planStateReady,
        PlanRowKind.waiting => t.planStateWaiting,
        PlanRowKind.hidden => t.planStateHidden,
      };

  @override
  Widget build(BuildContext context) => Semantics(
        label: label(context.t, kind),
        excludeSemantics: true,
        child: SizedBox.square(
          dimension: size,
          child: CustomPaint(painter: _MarkPainter(kind: kind, tokens: context.tokens)),
        ),
      );
}

class _MarkPainter extends CustomPainter {
  _MarkPainter({required this.kind, required this.tokens});

  final PlanRowKind kind;
  final HarkroomTokens tokens;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 18);
    const c = Offset(9, 9);
    final white = Paint()..color = Colors.white;
    Paint line(Color color, double w) => Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = w
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color;
    void disc(Color color) => canvas.drawCircle(c, 9, Paint()..color = color);
    void dashed(Color color, double w, int n, double part) {
      for (var i = 0; i < n; i++) {
        canvas.drawArc(Rect.fromCircle(center: c, radius: 8), i * 2 * math.pi / n, part * 2 * math.pi / n, false, line(color, w));
      }
    }

    switch (kind) {
      case PlanRowKind.done:
        disc(tokens.success);
        canvas.drawPath(Path()..moveTo(5, 9.3)..lineTo(8, 12.2)..lineTo(13, 6.5), line(Colors.white, 2));
      case PlanRowKind.active:
        disc(tokens.stateActive);
        canvas.drawPath(Path()..moveTo(7, 5.2)..lineTo(7, 12.8)..lineTo(13, 9)..close(), white);
      case PlanRowKind.blocked:
        disc(tokens.stateStuck);
        canvas.drawLine(const Offset(9, 4.5), const Offset(9, 10.1), line(Colors.white, 2.2));
        canvas.drawCircle(const Offset(9, 13.2), 1.3, white);
      case PlanRowKind.mine:
        disc(tokens.accent);
        canvas.drawCircle(const Offset(9, 6.6), 2.6, white);
        canvas.drawPath(
          Path()..moveTo(4.4, 14.2)..arcToPoint(const Offset(13.6, 14.2), radius: const Radius.circular(4.6))..close(),
          white,
        );
      case PlanRowKind.ready:
        canvas.drawCircle(c, 8, line(tokens.stateWaiting, 1.6));
        canvas.drawPath(Path()..moveTo(7.4, 5.8)..lineTo(7.4, 12.2)..lineTo(12.4, 9)..close(), Paint()..color = tokens.fgMuted);
      case PlanRowKind.waiting:
        dashed(tokens.stateWaiting, 1.6, 10, 0.5);
      case PlanRowKind.hidden:
        dashed(tokens.fgSubtle, 1.4, 8, 0.2);
    }
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.kind != kind || old.tokens != tokens;
}

/// 빨강만으로 말하지 않는다. 표지가 이미 읽히므로 VoiceOver 에는 겹쳐 읽히지 않게 한다.
class _BlockedTag extends StatelessWidget {
  const _BlockedTag();

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return ExcludeSemantics(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        decoration: BoxDecoration(
          border: Border.all(color: k.stateStuck),
          borderRadius: BorderRadius.circular(HarkroomRadius.sm + 1),
        ),
        child: Text(context.t.planStateBlocked, style: TextStyle(color: k.stateStuck, fontSize: 11)),
      ),
    );
  }
}

/// 처음 높이와 끌어 올린 높이(시안 v3). 끌어 내리면 닫힌다.
const double planSheetInitial = 0.78;
const double planSheetMax = 0.93;
const double planSheetMin = 0.2;

/// 계획 시트를 연다. [opener] 는 시트를 연 쪽의 context 다 — 글·연결 스레드로 갈 때 시트를 닫은 뒤 그 쌓기에 민다.
Future<void> openThreadPlanSheet(BuildContext opener, String rootId) {
  final app = AppScope.read(opener);
  // 버튼이 못 받았으면(실패·아직 안 옴) 여기서 다시 부른다. 받아 둔 판이 있으면 그대로 연다.
  if (app.threadPlans[rootId] == null) unawaited(app.loadThreadPlan(rootId));
  final dark = Theme.of(opener).brightness == Brightness.dark;
  return showModalBottomSheet<void>(
    context: opener,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: opener.tokens.surfaceRaised,
    barrierColor: Colors.black.withValues(alpha: dark ? 0.5 : 0.32),
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
    builder: (_) => _PlanSheet(opener: opener, rootId: rootId),
  );
}

class _PlanSheet extends StatefulWidget {
  const _PlanSheet({required this.opener, required this.rootId});

  final BuildContext opener;
  final String rootId;

  @override
  State<_PlanSheet> createState() => _PlanSheetState();
}

class _PlanSheetState extends State<_PlanSheet> {
  final _sheet = DraggableScrollableController();
  final _contentKey = GlobalKey();
  final _headKey = GlobalKey();
  bool _fitted = false;

  /// 사람이 접은 그룹. 처음엔 모두 펼친다(W1). 이 시트 안에서만 산다(기억하지 않는다, W8).
  final Set<String> _collapsed = {};
  final Set<String> _whyOpen = {};
  final Map<String, GlobalKey> _nodeKeys = {};

  /// 지금 깜빡일 노드. 번호가 바뀌면 [HitFlash] 를 새로 세워 다시 깜빡인다.
  String? _flashId;
  int _flashNo = 0;
  ({PlanRowKind kind, int index})? _cycle;

  @override
  void dispose() {
    _sheet.dispose();
    super.dispose();
  }

  GlobalKey _keyOf(String id) => _nodeKeys.putIfAbsent(id, GlobalKey.new);

  /// 그 노드로 스크롤하고 깜빡인다(접힌 그룹이면 편다). [why] 면 「막힌 까닭」까지 편다.
  void _goTo(ThreadPlanView plan, String id, {bool why = false}) {
    String? groupId;
    for (final s in plan.steps) {
      if (s.id == id) groupId = s.groupId;
    }
    setState(() {
      if (groupId != null) _collapsed.remove(groupId);
      if (why) _whyOpen.add(id);
      _flashId = id;
      _flashNo++;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _nodeKeys[id]?.currentContext;
      if (target != null && target.mounted) {
        unawaited(Scrollable.ensureVisible(target, alignment: 0.2, duration: HarkroomMotion.base, curve: HarkroomMotion.ease));
      }
    });
  }

  void _pressChip(ThreadPlanView plan, Map<PlanRowKind, List<String>> lists, PlanRowKind kind) {
    final ids = lists[kind] ?? const <String>[];
    final index = nextCycleIndex(ids.length, _cycle?.kind == kind ? _cycle!.index : null);
    if (index < 0) return;
    _cycle = (kind: kind, index: index);
    _goTo(plan, ids[index], why: kind == PlanRowKind.blocked);
  }

  void _pressPill(ThreadPlanView plan, PlanPill p, String? me) {
    if (p.state == PlanState.blocked) {
      for (final s in plan.stepsOf(p.id)) {
        if (stepKind(plan, s, me) == PlanRowKind.blocked) {
          _goTo(plan, s.id, why: true);
          return;
        }
      }
    }
    _goTo(plan, p.id);
  }

  /// 앞 노드로 간다. 다른 스레드에 이어진 그룹이면 그 스레드를 연다.
  void _pressWaiting(ThreadPlanView plan, String id) {
    final linked = plan.linkedOf(id);
    if (linked != null && !linked.hidden && linked.channelId != null) {
      unawaited(_openLinked(linked));
      return;
    }
    _goTo(plan, id);
  }

  /// 글로 간다 — 시트를 닫아 그 글을 가리지 않게 한다(W7).
  void _goToMessage(String id) {
    final opener = widget.opener;
    Navigator.of(context).pop();
    if (opener.mounted) unawaited(openMessageLink(opener, id));
  }

  /// 내용이 짧으면 내용 높이까지만 연다(시안 v3). 판을 처음 그린 뒤 한 번만 잰다 — 그 뒤 접고 펴도 높이를 흔들지 않는다.
  void _fitOnce() {
    if (_fitted) return;
    _fitted = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_sheet.isAttached) return;
      final head = _headKey.currentContext?.size?.height;
      final content = _contentKey.currentContext?.size?.height;
      if (head == null || content == null) return;
      final inset = MediaQuery.paddingOf(context).bottom;
      final want = _sheet.pixelsToSize(head + content + inset);
      if (want < planSheetInitial) _sheet.jumpTo(math.max(planSheetMin, want));
    });
  }

  /// 머리는 스크롤 밖에 있어 따로 끈다 — 끌어 올리면 커지고, 끌어 내리면 닫힌다.
  void _dragHead(DragUpdateDetails d) {
    if (!_sheet.isAttached) return;
    final next = _sheet.size - _sheet.pixelsToSize(d.primaryDelta ?? 0);
    _sheet.jumpTo(next.clamp(planSheetMin, planSheetMax));
  }

  void _dragHeadEnd(DragEndDetails d) {
    if (!_sheet.isAttached) return;
    if ((d.primaryVelocity ?? 0) > 700 || _sheet.size <= planSheetMin + 0.02) Navigator.of(context).pop();
  }

  Future<void> _openLinked(PlanLinked l) async {
    final channelId = l.channelId;
    if (channelId == null) return;
    final opener = widget.opener;
    final nav = Navigator.of(opener);
    final app = AppScope.read(opener);
    Navigator.of(context).pop();
    await app.openChannel(channelId);
    if (!opener.mounted) return;
    unawaited(openChannelScreen(opener, channelId, navigator: nav, (_) => ThreadScreen(channelId: channelId, rootId: l.rootId)));
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final plan = app.threadPlans[widget.rootId];
    final failed = app.threadPlanFailed.contains(widget.rootId);
    final me = app.me?.id;
    if (plan != null) _fitOnce();
    return DraggableScrollableSheet(
      controller: _sheet,
      expand: false,
      initialChildSize: planSheetInitial,
      minChildSize: planSheetMin,
      maxChildSize: planSheetMax,
      builder: (context, scroll) => LayoutBuilder(builder: (context, box) => Column(
        key: const Key('plan-sheet'),
        children: [
          // 머리는 고정이다(W4·W9) — 칩이 스크롤에 밀려 사라지면 차례로 가는 길도 사라진다.
          // 끌어 내려 시트가 머리보다 작아지면 넘치지 않게 잘라 보인다.
          GestureDetector(
            behavior: HitTestBehavior.translucent,
            onVerticalDragUpdate: _dragHead,
            onVerticalDragEnd: _dragHeadEnd,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxHeight: box.maxHeight),
              child: SingleChildScrollView(
                physics: const NeverScrollableScrollPhysics(),
                child: _SheetHead(
                  key: _headKey,
                  plan: plan,
                  app: app,
                  me: me,
                  cycle: _cycle,
                  onChip: (lists, kind) => _pressChip(plan!, lists, kind),
                  onPill: (p) => _pressPill(plan!, p, me),
                ),
              ),
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              key: const Key('plan-sheet-scroll'),
              controller: scroll,
              physics: const AlwaysScrollableScrollPhysics(),
              child: SafeArea(
                top: false,
                child: Column(
                  key: _contentKey,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: plan != null
                      ? _body(context, plan, app, me)
                      : failed
                          ? [_LoadFailed(onRetry: () => unawaited(app.loadThreadPlan(widget.rootId)))]
                          : const [_LoadingLines()],
                ),
              ),
            ),
          ),
        ],
      )),
    );
  }

  List<Widget> _body(BuildContext context, ThreadPlanView plan, AppState app, String? me) {
    final t = context.t;
    final k = context.tokens;
    return [
      if (plan.flagged)
        Padding(
          padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 8, HarkroomSize.gutter, 0),
          child: Text(t.planFlagged, key: const Key('plan-flagged'), style: TextStyle(color: k.stateStuck, fontSize: 13)),
        ),
      for (final g in plan.groups) ..._group(context, plan, g, app, me),
      for (final s in plan.stepsOf(null)) _stepNode(plan, s, app, me, grouped: false),
      if (plan.next != null || plan.blocked != null)
        Container(
          key: const Key('plan-foot'),
          margin: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 8, HarkroomSize.gutter, 12),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(color: k.surfaceSunken, borderRadius: BorderRadius.circular(HarkroomRadius.card - 2)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (plan.next != null)
              Text.rich(TextSpan(children: [
                TextSpan(text: '${t.planNext} ', style: TextStyle(color: k.fgMuted)),
                TextSpan(text: plan.next),
              ]), style: TextStyle(color: k.fg, fontSize: 13)),
            if (plan.blocked != null)
              InkWell(
                key: const Key('plan-foot-blocked'),
                onTap: () => _pressChip(plan, planLists(plan, me), PlanRowKind.blocked),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: HarkroomSize.row),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text('${t.planBlocked} ${plan.blocked}',
                        style: TextStyle(color: k.stateStuck, fontSize: 13, decoration: TextDecoration.underline, decorationStyle: TextDecorationStyle.dotted)),
                  ),
                ),
              ),
          ]),
        ),
      const SizedBox(height: 8),
    ];
  }

  Widget _flashable(String id, Widget child) => KeyedSubtree(
        key: _keyOf(id),
        child: _flashId == id ? HitFlash(key: ValueKey('plan-flash-$id-$_flashNo'), child: child) : child,
      );

  List<Widget> _group(BuildContext context, ThreadPlanView plan, PlanGroup g, AppState app, String? me) {
    final t = context.t;
    final k = context.tokens;
    final f = groupFacts(plan, g, me);
    final steps = plan.stepsOf(g.id);
    final linked = g.linkedRootId == null ? null : plan.linkedOf(g.id);
    final open = !_collapsed.contains(g.id);
    final node = plan.derived[g.id];
    final canToggle = steps.isNotEmpty;
    final childProgress = linked?.progress;
    return [
      _flashable(
        g.id,
        Semantics(
          button: canToggle,
          expanded: canToggle ? open : null,
          child: InkWell(
            key: Key('plan-group-${g.id}'),
            onTap: canToggle ? () => setState(() => open ? _collapsed.add(g.id) : _collapsed.remove(g.id)) : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: HarkroomSize.row),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter),
                child: Row(children: [
                  PlanStateMark(kind: f.kind),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Row(children: [
                      Flexible(
                        child: Text(
                          g.title,
                          maxLines: 1,
                          softWrap: false,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: f.kind == PlanRowKind.hidden ? k.fgSubtle : k.fg, fontWeight: FontWeight.w600, fontSize: HarkroomType.body),
                        ),
                      ),
                      if (g.linkedRootId == null && f.total > 0) ...[
                        const SizedBox(width: 8),
                        Text(
                          '${f.done}/${f.total}${f.active > 0 ? ' ${t.planGroupActive(f.active)}' : ''}',
                          key: Key('plan-group-count-${g.id}'),
                          style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta),
                        ),
                      ],
                      if (linked != null && !linked.hidden && childProgress != null && childProgress.total > 0) ...[
                        const SizedBox(width: 6),
                        ConstrainedBox(
                          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.4),
                          child: PlanChip(progress: childProgress),
                        ),
                      ],
                      if (f.kind == PlanRowKind.blocked) ...[const SizedBox(width: 8), const _BlockedTag()],
                    ]),
                  ),
                  if (canToggle) Icon(open ? Icons.expand_more : Icons.expand_less, size: 18, color: k.fgSubtle),
                ]),
              ),
            ),
          ),
        ),
      ),
      if (linked != null) _LinkedRow(linked: linked, title: g.title, onOpen: () => unawaited(_openLinked(linked))),
      if (node != null && node.waitingOn.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(40, 0, HarkroomSize.gutter, 2),
          child: _Waiting(plan: plan, ids: node.waitingOn, fromGroupId: g.id, onPress: (id) => _pressWaiting(plan, id)),
        ),
      if (open) for (final s in steps) _stepNode(plan, s, app, me, grouped: true),
    ];
  }

  Widget _stepNode(ThreadPlanView plan, PlanStep s, AppState app, String? me, {required bool grouped}) => _flashable(
        s.id,
        _StepRow(
          plan: plan,
          step: s,
          app: app,
          me: me,
          grouped: grouped,
          whyOpen: _whyOpen.contains(s.id),
          onToggleWhy: () => setState(() => _whyOpen.contains(s.id) ? _whyOpen.remove(s.id) : _whyOpen.add(s.id)),
          onWaiting: (id) => _pressWaiting(plan, id),
          onGo: (id, why) => _goTo(plan, id, why: why),
          onMessage: _goToMessage,
        ),
      );
}

class _SheetHead extends StatefulWidget {
  const _SheetHead({
    super.key, required this.plan, required this.app, required this.me, required this.cycle,
    required this.onChip, required this.onPill,
  });

  final ThreadPlanView? plan;
  final AppState app;
  final String? me;
  final ({PlanRowKind kind, int index})? cycle;
  final void Function(Map<PlanRowKind, List<String>>, PlanRowKind) onChip;
  final ValueChanged<PlanPill> onPill;

  @override
  State<_SheetHead> createState() => _SheetHeadState();
}

class _SheetHeadState extends State<_SheetHead> {
  bool _goalOpen = false;
  bool _flowOpen = false;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final plan = widget.plan;
    final editor = plan?.updatedBy == null ? null : widget.app.accounts[plan!.updatedBy!];
    final now = DateTime.now().toUtc();
    final meta = plan == null
        ? const <String>[]
        : [
            if (editor != null) editor.handle,
            if (plan.updatedAt != null) t.planEditedAgo(agoLabel(plan.updatedAt!, now, t)),
            t.planMetaCounts(plan.groups.length, plan.steps.length),
          ];
    final lists = plan == null ? null : planLists(plan, widget.me);
    final pills = plan == null ? const <PlanPill>[] : planPills(plan, widget.me);
    final layers = plan == null ? const <List<String>>[] : planFlow(plan);
    final flow = planFlowVisible(layers, 1 << 30);
    final pillOf = {for (final p in pills) p.id: p};
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 0, 8, 8),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: k.border))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Center(
          child: Container(
            width: 36,
            height: 5,
            margin: const EdgeInsets.only(top: 7, bottom: 2),
            decoration: BoxDecoration(color: k.surfaceHover, borderRadius: BorderRadius.circular(HarkroomRadius.full)),
          ),
        ),
        Row(children: [
          Text(t.planTitle, style: TextStyle(color: k.fg, fontSize: HarkroomType.name, fontWeight: FontWeight.w600)),
          const SizedBox(width: 8),
          Expanded(
            child: Align(
              alignment: Alignment.centerLeft,
              child: plan != null && plan.progress.total > 0 ? PlanChip(progress: plan.progress, compact: true) : null,
            ),
          ),
          IconButton(
            key: const Key('plan-sheet-close'),
            tooltip: MaterialLocalizations.of(context).closeButtonTooltip,
            icon: Icon(Icons.close, size: 18, color: k.fgMuted),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ]),
        if (plan != null) ...[
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() => _goalOpen = !_goalOpen),
              child: Text(
                plan.goal,
                key: const Key('plan-sheet-goal'),
                maxLines: _goalOpen ? null : 2,
                overflow: _goalOpen ? null : TextOverflow.ellipsis,
                style: TextStyle(color: k.fg, fontSize: HarkroomType.body),
              ),
            ),
          ),
          Text.rich(
            TextSpan(children: [
              TextSpan(text: meta.join(' · ')),
              if (isPlanStale(plan.updatedAt, now)) TextSpan(text: ' · ${t.planStale}', style: TextStyle(color: k.warning)),
            ]),
            style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta),
          ),
          const SizedBox(height: 6),
          // 상태 칩은 한 줄(가로 스크롤) — 40단계 판에서 목록 자리를 먹지 않게. 넘치는 쪽 끝을 흐린다.
          SizedBox(
            height: HarkroomSize.row,
            child: ShaderMask(
              blendMode: BlendMode.dstIn,
              shaderCallback: (r) => LinearGradient(
                colors: const [Colors.black, Colors.black, Colors.transparent],
                stops: [0, r.width <= 24 ? 0 : (r.width - 24) / r.width, 1],
              ).createShader(r),
              child: SingleChildScrollView(
                key: const Key('plan-chips'),
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.only(right: 24),
                child: Row(children: [
                  for (final kind in planChipKinds)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: _SummaryChip(
                        kind: kind,
                        n: lists![kind]!.length,
                        visiting: widget.cycle?.kind == kind ? widget.cycle!.index + 1 : null,
                        onTap: () => widget.onChip(lists, kind),
                      ),
                    ),
                ]),
              ),
            ),
          ),
          // 흐름은 한 줄로 접어 둔다. 누르면 고정 머리 안에서 편다.
          if (flow.ids.isNotEmpty) ...[
            InkWell(
              key: const Key('plan-flow-toggle'),
              onTap: () => setState(() => _flowOpen = !_flowOpen),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: HarkroomSize.row),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(_flowOpen ? t.planFlowHide : t.planFlowShow,
                      style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta, decoration: TextDecoration.underline, decorationStyle: TextDecorationStyle.dotted)),
                ),
              ),
            ),
            if (_flowOpen)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Wrap(
                  key: const Key('plan-flow'),
                  spacing: 4,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    for (var i = 0; i < flow.ids.length; i++) ...[
                      if (i > 0)
                        ExcludeSemantics(
                          child: Text(
                            layers.any((l) => l.contains(flow.ids[i]) && l.contains(flow.ids[i - 1])) ? '·' : '⟶',
                            style: TextStyle(color: k.fgSubtle, fontSize: HarkroomType.meta),
                          ),
                        ),
                      if (pillOf[flow.ids[i]] != null) _Pill(pill: pillOf[flow.ids[i]]!, onTap: () => widget.onPill(pillOf[flow.ids[i]]!)),
                    ],
                  ],
                ),
              ),
          ],
        ],
      ]),
    );
  }
}

/// 맨 위 상태 칩(V1·V3) — 누르면 그 상태 단계들을 문서 순서로 돌아가며 간다. 0 이면 흐리고 누를 수 없다.
class _SummaryChip extends StatelessWidget {
  const _SummaryChip({required this.kind, required this.n, required this.visiting, required this.onTap});

  final PlanRowKind kind;
  final int n;
  final int? visiting;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final (Color? bg, Color fg, Border? border) = switch (kind) {
      PlanRowKind.done => (k.successSurface, k.success, null),
      PlanRowKind.active => (k.stateActiveSurface, k.stateActive, null),
      PlanRowKind.blocked => (k.dangerSurface, k.stateStuck, null),
      PlanRowKind.mine => (k.accentSurface, k.accentText, null),
      PlanRowKind.ready => (null, k.fgMuted, Border.all(color: k.border)),
      _ => (null, k.fgSubtle, Border.all(color: k.border)),
    };
    return Opacity(
      opacity: n == 0 ? 0.45 : 1,
      child: Semantics(
        button: n > 0,
        enabled: n > 0,
        excludeSemantics: true,
        label: t.planSum(kind.name, n),
        onTap: n > 0 ? onTap : null,
        child: InkWell(
          key: Key('plan-chip-${kind.name}'),
          customBorder: const StadiumBorder(),
          onTap: n > 0 ? onTap : null,
          // 칩 모양은 작아도 누르는 자리는 44 다.
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: HarkroomSize.row),
            child: Align(
              widthFactor: 1,
              heightFactor: 1,
              child: Container(
                padding: const EdgeInsets.fromLTRB(4, 3, 10, 3),
                decoration: BoxDecoration(color: bg, border: border, borderRadius: BorderRadius.circular(HarkroomRadius.full)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  PlanStateMark(kind: kind, size: 14),
                  const SizedBox(width: 4),
                  Text(
                    visiting == null ? t.planSum(kind.name, n) : '${t.planSum(kind.name, n)} · ${t.planSumCycle(visiting!, n)}',
                    style: TextStyle(color: fg, fontSize: HarkroomType.meta, fontWeight: FontWeight.w600),
                  ),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.pill, required this.onTap});

  final PlanPill pill;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final (Color? bg, Color fg, Border? border) = switch (pill.key) {
      PlanPillKey.blocked => (k.dangerSurface, k.stateStuck, null),
      PlanPillKey.mine => (k.accentSurface, k.accentText, null),
      PlanPillKey.active => (k.stateActiveSurface, k.stateActive, null),
      PlanPillKey.plain => (null, k.fgMuted, null),
      _ => (null, k.fgMuted, Border.all(color: k.border)),
    };
    return InkWell(
      key: Key('plan-pill-${pill.id}'),
      customBorder: const StadiumBorder(),
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 200),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(color: bg, border: border, borderRadius: BorderRadius.circular(HarkroomRadius.full)),
          child: Text(
            '${planPillLabel(context.t, pill)}${pill.key == PlanPillKey.blocked ? ' ›' : ''}',
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: fg, fontSize: HarkroomType.meta),
          ),
        ),
      ),
    );
  }
}

class _LinkedRow extends StatelessWidget {
  const _LinkedRow({required this.linked, required this.title, required this.onOpen});

  final PlanLinked linked;
  final String title;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    const margin = EdgeInsets.fromLTRB(40, 0, HarkroomSize.gutter, 6);
    final radius = BorderRadius.circular(HarkroomRadius.card - 2);
    if (linked.hidden || linked.channelId == null) {
      // 볼 수 없으면 점선 줄만 둔다. 누를 수 없다.
      return Padding(
        padding: margin,
        child: CustomPaint(
          painter: _DashedBorder(color: k.fgSubtle, radius: HarkroomRadius.card - 2),
          child: Container(
            key: Key('plan-linked-hidden-${linked.groupId}'),
            constraints: const BoxConstraints(minHeight: 40),
            alignment: Alignment.centerLeft,
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(t.planLinkedHidden, style: TextStyle(color: k.fgSubtle, fontSize: 13)),
          ),
        ),
      );
    }
    return Padding(
      padding: margin,
      child: Material(
        color: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: k.border)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: Key('plan-open-linked-${linked.groupId}'),
          onTap: onOpen,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: HarkroomSize.row),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Row(children: [
                Expanded(child: Text(title, maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis, style: TextStyle(color: k.fg, fontSize: 13))),
                const SizedBox(width: 8),
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.55),
                  child: Text(t.planOpenLinked, maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: k.link, fontSize: 13, fontWeight: FontWeight.w600)),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _DashedBorder extends CustomPainter {
  _DashedBorder({required this.color, required this.radius});

  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..style = PaintingStyle.stroke..strokeWidth = 1..color = color;
    final path = Path()..addRRect(RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(radius)));
    for (final m in path.computeMetrics()) {
      for (var d = 0.0; d < m.length; d += 7) {
        canvas.drawPath(m.extractPath(d, d + 4), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_DashedBorder old) => old.color != color || old.radius != radius;
}

/// 「⏳ 앞: X ›」(D6) — 회색 알약, 누르는 자리 44. 그룹을 넘으면 「그룹 · 단계」로 쓴다. 볼 수 없는 스레드는 누를 수 없다.
class _Waiting extends StatelessWidget {
  const _Waiting({required this.plan, required this.ids, required this.fromGroupId, required this.onPress});

  final ThreadPlanView plan;
  final List<String> ids;
  final String? fromGroupId;
  final ValueChanged<String> onPress;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final prefix = '⏳ ${context.t.planWaitingOn}';
    return Wrap(
      children: [
        for (var i = 0; i < ids.length; i++)
          Builder(builder: (context) {
            final cross = crossGroupTitle(plan, ids[i], fromGroupId);
            final title = planTitleOf(plan, ids[i]);
            final hidden = plan.linkedOf(ids[i])?.hidden ?? false;
            return Semantics(
              button: !hidden,
              label: '$prefix ${cross == null ? '' : '$cross · '}$title',
              excludeSemantics: true,
              child: InkWell(
                key: Key('plan-waiting-${ids[i]}'),
                onTap: hidden ? null : () => onPress(ids[i]),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: HarkroomSize.row),
                  child: Align(
                    widthFactor: 1,
                    heightFactor: 1,
                    alignment: Alignment.centerLeft,
                    child: Container(
                      margin: const EdgeInsets.only(right: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(color: k.surfaceSunken, borderRadius: BorderRadius.circular(HarkroomRadius.row)),
                      child: Text.rich(
                        TextSpan(children: [
                          if (i == 0) TextSpan(text: '$prefix '),
                          TextSpan(
                            text: '${cross == null ? '' : '$cross · '}$title${hidden ? '' : ' ›'}',
                            style: TextStyle(color: k.fg, decoration: hidden ? null : TextDecoration.underline, decorationStyle: TextDecorationStyle.dotted),
                          ),
                        ]),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta),
                      ),
                    ),
                  ),
                ),
              ),
            );
          }),
      ],
    );
  }
}

/// 둘째 줄의 작은 링크. 눈에 보이는 글자는 작아도 누르는 자리는 44 다.
class _RowLink extends StatelessWidget {
  const _RowLink({super.key, required this.text, required this.color, required this.onTap});

  final String text;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: HarkroomSize.row, minWidth: HarkroomSize.row),
          child: Align(
            widthFactor: 1,
            heightFactor: 1,
            alignment: Alignment.centerLeft,
            child: Text(text,
                style: TextStyle(color: color, fontSize: HarkroomType.meta, decoration: TextDecoration.underline, decorationStyle: TextDecorationStyle.dotted)),
          ),
        ),
      );
}

class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.plan, required this.step, required this.app, required this.me, required this.grouped, required this.whyOpen,
    required this.onToggleWhy, required this.onWaiting, required this.onGo, required this.onMessage,
  });

  final ThreadPlanView plan;
  final PlanStep step;
  final AppState app;
  final String? me;
  final bool grouped;
  final bool whyOpen;
  final VoidCallback onToggleWhy;
  final ValueChanged<String> onWaiting;
  final void Function(String id, bool why) onGo;
  final ValueChanged<String> onMessage;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final kind = stepKind(plan, step, me);
    PlanGroup? parent;
    for (final g in plan.groups) {
      if (g.id == step.groupId) parent = g;
    }
    final hasDeps = step.dependsOn.isNotEmpty || (parent?.dependsOn.isNotEmpty ?? false);
    // 담당은 이 커뮤니티에 있는 계정일 때만 그린다 — 모르는 id 로 이름을 지어내지 않는다.
    final assigneeId = stepAssignee(plan, step);
    final assignee = assigneeId == null ? null : app.accounts[assigneeId];
    final links = stepFirstLinks(step);
    final waiters = kind == PlanRowKind.mine ? stepWaiters(plan, step.id) : const <String>[];
    TextStyle meta(Color c, {bool bold = false}) => TextStyle(color: c, fontSize: HarkroomType.meta, height: 1.4, fontWeight: bold ? FontWeight.w600 : null);
    // 조각들. 구분점은 **조각 사이에만** 둔다 — 줄이 구분점으로 끝나거나 시작하지 않게.
    final parts = <Widget>[
      if (kind == PlanRowKind.done) Text(t.planRowDone, style: meta(k.success, bold: true)),
      if (kind == PlanRowKind.active) Text(t.planStateActive, style: meta(k.stateActive, bold: true)),
      if (kind == PlanRowKind.mine) Text(t.planRowMine, style: meta(k.accentText, bold: true)),
      if (kind == PlanRowKind.ready) Text(hasDeps ? t.planReadyAfter : t.planReady, style: meta(k.fgMuted)),
      if (kind != PlanRowKind.mine && assignee != null)
        Text('${!assignee.isAgent && assignee.id != me ? '${t.planRowPerson} ' : ''}@${assignee.handle}', style: meta(k.fgAgent)),
      if (waiters.isNotEmpty)
        _RowLink(key: Key('plan-waiters-${step.id}'), text: t.planRowWaiters(waiters.length), color: k.stateStuck, onTap: () => onGo(waiters.first, true)),
      if (links.pr != null)
        _RowLink(
          key: Key('plan-row-pr-${step.id}'),
          text: t.planRowPr(links.pr!.number),
          color: k.link,
          onTap: () => unawaited(launchUrl(Uri.parse(prUrl(links.pr!)), mode: LaunchMode.externalApplication)),
        ),
      if (links.messageId != null && kind != PlanRowKind.blocked)
        _RowLink(key: Key('plan-row-message-${step.id}'), text: t.planRowMessage, color: k.link, onTap: () => onMessage(links.messageId!)),
      if (kind == PlanRowKind.blocked)
        _RowLink(key: Key('plan-why-toggle-${step.id}'), text: whyOpen ? t.planWhyCollapse : t.planWhyToggle, color: k.stateStuck, onTap: onToggleWhy),
    ];
    final node = plan.derived[step.id];
    return Container(
      key: Key('plan-step-${step.id}'),
      constraints: const BoxConstraints(minHeight: HarkroomSize.row),
      margin: EdgeInsets.only(left: grouped ? 24 : 0),
      decoration: kind == PlanRowKind.blocked ? BoxDecoration(color: k.dangerSurface, borderRadius: BorderRadius.circular(HarkroomRadius.row)) : null,
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 7, HarkroomSize.gutter, 7),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          PlanStateMark(kind: kind),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              // 길면 말줄임하고 길게 누르면 전체를 본다.
              Tooltip(
                message: step.title,
                child: Text(step.title, maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis, style: TextStyle(color: k.fg, fontSize: HarkroomType.body)),
              ),
              // 막힌 줄: 「막힘 · 사유」 는 한 줄로 줄인다. 전문은 「막힌 까닭」 상자에 있다.
              if (kind == PlanRowKind.blocked)
                Text.rich(
                  key: Key('plan-step-reason-${step.id}'),
                  TextSpan(children: [
                    TextSpan(text: t.planStateBlocked, style: const TextStyle(fontWeight: FontWeight.w600)),
                    if (step.blockedReason != null) TextSpan(text: ' · ${step.blockedReason}'),
                  ]),
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                  style: meta(k.stateStuck),
                ),
              if (parts.isNotEmpty)
                Wrap(
                  key: Key('plan-step-sub-${step.id}'),
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    for (var i = 0; i < parts.length; i++)
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        if (i > 0) ExcludeSemantics(child: Text(' · ', style: meta(k.fgMuted))),
                        parts[i],
                      ]),
                  ],
                ),
              if (node != null && node.waitingOn.isNotEmpty)
                _Waiting(plan: plan, ids: node.waitingOn, fromGroupId: step.groupId, onPress: onWaiting),
            ]),
          ),
          if (kind == PlanRowKind.blocked) ...[const SizedBox(width: 8), const _BlockedTag()],
        ]),
        if (kind == PlanRowKind.blocked && whyOpen) _WhyBox(plan: plan, step: step, me: me, onGo: (id) => onGo(id, false), onMessage: onMessage),
      ]),
    );
  }
}

/// 「막힌 까닭」 상자(V3) — 사유 전문, 앞 단계, 연결. 하나도 없으면 「연결된 것 없음」.
class _WhyBox extends StatelessWidget {
  const _WhyBox({required this.plan, required this.step, required this.me, required this.onGo, required this.onMessage});

  final ThreadPlanView plan;
  final PlanStep step;
  final String? me;
  final ValueChanged<String> onGo;
  final ValueChanged<String> onMessage;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final why = stepWhy(plan, step, me);
    Widget row(String label, Widget body) => Row(children: [
          SizedBox(width: 56, child: Text(label, style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta))),
          Expanded(child: Align(alignment: Alignment.centerLeft, child: body)),
        ]);
    return Container(
      key: Key('plan-why-${step.id}'),
      width: double.infinity,
      margin: const EdgeInsets.only(top: 6, left: 28),
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 6),
      decoration: BoxDecoration(color: k.surfaceRaised, border: Border(left: BorderSide(color: k.stateStuck, width: 2))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(t.planWhyTitle, style: TextStyle(color: k.stateStuck, fontSize: HarkroomType.meta, fontWeight: FontWeight.w600)),
        if (why.reason != null) Text(why.reason!, key: Key('plan-why-reason-${step.id}'), style: TextStyle(color: k.fg, fontSize: HarkroomType.meta)),
        for (final dep in why.deps)
          row(t.planWhyDep, _RowLink(key: Key('plan-why-dep-${dep.id}'), text: '${dep.group == null ? '' : '${dep.group} · '}${dep.title} ›', color: k.fg, onTap: () => onGo(dep.id))),
        for (final l in why.links)
          switch (l.kind) {
            'pr' => row(t.planWhyPr, _RowLink(key: Key('plan-why-pr-${l.number}'), text: t.planRowPr(l.number!), color: k.link,
                onTap: () => unawaited(launchUrl(Uri.parse(prUrl((repo: l.repo!, number: l.number!))), mode: LaunchMode.externalApplication)))),
            'workitem' => row(t.planWhyWorkitem, Text(l.id ?? '', style: TextStyle(color: k.fgSubtle, fontSize: HarkroomType.meta))),
            _ => row(l.kind == 'card' ? t.planWhyCard : t.planWhyMessage,
                _RowLink(key: Key('plan-why-goto-${l.id}'), text: t.planWhyGoto, color: k.link, onTap: () => onMessage(l.id ?? ''))),
          },
        if (why.deps.isEmpty && why.links.isEmpty)
          Text(t.planWhyNone, key: Key('plan-why-none-${step.id}'), style: TextStyle(color: k.fgSubtle, fontSize: HarkroomType.meta)),
      ]),
    );
  }
}

class _LoadFailed extends StatelessWidget {
  const _LoadFailed({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    return Container(
      key: const Key('plan-load-failed'),
      margin: const EdgeInsets.all(HarkroomSize.gutter),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: k.surfaceSunken, borderRadius: BorderRadius.circular(HarkroomRadius.card)),
      child: Column(children: [
        Text(t.planLoadFailed, textAlign: TextAlign.center, style: TextStyle(color: k.fg, fontSize: 14)),
        const SizedBox(height: 8),
        OutlinedButton(key: const Key('plan-retry'), onPressed: onRetry, child: Text(t.commonRetry)),
      ]),
    );
  }
}

/// 받는 동안 트리 자리에 회색 줄 3개.
class _LoadingLines extends StatelessWidget {
  const _LoadingLines();

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Semantics(
      label: context.t.commonLoading,
      child: Padding(
        key: const Key('plan-loading'),
        padding: const EdgeInsets.all(HarkroomSize.gutter),
        child: Column(children: [
          for (final w in const [1.0, 0.8, 0.6])
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: FractionallySizedBox(
                widthFactor: w,
                child: Container(height: 14, decoration: BoxDecoration(color: k.surfaceSunken, borderRadius: BorderRadius.circular(HarkroomRadius.sm))),
              ),
            ),
        ]),
      ),
    );
  }
}
