import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = new URL('./', import.meta.url);
const text = path => readFile(new URL(path, root), 'utf8');
const [activity, manifest, network, gradle, wrapper, provenance, pwa] = await Promise.all([
  text('app/src/main/java/com/beautyproof/trial/MainActivity.java'), text('app/src/main/AndroidManifest.xml'),
  text('app/src/main/res/xml/network_security_config.xml'), text('app/build.gradle'),
  text('gradle/wrapper/gradle-wrapper.properties'), text('gradle/wrapper/provenance.json'),
  text('../public/manifest.webmanifest'),
]);
let count = 0;
const check = (label, run) => { run(); count++; console.log(`PASS ${label}`); };
check('only Internet permission', () => assert.deepEqual([...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map(row => row[1]), ['android.permission.INTERNET']));
check('cleartext prohibited in manifest and network config', () => { assert.match(manifest, /usesCleartextTraffic="false"/); assert.match(network, /cleartextTrafficPermitted="false"/); });
check('only system trust anchors', () => { assert.match(network, /certificates src="system"/); assert.doesNotMatch(network, /src="user"|debug-overrides/); });
check('SSL errors cancel and never proceed', () => { assert.match(activity, /handler\.cancel\(\)/); assert.doesNotMatch(activity, /handler\.proceed\(/); });
check('no JavaScript-native bridge', () => assert.doesNotMatch(activity, /addJavascriptInterface\s*\(/));
check('file schemes and universal file access disabled', () => { for (const method of ['setAllowFileAccess', 'setAllowFileAccessFromFileURLs', 'setAllowUniversalAccessFromFileURLs']) assert.ok(activity.includes(`${method}(false)`)); });
check('mixed content and third party cookies disabled', () => { assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/); assert.match(activity, /setAcceptThirdPartyCookies\(web, false\)/); });
check('file picker is user initiated SAF with MIME and count limits', () => { for (const fragment of ['ACTION_OPEN_DOCUMENT', 'CATEGORY_OPENABLE', 'EXTRA_MIME_TYPES', 'clip.getItemCount() > 4', 'usableMedia(uri)', '200L * 1024L * 1024L']) assert.ok(activity.includes(fragment)); });
check('camera and microphone requests denied', () => assert.match(activity, /onPermissionRequest\(PermissionRequest request\) \{ request\.deny\(\); \}/));
check('external evidence navigation requires main frame plus gesture', () => assert.match(activity, /request\.isForMainFrame\(\) && request\.hasGesture\(\) && UrlPolicy\.isEvidenceLink/));
check('main-frame request interception also rejects off-domain POST navigation', () => { assert.match(activity, /shouldInterceptRequest/); assert.match(activity, /request\.isForMainFrame\(\) && !UrlPolicy\.isInternal/); assert.match(activity, /403, "Blocked"/); });
check('debug package differs from production and key stays project-local', () => { assert.match(gradle, /applicationIdSuffix '\.debug'/); assert.match(gradle, /rootProject\.file\('build\/debug\.keystore'\)/); });
check('SDK and Java versions are explicit', () => { assert.match(gradle, /compileSdk 35/); assert.match(gradle, /buildToolsVersion '35\.0\.0'/); assert.match(gradle, /VERSION_17/); });
check('online PWA only references local icon', () => { const value = JSON.parse(pwa); assert.equal(value.scope, '/'); assert.equal(value.icons[0].src, '/icons/beautyproof.svg'); });
const source = JSON.parse(provenance), bytes = await readFile(new URL('gradle/wrapper/gradle-wrapper.jar', root));
check('wrapper binary matches official checksum', () => assert.equal(createHash('sha256').update(bytes).digest('hex'), source.jarSha256));
check('Gradle distribution is pinned and checksummed', () => { assert.match(wrapper, /gradle-8\.11\.1-bin\.zip/); assert.ok(wrapper.includes(`distributionSha256Sum=${source.distributionSha256}`)); });
console.log(`${count} static project assertions passed. This does not compile Android Activity code or prove APK/device behavior.`);
