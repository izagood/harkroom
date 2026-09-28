import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';

/// 말풍선 한 줄. **채널 화면과 스레드 화면이 같은 것을 쓴다.**
///
/// 두 벌로 두면 한쪽에만 리액션이 붙거나 한쪽만 작성자를 다르게 그리게 된다 — 같은
/// 메시지가 화면마다 달라 보이는 것이 사람이 앱을 못 믿게 되는 가장 빠른 길이다.
class MessageTile extends StatelessWidget {
  const MessageTile({
    super.key,
    required this.message,
    this.onOpenThread,
  });

  final MessageRow message;

  /// 스레드로 들어가는 길. **스레드 화면 안에서는 `null`** 이다 — 이미 그 안이라
  /// 들어갈 곳이 없다.
  final void Function()? onOpenThread;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final t = context.t;
    final theme = Theme.of(context);
    final author = app.accounts[message.authorId];

    return Padding(
      key: Key('message-${message.id}'),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Flexible(
                child: Text(
                  app.displayNameOf(message.authorId),
                  style: theme.textTheme.labelLarge,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              // 사람과 에이전트를 **갈라 보여 준다** — 누구를 부르는지, 누가 답했는지가
              // 이 앱의 주제다.
              if (author?.isAgent == true) ...[
                const SizedBox(width: 6),
                Text(
                  t.agentBadge,
                  style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.primary),
                ),
              ],
            ],
          ),
          const SizedBox(height: 2),
          // 마크다운은 아직 그리지 않는다. 평문으로 흘리는 것이, 반쯤 해석해서 원문을
          // 잃는 것보다 낫다.
          Text(message.body),
          if (message.attachments.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                message.attachments.map((a) => a.filename).join(', '),
                style: theme.textTheme.bodySmall,
              ),
            ),
          if (message.reactions.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: _Reactions(message: message),
            ),
          if (onOpenThread != null && _replyLabel(t, message) != null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: Key('thread-open-${message.id}'),
                onPressed: onOpenThread,
                child: Text(_replyLabel(t, message)!),
              ),
            ),
        ],
      ),
    );
  }

  /// 답글 수 줄의 문구. **`replyCount` 가 `null` 이면 아무것도 그리지 않는다** —
  /// 그건 "답글이 0개"가 아니라 "이 질문의 대상이 아니다"(답글 자신)이다.
  ///
  /// 0 일 때는 *"답글 달기"* 로 문을 열어 둔다. 스레드는 사람이 시작해야 생긴다.
  static String? _replyLabel(Strings t, MessageRow m) {
    final count = m.replyCount;
    if (count == null) return null;
    if (count == 0) return t.threadRepliesZero;
    if (count == 1) return t.threadRepliesOne;
    return t.threadRepliesMany.replaceFirst('{n}', '$count');
  }
}

/// 이모지 칸들. 누른 것은 강조된다 — 내가 눌렀는지를 화면이 알아야 한다.
class _Reactions extends StatelessWidget {
  const _Reactions({required this.message});

  final MessageRow message;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final mine = app.me?.id;
    final theme = Theme.of(context);

    return Wrap(
      spacing: 6,
      runSpacing: 4,
      children: [
        for (final r in message.reactions)
          ActionChip(
            key: Key('reaction-${message.id}-${r.emoji}'),
            visualDensity: VisualDensity.compact,
            backgroundColor:
                mine != null && r.accountIds.contains(mine) ? theme.colorScheme.primaryContainer : null,
            label: Text('${r.emoji} ${r.accountIds.length}'),
            onPressed: () => app.toggleReaction(message.channelId, message.id, r.emoji),
          ),
      ],
    );
  }
}
