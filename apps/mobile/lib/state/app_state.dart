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
import '../mention/sticky.dart';
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

  /// 보관된 세션은 있는데 **서버에 닿지 못했다**(네트워크·서버 다운). 자격증명이 죽은 것이
  /// 아니므로 로그인으로 돌리지 않는다 — 사람에게 "다시 시도"를 준다.
  ///
  /// 이 단계가 없을 때는 부팅 화면의 회전자가 **영원히 돌았다**: `_enter` 가 던진 오류를
  /// 아무도 받지 않아 단계가 `booting` 에 남았다(지하철에서 앱을 켜면 그대로 멈춘 앱이다).
  unreachable,
}

/// 한 화면 분량을 읽는 상태. **셋을 한 문구로 뭉치지 않는다** — 읽는 중·비어 있음·못 읽음은
/// 사람이 할 일이 다르다(기다린다 / 첫 말을 건넨다 / 다시 시도한다). 전에는 셋 다
/// "아직 … 없습니다" 였고, 못 읽은 채널은 다시 읽을 길도 없었다.
enum LoadState { loading, loaded, failed }

/// 못 읽은 **까닭**. 문구가 사람을 엉뚱한 곳으로 보내지 않게 가른다 — 서버가 5xx 를 줬는데
/// "네트워크를 확인하라"고 하면 사람은 와이파이를 껐다 켠다(designer #977 권장).
enum LoadFailure {
  /// 서버에 닿지 못했다.
  network,

  /// 서버가 답했지만 실패다(5xx 등).
  server,

  /// 볼 권한이 없다(403·404). 다시 시도해도 낫지 않는다.
  forbidden;

  static LoadFailure of(Object error) => switch (error) {
        ApiError(status: 403 || 404) => LoadFailure.forbidden,
        ApiError() => LoadFailure.server,
        _ => LoadFailure.network,
      };
}

/// 보내지 못한 말. **작성칸으로 되돌리지 않고** 목록 안에 남긴다(재설계 §3.9) — 작성칸에
/// 되돌리면 사람이 그 사이 새로 친 글과 섞이고, 무엇이 안 갔는지가 화면에서 사라진다.
class FailedSend {
  FailedSend({
    required this.localId,
    required this.channelId,
    required this.body,
    required this.attachmentIds,
    this.threadRootId,
    this.agentModels = const [],
  });

  /// 화면이 줄을 집는 열쇠. 서버 id 가 없으니 앱이 짓는다.
  final String localId;
  final String channelId;
  final String? threadRootId;
  final String body;
  final List<String> attachmentIds;

  /// 이 글과 함께 갈 모델 지정(서버 079). 다시 보낼 때도 같이 간다 — 빠지면 고른 모델이 아니라
  /// 기본값으로 턴이 돈다.
  final List<Map<String, Object?>> agentModels;

  /// 다시 보내는 중이면 버튼을 잠근다 — 두 번 누르면 두 번 간다.
  bool retrying = false;
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

  /// 채널 id → 그 채널을 읽는 상태. 없으면 아직 연 적이 없다.
  final Map<String, LoadState> channelLoad = {};

  /// 채널 id → 서버에 더 오래된 메시지가 남아 있는가(첫 페이지의 `hasMore`, 이전 페이지마다 갱신).
  final Map<String, bool> channelHasMore = {};

  /// 채널 id → 이전 페이지를 받는 중인가. 두 번 겹쳐 받지 않는다.
  final Set<String> loadingOlder = {};

  /// 채널 id → 이전 페이지를 못 받았다. 이 채널은 **스크롤로는 다시 부르지 않는다** — 화면이
  /// "다시 시도" 줄을 세우고, 사람이 누를 때만 [retryOlder] 로 다시 간다. 스크롤마다 다시 부르면
  /// 서버가 아플 때 요청이 거듭 간다(security #996).
  final Set<String> olderFailed = {};

  /// 세션 세대. 로그인·로그아웃·다시 들어오기마다 올린다. 받는 데 걸린 사이에 계정이 바뀌면
  /// **그 응답을 버린다** — 안 버리면 옛 계정의 말이 새 계정 화면에 섞인다(security #996).
  int _generation = 0;

  /// 스레드 루트 id → 그 스레드를 읽는 상태.
  final Map<String, LoadState> threadLoad = {};

  /// 인박스를 읽는 상태.
  LoadState inboxLoad = LoadState.loading;

  /// 못 읽은 까닭. 열쇠는 채널 id · 스레드 루트 id · `'inbox'` 다.
  final Map<String, LoadFailure> failures = {};

  /// 작성칸 키(채널 id 또는 스레드 루트 id) → 보내지 못한 말들(오래된 것 먼저).
  final Map<String, List<FailedSend>> failedSends = {};

  /// 작성칸 키(채널 id 또는 스레드 루트 id) → 고정 멘션(**계정 id**, 부른 순서).
  ///
  /// 한 번 부른 상대는 그 작성칸의 다음 줄부터 저절로 불린다(`lib/mention/sticky.dart`).
  /// 화면(`State`)이 아니라 여기 두는 이유: 스레드 화면은 나가면 통째로 버려진다 — 거기 두면
  /// 스레드를 한 번 나갔다 오는 것만으로 칩이 사라지고, 사람은 부르던 줄 알고 보낸 글이
  /// 아무도 깨우지 않는다(데스크탑 #706 이 겪은 것). 앱을 껐다 켜면 비는 것은 작성칸 글과 같다.
  final Map<String, List<String>> stickyMentions = {};

  /// 이 작성칸이 지금 부를 고정 상대. 비활성·지워진 계정과 나는 뺀다(저장본은 그대로 둔다).
  List<AccountView> stickyAccounts(String key) =>
      liveStickyAccounts(stickyMentions[key] ?? const [], accounts, myId: me?.id);

  /// 방금 보낸 글([typed] — 사람이 친 글)에서 새로 부른 상대를 고정에 더한다.
  void keepStickyMentions(String key, String typed) {
    final cur = stickyMentions[key] ?? const <String>[];
    final next = keepMentioned(cur, typed, accounts.values, myId: me?.id);
    if (identical(next, cur)) return;
    stickyMentions[key] = next;
    notifyListeners();
  }

  /// "이 채널의 에이전트"(`available`) 칩을 눌렀다 — 그 상대를 고정한다. 그때부터는 사람이
  /// `@` 로 부른 것과 구분되지 않는다(데스크탑 `callChannelAgent` 와 같다: 부른 것은 사람이다).
  void pinStickyMention(String key, String accountId) {
    final cur = stickyMentions[key] ?? const <String>[];
    if (cur.contains(accountId)) return;
    stickyMentions[key] = [...cur, accountId];
    notifyListeners();
  }

  // ── 채널 자동 멘션(#173) ───────────────────────────────────────────────

  /// 채널 id → 자동 멘션 행. 키가 없으면 아직 못 받았다(그동안은 자동 멘션 없이 보낸다).
  final Map<String, List<ChannelAutoMention>> channelAutoMentions = {};

  /// 작성칸 키 → **이번 글에서만** 뺀 자동 멘션(계정 id). 보내면 비운다 — 다음 글에는 다시 붙는다.
  /// 설정을 지우는 것이 아니다: 설정은 admin 의 것이고, 사람에게 필요한 것은 "이 한 줄은 안 부르기"다.
  final Map<String, Set<String>> autoSkipped = {};

  /// 자동 멘션을 읽는다. 바뀌어도 소켓 이벤트가 없으므로 **채널을 열 때마다** 다시 읽는다(데스크탑도
  /// 채널을 열 때 읽는다). 실패는 삼킨다 — 칩이 안 설 뿐 작성칸은 돈다.
  Future<void> loadChannelAutoMentions(String channelId) async {
    try {
      channelAutoMentions[channelId] = await _api!.channelAutoMentions(channelId);
      notifyListeners();
    } on Object {
      // 끊김·권한. 앞에 받은 것이 있으면 그대로 둔다.
    }
  }

  /// 지금 깨울 수 있는 자동 멘션 상대. 비활성·지워진 계정과 나는 뺀다 — 깨어나지 못하는 상대를 매
  /// 줄에 붙이면 죽은 handle 만 남는다(데스크탑 `liveAutoRows`).
  List<AccountView> _liveAuto(String channelId, {required bool always}) => [
        for (final r in channelAutoMentions[channelId] ?? const <ChannelAutoMention>[])
          if (r.isAlways == always)
            if (accounts[r.agentAccountId] case final a? when !a.isDisabled && a.id != me?.id) a,
      ];

  /// 이 작성칸의 글에 실제로 붙을 자동 멘션(`always` 에서 이번만 뺀 것을 제한 것).
  List<AccountView> autoAccounts(String channelId, String key) {
    final skipped = autoSkipped[key] ?? const <String>{};
    return [for (final a in _liveAuto(channelId, always: true)) if (!skipped.contains(a.id)) a];
  }

  /// 이 작성칸의 고정 칩. **자동 멘션(`always`) 상대는 뺀다** — 같은 상대에 칩이 둘 서면 × 하나로
  /// 어느 쪽이 빠지는지 알 수 없다. 자동 칩이 그 자리를 대신한다(데스크탑 `sticky` 와 같다).
  /// 이번만 뺀 자동 상대도 고정 칩으로 되살아나지 않는다 — 되살아나면 × 가 듣지 않는 것처럼 보인다.
  List<AccountView> composerSticky(String channelId, String key) {
    final auto = {for (final a in _liveAuto(channelId, always: true)) a.id};
    return [for (final a in stickyAccounts(key)) if (!auto.contains(a.id)) a];
  }

  /// "이 채널의 에이전트"(`available`) 중 아직 부르고 있지 않은 상대 — 누르면 고정된다.
  List<AccountView> availableAccounts(String channelId, String key) {
    final stuck = {for (final a in stickyAccounts(key)) a.id};
    return [for (final a in _liveAuto(channelId, always: false)) if (!stuck.contains(a.id)) a];
  }

  /// 보낼 때 본문 앞에 붙일 handle — 자동이 먼저, 고정이 뒤(데스크탑 `[...autoActive, ...sticky]`).
  List<String> composerPrefix(String channelId, String key) => [
        for (final a in [...autoAccounts(channelId, key), ...composerSticky(channelId, key)])
          a.handle.toLowerCase(),
      ];

  /// 자동 칩의 × — 이번 글에서만 뺀다.
  void skipAutoOnce(String key, String accountId) {
    (autoSkipped[key] ??= <String>{}).add(accountId);
    notifyListeners();
  }

  /// 보냈다 — 이번만 뺀 자동 멘션은 이 글로 끝이다.
  void clearAutoSkips(String key) {
    if (autoSkipped.remove(key) != null) notifyListeners();
  }

  /// 칩의 × — 이 상대를 그만 부른다.
  void dropStickyMention(String key, String accountId) {
    final cur = stickyMentions[key];
    if (cur == null || !cur.contains(accountId)) return;
    final next = cur.where((id) => id != accountId).toList(growable: false);
    if (next.isEmpty) {
      stickyMentions.remove(key);
    } else {
      stickyMentions[key] = next;
    }
    notifyListeners();
  }
  int _localSeq = 0;

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

  /// 닿지 못해 멈춘 부팅을 다시 해 본다.
  Future<void> retryBoot() async {
    if (_api == null) return;
    phase = AppPhase.booting;
    notifyListeners();
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
    _generation++;
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
      // 서버가 답은 했지만 실패다(5xx 등). 기다리면 나을 수 있으니 닿지 못한 것과 같이 둔다.
      phase = AppPhase.unreachable;
      notifyListeners();
      return;
    } on Object {
      // 서버에 닿지 못했다. **던지지 않는다** — 받을 사람이 없어 부팅 화면이 멈춘다.
      phase = AppPhase.unreachable;
      notifyListeners();
      return;
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
        final wasDown = connection == SocketState.reconnecting;
        connection = SocketState.online;
        notifyListeners();
        // **다시 붙으면 빠진 것을 읽는다.** 끊긴 사이의 이벤트는 서버가 다시 보내 주지
        // 않는다 — 안 읽으면 그 사이의 말이 영영 화면에 없다. 처음 붙을 때는 방금 읽었으므로
        // 하지 않는다.
        if (wasDown) unawaited(catchUp());
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

  /// 지금 다시 붙어 본다(끊김 띠의 "다시"). 백오프를 기다리지 않는다.
  void reconnectNow() {
    if (phase != AppPhase.ready) return;
    _openSocket();
    notifyListeners();
  }

  /// 끊긴 사이에 빠진 것을 다시 읽는다: 읽어 둔 채널은 마지막 `seq` 뒤부터, 열어 둔
  /// 스레드는 통째로, 그리고 안 읽은 수와 인박스.
  ///
  /// 하나가 실패해도 나머지는 읽는다 — 한 채널 때문에 인박스가 낡은 채로 남으면 안 된다.
  Future<void> catchUp() async {
    final api = _api;
    if (api == null) return;
    final gen = _generation;
    for (final entry in messages.entries.toList()) {
      final list = entry.value;
      if (list.isEmpty) continue;
      try {
        final page = await api.messages(entry.key, since: list.last.seq, limit: 200);
        if (gen != _generation) return;
        for (final m in page.messages) {
          _upsertMessage(m);
        }
      } on Object {
        // 다음에 다시 붙을 때 또 읽는다.
      }
    }
    for (final entry in threads.entries.toList()) {
      final channelId = _channelOfThread(entry.key);
      if (channelId == null) continue;
      try {
        final page = await api.messages(channelId, thread: entry.key, limit: 100);
        if (gen != _generation) return;
        threads[entry.key] = [...page.messages]..sort((a, b) => a.seq.compareTo(b.seq));
      } on Object {
        /* 위와 같다 */
      }
    }
    try {
      final fresh = await api.reads();
      reads
        ..clear()
        ..addEntries(fresh.map((r) => MapEntry(r.channelId, r)));
    } on Object {
      /* 위와 같다 */
    }
    notifyListeners();
    await loadInbox();
  }

  String? _channelOfThread(String rootId) {
    for (final entry in messages.entries) {
      for (final m in entry.value) {
        if (m.id == rootId) return entry.key;
      }
    }
    for (final list in threads.values) {
      for (final m in list) {
        if (m.id == rootId || m.threadRootId == rootId) return m.channelId;
      }
    }
    return null;
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
      case 'thread.agent_model.changed':
        final rootId = event['threadRootId'];
        final agentId = event['agentId'];
        if (rootId is! String || agentId is! String) return;
        final prev = threadAgentModels[rootId];
        if (prev == null) return;
        final rest = prev.where((r) => r.agentId != agentId).toList();
        final row = event['row'];
        if (row is Map) rest.add(ThreadAgentModel.fromJson(Map<String, Object?>.from(row)));
        threadAgentModels[rootId] = rest;
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
      // **새 답글이면 루트의 답글 수를 올린다.** 서버는 루트를 다시 보내 주지 않는다 —
      // 안 올리면 답글이 달려도 채널 화면에 "답글 N개" 줄이 안 생기고, 스레드를 열 길이
      // 없다. 처음 들어올 때만 센다: 내 답글은 POST 응답과 소켓으로 **두 번** 온다.
      // `progress`·`wake` 는 답글로 안 센다(데스크탑 `countsAsReply` 와 같은 규칙).
      final root = message.threadRootId;
      if (root != null &&
          message.kind != MessageKind.progress &&
          message.kind != MessageKind.wake) {
        final at = list.indexWhere((m) => m.id == root);
        if (at >= 0) list[at] = list[at].withReplyCount((list[at].replyCount ?? 0) + 1);
      }
    }
    notifyListeners();
  }

  // ── 받은 것 ───────────────────────────────────────────────────────────

  Future<void> loadInbox() async {
    final api = _api;
    if (api == null) return;
    // 이미 한 번 읽었으면 다시 읽는 동안 **읽는 중으로 되돌리지 않는다** — 이벤트마다
    // 목록이 자리표시로 깜빡인다.
    if (inboxLoad != LoadState.loaded) {
      inboxLoad = LoadState.loading;
      notifyListeners();
    }
    try {
      final entries = await api.inbox();
      inbox
        ..clear()
        ..addAll(entries);
      inboxLoad = LoadState.loaded;
    } on Object catch (e) {
      // 이미 보이는 목록이 있으면 그대로 둔다 — 다시 못 읽었다고 지우면 있던 것까지 사라진다.
      failures['inbox'] = LoadFailure.of(e);
      if (inboxLoad != LoadState.loaded) inboxLoad = LoadState.failed;
    }
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
    // 자동 멘션은 소켓이 알려 주지 않으므로 열 때마다 새로 읽는다 — 아래의 "이미 읽은 채널" 조기
    // 반환보다 앞이어야 admin 이 바꾼 설정이 다시 열 때 잡힌다.
    unawaited(loadChannelAutoMentions(channelId));
    // 이미 읽어 둔 채널은 다시 읽지 않는다 — 소켓이 그 뒤를 잇는다. **못 읽었던 채널은
    // 다시 읽는다**: 전에는 한 번 실패하면 빈 목록이 남아 "메시지가 없다"로 굳었다.
    if (channelLoad[channelId] == LoadState.loaded ||
        channelLoad[channelId] == LoadState.loading) {
      notifyListeners();
      return;
    }
    channelLoad[channelId] = LoadState.loading;
    olderFailed.remove(channelId);
    notifyListeners();
    final gen = _generation;
    try {
      final page = await _api!.messages(channelId, limit: channelPageSize);
      if (gen != _generation) return;
      messages[channelId] = [...page.messages]..sort((a, b) => a.seq.compareTo(b.seq));
      channelHasMore[channelId] = page.hasMore;
      channelLoad[channelId] = LoadState.loaded;
    } on Object catch (e) {
      if (gen != _generation) return;
      messages.remove(channelId);
      failures[channelId] = LoadFailure.of(e);
      channelLoad[channelId] = LoadState.failed;
      notifyListeners();
      return;
    }
    notifyListeners();
    // 걸러서 남는 최상위 글이 너무 적으면 **더 받아 온다.** 서버는 최상위와 스레드 답글을 섞어
    // 최근 N 줄을 주고, 채널 화면은 최상위만 그린다 — 답글이 많은 채널은 첫 페이지를 다 걸러도
    // 한두 줄만 남는다(실기기 #task 에서 맨 아래 글 하나만 보였다).
    for (var i = 0; i < maxBackfillPages; i++) {
      final roots = (messages[channelId] ?? const <MessageRow>[]).where((m) => m.inChannelFeed).length;
      if (roots >= minVisibleRoots || channelHasMore[channelId] != true) break;
      if (!await loadOlder(channelId)) break;
    }
    if (gen != _generation) return;
    await markRead(channelId);
  }

  /// 한 번에 받는 줄 수. 서버 상한(500)이고 데스크탑의 `INITIAL_HISTORY_LIMIT` 과 같다 — 50 이면
  /// 답글이 많은 채널에서 최상위가 거의 남지 않았다.
  static const channelPageSize = 500;

  /// 채널을 열었을 때 이만큼의 최상위 글은 보이게 한다. 모자라면 [maxBackfillPages] 까지 더 받는다.
  static const minVisibleRoots = 20;

  /// 채널을 열 때 더 받는 페이지 상한. 답글만 수천 줄인 채널에서 끝없이 받지 않게 한다 —
  /// 그 뒤는 사람이 위로 밀 때 [loadOlder] 가 받는다.
  static const maxBackfillPages = 3;

  /// 이전 페이지(더 오래된 것)를 받는다. 받은 것이 있으면 `true`.
  ///
  /// 채널 화면이 목록 맨 위에 닿으면 부른다. 겹쳐 부르면 한 번만 간다. 실패해도 **던지지 않는다**
  /// — 이미 보이는 것을 지우지 않고 [olderFailed] 에 적는다. 그 뒤로는 [retryOlder] 만 다시 간다.
  Future<bool> loadOlder(String channelId) async {
    final list = messages[channelId];
    if (list == null || list.isEmpty) return false;
    if (channelHasMore[channelId] != true ||
        loadingOlder.contains(channelId) ||
        olderFailed.contains(channelId)) {
      return false;
    }
    loadingOlder.add(channelId);
    notifyListeners();
    final gen = _generation;
    try {
      final page = await _api!.messages(channelId, before: list.first.seq, limit: channelPageSize);
      if (gen != _generation) return false;
      channelHasMore[channelId] = page.hasMore;
      final current = messages[channelId];
      if (current == null) return false;
      final seen = current.map((m) => m.seq).toSet();
      final older = page.messages.where((m) => !seen.contains(m.seq)).toList();
      if (older.isEmpty) return false;
      messages[channelId] = [...older, ...current]..sort((a, b) => a.seq.compareTo(b.seq));
      return true;
    } on Object {
      if (gen == _generation) olderFailed.add(channelId);
      return false;
    } finally {
      loadingOlder.remove(channelId);
      notifyListeners();
    }
  }

  /// "이전 메시지를 불러오지 못했다 · 다시 시도" 를 눌렀다. 못 받은 표시를 걷고 한 번 더 간다.
  Future<bool> retryOlder(String channelId) {
    olderFailed.remove(channelId);
    return loadOlder(channelId);
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
  ///
  /// 보낼 수 없으면(첨부가 아직 올라가는 중) `false` 다 — 그때 화면은 작성칸을 **비우지 않는다.**
  /// 보내다 실패한 것은 `true` 다: 그 말은 [failedSends] 에 남아 목록 안에서 다시 보낸다.
  ///
  /// [agentModels] 는 작성칸 모델 칩으로 고른 값(서버 079)이다. 두 축이 다 빈 값은 "그 스레드의
  /// 지정 해제" 이므로 **걸러 내지 않는다** — 무엇을 실을지는 화면(`picksForBody`)이 이미 정했다.
  Future<bool> send(
    String channelId,
    String body, {
    String? threadRootId,
    Map<String, ({String? model, String? effort})> agentModels = const {},
  }) async {
    final key = threadRootId ?? channelId;
    final ids = (pending[key] ?? const <PendingAttachment>[])
        .where((p) => p.attachment != null)
        .map((p) => p.attachment!.id)
        .toList(growable: false);
    // **올리는 중인 것이 남아 있으면 보내지 않는다.** 보내 버리면 그 파일은 메시지에
    // 안 붙고, 사람은 붙였다고 믿는다.
    // 화면이 보내기 버튼을 잠그므로(`isUploading`) 여기 닿는 것은 버그다 — 그래도 글을
    // 잃지 않게 `false` 를 돌려 작성칸이 비우지 않게 한다.
    if (isUploading(key)) return false;
    pending.remove(key);
    await _post(FailedSend(
      localId: 'local-${_localSeq++}',
      channelId: channelId,
      threadRootId: threadRootId,
      body: body,
      attachmentIds: ids,
      agentModels: [
        for (final e in agentModels.entries)
          {'agentId': e.key, 'model': e.value.model, 'effort': e.value.effort},
      ],
    ));
    return true;
  }

  /// 이 작성칸에 아직 올라가는 첨부가 있는가. 있으면 보내기 버튼이 잠긴다.
  bool isUploading(String key) =>
      (pending[key] ?? const <PendingAttachment>[]).any((p) => p.attachment == null);

  /// 보낸다. 실패하면 **던지지 않고** [failedSends] 에 남긴다 — 던지면 받을 사람이 없어
  /// 글이 조용히 사라졌다(지난 검토의 "조용한 실패").
  Future<void> _post(FailedSend item) async {
    try {
      final sent = await _api!.postMessage(
        item.channelId,
        item.body,
        threadRootId: item.threadRootId,
        attachmentIds: item.attachmentIds,
        agentModels: item.agentModels,
      );
      _removeFailed(item);
      _upsertMessage(sent);
    } on Object {
      final key = item.threadRootId ?? item.channelId;
      final list = failedSends.putIfAbsent(key, () => []);
      item.retrying = false;
      if (!list.contains(item)) list.add(item);
      notifyListeners();
    }
  }

  /// 못 보낸 말을 다시 보낸다.
  Future<void> resend(FailedSend item) async {
    if (item.retrying) return;
    item.retrying = true;
    notifyListeners();
    await _post(item);
  }

  /// 못 보낸 말을 버린다.
  void discardFailed(FailedSend item) {
    _removeFailed(item);
    notifyListeners();
  }

  void _removeFailed(FailedSend item) {
    final key = item.threadRootId ?? item.channelId;
    final list = failedSends[key];
    if (list == null) return;
    list.remove(item);
    if (list.isEmpty) failedSends.remove(key);
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
    // 여기서 **알리지 않는다** — 화면이 `didChangeDependencies`(빌드 중)에서 부르므로 알리면
    // "빌드 중 setState" 가 된다. 아직 상태가 없으면 화면은 읽는 중으로 그린다.
    if (threadLoad[rootId] == LoadState.failed) threadLoad[rootId] = LoadState.loading;
    final gen = _generation;
    try {
      final page = await _api!.messages(channelId, thread: rootId, limit: 100);
      if (gen != _generation) return;
      threads[rootId] = [...page.messages]..sort((a, b) => a.seq.compareTo(b.seq));
      threadLoad[rootId] = LoadState.loaded;
    } on Object catch (e) {
      if (gen != _generation) return;
      failures[rootId] = LoadFailure.of(e);
      if (threadLoad[rootId] != LoadState.loaded) threadLoad[rootId] = LoadState.failed;
    }
    notifyListeners();
    unawaited(loadThreadAgentModels(channelId, rootId));
  }

  /// 스레드 루트 id → 에이전트 모델 지정(서버 079). 키가 없으면 아직 못 받았다.
  final Map<String, List<ThreadAgentModel>> threadAgentModels = {};

  /// 스레드의 모델 지정을 읽는다. 실패는 삼킨다 — 칩이 안 설 뿐 스레드는 열린다.
  Future<void> loadThreadAgentModels(String channelId, String rootId) async {
    try {
      threadAgentModels[rootId] = await _api!.threadAgentModels(channelId, rootId);
      notifyListeners();
    } on Object {
      // 옛 서버(404)·끊김. 키를 남기지 않아 "모른다" 로 둔다.
    }
  }

  /// 스레드 칩에서 정한다(다음 턴부터). 응답으로 바로 고친다 — 같은 사실이 이벤트로 다시 와도 같은 값이다.
  Future<void> setThreadAgentModel(
    String channelId, String rootId, String agentId, String? model, String? effort,
  ) async {
    final row = await _api!.setThreadAgentModel(channelId, rootId, agentId, model, effort);
    final rest = (threadAgentModels[rootId] ?? const <ThreadAgentModel>[])
        .where((r) => r.agentId != agentId)
        .toList();
    if (row != null) rest.add(row);
    threadAgentModels[rootId] = rest;
    notifyListeners();
  }

  /// 칩 고르개의 재료.
  Future<AgentModelOptions> agentModelOptions(String agentId) => _api!.agentModelOptions(agentId);

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
    _generation++;
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
    channelLoad.clear();
    channelHasMore.clear();
    loadingOlder.clear();
    olderFailed.clear();
    threadLoad.clear();
    failures.clear();
    inboxLoad = LoadState.loading;
    // 못 보낸 말도 버린다 — 다른 계정으로 들어온 뒤에 남은 말이 그 계정 이름으로 가면 안 된다.
    failedSends.clear();
    pending.clear();
    // 누구와 이야기하던 자리인가도 그 계정의 것이다 — 다른 계정이 이어받으면 엉뚱한 상대를 부른다.
    stickyMentions.clear();
    channelAutoMentions.clear();
    autoSkipped.clear();
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
