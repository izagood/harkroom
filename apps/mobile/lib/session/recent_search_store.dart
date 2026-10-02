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
}

class KeychainRecentSearchStore extends RecentSearchStore {
  KeychainRecentSearchStore();

  static const _options = IOSOptions(accessibility: KeychainAccessibility.first_unlock);
  final _storage = const FlutterSecureStorage();

  String _key(String communityKey) => 'harkroom.search.recent.$communityKey';

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
}

class MemoryRecentSearchStore extends RecentSearchStore {
  MemoryRecentSearchStore();

  final Map<String, List<String>> values = {};

  @override
  Future<List<String>> load(String communityKey) async => values[communityKey] ?? const [];

  @override
  Future<void> save(String communityKey, List<String> queries) async => values[communityKey] = queries;
}
