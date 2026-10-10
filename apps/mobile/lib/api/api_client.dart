import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;

import 'api_error.dart';
import 'content_type.dart';
import 'ask.dart';
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

  /// 이 토큰의 서버 세션을 끊는다(서버는 이 토큰만 지운다 — 다른 기기는 그대로다).
  Future<void> logout() async {
    await _send('POST', '/auth/logout');
  }

  /// 이 기기의 APNs 토큰을 지금 세션에 묶는다(서버 0.3.144~, `PUT /push/devices`). 다시 불러도 한 행이다.
  /// 사람 로그인 세션만 받는다 — 서버가 다른 자격증명이면 403 `push_session_only` 를 준다.
  ///
  /// [badge] 가 있으면 `prefs.badge` 로 싣는다(서버 #1088~). 그 키를 모르는 옛 서버는 prefs 가 strict 라 400 을
  /// 준다 — 그때는 prefs 없이 한 번 더 등록한다. 등록이 배지 설정 하나 때문에 깨지지 않게.
  ///
  /// [preview] 가 있으면 `prefs.preview` 로 싣는다(서버는 처음부터 받는다 — 켜면 알림에 글 앞부분이 실린다).
  /// 400 이 와도 prefs 를 통째로 빼지 않고 **preview 만** 실어 한 번 더 보낸다(security F1) — 서버는 보낸 키만
  /// 바꾸므로, 통째로 빼면 켜 둔 미리보기를 끈 것이 서버에 닿지 않는다. 그래도 400 이면 그때 뺀다.
  Future<void> registerPushDevice({required String token, required String env, bool? badge, bool? preview}) async {
    final body = {'token': token, 'platform': 'ios', 'env': env};
    final prefs = {'badge': ?badge, 'preview': ?preview};
    if (prefs.isEmpty) {
      await _send('PUT', '/push/devices', body: body);
      return;
    }
    try {
      await _send('PUT', '/push/devices', body: {...body, 'prefs': prefs});
    } on ApiError catch (e) {
      if (e.status != 400) rethrow;
      if (preview != null && badge != null) {
        try {
          await _send('PUT', '/push/devices', body: {...body, 'prefs': {'preview': preview}});
          return;
        } on ApiError catch (e) {
          if (e.status != 400) rethrow;
        }
      }
      await _send('PUT', '/push/devices', body: body);
    }
  }

  /// 지금 세션에 묶인 이 기기의 푸시 등록을 푼다. 로그아웃은 서버 세션이 지워지며 함께 풀리지만,
  /// 그 요청이 실패해도 이것이 먼저 닿게 따로 부른다.
  Future<void> unregisterPushDevice() async {
    await _send('DELETE', '/push/devices/current');
  }

  /// 서버 릴리스 번호(`/healthz` 의 `version`). 인증 없이 읽힌다. 모르면 `null`.
  Future<String?> serverVersion() async {
    final v = _obj(await _send('GET', '/healthz'))['version'];
    return v is String && v.isNotEmpty ? v : null;
  }

  // ── 디렉터리 · 채널 ───────────────────────────────────────────────────

  Future<List<AccountView>> accounts() async =>
      _list(_obj(await _send('GET', '/accounts'))['accounts'])
          .map(AccountView.fromJson)
          .toList(growable: false);

  Future<List<ChannelRow>> channels() async =>
      _list(_obj(await _send('GET', '/channels'))['channels'])
          .map(ChannelRow.fromJson)
          .toList(growable: false);

  /// 내 DM 들(최근 말 순). 데스크탑 사이드바의 DM 묶음과 같은 출처다.
  Future<List<ChannelRow>> dms() async =>
      _list(_obj(await _send('GET', '/dms'))['dms'])
          .map(ChannelRow.fromDmJson)
          .toList(growable: false);

  /// 사람들과의 DM 을 열거나 만든다(`POST /dms` — 이미 있으면 그것을 준다). 나는 서버가 더한다.
  Future<String> openDm(List<String> accountIds) async {
    final id = _obj(await _send('POST', '/dms', body: {'accountIds': accountIds}))['id'];
    if (id is! String || id.isEmpty) throw const FormatException('dm without id');
    return id;
  }

  /// 지금 도는 에이전트 턴들 — **그 채널을 볼 수 있는 것만**(`?scope=visible`, 서버 0.3.154~).
  /// 이 범위만 쓴다: 기본 범위는 attach 용 세션 id 를 싣는 소유자 표면이다.
  Future<List<AgentActivity>> agentActivity() async =>
      _list(_obj(await _send('GET', '/agent-sessions?scope=visible'))['sessions'])
          .map(AgentActivity.fromJson)
          .toList(growable: false);

  /// 앞으로 올 에이전트 깨움들(같은 범위).
  Future<List<AgentWake>> agentWakes() async =>
      _list(_obj(await _send('GET', '/agent-wakes?scope=visible'))['wakes'])
          .map(AgentWake.fromJson)
          .toList(growable: false);

  /// 내 채널 선호(즐겨찾기·섹션·순서·치움). 데스크탑 사이드바와 같은 값이다.
  Future<List<ChannelPref>> channelPrefs() async =>
      _list(_obj(await _send('GET', '/channels/prefs'))['prefs'])
          .map(ChannelPref.fromJson)
          .toList(growable: false);

  /// 채널 자동 멘션(#173). 채널을 볼 수 있는 사람 누구나 읽는다 — 작성칸이 칩을 그려야 한다.
  Future<List<ChannelAutoMention>> channelAutoMentions(String channelId) async =>
      _list(_obj(await _send('GET', '/channels/$channelId/auto-mentions'))['autoMentions'])
          .map(ChannelAutoMention.fromJson)
          .toList(growable: false);

  // ── 메시지 ────────────────────────────────────────────────────────────

  /// 한 페이지를 읽는다.
  ///
  /// [before] 는 **역방향 커서**다(그 `seq` 보다 앞). 서버가 desc 로 잡아 오름차순으로
  /// 되돌려 주므로 받은 순서를 그대로 그리면 된다.
  /// [thread] 를 주면 **그 스레드의 답글**만 온다. 채널 목록에는 루트만 실리므로
  /// 답글은 스레드를 열 때 따로 읽는다.
  /// [around] 는 **점프 창**이다 — 그 `seq` 를 가운데 두고 앞뒤 절반씩 온다(데스크톱의
  /// 검색·링크 점프와 같은 인자). `before`·`since` 와는 서로 다른 방향이라 함께 주지 않는다.
  Future<MessagePage> messages(
    String channelId, {
    int? before,
    int? since,
    int? around,
    int? limit,
    String? thread,
  }) async {
    final q = <String, String>{
      if (before != null) 'before': '$before',
      if (since != null) 'since': '$since',
      if (around != null) 'around': '$around',
      if (limit != null) 'limit': '$limit',
      'thread': ?thread,
    };
    final qs = q.isEmpty ? '' : '?${Uri(queryParameters: q).query}';
    return MessagePage.fromJson(_obj(await _send('GET', '/channels/$channelId/messages$qs')));
  }

  /// 메시지 찾기(`GET /search`). 데스크톱 `SearchPalette` 와 **같은 라우트·같은 인자**다.
  ///
  /// 순서는 서버가 정한다(접두 일치 > ts_rank > 최신순) — 받은 순서를 그대로 그린다. 그래서
  /// 페이지는 seq 커서가 아니라 [offset] 이다(서버 천장 1000, `hasMore` 가 이미 그 천장을 안다).
  /// [threadRootId] 를 줄 때도 [channelId] 를 같이 준다 — 서버의 403 판정이 채널 단위다.
  ///
  /// [sort] 가 없으면 서버 기본(관련도)이다. 최신순이면 서버가 `created_at desc` 로 준다.
  Future<MessagePage> search(String query,
      {String? channelId, String? threadRootId, int offset = 0, SearchSort? sort}) async {
    final q = <String, String>{
      'q': query,
      'channelId': ?channelId,
      'threadRootId': ?threadRootId,
      if (offset > 0) 'offset': '$offset',
      if (sort != null) 'sort': sort.name,
    };
    return MessagePage.fromJson(_obj(await _send('GET', '/search?${Uri(queryParameters: q).query}')));
  }

  /// 링크(`harkroom://message/<id>`)가 가리키는 메시지 하나(#178 의 `GET /messages/:id`). 링크를 받은
  /// 사람은 채널을 모른다 — 그것을 알려 주는 것이 이 라우트다. 없으면 404, 못 보는 대화면 403.
  Future<MessageRow> message(String messageId) async =>
      MessageRow.fromJson(_obj(await _send('GET', '/messages/${Uri.encodeComponent(messageId)}')));

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

  /// 내 글을 고친다(`PATCH`). 서버가 작성자만 받는다 — 화면도 내 글에만 줄을 세운다.
  Future<MessageRow> editMessage(String channelId, String messageId, String body) async => MessageRow.fromJson(
      _obj(await _send('PATCH', '/channels/$channelId/messages/$messageId', body: {'body': body})));

  /// 지운다. 작성자 또는 admin 만 — 서버가 다시 본다.
  ///
  /// 답글이 남은 스레드 머리는 서버가 본문을 뗀 자리표시자로 남기고 **그 행을 200 으로** 돌려준다.
  /// 정말 사라졌으면 204 라 `null` 이다.
  Future<MessageRow?> deleteMessage(String channelId, String messageId) async {
    final res = await _send('DELETE', '/channels/$channelId/messages/$messageId');
    return res == null ? null : MessageRow.fromJson(_obj(res));
  }

  /// 스레드 답글을 채널에도 올린다(`PUT …/also-in-channel`). 멱등이다.
  Future<MessageRow> postToChannel(String channelId, String messageId) async => MessageRow.fromJson(
      _obj(await _send('PUT', '/channels/$channelId/messages/$messageId/also-in-channel')));

  /// 채널에 함께 올린 답글을 채널에서만 거둔다. 글은 스레드에 남는다.
  Future<MessageRow> recallFromChannel(String channelId, String messageId) async => MessageRow.fromJson(
      _obj(await _send('DELETE', '/channels/$channelId/messages/$messageId/also-in-channel')));

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

  /// 미리보기 서명 경로를 받는다(서버 0.3.131~, #1045). WebView 는 Bearer 헤더를 못 싣기 때문에 60초짜리
  /// 서명 경로를 받아 연다 — 토큰은 그 URL 에 없다. 열 때·다시 불러올 때마다 새로 받는다(만료는 오류가 아니다).
  Future<PreviewTicket> issuePreview(String attachmentId) async =>
      PreviewTicket.fromJson(_obj(await _send('POST', '/attachments/$attachmentId/preview')));

  /// 서명 경로 → WebView 에 넣을 절대 URL. 서버는 프록시 뒤라 자기 공개 주소를 모른다.
  String previewUrl(String path) => '$baseUrl$path';

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

  /// 여기부터 안 읽음. 읽음(`/read`)과 **다른 라우트**다 — 서버가 자동 전진과 사람의 표시를 가른다.
  /// 보내는 것은 그 메시지의 seq 다(그 메시지부터 안 읽은 것이 된다).
  Future<void> markUnread(String channelId, int seq) =>
      _send('PUT', '/channels/$channelId/unread', body: {'seq': seq});

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

  /// 묶음 카드의 한 줄에 답한다(선택 카드 P1) — 서버가 원본에 누른 사람 이름으로 적는다. 돌아오는 것은 묶음 행이다.
  Future<MessageRow> answerBundleItem(String channelId, String bundleId, String rootId, String optionId) async {
    final res = await _send(
      'POST',
      '/channels/$channelId/messages/$bundleId/ask-bundle/answer',
      body: {'rootId': rootId, 'optionId': optionId},
    );
    return MessageRow.fromJson(_obj(res));
  }

  /// 「남은 n개 추천대로」 — 묶음 행과 줄마다의 결과(답함·뺌과 그 까닭). 되돌릴 수 없는 줄은 서버가 뺀다.
  Future<(MessageRow, List<BundleAcceptResult>)> acceptRecommendedBundle(String channelId, String bundleId) async {
    final res = _obj(await _send(
      'POST',
      '/channels/$channelId/messages/$bundleId/ask-bundle/accept-recommended',
      body: const <String, Object?>{},
    ));
    final results = <BundleAcceptResult>[
      for (final r in (res['results'] as List? ?? const [])) ?BundleAcceptResult.fromJson(r),
    ];
    return (MessageRow.fromJson(_obj(res['message'])), results);
  }

  // ── 나중에 볼 메시지(#219) ─────────────────────────────────────────────

  /// 담아 둔 메시지(새로 담은 것 먼저). 경로에 남의 계정이 없다 — 서버가 토큰의 주인 것만 준다.
  Future<List<SavedEntry>> savedMessages(SavedState state) async {
    final body = _obj(await _send('GET', '/saved?state=${state.name}'));
    return _list(body['entries']).map(SavedEntry.fromJson).toList(growable: false);
  }

  Future<SavedSummary> savedSummary() async => SavedSummary.fromJson(_obj(await _send('GET', '/saved/summary')));

  /// 담는다. 이미 담겨 있으면 서버가 할 것으로 되돌린다(행은 하나). 지운 글은 404, 볼 수 없는 글은 403.
  Future<void> saveMessage(String messageId) => _send('PUT', '/saved/$messageId');

  Future<void> setSavedState(String messageId, SavedState state) =>
      _send('PATCH', '/saved/$messageId', body: {'state': state.name});

  Future<void> unsaveMessage(String messageId) => _send('DELETE', '/saved/$messageId');

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

/// 찾기 결과 순서. 이름이 곧 서버 `GET /search?sort=` 의 값이다(`relevance` | `recent`).
enum SearchSort { relevance, recent }
