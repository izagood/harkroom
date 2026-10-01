import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../mention/mention.dart';
import '../mention/mention_suggest.dart';
import '../state/app_scope.dart';
import '../ui/tokens.dart';

/// 스레드 × 에이전트 모델 지정(서버 079 · jaebin 승인 결정 1~13)의 모바일 화면.
///
/// 데스크톱과 같은 순서를 따른다(designer 목업 v2 6절):
/// 1. `@` 후보 줄에서 에이전트를 고른다 — 지금처럼 부르기만 된다.
/// 2. 고른 **바로 그 자리**가 모델 빠른 줄(기본 / 목록 앞 셋 / 더보기)로 바뀐다. 그냥 계속 쓰면
///    기본값으로 부른다 — 대부분의 호출에서 손이 멈추지 않는다.
/// 3. 더보기나 "부를 상대" 칩을 누르면 바텀시트(모델·effort·기본값·비용)가 열린다.
///
/// 작성칸에서 고른 값은 그 글과 함께 간다(`agentModels[]`). 채널 작성칸은 보낸 뒤 기본으로
/// 돌아간다(결정 12) — 화면이 그 값을 들고 있지 않고 보내는 순간 비운다.

typedef ModelPick = ({String? model, String? effort});

String? formatModelPick(String? model, String? effort) {
  final parts = [
    model,
    effort,
  ].whereType<String>().where((s) => s.isNotEmpty).toList();
  return parts.isEmpty ? null : parts.join(' · ');
}

/// 본문이 부르는 **에이전트** id(순서 유지). 사람은 모델 칩이 없다.
List<String> calledAgentIds(String body, Iterable<AccountView> accounts) {
  final byHandle = {for (final a in accounts) a.handle.toLowerCase(): a};
  final out = <String>[];
  for (final h in mentionedHandles(body)) {
    final a = byHandle[h.toLowerCase()];
    if (a != null && a.isAgent && !out.contains(a.id)) out.add(a.id);
  }
  return out;
}

/// 고른 모델 중 **지금 본문이 부르는 에이전트** 것만 보낸다 — 고른 뒤 본문에서 지운 상대의
/// 스레드 지정까지 바뀌면 안 된다. 두 축이 다 빈 것(`기본`)도 뺀다: 보내면 지정을 **푼다**.
///
/// 예외 하나: 스레드에서 이어받은 지정을 [스레드 지정 풀기]로 비운 값(두 축 null)은 **싣는다** —
/// 그래야 실제로 풀린다(designer 검토 2). [threadRows] 에 그 에이전트의 지정이 있을 때만이다.
Map<String, ModelPick> picksForBody(
  Map<String, ModelPick> picks,
  String body,
  Iterable<AccountView> accounts, {
  List<ThreadAgentModel> threadRows = const [],
}) {
  if (picks.isEmpty) return const {};
  final called = calledAgentIds(body, accounts).toSet();
  final hasRow = {for (final r in threadRows) r.agentId};
  return {
    for (final e in picks.entries)
      if (called.contains(e.key) &&
          (e.value.model != null ||
              e.value.effort != null ||
              hasRow.contains(e.key)))
        e.key: e.value,
  };
}

/// 경고 색 — 무효 지정은 실패가 아니다(designer 검토 3). 앱 토큰의 `warn` 을 쓴다(모바일 S1 이
/// 들인 [HarkroomTokens]). 토큰이 없는 테마(시험의 맨 MaterialApp)에서는 amber 로 물러난다.
Color warningColor(BuildContext context) =>
    Theme.of(context).extension<HarkroomTokens>()?.warn ??
    (Theme.of(context).brightness == Brightness.dark ? Colors.amber.shade300 : Colors.amber.shade900);

/// 작성칸 위의 줄 — `@` 후보 줄, 고른 직후의 모델 빠른 줄, "부를 상대" 모델 칩 줄을 한 자리에서.
///
/// **채널 화면과 스레드 화면이 이 하나를 쓴다**(모바일 스레드 화면에는 `@` 후보 줄이 없었다 —
/// 그래서 스레드 안에서는 모델을 고를 길이 없었다).
class MentionModelBar extends StatefulWidget {
  const MentionModelBar({
    super.key,
    required this.controller,
    required this.picks,
    required this.onPicksChanged,
    this.threadRootId,
  });

  final TextEditingController controller;
  final Map<String, ModelPick> picks;
  final ValueChanged<Map<String, ModelPick>> onPicksChanged;

  /// 스레드 작성칸이면 그 루트 — 스레드 지정값을 칩에 이어받아 보인다.
  final String? threadRootId;

  @override
  State<MentionModelBar> createState() => _MentionModelBarState();
}

class _MentionModelBarState extends State<MentionModelBar> {
  /// 방금 후보에서 고른 에이전트 — 그 자리가 모델 빠른 줄로 바뀐다. 글을 더 치면 접힌다.
  String? _quickFor;
  String _quickAt = '';

  void _setPick(String agentId, ModelPick? v) {
    final next = Map<String, ModelPick>.from(widget.picks);
    // null 은 "이 글에서 고른 것 없음"(이어받거나 기본), 두 축 null 은 "스레드 지정 풀기" 다.
    if (v == null) {
      next.remove(agentId);
    } else {
      next[agentId] = v;
    }
    widget.onPicksChanged(next);
  }

  void _pickHandle(AccountView a) {
    final c = widget.controller;
    final sel = c.selection;
    final cursor = sel.isValid ? sel.baseOffset : c.text.length;
    final query = mentionQueryAt(c.text, cursor);
    if (query == null) return;
    final next = applyMention(c.text, query, a.handle);
    c.value = TextEditingValue(
      text: next.text,
      selection: TextSelection.collapsed(offset: next.cursor),
    );
    setState(() {
      _quickFor = a.isAgent ? a.id : null;
      _quickAt = next.text;
    });
  }

  /// 스레드에서 **이어받은** 값(이 글에서 고른 것이 없을 때만). 새로 고른 값과 다른 모양으로 그린다.
  ModelPick? _inherited(String agentId) {
    if (widget.picks.containsKey(agentId)) return null;
    final root = widget.threadRootId;
    if (root == null) return null;
    for (final r
        in context.app.threadAgentModels[root] ?? const <ThreadAgentModel>[]) {
      if (r.agentId == agentId && !r.stale) {
        return (model: r.model, effort: r.effort);
      }
    }
    return null;
  }

  ModelPick? _effective(String agentId) {
    final own = widget.picks[agentId];
    if (own != null) return own;
    final root = widget.threadRootId;
    if (root == null) return null;
    for (final r
        in context.app.threadAgentModels[root] ?? const <ThreadAgentModel>[]) {
      if (r.agentId == agentId && !r.stale) {
        return (model: r.model, effort: r.effort);
      }
    }
    return null;
  }

  Future<void> _openSheet(String agentId) async {
    final app = context.app;
    final handle = app.accounts[agentId]?.handle ?? '';
    final cur = _effective(agentId);
    final inherited = _inherited(agentId) != null;
    final result = await showAgentModelSheet(
      context,
      agentId: agentId,
      handle: handle,
      current: cur,
      clearsThread: inherited,
    );
    if (result == null || !mounted) return;
    // 이어받은 값을 되돌리면 "스레드 지정 풀기" — 빈 값을 남겨 보낼 때 실제로 푼다.
    _setPick(
      agentId,
      result.reset
          ? (inherited ? (model: null, effort: null) : null)
          : result.value,
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final c = widget.controller;
    // 글을 더 쳤으면 빠른 줄은 끝났다 — 기본값으로 부른다.
    if (_quickFor != null && c.text != _quickAt) _quickFor = null;

    final rows = <Widget>[];
    if (_quickFor != null) {
      rows.add(
        _QuickRow(
          key: const Key('model-quick-row'),
          agentId: _quickFor!,
          handle: app.accounts[_quickFor!]?.handle ?? '',
          current: formatModelPick(
            _effective(_quickFor!)?.model,
            _effective(_quickFor!)?.effort,
          ),
          onPick: (v) {
            _setPick(_quickFor!, v);
            setState(() => _quickFor = null);
          },
          onMore: () {
            final id = _quickFor!;
            setState(() => _quickFor = null);
            _openSheet(id);
          },
        ),
      );
    } else {
      final sel = c.selection;
      final query = mentionQueryAt(
        c.text,
        sel.isValid ? sel.baseOffset : c.text.length,
      );
      if (query != null) {
        final candidates = rankMentionCandidates(
          app.accounts.values.where((a) => !a.isDisabled),
          query.prefix,
          handleOf: (a) => a.handle,
          displayNameOf: (a) => a.displayName,
        );
        if (candidates.isNotEmpty) {
          rows.add(
            SizedBox(
              key: const Key('mention-picker'),
              height: 52,
              child: ListView.builder(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                itemCount: candidates.length,
                itemBuilder: (context, i) {
                  final a = candidates[i];
                  final v = a.isAgent ? _effective(a.id) : null;
                  final hint = v == null
                      ? null
                      : formatModelPick(v.model, v.effort);
                  return Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 4,
                      vertical: 8,
                    ),
                    child: ActionChip(
                      key: Key('mention-candidate-${a.handle}'),
                      avatar: a.isAgent
                          ? const Icon(Icons.smart_toy_outlined, size: 16)
                          : null,
                      // 스레드에 지정이 있는 에이전트만 옅게 적는다(결정 13).
                      label: Text(
                        hint == null ? '@${a.handle}' : '@${a.handle} · $hint',
                      ),
                      onPressed: () => _pickHandle(a),
                    ),
                  );
                },
              ),
            ),
          );
        }
      }
    }

    final called = calledAgentIds(c.text, app.accounts.values);
    if (called.isNotEmpty) {
      rows.add(
        SizedBox(
          key: const Key('called-model-chips'),
          height: 44,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            children: [
              for (final id in called)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 4,
                    vertical: 6,
                  ),
                  child: _ModelChip(
                    key: Key('model-chip-${app.accounts[id]?.handle ?? id}'),
                    handle: app.accounts[id]?.handle ?? '',
                    value: formatModelPick(
                      _effective(id)?.model,
                      _effective(id)?.effort,
                    ),
                    inherited: _inherited(id) != null,
                    onPressed: () => _openSheet(id),
                  ),
                ),
            ],
          ),
        ),
      );
    }
    if (rows.isEmpty) return const SizedBox.shrink();
    return Column(mainAxisSize: MainAxisSize.min, children: rows);
  }
}

/// 고른 직후의 빠른 줄: 기본 / 하네스가 밝힌 목록의 앞 셋 / 더보기.
class _QuickRow extends StatefulWidget {
  const _QuickRow({
    super.key,
    required this.agentId,
    required this.handle,
    required this.current,
    required this.onPick,
    required this.onMore,
  });
  final String agentId;
  final String handle;

  /// 지금 값(null = 기본). ✓ 로 표시한다.
  final String? current;
  final ValueChanged<ModelPick?> onPick;
  final VoidCallback onMore;
  @override
  State<_QuickRow> createState() => _QuickRowState();
}

class _QuickRowState extends State<_QuickRow> {
  AgentModelOptions? _options;
  bool _asked = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_asked) return;
    _asked = true;
    context.app.agentModelOptions(widget.agentId).then((o) {
      if (mounted) setState(() => _options = o);
    }, onError: (Object _) {});
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final top = (_options?.models ?? const <HarnessModelOption>[])
        .take(3)
        .toList();
    return SizedBox(
      height: 52,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        children: [
          // 무엇을 고르는 줄인지 맨 앞에 적는다(designer 검토 5) — 없으면 후보 줄과 구별되지 않는다.
          Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                t.modelQuickLabel.replaceAll('{handle}', '@${widget.handle}'),
                key: const Key('model-quick-label'),
                style: Theme.of(context).textTheme.labelMedium,
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
            child: ActionChip(
              key: const Key('model-quick-default'),
              label: Text(
                widget.current == null ? '✓ ${t.modelDefault}' : t.modelDefault,
              ),
              onPressed: () => widget.onPick(null),
            ),
          ),
          for (final m in top)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
              child: ActionChip(
                key: Key('model-quick-${m.id}'),
                label: Text(
                  widget.current == m.id
                      ? '✓ ${m.label ?? m.id}'
                      : (m.label ?? m.id),
                ),
                onPressed: () => widget.onPick((model: m.id, effort: null)),
              ),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
            child: ActionChip(
              key: const Key('model-quick-more'),
              label: Text(t.modelMore),
              onPressed: widget.onMore,
            ),
          ),
        ],
      ),
    );
  }
}

/// 바텀시트의 결과. [reset] 이면 기본으로 되돌린다.
typedef ModelSheetResult = ({ModelPick value, bool reset});

Future<ModelSheetResult?> showAgentModelSheet(
  BuildContext context, {
  required String agentId,
  required String handle,
  ModelPick? current,
  bool forThread = false,
  bool clearsThread = false,
}) => showModalBottomSheet<ModelSheetResult>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (_) => _ModelSheet(
    agentId: agentId,
    handle: handle,
    current: current,
    forThread: forThread,
    clearsThread: clearsThread,
  ),
);

class _ModelSheet extends StatefulWidget {
  const _ModelSheet({
    required this.agentId,
    required this.handle,
    this.current,
    required this.forThread,
    required this.clearsThread,
  });
  final String agentId;
  final String handle;
  final ModelPick? current;
  final bool forThread;
  final bool clearsThread;
  @override
  State<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<_ModelSheet> {
  AgentModelOptions? _options;
  bool _asked = false;
  late final TextEditingController _model = TextEditingController(
    text: widget.current?.model ?? '',
  );
  late String _effort = widget.current?.effort ?? '';

  /// 직접 입력칸은 [직접 입력] 칩을 눌러야 펼친다 — 목록이 있을 때 늘 서 있으면 시트가 길어진다.
  late bool _custom = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_asked) return;
    _asked = true;
    context.app
        .agentModelOptions(widget.agentId)
        .then(
          (o) {
            if (mounted) setState(() => _options = o);
          },
          onError: (Object _) {
            if (mounted) setState(() => _options = const AgentModelOptions());
          },
        );
  }

  @override
  void dispose() {
    _model.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final models = _options?.models;
    final target = _model.text.isNotEmpty ? _model.text : _options?.model;
    List<String>? efforts;
    for (final m in models ?? const <HarnessModelOption>[]) {
      if (m.id == target) efforts = m.efforts;
    }
    final agentDefault =
        formatModelPick(_options?.model, _options?.effort) ??
        t.modelHarnessDefault;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        16,
        0,
        16,
        16 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        key: const Key('model-sheet'),
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            widget.forThread
                ? t.modelSheetTitleThread.replaceAll(
                    '{handle}',
                    '@${widget.handle}',
                  )
                : t.modelSheetTitleComposer.replaceAll(
                    '{handle}',
                    '@${widget.handle}',
                  ),
            key: const Key('model-sheet-title'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          if (models != null)
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                // 맨 앞은 기본(설정 모델) — 없으면 지정이 없을 때 아무것도 선택되지 않은 채로 열린다.
                ChoiceChip(
                  key: const Key('model-option-default'),
                  label: Text(
                    '${t.modelDefault}${_options?.model != null ? ' (${_options!.model})' : ''}',
                  ),
                  selected: _model.text.isEmpty,
                  onSelected: (_) => setState(() => _model.text = ''),
                ),
                for (final m in models)
                  ChoiceChip(
                    key: Key('model-option-${m.id}'),
                    label: Text(m.label ?? m.id),
                    selected: _model.text == m.id,
                    onSelected: (_) => setState(() => _model.text = m.id),
                  ),
                ActionChip(
                  key: const Key('model-option-custom'),
                  label: Text(t.modelCustom),
                  onPressed: () => setState(() => _custom = true),
                ),
              ],
            ),
          // 목록 밖 이름(또는 목록을 모를 때)을 위한 직접 입력.
          if (models == null ||
              _custom ||
              (_model.text.isNotEmpty &&
                  !models.any((m) => m.id == _model.text)))
            TextField(
              key: const Key('model-custom'),
              controller: _model,
              decoration: InputDecoration(
                labelText: t.modelCustom,
                isDense: true,
              ),
              onChanged: (_) => setState(() {}),
            ),
          const SizedBox(height: 8),
          Text(t.modelEffort, style: Theme.of(context).textTheme.labelMedium),
          Wrap(
            spacing: 6,
            children: [
              ChoiceChip(
                label: Text(t.modelEffortDefault),
                selected: _effort.isEmpty,
                onSelected: (_) => setState(() => _effort = ''),
              ),
              for (final e in efforts ?? const <String>[])
                ChoiceChip(
                  key: Key('effort-option-$e'),
                  label: Text(e),
                  selected: _effort == e,
                  onSelected: (_) => setState(() => _effort = e),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '${t.modelAgentDefault} $agentDefault',
            key: const Key('model-agent-default'),
          ),
          const SizedBox(height: 4),
          Text(t.modelCostNote, style: Theme.of(context).textTheme.bodySmall),
          if (widget.forThread)
            Text(t.modelNextTurn, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                key: const Key('model-reset'),
                onPressed: () =>
                    Navigator.of(context)
                        .pop((value: (model: null, effort: null), reset: true)),
                child: Text(
                  widget.clearsThread ? t.modelClearThread : t.modelReset,
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                key: const Key('model-apply'),
                onPressed: () => Navigator.of(context).pop((
                  value: (
                    model: _model.text.trim().isEmpty
                        ? null
                        : _model.text.trim(),
                    effort: _effort.isEmpty ? null : _effort,
                  ),
                  reset: false,
                )),
                child: Text(t.modelApply),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 스레드 머리의 모델 줄(결정 1·A·9·10). 지정이 없으면 `모델 · 모두 기본` 칩 하나로 접힌다.
class ThreadModelBar extends StatefulWidget {
  const ThreadModelBar({
    super.key,
    required this.channelId,
    required this.rootId,
    required this.agentIds,
  });
  final String channelId;
  final String rootId;
  final List<String> agentIds;
  @override
  State<ThreadModelBar> createState() => _ThreadModelBarState();
}

class _ThreadModelBarState extends State<ThreadModelBar> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final rows = app.threadAgentModels[widget.rootId];
    if (rows == null) return const SizedBox.shrink();
    final ids = {...widget.agentIds, ...rows.map((r) => r.agentId)}.toList();
    if (ids.isEmpty) return const SizedBox.shrink();
    if (rows.isEmpty && !_open) {
      return Align(
        alignment: Alignment.centerLeft,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
          child: ActionChip(
            key: const Key('thread-models-collapsed'),
            label: Text(t.modelAllDefault),
            onPressed: () => setState(() => _open = true),
          ),
        ),
      );
    }
    final anyStale = rows.any((r) => r.stale);
    return Column(
      key: const Key('thread-models'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: 48,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            children: [
              for (final id in ids)
                Builder(
                  builder: (context) {
                    ThreadAgentModel? row;
                    for (final r in rows) {
                      if (r.agentId == id) row = r;
                    }
                    final handle = app.accounts[id]?.handle ?? '';
                    final value = formatModelPick(row?.model, row?.effort);
                    return Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 4,
                        vertical: 6,
                      ),
                      child: _ModelChip(
                        key: Key('thread-model-chip-$handle'),
                        handle: handle,
                        value: value,
                        stale: row?.stale ?? false,
                        threadTail: true,
                        onPressed: () async {
                          final result = await showAgentModelSheet(
                            context,
                            agentId: id,
                            handle: handle,
                            current: row == null
                                ? null
                                : (model: row.model, effort: row.effort),
                            forThread: true,
                          );
                          if (result == null || !context.mounted) return;
                          await context.app.setThreadAgentModel(
                            widget.channelId,
                            widget.rootId,
                            id,
                            result.reset ? null : result.value.model,
                            result.reset ? null : result.value.effort,
                          );
                        },
                      ),
                    );
                  },
                ),
            ],
          ),
        ),
        if (anyStale)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Wrap(
              key: const Key('thread-models-stale'),
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              children: [
                for (final r in rows.where((r) => r.stale)) ...[
                  Text(
                    '@${app.accounts[r.agentId]?.handle ?? ''} — ${t.modelStaleDetail.replaceAll('{harness}', r.currentHarness)}',
                    style: TextStyle(color: warningColor(context)),
                  ),
                  TextButton(
                    key: Key(
                      'thread-model-repick-${app.accounts[r.agentId]?.handle ?? ''}',
                    ),
                    onPressed: () async {
                      final result = await showAgentModelSheet(
                        context,
                        agentId: r.agentId,
                        handle: app.accounts[r.agentId]?.handle ?? '',
                        forThread: true,
                      );
                      if (result == null || !context.mounted) return;
                      await context.app.setThreadAgentModel(
                        widget.channelId,
                        widget.rootId,
                        r.agentId,
                        result.reset ? null : result.value.model,
                        result.reset ? null : result.value.effort,
                      );
                    },
                    child: Text(t.modelRepick),
                  ),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

/// 모델 칩 하나 — **세 모양**(designer 검토 6): 지정(강조 면) / 기본(테두리만) / 이어받음(옅은 강조 +
/// `스레드` 꼬리). 무효(stale)는 경고 색 취소선이다. 같은 모양이면 사람은 "이 글이 바꾼다" 와
/// "스레드가 이미 그렇다" 를 구별하지 못한다.
class _ModelChip extends StatelessWidget {
  const _ModelChip({
    super.key,
    required this.handle,
    required this.value,
    required this.onPressed,
    this.inherited = false,
    this.stale = false,
    this.threadTail = false,
  });

  final String handle;
  final String? value;
  final VoidCallback onPressed;
  final bool inherited;
  final bool stale;
  final bool threadTail;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final scheme = Theme.of(context).colorScheme;
    final set = value != null;
    final tail = set && !stale && (inherited || threadTail)
        ? ' · ${t.modelThreadSet}'
        : '';
    final Color? bg = stale
        ? null
        : !set
        ? Colors.transparent
        : inherited
        ? scheme.primaryContainer.withValues(alpha: 0.45)
        : scheme.primaryContainer;
    return InputChip(
      backgroundColor: bg,
      side: BorderSide(
        color: stale
            ? warningColor(context)
            : (set ? Colors.transparent : scheme.outline),
      ),
      label: Text(
        '@$handle · ${value ?? t.modelDefault}$tail',
        style: TextStyle(
          decoration: stale ? TextDecoration.lineThrough : null,
          color: stale
              ? warningColor(context)
              : (inherited ? scheme.onSurfaceVariant : null),
          fontWeight: set && !inherited && !stale ? FontWeight.w600 : null,
        ),
      ),
      onPressed: onPressed,
    );
  }
}
