import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/ws.dart';

/// 시험이 바꿔 끼우는 소켓. 열린 뒤 프레임을 밀어 넣고, 원하는 코드로 닫는다.
class FakeConnection implements WsConnection {
  FakeConnection({this.closeCode});

  final _ctrl = StreamController<String>();
  final sent = <String>[];

  @override
  int? closeCode;

  @override
  Stream<String> get messages => _ctrl.stream;

  @override
  void send(String payload) => sent.add(payload);

  @override
  Future<void> close() async {
    if (!_ctrl.isClosed) await _ctrl.close();
  }

  void push(String raw) => _ctrl.add(raw);
  Future<void> serverClosed(int code) async {
    closeCode = code;
    await _ctrl.close();
  }
}

/// 상태 코드를 들고 있는 오류. `ws.dart` 는 이것을 덕타이핑으로 읽는다.
class _StatusError implements Exception {
  _StatusError(this.status);
  final int status;
}

void main() {
  group('백오프', () {
    test('1초에서 두 배씩, 15초에서 멈춘다', () {
      var d = initialBackoff;
      expect(d, const Duration(seconds: 1));
      final seen = <int>[];
      for (var i = 0; i < 6; i++) {
        d = nextBackoff(d);
        seen.add(d.inSeconds);
      }
      expect(seen, [2, 4, 8, 15, 15, 15]);
    });
  });

  group('끊긴 이유를 가른다', () {
    test('티켓이 401 이면 재시도하지 않고 credential 로 포기한다', () async {
      final downs = <WsDownReason>[];
      var connectCalls = 0;
      final client = WsClient(
        baseUrl: 'https://h.example.com',
        getTicket: () async => throw _StatusError(401),
        connect: (_) async {
          connectCalls++;
          return FakeConnection();
        },
        onDown: downs.add,
        sleep: (_) async {},
      );

      await client.start();

      expect(downs, [WsDownReason.credential]);
      // **연결을 시도조차 하지 않는다** — 티켓이 없으면 열 수 없다.
      expect(connectCalls, 0);
    });

    test('티켓이 상태 코드 없는 실패면 네트워크로 보고 다시 시도한다', () async {
      final downs = <WsDownReason>[];
      var attempts = 0;
      late WsClient client;
      client = WsClient(
        baseUrl: 'https://h.example.com',
        getTicket: () async {
          attempts++;
          // 세 번 튕기고 나면 명시 종료해서 루프를 끝낸다(무한 재시도가 이 설계다).
          if (attempts >= 3) {
            await client.close();
          }
          throw Exception('DNS 실패');
        },
        connect: (_) async => FakeConnection(),
        onDown: downs.add,
        sleep: (_) async {},
      );

      await client.start();

      expect(attempts, greaterThanOrEqualTo(3));
      expect(downs.every((d) => d == WsDownReason.network), isTrue);
      expect(downs, isNotEmpty);
    });

    test('서버가 4401 로 끊으면 재연결하지 않는다', () async {
      final downs = <WsDownReason>[];
      final conn = FakeConnection();
      var connectCalls = 0;
      final client = WsClient(
        baseUrl: 'https://h.example.com',
        getTicket: () async => 't',
        connect: (_) async {
          connectCalls++;
          return conn;
        },
        onDown: downs.add,
        sleep: (_) async {},
      );

      final run = client.start();
      await Future<void>.delayed(Duration.zero);
      await conn.serverClosed(wsCloseCredential);
      await run;

      expect(downs, [WsDownReason.credential]);
      expect(connectCalls, 1);
    });

    test('서버가 4403 으로 끊으면 origin 으로 포기한다', () async {
      final downs = <WsDownReason>[];
      final conn = FakeConnection();
      final client = WsClient(
        baseUrl: 'https://h.example.com',
        getTicket: () async => 't',
        connect: (_) async => conn,
        onDown: downs.add,
        sleep: (_) async {},
      );

      final run = client.start();
      await Future<void>.delayed(Duration.zero);
      await conn.serverClosed(wsCloseOrigin);
      await run;

      expect(downs, [WsDownReason.origin]);
    });
  });

  group('프레임', () {
    test('JSON 객체는 이벤트로 올라가고, 깨진 프레임은 소켓을 끊지 않는다', () async {
      final events = <Map<String, Object?>>[];
      final conn = FakeConnection();
      final client = WsClient(
        baseUrl: 'https://h.example.com/',
        getTicket: () async => 't',
        connect: (_) async => conn,
        onEvent: events.add,
        sleep: (_) async {},
      );

      final run = client.start();
      await Future<void>.delayed(Duration.zero);
      conn.push('{"type":"message.created","message":{"id":"m1"}}');
      conn.push('이건 JSON 이 아니다');
      conn.push('{"type":"presence.changed","accountId":"a1","online":true}');
      await Future<void>.delayed(Duration.zero);
      await client.close();
      await conn.serverClosed(1000);
      await run;

      // 깨진 것 하나가 뒤의 멀쩡한 프레임을 막지 않는다.
      expect(events.map((e) => e['type']), ['message.created', 'presence.changed']);
    });

    test('소켓이 없으면 send 는 조용히 버린다', () {
      final client = WsClient(
        baseUrl: 'https://h.example.com',
        getTicket: () async => 't',
        connect: (_) async => FakeConnection(),
        sleep: (_) async {},
      );
      // 아직 start() 를 안 불렀다 — 던지지 않는 것이 규약이다.
      expect(() => client.send({'type': 'typing'}), returnsNormally);
    });
  });

  group('주소', () {
    test('https 는 wss 로, 끝 슬래시는 떼고 /ws 를 붙인다', () async {
      Uri? seen;
      final conn = FakeConnection();
      final client = WsClient(
        baseUrl: 'https://h.example.com/',
        getTicket: () async => 'tk 1',
        connect: (u) async {
          seen = u;
          return conn;
        },
        sleep: (_) async {},
      );
      final run = client.start();
      await Future<void>.delayed(Duration.zero);
      await client.close();
      await conn.serverClosed(1000);
      await run;

      expect(seen!.scheme, 'wss');
      expect(seen!.path, '/ws');
      // 티켓은 **인코딩되어** 실린다 — 공백이 그대로 나가면 서버가 못 읽는다.
      expect(seen!.queryParameters['ticket'], 'tk 1');
    });
  });

  // 좀비 연결: 서버가 끊었는데 앞단이 이쪽 다리를 열어 둔 채 두면 onDone 이 오지 않는다.
  // hb 를 한 번 받은 뒤로 주기의 2.5배 동안 아무 프레임도 없으면 스스로 버리고 새 티켓으로 다시 붙는다.
  group('수신 감시(앱 hb)', () {
    test('hb 가 끊기면 소켓을 버리고 새 티켓으로 다시 붙는다', () async {
      final conns = <FakeConnection>[];
      final tickets = <String>[];
      final downs = <WsDownReason>[];
      var issued = 0;
      late WsClient client;
      client = WsClient(
        baseUrl: 'https://h.example.com',
        getTicket: () async => 't${++issued}',
        connect: (url) async {
          tickets.add(url.queryParameters['ticket']!);
          final c = FakeConnection();
          conns.add(c);
          if (conns.length == 1) {
            // 첫 소켓: hb 를 한 번 받고 그 뒤로 조용하다(좀비).
            scheduleMicrotask(() => c.push('{"type":"hb","intervalMs":40}'));
          } else {
            // 둘째 소켓이 섰으면 끝 — 시작 루프가 이 소켓의 닫힘을 기다리기 시작한 뒤에 닫는다.
            Future<void>.delayed(const Duration(milliseconds: 20), client.close);
          }
          return c;
        },
        onDown: downs.add,
        sleep: (_) => Future<void>.delayed(const Duration(milliseconds: 5)),
        heartbeatFloor: const Duration(milliseconds: 10),
      );
      await client.start().timeout(const Duration(seconds: 2));
      expect(conns, hasLength(2));
      expect(tickets, ['t1', 't2']);
      expect(downs, [WsDownReason.network]);
    });

    test('hb 는 상태 층으로 올리지 않고, 프레임이 계속 오면 끊지 않는다', () async {
      final events = <Map<String, Object?>>[];
      final conns = <FakeConnection>[];
      final client = WsClient(
        baseUrl: 'https://h.example.com',
        getTicket: () async => 't',
        connect: (_) async {
          final c = FakeConnection();
          conns.add(c);
          return c;
        },
        onEvent: events.add,
        sleep: (_) => Future<void>.delayed(const Duration(milliseconds: 50)),
        heartbeatFloor: const Duration(milliseconds: 10),
      );
      final run = client.start();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      final conn = conns.single;
      conn.push('{"type":"hb","intervalMs":200}');
      for (var i = 0; i < 6; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        conn.push(i.isEven ? '{"type":"hb","intervalMs":200}' : '{"type":"lease.changed"}');
      }
      await Future<void>.delayed(const Duration(milliseconds: 20)); // 마지막 프레임이 리스너에 닿게
      expect(conns, hasLength(1));
      expect(events, [
        for (var i = 0; i < 3; i++) {'type': 'lease.changed'},
      ]);
      await client.close();
      await run;
    });

    test('hb 를 보내지 않는 옛 서버에는 감시를 켜지 않는다', () async {
      final conns = <FakeConnection>[];
      final client = WsClient(
        baseUrl: 'https://h.example.com',
        getTicket: () async => 't',
        connect: (_) async {
          final c = FakeConnection();
          conns.add(c);
          return c;
        },
        sleep: (_) => Future<void>.delayed(const Duration(milliseconds: 50)),
        heartbeatFloor: const Duration(milliseconds: 10),
      );
      final run = client.start();
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(conns, hasLength(1));
      await client.close();
      await run;
    });

    test('서버가 준 주기는 하한~5분으로 묶는다', () {
      expect(heartbeatInterval({'type': 'hb', 'intervalMs': 0}), const Duration(seconds: 1));
      expect(heartbeatInterval({'type': 'hb', 'intervalMs': 1e12}), const Duration(minutes: 5));
      expect(heartbeatInterval({'type': 'hb'}), const Duration(seconds: 20));
      expect(heartbeatInterval({'type': 'lease.changed'}), isNull);
    });
  });
}
