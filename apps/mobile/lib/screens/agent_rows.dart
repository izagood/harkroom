import 'package:flutter/material.dart';

import '../api/agent_meta.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../time.dart';
import '../ui/tokens.dart';
import '../mention/render.dart';

/// 진행 줄 — **말풍선이 아니라 상태 한 줄**이다.
///
/// 진행은 수십 개가 이어진다. 말풍선으로 흘리면 채널이 진행 로그로 덮이고, 정작 사람이
/// 읽어야 할 말이 그 사이에 묻힌다. 그래서 **이어진 것을 한 줄로 접고 마지막 것만**
/// 보여 준다 — 데스크탑 `ProgressRow` 와 같은 판단이다.
class ProgressRow extends StatelessWidget {
  const ProgressRow({super.key, required this.run});

  /// 이어진 진행들(시간 순). 마지막이 지금 하는 일이다.
  final List<MessageRow> run;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final last = run.last;
    final elapsed = DateTime.now().toUtc().difference(run.first.createdAt);

    final k = context.tokens;
    final muted = TextStyle(fontSize: 12, color: k.fgMuted, height: 1.35);
    // 개정판 3.3: 본문 열(아바타 뒤)에 맞춘 회색 한 줄 「◌ designer 작업 중 · 2분째 — 문구」.
    // 가장 최근 줄이면 목록이 아래부터 쌓이므로 작성칸 바로 위에 선다(따로 고정하지 않는다 —
    // 뒤에 말이 오면 그 말 위, 일이 일어난 순서 자리에 남는다).
    return Padding(
      key: Key('progress-${last.id}'),
      padding: const EdgeInsets.fromLTRB(
          HarkroomSize.gutter + HarkroomSize.avatar + 10, 4, HarkroomSize.gutter, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 2),
            child: SizedBox(width: 11, height: 11, child: CircularProgressIndicator(strokeWidth: 1.6)),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              '${app.displayNameOf(last.authorId)} ${t.agentWorking} · ${runningLabel(elapsed, t)} — '
              '${renderMentions(last.body, context.app.accounts, context.t.mentionUnknown)}',
              style: muted,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          // 접힌 진행이 여럿이면 몇 개인지(누르면 펼치는 것은 이 줄의 일이 아니다).
          if (run.length > 1) ...[
            const SizedBox(width: 6),
            Text('${run.length}', key: Key('progress-count-${last.id}'), style: muted),
          ],
        ],
      ),
    );
  }
}

/// 대기 줄 — 에이전트가 **언제 다시 볼지** 걸어 둔 예약.
///
/// 이것이 없으면 기다리는 스레드는 그냥 조용한 스레드와 구별되지 않는다.
class WakeRow extends StatelessWidget {
  const WakeRow({super.key, required this.message, required this.wake});

  final MessageRow message;
  final WakeMeta wake;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final theme = Theme.of(context);
    // 서버는 ISO 시각만 싣는다 — **읽는 쪽이 자기 시간대로 읽는다.**
    final when = inLabel(wake.wakeAt, DateTime.now().toUtc(), t);

    return Padding(
      key: Key('wake-${message.id}'),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Row(
        children: [
          Icon(Icons.schedule, size: 14, color: theme.colorScheme.outline),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              wake.reason == null
                  ? '${t.agentWaiting} · $when'
                  : '${t.agentWaiting} · $when — ${wake.reason}',
              style: theme.textTheme.bodySmall,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
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
