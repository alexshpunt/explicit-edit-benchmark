"""Check the generated card with the real HF loader, without network or model calls.

Run with Python that has datasets installed: python3 test/huggingface-viewer.py
"""

import gzip
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from datasets import load_dataset


ROOT = Path(__file__).resolve().parents[1]


class ConfigurationViewerTest(unittest.TestCase):
    def test_empty_shard_before_populated_shard(self):
        with tempfile.TemporaryDirectory(prefix="hf-viewer-") as temporary:
            output = Path(temporary) / "dataset"
            subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    """
import path from 'node:path';
import { bundle } from './test/helpers/normalized-bundle.mjs';
import { buildPublicDataset } from './scripts/build-public-dataset.mjs';
const root = process.argv[1];
const empty = path.join(root, 'empty');
const filled = path.join(root, 'filled');
await bundle(empty, 'a-empty');
await bundle(filled, 'b-filled', { provider: 'test-provider', transport: 'stdio' }, {}, {
  tools: ['edit', 'read'], extensions: ['test-extension'], rules: ['test-rule'],
  runtimeFlags: ['safe-mode'], environment: ['TEST_TOKEN'], configurationLabels: ['test-label'],
});
await buildPublicDataset(path.join(root, 'dataset'), [empty, filled]);
""",
                    temporary,
                ],
                cwd=ROOT,
                check=True,
            )
            for streaming in (True, False):
                with self.subTest(streaming=streaming):
                    rows = list(
                        load_dataset(
                            str(output),
                            name="configurations",
                            split="train",
                            streaming=streaming,
                            cache_dir=str(Path(temporary) / "cache"),
                        )
                    )
                    self.assertEqual(len(rows), 2)
                    self.assertIsNone(rows[0]["provider"])
                    self.assertEqual(rows[0]["tools"], [])
                    self.assertEqual(rows[1]["provider"], "test-provider")
                    self.assertEqual(rows[1]["tools"], ["edit", "read"])
                    self.assertEqual(rows[1]["rules"], ["test-rule"])
                    # Every published value survives loading, including null and empty lists.

                    expected = []
                    for file in sorted((output / "data" / "configurations").glob("*.gz")):
                        with gzip.open(file, "rt") as source:
                            expected.extend(json.loads(line) for line in source if line.strip())
                    self.assertEqual(rows, expected)


if __name__ == "__main__":
    unittest.main()
