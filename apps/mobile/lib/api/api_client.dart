import 'dart:convert';

import 'package:http/http.dart' as http;

import 'api_error.dart';
import 'models.dart';

/// 서버 REST 클라이언트. 데스크탑 `api.ts` 의 **같은 규약**을 따른다:
/// `Authorization: Bearer <token>`, JSON 본문, `{ error: { code, message } }` 오류 봉투.
///
/// P0 에 필요한 것만 있다. 엔드포인트를 더할 때는 **거기서 쓰는 모델도 함께** 만든다 —
/// `Map<String, dynamic>` 을 화면까지 흘리면 서버가 바뀐 것을 화면이 처음 발견한다.
class ApiClient {
  ApiClient({required this.baseUrl, String? token, http.Client? httpClient})
      : _token = token,
        _http = httpClient ?? http.Client();


  /// 끝 슬래시가 없는 주소. `connect/server_url.dart` 가 이미 그 모양으로 준다.
  final String baseUrl;
  final http.Client _http;
  String? _token;

  set token(String? value) => _token = value;

  Map<String, String> _headers({bool json = false}) => {
        if (json) 'content-type': 'application/json',
        if (_token != null) 'authorization': 'Bearer $_token',
      };

  /// 한 번의 왕복. 실패의 **두 갈래를 갈라서** 던진다 — 서버가 답했으면 [ApiError],
  /// 닿지도 못했으면 [NetworkError]. 부르는 쪽이 "기다리면 낫는가"를 판정할 수 있어야 한다.
  Future<Object?> _send(String method, String path, {Object? body}) async {
    final req = http.Request(method, Uri.parse('$baseUrl$path'))
      ..headers.addAll(_headers(json: body != null));
    if (body != null) req.body = jsonEncode(body);

    late final http.StreamedResponse streamed;
    try {
      streamed = await _http.send(req);
    } on Object catch (e) {
      throw NetworkError(e);
    }
    final res = await http.Response.fromStream(streamed);

    // 204 는 본문이 없다. `jsonDecode('')` 는 던지므로 먼저 걸러야 한다.
    if (res.statusCode == 204 || res.bodyBytes.isEmpty) {
      if (res.statusCode >= 400) {
        throw ApiError(res.statusCode, 'unknown', 'HTTP ${res.statusCode}');
      }
      return null;
    }

    Object? decoded;
    try {
      decoded = jsonDecode(_utf8Body(res));
    } on FormatException {
      decoded = null;
    }

    if (res.statusCode >= 400) {
      final err = decoded is Map ? decoded['error'] : null;
      final code = err is Map && err['code'] is String ? err['code']! as String : 'unknown';
      final message =
          err is Map && err['message'] is String ? err['message']! as String : 'HTTP ${res.statusCode}';
      throw ApiError(res.statusCode, code, message, decoded);
    }
    return decoded;
  }

  /// 본문을 **언제나 UTF-8 로** 읽는다.
  ///
  /// `http` 의 `Response.body` 는 `content-type` 의 `charset` 을 보고 없으면 **latin-1** 로
  /// 떨어진다(RFC 의 기본값이다). 그런데 JSON 은 UTF-8 이고, 이 저장소의 메시지는 한국어가
  /// 대부분이다 — `charset` 을 안 붙이는 서버·프록시를 만나면 본문이 통째로 깨진다.
  /// 깨진 채로 파싱은 **성공**하므로 아무 데서도 오류가 나지 않고, 사람이 화면에서
  /// 글자가 깨진 것으로 처음 발견한다.
  static String _utf8Body(http.Response res) => utf8.decode(res.bodyBytes, allowMalformed: true);

  Map<String, Object?> _obj(Object? v) =>
      v is Map ? Map<String, Object?>.from(v) : const <String, Object?>{};

  List<Map<String, Object?>> _list(Object? v) => v is List
      ? v.whereType<Map>().map((e) => Map<String, Object?>.from(e)).toList(growable: false)
      : const [];

  // ── 인증 ──────────────────────────────────────────────────────────────

  /// 로그인해서 토큰을 받는다. **이 토큰이 세션이다** — 키체인에 넣는 것이 이것이다.
  Future<String> login(String loginId, String password) async {
    final body = _obj(await _send('POST', '/auth/login', body: {'loginId': loginId, 'password': password}));
    final token = body['token'];
    if (token is! String || token.isEmpty) {
      throw ApiError(200, 'malformed_login', '로그인 응답에 토큰이 없다', body);
    }
    return token;
  }

  Future<MeView> me() async => MeView.fromJson(_obj(await _send('GET', '/auth/me')));

  // ── 디렉터리 · 채널 ───────────────────────────────────────────────────

  Future<List<AccountView>> accounts() async =>
      _list(await _send('GET', '/accounts')).map(AccountView.fromJson).toList(growable: false);

  Future<List<ChannelRow>> channels() async =>
      _list(await _send('GET', '/channels')).map(ChannelRow.fromJson).toList(growable: false);

  // ── 메시지 ────────────────────────────────────────────────────────────

  /// 한 페이지를 읽는다.
  ///
  /// [before] 는 **역방향 커서**다(그 `seq` 보다 앞). 서버가 desc 로 잡아 오름차순으로
  /// 되돌려 주므로 받은 순서를 그대로 그리면 된다.
  /// [thread] 를 주면 **그 스레드의 답글**만 온다. 채널 목록에는 루트만 실리므로
  /// 답글은 스레드를 열 때 따로 읽는다.
  Future<MessagePage> messages(
    String channelId, {
    int? before,
    int? limit,
    String? thread,
  }) async {
    final q = <String, String>{
      if (before != null) 'before': '$before',
      if (limit != null) 'limit': '$limit',
      'thread': ?thread,
    };
    final qs = q.isEmpty ? '' : '?${Uri(queryParameters: q).query}';
    return MessagePage.fromJson(_obj(await _send('GET', '/channels/$channelId/messages$qs')));
  }

  /// 말한다. 멘션이 들어 있으면 **이것이 에이전트를 부르는 방법**이다 — 별도
  /// 엔드포인트가 없고, 서버가 본문을 훑어 턴을 띄운다.
  Future<MessageRow> postMessage(String channelId, String body, {String? threadRootId}) async {
    final res = await _send('POST', '/channels/$channelId/messages', body: {
      'body': body,
      'threadRootId': ?threadRootId,
    });
    return MessageRow.fromJson(_obj(res));
  }

  // ── 선택 요청 ─────────────────────────────────────────────────────────

  /// 선택지를 고른다.
  ///
  /// **답은 원본을 고치지 않는다** — 고른 결과가 `meta.ask.answeredWith/By/At` 로
  /// 덧붙고 본문과 `editedAt` 은 그대로다. 사람이 글을 고친 것이 아니기 때문이다.
  Future<MessageRow> answerAsk(String channelId, String messageId, String optionId) async {
    final res = await _send(
      'POST',
      '/channels/$channelId/messages/$messageId/ask-answer',
      body: {'optionId': optionId},
    );
    return MessageRow.fromJson(_obj(res));
  }

  /// **답하지 않기로 한다.**
  ///
  /// 고르기만 있으면 그 작업을 그만두기로 한 사람에게 남는 수단이 **메시지를 지우는
  /// 것**뿐이고, 지우면 무엇을 물었는지까지 사라진다. 물음이 닫히는 길을 하나 더 둔다.
  Future<MessageRow> closeAsk(String channelId, String messageId) async {
    final res = await _send(
      'POST',
      '/channels/$channelId/messages/$messageId/ask-close',
      body: const <String, Object?>{},
    );
    return MessageRow.fromJson(_obj(res));
  }

  // ── 소켓 ──────────────────────────────────────────────────────────────

  /// 연결 **시도마다** 새로 받는다. 재사용하면 서버가 거절한다.
  Future<String> wsTicket() async {
    final body = _obj(await _send('POST', '/ws-ticket'));
    final ticket = body['ticket'];
    if (ticket is! String || ticket.isEmpty) {
      throw ApiError(200, 'malformed_ticket', '티켓 응답이 비어 있다', body);
    }
    return ticket;
  }

  void close() => _http.close();
}
