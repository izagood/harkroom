import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/screens/system_line.dart';

/// 러너 알림 줄(2026-11-02, designer 1·2) — 사람 멘션의 상태라 기록 줄이다. 데스크톱 `systemLineShape.test.tsx` 와 같은 판정.
MessageRow _runner(String key, Map<String, Object?> args) => MessageRow.fromJson({
      'id': 'm1',
      'seq': 1,
      'channelId': 'c1',
      'authorId': 'a1',
      'body': 'x',
      'kind': 'system',
      'meta': {
        'i18n': {'key': key, 'args': args},
      },
    });

void main() {
  test('러너 알림 줄은 기록 줄 — 대기는 ⏳, 넘겨받음은 ↪', () {
    final blocked = _runner('system.runner.blockedByTurn', {'agentId': 'a1'});
    final fenced = _runner('system.runner.fenced', {'agentId': 'a1'});
    final owner = _runner('system.runner.controlledByOwner', {'agentId': 'a1', 'pending': 1});
    final controlled = _runner('system.runner.controlled', {'agentId': 'a1', 'handle': 'h', 'pending': 2});
    for (final m in [blocked, fenced, owner, controlled]) {
      expect(systemLineShape(m), SystemLineShape.record);
    }
    expect(systemRecordIcon(blocked), '⏳');
    expect(systemRecordIcon(controlled), '⏳');
    expect(systemRecordIcon(owner), '⏳');
    expect(systemRecordIcon(fenced), '↪');
  });
}
