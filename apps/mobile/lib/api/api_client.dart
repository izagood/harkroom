import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;

import 'api_error.dart';
import 'content_type.dart';
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
      _list(_obj(await _send('GET', '/accounts'))['accounts'])
          .map(AccountView.fromJson)
          .toList(growable: false);

  Future<List<ChannelRow>> channels() async =>
      _list(_obj(await _send('GET', '/channels'))['channels'])
          .map(ChannelRow.fromJson)
          .toList(growable: false);

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
    int? since,
    int? limit,
    String? thread,
  }) async {
    final q = <String, String>{
      if (before != null) 'before': '$before',
      if (since != null) 'since': '$since',
      if (limit != null) 'limit': '$limit',
      'thread': ?thread,
    };
    final qs = q.isEmpty ? '' : '?${Uri(queryParameters: q).query}';
    return MessagePage.fromJson(_obj(await _send('GET', '/channels/$channelId/messages$qs')));
  }

  /// 말한다. 멘션이 들어 있으면 **이것이 에이전트를 부르는 방법**이다 — 별도
  /// 엔드포인트가 없고, 서버가 본문을 훑어 턴을 띄운다.
  ///
  /// [attachmentIds] 는 **먼저 올려 둔** 첨부의 id 다(`upload`). 업로드가 메시지보다
  /// 먼저 존재하는 이 순서가 서버의 결정이고, 되돌릴 수 있는 실패를 고른 것이다 —
  /// 올리다 만 파일은 고아로 남아 치울 수 있지만, 가리키는 파일이 없는 메시지는
  /// **깨진 첨부**다.
  Future<MessageRow> postMessage(
    String channelId,
    String body, {
    String? threadRootId,
    List<String> attachmentIds = const [],
    List<Map<String, Object?>> agentModels = const [],
  }) async {
    final res = await _send('POST', '/channels/$channelId/messages', body: {
      'body': body,
      'threadRootId': ?threadRootId,
      if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
      // 작성칸 모델 칩(서버 079). 빈 목록은 싣지 않는다 — 옛 서버는 모르는 키를 받지 않는다.
      if (agentModels.isNotEmpty) 'agentModels': agentModels,
    });
    return MessageRow.fromJson(_obj(res));
  }

  /// 스레드 × 에이전트 모델 지정(서버 079).
  Future<List<ThreadAgentModel>> threadAgentModels(String channelId, String rootId) async {
    final res = _obj(await _send('GET', '/channels/$channelId/threads/$rootId/agent-models'));
    final list = res['agentModels'];
    return list is List
        ? list.whereType<Map>().map((m) => ThreadAgentModel.fromJson(Map<String, Object?>.from(m))).toList()
        : const [];
  }

  /// 스레드 칩에서 정한다. 두 축이 다 비면 서버가 푼다. 사람만 된다.
  Future<ThreadAgentModel?> setThreadAgentModel(
    String channelId, String rootId, String agentId, String? model, String? effort,
  ) async {
    final res = _obj(await _send('PUT', '/channels/$channelId/threads/$rootId/agent-models/$agentId',
        body: {'model': model, 'effort': effort}));
    final row = res['row'];
    return row is Map ? ThreadAgentModel.fromJson(Map<String, Object?>.from(row)) : null;
  }

  /// 칩 고르개의 재료 — 하네스가 밝힌 모델 목록과 에이전트 기본값.
  Future<AgentModelOptions> agentModelOptions(String agentId) async =>
      AgentModelOptions.fromJson(_obj(await _send('GET', '/agents/$agentId/model-options')));

  /// 파일 하나를 올린다(`POST /uploads`, multipart 필드 이름은 `file`).
  ///
  /// ## 진행률을 **직접 센다**
  ///
  /// `http` 의 `MultipartRequest` 는 바디가 얼마나 갔는지 알려 주지 않는다. 그대로 두면
  /// 화면은 "올리는 중"을 **길이 없는 스피너**로만 그릴 수 있고, 그러면 큰 파일에서
  /// **멈춘 것과 가는 중인 것이 구별되지 않는다** — 사람이 오류로 읽는 자리다.
  /// 데스크탑이 같은 이유로 `fetch` 대신 XHR 을 골랐고, 여기서는 보내는 스트림을 감싸
  /// 같은 신호를 만든다.
  ///
  /// [onProgress] 는 0~1 이다. 총 길이를 모르면 **부르지 않는다** — 가짜 비율을 그리면
  /// 막대가 거짓말을 한다.
  Future<AttachmentRow> upload(
    Uint8List bytes,
    String filename, {
    String? contentType,
    void Function(double fraction)? onProgress,
  }) async {
    final uri = Uri.parse('$baseUrl/uploads');
    final req = http.MultipartRequest('POST', uri)
      ..headers.addAll(_headers())
      ..files.add(http.MultipartFile.fromBytes(
        'file',
        bytes,
        filename: filename,
        // 형식을 모르면 이름으로 짐작한다 — 비워 보내면 서버가 octet-stream 으로 저장해
        // 사진이 미리보기를 잃는다(`content_type.dart`).
        contentType: switch (contentType ?? contentTypeFor(filename)) {
          final String t => MediaType.parse(t),
          null => null,
        },
      ));

    final total = req.contentLength;
    final body = req.finalize();
    final watched = onProgress == null || total <= 0
        ? body
        : http.ByteStream(_counting(body, total, onProgress));

    final streamedRequest = http.StreamedRequest('POST', uri)
      ..headers.addAll(req.headers)
      ..contentLength = total;
    unawaited(watched.pipe(streamedRequest.sink));

    late final http.StreamedResponse streamed;
    try {
      streamed = await _http.send(streamedRequest);
    } on Object catch (e) {
      throw NetworkError(e);
    }
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode >= 400) {
      final decoded = _tryJson(res);
      final err = decoded is Map ? decoded['error'] : null;
      throw ApiError(
        res.statusCode,
        err is Map && err['code'] is String ? err['code']! as String : 'upload_failed',
        err is Map && err['message'] is String ? err['message']! as String : 'HTTP ${res.statusCode}',
        decoded,
      );
    }
    return AttachmentRow.fromJson(_obj(_tryJson(res)));
  }

  static Object? _tryJson(http.Response res) {
    try {
      return jsonDecode(_utf8Body(res));
    } on FormatException {
      return null;
    }
  }

  /// 보낸 바이트를 세면서 흘려보낸다.
  static Stream<List<int>> _counting(
    Stream<List<int>> source,
    int total,
    void Function(double) onProgress,
  ) async* {
    var sent = 0;
    await for (final chunk in source) {
      sent += chunk.length;
      // 1 을 넘지 않게 — multipart 의 경계 바이트 때문에 실제 총량이 어긋날 수 있다.
      onProgress(sent / total > 1 ? 1 : sent / total);
      yield chunk;
    }
  }

  // ── 받은 것 ───────────────────────────────────────────────────────────

  /// 나를 부른 것들. [unreadOnly] 면 아직 안 본 것만.
  Future<List<InboxEntry>> inbox({bool unreadOnly = false}) async {
    final body = _obj(await _send('GET', '/inbox${unreadOnly ? '?unread=1' : ''}'));
    return _list(body['entries']).map(InboxEntry.fromJson).toList(growable: false);
  }

  /// 읽음 처리. **entry id 로 보낸다** — 메시지 id 가 아니다(같은 메시지로 두 번
  /// 불릴 수 있고, 그때 한 줄만 읽음이 되어야 한다).
  Future<void> markInboxRead(List<int> ids) =>
      _send('POST', '/inbox/read', body: {'ids': ids});

  // ── 첨부 ──────────────────────────────────────────────────────────────

  /// 첨부 바이트를 받는 주소.
  ///
  /// **토큰이 URL 에 들어가지 않는다.** 그래서 이미지를 그릴 때 [authHeaders] 를 함께
  /// 넘겨야 한다 — 쿼리에 토큰을 싣는 쪽이 쉽지만, 그 주소는 로그·캐시·공유에 그대로
  /// 남는다.
  String attachmentUrl(String attachmentId) => '$baseUrl/attachments/$attachmentId';

  /// 이미지 위젯에 넘길 헤더.
  Map<String, String> get authHeaders => _headers();

  // ── 리액션 ────────────────────────────────────────────────────────────

  /// 이모지를 누른다. 같은 것을 이미 눌렀으면 서버가 조용히 넘어간다.
  ///
  /// 이모지가 경로에 들어가므로 **반드시 인코딩한다** — 안 하면 대부분의 이모지가
  /// 잘못된 URL 이 된다.
  Future<void> addReaction(String channelId, String messageId, String emoji) => _send(
        'PUT',
        '/channels/$channelId/messages/$messageId/reactions/${Uri.encodeComponent(emoji)}',
      );

  Future<void> removeReaction(String channelId, String messageId, String emoji) => _send(
        'DELETE',
        '/channels/$channelId/messages/$messageId/reactions/${Uri.encodeComponent(emoji)}',
      );

  // ── 읽음 ──────────────────────────────────────────────────────────────

  /// 채널별 읽음 위치와 안 읽은 수.
  Future<List<ReadState>> reads() async {
    final body = _obj(await _send('GET', '/reads'));
    return _list(body['reads']).map(ReadState.fromJson).toList(growable: false);
  }

  /// 여기까지 읽었다고 알린다.
  ///
  /// **`seq` 를 보낸다** — 시각이 아니다. 시각으로 하면 기기 시계가 틀린 만큼 읽음이
  /// 앞뒤로 흔들리고, 그 오차는 사람에게 "안 읽은 것이 사라졌다"로 보인다.
  Future<void> markRead(String channelId, int seq) =>
      _send('PUT', '/channels/$channelId/read', body: {'seq': seq});

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
