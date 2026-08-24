// Throwaway diagnostic script — replicates exactly what electron-builder's
// own code does internally (builder-util's executeAppBuilder(), called by
// binDownload.js's getBinFromUrl()) to download+extract the NSIS binary,
// to test whether Node.js spawning app-builder.exe (as opposed to
// PowerShell spawning it directly, which succeeded instantly in isolation)
// is what hangs. Delete once the real hang is understood and fixed.
const { executeAppBuilder } = require("builder-util");

async function main() {
  console.log("Calling executeAppBuilder (same call electron-builder itself makes)...");
  const start = Date.now();
  const out = await executeAppBuilder([
    "download-artifact",
    "--name",
    "nsis-3.0.4.1-node-repro",
    "--url",
    "https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z",
    "--sha512",
    "VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==",
  ]);
  console.log(`Done in ${Date.now() - start}ms. Output:`, out);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
