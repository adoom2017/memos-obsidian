import { Buffer } from "node:buffer";
import { readFile, readdir, rm, mkdir, copyFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(rootDir, "release");
const obsidianReleaseDir = path.join(releaseDir, "obsidian");
const requiredObsidianFiles = ["main.js", "manifest.json", "styles.css"];
const extensionDir = path.join(rootDir, "browser-extension");
let crcTable = null;

const packageJson = await readJson("package.json");
const manifest = await readJson("manifest.json");
const extensionManifest = await readJson("browser-extension/manifest.json");
const versions = await readJson("versions.json");
const version = manifest.version;

assert(packageJson.version === version, "package.json version must match manifest.json version.");
assert(extensionManifest.version === version, "browser-extension/manifest.json version must match manifest.json version.");
assert(versions[version] === manifest.minAppVersion, "versions.json must contain the current Obsidian version/minAppVersion mapping.");
assert(manifest.isDesktopOnly === true, "manifest.json must set isDesktopOnly=true because the plugin uses desktop-only Node/Electron APIs.");

await rm(releaseDir, { recursive: true, force: true });
await mkdir(obsidianReleaseDir, { recursive: true });

for (const file of requiredObsidianFiles) {
  await copyFile(path.join(rootDir, "dist", file), path.join(obsidianReleaseDir, file));
}

await createZip(
  path.join(releaseDir, `memos-card-view-${version}-obsidian.zip`),
  requiredObsidianFiles.map((file) => ({
    source: path.join(obsidianReleaseDir, file),
    name: file,
  })),
);

const extensionFiles = await listFiles(extensionDir);
await createZip(
  path.join(releaseDir, `memos-obsidian-clipper-${version}-chrome.zip`),
  extensionFiles.map((source) => ({
    source,
    name: path.relative(extensionDir, source).replaceAll(path.sep, "/"),
  })),
);

await writeFile(
  path.join(releaseDir, "README-release.md"),
  [
    `# Release ${version}`,
    "",
    "## Obsidian Community Plugin",
    "",
    "Upload these files to the GitHub Release whose tag matches the plugin version:",
    "",
    "- `release/obsidian/main.js`",
    "- `release/obsidian/manifest.json`",
    "- `release/obsidian/styles.css`",
    "",
    "The convenience zip is also available at:",
    "",
    `- \`release/memos-card-view-${version}-obsidian.zip\``,
    "",
    "## Chrome / Edge Extension",
    "",
    "Upload this zip to the browser extension store:",
    "",
    `- \`release/memos-obsidian-clipper-${version}-chrome.zip\``,
    "",
  ].join("\n"),
);

process.stdout.write(`Packaged release ${version} in ${path.relative(rootDir, releaseDir)}/\n`);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".DS_Store") {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files.sort();
}

async function createZip(outputPath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const data = await readFile(entry.source);
    const info = await stat(entry.source);
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(data);
    const { time, date } = toDosDateTime(info.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(outputPath, Buffer.concat([...localParts, centralDirectory, end]));
}

function toDosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function crc32(buffer) {
  crcTable ??= createCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
}
