import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';

/// 시스템 줄 C안 c4 — 인박스 항목이 시스템 줄인지 알아야 이름을 앞에 달지 않는다.
void main() {
  Map<String, Object?> j([String? kind]) => {
        'id': 1, 'messageId': 'm1', 'reason': 'thread_reply', 'channelId': 'c1', 'authorId': 'u1',
        'body': 'x', 'createdAt': '2026-10-24T00:00:00Z', 'threadRootId': null, 'readAt': null,
        'kind': ?kind,
      };

  test('kind system 이면 system, 없으면(옛 서버) 일반 글, 읽음 사본도 이어 받는다', () {
    final sys = InboxEntry.fromJson(j('system'));
    expect(sys.system, isTrue);
    expect(sys.withReadAt('2026-10-24T00:01:00Z').system, isTrue);
    expect(InboxEntry.fromJson(j()).system, isFalse);
    expect(InboxEntry.fromJson(j('user')).system, isFalse);
  });
}
