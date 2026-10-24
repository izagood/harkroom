import 'package:flutter/material.dart';

import '../api/ask.dart';
import '../api/models.dart';
import '../api/permission_card.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'message_link.dart';
import 'permission_card_view.dart';

/// r5(designer F1): 권한 카드가 줄 상자를 그리면(`_permission` 의 [PermissionLineBox] 조건과 같다) 본문에서 서버가 쓴
/// 대상 줄(meta `bodyTargetLine`) **하나만** 뺀다 — 줄 상자가 같은 것을 말한다. 줄 상자를 안 그리면 본문 그대로.
String permissionCardBody(String body, Map<String, Object?> meta) {
  final ask = AskMeta.read(meta);
  if (ask == null) return body;
  final perm = PermissionCardInfo.read(meta);
  if (perm == null || perm.neutral || perm.line == null) return body;
  if (perm.status == 'superseded' || ask.isSuperseded) return body;
  final target = perm.bodyTargetLine;
  if (target == null || target.isEmpty) return body;
  final lines = body.split('\n');
  final i = lines.indexOf(target);
  if (i < 0) return body;
  lines.removeAt(i);
  return lines.join('\n');
}

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
    final perm = PermissionCardInfo.read(widget.message.meta);
    if (perm != null) return _permission(context, app, ask, perm);

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
                (false, _) when ask.isExpired => '${t.askExpired} · ${t.askExpiredHint}',
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
            else if (ask.answeredWith != null || !(ask.isReplied || ask.isSuperseded || ask.isExpired))
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

  /// 권한 카드(W4 위임장, 시안 §5 모바일 375pt) — 칩 · 줄 상자 · 세로로 쌓은 44pt 버튼 · 끝난 상태.
  /// 원본과 진짜 거울은 같은 카드다. 중립 거울은 중립 한 줄과 원본 링크만 그린다.
  Widget _permission(BuildContext context, AppState app, AskMeta ask, PermissionCardInfo perm) {
    final t = context.t;
    final tok = context.tokens;
    final theme = Theme.of(context);
    final id = widget.message.id;

    if (perm.neutral) {
      return Card(
        key: Key('ask-$id'),
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(t.permMirrorNeutral, key: Key('perm-neutral-$id'), style: theme.textTheme.bodyMedium),
              const SizedBox(height: 4),
              TextButton(
                key: Key('perm-open-original-$id'),
                style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 44)),
                onPressed: () => openMessageLink(context, perm.mirrorRootId!),
                child: Text('↪ ${t.permOpenOriginal}'),
              ),
            ],
          ),
        ),
      );
    }

    final meId = app.me?.id;
    // 소유자나 나를 모르면 **소유자가 아니라고 본다** — 버튼 없이 읽기 전용 줄만.
    final owner = perm.ownerId != null && meId != null && perm.ownerId == meId;
    final ended = perm.mandate?.ended ?? false;
    final open = ask.isOpen && (perm.status == null || perm.status == 'pending') && !ended;
    final canPickLate = ask.isReplied && owner && _pickAnyway && !ended;
    final showOptions = (open || canPickLate) && owner;

    // 선택지 — 서버가 실은 순서대로. 머지 거절 카드의 [이번 한 번]은 서버가 선택지에 싣지 않는다(once 칸으로 그린다).
    final ids = [for (final o in ask.options) o.id];
    final hasMandateOpt = ids.contains(permOptApproveMandate) || ids.contains(permOptApproveNewMandate);
    final order = <String>[
      if (ids.contains(permOptApproveMandate)) permOptApproveMandate,
      if (ids.contains(permOptApproveNewMandate)) permOptApproveNewMandate,
      if (ids.contains(permOptApproveOnce) || perm.once != null) permOptApproveOnce,
    ];
    String label(String o) => switch (o) {
          permOptApproveMandate => t.permApproveMandate,
          permOptApproveNewMandate => t.permApproveNewMandate,
          permOptApproveOnce => perm.once == null
              ? t.permApproveOnce
              : '${perm.once!.ci ? t.mergeOnceCiButton : t.permApproveOnce} (PR #${perm.once!.number})',
          _ => o,
        };
    // 줄 상자의 한도는 한 선택지의 것만 — 열린 카드는 주 버튼, 끝난 카드는 고른 선택지(데스크톱과 같다).
    // PR·head 는 [이번 한 번]의 한도라 그 선택지일 때만 보인다 — 늘 보이면 [이 위임장 동안]이 PR 하나에 묶인 것처럼 읽힌다.
    final primary = order.isEmpty ? null : order.first;
    final shown = open ? primary : (ask.answeredWith ?? (perm.status == 'approved_once' ? permOptApproveOnce : null));
    final shownLimits = shown == null ? null : perm.line?.limits[shown];
    final shownOnce = shown == permOptApproveOnce ? perm.once : null;

    // r3: 머리는 i18n 키뿐 — 서버의 `ask.prompt`(한국어 고정 「권한을 줄까?」)는 줄 카드에 다시 그리지 않는다(데스크톱과 같은 말).
    final newMandate = hasMandateOpt && !ids.contains(permOptApproveMandate);
    final ownerHandle = perm.ownerId == null ? null : app.accounts[perm.ownerId!]?.handle;
    // r5(designer nit): 새 위임장 머리도 소유자를 알면 「· {owner} 차례」 꼬리를 단다.
    final turnTail = ownerHandle != null ? ' · ${t.permAskOwnerTurn(ownerHandle)}' : owner ? ' · ${t.askToYou}' : '';
    final head = open ? '${newMandate ? t.permAskNewMandate : t.permAskAddLine}$turnTail' : null;

    String? endedText;
    final s = perm.status;
    final chose = ask.answeredWith;
    if (ended && (s == null || s == 'pending')) {
      endedText = t.permStateMandateEnded;
    } else if (s == 'denied' || chose == permOptDeny) {
      endedText = t.permStateDenied;
    } else if (s == 'approved_once' || chose == permOptApproveOnce || (s == 'granted' && perm.kind == 'command')) {
      endedText = perm.ghUserUsed != null ? t.permStateOnceGh(perm.ghUserUsed!) : t.permStateOnce;
    } else if (s == 'granted' || chose != null) {
      endedText = t.permStateAdded;
    } else if (s == 'superseded' || ask.isSuperseded) {
      endedText = t.permStateSuperseded;
    } else if (s == 'expired' || ask.isExpired) {
      endedText = t.permStateExpired;
    } else if (ask.isReplied) {
      endedText = t.askReplied;
    } else if (!open) {
      endedText = t.askClosed;
    }
    if (endedText != null && perm.decidedViaChat) endedText = '$endedText · ${t.permViaChat}';
    final ownerAcc = perm.mandate?.ownerId == null ? null : app.accounts[perm.mandate!.ownerId!];

    return Card(
      key: Key('ask-$id'),
      margin: EdgeInsets.zero,
      color: open && owner ? theme.colorScheme.primaryContainer : null,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (perm.isMirror) ...[
              Row(children: [
                Flexible(child: Text('↪ ${t.permMirrorOf}', style: theme.textTheme.labelSmall?.copyWith(color: tok.fgMuted))),
                TextButton(
                  key: Key('perm-open-original-$id'),
                  style: TextButton.styleFrom(minimumSize: const Size(0, 32), padding: const EdgeInsets.symmetric(horizontal: 6)),
                  onPressed: () => openMessageLink(context, perm.mirrorRootId!),
                  child: Text(t.permOpenOriginal),
                ),
              ]),
            ],
            Text(
              head ?? endedText ?? '',
              key: Key('ask-head-$id'),
              style: theme.textTheme.labelSmall?.copyWith(fontWeight: head == null ? FontWeight.w600 : null),
            ),
            if (perm.mandate != null) ...[
              const SizedBox(height: 6),
              MandateChip(mandate: perm.mandate!, ownerHandle: ownerAcc?.handle),
            ],
            if (perm.line != null && s != 'superseded' && !ask.isSuperseded) ...[
              const SizedBox(height: 8),
              PermissionLineBox(
                line: perm.line!,
                limits: shownLimits,
                once: shownOnce,
              ),
            ],
            if (ask.prompt != null && open && (perm.line == null || (perm.once?.ci ?? false))) ...[
              const SizedBox(height: 6),
              Text(ask.prompt!, style: theme.textTheme.bodyMedium),
            ],
            const SizedBox(height: 10),
            if (open && !owner)
              Text(t.permReadOnly, key: Key('perm-readonly-$id'), style: theme.textTheme.bodySmall?.copyWith(color: tok.fgMuted)),
            if (ask.isReplied && owner && !_pickAnyway && !ended && (s == null || s == 'pending'))
              TextButton(
                key: Key('ask-pick-anyway-$id'),
                style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 44)),
                onPressed: () => setState(() => _pickAnyway = true),
                child: Text(t.askPickAnyway(order.length + 1)),
              ),
            if (showOptions) ...[
              for (final o in order)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: SizedBox(
                    width: double.infinity,
                    height: 44,
                    child: o == primary
                        ? FilledButton(
                            key: Key('ask-option-$id-$o'),
                            onPressed: _busy ? null : () => _run(() => app.answerAsk(widget.message.channelId, id, o)),
                            child: Text(label(o)),
                          )
                        : OutlinedButton(
                            key: Key('ask-option-$id-$o'),
                            style: OutlinedButton.styleFrom(backgroundColor: tok.surface),
                            onPressed: _busy ? null : () => _run(() => app.answerAsk(widget.message.channelId, id, o)),
                            child: Text(label(o)),
                          ),
                  ),
                ),
              if (perm.once != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(t.permOnceOperatorPicks, style: theme.textTheme.bodySmall?.copyWith(color: tok.fgMuted)),
                ),
              SizedBox(
                width: double.infinity,
                height: 44,
                child: TextButton(
                  key: Key('ask-option-$id-$permOptDeny'),
                  style: TextButton.styleFrom(foregroundColor: tok.danger),
                  onPressed: _busy ? null : () => _run(() => app.answerAsk(widget.message.channelId, id, permOptDeny)),
                  child: Text(t.permDeny),
                ),
              ),
            ] else if (!open) ...[
              if ((s == 'superseded' || ask.isSuperseded) && perm.supersededByMessageId != null)
                TextButton(
                  key: Key('perm-open-new-$id'),
                  style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 44)),
                  onPressed: () => openMessageLink(context, perm.supersededByMessageId!),
                  child: Text('→ ${t.permOpenNewCard}'),
                ),
            ],
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
