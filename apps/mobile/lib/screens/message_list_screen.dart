import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';

/// 한 채널의 말들 + 작성칸. P0 의 마지막 화면이다.
///
/// **스레드는 아직 열지 않는다**(P1). 지금은 채널의 흐름을 한 줄로 보여 주고, 답글이
/// 달린 루트에는 그 사실만 표시한다 — 없는 화면으로 들어가는 문을 그리지 않는다.
class MessageListScreen extends StatefulWidget {
  const MessageListScreen({super.key, required this.channelId});

  final String channelId;

  @override
  State<MessageListScreen> createState() => _MessageListScreenState();
}

class _MessageListScreenState extends State<MessageListScreen> {
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  bool _sending = false;

  @override
  void dispose() {
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    // **먼저 비운다.** 보내는 동안 글자가 남아 있으면 사람은 안 갔다고 생각하고 다시
    // 누른다. 실패하면 아래에서 되돌린다 — 친 글을 잃는 것이 더 나쁘다.
    _composer.clear();
    try {
      await context.app.send(widget.channelId, text);
    } on Object {
      if (mounted) _composer.text = text;
      rethrow;
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final all = app.messages[widget.channelId] ?? const <MessageRow>[];
    // `progress`·`wake` 는 말풍선이 아니다(서버가 `kind` 로 이미 갈라 준다). P0 에서는
    // 그것들을 **그리지 않는다** — 상태 줄·대기 줄은 P2 의 일이고, 그 전까지 말풍선으로
    // 흘리면 채널이 진행 로그로 덮인다.
    final speech = all.where((m) => m.isSpeech).toList(growable: false);
    // `firstOrNull` 은 `package:collection` 것이다. 의존성 하나를 이것 때문에 들이지
    // 않는다 — 채널이 목록에서 사라지는 경우(다른 기기에서 나갔다)가 있으므로 null 은
    // 정상이고, 그때 제목은 빈 줄로 둔다.
    ChannelRow? channel;
    for (final c in app.channels) {
      if (c.id == widget.channelId) {
        channel = c;
        break;
      }
    }

    return Scaffold(
      appBar: AppBar(title: Text(channel?.name ?? '')),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: speech.isEmpty
                  ? Center(child: Text(t.messagesEmpty))
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      itemCount: speech.length,
                      itemBuilder: (context, i) => _MessageRowTile(message: speech[i]),
                    ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('composer'),
                      controller: _composer,
                      minLines: 1,
                      maxLines: 5,
                      textInputAction: TextInputAction.newline,
                      decoration: InputDecoration(
                        // 에이전트를 부르는 방법이 **여기에만** 적혀 있다 — 별도 버튼이
                        // 없으므로 화면이 말해 주지 않으면 알 길이 없다.
                        hintText: t.composerHint,
                        border: const OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  IconButton(
                    key: const Key('composer-send'),
                    tooltip: t.composerSend,
                    icon: const Icon(Icons.send),
                    onPressed: _sending ? null : _send,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageRowTile extends StatelessWidget {
  const _MessageRowTile({required this.message});

  final MessageRow message;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final t = context.t;
    final author = app.accounts[message.authorId];
    final theme = Theme.of(context);

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
          // 마크다운은 아직 그리지 않는다(P1). 평문으로 흘리는 것이, 반쯤 해석해서
          // 원문을 잃는 것보다 낫다.
          Text(message.body),
          if (message.attachments.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                message.attachments.map((a) => a.filename).join(', '),
                style: theme.textTheme.bodySmall,
              ),
            ),
        ],
      ),
    );
  }
}
