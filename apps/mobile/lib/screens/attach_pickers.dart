import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:image_picker/image_picker.dart';

/// 고른 것 하나. 이름과, 바이트를 읽는 길.
///
/// 바이트를 바로 들고 오지 않는다 — 여러 장을 고르면 다 읽기 전에 첫 장부터 올리기 시작한다.
class PickedAttachment {
  const PickedAttachment({required this.name, required this.read});

  final String name;
  final Future<Uint8List> Function() read;
}

/// 첨부를 고르는 세 길. 시험에서는 가짜로 바꾼다 — 진짜 picker 는 플랫폼 채널이라
/// 위젯 시험에서 열 수 없다.
abstract class AttachPickers {
  /// 이 기기에 카메라가 있는가. 시뮬레이터에는 없다 — 그때 카메라 줄은 **숨기지 않고
  /// 비활성**으로 둔다(실기기와 배치가 같아야 스크린샷·시험이 대조된다).
  bool get hasCamera;

  /// 사진 보관함(PHPicker). 권한을 묻지 않으므로 거절 상태가 없다. 취소하면 빈 목록.
  Future<List<PickedAttachment>> library();

  /// 카메라로 한 장. 취소하면 null. 권한이 꺼져 있으면 `PlatformException`
  /// (`camera_access_denied`)을 던진다.
  Future<PickedAttachment?> camera();

  /// 파일 앱(UIDocumentPicker). 취소하면 빈 목록.
  Future<List<PickedAttachment>> files();
}

class PlatformAttachPickers implements AttachPickers {
  const PlatformAttachPickers();

  /// iOS 시뮬레이터는 앱 프로세스에 이 값을 넣는다. 실기기에는 없다.
  @override
  bool get hasCamera => !Platform.environment.containsKey('SIMULATOR_DEVICE_NAME');

  @override
  Future<List<PickedAttachment>> library() async {
    // `media` 여야 PHPicker 가 열린다. 기본값 `any` 는 파일 앱을 연다(이 PR 의 원인).
    // `compatible`: HEIC 를 JPEG 로 바꿔 받는다 — 데스크톱·웹 미리보기가 HEIC 를 못 그린다.
    final picked = await FilePicker.pickFiles(
      type: FileType.media,
      darwinOptions: const DarwinOptions(
        assetRepresentationMode: DarwinAssetRepresentationMode.compatible,
      ),
    );
    return [
      // `readAsBytes` 로 받는다. 사진 보관함 항목은 경로만으로는 앱이 못 읽는 자리에 있을
      // 수 있어서, 플러그인이 대신 읽어 주는 이 통로를 쓴다.
      for (final f in picked) PickedAttachment(name: f.name, read: f.readAsBytes),
    ];
  }

  @override
  Future<PickedAttachment?> camera() async {
    final shot = await ImagePicker().pickImage(source: ImageSource.camera);
    if (shot == null) return null;
    return PickedAttachment(name: shot.name, read: shot.readAsBytes);
  }

  @override
  Future<List<PickedAttachment>> files() async {
    // 취소하면 **빈 목록**이다(`null` 이 아니다 — file_picker 13 에서 바뀌었다).
    // 13 의 `pickFiles` 는 늘 여러 개를 고를 수 있다(한 개는 `pickFile`).
    final picked = await FilePicker.pickFiles();
    return [for (final f in picked) PickedAttachment(name: f.name, read: f.readAsBytes)];
  }
}

/// 카메라가 준 `image_picker_8F3A….jpg` 는 칩과 메시지에 그대로 보인다 — 찍은 시각으로 바꾼다.
/// 기기 시간대 그대로 쓴다. 사람이 찍은 때를 그 사람의 시계로 읽는다.
String cameraFilename(DateTime at) {
  String two(int n) => n.toString().padLeft(2, '0');
  return 'photo-${at.year}${two(at.month)}${two(at.day)}'
      '-${two(at.hour)}${two(at.minute)}${two(at.second)}.jpg';
}

/// 사진 보관함에서 온 이름의 확장자를 **실제 바이트**에 맞춘다.
///
/// `compatible` 이면 JPEG 로 오지만 이름이 `.heic` 로 남을 수 있다. 바이트가 JPEG 일 때만
/// `.jpg` 로 바꾼다 — 바이트를 보지 않고 이름만 바꾸면 HEIC 를 `.jpg` 로 속여 올리게 된다.
String libraryFilename(String name, Uint8List bytes) {
  final isJpeg = bytes.length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
  if (!isJpeg) return name;
  final dot = name.lastIndexOf('.');
  final ext = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  if (ext == 'jpg' || ext == 'jpeg') return name;
  return '${dot < 0 ? name : name.substring(0, dot)}.jpg';
}
