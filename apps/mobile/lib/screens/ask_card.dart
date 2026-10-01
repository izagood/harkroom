import 'package:flutter/material.dart';

import '../api/ask.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
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
                (false, _) => ask.answeredWith != null ? t.askAnswered : t.askClosed,
                (true, AskAccount()) => t.askToYou,
                (true, AskAnyHuman()) => t.askToAnyone,
              },
              style: theme.textTheme.labelSmall,
            ),
            // 본문에 이미 물음이 적혀 있으면 `prompt` 가 없다 — **같은 말을 두 번 그리지
            // 않는다.**
            if (ask.prompt != null) ...[
              const SizedBox(height: 6),
              Text(ask.prompt!, style: theme.textTheme.bodyMedium),
            ],
            const SizedBox(height: 10),
            if (ask.isOpen)
              ...ask.options.map(
                (o) => Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: SizedBox(
                    width: double.infinity,
                    child: OutlinedButton(
                      key: Key('ask-option-${widget.message.id}-${o.id}'),
                      // 옅은 주황 면 위에서 테두리만 있는 버튼은 묻힌다 — 바탕색으로 채워 띄운다.
                      style: OutlinedButton.styleFrom(backgroundColor: context.tokens.bg),
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
            else
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

  /// 고른 선택지의 이름. 서버가 모르는 id 를 주면 `null` — 지어내지 않는다.
  static String? _chosenLabel(AskMeta ask) {
    for (final o in ask.options) {
      if (o.id == ask.answeredWith) return o.label;
    }
    return null;
  }
}
