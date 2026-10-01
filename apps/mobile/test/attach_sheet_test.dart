import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/attach_pickers.dart';
import 'package:harkroom/screens/composer_attachments.dart';
import 'package:harkroom/theme.dart';

/// 진짜 picker 는 플랫폼 채널이라 열 수 없다. 어느 길을 불렀는지만 적는다.
class _FakePickers implements AttachPickers {
  _FakePickers({this.hasCamera = true, this.cameraError, this.libraryBytes});

  @override
  final bool hasCamera;
  final PlatformException? cameraError;
  final Uint8List? libraryBytes;
  final calls = <String>[];

  @override
  Future<List<PickedAttachment>> library() async {
    calls.add('library');
    return [
      PickedAttachment(name: 'IMG_0001.heic', read: () async => libraryBytes ?? Uint8List(4)),
    ];
  }

  @override
  Future<PickedAttachment?> camera() async {
    calls.add('camera');
    if (cameraError != null) throw cameraError!;
    return PickedAttachment(name: 'image_picker_8F3A.jpg', read: () async => Uint8List(4));
  }

  @override
  Future<List<PickedAttachment>> files() async {
    calls.add('files');
    return [
      PickedAttachment(name: '계획.pdf', read: () async => Uint8List(4)),
      PickedAttachment(name: '표.csv', read: () async => Uint8List(4)),
    ];
  }
}

void main() {
  late List<String> delivered;
  late int settingsOpened;

  setUp(() {
    delivered = [];
    settingsOpened = 0;
  });

  Widget host(AttachPickers pickers, {String lang = 'ko'}) => MaterialApp(
        theme: harkroomTheme(Brightness.light),
        home: I18n(
          strings: stringsFor(lang),
          child: Scaffold(
            body: Center(
              child: AttachButton(
                composerKey: 'c1',
                pickers: pickers,
                onPicked: (name, bytes) async => delivered.add(name),
                openSettings: () async => settingsOpened += 1,
                now: () => DateTime(2026, 10, 1, 21, 40, 12),
              ),
            ),
          ),
        ),
      );

  Future<void> openSheet(WidgetTester tester) async {
    await tester.tap(find.byKey(const Key('attach')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attach-sheet')), findsOneWidget);
  }

  testWidgets('버튼은 + 아이콘이고, 누르면 세 줄이 정해진 순서로 뜬다', (tester) async {
    await tester.pumpWidget(host(_FakePickers()));
    expect(find.byIcon(Icons.add_circle_outline), findsOneWidget);
    expect(find.byTooltip('첨부 추가'), findsOneWidget);

    await openSheet(tester);
    final ys = [
      for (final k in ['attach-library', 'attach-camera', 'attach-file'])
        tester.getTopLeft(find.byKey(Key(k))).dy,
    ];
    expect(ys, orderedEquals([...ys]..sort()));
    expect(find.text('사진 보관함'), findsOneWidget);
    expect(find.text('사진 찍기'), findsOneWidget);
    expect(find.text('파일 선택'), findsOneWidget);
    for (final k in ['attach-library', 'attach-camera', 'attach-file']) {
      expect(tester.getSize(find.byKey(Key(k))).height, greaterThanOrEqualTo(52));
    }
  });

  testWidgets('사진 보관함: 시트를 닫고 library 를 부른다. JPEG 로 왔으면 이름도 .jpg', (tester) async {
    final p = _FakePickers(libraryBytes: Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0]));
    await tester.pumpWidget(host(p));
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('attach-library')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('attach-sheet')), findsNothing);
    expect(p.calls, ['library']);
    expect(delivered, ['IMG_0001.jpg']);
  });

  testWidgets('파일 선택: files 를 부르고 고른 것을 다 넘긴다', (tester) async {
    final p = _FakePickers();
    await tester.pumpWidget(host(p));
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('attach-file')));
    await tester.pumpAndSettle();

    expect(p.calls, ['files']);
    expect(delivered, ['계획.pdf', '표.csv']);
  });

  testWidgets('사진 찍기: 찍은 시각으로 이름을 바꿔 넘긴다', (tester) async {
    final p = _FakePickers();
    await tester.pumpWidget(host(p));
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('attach-camera')));
    await tester.pumpAndSettle();

    expect(p.calls, ['camera']);
    expect(delivered, ['photo-20261001-214012.jpg']);
  });

  testWidgets('카메라가 없으면 줄을 숨기지 않고 비활성으로 두고, 눌러도 아무 일이 없다', (tester) async {
    final p = _FakePickers(hasCamera: false);
    await tester.pumpWidget(host(p));
    await openSheet(tester);
    expect(find.text('이 기기에는 카메라가 없다'), findsOneWidget);

    await tester.tap(find.byKey(const Key('attach-camera')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attach-sheet')), findsOneWidget);
    expect(p.calls, isEmpty);
  });

  testWidgets('카메라 권한이 꺼져 있으면 거절 시트가 뜨고, [설정 열기]로 설정을 연다', (tester) async {
    final p = _FakePickers(cameraError: PlatformException(code: 'camera_access_denied'));
    await tester.pumpWidget(host(p));
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('attach-camera')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('camera-denied')), findsOneWidget);
    expect(find.text('카메라를 쓸 수 없다'), findsOneWidget);
    await tester.tap(find.byKey(const Key('camera-denied-settings')));
    await tester.pumpAndSettle();
    expect(settingsOpened, 1);
    expect(find.byKey(const Key('camera-denied')), findsNothing);
    expect(delivered, isEmpty);
  });

  testWidgets('[닫기]는 설정을 열지 않는다', (tester) async {
    final p = _FakePickers(cameraError: PlatformException(code: 'camera_access_denied'));
    await tester.pumpWidget(host(p, lang: 'en'));
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('attach-camera')));
    await tester.pumpAndSettle();
    expect(find.text('Camera is off'), findsOneWidget);
    await tester.tap(find.byKey(const Key('camera-denied-close')));
    await tester.pumpAndSettle();
    expect(settingsOpened, 0);
  });

  testWidgets('권한 말고 다른 이유로 실패하면 스낵바만 띄운다', (tester) async {
    final p = _FakePickers(cameraError: PlatformException(code: 'camera_access_restricted'));
    await tester.pumpWidget(host(p));
    await openSheet(tester);
    await tester.tap(find.byKey(const Key('attach-camera')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('camera-denied')), findsNothing);
    expect(find.text('카메라를 열지 못했다.'), findsOneWidget);
  });

  testWidgets('시트를 그냥 닫으면 아무것도 부르지 않는다', (tester) async {
    final p = _FakePickers();
    await tester.pumpWidget(host(p));
    await openSheet(tester);
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('attach-sheet')), findsNothing);
    expect(p.calls, isEmpty);
  });

  group('이름', () {
    test('카메라 이름은 찍은 시각', () {
      expect(cameraFilename(DateTime(2026, 1, 2, 3, 4, 5)), 'photo-20260102-030405.jpg');
    });

    test('바이트가 JPEG 일 때만 확장자를 .jpg 로 바꾼다', () {
      final jpeg = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xDB]);
      final heic = Uint8List.fromList([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
      expect(libraryFilename('IMG.HEIC', jpeg), 'IMG.jpg');
      expect(libraryFilename('IMG.jpeg', jpeg), 'IMG.jpeg');
      expect(libraryFilename('IMG', jpeg), 'IMG.jpg');
      // HEIC 를 .jpg 로 속여 올리지 않는다.
      expect(libraryFilename('IMG.heic', heic), 'IMG.heic');
      expect(libraryFilename('clip.mov', heic), 'clip.mov');
    });
  });
}
