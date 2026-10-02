import '../session/session_store.dart';

/// 알림을 눌렀을 때 갈 곳. [resolvePushTarget] 만 만든다.
class PushTarget {
  const PushTarget({required this.communityKey, required this.channelId, this.threadRootId});
  final String communityKey;
  final String channelId;
  final String? threadRootId;
}

final _uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', caseSensitive: false);

/// 알림의 `hk` 를 저장된 커뮤니티와 맞춰 갈 곳을 정한다. **못 정하면 `null` — 아무것도 하지 않는다.**
///
/// - `hk` 는 Apple 을 지나 온 값이다. 믿지 않는다: 버전·id 모양이 다르면 버린다.
/// - 커뮤니티는 **계정 id 하나로만** 고른다. 서버는 주소(origin)를 싣지 않는다 — 앱이 그 값을 요청
///   주소로 쓸 길을 아예 두지 않는다. 요청은 언제나 저장해 둔 커뮤니티의 주소·토큰으로 간다.
/// - 그 계정 id 를 가진 저장 커뮤니티가 **딱 하나**일 때만 간다. 없으면(지운 커뮤니티) 무시하고,
///   둘 이상이면(한 서버 DB 를 다른 서버로 복원한 경우 등) 어느 쪽인지 추측하지 않는다(security #1070).
PushTarget? resolvePushTarget(Map<String, Object?> hk, List<StoredCommunity> communities) {
  if (hk['v'] != 1) return null;
  final accountId = hk['accountId'];
  final channelId = hk['channelId'];
  final root = hk['threadRootId'];
  if (accountId is! String || !_uuid.hasMatch(accountId)) return null;
  if (channelId is! String || !_uuid.hasMatch(channelId)) return null;
  if (root != null && (root is! String || !_uuid.hasMatch(root))) return null;
  final matches = communities.where((c) => c.accountId.toLowerCase() == accountId.toLowerCase()).toList();
  if (matches.length != 1) return null;
  return PushTarget(communityKey: matches.single.key, channelId: channelId, threadRootId: root as String?);
}
