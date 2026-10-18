#!/usr/bin/env node
/**
 * Packages the Zendesk app for upload without needing a Zendesk login.
 * manifest.json, assets/ and translations/ go at the root of the zip, and
 * nothing else — the backend never belongs in the app package.
 *
 * `zcli apps:package` does the same and also validates against Zendesk, but it
 * needs `zcli login` first. This is the offline equivalent.
 *
 * Uses `zip` where it exists (macOS, most Linux). `tar -a` is only a fallback:
 * bsdtar (macOS, Windows) writes a real zip for a .zip name, GNU tar does not.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, readFileSync } from "node:fs";

const outFile = "Vobiz-Zendesk-Calling.zip";
const parts = ["manifest.json", "assets", "translations"];

if (existsSync(outFile)) unlinkSync(outFile);

const hasZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;
try {
  if (hasZip) {
    execFileSync("zip", ["-r", "-X", "-q", outFile, ...parts, "-x", "*/.DS_Store"], { stdio: "inherit" });
  } else {
    execFileSync("tar", ["-a", "-cf", outFile, ...parts], { stdio: "inherit" });
  }
} catch (err) {
  console.error("Failed to create package:", err.message);
  process.exit(1);
}

// A zip starts with "PK". Anything else (GNU tar) would be rejected on upload.
if (readFileSync(outFile).subarray(0, 2).toString() !== "PK") {
  console.error(`${outFile} is not a zip archive — install \`zip\` and run again.`);
  process.exit(1);
}
console.log(`Created ${outFile} (manifest.json at the root). Upload it under Admin Center → Apps and integrations → Zendesk Support apps → Upload private app.`);
