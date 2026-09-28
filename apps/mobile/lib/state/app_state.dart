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
      final results = await Future.wait([api.channels(), api.accounts()]);
      channels
        ..clear()
        ..addAll(results[0] as List<ChannelRow>);
      accounts
        ..clear()
        ..addEntries((results[1] as List<AccountView>).map((a) => MapEntry(a.id, a)));
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
  }

  void closeChannel() {
    openChannelId = null;
    notifyListeners();
  }

  /// 말한다. 멘션이 들어 있으면 **이것이 에이전트를 부르는 것**이다.
  ///
  /// [threadRootId] 를 주면 그 스레드의 답글이 된다.
  Future<void> send(String channelId, String body, {String? threadRootId}) async {
    final sent = await _api!.postMessage(channelId, body, threadRootId: threadRootId);
    _upsertMessage(sent);
  }

  // ── 스레드 ────────────────────────────────────────────────────────────

  /// 스레드 루트 id → 그 답글들(오름차순).
  ///
  /// 채널 목록과 **따로 둔다**: 채널에는 루트만 실리고 답글은 스레드를 열 때 읽는다.
  /// 한 곳에 섞으면 채널 화면이 답글까지 그리게 되고, 그건 스레드를 만든 이유를 지운다.
  final Map<String, List<MessageRow>> threads = {};

  Future<void> openThread(String channelId, String rootId) async {
    if (!threads.containsKey(rootId)) {
      threads[rootId] = [];
      notifyListeners();
    }
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
