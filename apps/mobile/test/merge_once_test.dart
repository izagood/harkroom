import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/screens/merge_once_note.dart';

// 머지 거절에서 온 권한 카드의 [이번 한 번 머지](스레드 1b75d7a0) — 모바일은 「데스크톱에서」 시트만 연다.
// 버튼이 서는 조건: 머지 권한 카드 · 거절에서 옴(once) · 내가 소유자 · 아직 기다리는 중.
void main() {
  Map<String, Object?> meta({String kind = 'merge', String owner = 'me', String? status, Object? once = const {'number': 42, 'headSha': 'a'}}) => {
        'permissionRequest': {
          'kind': kind,
          'ownerAccountId': owner,
          'status': ?status,
          'once': ?once,
        },
      };

  test('소유자이고 기다리는 거절발 머지 카드면 PR 번호', () {
    expect(MergeOnceNote.pendingNumber(meta(), 'me'), 42);
    expect(MergeOnceNote.pendingNumber(meta(status: 'pending'), 'me'), 42);
  });

  test('그 밖이면 서지 않는다', () {
    expect(MergeOnceNote.pendingNumber(meta(owner: 'someone'), 'me'), isNull);
    expect(MergeOnceNote.pendingNumber(meta(), null), isNull);
    expect(MergeOnceNote.pendingNumber(meta(kind: 'tool'), 'me'), isNull);
    expect(MergeOnceNote.pendingNumber(meta(once: null), 'me'), isNull);
    expect(MergeOnceNote.pendingNumber(meta(status: 'approved_once'), 'me'), isNull);
    expect(MergeOnceNote.pendingNumber(meta(status: 'granted'), 'me'), isNull);
    expect(MergeOnceNote.pendingNumber(const {}, 'me'), isNull);
  });
}
