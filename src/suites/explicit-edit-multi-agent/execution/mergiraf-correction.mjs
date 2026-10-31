import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const revisions = ["B", "A", "E"];
const roles = { B: "base", A: "actual", E: "expected" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const value = (node) => [node.kind, node.field, node.leafText];
const shape = (node) => [...value(node), node.children];
const key = (triple) => JSON.stringify(triple);
const index = () => new Map(revisions.map((revision) => [revision, new Map()]));
function add(map, id, row) {
  assert.ok(!map.has(id), "Duplicate native identity");
  map.set(id, row);
}
function triple(row) {
  assert.ok(Array.isArray(row.triple) && row.triple.length === 3);
  assert.ok(row.triple.every((part) => typeof part === "string"));
  return key(row.triple);
}

/** Independently verify directed PCS, source coverage and complete ordered AST replay.
 * Native class leaders supply correspondence, never physical definition ownership.
 */
export function validateMergirafRecords(records, inputs) {
  const nodes = index(),
    pcs = index(),
    sources = new Map(),
    summaries = new Map();
  const matchings = new Map(["B-A", "B-E", "A-E"].map((pair) => [pair, []]));
  const changes = { add: new Map(), remove: new Map() },
    values = new Map(),
    diagnostics = [];
  let header, summary;
  for (const row of records) {
    assert.ok(row && typeof row === "object" && !Array.isArray(row));
    switch (row.record) {
      case "header": {
        assert.equal(header, undefined);
        header = row;
        break;
      }
      case "summary": {
        assert.equal(summary, undefined);
        summary = row;
        break;
      }
      case "source": {
        assert.ok(revisions.includes(row.revision));
        assert.equal(typeof row.text, "string");
        const bytes = Buffer.from(row.text);
        assert.equal(bytes.toString(), row.text);
        assert.equal(bytes.length, row.bytes);
        assert.deepEqual(
          bytes,
          inputs[roles[row.revision]],
          "Native source differs from sealed input",
        );
        add(sources, row.revision, bytes);
        break;
      }
      case "node": {
        assert.ok(revisions.includes(row.revision));
        assert.match(row.leader, /^[BAE]:[0-9]+$/);
        assert.ok(Number.isSafeInteger(row.id) && row.id >= 0);
        assert.equal(typeof row.kind, "string");
        assert.ok(row.field === null || typeof row.field === "string");
        assert.ok(row.leafText === null || typeof row.leafText === "string");
        assert.ok(Array.isArray(row.children));
        assert.equal(typeof row.collapsedAllThree, "boolean");
        add(nodes.get(row.revision), row.leader, row);
        break;
      }
      case "pcs": {
        assert.ok(pcs.has(row.revision));
        add(pcs.get(row.revision), triple(row), row.triple);
        break;
      }
      case "pcs_delta": {
        assert.ok(Object.hasOwn(changes, row.action));
        add(changes[row.action], triple(row), row.triple);
        break;
      }
      case "node_value_delta": {
        add(values, row.leader, row);
        break;
      }
      case "matching": {
        assert.ok(matchings.has(row.pair));
        matchings.get(row.pair).push(row);
        break;
      }
      case "matching_summary": {
        assert.ok(matchings.has(row.pair));
        add(summaries, row.pair, row);
        break;
      }
      case "base_parse_recovery": {
        assert.equal(row.revision, "B");
        assert.equal(typeof row.diagnostic, "string");
        diagnostics.push(row);
        break;
      }
      case "opaque_parse_recovery": {
        assert.ok(["A", "E"].includes(row.revision));
        assert.equal(typeof row.diagnostic, "string");
        diagnostics.push(row);
        break;
      }
      default: {
        assert.fail("Unsupported native correction record");
      }
    }
  }
  assert.equal(header?.schema, "lpt944-mergiraf-pcs-probe-v1");
  assert.equal(header.engineVersion, "0.20.0");
  assert.equal(header.mergeExecuted, false);
  assert.equal(header.baseRole, "B");
  assert.equal(header.actualRole, "A");
  assert.equal(header.expectedRole, "E");
  assert.equal(header.recoveryPolicy, "opaque-cst-regions");
  assert.equal(summary?.status, "ok");
  assert.equal(summary.complete, true);
  assert.equal(sources.size, 3);
  const orders = new Map(),
    nativeIds = index();
  for (const revision of revisions) {
    const inventory = nodes.get(revision),
      bytes = sources.get(revision),
      roots = [];
    for (const [leader, node] of inventory) {
      add(nativeIds.get(revision), node.id, leader);
      assert.ok(Number.isSafeInteger(node.start) && Number.isSafeInteger(node.end));
      assert.ok(0 <= node.start && node.start <= node.end && node.end <= bytes.length);
      for (const offset of [node.start, node.end])
        assert.ok(
          offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80,
          "Native span splits a UTF-8 code point",
        );
      if (node.leafText !== null) {
        assert.equal(node.children.length, 0);
        assert.equal(bytes.subarray(node.start, node.end).toString(), node.leafText);
      } else assert.ok(node.children.length > 0);
      if (node.parent === null) roots.push(leader);
      else assert.ok(inventory.has(node.parent));
      let end = node.start;
      for (const childId of node.children) {
        const child = inventory.get(childId);
        assert.ok(child);
        assert.equal(child.parent, leader);
        assert.ok(child.start >= end && child.end <= node.end);
        end = child.end;
      }
    }
    assert.equal(roots.length, 1);
    const order = [],
      seen = new Set(),
      pending = [roots[0]];
    while (pending.length) {
      const leader = pending.pop();
      assert.ok(!seen.has(leader), "Cycle or multiply-parented native node");
      seen.add(leader);
      order.push(leader);
      pending.push(...inventory.get(leader).children.toReversed());
    }
    assert.equal(seen.size, inventory.size);
    orders.set(revision, order);
  }
  for (const revision of revisions)
    for (const [leader, node] of nodes.get(revision)) {
      const [origin, id] = leader.split(":");
      assert.equal(nativeIds.get(origin).get(Number(id)), leader);
      if (node.collapsedAllThree)
        for (const side of revisions) {
          assert.ok(nodes.get(side).has(leader));
          assert.deepEqual(shape(nodes.get(side).get(leader)), shape(node));
        }
    }
  for (const [pair, matching] of matchings) {
    assert.equal(summaries.get(pair)?.full, matching.length);
    const [left, right] = pair.split("-"),
      seenLeft = new Set(),
      seenRight = new Set();
    for (const row of matching) {
      assert.ok(!seenLeft.has(row.leftId) && !seenRight.has(row.rightId));
      seenLeft.add(row.leftId);
      seenRight.add(row.rightId);
      assert.ok(nativeIds.get(left).has(row.leftId) && nativeIds.get(right).has(row.rightId));
      assert.equal(nativeIds.get(left).get(row.leftId), nativeIds.get(right).get(row.rightId));
    }
  }
  for (const action of ["remove", "add"]) {
    const from = pcs.get(action === "remove" ? "A" : "E"),
      to = pcs.get(action === "remove" ? "E" : "A");
    assert.deepEqual(
      new Set(changes[action].keys()),
      new Set([...from.keys()].filter((item) => !to.has(item))),
    );
  }
  function edgesFrom(triples) {
    const edges = new Map();
    for (const [parent, before, after] of triples) {
      if (!edges.has(parent)) edges.set(parent, new Map());
      assert.ok(!edges.get(parent).has(before), "Conflicting PCS successor");
      edges.get(parent).set(before, after);
    }
    return edges;
  }
  function childrenFrom(edges, leader, fallback) {
    if (!edges.has(leader)) {
      assert.equal(fallback?.collapsedAllThree, true, "Missing PCS parent");
      return fallback.children;
    }
    const chain = edges.get(leader),
      seen = new Set(),
      children = [];
    let current = "START";
    for (;;) {
      assert.ok(!seen.has(current) && chain.has(current), "Broken PCS successor chain");
      seen.add(current);
      const after = chain.get(current);
      if (after === "END") break;
      assert.ok(after !== "ROOT" && after !== "START");
      children.push(after);
      current = after;
    }
    assert.equal(seen.size, chain.size, "Unreachable PCS relation");
    return children;
  }
  for (const revision of revisions) {
    const inventory = nodes.get(revision),
      edges = edgesFrom(pcs.get(revision).values());
    assert.deepEqual(childrenFrom(edges, "ROOT"), [orders.get(revision)[0]]);
    for (const [leader, node] of inventory)
      assert.deepEqual(childrenFrom(edges, leader, node), node.children);
    assert.ok([...edges.keys()].every((leader) => leader === "ROOT" || inventory.has(leader)));
  }
  const replayed = new Map(pcs.get("A"));
  for (const id of changes.remove.keys()) replayed.delete(id);
  for (const [id, item] of changes.add) replayed.set(id, item);
  const edges = edgesFrom(replayed.values()),
    seen = new Set(),
    changedValues = new Set();
  const root = childrenFrom(edges, "ROOT");
  assert.equal(root.length, 1);
  const pending = [...root];
  while (pending.length) {
    const leader = pending.pop();
    assert.ok(!seen.has(leader));
    seen.add(leader);
    const actual = nodes.get("A").get(leader),
      expected = nodes.get("E").get(leader);
    assert.ok(expected);
    const node = { ...(actual ?? expected) },
      change = values.get(leader);
    if (actual && key(value(actual)) !== key(value(expected))) changedValues.add(leader);
    if (change)
      Object.assign(node, {
        kind: change.expectedKind,
        field: change.expectedField,
        leafText: change.expectedLeafText,
      });
    const children = childrenFrom(edges, leader, actual);
    assert.deepEqual(
      [...value(node), children],
      shape(expected),
      "Directed PCS/value replay differs",
    );
    pending.push(...children.toReversed());
  }
  assert.deepEqual(seen, new Set(nodes.get("E").keys()));
  assert.deepEqual(new Set(values.keys()), changedValues);
  for (const [field, count] of Object.entries({
    baseNodes: nodes.get("B").size,
    actualNodes: nodes.get("A").size,
    expectedNodes: nodes.get("E").size,
    actualPcs: pcs.get("A").size,
    expectedPcs: pcs.get("E").size,
    removePcs: changes.remove.size,
    addPcs: changes.add.size,
    nodeValueChanges: values.size,
  }))
    assert.equal(summary[field], count);
  const indexes = new Map(
    revisions.map((revision) => [
      revision,
      new Map(orders.get(revision).map((leader, id) => [leader, id])),
    ]),
  );
  function table(revision) {
    const ids = indexes.get(revision);
    return orders.get(revision).map((leader) => {
      const n = nodes.get(revision).get(leader);
      return [
        ids.get(leader),
        n.kind,
        key([n.field, n.leafText]),
        n.start,
        n.end - n.start,
        n.parent === null ? -1 : ids.get(n.parent),
        n.children.map((child) => ids.get(child)),
      ];
    });
  }
  return {
    actualNodes: table("A"),
    expectedNodes: table("E"),
    mappings: orders
      .get("A")
      .filter((leader) => indexes.get("E").has(leader))
      .map((leader) => [indexes.get("A").get(leader), indexes.get("E").get(leader)]),
    verification: {
      engineVersion: header.engineVersion,
      pcsReplayExact: true,
      astReplayExact: true,
      sourceSha256: Object.fromEntries(
        revisions.map((revision) => [roles[revision], hash(sources.get(revision))]),
      ),
      diagnostics,
    },
  };
}

/** Run an explicitly configured, separately supplied native helper. Never edit a candidate. */
export async function prepareMergirafCorrection({
  command,
  base,
  actual,
  expected,
  directory,
  signal,
  timeout = 180_000,
}) {
  assert.ok(
    Array.isArray(command) &&
      command.length &&
      command.every((part) => typeof part === "string" && !part.includes("\0")),
  );
  assert.ok(path.isAbsolute(command[0]), "Native correction executable must be absolute");
  signal?.throwIfAborted();
  const inputs = { base, actual, expected };
  for (const bytes of Object.values(inputs))
    assert.ok(
      Buffer.isBuffer(bytes) && Buffer.from(bytes.toString()).equals(bytes),
      "Native C++ correction requires valid UTF-8",
    );
  await mkdir(directory, { mode: 0o700 });
  const inputPaths = [];
  for (const [name, bytes] of Object.entries(inputs)) {
    const file = path.join(directory, `${name}.cpp`);
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    inputPaths.push(file);
  }
  const receipt = {
    executableSha256: hash(await readFile(command[0])),
    command,
    sourceSha256: Object.fromEntries(
      Object.entries(inputs).map(([name, bytes]) => [name, hash(bytes)]),
    ),
  };
  let result, running;
  try {
    running = execute(
      command[0],
      [...command.slice(1), ...inputPaths, path.join(directory, "native")],
      {
        signal,
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LPT944_BASE_RECOVERY: "1", LPT944_RECOVER_ALL: "1" },
      },
    );
    result = await running;
    receipt.exitCode = 0;
  } catch (error) {
    result = error;
    const child = running?.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null)
      await new Promise((resolve) => child.once("close", resolve));
    receipt.exitCode = child?.exitCode ?? (Number.isInteger(error.code) ? error.code : null);
    receipt.signal = child?.signalCode ?? error.signal ?? null;
    receipt.errorCode = error.code ?? null;
    throw error;
  } finally {
    await writeFile(path.join(directory, "stdout.txt"), result?.stdout ?? "", {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "stderr.txt"), result?.stderr ?? "", {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "execution.json"), JSON.stringify(receipt) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  signal?.throwIfAborted();
  const text = await readFile(path.join(directory, "native", "probe.ndjson"), "utf8");
  assert.ok(text.endsWith("\n"), "Truncated native correction evidence");
  const verified = validateMergirafRecords(
    text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
    inputs,
  );
  await writeFile(
    path.join(directory, "verification.json"),
    JSON.stringify(verified.verification) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return verified;
}
