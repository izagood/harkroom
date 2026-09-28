import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/agent_meta.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/screens/message_feed.dart';

MessageRow _msg(int seq, MessageKind kind, {String author = 'a1', String body = 'x'}) =>
    MessageRow.fromJson({
      'id': 'm$seq',
      'seq': seq,
      'channelId': 'c1',
      'authorId': author,
      'body': body,
      'kind': switch (kind) {
        MessageKind.progress => 'progress',
        MessageKind.wake => 'wake',
        MessageKind.system => 'system',
        MessageKind.user => 'user',
      },
    });

void main() {
  group('보고', () {
    test('checks 가 비면 카드가 아니다 — 빈 상자는 거짓 신호다', () {
      expect(ReportMeta.read({'kind': 'report', 'report': {'checks': <Object?>[]}}), isNull);
      expect(ReportMeta.read({'kind': 'report', 'report': {'checks': ['  ', '']}}), isNull);
    });

    test('checks 만 있어도 보고다 — 바꾼 파일이 없는 작업도 있다', () {
      final r = ReportMeta.read({'kind': 'report', 'report': {'checks': ['시험 돌림']}});
      expect(r!.checks, ['시험 돌림']);
      expect(r.files, isEmpty);
      expect(r.duration, isNull);
    });

    test('남은 것과 다음 후보를 읽는다', () {
      final r = ReportMeta.read({
        'kind': 'report',
        'report': {
          'checks': ['a'],
          'remaining': ['b'],
          'durationMs': 65000,
          'next': [
            {'id': 'n1', 'label': '이어서 할까'},
            {'id': '', 'label': '형식이 깨진 것'},
          ],
        },
      });
      expect(r!.remaining, ['b']);
      expect(r.duration, const Duration(milliseconds: 65000));
      expect(r.next.map((n) => n.id), ['n1']);
    });
  });

  group('실패', () {
    test('retryable 을 모르면 **다시 해 볼 수 있다고 말하지 않는다**', () {
      // 헛된 재시도를 권하는 쪽이 손이 필요하다고 말하는 쪽보다 나쁘다.
      final f = FailureMeta.read({'kind': 'failure', 'failure': {'what': '깨짐'}});
      expect(f!.retryable, isFalse);
    });

    test('사유를 읽는다', () {
      final f = FailureMeta.read({
        'kind': 'failure',
        'failure': {'what': '빌드', 'reason': '타입 오류', 'retryable': true},
      });
      expect(f!.what, '빌드');
      expect(f.reason, '타입 오류');
      expect(f.retryable, isTrue);
    });
  });

  group('대기', () {
    test('시각이 없거나 깨졌으면 대기 줄이 아니다 — 평문으로 흘린다', () {
      expect(WakeMeta.read({'kind': 'wake', 'wake': <String, Object?>{}}), isNull);
      expect(WakeMeta.read({'kind': 'wake', 'wake': {'wakeAt': '시각이 아님'}}), isNull);
    });

    test('ISO 시각을 UTC 로 읽는다 — 서버가 문자열을 굽지 않는 이유다', () {
      final w = WakeMeta.read({
        'kind': 'wake',
        'wake': {'wakeAt': '2026-09-28T12:00:00.000Z', 'reason': 'CI 보려고'},
      });
      expect(w!.wakeAt.isUtc, isTrue);
      expect(w.reason, 'CI 보려고');
    });
  });

  group('진행은 이어진 것끼리 접힌다', () {
    test('연달아 오면 한 묶음', () {
      final feed = buildFeed([
        _msg(1, MessageKind.user),
        _msg(2, MessageKind.progress),
        _msg(3, MessageKind.progress),
      ]);
      expect(feed.length, 2);
      expect((feed[1] as FeedProgressRun).run.map((m) => m.seq), [2, 3]);
    });

    test('사이에 다른 말이 끼면 묶음이 끊긴다', () {
      // 그래야 "이 진행이 무엇 뒤에 일어난 일인가"가 순서로 남는다.
      final feed = buildFeed([
        _msg(1, MessageKind.progress),
        _msg(2, MessageKind.user),
        _msg(3, MessageKind.progress),
      ]);
      expect(feed.length, 3);
      expect(feed[0], isA<FeedProgressRun>());
      expect(feed[1], isA<FeedMessage>());
      expect(feed[2], isA<FeedProgressRun>());
    });

    test('작성자가 바뀌면 묶음이 끊긴다 — 누가 무엇을 하는지 사라지면 안 된다', () {
      final feed = buildFeed([
        _msg(1, MessageKind.progress, author: 'forge'),
        _msg(2, MessageKind.progress, author: 'codex'),
      ]);
      expect(feed.length, 2);
      expect((feed[0] as FeedProgressRun).run.single.authorId, 'forge');
      expect((feed[1] as FeedProgressRun).run.single.authorId, 'codex');
    });

    test('진행만 있는 스레드도 빈 것이 아니다', () {
      // P1 까지는 이걸 버려서 오래 도는 스레드가 조용해 보였다.
      final feed = buildFeed([_msg(1, MessageKind.progress)]);
      expect(feed, hasLength(1));
    });

    test('빈 목록은 빈 줄', () {
      expect(buildFeed(const []), isEmpty);
    });
  });
}
