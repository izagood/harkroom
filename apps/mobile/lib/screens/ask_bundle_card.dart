import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_error.dart';
import '../api/ask.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'message_link.dart';

/// **묶음 카드**(선택 카드 P1, 스레드 596146cc) — 관리 에이전트가 여러 에이전트의 사람 앞 카드를 한 장에 줄로
/// 모은 것. 데스크톱 `AskBundleCard` 와 같은 판정이다.
///
/// ## 줄의 상태는 원본에서 읽는다
///
/// 묶음 meta 는 원본을 가리킬 뿐 상태를 싣지 않는다(정본은 하나). 줄마다 `GET /messages/:id` 로 원본을 읽고,
/// **묶음 행이 바뀔 때마다** 다시 읽는다 — 원본이 바뀌면 서버가 묶음에 `message.updated` 를 보낸다. 원본을 못
/// 보면(403) 그 줄은 「원본 카드를 볼 수 없다」로 선다.
///
/// ## 「추천대로」는 서버가 다시 거른다
///
/// 되돌릴 수 없는 줄·추천 없는 줄·링크 줄은 빠지고, 빠진 까닭을 줄마다 남긴다(security 3b ②).
/// 「추천대로」를 누른 뒤 실제로 보내기까지 기다리는 초(시안 9절).
const bundleAcceptDelaySeconds = 5;

class AskBundleCard extends StatefulWidget {
  const AskBundleCard({super.key, required this.message, required this.bundle});

  final MessageRow message;
  final AskBundleMeta bundle;

  @override
  State<AskBundleCard> createState() => _AskBundleCardState();
}

class _AskBundleCardState extends State<AskBundleCard> {
  /// 원본 `meta`. 못 본 줄은 [_unavailable] 에.
  final Map<String, Map<String, Object?>> _roots = {};
  final Set<String> _unavailable = {};
  List<BundleAcceptResult>? _results;
  bool _busy = false;

  /// 「추천대로」를 누른 뒤 보내기까지 남은 초. null 이면 기다리지 않는다(#1288 designer s2) — 답은 되돌릴 수 없어서
  /// 한 박자 둔다. 취소하면 아무것도 보내지 않는다(서버에는 답을 지우는 길이 없다).
  int? _countdown;
  Timer? _tick;
  int _loadGen = 0;
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started) {
      _started = true;
      _load();
    }
  }

  @override
  void didUpdateWidget(AskBundleCard old) {
    super.didUpdateWidget(old);
    // 묶음 행이 새로 왔다 = 원본 어딘가가 바뀌었다는 알림. 다시 읽는다.
    if (!identical(old.message, widget.message)) _load();
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  /// 5초를 세고 0 이 되면 그때 보낸다.
  void _startAccept(AppState app) {
    _tick?.cancel();
    setState(() => _countdown = bundleAcceptDelaySeconds);
    _tick = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return timer.cancel();
      final next = (_countdown ?? 0) - 1;
      if (next > 0) {
        setState(() => _countdown = next);
        return;
      }
      timer.cancel();
      setState(() => _countdown = null);
      _run(() async {
        final results = await app.acceptRecommendedBundle(widget.message.channelId, widget.message.id);
        if (mounted) setState(() => _results = results);
      });
    });
  }

  void _cancelAccept() {
    _tick?.cancel();
    setState(() => _countdown = null);
  }

  Future<void> _load() async {
    final gen = ++_loadGen;
    final app = AppScope.read(context);
    final pairs = await Future.wait(widget.bundle.items.map((item) async {
      try {
        return (item.rootId, (await app.fetchMessage(item.rootId)).meta);
      } on Object {
        return (item.rootId, null);
      }
    }));
    if (!mounted || gen != _loadGen) return;
    setState(() {
      _roots.clear();
      _unavailable.clear();
      for (final (id, meta) in pairs) {
        if (meta == null) {
          _unavailable.add(id);
        } else {
          _roots[id] = meta;
        }
      }
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } on Object catch (e) {
      if (mounted) {
        showFailureToast(context, e is ApiError && e.status == 403 ? context.t.bundleUnavailable : context.t.askFailed,
            retry: () => _run(action));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final theme = Theme.of(context);
    final items = widget.bundle.items;
    final rows = [
      for (final item in items)
        (item, bundleRowState(item, _roots[item.rootId], unavailable: _unavailable.contains(item.rootId))),
    ];
    final open = rows.where((r) => r.$2 is BundleRowOpen || r.$2 is BundleRowLink).length;
    // 서버가 언제나 빼는 줄(되돌릴 수 없음·링크)은 n 에서 뺀다 — 다시 눌러도 같다(#1288 designer s1).
    final skipped = {
      for (final r in _results ?? const <BundleAcceptResult>[])
        if (r.outcome == 'skipped_irreversible' || r.outcome == 'skipped_link') r.rootId,
    };
    final recommendable = rows
        .where((r) =>
            r.$2 is BundleRowOpen &&
            !skipped.contains(r.$1.rootId) &&
            bundleRecommended((r.$2 as BundleRowOpen).ask.options) != null)
        .length;

    return Card(
      key: Key('ask-bundle-${widget.message.id}'),
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              open > 0 ? t.bundleRemaining(open, rows.length) : t.bundleAllDone(rows.length),
              key: Key('ask-bundle-head-${widget.message.id}'),
              style: theme.textTheme.labelMedium?.copyWith(
                fontWeight: FontWeight.w600,
                color: open > 0 ? theme.colorScheme.primary : null,
              ),
            ),
            for (final (i, (item, state)) in rows.indexed) ...[
              if (i > 0) Divider(height: 12, color: context.tokens.border),
              _BundleRow(
                item: item,
                state: state,
                app: app,
                t: t,
                busy: _busy || _countdown != null,
                result: _results?.where((r) => r.rootId == item.rootId).firstOrNull,
                onPick: (optionId) => _run(() => app.answerBundleItem(
                    widget.message.channelId, widget.message.id, item.rootId, optionId)),
              ),
            ],
            if (_countdown != null) ...[
              const SizedBox(height: 8),
              Row(
                key: Key('ask-bundle-pending-${widget.message.id}'),
                children: [
                  Expanded(child: Text(t.bundleAcceptPending(recommendable, _countdown!), style: theme.textTheme.bodyMedium)),
                  TextButton(
                    key: Key('ask-bundle-cancel-${widget.message.id}'),
                    onPressed: _cancelAccept,
                    child: Text(t.bundleAcceptCancel),
                  ),
                ],
              ),
            ] else if (recommendable > 0) ...[
              const SizedBox(height: 8),
              OutlinedButton(
                key: Key('ask-bundle-accept-${widget.message.id}'),
                onPressed: _busy ? null : () => _startAccept(app),
                child: Text(t.bundleAcceptRecommended(recommendable)),
              ),
              Text(t.bundleAcceptNote, style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }
}

String _nameOf(AppState app, String? id, Strings t) {
  final a = id == null ? null : app.accounts[id];
  if (a == null) return t.bundleSomeone;
  return a.displayName.isNotEmpty ? a.displayName : a.handle;
}

String? _skipText(Strings t, String outcome) => switch (outcome) {
      'skipped_irreversible' => t.bundleSkipIrreversible,
      'skipped_no_recommendation' => t.bundleSkipNoRecommendation,
      'skipped_link' => t.bundleSkipLink,
      'failed' => t.bundleSkipFailed,
      _ => null,
    };

class _BundleRow extends StatelessWidget {
  const _BundleRow({
    required this.item,
    required this.state,
    required this.app,
    required this.t,
    required this.busy,
    required this.onPick,
    this.result,
  });

  final AskBundleItem item;
  final BundleRowState state;
  final AppState app;
  final Strings t;
  final bool busy;
  final void Function(String optionId) onPick;
  final BundleAcceptResult? result;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: context.tokens.fgSubtle);
    final settled = state is! BundleRowOpen && state is! BundleRowLink && state is! BundleRowLoading;
    final skip = result != null && result!.skipped ? _skipText(t, result!.outcome) : null;
    void goOriginal() => openMessageLink(context, item.rootId);

    return Column(
      key: Key('ask-bundle-row-${item.rootId}'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(_nameOf(app, item.askerId, t), style: muted),
        Text(
          item.prompt,
          maxLines: settled ? 1 : 3,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodyMedium?.copyWith(color: settled ? context.tokens.fgMuted : null),
        ),
        const SizedBox(height: 4),
        switch (state) {
          BundleRowOpen(:final ask) => Wrap(
              spacing: 6,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                for (final o in ask.options)
                  ActionChip(
                    key: Key('ask-bundle-option-${item.rootId}-${o.id}'),
                    tooltip: o.hint,
                    onPressed: busy ? null : () => onPick(o.id),
                    label: Text(o.recommended ? '${o.label} · ${t.bundleRecommended}' : o.label),
                  ),
                TextButton(
                  key: Key('ask-bundle-reply-${item.rootId}'),
                  style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 4), minimumSize: const Size(0, 32)),
                  onPressed: goOriginal,
                  child: Text(t.bundleReplyInThread),
                ),
              ],
            ),
          BundleRowLink() => TextButton(
              key: Key('ask-bundle-link-${item.rootId}'),
              style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 32)),
              onPressed: goOriginal,
              child: Text(t.bundleDecideInThread),
            ),
          BundleRowLoading() => Text(t.bundleLoading, style: muted),
          BundleRowUnavailable() => Text(t.bundleUnavailable, style: muted),
          BundleRowAnswered(:final label, :final by) =>
            Text(t.bundleAnswered(label ?? '—', _nameOf(app, by, t)), style: muted),
          BundleRowReplied(:final by, :final note, :final noteBy) => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(t.bundleReplied(_nameOf(app, by, t)), style: muted),
                if (note != null && note.isNotEmpty)
                  Container(
                    key: Key('ask-bundle-note-${item.rootId}'),
                    margin: const EdgeInsets.only(top: 2),
                    padding: const EdgeInsets.only(left: 8),
                    decoration: BoxDecoration(border: Border(left: BorderSide(color: theme.dividerColor, width: 2))),
                    // 요지는 관리 에이전트가 옮긴 말이다 — 사람의 말로 읽히지 않게 누가 요약했는지 밝힌다(security n1).
                    child: Text('${t.bundleNoteBy(_nameOf(app, noteBy, t))} $note',
                        maxLines: 2, overflow: TextOverflow.ellipsis, style: theme.textTheme.bodySmall),
                  ),
              ],
            ),
          BundleRowSuperseded() => Text(t.askSuperseded, style: muted),
          BundleRowDeclined() => Text(t.askClosed, style: muted),
        },
        if (skip != null)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(skip,
                key: Key('ask-bundle-skip-${item.rootId}'),
                style: theme.textTheme.bodySmall?.copyWith(color: context.tokens.fgMuted)),
          ),
      ],
    );
  }
}
