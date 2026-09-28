/// 세션 보관. iOS 에서는 **Keychain** 에 들어간다.
///
/// 데스크탑 `packages/desktop/src/lib/session.ts` 의 판단을 그대로 베낀다. 베끼는 것이
/// 모양이 아니라 **왜 그 모양인가** 라서, 그 근거를 여기 다시 적는다.
///
/// ## 키는 **계정 id** 다. URL 이 아니다
///
/// 같은 서버가 여러 주소로 닿을 수 있다(사내망 이름, 공개 도메인, 포트 다른 것). URL 로
/// 키를 두면 **같은 커뮤니티가 목록에 두 번 선다.** 계정 id 는 서버 DB 의 UUID 라 어느
/// 주소로 들어가든 같고, 다른 서버와는 다르다.
///
/// ## 저장에 실패하면 **평문으로 내려가지 않는다**
///
/// 키체인을 쓰겠다고 해놓고 조용히 평문이 되는 것이 더 나쁘다. 대신 **아무에게도 말하지
/// 않는 것**을 고친다: 세션이 어디에도 없는데 화면은 로그인 상태라, 사람은 다음 기동에
/// 로그아웃되고 이유를 알 방법이 없다. 그래서 실패를 [SessionSaveFailure] 로 던지고,
/// 부르는 쪽이 그것을 화면에 세운다. 이번 실행은 메모리의 세션으로 계속된다 — 로그인을
/// 막지는 않는다.
///
/// 재시도는 넣지 않는다. 키체인 잠김은 사람이 풀어야 하는 것이고, 조용한 재시도는 실패를
/// 다시 숨긴다.
library;

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 이 기기에 보관된 커뮤니티 하나.
class StoredCommunity {
  const StoredCommunity({
    required this.accountId,
    required this.baseUrl,
    required this.token,
    required this.handle,
    this.label,
  });

  /// **목록의 열쇠.** 서버 DB 의 UUID 다.
  final String accountId;
  final String baseUrl;
  final String token;
  final String handle;

  /// 이 기기에서 붙인 표시 이름. **`null` 이 "붙이지 않았다"** 이고, 그때 화면은
  /// 호스트명으로 떨어진다. 서버에 보내지 않는다.
  final String? label;

  Map<String, Object?> toJson() => {
        'accountId': accountId,
        'baseUrl': baseUrl,
        'token': token,
        'handle': handle,
        'label': label,
      };

  /// 나중에 생긴 필드(`label`)는 옛 저장본에 없다. 그것을 그대로 흘리면 타입이 거짓이
  /// 되므로 여기서 채운다 — "이름 없음"과 "필드 없음"이 코드 안에서 갈리지 않게.
  static StoredCommunity fromJson(Map<String, Object?> j) => StoredCommunity(
        accountId: j['accountId'] as String? ?? '',
        baseUrl: j['baseUrl'] as String? ?? '',
        token: j['token'] as String? ?? '',
        handle: j['handle'] as String? ?? '',
        label: j['label'] as String?,
      );

  StoredCommunity copyWith({String? handle, String? token, String? label, bool clearLabel = false}) =>
      StoredCommunity(
        accountId: accountId,
        baseUrl: baseUrl,
        token: token ?? this.token,
        handle: handle ?? this.handle,
        label: clearLabel ? null : (label ?? this.label),
      );
}

/// 보관본 전체.
class StoredSessions {
  const StoredSessions({required this.active, required this.communities});

  /// 마지막으로 쓰던 커뮤니티의 계정 id. 없으면 첫 번째로 떨어진다.
  final String? active;
  final List<StoredCommunity> communities;

  bool get isEmpty => communities.isEmpty;

  /// 지금 열 커뮤니티. `active` 가 가리키는 것이 사라졌으면 첫 번째다 —
  /// **고아 포인터로 빈 화면을 띄우지 않는다.**
  StoredCommunity? get current {
    if (communities.isEmpty) return null;
    for (final c in communities) {
      if (c.accountId == active) return c;
    }
    return communities.first;
  }

  Map<String, Object?> toJson() => {
        'active': active,
        'communities': communities.map((c) => c.toJson()).toList(growable: false),
      };

  static StoredSessions? fromRaw(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final list = decoded['communities'];
      if (list is! List) return null;
      return StoredSessions(
        active: decoded['active'] as String?,
        communities: list
            .whereType<Map>()
            .map((e) => StoredCommunity.fromJson(Map<String, Object?>.from(e)))
            .toList(growable: false),
      );
    } on FormatException {
      // 깨진 보관본은 **없는 것으로 친다.** 여기서 던지면 앱이 아예 못 뜨고, 사람에게는
      // 지울 방법도 없다(설정 화면에 닿지 못한다).
      return null;
    }
  }
}

/// 키체인에 쓰지 못했다. 부르는 쪽이 사람에게 말해야 한다 — 삼키지 마라.
class SessionSaveFailure implements Exception {
  SessionSaveFailure(this.cause);
  final Object cause;

  @override
  String toString() => 'SessionSaveFailure: $cause';
}

/// 보관소. 시험이 [SessionStore.inMemory] 로 바꿔 끼운다 — 키체인은 시험 환경에 없다.
///
/// `load`·`save`·`clear` 만 구현하면 된다. [remove]·[upsert] 는 그 셋으로 짜여 있어서
/// **구현마다 같은 문장을 두 벌 갖지 않는다** — 두 벌이면 반드시 갈라진다.
abstract class SessionStore {
  const SessionStore();

  factory SessionStore.keychain() = KeychainSessionStore;

  /// 시험용. 키체인 없이 같은 규약으로 돈다. [failWrites] 로 "키체인이 잠긴" 상황을 만든다.
  factory SessionStore.inMemory({String? seed, bool failWrites}) = MemorySessionStore;

  Future<StoredSessions?> load();

  /// 실패하면 [SessionSaveFailure] 를 던진다. **평문으로 내려가지 않는다.**
  Future<void> save(StoredSessions sessions);

  Future<void> clear();

  /// 커뮤니티 하나만 뺀다.
  ///
  /// 하나가 죽었다고 나머지 토큰까지 지우면, 이 설계가 막으려던 것("셋 중 하나가 죽었는데
  /// 전부 잃는다")의 데이터 버전이 된다. 지운 것이 활성이었으면 `active` 를 비운다 —
  /// 다음 기동이 첫 커뮤니티로 떨어진다.
  Future<void> remove(String accountId) async {
    final current = await load();
    if (current == null) return;
    final rest = current.communities.where((c) => c.accountId != accountId).toList(growable: false);
    if (rest.isEmpty) return clear();
    await save(StoredSessions(
      active: current.active == accountId ? null : current.active,
      communities: rest,
    ));
  }

  /// 커뮤니티 하나를 더하거나 덮어쓴다.
  ///
  /// 같은 계정 id 면 **자리를 지키며 갱신한다** — 뒤로 밀면 다시 로그인할 때마다 목록
  /// 순서가 바뀌고, 사람은 자기가 무엇을 건드렸는지 모른다.
  Future<StoredSessions> upsert(StoredCommunity community) async {
    final current = await load() ?? const StoredSessions(active: null, communities: []);
    final idx = current.communities.indexWhere((c) => c.accountId == community.accountId);
    final next = [...current.communities];
    if (idx >= 0) {
      next[idx] = community;
    } else {
      next.add(community);
    }
    final sessions = StoredSessions(active: community.accountId, communities: next);
    await save(sessions);
    return sessions;
  }
}

const String _key = 'harkroom.sessions';

class KeychainSessionStore extends SessionStore {
  KeychainSessionStore();

  /// `first_unlock`: 기기가 한 번 잠금 해제된 뒤에야 읽힌다.
  ///
  /// 기본값(`unlocked`)이면 화면이 잠긴 동안 백그라운드에서 깨어난 코드가 세션을 **못
  /// 읽는데**, 그때 앱은 그것을 "로그아웃"으로 오해한다. 푸시를 붙이면(다음 단계) 바로
  /// 그 경로가 생기므로 지금 정해 둔다.
  static const _options = IOSOptions(accessibility: KeychainAccessibility.first_unlock);
  final _storage = const FlutterSecureStorage();

  @override
  Future<StoredSessions?> load() async {
    try {
      return StoredSessions.fromRaw(await _storage.read(key: _key, iOptions: _options));
    } on Object {
      // 읽기 실패는 "세션이 없다"로 떨어진다 — 다시 로그인하면 된다. 여기서 던지면
      // 앱이 부팅 중에 죽고, 사람에게는 되돌릴 방법이 없다.
      return null;
    }
  }

  @override
  Future<void> save(StoredSessions sessions) async {
    try {
      await _storage.write(key: _key, value: jsonEncode(sessions.toJson()), iOptions: _options);
    } on Object catch (e) {
      throw SessionSaveFailure(e);
    }
  }

  @override
  Future<void> clear() async {
    try {
      await _storage.delete(key: _key, iOptions: _options);
    } on Object {
      // 못 지우면 다음 기동에 다시 시도된다.
    }
  }
}

class MemorySessionStore extends SessionStore {
  MemorySessionStore({String? seed, this.failWrites = false}) : _raw = seed;

  String? _raw;
  final bool failWrites;

  @override
  Future<StoredSessions?> load() async => StoredSessions.fromRaw(_raw);

  @override
  Future<void> save(StoredSessions sessions) async {
    if (failWrites) throw SessionSaveFailure(StateError('키체인 잠김(시험)'));
    _raw = jsonEncode(sessions.toJson());
  }

  @override
  Future<void> clear() async => _raw = null;
}
