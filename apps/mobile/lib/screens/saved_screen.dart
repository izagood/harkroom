import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../api/api_error.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../mention/render.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../time.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'message_link.dart';
import 'message_tile.dart';

/// 저장된 메시지(#219) — 데스크톱 「Saved」 겹창의 모바일 판(designer 시안 ③).
///
/// 칸이 둘(할 것·완료)인 것은 서버 모델이 그렇기 때문이다 — 폰에서 완료한 것이 데스크톱 할 것에
/// 남으면 둘이 어긋난다. 상태는 셋(읽는 중·비었음·못 읽음)을 갈라 그린다. 못 읽은 것을 빈 목록으로
/// 보이면 사람은 담은 것이 사라진 줄 안다.
class SavedScreen extends StatefulWidget {
  const SavedScreen({super.key});

  @override
  State<SavedScreen> createState() => _SavedScreenState();
}

class _SavedScreenState extends State<SavedScreen> {
  SavedState _tab = SavedState.open;

  @override
  void initState() {
    super.initState();
    // 열 때마다 새로 읽는다 — 소켓 동기화(다음 단계)가 없는 동안 다른 기기에서 바꾼 것이 여기서 맞춰진다.
    final app = AppScope.read(context);
    app.loadSaved(SavedState.open).ignore();
    app.loadSaved(SavedState.done).ignore();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final rows = app.saved[_tab]!;
    return Scaffold(
      appBar: AppBar(title: Text(t.savedTitle)),
      body: SafeArea(
        child: Column(
          children: [
            const ConnectionBand(),
            Padding(
              padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 8, HarkroomSize.gutter, 4),
              child: SizedBox(
                width: double.infinity,
                child: SegmentedButton<SavedState>(
                  key: const Key('saved-tabs'),
                  showSelectedIcon: false,
                  segments: [
                    ButtonSegment(
                      value: SavedState.open,
                      label: Text(
                        app.savedOpenCount > 0 ? '${t.savedTabOpen} ${app.savedOpenCount}' : t.savedTabOpen,
                        key: const Key('saved-tab-open'),
                      ),
                    ),
                    ButtonSegment(
                      value: SavedState.done,
                      label: Text(t.savedTabDone, key: const Key('saved-tab-done')),
                    ),
                  ],
                  selected: {_tab},
                  onSelectionChanged: (s) => setState(() => _tab = s.first),
                ),
              ),
            ),
            Expanded(
              // 이미 읽은 줄이 있으면 상태와 관계없이 보인다(인박스와 같은 판단).
              child: rows.isNotEmpty
                  ? RefreshIndicator(
                      onRefresh: () => app.loadSaved(_tab),
                      child: ListView.builder(
                        key: Key('saved-list-${_tab.name}'),
                        itemCount: rows.length,
                        itemBuilder: (context, i) => SavedRow(entry: rows[i]),
                      ),
                    )
                  : switch (app.savedLoad[_tab]!) {
                      LoadState.loading => const LoadingSkeleton(rows: 3),
                      LoadState.failed => FailedState(
                          title: t.savedLoadFailed,
                          cause: app.failures['saved-${_tab.name}'] ?? LoadFailure.network,
                          onRetry: () => app.loadSaved(_tab),
                        ),
                      // 완료 칸에서는 담는 법을 말하지 않는다 — 거기서 할 일이 아니다.
                      LoadState.loaded => _tab == SavedState.open
                          ? EmptyState(title: t.savedEmptyOpen, hint: t.savedEmptyOpenHint)
                          : EmptyState(title: t.savedEmptyDone),
                    },
            ),
          ],
        ),
      ),
    );
  }
}

/// 저장 목록 한 줄: 채널 칩 · @작성자 · 시각 / 본문 두 줄 / ✓(또는 ↺).
///
/// 지운 글·볼 수 없는 채널의 글은 흐린 줄로 남고 누를 수 없다. **그래도 ✓·빼기는 된다** — 안 그러면
/// 그 줄을 지울 길이 없다.
class SavedRow extends StatelessWidget {
  const SavedRow({super.key, required this.entry});

  final SavedEntry entry;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final m = entry.message;
    final done = entry.state == SavedState.done;
    final next = done ? SavedState.open : SavedState.done;
    final toggleLabel = done ? t.savedMarkOpen : t.savedMarkDone;

    final preview = m == null
        ? (entry.deleted ? t.savedDeleted : t.savedUnavailable)
        : displayBody(m, app.accounts, unknownMention: t.mentionUnknown, unknownAccount: t.systemAccountUnknown).trim();
    final when = agoLabel(m?.createdAt ?? entry.createdAt, DateTime.now().toUtc(), t);
    final who = m == null ? null : '@${app.accounts[m.authorId]?.handle ?? app.displayNameOf(m.authorId)}';

    return Semantics(
      customSemanticsActions: {
        CustomSemanticsAction(label: toggleLabel): () => setSavedStateWithToast(context, entry.messageId, next),
        CustomSemanticsAction(label: t.messageUnsave): () => toggleSaved(context, entry.messageId, save: false),
      },
      child: InkWell(
        key: Key('saved-row-${entry.messageId}'),
        onTap: m == null ? null : () => openMessageRow(context, m),
        onLongPress: () => _rowSheet(context, entry),
        child: Container(
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: k.border))),
          padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 10, 8, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (m == null)
                const SizedBox(width: HarkroomSize.avatar, height: HarkroomSize.avatar)
              else
                HarkroomAvatar(id: m.authorId, name: app.accounts[m.authorId]?.handle ?? app.displayNameOf(m.authorId)),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(child: _ChannelChip(channelId: entry.channelId)),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            who == null ? when : '$who · $when',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      preview,
                      key: Key('saved-preview-${entry.messageId}'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: m == null
                          ? TextStyle(fontSize: 14, fontStyle: FontStyle.italic, color: k.fgMuted)
                          : TextStyle(fontSize: 14, color: k.fg),
                    ),
                  ],
                ),
              ),
              // 44pt 를 넘기는 터치 영역(IconButton 기본 48).
              IconButton(
                key: Key('saved-toggle-${entry.messageId}'),
                tooltip: toggleLabel,
                onPressed: () => setSavedStateWithToast(context, entry.messageId, next),
                icon: Icon(done ? Icons.replay : Icons.check_circle_outline, color: k.fgMuted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 채널 이름 칩. DM 은 `#` 없이 상대 이름이다. 목록에 없는 채널(나간 채널)은 칩을 비운다.
class _ChannelChip extends StatelessWidget {
  const _ChannelChip({required this.channelId});

  final String channelId;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    ChannelRow? channel;
    for (final c in context.app.channels) {
      if (c.id == channelId) channel = c;
    }
    if (channel == null) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(color: k.surfaceHover, borderRadius: BorderRadius.circular(HarkroomRadius.sm)),
      child: Text(
        channel.isDm ? channel.name : '#${channel.name}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 11, color: k.fgMuted),
      ),
    );
  }
}

/// 목록 줄을 길게 누르면: 담은 것 빼기 · 링크 복사(본문이 있을 때만).
Future<void> _rowSheet(BuildContext context, SavedEntry entry) async {
  final t = context.t;
  HapticFeedback.selectionClick().ignore();
  final m = entry.message;
  final pick = await showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (m != null)
            ListTile(
              key: const Key('saved-action-copy-link'),
              leading: const Icon(Icons.link),
              title: Text(t.messageCopyLink),
              onTap: () => Navigator.of(sheet).pop('link'),
            ),
          ListTile(
            key: const Key('saved-action-unsave'),
            leading: const Icon(Icons.bookmark_remove_outlined),
            title: Text(t.messageUnsave),
            onTap: () => Navigator.of(sheet).pop('unsave'),
          ),
        ],
      ),
    ),
  );
  if (!context.mounted) return;
  switch (pick) {
    case 'link':
      await copyMessage(context, m!, MessageCopy.link);
    case 'unsave':
      await toggleSaved(context, entry.messageId, save: false);
  }
}

void _toast(ScaffoldMessengerState messenger, EdgeInsets margin, String text,
    {Key? key, String? actionLabel, VoidCallback? onAction}) {
  messenger
    ..removeCurrentSnackBar()
    ..showSnackBar(SnackBar(
      key: key,
      content: Text(text),
      behavior: SnackBarBehavior.floating,
      margin: margin,
      duration: const Duration(seconds: 4),
      action: actionLabel == null || onAction == null ? null : SnackBarAction(label: actionLabel, onPressed: onAction),
    ));
}

/// 담기·빼기. 메시지 시트·VoiceOver·저장 목록이 이 한 길로 들어온다.
///
/// 토스트는 [ScaffoldMessengerState] 를 **미리 쥐고** 띄운다 — 되돌리기를 누를 때는 시트도, 어쩌면 그
/// 줄도 이미 사라졌다. 담은 뒤에는 「목록 보기」, 뺀 뒤에는 「되돌리기」를 준다(줄·표식이 눈앞에서 사라진다).
///
/// 되돌리기로 다시 담은 것에는 「목록 보기」를 다시 권하지 않고 토스트를 내리기만 한다 — 저장 화면 안에서
/// 누르면 같은 화면이 한 장 더 쌓인다(designer #1231). 토스트가 떠 있는 사이 계정이 바뀌었으면 토스트의
/// 동작은 아무것도 하지 않는다 — 새 계정으로 PUT 이 나가면 안 된다(security #1231 n2).
Future<void> toggleSaved(BuildContext context, String messageId, {required bool save}) async {
  final t = context.t;
  final app = AppScope.read(context);
  final messenger = ScaffoldMessenger.of(context);
  final margin = toastMargin(context);
  final navigator = Navigator.of(context);
  final gen = app.sessionGeneration;
  Future<void> run(bool on, {bool undo = false}) async {
    if (app.sessionGeneration != gen) return;
    try {
      await (on ? app.saveMessage(messageId) : app.unsaveMessage(messageId));
    } on ApiError catch (e) {
      // 담기의 403·404 는 다시 해도 같다(지운 글·볼 수 없는 채널) — 다시 시도를 달지 않는다.
      final permanent = on && (e.status == 403 || e.status == 404);
      _toast(messenger, margin, on ? t.savedSaveFailed : t.savedActionFailed,
          key: const Key('saved-failed'),
          actionLabel: permanent ? null : t.commonRetry,
          onAction: permanent ? null : () => run(on, undo: undo).ignore());
      return;
    } on Object {
      _toast(messenger, margin, on ? t.savedSaveFailed : t.savedActionFailed,
          key: const Key('saved-failed'), actionLabel: t.commonRetry, onAction: () => run(on, undo: undo).ignore());
      return;
    }
    HapticFeedback.selectionClick().ignore();
    if (undo) {
      messenger.removeCurrentSnackBar();
    } else if (on) {
      _toast(messenger, margin, t.savedAdded,
          key: const Key('saved-added'),
          actionLabel: t.savedOpenList,
          onAction: () {
            if (app.sessionGeneration == gen) navigator.push(MaterialPageRoute<void>(builder: (_) => const SavedScreen())).ignore();
          });
    } else {
      _toast(messenger, margin, t.savedRemoved,
          key: const Key('saved-removed'), actionLabel: t.savedUndo, onAction: () => run(true, undo: true).ignore());
    }
  }

  await run(save);
}

/// ✓(완료로) · ↺(할 것으로). 줄이 다른 칸으로 빠지므로 토스트에 되돌리기를 준다.
Future<void> setSavedStateWithToast(BuildContext context, String messageId, SavedState next) async {
  final t = context.t;
  final app = AppScope.read(context);
  final messenger = ScaffoldMessenger.of(context);
  final margin = toastMargin(context);
  final gen = app.sessionGeneration;
  Future<void> run(SavedState to, {bool undoable = true}) async {
    if (app.sessionGeneration != gen) return;
    try {
      await app.setSavedState(messageId, to);
    } on Object {
      _toast(messenger, margin, t.savedActionFailed,
          key: const Key('saved-failed'), actionLabel: t.commonRetry, onAction: () => run(to, undoable: undoable).ignore());
      return;
    }
    HapticFeedback.selectionClick().ignore();
    if (!undoable) {
      messenger.removeCurrentSnackBar();
      return;
    }
    final back = to == SavedState.done ? SavedState.open : SavedState.done;
    _toast(messenger, margin, to == SavedState.done ? t.savedMovedDone : t.savedMovedOpen,
        key: Key('saved-moved-${to.name}'),
        actionLabel: t.savedUndo,
        onAction: () => run(back, undoable: false).ignore());
  }

  await run(next);
}
