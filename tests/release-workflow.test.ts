import { expect, test } from "bun:test";

const workflow = await Bun.file(".github/workflows/release.yml").text();

function releaseStep(name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Release step not found: ${name}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, next);
}

const BUILD_STEPS = [
  "Build signed + notarized macOS bundles",
  "Build executable + NSIS updater installer",
];

test.each(BUILD_STEPS)("%s receives the DeBank API key", (stepName) => {
  expect(releaseStep(stepName)).toContain(
    "DEBANK_APIKEY: ${{ secrets.DEBANK_APIKEY }}",
  );
});

// Without it, `option_env!("PUBLIC_NODE_KEY")` compiles to None and every shipped
// build talks to PublicNode unauthenticated.
test.each(BUILD_STEPS)("%s receives the PublicNode RPC key", (stepName) => {
  expect(releaseStep(stepName)).toContain(
    "PUBLIC_NODE_KEY: ${{ secrets.PUBLIC_NODE_KEY }}",
  );
});
