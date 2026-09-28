/// 워크스페이스 이벤트 소켓.
///
/// 데스크탑 `packages/desktop/src/lib/ws.ts` 의 **상태 기계를 그대로 옮긴 것**이다.
/// 옮긴 것이 모양이 아니라 **판단**이라는 점이 중요하다:
///
/// ## 끊긴 **이유**를 가른다 — 기다리면 낫는 것과 그렇지 않은 것
///
/// 네트워크는 돌아오지만 **폐기된 세션은 돌아오지 않는다.** 구분하지 않으면 사람은 빨간
/// 점과 영원한 재연결만 보고 왜 안 되는지 알 방법이 없다(= 조용한 실패). 폰에서는 이것이
/// 데스크탑보다 더 아프다 — 지하철에서 끊기는 일이 기본값이라, 진짜 로그아웃이 그 소음에
/// 묻힌다.
///
/// ## 티켓은 **연결마다 새로** 받는다
///
/// `POST /ws-ticket` 이 주는 것은 단기 1회용이다. 재사용하면 서버가 거절한다. 그래서
/// 재연결은 "소켓을 다시 연다"가 아니라 **"티켓을 다시 받아 소켓을 연다"** 이고, 티켓
/// 발급이 401/403 이면 그것 자체가 자격증명이 죽었다는 신호다.
library;

import 'dart:async';
import 'dart:convert';

/// 왜 끊겼나. [network] 만 재시도로 낫는다.
enum WsDownReason {
  /// 기다리면 낫는다.
  network,

  /// 티켓이 무효거나, 소켓 수명 중에 자격증명이 폐기됐다(close 4401).
  credential,

  /// 서버의 허용 origin 목록에 없다(close 4403).
  origin,
}

/// 서버가 핸드셰이크를 거절하거나 소켓을 끊을 때 쓰는 코드. **둘 다 재시도로 안 낫는다.**
const int wsCloseCredential = 4401;
const int wsCloseOrigin = 4403;

/// 연결 시도마다 새로 받아야 하는 티켓을 내놓는다.
typedef TicketProvider = Future<String> Function();

/// 소켓을 실제로 여는 자리. **시험이 여기를 바꿔 끼운다** — 진짜 서버 없이 백오프와
/// 포기 판정을 시험할 수 있어야 하고, 그것이 이 파일에서 가장 틀리기 쉬운 부분이다.
typedef WsConnector = Future<WsConnection> Function(Uri url);

/// 열린 소켓 하나. `web_socket_channel` 을 감싸는 얇은 인터페이스다 —
/// 이 파일이 특정 패키지에 묶이지 않게.
abstract class WsConnection {
  /// 서버가 보낸 텍스트 프레임.
  Stream<String> get messages;

  /// 닫힘 코드. 소켓이 닫힌 뒤에만 의미가 있다.
  int? get closeCode;

  void send(String payload);
  Future<void> close();
}

/// 백오프 한 단계. `ws.ts` 와 같은 값이다 — 1초에서 시작해 두 배씩, 15초에서 멈춘다.
Duration nextBackoff(Duration current) {
  const cap = Duration(seconds: 15);
  final doubled = current * 2;
  return doubled > cap ? cap : doubled;
}

const Duration initialBackoff = Duration(seconds: 1);

/// 이벤트 소켓을 열고 **살아 있게 유지한다.**
class WsClient {
  WsClient({
    required String baseUrl,
    required TicketProvider getTicket,
    required WsConnector connect,
    this.onEvent,
    this.onOpen,
    this.onDown,
    Future<void> Function(Duration)? sleep,
  })  : _wsBase = _toWsBase(baseUrl),
        _getTicket = getTicket,
        _connect = connect,
        // 시험이 시간을 건너뛴다. 진짜 지연을 기다리면 백오프 시험 하나가 30초를 쓴다.
        _sleep = sleep ?? Future<void>.delayed;

  final String _wsBase;
  final TicketProvider _getTicket;
  final WsConnector _connect;
  final Future<void> Function(Duration) _sleep;

  final void Function(Map<String, Object?> event)? onEvent;
  final void Function()? onOpen;
  final void Function(WsDownReason reason)? onDown;

  bool _closed = false;
  Duration _backoff = initialBackoff;
  WsConnection? _conn;
  StreamSubscription<String>? _sub;

  /// 지금 열린 소켓이 닫히기를 기다리는 자리.
  ///
  /// **[close] 가 이것을 완료시켜야 한다.** 구독을 취소하면 `onDone` 이 영영 안 오므로,
  /// 이걸 안 깨우면 `close()` 를 부른 쪽의 `start()` 퓨처가 **영원히 매달린다** —
  /// 화면을 떠났는데 소켓 루프가 살아 있는 상태다. 시험이 이걸 잡았다.
  Completer<void>? _socketClosed;

  /// `https://h` → `wss://h/ws`. 끝 슬래시는 떼고, 스킴은 그대로 뒤집는다
  /// (`https`→`wss`, `http`→`ws`).
  static String _toWsBase(String baseUrl) {
    final trimmed = baseUrl.replaceAll(RegExp(r'/+$'), '');
    return '${trimmed.replaceFirst(RegExp(r'^http'), 'ws')}/ws';
  }

  /// 재시도로 낫지 않는 사유. **더 시도하지 않고** 호출부에 넘긴다.
  void _giveUp(WsDownReason reason) {
    _closed = true;
    onDown?.call(reason);
  }

  Future<void> start() async {
    while (!_closed) {
      String ticket;
      try {
        ticket = await _getTicket();
      } on Object catch (err) {
        // 401/403 은 자격증명이 죽었다는 뜻이다 — 백오프를 아무리 해도 살아나지 않는다.
        // `ApiError` 를 import 하지 않고 덕타이핑으로 본다: 이 파일이 HTTP 계층을 알
        // 필요가 없다(`ws.ts` 가 `api.ts` 를 모르는 것과 같은 선).
        final status = _statusOf(err);
        if (status == 401 || status == 403) return _giveUp(WsDownReason.credential);
        onDown?.call(WsDownReason.network);
        await _sleep(_backoff);
        _backoff = nextBackoff(_backoff);
        continue;
      }
      // 발급을 기다리는 사이 명시 종료가 들어왔을 수 있다. 여기서 안 막으면 **닫은 뒤에
      // 소켓이 열린다.**
      if (_closed) return;

      final url = Uri.parse('$_wsBase?ticket=${Uri.encodeQueryComponent(ticket)}');
      try {
        final conn = await _connect(url);
        _conn = conn;
        _backoff = initialBackoff;
        onOpen?.call();

        final done = Completer<void>();
        _socketClosed = done;
        _sub = conn.messages.listen(
          (raw) {
            // 비정형 프레임은 **무시한다.** 하나가 깨졌다고 소켓을 끊으면, 서버가 새
            // 이벤트를 하나 더하는 날 옛 앱이 전부 연결을 잃는다.
            try {
              final decoded = jsonDecode(raw);
              if (decoded is Map) onEvent?.call(Map<String, Object?>.from(decoded));
            } on FormatException {
              /* 무시 */
            }
          },
          onError: (_) {
            if (!done.isCompleted) done.complete();
          },
          onDone: () {
            if (!done.isCompleted) done.complete();
          },
          cancelOnError: false,
        );
        await done.future;
        _socketClosed = null;
        await _sub?.cancel();
        _sub = null;

        if (_closed) return;
        final code = conn.closeCode;
        if (code == wsCloseCredential) return _giveUp(WsDownReason.credential);
        if (code == wsCloseOrigin) return _giveUp(WsDownReason.origin);
      } on Object {
        // 연결 자체가 실패했다. 사유를 알 수 없으면 네트워크로 본다.
      }

      if (_closed) return;
      onDown?.call(WsDownReason.network);
      await _sleep(_backoff);
      _backoff = nextBackoff(_backoff);
    }
  }

  /// 클라이언트 → 서버. 지금 쓰는 것은 '입력 중' 하나다.
  ///
  /// 소켓이 아직 안 열렸으면 **조용히 버린다.** 큐에 쌓아 두면 재연결 뒤에 오래된
  /// '입력 중'이 도착해서 이미 멈춘 사람이 입력 중으로 보인다 — 수명이 몇 초인 신호는
  /// 버리는 것이 맞다.
  void send(Map<String, Object?> payload) {
    final conn = _conn;
    if (conn == null) return;
    conn.send(jsonEncode(payload));
  }

  Future<void> close() async {
    _closed = true;
    // 매달린 `start()` 를 먼저 깨운다 — 구독을 취소한 뒤에는 `onDone` 이 오지 않는다.
    if (_socketClosed?.isCompleted == false) _socketClosed!.complete();
    _socketClosed = null;
    await _sub?.cancel();
    _sub = null;
    await _conn?.close();
    _conn = null;
  }

  static int? _statusOf(Object err) {
    try {
      final dynamic e = err;
      final Object? s = e.status;
      return s is int ? s : null;
    } on NoSuchMethodError {
      return null;
    }
  }
}
