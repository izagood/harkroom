/// 앱 상태 **한 곳**. 데스크탑의 `state/controller.ts` 가 하는 일의 P0 분량이다.
///
/// ## 왜 한 곳인가
///
/// 같은 사실이 두 곳에 살면 둘은 갈라진다. 특히 여기서는 **소켓 이벤트와 REST 응답이
/// 같은 것을 말한다** — 메시지를 올리면 POST 응답으로 한 번, `message.created` 로 또 한
/// 번 온다. 그 둘이 다른 곳에 쌓이면 말풍선이 두 개가 되거나, 하나가 사라진다.
///
/// 그래서 **들어오는 길이 몇 개든 쌓이는 곳은 하나**이고, 중복은 `seq` 로 가려낸다.
///
/// 상태 관리 라이브러리를 고르지 않았다(계획서 §10) — P0 의 화면 수로는 근거 없이 고르게
/// 된다. `ChangeNotifier` 로 시작하고 P1 에서 되돌아본다.
library;


import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/api_error.dart';
import '../api/models.dart';
import '../api/ws.dart';
import '../api/ws_socket.dart';
import '../session/session_store.dart';

/// 앱이 지금 어느 단계에 있나. 화면 하나가 이것만 보고 무엇을 그릴지 정한다.
enum AppPhase {
  /// 보관된 세션을 읽는 중. **키체인 접근은 느릴 수 있다**(사람이 승인해야 할 때가 있다).
  booting,

  /// 붙을 서버를 아직 모른다.
  needsServer,

  /// 서버는 알지만 로그인하지 않았다.
  needsLogin,

  /// 들어왔다.
  ready,
}

/// 소켓이 지금 어떤가. **끊김을 한 가지로 뭉치지 않는다** — 기다리면 낫는 것과 그렇지
/// 않은 것을 화면이 다르게 말해야 한다(`ws.dart` 의 같은 판단).
///
/// 이름이 `ConnectionState` 가 **아닌** 이유: 그 이름은 Flutter 의 `AsyncSnapshot` 쪽에
/// 이미 있다. 같은 이름을 쓰면 `material.dart` 를 import 한 화면마다 충돌하고, 해결책이
/// `as prefix` 뿐이라 부르는 자리가 전부 지저분해진다.
enum SocketState { connecting, online, reconnecting, dead }

class AppState extends ChangeNotifier {
  AppState({
    required SessionStore sessions,
    ApiClient Function(String baseUrl, String? token)? apiFactory,
    WsConnector? connector,
  })  : _sessions = sessions,
        _apiFactory = apiFactory ?? ((b, t) => ApiClient(baseUrl: b, token: t)),
        _connector = connector ?? RealWsConnection.connect;

  final SessionStore _sessions;
  final ApiClient Function(String baseUrl, String? token) _apiFactory;
  final WsConnector _connector;

  AppPhase phase = AppPhase.booting;
  SocketState connection = SocketState.connecting;

  /// 사람 앞에 한 번 세우고 지우는 말(세션 저장 실패 등). **i18n 키**를 담는다 —
  /// 상태가 문장을 짓지 않는다.
  String? noticeKey;

  String? baseUrl;
  MeView? me;

  ApiClient? _api;
  WsClient? _ws;

  final List<ChannelRow> channels = [];
  final Map<String, AccountView> accounts = {};

  /// 나를 부른 것들(새것 먼저). 서버가 준 순서를 뒤집지 않는다.
  final List<InboxEntry> inbox = [];

  /// 아직 안 본 부름의 수. 탭 배지가 읽는다.
  int get inboxUnread => inbox.where((e) => e.isUnread).length;

  /// 채널 id → 읽음 위치와 안 읽은 수. **서버가 센다** — 클라이언트가 세면 열지 않은
  /// 채널에서 틀린다.
  final Map<String, ReadState> reads = {};

  /// 채널 id → 그 채널에서 읽어 둔 메시지(오름차순, `seq` 로 유일).
  final Map<String, List<MessageRow>> messages = {};

  /// 지금 열려 있는 채널. 소켓 이벤트를 받아도 **열지 않은 채널은 쌓지 않는다** —
  /// 안 본 채널까지 메모리에 들고 있을 이유가 없다(읽지 않은 수는 서버가 센다).
  String? openChannelId;

  ApiClient? get api => _api;

  /// 작성자 id 를 이름으로 푼다. **모르는 id 는 id 를 그대로 보여 준다** — 빈칸을 두면
  /// 말풍선에 작성자가 없어지고, 사람은 누가 말했는지 알 수 없다.
  String displayNameOf(String accountId) =>
      accounts[accountId]?.displayName ?? accounts[accountId]?.handle ?? accountId;

  // ── 부팅 ──────────────────────────────────────────────────────────────

  Future<void> boot() async {
    final stored = await _sessions.load();
    final current = stored?.current;
    if (current == null || current.token.isEmpty) {
      phase = stored?.communities.isNotEmpty == true ? AppPhase.needsLogin : AppPhase.needsServer;
      baseUrl = current?.baseUrl;
      notifyListeners();
      return;
    }
    baseUrl = current.baseUrl;
    _api = _apiFactory(current.baseUrl, current.token);
    await _enter();
  }

  /// 연결 화면이 주소를 확정했다. 아직 로그인은 아니다.
  void setServer(String url) {
    baseUrl = url;
    _api = _apiFactory(url, null);
    phase = AppPhase.needsLogin;
    notifyListeners();
  }

  /// 로그인하고 세션을 보관한다.
  ///
  /// 보관에 실패해도 **로그인을 막지 않는다** — 이번 실행은 메모리의 토큰으로 돈다.
  /// 대신 [noticeKey] 로 사람에게 말한다: 다음 기동에 다시 로그인해야 한다는 것을
  /// 그때 가서 이유 없이 겪게 두지 않는다.
  Future<void> login(String loginId, String password) async {
    final api = _api;
    if (api == null || baseUrl == null) throw StateError('서버 주소가 없다');
    final token = await api.login(loginId, password);
    api.token = token;
    final who = await api.me();

    try {
      await _sessions.upsert(StoredCommunity(
        accountId: who.id,
        baseUrl: baseUrl!,
        token: token,
        handle: who.handle,
      ));
    } on SessionSaveFailure {
      noticeKey = 'noticeSessionNotSaved';
    }
    me = who;
    await _enter();
  }

  /// 목록을 채우고 소켓을 연다.
  Future<void> _enter() async {
    final api = _api!;
    try {
      me ??= await api.me();
      final results = await Future.wait([api.channels(), api.accounts(), api.reads()]);
      channels
        ..clear()
        ..addAll(results[0] as List<ChannelRow>);
      accounts
        ..clear()
        ..addEntries((results[1] as List<AccountView>).map((a) => MapEntry(a.id, a)));
      reads
        ..clear()
        ..addEntries((results[2] as List<ReadState>).map((r) => MapEntry(r.channelId, r)));
    } on ApiError catch (e) {
      // 토큰이 죽었다. **보관본을 지우고** 로그인으로 돌린다 — 안 지우면 다음 기동에
      // 같은 실패를 반복한다.
      if (e.isCredentialFailure) {
        await _sessions.clear();
        _api = _apiFactory(baseUrl!, null);
        phase = AppPhase.needsLogin;
        notifyListeners();
        return;
      }
      rethrow;
    }
    phase = AppPhase.ready;
    notifyListeners();
    _openSocket();
    // 부팅을 막지 않는다 — 채널 목록이 먼저 서고 받은 것은 뒤따라 온다.
    unawaited(loadInbox());
  }

  void _openSocket() {
    _ws?.close();
    connection = SocketState.connecting;
    _ws = WsClient(
      baseUrl: baseUrl!,
      getTicket: () => _api!.wsTicket(),
      connect: _connector,
      onOpen: () {
        connection = SocketState.online;
        notifyListeners();
      },
      onDown: (reason) {
        connection =
            reason == WsDownReason.network ? SocketState.reconnecting : SocketState.dead;
        notifyListeners();
      },
      onEvent: applyEvent,
    );
    unawaited(_ws!.start());
  }

  // ── 이벤트 ────────────────────────────────────────────────────────────

  /// 소켓 이벤트를 상태에 반영한다. **모르는 `type` 은 조용히 지나간다** — 서버가 이벤트를
  /// 하나 더하는 날 옛 앱이 죽지 않게. 시험이 이 함수를 직접 부른다.
  @visibleForTesting
  void applyEvent(Map<String, Object?> event) {
    switch (event['type']) {
      case 'message.created':
      case 'message.updated':
        final raw = event['message'];
        if (raw is! Map) return;
        _upsertMessage(MessageRow.fromJson(Map<String, Object?>.from(raw)));
      case 'message.deleted':
        final channelId = event['channelId'];
        final messageId = event['messageId'];
        if (channelId is! String || messageId is! String) return;
        messages[channelId]?.removeWhere((m) => m.id == messageId);
        notifyListeners();
      case 'inbox.updated':
        // 서버는 "바뀌었다"만 알린다 — 무엇이 바뀌었는지는 싣지 않는다. 한 건을
        // 끼워 넣으면 그 사이 다른 기기에서 읽은 것이 화면에서 되살아나므로,
        // **목록을 다시 읽는다**(데스크탑의 같은 판단).
        unawaited(loadInbox());
      case 'reaction.added':
      case 'reaction.removed':
        _applyReactionDelta(event);
      case 'account.handle_changed':
        final id = event['accountId'];
        final handle = event['newHandle'];
        if (id is! String || handle is! String) return;
        final existing = accounts[id];
        if (existing == null) return;
        accounts[id] = AccountView(
          id: existing.id,
          handle: handle,
          displayName: existing.displayName,
          isAgent: existing.isAgent,
          isDisabled: existing.isDisabled,
          avatarAttachmentId: existing.avatarAttachmentId,
        );
        notifyListeners();
      default:
      // 모르는 이벤트. 무시한다.
    }
  }

  /// 리액션은 **델타로 온다** — 메시지 전체를 다시 싣지 않는다. 한 번 누를 때마다
  /// 본문이 오가는 것을 막으려는 서버의 결정이고, 받는 쪽도 그 모양대로 고쳐야 한다.
  ///
  /// 모르는 메시지의 델타는 **버린다.** 그 메시지를 나중에 읽을 때 서버가 리액션을
  /// 함께 주므로, 여기서 빈 자리를 만들어 둘 이유가 없다.
  void _applyReactionDelta(Map<String, Object?> event) {
    final channelId = event['channelId'];
    final messageId = event['messageId'];
    final emoji = event['emoji'];
    final accountId = event['accountId'];
    if (channelId is! String || messageId is! String || emoji is! String || accountId is! String) {
      return;
    }
    final added = event['type'] == 'reaction.added';

    for (final list in [messages[channelId], ...threads.values]) {
      if (list == null) continue;
      final idx = list.indexWhere((m) => m.id == messageId);
      if (idx < 0) continue;
      list[idx] = list[idx].withReaction(emoji: emoji, accountId: accountId, added: added);
      notifyListeners();
    }
  }

  /// 같은 메시지가 두 번 와도 한 줄로 남는다.
  ///
  /// 두 번 오는 것은 **정상 경로**다: 내가 올린 메시지는 POST 응답으로 한 번, 소켓으로 또
  /// 한 번 온다. 재연결 직후에도 겹칠 수 있다. `seq` 가 채널 안에서 유일하므로 그것으로
  /// 가려내고, 이미 있으면 **덮어쓴다**(수정·리액션이 그 경로로 온다).
  void _upsertMessage(MessageRow message) {
    // 스레드 답글이면 그 스레드에도 넣는다. **둘 다 갱신해야 한다** — 채널 화면의
    // 요약(답글 수)과 열려 있는 스레드가 같은 사실을 봐야 하기 때문이다.
    final rootId = message.threadRootId;
    if (rootId != null) {
      final replies = threads[rootId];
      if (replies != null) {
        final at = replies.indexWhere((m) => m.seq == message.seq);
        if (at >= 0) {
          replies[at] = message;
        } else {
          replies.add(message);
          replies.sort((a, b) => a.seq.compareTo(b.seq));
        }
        notifyListeners();
      }
    }

    // 열지 않은 채널은 쌓지 않는다 — 열 때 서버에서 읽는다.
    final list = messages[message.channelId];
    if (list == null) return;

    final idx = list.indexWhere((m) => m.seq == message.seq);
    if (idx >= 0) {
      list[idx] = message;
    } else {
      list.add(message);
      // 소켓은 순서를 보장하지만 재연결 직후에는 섞일 수 있다. 꼬리만 보고 넣으므로
      // 대부분 이 정렬은 공짜다.
      list.sort((a, b) => a.seq.compareTo(b.seq));
    }
    notifyListeners();
  }

  // ── 받은 것 ───────────────────────────────────────────────────────────

  Future<void> loadInbox() async {
    final api = _api;
    if (api == null) return;
    final entries = await api.inbox();
    inbox
      ..clear()
      ..addAll(entries);
    notifyListeners();
  }

  /// 한 줄을 읽음으로 만든다.
  ///
  /// **화면을 먼저 고친다** — 눌렀는데 배지가 그대로면 사람은 안 눌린 줄 알고 다시
  /// 누른다. 실패해도 되돌리지 않는다: 사람은 이미 봤고, 되살아나는 배지가 더 이상하다.
  Future<void> markInboxRead(List<int> ids) async {
    if (ids.isEmpty) return;
    final now = DateTime.now().toUtc().toIso8601String();
    for (var i = 0; i < inbox.length; i += 1) {
      final e = inbox[i];
      if (!ids.contains(e.id) || !e.isUnread) continue;
      inbox[i] = InboxEntry(
        id: e.id,
        messageId: e.messageId,
        reason: e.reason,
        channelId: e.channelId,
        authorId: e.authorId,
        body: e.body,
        createdAt: e.createdAt,
        threadRootId: e.threadRootId,
        readAt: now,
      );
    }
    notifyListeners();
    try {
      await _api!.markInboxRead(ids);
    } on Object {
      // 다음 `loadInbox` 가 서버의 사실로 덮는다.
    }
  }

  // ── 채널 ──────────────────────────────────────────────────────────────

  /// 채널을 연다. 이미 읽어 둔 것이 있으면 **다시 읽지 않는다** — 소켓이 그 뒤를 잇는다.
  Future<void> openChannel(String channelId) async {
    openChannelId = channelId;
    if (messages.containsKey(channelId)) {
      notifyListeners();
      return;
    }
    messages[channelId] = [];
    notifyListeners();
    final page = await _api!.messages(channelId, limit: 50);
    messages[channelId] = [...page.messages]..sort((a, b) => a.seq.compareTo(b.seq));
    notifyListeners();
    await markRead(channelId);
  }

  /// 이모지를 누르거나 뗀다.
  ///
  /// **화면을 먼저 고치지 않는다**(낙관적 갱신을 하지 않는다). 리액션은 서버가 델타를
  /// 되쏘아 주므로 그것으로 화면이 선다 — 미리 고치면 실패했을 때 되돌릴 자리가
  /// 생기고, 되돌리는 코드는 거의 시험되지 않는다.
  Future<void> toggleReaction(String channelId, String messageId, String emoji) async {
    final mine = me?.id;
    if (mine == null) return;
    final message = _findMessage(channelId, messageId);
    final pressed = message?.reactions
            .any((r) => r.emoji == emoji && r.accountIds.contains(mine)) ??
        false;
    if (pressed) {
      await _api!.removeReaction(channelId, messageId, emoji);
    } else {
      await _api!.addReaction(channelId, messageId, emoji);
    }
  }

  MessageRow? _findMessage(String channelId, String messageId) {
    for (final list in [messages[channelId], ...threads.values]) {
      if (list == null) continue;
      for (final m in list) {
        if (m.id == messageId) return m;
      }
    }
    return null;
  }

  /// 여기까지 읽었다고 알린다. **화면이 그 채널을 보고 있을 때만** 부른다.
  ///
  /// 안 읽은 수를 화면에서 먼저 0 으로 만든다 — 서버 왕복을 기다리면 사람이 채널을
  /// 열었는데 배지가 남아 있고, 그건 "안 읽은 것이 또 있나" 로 읽힌다.
  Future<void> markRead(String channelId) async {
    final list = messages[channelId];
    if (list == null || list.isEmpty) return;
    final last = list.last.seq;
    final current = reads[channelId];
    if (current != null && current.lastReadSeq >= last) return;
    reads[channelId] = ReadState(channelId: channelId, lastReadSeq: last, unread: 0);
    notifyListeners();
    try {
      await _api!.markRead(channelId, last);
    } on Object {
      // 못 알렸으면 다음에 다시 알린다. 화면을 되돌리지는 않는다 — 사람은 이미 읽었고,
      // 배지가 다시 살아나는 것이 더 이상하다.
    }
  }

  void closeChannel() {
    openChannelId = null;
    notifyListeners();
  }

  /// 말한다. 멘션이 들어 있으면 **이것이 에이전트를 부르는 것**이다.
  ///
  /// [threadRootId] 를 주면 그 스레드의 답글이 된다. 붙여 둔 첨부가 있으면 함께 간다.
  Future<void> send(String channelId, String body, {String? threadRootId}) async {
    final key = threadRootId ?? channelId;
    final ids = (pending[key] ?? const <PendingAttachment>[])
        .where((p) => p.attachment != null)
        .map((p) => p.attachment!.id)
        .toList(growable: false);
    // **올리는 중인 것이 남아 있으면 보내지 않는다.** 보내 버리면 그 파일은 메시지에
    // 안 붙고, 사람은 붙였다고 믿는다.
    if ((pending[key] ?? const <PendingAttachment>[]).any((p) => p.attachment == null)) {
      return;
    }
    final sent = await _api!.postMessage(
      channelId,
      body,
      threadRootId: threadRootId,
      attachmentIds: ids,
    );
    pending.remove(key);
    _upsertMessage(sent);
  }

  // ── 붙여 둔 첨부 ──────────────────────────────────────────────────────

  /// 작성칸 키(채널 id 또는 스레드 루트 id) → 아직 안 보낸 첨부들.
  ///
  /// **채널과 스레드가 따로다.** 둘이 한 목록을 쓰면 채널에서 고른 사진이 스레드 답글에
  /// 딸려 간다 — 사람은 그것을 보내고 나서야 안다.
  final Map<String, List<PendingAttachment>> pending = {};

  /// 파일을 고르자마자 **먼저 올린다.**
  ///
  /// 보낼 때 몰아서 올리지 않는 이유: 그러면 보내기 버튼이 몇 초씩 멈추고, 그 동안
  /// 실패하면 사람은 **친 글까지 잃는다.** 미리 올려 두면 보내기는 id 만 싣는다.
  Future<void> attach(String key, PendingAttachment item, Uint8List bytes) async {
    final list = pending.putIfAbsent(key, () => []);
    list.add(item);
    notifyListeners();
    try {
      final row = await _api!.upload(
        bytes,
        item.filename,
        contentType: item.contentType,
        onProgress: (f) {
          item.progress = f;
          notifyListeners();
        },
      );
      item.attachment = row;
    } on Object {
      // 실패한 것은 **목록에서 뺀다.** 남겨 두면 보내기가 영원히 막힌다(위 가드).
      list.remove(item);
      rethrow;
    } finally {
      notifyListeners();
    }
  }

  void detach(String key, PendingAttachment item) {
    pending[key]?.remove(item);
    if (pending[key]?.isEmpty ?? false) pending.remove(key);
    notifyListeners();
  }

  // ── 스레드 ────────────────────────────────────────────────────────────

  /// 스레드 루트 id → 그 답글들(오름차순).
  ///
  /// 채널 목록과 **따로 둔다**: 채널에는 루트만 실리고 답글은 스레드를 열 때 읽는다.
  /// 한 곳에 섞으면 채널 화면이 답글까지 그리게 되고, 그건 스레드를 만든 이유를 지운다.
  final Map<String, List<MessageRow>> threads = {};

  /// 스레드를 연다.
  ///
  /// **첫 `await` 전에 `notifyListeners()` 를 부르지 않는다.** 이 함수를 부르는 자리는
  /// 화면의 `didChangeDependencies` 이고 그때는 **빌드 중**이다 — 거기서 알리면
  /// *"setState() called during build"* 로 죽는다. 시험이 잡았고, 실기기였으면 스레드를
  /// 처음 여는 순간 빨간 화면이었다.
  ///
  /// 알리지 않아도 손해가 없다: 화면은 `threads[rootId] ?? []` 를 읽으므로 빈 목록이
  /// 그려지고, 답글이 도착하면 아래에서 알린다.
  Future<void> openThread(String channelId, String rootId) async {
    threads.putIfAbsent(rootId, () => []);
    final page = await _api!.messages(channelId, thread: rootId, limit: 100);
    threads[rootId] = [...page.messages]..sort((a, b) => a.seq.compareTo(b.seq));
    notifyListeners();
  }

  // ── 선택 요청 ─────────────────────────────────────────────────────────

  /// 선택지를 고른다. 돌아온 메시지로 **그 자리를 덮어쓴다** — 버튼이 사라지고 고른
  /// 것이 남는다. 누른 뒤에도 버튼이 있으면 사람은 자기가 누른 것을 의심한다.
  Future<void> answerAsk(String channelId, String messageId, String optionId) async {
    _upsertMessage(await _api!.answerAsk(channelId, messageId, optionId));
  }

  /// 답하지 않기로 한다.
  Future<void> closeAsk(String channelId, String messageId) async {
    _upsertMessage(await _api!.closeAsk(channelId, messageId));
  }

  void clearNotice() {
    noticeKey = null;
    notifyListeners();
  }

  /// 로그아웃. 보관본을 지우고 소켓을 닫는다.
  Future<void> signOut() async {
    await _ws?.close();
    _ws = null;
    await _sessions.clear();
    me = null;
    inbox.clear();
    reads.clear();
    threads.clear();
    channels.clear();
    accounts.clear();
    messages.clear();
    openChannelId = null;
    _api = baseUrl == null ? null : _apiFactory(baseUrl!, null);
    phase = baseUrl == null ? AppPhase.needsServer : AppPhase.needsLogin;
    notifyListeners();
  }

  @override
  void dispose() {
    _ws?.close();
    _api?.close();
    super.dispose();
  }
}

/// `unawaited` 를 위해. `dart:async` 를 통째로 들이지 않는다.
void unawaited(Future<void> future) {
  future.catchError((Object _) {
    // 소켓 루프의 실패는 `onDown` 으로 이미 화면에 닿는다. 여기서 다시 던지면
    // 잡는 사람이 없어 앱이 죽는다.
  });
}


/// 아직 안 보낸 첨부 하나.
///
/// `attachment` 가 `null` 인 동안은 **올리는 중**이다. 그 상태로 메시지를 보내면 파일이
/// 안 붙으므로 [AppState.send] 가 막는다.
class PendingAttachment {
  PendingAttachment({required this.filename, this.contentType});

  final String filename;
  final String? contentType;

  /// 0~1. 총 길이를 모르면 올라가지 않는다 — **가짜 비율을 그리지 않는다.**
  double progress = 0;

  /// 올리기가 끝나면 채워진다.
  AttachmentRow? attachment;
}
