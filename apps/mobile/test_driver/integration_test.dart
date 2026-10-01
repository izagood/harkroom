import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

/// `flutter drive` 의 드라이버. 시험이 `takeScreenshot` 으로 넘긴 그림을
/// `build/gallery/<이름>.png` 로 쓴다(`integration_test/gallery_test.dart`).
///
/// `build/` 아래에 두는 이유: 저장소에 들어가면 안 되는 산출물이고, `build/` 는 이미
/// 무시 목록에 있다.
Future<void> main() => integrationDriver(
      onScreenshot: (name, bytes, [args]) async {
        final file = File('build/gallery/$name.png');
        await file.create(recursive: true);
        await file.writeAsBytes(bytes);
        return true;
      },
    );
