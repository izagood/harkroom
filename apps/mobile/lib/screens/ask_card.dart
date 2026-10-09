import 'package:flutter/material.dart';

import '../api/ask.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';

/// 선택 요청을 **누를 수 있는 것**으로 그린다.
///
/// 이것이 P1 인 이유는 `api/ask.dart` 머리에 적혀 있다 — 답이 없으면 그 턴은 멈추고,
/// 답할 수 없는 클라이언트에서는 *"불렀는데 조용한"* 것이 정상이 된다.
///
/// ## 강조는 **내 차례일 때만**
///
/// 모든 물음에 강조를 주면 그 색은 곧 배경이 되고, 정작 내가 막고 있는 물음도 안 읽힌다.
/// 그래서 `to` 가 나이거나 *사람 아무나*일 때만 세운다.
class AskCard extends StatefulWidget {
  const AskCard({super.key, required this.message, required this.ask});

  final MessageRow message;
  final AskMeta ask;

  @override
  State<AskCard> createState() => _AskCardState();
}

class _AskCardState extends State<AskCard> {
  bool _busy = false;

  /// 글로 답한 카드의 「그래도 고르기」를 펼쳤나.
  bool _pickAnyway = false;

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } on Object {
      // **조용히 지나가지 않는다.** 버튼이 그대로 서 있으면 사람은 눌린 줄 모르고, 그 턴은
      // 답을 못 받은 채 멈춰 있다. 같은 동작을 "다시 시도"로 단다.
      if (mounted) showFailureToast(context, context.t.askFailed, retry: () => _run(action));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final ask = widget.ask;
    final theme = Theme.of(context);

    final mine = switch (ask.to) {
      AskAnyHuman() => true,
      AskAccount(accountId: final id) => id == app.me?.id,
    };
    final highlight = ask.isOpen && mine;
    // 글로 답한 카드(A′)는 펼친 뒤에만 다시 고른다. 강조는 주지 않는다 — 차례는 이미 넘어갔다.
    final canPickLate = ask.isReplied && mine && _pickAnyway;
    final showOptions = ask.isOpen || canPickLate;
    final closedBy = ask.closedBy == null ? null : app.accounts[ask.closedBy!];
    final closedByName = closedBy == null
        ? null
        : (closedBy.displayName.isNotEmpty ? closedBy.displayName : closedBy.handle);
    final quote = ask.isReplied ? _replyQuote(app, widget.message, ask.replyMessageId) : null;

    return Card(
      key: Key('ask-${widget.message.id}'),
      // 메시지 줄 안에 덧붙는다 — 무엇을 묻는지(본문)와 누가 묻는지(이름)는 줄이 그린다.
      margin: EdgeInsets.zero,
      color: highlight ? theme.colorScheme.primaryContainer : null,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              switch ((ask.isOpen, ask.to)) {
                (false, _) when ask.answeredWith != null => t.askAnswered,
                (false, _) when ask.isReplied =>
                  closedByName == null ? t.askReplied : '${t.askReplied} · $closedByName',
                (false, _) when ask.isSuperseded => t.askSuperseded,
                (false, _) => t.askClosed,
                (true, AskAccount()) => t.askToYou,
                (true, AskAnyHuman()) => t.askToAnyone,
              },
              key: Key('ask-head-${widget.message.id}'),
              style: theme.textTheme.labelSmall,
            ),
            // 본문에 이미 물음이 적혀 있으면 `prompt` 가 없다 — **같은 말을 두 번 그리지
            // 않는다.** 대신된 카드는 한 줄로 접힌다 — 물음은 새 카드에 있다.
            if (ask.prompt != null && !ask.isSuperseded) ...[
              const SizedBox(height: 6),
              Text(ask.prompt!, style: theme.textTheme.bodyMedium),
            ],
            if (quote != null && quote.isNotEmpty) ...[
              const SizedBox(height: 6),
              Container(
                key: Key('ask-reply-quote-${widget.message.id}'),
                padding: const EdgeInsets.only(left: 8),
                decoration: BoxDecoration(
                  border: Border(left: BorderSide(color: theme.dividerColor, width: 2)),
                ),
                child: Text(quote, maxLines: 1, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
              ),
            ],
            if (!ask.isSuperseded) const SizedBox(height: 10),
            if (ask.isReplied && mine && !_pickAnyway)
              TextButton(
                key: Key('ask-pick-anyway-${widget.message.id}'),
                style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 32)),
                onPressed: () => setState(() => _pickAnyway = true),
                child: Text(t.askPickAnyway(ask.options.length)),
              ),
            if (showOptions)
              ...ask.options.map(
                (o) => Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      key: Key('ask-option-${widget.message.id}-${o.id}'),
                      // 옅은 주황 면 위에서 테두리만 있는 버튼은 묻힌다 — 바탕색으로 채워 띄운다.
                      style: OutlinedButton.styleFrom(backgroundColor: context.tokens.surface),
                      onPressed: _busy
                          ? null
                          : () => _run(() =>
                              app.answerAsk(widget.message.channelId, widget.message.id, o.id)),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Align(alignment: Alignment.centerLeft, child: Text(o.label)),
                          if (o.hint != null)
                            Align(
                              alignment: Alignment.centerLeft,
                              child: Text(o.hint!, style: theme.textTheme.bodySmall),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              )
            else if (ask.answeredWith != null || !(ask.isReplied || ask.isSuperseded))
              // **고른 것을 남긴다.** 버튼이 사라지고 결과가 그 자리에 선다 — 누른 뒤에도
              // 버튼이 있으면 사람은 자기가 누른 것을 의심한다.
              Text(
                _chosenLabel(ask) ?? '—',
                key: Key('ask-chosen-${widget.message.id}'),
                style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
              ),
            if (ask.isOpen && mine)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  key: Key('ask-decline-${widget.message.id}'),
                  onPressed: _busy
                      ? null
                      : () => _run(
                          () => app.closeAsk(widget.message.channelId, widget.message.id)),
                  child: Text(t.askDecline),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// 카드를 닫은 사람 글의 첫 줄(80자까지, 데스크톱 `quoteLine` 과 같다). 읽어 둔 목록에
  /// 없거나 **다른 스레드의 글**이면 `null` — 인용 줄만 빠진다. 지운 글은 목록에서 빠지므로
  /// 따로 거를 것이 없다(`message.deleted`).
  static String? _replyQuote(AppState app, MessageRow message, String? replyId) {
    if (replyId == null) return null;
    final root = message.threadRootId ?? message.id;
    final pool = [...?app.threads[root], ...?app.messages[message.channelId]];
    MessageRow? hit;
    for (final m in pool) {
      if (m.id == replyId && (m.threadRootId ?? m.id) == root) {
        hit = m;
        break;
      }
    }
    if (hit == null) return null;
    final lines = hit.body
        .replaceAll(RegExp(r'<@[0-9a-f-]{36}>\s*'), '')
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.isNotEmpty);
    if (lines.isEmpty) return null;
    final line = lines.first;
    return line.length > 80 ? '${line.substring(0, 79)}…' : line;
  }

  /// 고른 선택지의 이름. 서버가 모르는 id 를 주면 `null` — 지어내지 않는다.
  static String? _chosenLabel(AskMeta ask) {
    for (final o in ask.options) {
      if (o.id == ask.answeredWith) return o.label;
    }
    return null;
  }
}
