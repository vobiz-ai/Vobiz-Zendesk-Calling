#!/usr/bin/env node
/**
 * Packages the Zendesk App for upload.
 * Ensures manifest.json, assets/, and translations/ are placed at the root of the ZIP.
 */
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

const outFile = "Vobiz-Zendesk-Calling.zip";

if (existsSync(outFile)) {
  unlinkSync(outFile);
}

try {
  execFileSync("tar", ["-a", "-cf", outFile, "manifest.json", "assets", "translations"], {
    stdio: "inherit",
  });
  console.log(`\nSuccessfully created Zendesk package: ${outFile}`);
} catch (err) {
  console.error("Failed to create package:", err);
  process.exit(1);
}
