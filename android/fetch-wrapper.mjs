import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Fetches only the small official Gradle wrapper files, never Gradle or Android SDK.
const root = new URL('./', import.meta.url);
const version = '8.11.1';
const read = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`wrapper_download_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 200000) throw new Error('unexpected_large_wrapper_file');
  return bytes;
};
const decode = value => new TextDecoder().decode(value).trim();
const files = ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar'];
const [downloads, jarChecksum, distChecksum] = await Promise.all([
  Promise.all(files.map(path => read(`https://raw.githubusercontent.com/gradle/gradle/v${version}/${path}`))),
  read(`https://services.gradle.org/distributions/gradle-${version}-wrapper.jar.sha256`),
  read(`https://services.gradle.org/distributions/gradle-${version}-bin.zip.sha256`),
]);
const expectedJar = decode(jarChecksum), expectedDist = decode(distChecksum);
if (!/^[a-f0-9]{64}$/.test(expectedJar) || !/^[a-f0-9]{64}$/.test(expectedDist)) throw new Error('invalid_official_checksum');
if (createHash('sha256').update(downloads[2]).digest('hex') !== expectedJar) throw new Error('wrapper_checksum_mismatch');
await mkdir(new URL('gradle/wrapper/', root), { recursive: true });
for (let index = 0; index < files.length; index++) await writeFile(new URL(files[index], root), downloads[index]);
await writeFile(new URL('gradle/LICENSE', root), await read(`https://raw.githubusercontent.com/gradle/gradle/v${version}/LICENSE`));
await writeFile(new URL('gradle/wrapper/gradle-wrapper.properties', root), [
  'distributionBase=GRADLE_USER_HOME', 'distributionPath=wrapper/dists',
  `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip`,
  `distributionSha256Sum=${expectedDist}`, 'networkTimeout=30000', 'validateDistributionUrl=true',
  'zipStoreBase=GRADLE_USER_HOME', 'zipStorePath=wrapper/dists', '',
].join('\n'));
const manifest = { version, jarSha256: expectedJar, distributionSha256: expectedDist,
  files: files.map((path, index) => ({ path, bytes: downloads[index].length, sha256: createHash('sha256').update(downloads[index]).digest('hex') })),
  source: `https://github.com/gradle/gradle/tree/v${version}`, sdkDownloaded: false, distributionDownloaded: false };
await writeFile(new URL('gradle/wrapper/provenance.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
