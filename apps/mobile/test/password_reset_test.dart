import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/login_screen.dart';
import 'package:harkroom/screens/password_reset.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 비밀번호 재설정 코드 — 모바일(스레드 a6017542, 서버 #1409). 재는 것: 코드 묶기·판 비교, 안내 시트는 서버를
/// 부르지 않는다, 옛 서버면 라우트를 부르지 않는다, 실패 문구 하나, 키보드 「완료」로 보낸다, autofill, 128자는
/// 칸이 자르지 않고 문구로 막는다, 알림은 전부 보이고 보인 id 만 내린다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

class _Server {
  _Server({this.version = '0.4.122'});
  String version;
  int resetStatus = 400;
  final calls = <String>[];
  Object? ackBody;
  List<Map<String, Object?>> notices = [];

  MockClient get client => MockClient((req) async {
        calls.add('${req.method} ${req.url.path}');
        switch (req.url.path) {
          case '/healthz':
            return _json({'ok': true, 'version': version});
          case '/auth/password-reset':
            return resetStatus == 200
                ? _json({'token': 'hrks_new'})
                : _json({'error': {'code': 'invalid_reset_code', 'message': 'nope'}}, resetStatus);
          case '/auth/password-reset-notices':
            return _json({'notices': notices});
          case '/auth/password-reset-notices/ack':
            ackBody = jsonDecode(req.body);
            return http.Response('', 204);
        }
        return _json({'error': {'code': 'not_found', 'message': 'x'}}, 404);
      });
}

AppState _state(_Server s) => AppState(
      sessions: SessionStore.inMemory(),
      apiFactory: (base, token) => ApiClient(baseUrl: base, token: token, httpClient: s.client),
      connector: (Uri _) async => throw StateError('시험에서는 소켓을 열지 않는다'),
    )..setServer('https://hk.example.com');

// 앱(main.dart)과 같이 MaterialApp.builder 로 감싼다 — 시트·밀어 넣은 화면도 I18n·AppScope 아래에 선다.
Widget _app(AppState state, Widget child) => MaterialApp(
      theme: harkroomTheme(Brightness.light),
      builder: (context, nav) => I18n(strings: stringsFor('ko'), child: AppScope(state: state, child: nav!)),
      home: child,
    );

void main() {
  test('코드는 4-4-4 로 묶고 12자에서 자른다', () {
    expect(groupResetCode('k7qf9mxd2pqr'), 'K7QF-9MXD-2PQR');
    expect(groupResetCode('K7QF-9MXD-2PQRXX'), 'K7QF-9MXD-2PQR');
    expect(groupResetCode('k7 q'), 'K7Q');
  });

  test('판 비교 — 모양이 다르면 막지 않는다', () {
    expect(versionAtLeast('0.4.122', passwordResetSince), isTrue);
    expect(versionAtLeast('0.4.200', passwordResetSince), isTrue);
    expect(versionAtLeast('0.4.113', passwordResetSince), isFalse);
    expect(versionAtLeast('dev', passwordResetSince), isTrue);
  });

  test('옛 서버면 재설정 라우트를 부르지 않는다', () async {
    final s = _Server(version: '0.4.113');
    final app = _state(s);
    await expectLater(app.resetPasswordWithCode('minji', 'K7QF-9MXD-2PQR', 'new-pass-1234'), throwsA(isA<ResetUnsupported>()));
    expect(s.calls, ['GET /healthz']);
  });

  testWidgets('로그인 화면 「잊었다면」 → 안내 시트는 서버를 부르지 않는다', (tester) async {
    final s = _Server();
    await tester.pumpWidget(_app(_state(s), const LoginScreen()));
    await tester.tap(find.byKey(const Key('login-forgot')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('pwreset-guide')), findsOneWidget);
    expect(s.calls, isEmpty);
    await tester.tap(find.byKey(const Key('pwreset-have-code')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('pwreset-code')), findsOneWidget);
  });

  testWidgets('코드 화면: autofill·대문자·완료로 보내기·실패 문구 하나', (tester) async {
    final s = _Server();
    await tester.pumpWidget(_app(_state(s), const ResetPasswordScreen(initialLoginId: 'minji')));
    final code = tester.widget<TextField>(find.byKey(const Key('pwreset-code')));
    expect(code.autofocus, isTrue); // ID 가 채워져 왔으면 코드 칸부터
    expect(code.textCapitalization, TextCapitalization.characters);
    expect(code.autocorrect, isFalse);
    final pw = tester.widget<TextField>(find.byKey(const Key('pwreset-new')));
    expect(pw.autofillHints, [AutofillHints.newPassword]);
    expect(pw.maxLength, isNull); // 붙여 넣은 값을 말없이 자르지 않는다
    final confirm = tester.widget<TextField>(find.byKey(const Key('pwreset-confirm')));
    expect(confirm.textInputAction, TextInputAction.done);

    await tester.enterText(find.byKey(const Key('pwreset-code')), 'k7qf9mxd2pqr');
    expect(tester.widget<TextField>(find.byKey(const Key('pwreset-code'))).controller!.text, 'K7QF-9MXD-2PQR');
    await tester.enterText(find.byKey(const Key('pwreset-new')), 'new-pass-1234');
    await tester.enterText(find.byKey(const Key('pwreset-confirm')), 'new-pass-1234');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    await tester.pump();
    expect(s.calls, contains('POST /auth/password-reset'));
    expect(find.text(stringsFor('ko').pwresetFormInvalid), findsOneWidget);
  });

  testWidgets('128자를 넘으면 문구로 막고 보내지 않는다', (tester) async {
    final s = _Server();
    await tester.pumpWidget(_app(_state(s), const ResetPasswordScreen(initialLoginId: 'minji')));
    final long = 'x' * 129;
    await tester.enterText(find.byKey(const Key('pwreset-code')), 'k7qf9mxd2pqr');
    await tester.enterText(find.byKey(const Key('pwreset-new')), long);
    await tester.enterText(find.byKey(const Key('pwreset-confirm')), long);
    await tester.pump();
    expect(find.text(stringsFor('ko').pwresetFormTooLong), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('pwreset-submit'))).onPressed, isNull);
  });

  testWidgets('알림: 전부 한 줄씩, 이름으로, [확인] 은 보인 id 만', (tester) async {
    final s = _Server();
    final app = _state(s);
    app.accounts['a1'] = const AccountView(id: 'a1', handle: 'adm', displayName: '', isAgent: false, isDisabled: false, avatarAttachmentId: null);
    app.passwordResetNotices = [
      PasswordResetNotice(id: 'n2', issuedById: 'o1', issuedAt: DateTime.now(), usedAt: null),
      PasswordResetNotice(id: 'n1', issuedById: 'a1', issuedAt: DateTime.now(), usedAt: DateTime.now()),
    ];
    await tester.pumpWidget(_app(app, const Scaffold(body: PasswordResetNoticeBand())));
    final band = find.byKey(const Key('pwreset-notice'));
    expect(band, findsOneWidget);
    final text = tester.widgetList<Text>(find.descendant(of: band, matching: find.byType(Text))).map((w) => w.data ?? '').join('\n');
    expect(text, contains('adm (@adm)')); // 표시 이름이 비면 handle
    expect(text, contains(stringsFor('ko').pwresetNoticeUnknownAdmin)); // 목록에 없으면 id 가 아니라 「관리자」
    expect(text, isNot(contains('o1')));
    // 사용됨·미사용이 섞이면 두 설명이 다
    expect(text, contains(stringsFor('ko').pwresetNoticeUsedDetail));
    expect(text, contains(stringsFor('ko').pwresetNoticeIssuedDetail));
    await tester.tap(find.text(stringsFor('ko').pwresetNoticeAck));
    await tester.pump();
    expect(s.ackBody, {'ids': ['n2', 'n1']});
    expect(app.passwordResetNotices, isEmpty);
  });
}
