import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 최근 찾은 말. **이 기기에만** 둔다(서버로 보내지 않는다) — 커뮤니티마다 따로.
///
/// 키체인에 두는 이유: 이 앱에는 다른 기기 저장소가 없고(의존성을 하나 더 들이지 않는다), 찾은 말은
/// 사람이 무엇을 찾았는지라 평문 파일보다 키체인이 맞다. 읽기·쓰기 실패는 **삼킨다** — 최근 목록이
/// 비는 것이 화면이 죽는 것보다 낫다.
abstract class RecentSearchStore {
  const RecentSearchStore();

  factory RecentSearchStore.keychain() = KeychainRecentSearchStore;

  factory RecentSearchStore.inMemory() = MemoryRecentSearchStore;

  Future<List<String>> load(String communityKey);

  Future<void> save(String communityKey, List<String> queries);

  /// 그 커뮤니티의 것을 지운다 — 로그아웃할 때. iOS 키체인은 앱을 지워도 남으므로 안 지우면 무엇을
  /// 찾았는지가 기기에 계속 남는다(security #1094 F1).
  Future<void> delete(String communityKey);

  /// 마지막에 고른 찾기 순서(`relevance` | `recent`). **기기에 하나** — 커뮤니티·범위와 상관없다
  /// (designer 찾기 정렬 안 A). 없거나 못 읽으면 null.
  Future<String?> loadSort();

  Future<void> saveSort(String sort);
}

class KeychainRecentSearchStore extends RecentSearchStore {
  KeychainRecentSearchStore();

  static const _options = IOSOptions(accessibility: KeychainAccessibility.first_unlock);
  final _storage = const FlutterSecureStorage();

  String _key(String communityKey) => 'harkroom.search.recent.$communityKey';

  static const _sortKey = 'harkroom.search.sort';

  @override
  Future<String?> loadSort() async {
    try {
      return await _storage.read(key: _sortKey, iOptions: _options);
    } on Object {
      return null;
    }
  }

  @override
  Future<void> saveSort(String sort) async {
    try {
      await _storage.write(key: _sortKey, value: sort, iOptions: _options);
    } on Object {
      /* 최근 찾은 말과 같다 — 못 쓰면 다음에 기본값으로 연다 */
    }
  }

  @override
  Future<List<String>> load(String communityKey) async {
    try {
      final raw = await _storage.read(key: _key(communityKey), iOptions: _options);
      if (raw == null) return const [];
      final v = jsonDecode(raw);
      return v is List ? v.whereType<String>().toList(growable: false) : const [];
    } on Object {
      return const [];
    }
  }

  @override
  Future<void> save(String communityKey, List<String> queries) async {
    try {
      await _storage.write(key: _key(communityKey), value: jsonEncode(queries), iOptions: _options);
    } on Object {
      /* 위와 같다 */
    }
  }

  @override
  Future<void> delete(String communityKey) async {
    try {
      await _storage.delete(key: _key(communityKey), iOptions: _options);
    } on Object {
      /* 위와 같다 */
    }
  }
}

class MemoryRecentSearchStore extends RecentSearchStore {
  MemoryRecentSearchStore();

  final Map<String, List<String>> values = {};

  @override
  Future<List<String>> load(String communityKey) async => values[communityKey] ?? const [];

  @override
  Future<void> save(String communityKey, List<String> queries) async => values[communityKey] = queries;

  @override
  Future<void> delete(String communityKey) async => values.remove(communityKey);

  String? sort;

  @override
  Future<String?> loadSort() async => sort;

  @override
  Future<void> saveSort(String sort) async => this.sort = sort;
}
