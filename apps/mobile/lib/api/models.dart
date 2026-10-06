/// 서버가 주는 모양을 Dart 로 **손으로** 옮긴 것(계획서 결정 5).
///
/// ## 규약 하나 — 모르는 것은 버리지 않고 **견딘다**
///
/// 이 모델들은 `packages/shared/src/index.ts` 의 사본이고, 사본은 갈라진다. 그래서 파서는
/// 엄격하지 않다: 모르는 필드는 무시하고, 아는 필드가 없으면 **그럴듯한 기본값**으로
/// 떨어진다. 서버가 필드를 하나 더하는 날 앱이 흰 화면이 되는 것보다, 그 필드를 모른 채
/// 도는 편이 낫다.
///
/// 갈라지는 것을 **막지는 못하지만 알아채게는** 한다 — `test/golden/` 의 실제 응답 표본이
/// 그 일을 한다. 서버가 모양을 바꾸면 사람이 앱을 열기 전에 시험이 먼저 빨개진다.
library;

/// `null` 도 아니고 문자열도 아닌 것이 올 수 있다 — JSON 은 무엇이든 담는다.
String _str(Object? v, [String fallback = '']) => v is String ? v : fallback;

bool _bool(Object? v, [bool fallback = false]) => v is bool ? v : fallback;

int _int(Object? v, [int fallback = 0]) => v is int ? v : (v is num ? v.toInt() : fallback);

List<String> _strList(Object? v) =>
    v is List ? v.whereType<String>().toList(growable: false) : const [];

/// 로그인한 나. `GET /auth/me`.
class MeView {
  const MeView({required this.id, required this.handle, required this.displayName, required this.isAdmin});

  final String id;
  final String handle;
  final String displayName;
  final bool isAdmin;

  static MeView fromJson(Map<String, Object?> j) => MeView(
        id: _str(j['id']),
        handle: _str(j['handle']),
        displayName: _str(j['displayName']),
        isAdmin: _bool(j['isAdmin']),
      );
}

/// 디렉터리의 한 사람 또는 에이전트. `GET /accounts`.
///
/// **비활성 계정도 목록에 남는다**(`isDisabled`). 이 목록은 멘션 자동완성의 원천이면서
/// 동시에 **작성자 이름을 푸는 표**라, 빼 버리면 그 에이전트의 과거 메시지가 작성자를
/// 잃는다. 자동완성 후보에서 빼는 것은 화면의 몫이다.
class AccountView {
  const AccountView({
    required this.id,
    required this.handle,
    required this.displayName,
    required this.isAgent,
    required this.isDisabled,
    required this.avatarAttachmentId,
  });

  final String id;
  final String handle;
  final String displayName;
  final bool isAgent;
  final bool isDisabled;

  /// 아바타 이미지의 **첨부 id**. 계정 id 가 아니다 — 캐시 키로 쓸 것은 이쪽이다
  /// (사진을 바꾸면 계정 id 는 그대로인데 그림이 달라진다).
  final String? avatarAttachmentId;

  static AccountView fromJson(Map<String, Object?> j) => AccountView(
        id: _str(j['id']),
        handle: _str(j['handle']),
        displayName: _str(j['displayName']),
        isAgent: _str(j['kind']) == 'agent',
        isDisabled: _bool(j['isDisabled']),
        avatarAttachmentId: j['avatarAttachmentId'] as String?,
      );
}

/// 채널 하나. `GET /channels`.
class ChannelRow {
  const ChannelRow({
    required this.id,
    required this.name,
    required this.isPrivate,
    required this.isDm,
    required this.topic,
    this.memberIds = const [],
  });

  final String id;
  final String name;
  final bool isPrivate;

  /// DM 의 참여자(나 포함). 채널이면 비어 있다 — `GET /channels` 는 명단을 주지 않는다.
  final List<String> memberIds;

  /// DM 은 이름이 아니라 **상대**로 그려야 한다 — 화면이 갈라져야 하므로 값으로 둔다.
  final bool isDm;
  final String? topic;

  static ChannelRow fromJson(Map<String, Object?> j) => ChannelRow(
        id: _str(j['id']),
        name: _str(j['name']),
        isPrivate: _bool(j['isPrivate']),
        isDm: _str(j['kind']) == 'dm',
        topic: j['topic'] as String?,
      );

  /// `GET /dms` 의 한 줄(`id`·`memberIds`). **`GET /channels` 는 DM 을 주지 않는다**(kind standard 만) —
  /// DM 은 이 길로만 온다. 이름은 서버가 주지 않으므로 [name] 은 비워 두고 화면 쪽이 상대 이름으로 채운다.
  static ChannelRow fromDmJson(Map<String, Object?> j) => ChannelRow(
        id: _str(j['id']),
        name: '',
        isPrivate: true,
        isDm: true,
        topic: null,
        memberIds: _strList(j['memberIds']),
      );

  ChannelRow withName(String n) =>
      ChannelRow(id: id, name: n, isPrivate: isPrivate, isDm: isDm, topic: topic, memberIds: memberIds);
}

/// 리액션 한 칸. 누가 눌렀는지까지 온다 — 내가 눌렀는지를 화면이 알아야 한다.
class ReactionRow {
  const ReactionRow({required this.emoji, required this.accountIds});

  final String emoji;
  final List<String> accountIds;

  static ReactionRow fromJson(Map<String, Object?> j) => ReactionRow(
        emoji: _str(j['emoji']),
        accountIds: _strList(j['accountIds']),
      );
}

/// 스레드 상태(서버 `statusReaction`, 루트에만). 서버는 이 상태를 루트의 **진짜 리액션**으로도 단다 —
/// 주인 에이전트 이름으로, 끝남(done)은 없이(server 108, 2026-10-06). 화면은 이것으로 그 리액션 칸이
/// 상태 칸인지 알아볼 뿐이다 — 따로 그리지 않는다.
class ThreadStatusMark {
  const ThreadStatusMark({required this.status, required this.emoji, required this.accountId, required this.reason});

  /// `received`·`running`·`waiting`·`my-turn`·`stuck`·`done`.
  final String status;
  final String emoji;
  final String? accountId;
  final String? reason;

  /// 이 리액션 칸이 서버가 단 상태 칸인가 — 상태 이모지이고 주인 에이전트가 들어 있다. 끝남은 달지 않는다.
  bool marks(ReactionRow r) =>
      status != 'done' && accountId != null && r.emoji == emoji && r.accountIds.contains(accountId);

  static ThreadStatusMark? fromJson(Object? j) {
    if (j is! Map) return null;
    final status = j['status'];
    final emoji = j['emoji'];
    if (status is! String || emoji is! String) return null;
    return ThreadStatusMark(
      status: status,
      emoji: emoji,
      accountId: j['accountId'] as String?,
      reason: j['reason'] as String?,
    );
  }
}

/// 첨부 하나.
class AttachmentRow {
  const AttachmentRow({
    required this.id,
    required this.filename,
    required this.contentType,
    required this.byteSize,
    this.artifact,
  });

  final String id;
  final String filename;
  final String contentType;
  final int byteSize;

  /// 미리보기(아티팩트) 버전이면 있다(서버 0.3.133~, `artifact.publish`). 보통 첨부에는 없다.
  final ArtifactRef? artifact;

  bool get isImage => contentType.startsWith('image/');

  static AttachmentRow fromJson(Map<String, Object?> j) => AttachmentRow(
        id: _str(j['id']),
        filename: _str(j['filename']),
        contentType: _str(j['contentType'], 'application/octet-stream'),
        byteSize: _int(j['sizeBytes']),
        artifact: j['artifact'] is Map ? ArtifactRef.fromJson((j['artifact']! as Map).cast<String, Object?>()) : null,
      );
}

/// 첨부가 가리키는 미리보기 버전. `title`·`summary` 는 **그 글의 버전** 것이다(#1065) — 옛 카드는 그때 이름을
/// 보인다. `latestVersion` 은 목록을 읽은 순간 값이라, 화면은 더 높은 버전 글이 들어오면 스스로 알약을 갱신한다.
class ArtifactRef {
  const ArtifactRef({
    required this.artifactId,
    required this.version,
    required this.latestVersion,
    required this.title,
    this.latestTitle,
    this.summary,
    this.coverAttachmentId,
  });

  final String artifactId;
  final int version;
  final int latestVersion;
  final String title;
  final String? latestTitle;
  final String? summary;
  final String? coverAttachmentId;

  static ArtifactRef fromJson(Map<String, Object?> j) => ArtifactRef(
        artifactId: _str(j['artifactId']),
        version: _int(j['version'], 1),
        latestVersion: _int(j['latestVersion'], _int(j['version'], 1)),
        title: _str(j['title']),
        latestTitle: j['latestTitle'] is String ? j['latestTitle']! as String : null,
        summary: j['summary'] is String ? j['summary']! as String : null,
        coverAttachmentId: j['coverAttachmentId'] is String ? j['coverAttachmentId']! as String : null,
      );
}

/// `POST /attachments/:id/preview` 의 답 — 60초짜리 서명 경로. 열 때마다 새로 받는다.
class PreviewTicket {
  const PreviewTicket({required this.path, required this.title, required this.version});

  final String path;
  final String title;
  final int version;

  static PreviewTicket fromJson(Map<String, Object?> j) => PreviewTicket(
        path: _str(j['path']),
        title: _str(j['title']),
        version: _int(j['version'], 1),
      );
}

/// 메시지가 **어떤 말인가.** 서버의 `MessageRow.kind` 그대로다.
///
/// `progress` 와 `wake` 는 **결과 발화가 아니다** — 말풍선으로 그리지 않고 상태 줄·대기
/// 줄로 접는다(데스크탑 `ProgressRow`·`WakeRow` 의 판단). 모르는 값은 [user] 로 떨어진다:
/// 서버가 종류를 하나 더하는 날, 그 메시지가 **안 보이는 것**보다 평범한 말풍선으로라도
/// 보이는 편이 낫다.
enum MessageKind {
  user,
  system,
  progress,
  wake;

  static MessageKind parse(Object? v) => switch (v) {
        'system' => MessageKind.system,
        'progress' => MessageKind.progress,
        'wake' => MessageKind.wake,
        _ => MessageKind.user,
      };
}

/// 메시지 하나. `GET /channels/{id}/messages`, 그리고 `message.created` 이벤트.
class MessageRow {
  const MessageRow({
    required this.id,
    required this.seq,
    required this.channelId,
    required this.threadRootId,
    required this.authorId,
    required this.body,
    required this.kind,
    required this.meta,
    required this.createdAt,
    required this.editedAt,
    required this.reactions,
    required this.attachments,
    required this.replyCount,
    this.alsoInChannel = false,
    this.participantIds = const [],
    this.lastReplyAt,
    this.status,
  });

  final String id;

  /// 채널 안에서 **단조 증가**한다. 목록을 이어 붙일 때의 커서이고, 같은 메시지가 두 번
  /// 와도 이것으로 가려낸다(재연결 직후에 실제로 그런 일이 생긴다).
  final int seq;
  final String channelId;
  final String? threadRootId;
  final String authorId;
  final String body;
  final MessageKind kind;

  /// `ask`·`report`·`failure`·`wake` 의 내용이 여기 실린다. **해석하지 않고 들고만 있는다** —
  /// 아는 `kind` 만 읽고 모르는 것은 평문으로 흘리는 것이 데스크탑의 규약이고, 사본인 이쪽이
  /// 그것을 어기면 모르는 meta 가 화면에서 **사라진다.**
  final Map<String, Object?> meta;

  final DateTime createdAt;
  final DateTime? editedAt;
  final List<ReactionRow> reactions;
  final List<AttachmentRow> attachments;

  /// **스레드 루트에만 있다.** 답글이면 `null` — "답글이 0개"가 아니라 "이 질문의 대상이
  /// 아니다"다. 둘을 0 으로 뭉치면 모든 답글이 스레드 진입점을 갖게 된다.
  final int? replyCount;

  /// **스레드 루트에만**: 답글을 단 사람들의 id(서버가 센다, 최근 순). 요약 줄의 아바타가 쓴다.
  /// 옛 서버나 답글이면 비어 있다.
  final List<String> participantIds;

  /// **스레드 루트에만**: 마지막 답글 시각. 요약 줄 「· 2분 전」 이 쓴다.
  final DateTime? lastReplyAt;

  /// **스레드 루트에만**: 스레드 상태(`ThreadStatusMark`). 옛 서버·답글·에이전트가 안 낀 스레드는 `null`.
  final ThreadStatusMark? status;

  /// 스레드 답글인데 **채널에도 보이라고** 올린 것(#231). 채널 화면은 루트와 이것만 그린다.
  final bool alsoInChannel;

  /// 채널 화면에 한 줄로 설 말인가. 서버는 채널 조회에 **답글까지 섞어** 주고 거르는 것은
  /// 화면의 몫이다(데스크탑 `ChannelPane` 과 같은 규칙) — 안 거르면 남의 스레드 대화가
  /// 채널 한가운데 문맥 없이 흘러든다.
  bool get inChannelFeed => threadRootId == null || alsoInChannel;

  /// 답글 수를 바꾼 사본(루트에만 뜻이 있다).
  MessageRow withReplyCount(int n) => MessageRow(
        id: id,
        seq: seq,
        channelId: channelId,
        threadRootId: threadRootId,
        authorId: authorId,
        body: body,
        kind: kind,
        meta: meta,
        createdAt: createdAt,
        editedAt: editedAt,
        reactions: reactions,
        attachments: attachments,
        replyCount: n < 0 ? 0 : n,
        alsoInChannel: alsoInChannel,
        participantIds: participantIds,
        lastReplyAt: lastReplyAt,
        status: status,
      );

  /// 스레드 상태를 바꾼 사본(`thread.status` 이벤트).
  MessageRow withStatus(ThreadStatusMark? next) => MessageRow(
        id: id,
        seq: seq,
        channelId: channelId,
        threadRootId: threadRootId,
        authorId: authorId,
        body: body,
        kind: kind,
        meta: meta,
        createdAt: createdAt,
        editedAt: editedAt,
        reactions: reactions,
        attachments: attachments,
        replyCount: replyCount,
        alsoInChannel: alsoInChannel,
        participantIds: participantIds,
        lastReplyAt: lastReplyAt,
        status: next,
      );

  bool get isThreadRoot => threadRootId == null;

  /// 화면이 **말풍선으로 그릴 말**인가. `progress`·`wake` 는 아니다.
  bool get isSpeech => kind == MessageKind.user || kind == MessageKind.system;

  /// 리액션 델타 하나를 적용한 사본.
  ///
  /// **마지막 사람이 떼면 칸이 사라진다** — 아무도 안 누른 이모지가 남아 있으면 그것은
  /// 누군가 눌렀다는 거짓 신호다.
  MessageRow withReaction({required String emoji, required String accountId, required bool added}) {
    final next = <ReactionRow>[];
    var seen = false;
    for (final r in reactions) {
      if (r.emoji != emoji) {
        next.add(r);
        continue;
      }
      seen = true;
      final ids = [...r.accountIds];
      if (added) {
        if (!ids.contains(accountId)) ids.add(accountId);
      } else {
        ids.remove(accountId);
      }
      if (ids.isNotEmpty) next.add(ReactionRow(emoji: emoji, accountIds: ids));
    }
    if (!seen && added) next.add(ReactionRow(emoji: emoji, accountIds: [accountId]));

    return MessageRow(
      id: id,
      seq: seq,
      channelId: channelId,
      threadRootId: threadRootId,
      authorId: authorId,
      body: body,
      kind: kind,
      meta: meta,
      createdAt: createdAt,
      editedAt: editedAt,
      reactions: next,
      attachments: attachments,
      replyCount: replyCount,
      alsoInChannel: alsoInChannel,
      participantIds: participantIds,
      lastReplyAt: lastReplyAt,
      status: status,
    );
  }

  static MessageRow fromJson(Map<String, Object?> j) => MessageRow(
        id: _str(j['id']),
        seq: _int(j['seq']),
        channelId: _str(j['channelId']),
        threadRootId: j['threadRootId'] as String?,
        authorId: _str(j['authorId']),
        body: _str(j['body']),
        kind: MessageKind.parse(j['kind']),
        meta: j['meta'] is Map ? Map<String, Object?>.from(j['meta']! as Map) : const {},
        // 시각이 깨져 있으면 **메시지를 버리지 않고** epoch 으로 떨어진다. 한 줄이 잘못된
        // 시각에 놓이는 것이, 그 줄이 통째로 사라지는 것보다 낫다.
        createdAt: DateTime.tryParse(_str(j['createdAt']))?.toUtc() ??
            DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        editedAt: DateTime.tryParse(_str(j['editedAt']))?.toUtc(),
        reactions: j['reactions'] is List
            ? (j['reactions']! as List)
                .whereType<Map>()
                .map((e) => ReactionRow.fromJson(Map<String, Object?>.from(e)))
                .toList(growable: false)
            : const [],
        attachments: j['attachments'] is List
            ? (j['attachments']! as List)
                .whereType<Map>()
                .map((e) => AttachmentRow.fromJson(Map<String, Object?>.from(e)))
                .toList(growable: false)
            : const [],
        replyCount: j['replyCount'] is num ? (j['replyCount']! as num).toInt() : null,
        alsoInChannel: j['alsoInChannel'] == true,
        participantIds: j['participantIds'] is List
            ? (j['participantIds']! as List).whereType<String>().toList(growable: false)
            : const [],
        lastReplyAt: DateTime.tryParse(_str(j['lastReplyAt']))?.toUtc(),
        status: ThreadStatusMark.fromJson(j['statusReaction']),
      );
}

/// 한 페이지의 메시지와 **더 있는지**. 역방향 페이지(`before` 커서)를 쓴다.
class MessagePage {
  const MessagePage({required this.messages, required this.hasMore});

  final List<MessageRow> messages;
  final bool hasMore;

  static MessagePage fromJson(Map<String, Object?> j) => MessagePage(
        messages: j['messages'] is List
            ? (j['messages']! as List)
                .whereType<Map>()
                .map((e) => MessageRow.fromJson(Map<String, Object?>.from(e)))
                .toList(growable: false)
            : const [],
        hasMore: _bool(j['hasMore']),
      );
}


/// 한 채널의 읽음 위치. `GET /reads`.
class ReadState {
  const ReadState({required this.channelId, required this.lastReadSeq, required this.unread});

  final String channelId;

  /// 여기까지 읽었다. **`seq` 다** — 시각이 아니다(기기 시계가 틀리면 읽음이 흔들린다).
  final int lastReadSeq;

  /// 안 읽은 수. 서버가 센다 — 클라이언트가 세면 열지 않은 채널에서 틀린다.
  final int unread;

  static ReadState fromJson(Map<String, Object?> j) => ReadState(
        channelId: _str(j['channelId']),
        lastReadSeq: _int(j['lastReadSeq']),
        unread: _int(j['unread']),
      );
}

/// 채널 하나에 대한 **내** 선호. `GET /channels/prefs`(데스크탑 사이드바와 같은 값).
/// 모바일은 S5b 에서 읽기만 한다 — 별표·섹션 편집은 S9 채널 시트.
class ChannelPref {
  const ChannelPref({
    required this.channelId,
    required this.starred,
    required this.section,
    required this.sortOrder,
    required this.hidden,
  });

  final String channelId;

  /// 즐겨찾기(`starredAt` 이 있다).
  final bool starred;

  /// 사용자 섹션 이름. null 이면 섹션 없음(맨 아래 「채널」).
  final String? section;

  /// 섹션 안 수동 순서. null 이면 이름순 뒤.
  final int? sortOrder;

  /// 사이드바에서 치웠다(`hiddenAt` 이 있다) — 목록에 세우지 않는다.
  final bool hidden;

  static ChannelPref fromJson(Map<String, Object?> j) => ChannelPref(
        channelId: _str(j['channelId']),
        starred: j['starredAt'] is String,
        section: j['section'] is String && (j['section']! as String).trim().isNotEmpty ? j['section']! as String : null,
        sortOrder: j['sortOrder'] is num ? (j['sortOrder']! as num).toInt() : null,
        hidden: j['hiddenAt'] is String,
      );
}

/// 내가 **불린 이유**. 러너가 프롬프트를 다르게 조립하려고 서버가 갈라 둔 값이고,
/// 화면도 같은 이유로 갈라 그린다 — "멘션"과 "내가 낸 물음에 답이 왔다"는 다른 일이다.
///
/// 모르는 사유는 [unknown] 으로 떨어진다. 서버가 하나 더하는 날 그 줄이 **사라지는**
/// 것보다, 사유를 모른 채 보이는 편이 낫다.
enum InboxReason {
  mention,
  threadReply,
  dm,
  wake,
  askAnswered,
  askClosed,
  teamMention,
  teamDelegated,
  delegationDone,
  unknown;

  static InboxReason parse(Object? v) => switch (v) {
        'mention' => InboxReason.mention,
        'thread_reply' => InboxReason.threadReply,
        'dm' => InboxReason.dm,
        'wake' => InboxReason.wake,
        'ask_answered' => InboxReason.askAnswered,
        'ask_closed' => InboxReason.askClosed,
        'team_mention' => InboxReason.teamMention,
        'team_delegated' => InboxReason.teamDelegated,
        'delegation_done' => InboxReason.delegationDone,
        _ => InboxReason.unknown,
      };
}

/// 받은 것 한 줄. `GET /inbox`.
class InboxEntry {
  const InboxEntry({
    required this.id,
    required this.messageId,
    required this.reason,
    required this.channelId,
    required this.authorId,
    required this.body,
    required this.createdAt,
    required this.threadRootId,
    required this.readAt,
  });

  /// 읽음 처리에 쓰는 열쇠. **메시지 id 가 아니다** — 같은 메시지로 두 번 불릴 수 있다.
  final int id;
  final String messageId;
  final InboxReason reason;
  final String channelId;

  /// 깨움(`wake`)에는 **작성자가 없다** — 사람의 발화가 아니라 자기가 걸어 둔 예약이다.
  final String? authorId;
  final String body;
  final DateTime createdAt;
  final String? threadRootId;
  final String? readAt;

  bool get isUnread => readAt == null;

  static InboxEntry fromJson(Map<String, Object?> j) => InboxEntry(
        id: _int(j['id']),
        messageId: _str(j['messageId']),
        reason: InboxReason.parse(j['reason']),
        channelId: _str(j['channelId']),
        authorId: j['authorId'] as String?,
        body: _str(j['body']),
        createdAt: DateTime.tryParse(_str(j['createdAt']))?.toUtc() ??
            DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        threadRootId: j['threadRootId'] as String?,
        readAt: j['readAt'] as String?,
      );
}

/// 채널 자동 멘션 한 줄(`GET /channels/:id/auto-mentions`, #173 · 모드는 마이그레이션 048).
///
/// - `always`: 이 채널의 작성칸이 **매 글 앞에** `@handle` 을 붙인다.
/// - `available`: 붙이지는 않고 "이 채널이 데리고 있는 에이전트"로 후보에 띄운다 — 누르면 고정된다.
///
/// 모드를 모르는 옛 서버(048 이전)는 `mode` 를 싣지 않는다. 그때의 자동 멘션은 전부 `always` 였다.
class ChannelAutoMention {
  const ChannelAutoMention({required this.agentAccountId, required this.handle, required this.mode});

  final String agentAccountId;
  final String handle;
  final String mode;

  bool get isAlways => mode != 'available';

  factory ChannelAutoMention.fromJson(Map<String, Object?> j) => ChannelAutoMention(
        agentAccountId: _str(j['agentAccountId']),
        handle: _str(j['handle']),
        mode: _str(j['mode'], 'always'),
      );
}

/// 스레드 × 에이전트 모델 지정 한 줄(서버 079). 값이 null 인 축은 에이전트 설정을 따른다.
/// [stale] 은 지정 뒤 에이전트의 하네스가 바뀌어 쓰지 않는 값이다 — 칩이 취소선으로 그린다.
class ThreadAgentModel {
  const ThreadAgentModel({
    required this.agentId,
    required this.model,
    required this.effort,
    required this.stale,
    this.currentHarness = '',
    this.setBy,
    this.setByKind = 'human',
  });

  final String agentId;

  /// 정한 계정(087). 지워졌으면 null.
  final String? setBy;

  /// `human` | `agent`(087). 옛 서버는 싣지 않는다 — 사람 지정으로 읽는다(그 서버에는 에이전트 지정이 없다).
  final String setByKind;
  /// 에이전트의 **지금** 하네스 — 무효 안내("하네스가 X 로 바뀌어…")의 재료.
  final String currentHarness;
  final String? model;
  final String? effort;
  final bool stale;

  factory ThreadAgentModel.fromJson(Map<String, Object?> j) => ThreadAgentModel(
        agentId: _str(j['agentId']),
        model: j['model'] is String ? j['model'] as String : null,
        effort: j['effort'] is String ? j['effort'] as String : null,
        stale: j['stale'] == true,
        currentHarness: _str(j['currentHarness']),
        setBy: j['setBy'] is String ? j['setBy'] as String : null,
        setByKind: j['setByKind'] == 'agent' ? 'agent' : 'human',
      );
}

/// 하네스가 밝힌 모델 하나와 그 모델이 받는 effort(없으면 모른다).
class HarnessModelOption {
  const HarnessModelOption({required this.id, this.label, this.efforts});
  final String id;
  final String? label;
  final List<String>? efforts;
}

/// 칩 고르개의 재료(`GET /agents/:id/model-options`). [models] 가 null 이면 "모른다" —
/// 고르개는 직접 입력으로 물러선다.
class AgentModelOptions {
  const AgentModelOptions({this.model, this.effort, this.models});
  final String? model;
  final String? effort;
  final List<HarnessModelOption>? models;

  factory AgentModelOptions.fromJson(Map<String, Object?> j) {
    final raw = j['models'];
    return AgentModelOptions(
      model: j['model'] is String ? j['model'] as String : null,
      effort: j['effort'] is String ? j['effort'] as String : null,
      models: raw is List
          ? raw.whereType<Map>().map((m) {
              final e = m['efforts'];
              return HarnessModelOption(
                id: _str(m['id']),
                label: m['label'] is String ? m['label'] as String : null,
                efforts: e is List ? e.whereType<String>().toList(growable: false) : null,
              );
            }).toList(growable: false)
          : null,
    );
  }
}

/// 에이전트가 지금 도는 턴 하나(`GET /agent-sessions?scope=visible`, S7). 읽기 전용이라 세션 id 를 받지 않는다.
///
/// **옛 서버**(scope 를 모르는 0.3.153 이하)는 소유자·admin 목록을 옛 모양으로 준다 — `owned` 가 없으면
/// 그 목록은 원래 내 것만이므로 참으로 읽는다.
class AgentActivity {
  const AgentActivity({
    required this.agentAccountId,
    required this.channelId,
    required this.threadRootId,
    required this.harness,
    required this.startedAt,
    required this.owned,
  });

  final String agentAccountId;
  final String channelId;
  final String? threadRootId;
  final String harness;
  final DateTime? startedAt;
  final bool owned;

  static AgentActivity fromJson(Map<String, Object?> j) => AgentActivity(
        agentAccountId: _str(j['agentAccountId']),
        channelId: _str(j['channelId']),
        threadRootId: j['threadRootId'] is String ? j['threadRootId'] as String : null,
        harness: _str(j['harness']),
        startedAt: j['startedAt'] is String ? DateTime.tryParse(j['startedAt'] as String) : null,
        owned: j['owned'] is bool ? j['owned'] as bool : true,
      );
}

/// 에이전트가 스스로 걸어 둔 다음 깨움(`GET /agent-wakes?scope=visible`).
class AgentWake {
  const AgentWake({
    required this.agentAccountId,
    required this.channelId,
    required this.threadRootId,
    required this.wakeAt,
    required this.reason,
  });

  final String agentAccountId;
  final String channelId;
  final String threadRootId;
  final DateTime? wakeAt;

  /// wake 메시지 본문. 지워졌으면 null.
  final String? reason;

  static AgentWake fromJson(Map<String, Object?> j) => AgentWake(
        agentAccountId: _str(j['agentAccountId']),
        channelId: _str(j['channelId']),
        threadRootId: _str(j['threadRootId']),
        wakeAt: j['wakeAt'] is String ? DateTime.tryParse(j['wakeAt'] as String) : null,
        reason: j['reason'] is String ? j['reason'] as String : null,
      );
}
