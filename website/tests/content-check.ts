import { readFileSync } from 'node:fs';
const app = readFileSync('src/App.tsx', 'utf8');
const css = readFileSync('src/styles.css', 'utf8');
const tokens = readFileSync('src/tokens.css', 'utf8');
const canonicalTokens = readFileSync('../native/Sources/GDMNative/Resources/design-tokens.css', 'utf8');

for (const text of ['Agents run.', 'Evidence decides.', '터미널은 그대로', 'Gidem이 작업을 보여주고', '완료했다고 말하지 말고', 'github.com/Gdm0714/gdm', 'install.sh', 'animated-static.svg']) {
  if (!app.includes(text)) throw new Error(`missing content: ${text}`);
}

if (/gradient|fonts\.googleapis|unpkg\.com|cdn\./i.test(css + app)) {
  throw new Error('forbidden visual dependency found');
}

if (/#[0-9a-f]{3,8}|rgba?\(|hsla?\(/i.test(css + app)) {
  throw new Error('hard-coded color found outside canonical tokens');
}

if (tokens !== canonicalTokens) {
  throw new Error('website tokens diverge from native canonical design-tokens.css');
}

console.log('content, canonical tokens, asset reuse, and dependency boundary checks passed');
