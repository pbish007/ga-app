/**
 * FAA Registry daily ingest entry point.
 * R0 skeleton — exits 0 to prove GH Actions wiring.
 * Replace with real download/parse logic in R1.
 */

async function main() {
  const snapshotDate = new Date().toISOString().slice(0, 10);
  console.log(`[faa-pipeline] noop ingest for ${snapshotDate}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
