import { readFile, writeFile } from "node:fs/promises";

const packageJsonPath = "package.json";
const manifestPath = "manifest.json";
const browserExtensionManifestPath = "browser-extension/manifest.json";
const versionsPath = "versions.json";
const semverPattern = /^\d+\.\d+\.\d+$/;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const packageJson = await readJson(packageJsonPath);
const manifest = await readJson(manifestPath);
const browserExtensionManifest = await readJson(browserExtensionManifestPath);
const versions = await readJson(versionsPath);
const version = packageJson.version;

if (!semverPattern.test(version)) {
  throw new Error(`package.json version must use x.y.z format, got ${version}`);
}

if (!manifest.minAppVersion) {
  throw new Error("manifest.json must define minAppVersion");
}

manifest.version = version;
browserExtensionManifest.version = version;
versions[version] = manifest.minAppVersion;

await writeJson(manifestPath, manifest);
await writeJson(browserExtensionManifestPath, browserExtensionManifest);
await writeJson(versionsPath, versions);

console.log(`Synced release metadata to ${version}`);
