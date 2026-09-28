/// `WsConnection` 의 실물 — `web_socket_channel` 을 감싼다.
///
/// 이것이 `ws.dart` 와 갈라져 있는 이유: 그 파일의 상태 기계(백오프·포기 판정)가 이
/// 저장소에서 **가장 틀리기 쉬운 부분**인데, 진짜 소켓에 묶여 있으면 시험할 수가 없다.
/// 여기는 얇게 두고 로직을 저쪽에 몰아 둔다.
library;

import 'dart:async';

import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as ws_status;

import 'ws.dart';

class RealWsConnection implements WsConnection {
  RealWsConnection._(this._channel);

  final WebSocketChannel _channel;

  /// 서버가 준 닫힘 코드. **연결이 끊긴 뒤에만** 값이 있다 — `ws.dart` 가 `onDone` 뒤에
  /// 읽는다.
  @override
  int? get closeCode => _channel.closeCode;

  @override
  Stream<String> get messages => _channel.stream.map((e) => e is String ? e : '');

  @override
  void send(String payload) => _channel.sink.add(payload);

  @override
  Future<void> close() async {
    try {
      await _channel.sink.close(ws_status.normalClosure);
    } on Object {
      // 이미 죽은 소켓을 닫는 것은 오류가 아니다.
    }
  }

  /// 연결이 **설 때까지 기다린 뒤** 돌려준다.
  ///
  /// `WebSocketChannel.connect` 는 즉시 돌아오고 실패는 스트림으로 온다. 그대로 두면
  /// `ws.dart` 가 "열렸다"고 보고 `onOpen` 을 부르는데, 실제로는 핸드셰이크가 거절된
  /// 상태다 — 그러면 화면이 **연결됐다고 거짓말한다.** `ready` 를 기다려서 그 창을 닫는다.
  static Future<WsConnection> connect(Uri url) async {
    final channel = WebSocketChannel.connect(url);
    await channel.ready;
    return RealWsConnection._(channel);
  }
}
