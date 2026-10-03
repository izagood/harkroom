import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../time.dart';
import '../ui/parts.dart';
import '../ui/tokens.dart';
import '../ui/states.dart';
import '../mention/render.dart';
import '../markdown/markdown_view.dart';
import 'attachments.dart';
import 'message_link.dart';

/// 말풍선 한 줄. **채널 화면과 스레드 화면이 같은 것을 쓴다.**
///
/// 두 벌로 두면 한쪽에만 리액션이 붙거나 한쪽만 작성자를 다르게 그리게 된다 — 같은
/// 메시지가 화면마다 달라 보이는 것이 사람이 앱을 못 믿게 되는 가장 빠른 길이다.
class MessageTile extends StatelessWidget {
  const MessageTile({
    super.key,
    required this.message,
    this.onOpenThread,
    this.onReplyInThread,
    this.continued = false,
    this.card,
  });

  final MessageRow message;

  /// 스레드로 들어가는 길. **스레드 화면 안에서는 `null`** 이다 — 이미 그 안이라
  /// 들어갈 곳이 없다.
  final void Function()? onOpenThread;

  /// 「스레드에서 답글」 — 스레드를 열면서 작성칸에 키보드까지 올린다. 채널 화면의 **최상위
  /// 글**에만 준다(답글·스레드 화면 안에서는 `null` 이고, 시트에 그 줄이 서지 않는다).
  final void Function()? onReplyInThread;

  /// 같은 사람이 이어 말한 줄이다 — 아바타·이름·시각을 빼고 본문만 아바타 뒤에 붙인다.
  final bool continued;

  /// 본문 **아래에 덧붙는** 카드(ask·보고·실패). 카드는 메시지를 대신하지 않는다 —
  /// 대신하면 무엇을 묻는지(본문)와 누가 물었는지(이름)가 화면에서 사라진다(designer #976).
  final Widget? card;

  /// 메시지 기능 바(designer 설계 2판 1단계). 길게 누르면 시트, 채널에서 탭하면 스레드.
  /// 채널 최상위와 스레드 답글이 이 한 줄을 같이 쓰므로 두 곳 다 된다. 본문 안 링크·칩·첨부·
  /// 코드는 각자의 제스처가 먼저 잡는다(안쪽 인식기가 이긴다).
  @override
  Widget build(BuildContext context) => _Pressable(
        message: message,
        onTap: onOpenThread,
        onReplyInThread: onReplyInThread,
        child: _row(context),
      );

  Widget _row(BuildContext context) {
    final app = context.app;
    final t = context.t;
    final k = context.tokens;
    final author = app.accounts[message.authorId];
    final body = displayBody(message, app.accounts, unknownMention: t.mentionUnknown, unknownAccount: t.systemAccountUnknown).trim();
    final denied = _deniedHandles(message.meta);

    return Padding(
      key: Key('message-${message.id}'),
      padding: EdgeInsets.fromLTRB(
          HarkroomSize.gutter, continued ? 1 : 8, HarkroomSize.gutter, 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 이어 말한 줄도 **같은 폭을 비워 둔다** — 본문이 아바타 뒤로 줄을 맞춰야 한 사람의
          // 말로 읽힌다.
          if (continued)
            const SizedBox(width: HarkroomSize.avatar)
          else
            HarkroomAvatar(id: message.authorId, name: author?.handle ?? app.displayNameOf(message.authorId)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (!continued) _Header(message: message, isAgent: author?.isAgent == true),
                // 작은 마크다운(코드·목록·인용·굵게·링크). 모르는 것은 글자 그대로 둔다.
                if (body.isNotEmpty)
                  MarkdownBody(body, openMessage: (id) => openMessageLink(context, id)),
                if (denied.isNotEmpty) _MentionDenied(handles: denied),
                if (card != null) Padding(padding: const EdgeInsets.only(top: 6), child: card),
                AttachmentStrip(attachments: message.attachments, message: message),
                if (message.reactions.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: _Reactions(message: message),
                  ),
                if (onOpenThread != null && _replyLabel(t, message) != null)
                  // 스레드 요약 줄(개정판 3.3): 참여자 아바타 몇 개 · 「답글 n개」 · 마지막 답글 시각.
                  InkWell(
                    key: Key('thread-open-${message.id}'),
                    onTap: onOpenThread,
                    borderRadius: BorderRadius.circular(HarkroomRadius.row),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minHeight: 32),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (final id in message.participantIds.take(3))
                            Padding(
                              key: Key('thread-participant-${message.id}-$id'),
                              padding: const EdgeInsets.only(right: 3),
                              child: HarkroomAvatar(
                                id: id,
                                name: app.accounts[id]?.handle ?? app.displayNameOf(id),
                                size: 18,
                              ),
                            ),
                          if (message.participantIds.isNotEmpty) const SizedBox(width: 3),
                          Text(
                            _replyLabel(t, message)!,
                            style: TextStyle(color: k.link, fontWeight: FontWeight.w600, fontSize: 13),
                          ),
                          if (message.lastReplyAt != null && (message.replyCount ?? 0) > 0)
                            Text(
                              ' · ${agoLabel(message.lastReplyAt!, DateTime.now().toUtc(), t)}',
                              style: TextStyle(color: k.fgMuted, fontSize: 12),
                            ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 서버가 붙인 "부르지 않은 이름들". 형식이 깨졌으면 없는 것으로 본다.
  static List<String> _deniedHandles(Map<String, Object?> meta) {
    final raw = meta['mentionDenied'];
    if (raw is! List) return const [];
    return raw.whereType<String>().where((h) => h.isNotEmpty).toList(growable: false);
  }

  /// 답글 수 줄의 문구. **`replyCount` 가 `null` 이면 아무것도 그리지 않는다** —
  /// 그건 "답글이 0개"가 아니라 "이 질문의 대상이 아니다"(답글 자신)이다.
  ///
  /// 서버는 답글 없는 최상위 글에도 0 이 아니라 `null` 을 준다 — 그래서 「답글 달기」 줄은
  /// 실제로는 서지 않는다. 답글 없는 글의 스레드는 **줄을 탭하거나** 시트의 「스레드에서 답글」로
  /// 연다(designer 기능 바 설계 2판). 모든 글 밑에 「답글 달기」를 세우면 피드가 시끄러워진다.
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
            onPressed: () async {
              Future<void> go() => app.toggleReaction(message.channelId, message.id, r.emoji);
              try {
                await go();
              } on Object {
                // 조용히 지나가면 사람은 눌렀는데 안 바뀐 이유를 모른다.
                if (context.mounted) {
                  showFailureToast(context, context.t.reactionFailed, retry: () => go().ignore());
                }
              }
            },
          ),
        // 이모지 더하기(개정판 3.3 「☺＋」). 이미 있는 칸을 누르는 것 말고는 새 이모지를 달 길이 없었다.
        ActionChip(
          key: Key('reaction-add-${message.id}'),
          visualDensity: VisualDensity.compact,
          tooltip: context.t.reactionAdd,
          label: const Icon(Icons.add_reaction_outlined, size: 16),
          onPressed: () => pickReaction(context, message),
        ),
      ],
    );
  }
}

/// 메시지 링크. 데스크톱 `messagePermalink`(shared)와 같은 모양이어야 한다 — 어느 쪽에서
/// 복사했든 붙여넣은 곳에서 그 메시지로 이동된다.
String messagePermalink(String messageId) => 'harkroom://message/$messageId';

/// 줄을 누르는 자리. 시트가 떠 있는 동안 그 줄을 옅게 칠한다 — 시트가 줄을 덮으면 어느
/// 메시지의 메뉴인지 잊는다. VoiceOver 에는 같은 일을 사용자 지정 동작으로 건넨다(길게
/// 누르기는 화면 읽기에서 찾기 어렵다).
class _Pressable extends StatefulWidget {
  const _Pressable({required this.message, required this.child, this.onTap, this.onReplyInThread});

  final MessageRow message;
  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onReplyInThread;

  @override
  State<_Pressable> createState() => _PressableState();
}

class _PressableState extends State<_Pressable> {
  bool _open = false;

  Future<void> _sheet() async {
    setState(() => _open = true);
    try {
      await showMessageActions(context, widget.message, onReplyInThread: widget.onReplyInThread);
    } finally {
      if (mounted) setState(() => _open = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final m = widget.message;
    final reply = widget.onReplyInThread;
    final hasBody = m.body.trim().isNotEmpty;
    return Semantics(
      customSemanticsActions: {
        CustomSemanticsAction(label: t.messageReplyInThread): ?reply,
        CustomSemanticsAction(label: t.messageCopyLink): () => copyMessage(context, m, MessageCopy.link),
        if (hasBody) CustomSemanticsAction(label: t.messageCopyBody): () => copyMessage(context, m, MessageCopy.body),
      },
      child: Material(
        color: _open ? context.tokens.surfaceHover : Colors.transparent,
        child: InkWell(
          key: Key('message-press-${m.id}'),
          onTap: widget.onTap,
          onLongPress: _sheet,
          child: widget.child,
        ),
      ),
    );
  }
}

/// 메시지 길게 누르기 시트: 리액션 줄 · 스레드에서 답글 · 링크 복사 · 본문 복사.
///
/// 본문 복사는 **마크다운 원문**이다 — 그려진 글자가 아니라 다시 붙여넣을 수 있는 글이다.
/// 멘션만 `@handle` 로 되돌린다([bodyAsHandles]). 첨부·리액션은 본문이 아니라 싣지 않는다.
/// 본문이 비었으면(첨부만 있는 메시지) 본문 복사 줄을 세우지 않는다 — 눌러도 담을 것이 없다.
/// 시스템 글은 리액션과 복사만 둔다 — 사람의 말이 아니라 스레드를 열 까닭이 없다.
Future<void> showMessageActions(BuildContext context, MessageRow message, {VoidCallback? onReplyInThread}) async {
  final t = context.t;
  final app = context.app;
  final mine = app.me?.id;
  HapticFeedback.selectionClick().ignore();
  final hasBody = message.body.trim().isNotEmpty;
  final reply = message.kind == MessageKind.system ? null : onReplyInThread;
  final choice = await showModalBottomSheet<_SheetPick>(
    context: context,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // 리액션 줄(맨 위). 이미 단 것은 칠해 보인다 — 누르면 뗀다.
          Padding(
            padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 12, HarkroomSize.gutter, 4),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                for (final e in quickReactions)
                  _SheetEmoji(
                    key: Key('message-action-react-$e'),
                    emoji: e,
                    on: mine != null &&
                        message.reactions.any((r) => r.emoji == e && r.accountIds.contains(mine)),
                    onTap: () => Navigator.of(sheet).pop(_SheetPick.react(e)),
                  ),
              ],
            ),
          ),
          const Divider(height: 1),
          if (reply != null)
            ListTile(
              key: const Key('message-action-reply'),
              leading: const Icon(Icons.chat_bubble_outline),
              title: Text(t.messageReplyInThread),
              onTap: () => Navigator.of(sheet).pop(const _SheetPick.reply()),
            ),
          ListTile(
            key: const Key('message-action-copy-link'),
            leading: const Icon(Icons.link),
            title: Text(t.messageCopyLink),
            onTap: () => Navigator.of(sheet).pop(const _SheetPick.copy(MessageCopy.link)),
          ),
          if (hasBody)
            ListTile(
              key: const Key('message-action-copy-body'),
              leading: const Icon(Icons.content_copy),
              title: Text(t.messageCopyBody),
              onTap: () => Navigator.of(sheet).pop(const _SheetPick.copy(MessageCopy.body)),
            ),
        ],
      ),
    ),
  );
  if (choice == null || !context.mounted) return;
  switch (choice) {
    case _SheetPick(:final emoji?):
      Future<void> go() => app.toggleReaction(message.channelId, message.id, emoji);
      try {
        await go();
      } on Object {
        if (context.mounted) showFailureToast(context, t.reactionFailed, retry: () => go().ignore());
      }
    case _SheetPick(:final copy?):
      await copyMessage(context, message, copy);
    default:
      reply?.call();
  }
}

/// 시트에서 고른 것. 셋 중 하나만 찬다(셋 다 비면 「스레드에서 답글」).
class _SheetPick {
  const _SheetPick.react(String this.emoji) : copy = null;
  const _SheetPick.copy(MessageCopy this.copy) : emoji = null;
  const _SheetPick.reply()
      : emoji = null,
        copy = null;

  final String? emoji;
  final MessageCopy? copy;
}

/// 시트 맨 위 리액션 칸 하나. 엄지가 닿게 44pt 를 넘긴다.
class _SheetEmoji extends StatelessWidget {
  const _SheetEmoji({super.key, required this.emoji, required this.on, required this.onTap});

  final String emoji;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: on ? Theme.of(context).colorScheme.primaryContainer : context.tokens.surfaceSunken,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: 48,
            height: 48,
            child: Center(child: Text(emoji, style: const TextStyle(fontSize: 24))),
          ),
        ),
      );
}

/// 복사할 것.
enum MessageCopy { link, body }

/// 링크나 본문을 클립보드에 담고 짧게 알린다. 시트와 VoiceOver 동작이 같은 길을 쓴다.
Future<void> copyMessage(BuildContext context, MessageRow message, MessageCopy what) async {
  final t = context.t;
  final (text, done) = switch (what) {
    MessageCopy.link => (messagePermalink(message.id), t.messageLinkCopied),
    MessageCopy.body => (bodyAsHandles(message.body, AppScope.read(context).accounts), t.messageBodyCopied),
  };
  final messenger = ScaffoldMessenger.of(context);
  final margin = toastMargin(context);
  try {
    await Clipboard.setData(ClipboardData(text: text));
  } on Object {
    if (context.mounted) showFailureToast(context, t.messageCopyFailed);
    return;
  }
  // 짧은 확인. 앞의 토스트를 밀어내고 선다 — 연달아 복사하면 마지막 것이 보여야 한다.
  messenger
    ..removeCurrentSnackBar()
    ..showSnackBar(SnackBar(
      key: const Key('message-copied'),
      content: Text(done),
      behavior: SnackBarBehavior.floating,
      margin: margin,
      duration: const Duration(seconds: 2),
    ));
}

/// 자주 쓰는 이모지에서 하나를 고른다. 고르면 그 칸을 누른 것과 같다(이미 눌렀으면 뗀다).
const quickReactions = ['👍', '✅', '👀', '🎉', '❤️', '😂'];

Future<void> pickReaction(BuildContext context, MessageRow message) async {
  final app = context.app;
  final emoji = await showModalBottomSheet<String>(
    context: context,
    builder: (sheet) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter, vertical: 12),
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final e in quickReactions)
              InkWell(
                key: Key('reaction-pick-$e'),
                borderRadius: BorderRadius.circular(HarkroomRadius.card),
                onTap: () => Navigator.of(sheet).pop(e),
                child: SizedBox(
                  width: 48,
                  height: 48,
                  child: Center(child: Text(e, style: const TextStyle(fontSize: 26))),
                ),
              ),
          ],
        ),
      ),
    ),
  );
  if (emoji == null) return;
  Future<void> go() => app.toggleReaction(message.channelId, message.id, emoji);
  try {
    await go();
  } on Object {
    if (context.mounted) {
      showFailureToast(context, context.t.reactionFailed, retry: () => go().ignore());
    }
  }
}

/// 이름 · (에이전트 표지) · 시각 한 줄.
class _Header extends StatelessWidget {
  const _Header({required this.message, required this.isAgent});

  final MessageRow message;
  final bool isAgent;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final t = context.t;
    final k = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Flexible(
            child: Text(
              app.displayNameOf(message.authorId),
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: k.fg),
            ),
          ),
          // 사람과 에이전트를 **갈라 보여 준다** — 누구를 부르는지, 누가 답했는지가 이 앱의
          // 주제다. 모양(아바타)이 아니라 글자로 가른다.
          if (isAgent) ...[
            const SizedBox(width: 5),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
              decoration: BoxDecoration(
                border: Border.all(color: k.accent.withValues(alpha: 0.45)),
                borderRadius: BorderRadius.circular(HarkroomRadius.sm),
              ),
              child: Text(t.agentBadge,
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: k.accent)),
            ),
          ],
          const SizedBox(width: 6),
          // **상대 시각**이다. 서버는 ISO 시각만 주고, 글자는 여기서 폰 시간대로 짓는다.
          Text(
            agoLabel(message.createdAt, DateTime.now().toUtc(), t),
            key: Key('time-${message.id}'),
            style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted),
          ),
        ],
      ),
    );
  }
}

/// 멘션 거절 줄(재설계 §3.3, MH1). **노란 줄로 메시지 바로 아래에** 선다 — 이게 없으면 사람은
/// 불렀다고 믿고 조용히 기다린다(서버는 `meta.mentionDenied` 로 이미 알려 주고 있었다).
class _MentionDenied extends StatelessWidget {
  const _MentionDenied({required this.handles});

  final List<String> handles;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final t = context.t;
    final names = handles.map((h) => '@$h').join(', ');
    return Container(
      key: const Key('mention-denied'),
      margin: const EdgeInsets.only(top: 4),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(color: k.warningSurface, borderRadius: BorderRadius.circular(HarkroomRadius.card)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.warning_amber_rounded, size: 14, color: k.warning),
          const SizedBox(width: 5),
          Expanded(
            child: Text(t.mentionDeniedLine.replaceFirst('{handles}', names),
                style: TextStyle(fontSize: HarkroomType.meta, height: 1.35, color: k.warning)),
          ),
        ],
      ),
    );
  }
}

/// 날짜 줄의 글자: 오늘 · 어제 · 9월 28일. 스레드의 「답글 n개 · 오늘」도 같은 말을 쓴다.
///
/// [now] 는 시험이 고정 시각을 넣는 자리다(없으면 지금) — 자정 근처에 돌아도 「오늘」 이 흔들리지 않게.
String dayLabel(Strings t, DateTime at, {DateTime? now}) {
  final local = at.toLocal();
  now ??= DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(local.year, local.month, local.day);
  return day == today
      ? t.dayToday
      : day == today.subtract(const Duration(days: 1))
          ? t.dayYesterday
          : t.dayDate.replaceFirst('{m}', '${local.month}').replaceFirst('{d}', '${local.day}');
}

/// 같은 현지 날짜인가.
bool sameLocalDay(DateTime a, DateTime b) {
  final x = a.toLocal();
  final y = b.toLocal();
  return x.year == y.year && x.month == y.month && x.day == y.day;
}

/// 날짜 줄. 날짜가 바뀌는 자리에 **가운데 한 줄**로 선다.
class DayDivider extends StatelessWidget {
  const DayDivider({super.key, required this.at});

  final DateTime at;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final label = dayLabel(context.t, at);
    Widget line() => Expanded(child: Container(height: 1, color: k.border));
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter, vertical: 8),
      child: Row(
        children: [
          line(),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Text(label,
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: k.fgMuted)),
          ),
          line(),
        ],
      ),
    );
  }
}
