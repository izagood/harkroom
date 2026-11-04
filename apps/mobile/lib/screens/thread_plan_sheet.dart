import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api/thread_plan.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../time.dart';
import '../ui/tokens.dart';
import 'tab_nav.dart';
import 'thread_screen.dart';

/// 스레드 계획판 — 칩·띠·시트(시안 v3, 데스크톱 `ThreadPlanBand`·`PlanChip` 의 폰 판).
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

/// 스레드 머리 밑의 띠(44pt, 불투명). 칩 · 목표 · 알약 1개 · +n · ⌃. 띠 전체가 누르는 자리 하나다.
///
/// **부를 길은 루트 행의 `planProgress` 뿐이다** — 옛 서버나 계획 없는 스레드에서는 띠가 없고 GET 도 없다.
/// 판을 받는 곳은 이 띠 하나다(데스크톱 R1). 칩은 판을 받은 뒤 개인 진행률을 쓴다(R2).
class ThreadPlanBand extends StatefulWidget {
  const ThreadPlanBand({super.key, required this.rootId, required this.progress});

  final String rootId;
  final PlanProgressMark? progress;

  @override
  State<ThreadPlanBand> createState() => _ThreadPlanBandState();
}

class _ThreadPlanBandState extends State<ThreadPlanBand> {
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
    final t = context.t;
    final k = context.tokens;
    _sync(app);
    final plan = app.threadPlans[widget.rootId];
    final PlanCounts chip = plan != null && plan.progress.total > 0 ? plan.progress : mark!;
    final pills = plan == null ? const <PlanPill>[] : planPills(plan);
    final summary = planSummary(pills);
    final stale = plan != null && isPlanStale(plan.updatedAt, DateTime.now().toUtc());
    void open() => openThreadPlanSheet(context, widget.rootId);

    return Semantics(
      key: const Key('plan-band'),
      button: true,
      excludeSemantics: true,
      label: [
        t.planChipSemantics(chip.done, chip.total),
        if (chip.blocked > 0) t.planBlockedSemantics(chip.blocked),
        if (plan != null) t.planGoalSemantics(plan.goal),
      ].join(', '),
      hint: t.planOpenHint,
      onTap: open,
      child: Material(
        color: k.surfaceRaised,
        child: InkWell(
          key: const Key('plan-band-open'),
          onTap: open,
          child: Container(
            constraints: const BoxConstraints(minHeight: HarkroomSize.row),
            padding: const EdgeInsets.fromLTRB(10, 0, 12, 0),
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: k.border))),
            child: Row(children: [
              // 큰 글자에서도 목표·⌃ 자리를 남긴다.
              ConstrainedBox(
                constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.55),
                child: PlanChip(progress: chip),
              ),
              const SizedBox(width: 6),
              // 좁을수록 목표 글자부터 줄이고 알약은 남긴다(데스크톱 designer 1).
              Expanded(
                child: Text(
                  plan?.goal ?? '',
                  key: const Key('plan-band-goal'),
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: k.fg, fontSize: 14),
                ),
              ),
              if (stale)
                Padding(
                  padding: const EdgeInsets.only(left: 6),
                  child: Text(t.planStaleShort, key: const Key('plan-stale'), style: TextStyle(color: k.warning, fontSize: HarkroomType.meta)),
                )
              else if (summary != null)
                // 막힌 그룹 이름까지 보이도록 목표보다 자리를 더 준다.
                Flexible(
                  flex: 2,
                  child: Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: Text.rich(
                      key: const Key('plan-summary'),
                      TextSpan(children: [
                        TextSpan(text: summary.blocked > 0
                            ? t.planSummary(summary.groups, summary.active, summary.blocked)
                            : t.planSummaryNoBlocked(summary.groups, summary.active)),
                        if (summary.firstBlocked != null)
                          TextSpan(text: ' (${summary.firstBlocked})', style: TextStyle(color: k.stateStuck)),
                      ]),
                      maxLines: 1,
                      softWrap: false,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta),
                    ),
                  ),
                )
              else if (pills.isNotEmpty) ...[
                const SizedBox(width: 6),
                _Pill(pill: pills.first),
                if (pills.length > 1)
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: Text(t.planMoreGroups(pills.length - 1), key: const Key('plan-more'), style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta)),
                  ),
              ],
              const SizedBox(width: 4),
              Icon(Icons.expand_less, size: 18, color: k.fgSubtle),
            ]),
          ),
        ),
      ),
    );
  }
}

/// 알약 글자(D7) — 데스크톱 `plan.pill.*` 와 같다: 「화면 막힘 1/3」「서버✓」「출시 대기」「문서 대기 1/3」.
String planPillLabel(Strings t, PlanPill p) {
  final c = p.count;
  if (p.state == PlanState.done) return t.planPillDone(p.title);
  if (p.state == PlanState.blocked && c != null) return t.planPillBlocked(p.title, c.done, c.total);
  if (p.state == PlanState.waiting && c != null && c.total > 0 && c.done > 0) {
    return t.planPillWaitingCount(p.title, c.done, c.total);
  }
  if (p.state == PlanState.waiting) return t.planPillWaiting(p.title);
  if (c != null && c.total > 0 && p.state != PlanState.hidden) return t.planPillCount(p.title, c.done, c.total);
  return p.title;
}

class _Pill extends StatelessWidget {
  const _Pill({required this.pill});

  final PlanPill pill;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final (Color? bg, Color fg, Border? border) = switch (pill.state) {
      PlanState.blocked => (k.dangerSurface, k.stateStuck, null),
      PlanState.active => (k.surfaceSunken, k.fgAgent, null),
      PlanState.ready => (k.surfaceSunken, k.fgMuted, null),
      _ => (null, k.fgMuted, Border.all(color: k.border)),
    };
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 152),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
        decoration: BoxDecoration(color: bg, border: border, borderRadius: BorderRadius.circular(HarkroomRadius.full)),
        child: Text(
          planPillLabel(context.t, pill),
          maxLines: 1,
          softWrap: false,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: fg, fontSize: HarkroomType.meta),
        ),
      ),
    );
  }
}

/// 상태 표지 — **색만으로 가르지 않는다**: ✓ 끝남 · ◐ 진행 · ! 막힘 · ▷ 시작 가능 · ○ 대기 · 점선 볼 수 없음. VoiceOver 는 라벨을 읽는다.
class PlanStateMark extends StatelessWidget {
  const PlanStateMark({super.key, required this.state});

  final PlanState state;

  static String label(Strings t, PlanState s) => switch (s) {
        PlanState.done => t.planStateDone,
        PlanState.active => t.planStateActive,
        PlanState.blocked => t.planStateBlocked,
        PlanState.ready => t.planStateReady,
        PlanState.waiting => t.planStateWaiting,
        PlanState.hidden => t.planStateHidden,
      };

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Semantics(
      label: label(context.t, state),
      excludeSemantics: true,
      child: SizedBox.square(
        dimension: 16,
        child: CustomPaint(painter: _MarkPainter(state: state, tokens: k)),
      ),
    );
  }
}

class _MarkPainter extends CustomPainter {
  _MarkPainter({required this.state, required this.tokens});

  final PlanState state;
  final HarkroomTokens tokens;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    final r = size.width / 2 - 1;
    Paint stroke(Color color) => Paint()..style = PaintingStyle.stroke..strokeWidth = 1.5..color = color;
    Paint fill(Color color) => Paint()..color = color;
    Paint ink(Color color) => Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color;
    Offset at(double x, double y) => Offset(c.dx + x, c.dy + y);
    switch (state) {
      case PlanState.done:
        canvas.drawCircle(c, r + 1, fill(tokens.success));
        canvas.drawPath(
          Path()
            ..moveTo(at(-3.5, 0).dx, at(-3.5, 0).dy)
            ..lineTo(at(-1, 2.5).dx, at(-1, 2.5).dy)
            ..lineTo(at(3.5, -2.5).dx, at(3.5, -2.5).dy),
          ink(tokens.surfaceRaised),
        );
      case PlanState.active:
        canvas.drawCircle(c, r, stroke(tokens.stateRunning));
        canvas.drawArc(Rect.fromCircle(center: c, radius: r), -math.pi / 2, math.pi, true, fill(tokens.stateRunning));
      case PlanState.blocked:
        canvas.drawCircle(c, r + 1, fill(tokens.stateStuck));
        canvas.drawLine(at(0, -3.5), at(0, 0.8), ink(tokens.surfaceRaised));
        canvas.drawCircle(at(0, 3.6), 1.1, fill(tokens.surfaceRaised));
      case PlanState.ready:
        canvas.drawCircle(c, r, stroke(tokens.stateWaiting));
        canvas.drawPath(
          Path()
            ..moveTo(at(-1.8, -3).dx, at(-1.8, -3).dy)
            ..lineTo(at(3, 0).dx, at(3, 0).dy)
            ..lineTo(at(-1.8, 3).dx, at(-1.8, 3).dy)
            ..close(),
          fill(tokens.fgMuted),
        );
      case PlanState.waiting:
        canvas.drawCircle(c, r, stroke(tokens.stateWaiting));
      case PlanState.hidden:
        const n = 8;
        for (var i = 0; i < n; i++) {
          canvas.drawArc(Rect.fromCircle(center: c, radius: r), i * 2 * math.pi / n, math.pi / n, false, stroke(tokens.fgSubtle));
        }
    }
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.state != state || old.tokens != tokens;
}

/// 「막힘」 꼬리표 — 빨강만으로 말하지 않는다. 표지가 이미 읽히므로 VoiceOver 에는 겹쳐 읽히지 않게 한다.
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

/// 계획 시트를 연다. [opener] 는 시트를 연 쪽의 context 다 — 「그 스레드 열기」가 시트를 닫은 뒤 그 쌓기에 민다.
Future<void> openThreadPlanSheet(BuildContext opener, String rootId) {
  final app = AppScope.read(opener);
  // 띠가 못 받았으면(실패·아직 안 옴) 여기서 다시 부른다. 받아 둔 판이 있으면 그대로 연다.
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

  /// 그룹별 펼침을 사람이 바꾼 값. 없으면 상태로 정한다 — 이 시트 안에서만 산다(기억하지 않는다).
  final Map<String, bool> _open = {};
  final Map<String, GlobalKey> _nodeKeys = {};

  /// 지금 깜빡일 노드. 번호가 바뀌면 [HitFlash] 를 새로 세워 다시 깜빡인다.
  String? _flashId;
  int _flashNo = 0;

  @override
  void dispose() {
    _sheet.dispose();
    super.dispose();
  }

  GlobalKey _keyOf(String id) => _nodeKeys.putIfAbsent(id, GlobalKey.new);

  bool _isOpen(ThreadPlanView plan, PlanGroup g) => _open[g.id] ?? planGroupStartsOpen(plan.stateOf(g.id));

  /// 「⏳ 앞: X」 — 그 그룹을 펴고 스크롤한 뒤 깜빡인다.
  void _jump(ThreadPlanView plan, String id) {
    String? groupId;
    for (final s in plan.steps) {
      if (s.id == id) groupId = s.groupId;
    }
    setState(() {
      if (groupId != null) _open[groupId] = true;
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
    if (plan != null) _fitOnce();
    return DraggableScrollableSheet(
      controller: _sheet,
      expand: false,
      initialChildSize: planSheetInitial,
      minChildSize: planSheetMin,
      maxChildSize: planSheetMax,
      builder: (context, scroll) => Column(
        key: const Key('plan-sheet'),
        children: [
          GestureDetector(
            behavior: HitTestBehavior.translucent,
            onVerticalDragUpdate: _dragHead,
            onVerticalDragEnd: _dragHeadEnd,
            child: _SheetHead(key: _headKey, plan: plan, app: app),
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
                      ? _body(context, plan, app)
                      : failed
                          ? [_LoadFailed(onRetry: () => unawaited(app.loadThreadPlan(widget.rootId)))]
                          : const [_LoadingLines()],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _body(BuildContext context, ThreadPlanView plan, AppState app) {
    final t = context.t;
    final k = context.tokens;
    return [
      if (plan.groups.isNotEmpty) _Flow(plan: plan),
      for (final g in plan.groups) ..._group(context, plan, g, app),
      for (final s in plan.stepsOf(null)) _stepNode(plan, s, app, grouped: false),
      if (plan.next != null || plan.blocked != null || plan.flagged)
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
            if (plan.blocked != null) Text('${t.planBlocked} ${plan.blocked}', style: TextStyle(color: k.stateStuck, fontSize: 13)),
            if (plan.flagged) Text(t.planFlagged, key: const Key('plan-flagged'), style: TextStyle(color: k.stateStuck, fontSize: 13)),
          ]),
        ),
      const SizedBox(height: 8),
    ];
  }

  Widget _flashable(String id, Widget child) => KeyedSubtree(
        key: _keyOf(id),
        child: _flashId == id ? HitFlash(key: ValueKey('plan-flash-$id-$_flashNo'), child: child) : child,
      );

  List<Widget> _group(BuildContext context, ThreadPlanView plan, PlanGroup g, AppState app) {
    final k = context.tokens;
    final state = plan.stateOf(g.id);
    final steps = plan.stepsOf(g.id);
    final linked = g.linkedRootId == null ? null : plan.linkedOf(g.id);
    final count = groupCount(plan, g);
    final open = _isOpen(plan, g);
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
            onTap: canToggle ? () => setState(() => _open[g.id] = !open) : null,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: HarkroomSize.row),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter),
                child: Row(children: [
                  PlanStateMark(state: state),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Row(children: [
                      Flexible(
                        child: Text(
                          g.title,
                          maxLines: 1,
                          softWrap: false,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: state == PlanState.hidden ? k.fgSubtle : k.fg,
                            fontWeight: FontWeight.w600,
                            fontSize: HarkroomType.body,
                          ),
                        ),
                      ),
                      if (g.linkedRootId == null && count != null && count.total > 0) ...[
                        const SizedBox(width: 8),
                        Text('${count.done}/${count.total}', key: Key('plan-group-count-${g.id}'), style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta)),
                      ],
                      if (linked != null && !linked.hidden && childProgress != null && childProgress.total > 0) ...[
                        const SizedBox(width: 6),
                        ConstrainedBox(
                          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.4),
                          child: PlanChip(progress: childProgress),
                        ),
                      ],
                      if (state == PlanState.blocked) ...[const SizedBox(width: 8), const _BlockedTag()],
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
          child: _Waiting(plan: plan, ids: node.waitingOn, fromGroupId: g.id, onJump: (id) => _jump(plan, id)),
        ),
      if (open) for (final s in steps) _stepNode(plan, s, app, grouped: true),
    ];
  }

  Widget _stepNode(ThreadPlanView plan, PlanStep s, AppState app, {required bool grouped}) => _flashable(
        s.id,
        _StepRow(plan: plan, step: s, app: app, grouped: grouped, onJump: (id) => _jump(plan, id)),
      );
}

class _SheetHead extends StatefulWidget {
  const _SheetHead({super.key, required this.plan, required this.app});

  final ThreadPlanView? plan;
  final AppState app;

  @override
  State<_SheetHead> createState() => _SheetHeadState();
}

class _SheetHeadState extends State<_SheetHead> {
  bool _goalOpen = false;

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
          ];
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
              if (isPlanStale(plan.updatedAt, now))
                TextSpan(text: '${meta.isEmpty ? '' : ' · '}${t.planStale}', style: TextStyle(color: k.warning)),
            ]),
            style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta),
          ),
          if (plan.updatedAt != null || editor != null) const SizedBox(height: 2),
        ],
      ]),
    );
  }
}

/// 흐름 — 층마다 한 줄(시안 v3). 같은 층에 둘 이상이면 「동시에 진행」.
class _Flow extends StatelessWidget {
  const _Flow({required this.plan});

  final ThreadPlanView plan;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final pillOf = {for (final p in planPills(plan)) p.id: p};
    final layers = planFlow(plan);
    return Container(
      key: const Key('plan-flow'),
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 8, HarkroomSize.gutter, 10),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: k.border))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(t.planFlow, style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta, fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        for (var i = 0; i < layers.length; i++) ...[
          if (i > 0)
            Padding(
              padding: const EdgeInsets.only(left: 4),
              child: ExcludeSemantics(child: Text('↓', style: TextStyle(color: k.fgSubtle, fontSize: 11, height: 1))),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Wrap(
              key: Key('plan-flow-layer-$i'),
              spacing: 6,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Container(
                  width: 18,
                  height: 18,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: k.surfaceSunken, shape: BoxShape.circle),
                  child: Text('${i + 1}', style: TextStyle(color: k.fgMuted, fontSize: 11, fontWeight: FontWeight.w600)),
                ),
                for (final id in layers[i])
                  if (pillOf[id] != null) _Pill(pill: pillOf[id]!),
                if (layers[i].length > 1) Text(t.planParallel, style: TextStyle(color: k.fgSubtle, fontSize: 11)),
              ],
            ),
          ),
        ],
      ]),
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
                Expanded(
                  child: Text(title, maxLines: 1, softWrap: false, overflow: TextOverflow.ellipsis, style: TextStyle(color: k.fg, fontSize: 13)),
                ),
                const SizedBox(width: 8),
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.55),
                  child: Text(
                    t.planOpenLinked,
                    maxLines: 1,
                    softWrap: false,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: k.link, fontSize: 13, fontWeight: FontWeight.w600),
                  ),
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

/// 「⏳ 앞: X」(D6) — 회색 알약, 누르는 자리 44. 그룹을 넘으면 「그룹 · 단계」로 쓴다.
class _Waiting extends StatelessWidget {
  const _Waiting({required this.plan, required this.ids, required this.fromGroupId, required this.onJump});

  final ThreadPlanView plan;
  final List<String> ids;
  final String? fromGroupId;
  final ValueChanged<String> onJump;

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
            return Semantics(
              button: true,
              label: '$prefix ${cross == null ? '' : '$cross · '}$title',
              excludeSemantics: true,
              child: InkWell(
                key: Key('plan-waiting-${ids[i]}'),
                onTap: () => onJump(ids[i]),
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
                            text: '${cross == null ? '' : '$cross · '}$title',
                            style: TextStyle(color: k.fg, decoration: TextDecoration.underline, decorationStyle: TextDecorationStyle.dotted),
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

class _StepRow extends StatelessWidget {
  const _StepRow({required this.plan, required this.step, required this.app, required this.grouped, required this.onJump});

  final ThreadPlanView plan;
  final PlanStep step;
  final AppState app;
  final bool grouped;
  final ValueChanged<String> onJump;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final state = plan.stateOf(step.id);
    PlanGroup? parent;
    for (final g in plan.groups) {
      if (g.id == step.groupId) parent = g;
    }
    final hasDeps = step.dependsOn.isNotEmpty || (parent?.dependsOn.isNotEmpty ?? false);
    // 담당은 이 커뮤니티에 있는 계정일 때만 그린다 — 모르는 id 로 이름을 지어내지 않는다.
    final assigneeId = step.assigneeId ?? parent?.assigneeId;
    final assignee = assigneeId == null ? null : app.accounts[assigneeId];
    final reason = state == PlanState.blocked ? step.blockedReason : null;
    final ready = state != PlanState.ready ? null : (hasDeps ? t.planReadyAfter : t.planReady);
    final spans = <InlineSpan>[
      if (assignee != null) TextSpan(text: '@${assignee.handle}', style: TextStyle(color: k.fgAgent)),
      if (reason != null) TextSpan(text: reason, style: TextStyle(color: k.stateStuck)),
      if (ready != null) TextSpan(text: ready),
    ];
    final node = plan.derived[step.id];
    return ConstrainedBox(
      key: Key('plan-step-${step.id}'),
      constraints: const BoxConstraints(minHeight: HarkroomSize.row),
      child: Padding(
        padding: EdgeInsets.fromLTRB(grouped ? 40 : HarkroomSize.gutter, 7, HarkroomSize.gutter, 7),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 3), child: PlanStateMark(state: state)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              // 길면 말줄임하고 길게 누르면 전체를 본다.
              Tooltip(
                message: step.title,
                child: Text(
                  step.title,
                  maxLines: 1,
                  softWrap: false,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: state == PlanState.done ? k.fgSubtle : k.fg, fontSize: HarkroomType.body),
                ),
              ),
              if (spans.isNotEmpty)
                Text.rich(
                  key: Key('plan-step-sub-${step.id}'),
                  TextSpan(children: [
                    for (var i = 0; i < spans.length; i++) ...[
                      if (i > 0) const TextSpan(text: ' · '),
                      spans[i],
                    ],
                  ]),
                  style: TextStyle(color: k.fgMuted, fontSize: HarkroomType.meta, height: 1.4),
                ),
              if (node != null && node.waitingOn.isNotEmpty)
                _Waiting(plan: plan, ids: node.waitingOn, fromGroupId: step.groupId, onJump: onJump),
            ]),
          ),
          if (state == PlanState.blocked) ...[const SizedBox(width: 8), const _BlockedTag()],
        ]),
      ),
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
