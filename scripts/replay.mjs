#!/usr/bin/env node
// Records multi-agent runs and builds replay pages; see docs/module-extraction.md#replay-pages.
import { main } from "../src/replay/cli.ts";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
