import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/content_type.dart';

void main() {
  test('사진 확장자는 이미지 형식이 된다(대소문자 무관)', () {
    expect(contentTypeFor('IMG_0001.HEIC'), 'image/heic');
    expect(contentTypeFor('a.jpg'), 'image/jpeg');
    expect(contentTypeFor('a.b.png'), 'image/png');
  });

  test('모르는 것·확장자 없음·SVG 는 짐작하지 않는다', () {
    expect(contentTypeFor('Makefile'), isNull);
    expect(contentTypeFor('a.'), isNull);
    expect(contentTypeFor('x.svg'), isNull);
    expect(contentTypeFor('x.weird'), isNull);
  });
}
