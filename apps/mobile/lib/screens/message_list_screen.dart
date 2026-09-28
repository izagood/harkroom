import 'package:flutter/material.dart';

import '../api/ask.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../mention/mention_suggest.dart';
import '../state/app_scope.dart';
import 'ask_card.dart';

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
                      itemBuilder: (context, i) {
                        final m = speech[i];
                        // 선택 요청은 **말풍선이 아니라 누를 수 있는 것**이다.
                        final ask = AskMeta.read(m.meta);
                        if (ask != null) return AskCard(message: m, ask: ask);
                        return _MessageRowTile(message: m);
                      },
                    ),
            ),
            _MentionPicker(
              controller: _composer,
              onPicked: (handle) {
                final sel = _composer.selection;
                final cursor = sel.isValid ? sel.baseOffset : _composer.text.length;
                final query = mentionQueryAt(_composer.text, cursor);
                if (query == null) return;
                final next = applyMention(_composer.text, query, handle);
                _composer.value = TextEditingValue(
                  text: next.text,
                  selection: TextSelection.collapsed(offset: next.cursor),
                );
                setState(() {});
              },
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
                      // 글자가 바뀔 때마다 후보를 다시 세운다. 커서만 움직여도 바뀌므로
                      // `onChanged` 로는 모자라지만, 그 경우는 다음 입력에 따라잡힌다.
                      onChanged: (_) => setState(() {}),
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


/// 컴포저 위에 서는 멘션 후보 줄.
///
/// **없을 때는 자리를 차지하지 않는다**(`SizedBox.shrink`). 늘 떠 있으면 그 줄은 곧
/// 안 보이는 것이 되고, 화면 높이만 먹는다.
class _MentionPicker extends StatelessWidget {
  const _MentionPicker({required this.controller, required this.onPicked});

  final TextEditingController controller;
  final void Function(String handle) onPicked;

  @override
  Widget build(BuildContext context) {
    final sel = controller.selection;
    final cursor = sel.isValid ? sel.baseOffset : controller.text.length;
    final query = mentionQueryAt(controller.text, cursor);
    if (query == null) return const SizedBox.shrink();

    final app = context.app;
    // **비활성 계정은 후보에서 뺀다.** 디렉터리에는 남아 있어야 하지만(과거 메시지의
    // 작성자를 푸는 표다) 부를 수는 없다.
    final candidates = rankMentionCandidates(
      app.accounts.values.where((a) => !a.isDisabled),
      query.prefix,
      handleOf: (a) => a.handle,
      displayNameOf: (a) => a.displayName,
    );
    if (candidates.isEmpty) return const SizedBox.shrink();

    return SizedBox(
      key: const Key('mention-picker'),
      height: 52,
      child: ListView.builder(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        itemCount: candidates.length,
        itemBuilder: (context, i) {
          final a = candidates[i];
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
            child: ActionChip(
              key: Key('mention-candidate-${a.handle}'),
              avatar: a.isAgent ? const Icon(Icons.smart_toy_outlined, size: 16) : null,
              label: Text('@${a.handle}'),
              onPressed: () => onPicked(a.handle),
            ),
          );
        },
      ),
    );
  }
}
