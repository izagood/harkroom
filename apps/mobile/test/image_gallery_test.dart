import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/attachments.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 그림 넘겨 보기 — designer 사양(2026-10-02) 1·5 의 모바일 몫.

AttachmentRow _img(String id, {String type = 'image/png', ArtifactRef? artifact}) =>
    AttachmentRow(id: id, filename: '$id.png', contentType: type, byteSize: 100, artifact: artifact);

MessageRow _msg(String id, int seq, List<AttachmentRow> atts) => MessageRow(
      id: id, seq: seq, channelId: 'c1', threadRootId: null, authorId: 'u1', body: '', kind: MessageKind.user,
      meta: const {}, createdAt: DateTime.utc(2026, 10, 2), editedAt: null, reactions: const [],
      attachments: atts, replyCount: 0,
    );

AppState _state() {
  final s = AppState(
    sessions: SessionStore.inMemory(),
    apiFactory: (base, token) => ApiClient(
        baseUrl: base, token: token, httpClient: MockClient((_) async => http.Response('nope', 404))),
    connector: (Uri _) async => throw StateError('시험에서는 소켓을 열지 않는다'),
  );
  s.setServer('https://server.example.com');
  return s;
}

void main() {
  test('목록: seq 순·첨부 순, svg·미리보기 카드·표지는 뺀다', () {
    const cover = ArtifactRef(artifactId: 'a', version: 1, latestVersion: 1, title: 't', summary: null, coverAttachmentId: 'cv');
    final items = collectGallery([
      _msg('m2', 2, [_img('b1'), _img('svg', type: 'image/svg+xml')]),
      _msg('m1', 1, [_img('a1'), _img('a2')]),
      _msg('m3', 3, [_img('card', type: 'text/html', artifact: cover), _img('cv')]),
    ]);
    expect(items.map((i) => i.attachment.id), ['a1', 'a2', 'b1']);
  });

  final items = [
    GalleryItem(_img('g1'), _msg('m1', 1, const [])),
    GalleryItem(_img('g2'), _msg('m2', 2, const [])),
    GalleryItem(_img('g3'), _msg('m3', 3, const [])),
  ];

  Future<List<String>> open(WidgetTester tester, {int start = 0}) async {
    final went = <String>[];
    await tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: I18n(
        strings: stringsFor('ko'),
        child: AppScope(state: _state(), child: ImageGallery(items: items, start: start, onGoTo: went.add)),
      ),
    ));
    await tester.pump();
    return went;
  }

  String title(WidgetTester tester) => tester.widget<Text>(find.byKey(const Key('gallery-title'))).data!;
  Future<void> swipeLeft(WidgetTester tester) async {
    await tester.fling(find.byKey(const Key('gallery-pages')), const Offset(-300, 0), 1000);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
  }

  testWidgets('맞춤에서 왼쪽으로 밀면 다음 장, 끝에서는 멈춘다', (tester) async {
    await open(tester);
    expect(title(tester), '1 / 3');
    await swipeLeft(tester);
    expect(title(tester), '2 / 3');
    await swipeLeft(tester);
    await swipeLeft(tester);
    expect(title(tester), '3 / 3');
  });

  testWidgets('확대 중(배율 > 1)에는 밀어도 장이 그대로다', (tester) async {
    await open(tester);
    final vp = tester.widget<ImageViewport>(find.byType(ImageViewport).first);
    vp.onZoomChanged!(true);
    await tester.pump();
    await swipeLeft(tester);
    expect(title(tester), '1 / 3');
    vp.onZoomChanged!(false);
    await tester.pump();
    await swipeLeft(tester);
    expect(title(tester), '2 / 3');
  });

  testWidgets('메뉴의 [글로 가기]는 닫고 그 글을 연다', (tester) async {
    final went = await open(tester, start: 2);
    await tester.tap(find.byKey(const Key('gallery-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('gallery-goto')));
    await tester.pump();
    expect(went, ['m3']);
  });
}
