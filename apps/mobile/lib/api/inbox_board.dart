/// Inbox **보드 판정** — 데스크톱 `packages/desktop/src/lib/inboxBoard.ts` 의 Dart 포팅(Inbox A안 모바일 M1).
///
/// ## 왜 사본인가, 그리고 무엇이 지키나
///
/// 판정(어느 일이 내 차례인가·언제 접나·무엇을 묶나)은 데스크톱과 **같은 답**을 내야 한다 — 두 기기가
/// 다른 숫자를 말하면 사람은 어느 쪽도 믿지 않는다(옛 「129」). 서버는 재료(`GET /inbox/board`)만 주고
/// 판정은 클라이언트에 있으므로 Dart 에 두 번째 구현이 생긴다.
///
/// 그래서 **판례 표**가 지킨다: TS 가 `packages/desktop/test/fixtures/inboxBoardCases.json` 을 뽑고
/// (`inboxBoardCases.test.ts`), 이 파일은 `test/inbox_board_contract_test.dart` 에서 같은 입력에 같은 답을
/// 내야 한다. 입력은 **서버가 보내는 그대로의 JSON** 이라 이 파일의 읽기(`fromJson`)도 함께 잰다.
///
/// ## 사본이 지켜야 할 것
///
/// - `ask`·`failure` meta 는 **이 판정 전용 읽기**(`_boardAsk`·`_boardFailure`)로 읽는다. 화면용
///   `AskMeta.read` 는 모르는 수신자를 「사람 아무나」로 떨구지만(그려야 하므로), TS `readAskMeta` 는 그런
///   물음을 버린다 — 판정이 갈리면 남에게 간 물음이 내 차례로 선다.
/// - 정렬은 **안정**해야 한다(JS `Array.prototype.sort` 는 안정, Dart `List.sort` 는 보장이 없다) — 같은 시각의
///   두 줄 순서가 갈리면 판례가 빨개진다. 그래서 원래 자리를 마지막 열쇠로 쓴다.
/// - 시각은 밀리초로 견준다. 문자열 그대로 견주면 서버의 ISO 꼴이 바뀔 때 조용히 틀린다.
library;

import 'dart:convert';

import 'models.dart';

/// 열. 「내 차례」만 사람의 할 일이고, 나머지는 스레드의 지금 상태다.
enum BoardColumn {
  mine,
  blocked,
  active,
  done;

  String get wire => name;
}

/// 열 안에서 접힌 자리. `quiet` 7일 조용한 진행 · `old` 7일 넘은 끝남 · `stale` 7일 넘게 기다린 내 차례·막힘
/// (R2, 수에서 빠진다) · `cleared` 내가 치웠다 · `later` 내가 미뤘다.
enum BoardFold { quiet, old, stale, cleared, later }

/// 할 일의 종류(R4).
enum BoardKind { decision, blocker, news }

/// 펼쳐 두는 기간 — 7일.
const int recentMs = 7 * 86400000;

/// 요약 한 문장의 상한(글자 = UTF-16 단위, JS `length` 와 같다).
const int _maxSummary = 160;

// ── 재료 ───────────────────────────────────────────────────────────────

/// 스레드 머리의 **지금 상태** — 보드가 열을 가르는 데 쓰는 것만 읽는다(`GET /inbox/board` 의 `threads`).
class BoardHead {
  const BoardHead({
    required this.id,
    required this.channelId,
    required this.authorId,
    required this.body,
    required this.createdAt,
    this.lastReplyAt,
    this.replyCount,
    this.participantIds = const [],
    this.openAskHumanCount = 0,
    this.openAskAccountIds = const [],
    this.openAskLinks = const [],
    this.openGateAccountIds = const [],
    this.unresolvedFailureCount = 0,
    this.lastKind,
    this.lastAuthorId,
    this.status,
  });

  final String id;
  final String channelId;
  final String authorId;
  final String body;
  final DateTime createdAt;
  final DateTime? lastReplyAt;
  final int? replyCount;
  final List<String> participantIds;
  final int openAskHumanCount;
  final List<String> openAskAccountIds;

  /// 대기 마디 — 누가(waiter) 누구를(blockedBy) 기다리나.
  final List<({String? waiter, String? blockedBy})> openAskLinks;
  final List<String> openGateAccountIds;
  final int unresolvedFailureCount;
  final String? lastKind;
  final String? lastAuthorId;

  /// 서버 상태(`statusReaction.status`) — `received`·`running`·`waiting`·`my-turn`·`stuck`·`done`.
  final String? status;

  static List<String> _strs(Object? v) =>
      v is List ? v.whereType<String>().toList(growable: false) : const [];
  static int _n(Object? v) => v is num ? v.toInt() : 0;

  factory BoardHead.fromJson(Map<String, Object?> j) {
    final links = j['openAskLinks'];
    final sr = j['statusReaction'];
    return BoardHead(
      id: j['id'] as String? ?? '',
      channelId: j['channelId'] as String? ?? '',
      authorId: j['authorId'] as String? ?? '',
      body: j['body'] as String? ?? '',
      createdAt: _date(j['createdAt']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      lastReplyAt: _date(j['lastReplyAt']),
      replyCount: j['replyCount'] is num ? (j['replyCount']! as num).toInt() : null,
      participantIds: _strs(j['participantIds']),
      openAskHumanCount: _n(j['openAskHumanCount']),
      openAskAccountIds: _strs(j['openAskAccountIds']),
      openAskLinks: links is List
          ? [
              for (final l in links)
                if (l is Map) (waiter: l['waiter'] as String?, blockedBy: l['blockedBy'] as String?),
            ]
          : const [],
      openGateAccountIds: _strs(j['openGateAccountIds']),
      unresolvedFailureCount: _n(j['unresolvedFailureCount']),
      lastKind: j['lastKind'] as String?,
      lastAuthorId: j['lastAuthorId'] as String?,
      status: sr is Map && sr['status'] is String ? sr['status']! as String : null,
    );
  }
}

/// 스레드 하나의 **내** 처리 상태(완료·나중에). `PUT /inbox/threads/:rootId` 로 바꾼다.
class InboxThreadState {
  const InboxThreadState({required this.rootId, required this.state, required this.until, required this.updatedAt});

  final String rootId;

  /// `done` 또는 `later`.
  final String state;
  final DateTime? until;
  final DateTime updatedAt;

  static InboxThreadState? fromJson(Object? j) {
    if (j is! Map) return null;
    final rootId = j['rootId'];
    final state = j['state'];
    final updatedAt = _date(j['updatedAt']);
    if (rootId is! String || (state != 'done' && state != 'later') || updatedAt == null) return null;
    return InboxThreadState(rootId: rootId, state: state! as String, until: _date(j['until']), updatedAt: updatedAt);
  }
}

/// `GET /inbox/board` 한 판.
class InboxBoardData {
  const InboxBoardData({required this.entries, required this.threads, required this.threadStates, this.truncated = false});

  final List<InboxEntry> entries;

  /// `null` 이면 서버가 머리를 안 줬다(옛 서버) — 항목 `meta` 로 판정한다.
  final List<BoardHead>? threads;
  final List<InboxThreadState> threadStates;

  /// inbox 밖 머리가 서버 상한에서 잘렸다.
  final bool truncated;

  /// 간추린 판(`compact=1`)에서 잘린 본문 끝의 반쪽 멘션 토큰(`<@abc…`)을 뗀다 — 데스크톱 `dropCutMention`.
  static String dropCutMention(String body) => body.replaceFirst(RegExp(r'<@[^>\s]*$'), '');

  factory InboxBoardData.fromJson(Map<String, Object?> j) {
    final rawEntries = j['entries'] is List ? j['entries']! as List : const [];
    final rawThreads = j['threads'];
    final rawStates = j['threadStates'];
    return InboxBoardData(
      entries: [
        for (final e in rawEntries)
          if (e is Map)
            () {
              final entry = InboxEntry.fromJson(Map<String, Object?>.from(e));
              return e['bodyTruncated'] == true ? entry.withBody(dropCutMention(entry.body)) : entry;
            }(),
      ],
      threads: rawThreads is List
          ? [
              for (final m in rawThreads)
                if (m is Map)
                  () {
                    final head = BoardHead.fromJson(Map<String, Object?>.from(m));
                    return BoardHead(
                      id: head.id,
                      channelId: head.channelId,
                      authorId: head.authorId,
                      body: dropCutMention(head.body),
                      createdAt: head.createdAt,
                      lastReplyAt: head.lastReplyAt,
                      replyCount: head.replyCount,
                      participantIds: head.participantIds,
                      openAskHumanCount: head.openAskHumanCount,
                      openAskAccountIds: head.openAskAccountIds,
                      openAskLinks: head.openAskLinks,
                      openGateAccountIds: head.openGateAccountIds,
                      unresolvedFailureCount: head.unresolvedFailureCount,
                      lastKind: head.lastKind,
                      lastAuthorId: head.lastAuthorId,
                      status: head.status,
                    );
                  }(),
            ]
          : null,
      threadStates: rawStates is List
          ? rawStates.map(InboxThreadState.fromJson).whereType<InboxThreadState>().toList(growable: false)
          : const [],
      truncated: j['truncated'] == true,
    );
  }
}

// ── 결과 ───────────────────────────────────────────────────────────────

/// 카드 하나 = 일(스레드) 하나.
class BoardCard {
  const BoardCard({
    required this.rootId,
    required this.channelId,
    required this.column,
    required this.fold,
    required this.entries,
    required this.summary,
    required this.whoId,
    required this.sinceAt,
    required this.lastActivityAt,
    required this.unread,
    required this.ask,
    required this.laterUntil,
    required this.kind,
    required this.similarKey,
    required this.replyCount,
  });

  final String rootId;
  final String channelId;
  final BoardColumn column;
  final BoardFold? fold;

  /// 이 일에서 나에게 온 항목들, 최근 것이 앞.
  final List<InboxEntry> entries;

  /// 해야 할 일 한 문장(마크다운을 벗긴 평문).
  final String summary;
  final String? whoId;

  /// 「N일째」의 기준 — 이 열에 들어오게 한 말의 시각.
  final DateTime sinceAt;
  final DateTime lastActivityAt;
  final bool unread;

  /// 카드에서 바로 고를 물음 — **나에게 온 열린 물음**일 때만.
  final ({String messageId, List<({String id, String label})> options})? ask;
  final DateTime? laterUntil;
  final BoardKind kind;

  /// 같은 실패를 한 줄로 묶는 열쇠(R5). 결정 카드·실패 아닌 카드는 null.
  final String? similarKey;
  final int? replyCount;
}

/// 묶인 한 줄 — 맨 앞 카드와 같이 묶인 나머지(R5).
class BoardGroup {
  BoardGroup(this.card) : similar = [];
  final BoardCard card;
  final List<BoardCard> similar;
}

class BoardMe {
  const BoardMe({required this.id, required this.isHuman});
  final String id;
  final bool isHuman;
}

// ── 판정 ───────────────────────────────────────────────────────────────

/// 나를 **부른** 사유. `thread_reply` 는 빠진다 — 말을 한 번 얹었다는 뜻일 뿐 나를 지목한 것이 아니다.
const Set<InboxReason> _calledMe = {
  InboxReason.mention,
  InboxReason.teamMention,
  InboxReason.teamDelegated,
  InboxReason.delegationDone,
  InboxReason.dm,
  InboxReason.askAnswered,
  InboxReason.askClosed,
};

typedef _Scope = ({bool opened, bool calledMe});
typedef _Ask = ({String? prompt, List<({String id, String label})> options, String toKind, String? toAccountId});

/// TS `readAskMeta` + `isAskOpen` 과 같은 판례. 화면용 `AskMeta.read` 를 쓰지 않는 이유는 파일 머리 주석.
_Ask? _boardAsk(Map<String, Object?> meta) {
  if (meta['kind'] != 'ask') return null;
  final ask = meta['ask'];
  if (ask is! Map) return null;
  final options = ask['options'];
  if (options is! List || options.length < 2 || options.length > 5) return null;
  final parsed = <({String id, String label})>[];
  for (final o in options) {
    if (o is! Map || o['id'] is! String || o['label'] is! String) return null;
    parsed.add((id: o['id']! as String, label: o['label']! as String));
  }
  final to = ask['to'];
  if (to is! Map || (to['kind'] != 'human' && to['kind'] != 'account')) return null;
  if (to['kind'] == 'account' && to['accountId'] is! String) return null;
  if (ask['answeredWith'] != null || ask['closedAt'] != null) return null;
  return (
    prompt: ask['prompt'] is String ? ask['prompt']! as String : null,
    options: parsed,
    toKind: to['kind']! as String,
    toAccountId: to['accountId'] as String?,
  );
}

/// TS `readFailureMeta` 와 같은 판례 — `retryable` 이 불리언이 아니면 실패로 읽지 않는다.
({String? what, String? reason, String? code})? _boardFailure(Map<String, Object?> meta) {
  if (meta['kind'] != 'failure') return null;
  final f = meta['failure'];
  if (f is! Map || f['retryable'] is! bool) return null;
  return (what: f['what'] as String?, reason: f['reason'] as String?, code: f['code'] as String?);
}

_Ask? _askForMe(Map<String, Object?> meta, BoardMe? me, _Scope scope) {
  final ask = _boardAsk(meta);
  if (ask == null || me == null) return null;
  if (ask.toKind == 'human') return me.isHuman && (scope.opened || scope.calledMe) ? ask : null;
  return ask.toAccountId == me.id ? ask : null;
}

BoardColumn? _viewerColumn(BoardHead head, BoardMe? me, _Scope scope) {
  final myId = me?.id;
  final human = me?.isHuman ?? false;
  final mine = scope.opened || scope.calledMe;
  if ((myId != null && (head.openAskAccountIds.contains(myId) || head.openGateAccountIds.contains(myId))) ||
      (myId != null && head.openAskLinks.any((l) => l.blockedBy == myId)) ||
      (human && mine && (head.openAskHumanCount > 0 || head.unresolvedFailureCount > 0))) {
    return BoardColumn.mine;
  }
  return null;
}

BoardColumn _columnFromStatus(String status, _Scope scope) => switch (status) {
      'running' || 'received' => BoardColumn.active,
      'waiting' || 'my-turn' => BoardColumn.blocked,
      'stuck' => scope.opened || scope.calledMe ? BoardColumn.mine : BoardColumn.blocked,
      'done' => BoardColumn.done,
      // 모르는 상태 — TS 의 switch 는 갈래 밖 값이면 undefined 를 돌려 옛 규칙으로 떨어지지 않는다.
      // 서버 타입이 닫혀 있어 여기 올 일은 없지만, 오면 진행으로 둔다(가장 덜 단정적인 열).
      _ => BoardColumn.active,
    };

BoardColumn _legacyColumn(BoardHead head, BoardMe? me, bool Function(String) isAgent, _Scope scope) {
  final myId = me?.id;
  final iWait = myId != null && head.openAskLinks.any((l) => l.waiter == myId);
  final open = head.openAskLinks.isNotEmpty ||
      head.openAskAccountIds.isNotEmpty ||
      head.openAskHumanCount > 0 ||
      head.unresolvedFailureCount > 0;
  if ((scope.opened || iWait) && open) return BoardColumn.blocked;
  final running = head.lastKind == 'progress';
  if (!open && !running && head.lastAuthorId != null && isAgent(head.lastAuthorId!)) return BoardColumn.done;
  return BoardColumn.active;
}

BoardColumn _columnFromHead(BoardHead head, BoardMe? me, bool Function(String) isAgent, _Scope scope) {
  final viewer = _viewerColumn(head, me, scope);
  if (viewer != null) return viewer;
  if (head.status != null) return _columnFromStatus(head.status!, scope);
  return _legacyColumn(head, me, isAgent, scope);
}

BoardColumn _columnFromEntries(List<InboxEntry> entries, BoardMe? me, _Scope scope) {
  final human = me?.isHuman ?? false;
  if (entries.any((e) =>
      _askForMe(e.meta, me, scope) != null ||
      (human && (scope.opened || scope.calledMe) && _boardFailure(e.meta) != null))) {
    return BoardColumn.mine;
  }
  return BoardColumn.active;
}

BoardKind _kindOf(BoardHead? head, BoardMe? me, bool askForMe, bool failure) {
  final myId = me?.id;
  if (askForMe || (myId != null && (head?.openAskAccountIds ?? const []).contains(myId))) return BoardKind.decision;
  if (failure ||
      (myId != null && (head?.openGateAccountIds ?? const []).contains(myId)) ||
      (head?.unresolvedFailureCount ?? 0) > 0 ||
      head?.status == 'stuck') {
    return BoardKind.blocker;
  }
  return BoardKind.news;
}

final _headMarker = RegExp(r'^(#{1,6}|>|[-*+]|\d+[.)])\s+');
final _headMentions = RegExp(r'^(<@[^>]+>\s*)+');
final _image = RegExp(r'!\[([^\]]*)\]\([^)]*\)');
final _link = RegExp(r'\[([^\]]+)\]\([^)]*\)');
final _marks = RegExp(r'\*\*|__|~~|`');
final _italicStar = RegExp(r'\*([^*\s][^*]*?)\*');
final _italicUnderscore = RegExp(r'(^|\s)_([^_\s][^_]*)_(?=\s|$|[.,!?])');
final _rule = RegExp(r'^[-=*_]{3,}$');
final _question = RegExp(r'[?？]$');

/// 본문에서 **한 문장**을 고른다 — 표·코드·인용·제목 표시를 건너뛰고, 머리 멘션을 떼고, 물음표로 끝나는
/// 줄이 있으면 그것. TS `oneSentence` 와 같은 정규식이다.
String oneSentence(String body) {
  final lines = <String>[];
  var fenced = false;
  for (final raw in body.split('\n')) {
    final line = raw.trim();
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.isEmpty || line.startsWith('|') || _rule.hasMatch(line)) continue;
    final text = line
        .replaceFirst(_headMarker, '')
        .replaceFirst(_headMentions, '')
        .replaceAllMapped(_image, (m) => m[1]!)
        .replaceAllMapped(_link, (m) => m[1]!)
        .replaceAll(_marks, '')
        .replaceAllMapped(_italicStar, (m) => m[1]!)
        .replaceAllMapped(_italicUnderscore, (m) => '${m[1]}${m[2]}')
        .trim();
    if (text.isNotEmpty) lines.add(text);
  }
  final pick = lines.firstWhere(_question.hasMatch, orElse: () => lines.isEmpty ? '' : lines.first);
  return pick.length > _maxSummary ? '${pick.substring(0, _maxSummary - 1)}…' : pick;
}

/// 지금도 뜻이 있는 내 상태인가 — 그 뒤로 나에게 새 말이 왔으면 풀리고, 나중에는 깨어날 시각이 지나도 풀린다.
InboxThreadState? _effectiveState(InboxThreadState? s, int latestEntryMs, int nowMs) {
  if (s == null) return null;
  if (latestEntryMs > s.updatedAt.millisecondsSinceEpoch) return null;
  if (s.state == 'later' && (s.until == null || s.until!.millisecondsSinceEpoch <= nowMs)) return null;
  return s;
}

/// **내 차례 수** — 머리글·배지의 숫자. 접힌 것(나중에·7일 넘은 것)은 세지 않는다.
int mineCount(List<BoardCard> cards) => cards.where((c) => c.column == BoardColumn.mine && c.fold == null).length;

/// 안정 정렬 — 같은 열쇠면 원래 자리 그대로(JS 와 같다).
List<T> _stableSorted<T>(List<T> list, int Function(T a, T b) compare) {
  final indexed = [for (var i = 0; i < list.length; i++) (i, list[i])];
  indexed.sort((a, b) {
    final c = compare(a.$2, b.$2);
    return c != 0 ? c : a.$1 - b.$1;
  });
  return [for (final p in indexed) p.$2];
}

/// 보드를 세운다. TS `buildBoard` 와 같은 순서·같은 규칙.
List<BoardCard> buildBoard({
  required List<InboxEntry> entries,
  required List<BoardHead>? threads,
  required BoardMe? me,
  required List<InboxThreadState> threadStates,
  required bool Function(String accountId) isAgent,
  required int nowMs,
}) {
  final heads = {for (final m in threads ?? const <BoardHead>[]) m.id: m};
  final states = {for (final s in threadStates) s.rootId: s};
  final groups = <String, List<InboxEntry>>{};
  for (final e in entries) {
    groups.putIfAbsent(e.threadRootId ?? e.messageId, () => []).add(e);
  }
  for (final head in threads ?? const <BoardHead>[]) {
    groups.putIfAbsent(head.id, () => []);
  }
  final myId = me?.id;
  final cards = <BoardCard>[];
  for (final MapEntry(key: rootId, value: unsorted) in groups.entries) {
    final list = _stableSorted(
      unsorted,
      (InboxEntry a, InboxEntry b) => b.createdAt.millisecondsSinceEpoch - a.createdAt.millisecondsSinceEpoch,
    );
    final head = heads[rootId];
    final latest = list.isEmpty ? null : list.first;
    if (threads != null && head == null) continue;
    final _Scope scope = (
      opened: myId != null && head?.authorId == myId,
      calledMe: list.any((e) => _calledMe.contains(e.reason)),
    );
    var column = head != null ? _columnFromHead(head, me, isAgent, scope) : _columnFromEntries(list, me, scope);
    // 가장 늦은 시각 — 같으면 앞 것(TS reduce 의 `>=`).
    final candidates = [head?.lastReplyAt, head?.createdAt, latest?.createdAt].whereType<DateTime>();
    final lastActivityAt = candidates.reduce((a, b) => a.millisecondsSinceEpoch >= b.millisecondsSinceEpoch ? a : b);
    final stale = nowMs - lastActivityAt.millisecondsSinceEpoch > recentMs;
    final running = head?.lastKind == 'progress';
    final state = _effectiveState(states[rootId], latest?.createdAt.millisecondsSinceEpoch ?? 0, nowMs);
    final openAsk = list.where((e) => _askForMe(e.meta, me, scope) != null).firstOrNull;
    final failure = column == BoardColumn.mine ? list.where((e) => _boardFailure(e.meta) != null).firstOrNull : null;
    final lead = openAsk ?? failure;
    final ask = openAsk != null ? _askForMe(openAsk.meta, me, scope) : null;
    final failureMeta = failure != null ? _boardFailure(failure.meta) : null;
    String orEmpty(String? s) => s ?? '';
    final reasonLine = failureMeta?.reason != null && failureMeta!.reason!.isNotEmpty ? oneSentence(failureMeta.reason!) : '';
    final whatLine = failureMeta?.what != null && failureMeta!.what!.isNotEmpty ? oneSentence(failureMeta.what!) : '';
    final failureTitle = reasonLine.isNotEmpty ? reasonLine : whatLine;
    final promptLine = ask?.prompt != null && ask!.prompt!.isNotEmpty ? oneSentence(ask.prompt!) : '';
    var summary = promptLine;
    if (summary.isEmpty) summary = failureTitle;
    if (summary.isEmpty) summary = oneSentence(lead?.body ?? head?.body ?? orEmpty(latest?.body));
    if (summary.isEmpty) summary = oneSentence(orEmpty(latest?.body));
    final sinceAt = (lead ?? latest)?.createdAt ?? lastActivityAt;

    BoardFold? fold;
    if (state?.state == 'later') {
      fold = BoardFold.later;
    } else if (state?.state == 'done') {
      column = BoardColumn.done;
      fold = BoardFold.cleared;
    } else if ((column == BoardColumn.mine || column == BoardColumn.blocked) &&
        nowMs - sinceAt.millisecondsSinceEpoch > recentMs) {
      fold = BoardFold.stale;
    } else if (column == BoardColumn.active && stale && !running) {
      fold = BoardFold.quiet;
    } else if (column == BoardColumn.done && stale) {
      fold = BoardFold.old;
    }

    final kind = _kindOf(head, me, ask != null, failure != null);
    cards.add(BoardCard(
      rootId: rootId,
      channelId: head?.channelId ?? latest!.channelId,
      column: column,
      fold: fold,
      entries: List.unmodifiable(list),
      summary: summary,
      whoId: lead?.authorId ?? head?.authorId ?? latest?.authorId,
      sinceAt: sinceAt,
      lastActivityAt: lastActivityAt,
      unread: list.any((e) => e.readAt == null),
      ask: openAsk != null && ask != null ? (messageId: openAsk.messageId, options: ask.options) : null,
      laterUntil: fold == BoardFold.later ? state?.until : null,
      kind: kind,
      // TS `JSON.stringify([채널, 작성자, code, 원인])` 과 같은 글자 — 열쇠는 비교만 하지만 판례가 글자로 잰다.
      similarKey: kind != BoardKind.decision && failure != null && failureTitle.isNotEmpty
          ? jsonEncode([failure.channelId, failure.authorId, failureMeta?.code, failureTitle])
          : null,
      replyCount: head?.replyCount,
    ));
  }
  return _stableSorted(cards, (BoardCard a, BoardCard b) {
    if (a.column != b.column) return a.column.index - b.column.index;
    if (a.column == BoardColumn.mine || a.column == BoardColumn.blocked) {
      return b.sinceAt.millisecondsSinceEpoch - a.sinceAt.millisecondsSinceEpoch;
    }
    return b.lastActivityAt.millisecondsSinceEpoch - a.lastActivityAt.millisecondsSinceEpoch;
  });
}

/// **같은 실패는 한 줄로**(R5). 묶음은 같은 목록 안에서만 — 부르는 쪽이 이미 가른 목록을 준다.
List<BoardGroup> groupSimilar(List<BoardCard> cards) {
  final groups = <BoardGroup>[];
  final byKey = <String, BoardGroup>{};
  for (final card in cards) {
    final g = card.similarKey != null ? byKey[card.similarKey] : null;
    if (g != null) {
      g.similar.add(card);
      continue;
    }
    final fresh = BoardGroup(card);
    groups.add(fresh);
    if (card.similarKey != null) byKey[card.similarKey!] = fresh;
  }
  return groups;
}

/// 「N일째」 — 하루 안이면 null(화면이 상대 시각으로 쓴다).
int? daysWaiting(DateTime sinceAt, int nowMs) {
  final days = ((nowMs - sinceAt.millisecondsSinceEpoch) / 86400000).floor();
  return days >= 1 ? days : null;
}

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v)?.toUtc() : null;
