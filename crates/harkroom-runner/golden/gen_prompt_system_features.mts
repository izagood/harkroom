// 정본 prompt.ts featureSection(「쓸 수 있는 기능」 절)과 그 원본 shared/featureCatalog.ts 를 뽑는다(B4-2e-4b3).
// 실행: tsx crates/harkroom-runner/golden/gen_prompt_system_features.mts > crates/harkroom-runner/tests/prompt_system_features_golden.json
import { featureSection } from '../../../packages/agent/src/prompt.ts';
import { READONLY_ALLOW } from '../../../packages/agent/src/turn.ts';
import { FEATURE_CATALOG } from '../../../packages/shared/src/featureCatalog.ts';

const sections: Record<string, unknown> = {};
for (const readOnly of [false, true]) {
  for (const secretCreate of [false, true]) {
    sections[`${readOnly ? 'ro' : 'rw'}_${secretCreate ? 'secret' : 'nosecret'}`] = {
      readOnly, secretCreate, expected: featureSection({ readOnly, secretCreate }),
    };
  }
}
const out = {
  sections,
  catalog: FEATURE_CATALOG.map((e) => ({ id: e.id, tools: e.tools, needs: e.needs ?? null, lines: e.lines })),
  readonlyAllow: READONLY_ALLOW,
};
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
