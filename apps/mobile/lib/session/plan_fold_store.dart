import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 계획판에서 **사람이 직접** 접거나 편 그룹 — `{스레드 id: {그룹 id: 접힘}}`. **이 기기에만** 둔다(커뮤니티마다 따로).
///
/// 키체인에 두는 이유는 [RecentSearchStore] 와 같다 — 이 앱에는 다른 기기 저장소가 없고 의존성을 하나 더 들이지 않는다.
/// 읽기·쓰기 실패는 **삼킨다** — 기억이 비면 기본값(다 끝난 그룹만 접힘)으로 열 뿐이다.
abstract class PlanFoldStore {
  const PlanFoldStore();

  factory PlanFoldStore.keychain() = KeychainPlanFoldStore;

  factory PlanFoldStore.inMemory() = MemoryPlanFoldStore;

  Future<Map<String, Map<String, bool>>> load(String communityKey);

  Future<void> save(String communityKey, Map<String, Map<String, bool>> folds);

  /// 로그아웃할 때 지운다 — 내용은 없지만 연 스레드 id 가 기기에 남지 않게(데스크톱 `clearPlanOpenKeys` 와 같다).
  Future<void> delete(String communityKey);
}

/// 저장된 꼴을 믿지 않고 고른다 — 문자열 키·bool 값만 남긴다.
Map<String, Map<String, bool>> parsePlanFolds(Object? v) {
  if (v is! Map) return {};
  final out = <String, Map<String, bool>>{};
  v.forEach((root, groups) {
    if (root is! String || groups is! Map) return;
    final g = <String, bool>{};
    groups.forEach((id, folded) {
      if (id is String && folded is bool) g[id] = folded;
    });
    if (g.isNotEmpty) out[root] = g;
  });
  return out;
}

class KeychainPlanFoldStore extends PlanFoldStore {
  KeychainPlanFoldStore();

  static const _options = IOSOptions(accessibility: KeychainAccessibility.first_unlock);
  final _storage = const FlutterSecureStorage();

  String _key(String communityKey) => 'harkroom.plan.folds.$communityKey';

  @override
  Future<Map<String, Map<String, bool>>> load(String communityKey) async {
    try {
      final raw = await _storage.read(key: _key(communityKey), iOptions: _options);
      return raw == null ? {} : parsePlanFolds(jsonDecode(raw));
    } on Object {
      return {};
    }
  }

  @override
  Future<void> save(String communityKey, Map<String, Map<String, bool>> folds) async {
    try {
      await _storage.write(key: _key(communityKey), value: jsonEncode(folds), iOptions: _options);
    } on Object {
      /* 못 쓰면 다음에 기본값으로 연다 */
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

class MemoryPlanFoldStore extends PlanFoldStore {
  MemoryPlanFoldStore();

  final Map<String, Map<String, Map<String, bool>>> values = {};

  @override
  Future<Map<String, Map<String, bool>>> load(String communityKey) async =>
      {for (final e in (values[communityKey] ?? const {}).entries) e.key: {...e.value}};

  @override
  Future<void> save(String communityKey, Map<String, Map<String, bool>> folds) async =>
      values[communityKey] = {for (final e in folds.entries) e.key: {...e.value}};

  @override
  Future<void> delete(String communityKey) async => values.remove(communityKey);
}
