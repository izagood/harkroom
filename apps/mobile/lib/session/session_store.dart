/// 세션 보관. iOS 에서는 **Keychain** 에 들어간다.
///
/// 데스크탑 `packages/desktop/src/lib/session.ts` 의 판단을 그대로 베낀다. 베끼는 것이
/// 모양이 아니라 **왜 그 모양인가** 라서, 그 근거를 여기 다시 적는다.
///
/// ## 키는 **(서버 origin, 계정 id)** 다
///
/// 계정 id 는 서버가 `/auth/me` 로 **스스로 대는 값**이다. id 만 열쇠로 두면 낯선 서버 B 가 기존
/// 커뮤니티 A 의 id 를 대는 것만으로 A 의 행(토큰·붙인 이름)을 차지한다 — 사람은 「회사」 행에 쓴다고
/// 믿고 B 에 쓴다(security #1046 F1). 그래서 origin 까지 같아야 같은 행이다.
///
/// 대가: 같은 서버를 다른 주소(사내망 이름과 공개 도메인)로 들어가면 행이 둘 선다. 주소가 다르면
/// 다른 서버일 수 있다는 쪽을 택했다 — 둘 중 하나를 로그아웃하면 된다.
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

  /// 서버 DB 의 계정 UUID. **혼자서는 열쇠가 아니다** — [key] 를 쓴다.
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

  /// `scheme://host[:port]`. 못 읽는 주소면 주소 그대로다.
  String get origin {
    final u = Uri.tryParse(baseUrl);
    if (u == null || !u.hasScheme || u.host.isEmpty) return baseUrl;
    return u.hasPort ? '${u.scheme}://${u.host}:${u.port}' : '${u.scheme}://${u.host}';
  }

  /// **목록의 열쇠** — (origin, 계정 id). 화면·상태·보관소가 모두 이것으로 행을 가리킨다.
  String get key => '$origin#$accountId';

  /// 토큰이 죽어 다시 로그인해야 하는 커뮤니티. **목록에서 빼지 않는다** — 빼면 사람은
  /// 그 커뮤니티가 있었다는 것조차 잊고, 서버 주소를 처음부터 다시 쳐야 한다. 토큰만 비워
  /// 「다시 로그인」 행으로 남긴다(designer 판정 2).
  bool get isExpired => token.isEmpty;

  /// 화면에 세울 이름 — 붙인 이름이 없으면 호스트명이다(데스크탑 레일과 같다).
  String get displayLabel {
    final l = label?.trim();
    if (l != null && l.isNotEmpty) return l;
    return Uri.tryParse(baseUrl)?.host.nullIfEmpty ?? baseUrl;
  }

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

  /// 마지막으로 쓰던 커뮤니티의 [StoredCommunity.key]. 없으면 첫 번째로 떨어진다.
  /// 옛 저장본은 계정 id 만 담았다 — [current] 가 그것도 알아본다.
  final String? active;
  final List<StoredCommunity> communities;

  bool get isEmpty => communities.isEmpty;

  /// 지금 열 커뮤니티. `active` 가 가리키는 것이 사라졌으면 첫 번째다 —
  /// **고아 포인터로 빈 화면을 띄우지 않는다.**
  StoredCommunity? get current {
    if (communities.isEmpty) return null;
    for (final c in communities) {
      if (c.key == active) return c;
    }
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
  Future<void> remove(String key) async {
    final current = await load();
    if (current == null) return;
    final rest = current.communities.where((c) => c.key != key).toList(growable: false);
    if (rest.isEmpty) return clear();
    await save(StoredSessions(
      active: current.current?.key == key ? null : current.active,
      communities: rest,
    ));
  }

  /// 커뮤니티 하나를 고친다(토큰 비우기·이름 붙이기). **`active` 는 건드리지 않는다** —
  /// 다른 커뮤니티의 이름을 고쳤다고 지금 보던 커뮤니티가 바뀌면 안 된다.
  Future<StoredSessions?> update(
      String key, StoredCommunity Function(StoredCommunity) change) async {
    final current = await load();
    if (current == null) return null;
    final idx = current.communities.indexWhere((c) => c.key == key);
    if (idx < 0) return current;
    final next = [...current.communities];
    next[idx] = change(next[idx]);
    final sessions = StoredSessions(active: current.active, communities: next);
    await save(sessions);
    return sessions;
  }

  /// 지금 쓰는 커뮤니티를 바꾼다. 없는 id 면 그대로 둔다.
  Future<StoredSessions?> setActive(String key) async {
    final current = await load();
    if (current == null || current.communities.every((c) => c.key != key)) {
      return current;
    }
    final sessions = StoredSessions(active: key, communities: current.communities);
    await save(sessions);
    return sessions;
  }

  /// 커뮤니티 하나를 더하거나 덮어쓴다.
  ///
  /// 같은 열쇠(origin + 계정 id)면 **자리를 지키며 갱신한다** — 뒤로 밀면 다시 로그인할 때마다 목록
  /// 순서가 바뀌고, 사람은 자기가 무엇을 건드렸는지 모른다.
  Future<StoredSessions> upsert(StoredCommunity community) async {
    final current = await load() ?? const StoredSessions(active: null, communities: []);
    // 같은 계정 id 라도 origin 이 다르면 **새 행**이다 — 기존 행의 토큰·주소·이름을 건드리지 않는다.
    final idx = current.communities.indexWhere((c) => c.key == community.key);
    final next = [...current.communities];
    if (idx >= 0) {
      // 다시 로그인한 것이면 이 기기에서 붙인 이름을 지킨다 — 로그인 응답에는 이름이 없다.
      next[idx] = community.label == null
          ? community.copyWith(label: next[idx].label)
          : community;
    } else {
      next.add(community);
    }
    final sessions = StoredSessions(active: community.key, communities: next);
    await save(sessions);
    return sessions;
  }
}

const String _key = 'harkroom.sessions';

extension on String {
  String? get nullIfEmpty => isEmpty ? null : this;
}

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
