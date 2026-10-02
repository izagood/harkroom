import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/screens/attachments.dart';

Future<Uint8List> _png(int w, int h) async {
  final rec = ui.PictureRecorder();
  Canvas(rec).drawRect(
      Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()), Paint()..color = const Color(0xFF00AA00));
  final img = await rec.endRecording().toImage(w, h);
  final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
  return bytes!.buffer.asUint8List();
}

/// 그림이 실제로 칠해진 사각형(화면 좌표). RawImage 의 칸 안에서 contain 으로 앉은 자리다.
Rect _paintedRect(WidgetTester tester) {
  final raw = tester.widget<RawImage>(find.byType(RawImage));
  final box = tester.renderObject<RenderBox>(find.byType(RawImage));
  final out = box.localToGlobal(Offset.zero) & box.size;
  final img = Size(raw.image!.width.toDouble(), raw.image!.height.toDouble());
  final fitted = applyBoxFit(raw.fit ?? BoxFit.scaleDown, img, out.size).destination;
  return Alignment.center.inscribe(fitted, out);
}

void main() {
  // iPhone 폭(390×844 논리 픽셀). 본문 = 앱바 아래 전부.
  const phone = Size(390, 844);

  Future<Rect> open(WidgetTester tester, int w, int h) async {
    tester.view.physicalSize = phone * 3;
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final bytes = (await tester.runAsync(() => _png(w, h)))!;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        appBar: AppBar(title: const Text('x')),
        body: ImageViewport(image: MemoryImage(bytes), errorText: 'failed'),
      ),
    ));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await tester.pump();
    return _paintedRect(tester);
  }

  Rect body(WidgetTester tester) {
    // 본문 = 앱바 아래 전부(LayoutBuilder 가 받은 칸). 긴 그림이면 InteractiveViewer 가 그보다 크지 않다.
    final s = tester.renderObject<RenderBox>(find.byType(ImageViewport));
    return s.localToGlobal(Offset.zero) & s.size;
  }

  void expectInside(Rect painted, Rect area) {
    const e = 0.5;
    expect(painted.left, greaterThanOrEqualTo(area.left - e));
    expect(painted.top, greaterThanOrEqualTo(area.top - e));
    expect(painted.right, lessThanOrEqualTo(area.right + e));
    expect(painted.bottom, lessThanOrEqualTo(area.bottom + e));
  }

  testWidgets('가로로 긴 데스크톱 스크린샷은 폭에 맞춰 통째로 보인다', (tester) async {
    final painted = await open(tester, 3456, 2234);
    final area = body(tester);
    expectInside(painted, area);
    expect(painted.width, closeTo(area.width, 0.5));
    expect(painted.center.dy, closeTo(area.center.dy, 0.5));
  });

  testWidgets('조금 세로로 긴 이미지(폰 스크린샷)는 높이에 맞춰 통째로 보인다', (tester) async {
    final painted = await open(tester, 1170, 2532);
    final area = body(tester);
    expectInside(painted, area);
    expect(painted.height, closeTo(area.height, 0.5));
    expect(painted.center.dx, closeTo(area.center.dx, 0.5));
  });

  // designer 3192efed 6: 세로로 많이 긴 그림은 높이에 줄이면 글자가 안 읽힌다 — 폭에 맞추고 맨 위부터.
  testWidgets('세로로 많이 긴 이미지는 폭에 맞추고 맨 위부터 보인다', (tester) async {
    final painted = await open(tester, 600, 6000);
    final area = body(tester);
    expect(find.byKey(const Key('attachment-tall-viewport')), findsOneWidget);
    expect(painted.width, closeTo(area.width, 0.5));
    expect(painted.top, closeTo(area.top, 0.5));
    expect(painted.height, closeTo(area.width * 10, 0.5));
  });

  testWidgets('긴 이미지는 더블탭으로 2배, 한 번 더 누르면 맞춤으로 돌아온다', (tester) async {
    await open(tester, 600, 6000);
    final viewer = tester.widget<InteractiveViewer>(find.byKey(const Key('attachment-tall-viewport')));
    final tc = viewer.transformationController!;
    final center = tester.getCenter(find.byKey(const Key('attachment-tall-viewport')));
    await tester.tap(find.byKey(const Key('attachment-tall-viewport')));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tapAt(center);
    await tester.pumpAndSettle();
    expect(tc.value.getMaxScaleOnAxis(), closeTo(2, 0.01));
    await tester.tapAt(center);
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tapAt(center);
    await tester.pumpAndSettle();
    expect(tc.value.getMaxScaleOnAxis(), closeTo(1, 0.01));
  });

  test('긴 그림 판정: 높이/폭이 화면 높이/폭의 1.5배를 넘을 때', () {
    const view = Size(390, 780); // 2:1
    expect(isTallImage(const Size(600, 6000), view), isTrue); // 10:1
    expect(isTallImage(const Size(1170, 2532), view), isFalse); // 2.16:1 < 3
    expect(isTallImage(const Size(1000, 3100), view), isTrue); // 3.1:1 > 3
    expect(isTallImage(const Size(3456, 2234), view), isFalse);
    expect(isTallImage(Size.zero, view), isFalse);
  });

  testWidgets('작은 이미지는 원래 크기로 가운데에 선다', (tester) async {
    final painted = await open(tester, 100, 50);
    final area = body(tester);
    expect(painted.size, const Size(100, 50));
    expect(painted.center.dx, closeTo(area.center.dx, 0.5));
    expect(painted.center.dy, closeTo(area.center.dy, 0.5));
  });

  testWidgets('맞춤보다 작게 오므릴 수 없고 6배까지 키운다', (tester) async {
    await open(tester, 3456, 2234);
    final viewer = tester.widget<InteractiveViewer>(find.byType(InteractiveViewer));
    expect(viewer.minScale, 1);
    expect(viewer.maxScale, 6);
  });
}
