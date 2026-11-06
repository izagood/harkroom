import 'dart:async';

import 'package:flutter/material.dart';

import '../api/agent_meta.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../time.dart';
import '../ui/tokens.dart';
import '../mention/render.dart';
import 'agent_exchange.dart';
import 'message_feed.dart';

/// 살아 있는 줄의 상대 시각이 멈추지 않게 1분마다 다시 그린다. 끝난 줄은 값이 바뀌지 않으므로 쓰지 않는다.
class _MinuteTicker extends StatefulWidget {
  const _MinuteTicker({required this.builder});

  final WidgetBuilder builder;

  @override
  State<_MinuteTicker> createState() => _MinuteTickerState();
}

class _MinuteTickerState extends State<_MinuteTicker> {
  late final Timer _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(minutes: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context);
}

/// 진행 줄 — **말풍선이 아니라 상태 한 줄**이다.
///
/// 진행은 수십 개가 이어진다. 말풍선으로 흘리면 채널이 진행 로그로 덮이고, 정작 사람이
/// 읽어야 할 말이 그 사이에 묻힌다. 그래서 **이어진 것을 한 줄로 접고 마지막 것만**
/// 보여 준다 — 데스크탑 `ProgressRow` 와 같은 판단이다.
///
/// 끝난 묶음은 과거로 그린다: 회전 표시 대신 회색 점, 「작업 · 5분 걸림」. 길이를 모르면 「작업 · 끝남」.
class ProgressRow extends StatelessWidget {
  const ProgressRow({super.key, required this.item, this.inRun = false});

  final FeedProgressRun item;

  /// 펼친 묶음 안의 줄 — 이름은 묶음 머리에 있고 왼쪽 선 안에 선다.
  final bool inRun;

  @override
  Widget build(BuildContext context) {
    if (item.ended) return _line(context);
    return _MinuteTicker(builder: _line);
  }

  Widget _line(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final k = context.tokens;
    final run = item.run;
    final last = run.last;
    final ended = item.ended;
    final endedAt = item.endedAt;
    final String status;
    if (!ended) {
      status = '${t.agentWorking} · ${runningLabel(DateTime.now().toUtc().difference(run.first.createdAt), t)}';
    } else if (endedAt != null) {
      status = '${t.agentWorked} · ${tookLabel(endedAt.difference(run.first.createdAt), t)}';
    } else {
      status = '${t.agentWorked} · ${t.agentEnded}';
    }
    final style = TextStyle(fontSize: 12, height: 1.35, color: ended ? k.fgSubtle : k.fgMuted);
    // 개정판 3.3: 본문 열(아바타 뒤)에 맞춘 회색 한 줄 「◌ designer 작업 중 · 2분째 — 문구」.
    // 가장 최근 줄이면 목록이 아래부터 쌓이므로 작성칸 바로 위에 선다(따로 고정하지 않는다 —
    // 뒤에 말이 오면 그 말 위, 일이 일어난 순서 자리에 남는다).
    return Padding(
      key: Key('progress-${last.id}'),
      padding: inRun
          ? const EdgeInsets.fromLTRB(12, 3, HarkroomSize.gutter, 3)
          : const EdgeInsets.fromLTRB(HarkroomSize.gutter + HarkroomSize.avatar + 10, 4, HarkroomSize.gutter, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (ended)
            Padding(
              key: Key('progress-dot-${last.id}'),
              padding: const EdgeInsets.fromLTRB(3, 5, 2, 0),
              child: Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(color: k.fgSubtle, shape: BoxShape.circle),
              ),
            )
          else
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.6)),
            ),
          const SizedBox(width: 6),
          Expanded(
            child: Text.rich(
              TextSpan(children: [
                if (!inRun) ...[
                  TextSpan(
                    text: app.displayNameOf(last.authorId),
                    style: TextStyle(fontWeight: FontWeight.w600, color: k.fgAgent),
                  ),
                  const TextSpan(text: ' '),
                ],
                TextSpan(text: '$status — ${renderMentions(last.body, app.accounts, t.mentionUnknown)}'),
              ]),
              style: style,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          // 접힌 진행이 여럿이면 몇 개인지(누르면 펼치는 것은 이 줄의 일이 아니다).
          if (run.length > 1) ...[
            const SizedBox(width: 6),
            Text('${run.length}', key: Key('progress-count-${last.id}'), style: style),
          ],
        ],
      ),
    );
  }
}

/// 대기 줄 — 에이전트가 **언제 다시 볼지** 걸어 둔 예약.
///
/// 이것이 없으면 기다리는 스레드는 그냥 조용한 스레드와 구별되지 않는다. 끝난 예약은 회색 한 줄로 낮춰,
/// 살아 있는 대기와 한눈에 갈린다. 초록·강조색은 쓰지 않는다 — 끝난 대기는 나를 막지 않는다.
class WakeRow extends StatelessWidget {
  const WakeRow({super.key, required this.message, required this.wake, this.inRun = false});

  final MessageRow message;
  final WakeMeta wake;

  /// 펼친 묶음 안의 줄 — 왼쪽 선 안에 서고 두 줄까지 보인다.
  final bool inRun;

  WakeState _state(DateTime now) => wake.stateAt(now, ownerChecked: ownerCheckedWake(message));

  @override
  Widget build(BuildContext context) {
    if (_state(DateTime.now().toUtc()).isPast) return _line(context);
    return _MinuteTicker(builder: _line);
  }

  Widget _line(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final now = DateTime.now().toUtc();
    final state = _state(now);
    final status = _statusLabel(state, now, t);
    final past = state.isPast;
    final reason = wake.reason == null || wake.reason!.trim().isEmpty
        ? null
        : renderMentions(wake.reason!, context.app.accounts, t.mentionUnknown);
    final icon = switch (state) {
      WakeState.checked => Icons.check,
      WakeState.canceled => Icons.block,
      _ => Icons.schedule,
    };

    return Padding(
      key: Key('wake-${message.id}'),
      padding: inRun
          ? const EdgeInsets.fromLTRB(12, 3, HarkroomSize.gutter, 3)
          : const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter, vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(icon, key: Key('wake-icon-${state.name}'), size: 13, color: past ? k.fgSubtle : k.fg),
          ),
          const SizedBox(width: 7),
          Expanded(
            child: Text.rich(
              TextSpan(children: [
                TextSpan(
                  text: status,
                  style: past
                      ? TextStyle(color: k.fgMuted)
                      : TextStyle(color: k.fg, fontWeight: FontWeight.w500),
                ),
                if (reason != null) TextSpan(text: ' — $reason'),
              ]),
              style: TextStyle(fontSize: 12, height: 1.38, color: past ? k.fgSubtle : k.fgMuted),
              maxLines: past && !inRun ? 1 : 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  String _statusLabel(WakeState state, DateTime now, Strings t) {
    String at(String template, DateTime when) => template.replaceFirst('{when}', stampLabel(when, now));
    String again(String rest) => at(t.wakeStatusAgain, wake.wakeAt).replaceFirst('{rest}', rest);
    return switch (state) {
      WakeState.checked => wake.checkedAt == null ? t.wakeStatusCheckedNoTime : at(t.wakeStatusChecked, wake.checkedAt!),
      WakeState.canceled => at(t.wakeStatusCanceled, wake.wakeAt),
      WakeState.fired => at(t.wakeStatusFired, wake.firedAt!),
      WakeState.soon => again(t.timeSoon),
      WakeState.waiting => again(inLabel(wake.wakeAt, now, t)),
      WakeState.passed => at(t.wakeStatusPassed, wake.wakeAt),
    };
  }
}

/// 지난 예약·확인 묶음의 머리 줄. 누르면 원래 순서로 펼친다.
class PastRunRow extends StatelessWidget {
  const PastRunRow({super.key, required this.run, required this.open, required this.onToggle});

  final FeedPastRun run;
  final bool open;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final rows = run.rows;
    final name = context.app.displayNameOf(rows.first.authorId);
    final count = '${run.items.length}';
    final from = stampLabel(rows.first.createdAt, DateTime.now().toUtc());
    final to = clockLabel(rows.last.createdAt);
    final range = from.endsWith(to) ? from : '$from–$to';
    final summary = t.pastRunSummary.replaceFirst('{n}', count).replaceFirst('{range}', range);
    final label = (open ? t.pastRunCollapse : t.pastRunExpand).replaceFirst('{name}', name).replaceFirst('{n}', count);
    return Semantics(
      button: true,
      expanded: open,
      label: label,
      excludeSemantics: true,
      child: InkWell(
        key: Key('past-run-${run.key}'),
        onTap: onToggle,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter, vertical: 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(Icons.schedule, size: 13, color: k.fgSubtle),
              ),
              const SizedBox(width: 7),
              Expanded(
                child: Text.rich(
                  TextSpan(children: [
                    TextSpan(text: name, style: TextStyle(fontWeight: FontWeight.w600, color: k.fgAgent)),
                    TextSpan(text: ' $summary'),
                  ]),
                  style: TextStyle(fontSize: 12, height: 1.38, color: k.fgSubtle),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 7),
              Icon(open ? Icons.expand_more : Icons.chevron_right, size: 15, color: k.fgSubtle),
            ],
          ),
        ),
      ),
    );
  }
}

/// 완료 보고.
///
/// **강조색을 쓰지 않는다.** 읽히는 말이지 막는 말이 아니다 — 보고에 강조를 주면
/// "내 차례"(`ask`)라는 신호가 그만큼 흐려진다.
class ReportCard extends StatelessWidget {
  const ReportCard({super.key, required this.message, required this.report});

  final MessageRow message;
  final ReportMeta report;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final theme = Theme.of(context);

    return Card(
      key: Key('report-${message.id}'),
      // 메시지 줄 **안에** 덧붙는다(본문·이름은 줄이 그린다) — 바깥 여백이 없다.
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.check_circle_outline, size: 16, color: theme.colorScheme.outline),
                const SizedBox(width: 6),
                Text(t.reportTitle, style: theme.textTheme.labelMedium),
                const Spacer(),
                if (report.duration != null)
                  Text(tookLabel(report.duration!, t), style: theme.textTheme.labelSmall),
              ],
            ),
            _Section(title: t.reportChecks, items: report.checks),
            _Section(title: t.reportFiles, items: report.files),
            // 남은 것은 **숨기지 않는다** — 숨기면 끝난 것처럼 보인다.
            _Section(title: t.reportRemaining, items: report.remaining),
            if (report.next.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(t.reportNext, style: theme.textTheme.labelSmall),
              const SizedBox(height: 4),
              Wrap(
                spacing: 6,
                children: [
                  for (final n in report.next)
                    ActionChip(
                      key: Key('report-next-${message.id}-${n.id}'),
                      label: Text(n.label),
                      // 누르면 **새 부탁을 그대로 올린다.** 사람이 다시 타이핑하지 않는
                      // 것이 이 어휘의 존재 이유다.
                      onPressed: () => context.app.send(message.channelId, n.label,
                          threadRootId: message.threadRootId ?? message.id),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 실패. **`retryable` 이 사람이 할 일을 가른다.**
class FailureCard extends StatelessWidget {
  const FailureCard({super.key, required this.message, required this.failure});

  final MessageRow message;
  final FailureMeta failure;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final theme = Theme.of(context);

    return Card(
      key: Key('failure-${message.id}'),
      margin: EdgeInsets.zero,
      color: theme.colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.error_outline, size: 16, color: theme.colorScheme.error),
                const SizedBox(width: 6),
                Text(t.failureTitle, style: theme.textTheme.labelMedium),
                const Spacer(),
                Text(
                  failure.retryable ? t.failureRetryable : t.failureNeedsHand,
                  style: theme.textTheme.labelSmall,
                ),
              ],
            ),
            // 본문은 줄이 위에 그린다. `what` 이 본문과 같으면 **두 번 그리지 않는다.**
            if (failure.what != null && failure.what!.trim() != message.body.trim()) ...[
              const SizedBox(height: 8),
              Text(failure.what!),
            ],
            if (failure.reason != null) ...[
              const SizedBox(height: 4),
              Text(failure.reason!, style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.items});

  final String title;
  final List<String> items;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.labelSmall),
          const SizedBox(height: 2),
          for (final item in items)
            Padding(
              padding: const EdgeInsets.only(left: 4, top: 1),
              child: Text('· $item', style: theme.textTheme.bodySmall),
            ),
        ],
      ),
    );
  }
}

/// 접힌 에이전트 주고받기 한 줄 — 「forge ↔ codex · 끝냈다 테스트 통과 · 3번 주고받음」.
///
/// 데스크톱 `AgentExchange` 의 접힌 줄과 같은 말을 같은 순서로 싣는다: 참여자 → 결론(없으면
/// 마지막 말 한 줄) → 횟수. **줄 전체가 손잡이다**(데스크톱과 같다 — 「펼치기」 글자를 두지 않는다).
/// 펼친 상태에서는 머리 줄 「forge ↔ codex · 접기」가 되고, 펼친 줄들은 부르는 쪽이 아래에 세운다.
class ExchangeRow extends StatelessWidget {
  const ExchangeRow({super.key, required this.exchange, required this.open, required this.onToggle});

  final FoldExchange exchange;
  final bool open;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final k = context.tokens;
    final messages = exchange.messages;
    final names = exchangeParticipants(messages).map(app.displayNameOf).join(' ↔ ');
    final speech = messages.where(isExchangeSpeech).length;

    final List<InlineSpan> rest;
    if (open) {
      rest = [TextSpan(text: ' · ${t.exchangeCollapse}', style: TextStyle(color: k.fgSubtle))];
    } else {
      final conclusion = exchangeConclusion(messages);
      final last = conclusion == null
          ? exchangeLastLine(messages, (m) => renderMentions(m.body, app.accounts, t.mentionUnknown))
          : null;
      rest = [
        if (conclusion != null) ...[
          TextSpan(
            text: ' · ${conclusion.source == ExchangeConclusionSource.ask ? t.exchangeDecided : t.exchangeFinished} ',
            style: TextStyle(color: k.fgSubtle),
          ),
          TextSpan(text: conclusion.text, style: TextStyle(color: k.fgMuted)),
        ] else if (last != null) ...[
          TextSpan(text: ' · ${app.displayNameOf(last.authorId)}: ', style: TextStyle(color: k.fgSubtle)),
          TextSpan(
            text: last.text ?? t.exchangeAttachments(last.attachments ?? 0),
            style: TextStyle(color: k.fgMuted),
          ),
        ],
      ];
    }
    final base = TextStyle(fontSize: 12, height: 1.35, color: k.fgAgent);

    return Semantics(
      button: true,
      expanded: open,
      child: InkWell(
        key: Key('exchange-${exchange.rows.first.id}'),
        onTap: onToggle,
        child: Padding(
          // 본문 열(아바타 뒤)에 맞춘다 — 진행 줄(`ProgressRow`)과 같은 들여쓰기.
          padding: const EdgeInsets.fromLTRB(
              HarkroomSize.gutter + HarkroomSize.avatar + 10, 8, HarkroomSize.gutter, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(color: k.borderAgent, borderRadius: BorderRadius.circular(1.5)),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text.rich(
                  TextSpan(
                    style: base,
                    children: [
                      TextSpan(text: names, style: const TextStyle(fontWeight: FontWeight.w600)),
                      ...rest,
                    ],
                  ),
                  key: Key('exchange-line-${exchange.rows.first.id}'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              // 횟수는 **말줄임 밖** 줄 끝에 따로 선다(designer d1) — 미리보기와 한 글에 두면 마지막 말이 길 때
              // 말줄임이 횟수까지 잘랐다. 데스크톱 접힌 줄의 `truncate` + `shrink-0` 과 같은 꼴이다.
              if (!open)
                Text(
                  ' · ${t.exchangeCount(speech)}',
                  key: Key('exchange-count-${exchange.rows.first.id}'),
                  style: base.copyWith(color: k.fgSubtle),
                  maxLines: 1,
                  softWrap: false,
                ),
              Icon(open ? Icons.expand_less : Icons.expand_more, size: 16, color: k.fgSubtle),
            ],
          ),
        ),
      ),
    );
  }
}
