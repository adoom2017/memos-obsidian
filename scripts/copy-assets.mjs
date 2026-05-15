import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

await Promise.all([
  copyFile("manifest.json", "dist/manifest.json"),
  copyFile("styles.css", "dist/styles.css"),
]);
