import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../ui/states.dart';
import '../state/app_state.dart';
import '../ui/tokens.dart';
import '../mention/render.dart';
import 'message_list_screen.dart';
import 'thread_screen.dart';

/// 나를 부른 것들.
///
/// **사유를 갈라 보여 준다.** "누가 나를 불렀다"와 "내가 낸 물음에 답이 왔다"는 다른
/// 일이고, 사람이 할 일도 다르다 — 서버가 그 둘을 갈라 둔 이유와 같다.
class InboxScreen extends StatelessWidget {
  const InboxScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;

    return Scaffold(
      appBar: AppBar(
        title: Text(t.tabInbox),
        actions: [
          if (app.inboxUnread > 0)
            TextButton(
              key: const Key('inbox-mark-all'),
              onPressed: () => app.markInboxRead(
                app.inbox.where((e) => e.isUnread).map((e) => e.id).toList(growable: false),
              ),
              child: Text(t.inboxMarkAllRead),
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            const ConnectionBand(),
            Expanded(
              // 이미 읽은 목록이 있으면 상태와 관계없이 그것을 보인다 — 다시 읽다 실패했다고
              // 있던 줄을 지우지 않는다(`loadInbox` 의 같은 판단).
              child: app.inbox.isNotEmpty
                  ? RefreshIndicator(
                      onRefresh: app.loadInbox,
                      child: ListView.builder(
                        itemCount: app.inbox.length,
                        itemBuilder: (context, i) => _InboxRow(entry: app.inbox[i]),
                      ),
                    )
                  : switch (app.inboxLoad) {
                      LoadState.loading => const LoadingSkeleton(rows: 3),
                      LoadState.failed =>
                        FailedState(title: t.inboxLoadFailed, onRetry: app.loadInbox),
                      LoadState.loaded => EmptyState(title: t.inboxEmpty, hint: t.inboxEmptyHint),
                    },
            ),
          ],
        ),
      ),
    );
  }
}

class _InboxRow extends StatelessWidget {
  const _InboxRow({required this.entry});

  final InboxEntry entry;

  /// 사유 → 문구. 모르는 사유도 **줄을 지우지 않는다** — 사유를 몰라도 보이는 편이
  /// 낫다(서버가 사유를 하나 더하는 날 그 부름이 사라지면 안 된다).
  static String _reason(Strings t, InboxReason r) => switch (r) {
        InboxReason.mention || InboxReason.teamMention => t.inboxReasonMention,
        InboxReason.threadReply => t.inboxReasonThreadReply,
        InboxReason.dm => t.inboxReasonDm,
        InboxReason.askAnswered => t.inboxReasonAskAnswered,
        InboxReason.askClosed => t.inboxReasonAskClosed,
        _ => t.inboxReasonOther,
      };

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final theme = Theme.of(context);
    final who = entry.authorId == null ? null : app.displayNameOf(entry.authorId!);

    return ListTile(
      key: Key('inbox-${entry.id}'),
      // 안 본 것에만 점을 찍는다.
      leading: entry.isUnread
          ? Icon(Icons.circle, size: 8, color: context.tokens.accent)
          : const SizedBox(width: 10),
      title: Text(
        who == null ? _reason(t, entry.reason) : '$who · ${_reason(t, entry.reason)}',
        style: theme.textTheme.labelMedium,
      ),
      subtitle: Text(renderMentions(entry.body, context.app.accounts, context.t.mentionUnknown), maxLines: 2, overflow: TextOverflow.ellipsis),
      onTap: () async {
        // 열면 읽음이 된다. **누르기 전에 읽음으로 만들지 않는다** — 목록을 훑기만
        // 해도 사라지면 사람은 무엇이 있었는지 모른다.
        await app.markInboxRead([entry.id]);
        await app.openChannel(entry.channelId);
        if (!context.mounted) return;
        // 스레드에서 온 부름은 **그 스레드로** 데려간다. 채널만 열면 사람이 그 답글을
        // 다시 찾아야 한다.
        final rootId = entry.threadRootId;
        await Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (_) => rootId == null
              ? MessageListScreen(channelId: entry.channelId)
              : ThreadScreen(channelId: entry.channelId, rootId: rootId),
        ));
      },
    );
  }
}
