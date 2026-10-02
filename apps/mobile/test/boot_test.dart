import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';

/// 앱 시작 경로. `testWidgets` 는 바인딩을 미리 세워 주므로 `main` 이 바인딩 없이 도는 실제 시작을
/// 못 본다 — 그래서 여기는 일부러 맨 `test` 로 연다(이 파일은 따로 된 isolate 에서 돈다).
void main() {
  test('바인딩이 없는 데서 불러도 앱을 짓는다 — 푸시 채널 처리기가 runApp 전에 달린다(281 흰 화면)', () {
    final app = bootApp(sessions: SessionStore.inMemory());
    expect(app.push, isNotNull);
  });
}
