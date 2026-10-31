import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import {
  prepareCanonical,
  loadCanonicalPreparation,
} from "../../src/suites/explicit-edit-multi-agent/execution/canonical-preparation.mjs";
import { runCanonical } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-run.mjs";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import { canonicalizeTrustedProject } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-candidate.mjs";
import { compareCanonicalDiff } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-diff.mjs";
import { canonicalCorrectionNodes } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-diagnostics.mjs";
import { coherentTaskPrompt } from "../../src/suites/explicit-edit-multi-agent/tasks/coherent-tasks.mjs";
import {
  canonicalMultiAgentResult,
  validateCanonicalResult,
} from "../../src/suites/explicit-edit-multi-agent/canonical-results.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { multiAgentMain } from "../../scripts/multi-agent.mjs";

function userPrompt(body) {
  const content = body.messages.findLast(({ role }) => role === "user")?.content;
  return typeof content === "string"
    ? content
    : (content ?? []).map((item) => item.text ?? "").join("");
}

// Commands come from the controller's fixture operations, not from parsing the
// wording an agent receives. Pi still executes every command in its real mount.
function renameCommand(assignments, corrections, files = []) {
  return `python3 - <<'PY'
from pathlib import Path
import re,json,fcntl,hashlib
requests=json.loads(${JSON.stringify(JSON.stringify({ assignments, corrections, files }))})
for item in requests['files']:
    path=Path(item['path'])
    assert str(path).startswith('/feedback/')
    assert not Path('/workspace/feedback').exists()
    assert hashlib.sha256(path.read_bytes()).hexdigest()==item['sha256']
    try:
        with path.open('ab') as f: f.write(b'forbidden')
    except OSError:
        pass
    else:
        raise AssertionError('assignment mount is writable')
p=Path('/workspace/main.cpp')
with p.open('r+') as f:
    fcntl.flock(f,fcntl.LOCK_EX)
    text=f.read()
    for request in requests['assignments']:
        for item in request['mapping']:
            before,after=item['from'],item['to']
            if before=='wrong':
                name=request['selectors'][0]['owner']['scope'].split('::')[-1]
                pattern=r'\\bint\\s+'+re.escape(name)+r'\\([^)]*\\)\\s*\\{[^}]*\\}'
                matches=list(re.finditer(pattern,text))
                assert len(matches)==1
                match=matches[0]
                part=re.sub(r'\\b'+re.escape(before)+r'\\b',after,match.group())
                text=text[:match.start()]+part+text[match.end():]
            else:
                text=re.sub(r'\\b'+re.escape(before)+r'\\b',after,text)
    for correction in requests['corrections']:
        for before,after in correction:
            text=re.sub(r'\\b'+re.escape(before)+r'\\b',after,text)
    f.seek(0);f.write(text);f.truncate()
PY`;
}

function correctionRenames({ repair }) {
  assert.equal(repair.action, "replace");
  assert.equal(repair.path, "main.cpp");
  const identifiers = (source) =>
    cppTokens(source)
      .map(({ text }) => text)
      .filter((text) => /^[A-Za-z_]\w*$/.test(text));
  const before = identifiers(repair.before),
    after = identifiers(repair.after);
  assert.equal(before.length, after.length);
  const pairs = before.flatMap((name, index) =>
    name === after[index] ? [] : [[name, after[index]]],
  );
  assert.ok(pairs.length > 0);
  return [...new Map(pairs)];
}

async function assertClosed(namespaces) {
  const remaining = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!namespaces.has(await readlink(`/proc/${pid}/ns/pid`))) continue;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const state = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[0];
      if (!["Z", "X"].includes(state)) remaining.push(pid);
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  assert.deepEqual(remaining, []);
}

const preparation = process.env.RENDERER_CANONICAL_PREPARATION;
const proofPath = process.env.RENDERER_CANONICAL_PROOF;
const runtime = process.env.RENDERER_CANONICAL_RUNTIME ?? process.env.RENDERER_PI_IDE_RUNTIME;
const harness = process.env.RENDERER_CANONICAL_HARNESS ?? "pi-agent-ide-codemode";

async function nativeProvider(t, root, respond) {
  const provider = await providerFixture(root, respond);
  if (harness === "baseline-agent")
    t.after(() => {
      for (const request of provider.requests) {
        assert.deepEqual(
          request.tools.map((tool) => tool.function.name),
          ["bash"],
        );
        assert.ok(
          !request.messages.some((message) => message.role === "system" && message.content),
        );
      }
    });
  return provider;
}
const options = {
  skip: !preparation || !proofPath || !runtime || process.platform !== "linux",
  timeout: 180000,
};

function replacePixels(before, after) {
  return `python3 - <<'PY'\nfrom pathlib import Path\np=Path('/workspace/main.cpp')\ns=p.read_text()\nbefore=${JSON.stringify(before)}\nassert s.count(before)==1\np.write_text(s.replace(before,${JSON.stringify(after)}))\nPY`;
}
for (const scenario of [
  "exact",
  "missed-first",
  "wrong-first",
  "long-feedback",
  "four-waves",
  "transient-first",
]) {
  const missedFirst = scenario === "missed-first";
  const longFeedback = scenario === "long-feedback";
  const wrongFirst = scenario === "wrong-first" || longFeedback;
  const structuralCorrection = missedFirst || wrongFirst;
  const fourWaves = scenario === "four-waves";
  const transientFirst = scenario === "transient-first";
  test(
    `the canonical runner measures actual native edits, fresh corrections and trusted round resets (${scenario})`,
    options,
    async (t) => {
      await mkdir(path.resolve(".tmp"), { recursive: true });
      const root = await mkdtemp(path.resolve(".tmp/canonical-native-run-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const cache = path.join(root, "cache");
      const prepared = await prepareCanonical(preparation, cache, {
        agents: 2,
        proofPath,
        signal: t.signal,
      });
      const loaded = await loadCanonicalPreparation(preparation, cache, {
        agents: 2,
        signal: t.signal,
      });
      let first = true;
      const userCounts = [];
      const commands = new Map();
      const commandStates = new Map();
      let transientPrompt, replayProof;
      let transientFailures = 0;
      const transientUserCounts = [];
      const deliveredFiles = [];
      const provider = await nativeProvider(t, root, (body) => {
        const prompt = userPrompt(body);
        if (transientFirst && transientPrompt === undefined) {
          transientPrompt = prompt;
          replayProof = path.join(commandStates.get(prompt), "recovery-once.txt");
        }
        if (transientFirst && prompt === transientPrompt)
          transientUserCounts.push(body.messages.filter(({ role }) => role === "user").length);
        if (body.messages.at(-1).role === "tool") {
          if (transientFirst && prompt === transientPrompt && transientFailures < 4) {
            transientFailures++;
            return { streamError: '{"detail":"Rate limit exceeded"}' };
          }
          return {};
        }
        userCounts.push(body.messages.filter(({ role }) => role === "user").length);
        assert.ok(commands.has(prompt), "Native request did not match its assigned editing packet");
        const prefix =
          transientFirst && prompt === transientPrompt
            ? "printf 'once\\n' >> /state/recovery-once.txt;\n"
            : "";
        return { command: prefix + commands.get(prompt) };
      });
      t.after(() => provider.close());
      const namespaces = new Set();
      let captures = 0;
      const report = await runCanonical(preparation, path.join(root, "run"), {
        canonicalPath: cache,
        agents: 2,
        maxConcurrentAgents: 2,
        batchSize: 10,
        signal: t.signal,
        createDriver: async (
          workspace,
          state,
          _agent,
          { stage, round, signal, feedbackDirectory, onRecovery, onProviderFailure },
        ) => {
          const driver = await startPiParticipant(
            workspace,
            state,
            { ...provider.config, runtime, harness },
            {
              signal,
              feedbackDirectory,
              enforceProcessBoundary: true,
              onRecovery,
              onProviderFailure,
            },
          );
          const execute = driver.execute;
          driver.execute = async (prompt, execution) => {
            const files = [];
            let delivered = prompt;
            for (const name of await readdir(feedbackDirectory)) {
              const file = `/feedback/${name}`;
              if (!prompt.includes(file)) continue;
              const text = await readFile(path.join(feedbackDirectory, name), "utf8");
              delivered += "\n" + text;
              files.push({ path: file, sha256: createHash("sha256").update(text).digest("hex") });
              deliveredFiles.push({ stage, round, text, file });
            }
            const damageOriginal = first && wrongFirst;
            let command;
            if (first && fourWaves)
              command = replacePixels("pixels[i] = float(", "pixels[i] = float(;");
            else if (first && missedFirst) command = "true";
            else if (fourWaves && stage === "structural-correction") command = "true";
            else if (fourWaves && stage === "build-correction")
              command = replacePixels("pixels[i] = float(;", "pixels[i] = float(1 + ");
            else if (fourWaves && stage === "image-correction")
              command = replacePixels("pixels[i] = float(1 + ", "pixels[i] = float(");
            else if (stage === "original") {
              const assignments = structuredClone(
                loaded.atomicIntervals.rounds
                  .get(round)
                  .nodes.filter((node) =>
                    delivered.includes(coherentTaskPrompt("", node.operations)),
                  )
                  .flatMap(({ operations }) => operations),
              );
              assert.ok(assignments.length > 0);
              if (damageOriginal)
                assignments[0].mapping[0].to += longFeedback
                  ? "_feedback_wrong".repeat(600)
                  : "_feedback_wrong";
              command = renameCommand(assignments, [], files);
            } else {
              const preparedDiff = loaded.canonical.rounds.get(round).preparedDiff;
              const snapshot = await canonicalizeTrustedProject({
                "main.cpp": await readFile(path.join(workspace, "main.cpp"), "utf8"),
              });
              const repairs = (
                await canonicalCorrectionNodes(
                  compareCanonicalDiff(preparedDiff, snapshot),
                  preparedDiff.start,
                  {
                    actual: {
                      contents: new Map([
                        [
                          Buffer.from("main.cpp").toString("base64"),
                          Buffer.from(await readFile(path.join(workspace, "main.cpp"), "utf8")),
                        ],
                      ]),
                    },
                    expected: loaded.atomicIntervals.rounds.get(round).expectedTree,
                  },
                )
              ).filter(({ prompt }) => delivered.includes(prompt));
              assert.ok(repairs.length > 0);
              command = renameCommand([], repairs.map(correctionRenames), files);
            }
            first = false;
            commands.set(prompt, command);
            commandStates.set(prompt, state);
            const result = await execute(prompt, execution);
            assert.equal(result.failedToolCalls, 0);
            return result;
          };
          return driver;
        },
        onCase: async (event) => {
          if (event.kind === "participant") namespaces.add(event.participant.process.namespace);
          if (event.kind === "captured") {
            await assertClosed(namespaces);
            const manifest = JSON.parse(
              await readFile(
                path.join(
                  root,
                  "run",
                  "rounds",
                  event.round,
                  event.stage,
                  "candidate",
                  "manifest.json",
                ),
                "utf8",
              ),
            );
            assert.deepEqual(
              manifest.entries.map(({ path }) => path),
              ["main.cpp"],
            );
            captures++;
          }
        },
      });
      assert.equal(report.status, "complete", JSON.stringify(report.terminal));
      if (longFeedback) {
        assert.ok(
          deliveredFiles.some(
            ({ stage, text, file }) =>
              stage === "structural-correction" &&
              Buffer.byteLength(text) > 4096 &&
              file.endsWith(".txt"),
          ),
        );
      }
      if (transientFirst) {
        assert.equal(transientFailures, 4);
        assert.ok(transientUserCounts.every((count) => count === 1));
        assert.equal(await readFile(replayProof, "utf8"), "once\n");
        assert.ok(report.providerRecovery.some(({ type }) => type === "provider_recovery_probe"));
        assert.equal(
          report.executions.filter(({ receipt }) =>
            receipt.lifecycle.some(
              ({ type, success }) => type === "provider_recovery_end" && success === true,
            ),
          ).length,
          1,
        );
      }
      assert.equal(report.rounds.length, prepared.scope.totalRounds);
      assert.equal(
        captures,
        prepared.scope.totalRounds + (fourWaves ? 3 : Number(structuralCorrection)),
      );
      assert.ok(report.agentsClosed.every(Boolean));
      assert.equal(report.repairs, fourWaves ? 3 : Number(structuralCorrection));
      assert.equal(report.score.score, fourWaves ? 80 : structuralCorrection ? 90 : 100);
      assert.equal(report.score.firstStructuralScore, structuralCorrection || fourWaves ? 80 : 100);
      assert.equal(report.rounds[0].stages.length, fourWaves ? 4 : structuralCorrection ? 2 : 1);
      if (wrongFirst) {
        assert.ok(
          report.rounds[0].stages[0].comparison.mismatches.some(({ status }) => status === "wrong"),
        );
        assert.deepEqual(report.rounds[0].stages[1].comparison.differenceIds, []);
      }
      if (fourWaves) {
        assert.deepEqual(
          report.rounds[0].stages.map(({ stage }) => stage),
          ["original", "structural-correction", "build-correction", "image-correction"],
        );
        assert.equal(report.rounds[0].score.build.factor, 0.75);
        assert.equal(report.rounds[0].score.images.factor, 0.75);
      }
      assert.ok(report.rounds.every(({ restoration }) => restoration.restored));
      assert.equal(report.final, prepared.scope.expectedFinal);
      assert.equal(provider.errors.length, 0);
      await assertClosed(namespaces);
      const safe = canonicalMultiAgentResult(report);
      assert.ok(validateCanonicalResult(safe));
      assert.equal(safe.score.score, report.score.score);
      assert.equal(safe.status, "complete");
      const exported = path.join(root, "safe.json");
      await multiAgentMain(["export-canonical", path.join(root, "run"), exported]);
      await multiAgentMain(["validate-canonical", exported]);
      await multiAgentMain(["inspect-canonical", path.join(root, "run")]);
      assert.deepEqual(JSON.parse(await readFile(exported, "utf8")), safe);
      assert.ok(userCounts.every((count) => count >= 1));
      const stageSessions = report.participants.filter(
        ({ round }) => round === report.rounds[0].round,
      );
      if (structuralCorrection || fourWaves)
        assert.equal(
          new Set(stageSessions.map(({ participant }) => participant.sessionId)).size,
          stageSessions.length,
        );
    },
  );
}

test(
  "a native provider refusal stops the canonical runner without correction or inference retry",
  options,
  async (t) => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/canonical-native-refusal-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cache = path.join(root, "cache");
    const prepared = await prepareCanonical(preparation, cache, {
      agents: 2,
      proofPath,
      signal: t.signal,
    });
    const provider = await nativeProvider(t, root, () => ({
      status: 401,
      error: "private refusal fixture",
    }));
    t.after(() => provider.close());
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ ...provider.config, runtime, harness }));
    const namespaces = new Set();
    const report = await runCanonical(preparation, path.join(root, "run"), {
      canonicalPath: cache,
      agents: 2,
      maxConcurrentAgents: 2,
      configPath,
      allowModelCalls: true,
      signal: t.signal,
      onCase: ({ kind, participant }) => {
        if (kind === "participant") namespaces.add(participant.process.namespace);
      },
    });
    assert.equal(report.status, "error");
    assert.equal(report.rounds.length, 0);
    assert.equal(report.deliveries, 1);
    assert.equal(report.repairs, 0);
    assert.equal(provider.requests.length, 1);
    assert.equal(report.participants.length, 1);
    assert.equal(namespaces.size, 1);
    assert.equal(provider.errors.length, 0);
    assert.ok(report.agentsClosed.every(Boolean));
    assert.equal(report.score.observedRounds, 0);
    assert.equal(report.score.plannedRounds, prepared.scope.totalRounds);
    await assertClosed(namespaces);
    const safe = canonicalMultiAgentResult(report);
    assert.ok(validateCanonicalResult(safe));
    assert.equal(safe.status, "error");
    assert.equal(safe.score.complete, false);
    assert.equal(safe.score.plannedRounds, prepared.scope.totalRounds);
    assert.equal(Object.hasOwn(safe.terminal, "message"), false);
  },
);

test(
  "a real native exit before initial registration retains closure without inventing identity",
  options,
  async (t) => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/canonical-native-startup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cache = path.join(root, "cache");
    const prepared = await prepareCanonical(preparation, cache, {
      agents: 2,
      proofPath,
      signal: t.signal,
    });
    const provider = await nativeProvider(t, root, () => ({}));
    t.after(() => provider.close());
    const namespaces = new Set();
    const report = await runCanonical(preparation, path.join(root, "run"), {
      canonicalPath: cache,
      agents: 2,
      maxConcurrentAgents: 2,
      signal: t.signal,
      createDriver: async (workspace, state, _agent, { signal }) => {
        const driver = await startPiParticipant(
          workspace,
          state,
          { ...provider.config, runtime, harness },
          { signal, enforceProcessBoundary: true },
        );
        const identity = await driver.assertIdle();
        namespaces.add(identity.process.namespace);
        await driver.terminate();
        return driver;
      },
    });
    assert.equal(report.status, "error");
    assert.equal(report.rounds.length, 0);
    assert.equal(report.participants.length, 1);
    assert.equal(report.participants[0].participant, null);
    assert.equal(report.participants[0].registeredMs, null);
    assert.equal(report.participants[0].closed, true);
    assert.equal(namespaces.size, 1);
    assert.equal(provider.requests.length, 0);
    assert.equal(report.deliveries, 0);
    assert.equal(report.repairs, 0);
    await assertClosed(namespaces);
    const safe = canonicalMultiAgentResult(report);
    assert.equal(validateCanonicalResult(safe), true);
    assert.equal(safe.execution.registeredParticipants, 0);
    assert.equal(safe.execution.unregisteredParticipants, 1);
    assert.equal(safe.score.plannedRounds, prepared.scope.totalRounds);
    assert.equal(safe.score.complete, false);
  },
);

test(
  "external cancellation after native closure preserves a null abort reason as cancellation",
  options,
  async (t) => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const root = await mkdtemp(path.resolve(".tmp/canonical-native-cancel-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cache = path.join(root, "cache");
    const prepared = await prepareCanonical(preparation, cache, {
      agents: 2,
      proofPath,
      signal: t.signal,
    });
    const provider = await nativeProvider(t, root, (body) =>
      body.messages.at(-1).role === "tool" ? {} : { command: "true" },
    );
    t.after(() => provider.close());
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ ...provider.config, runtime, harness }));
    const cancellation = new AbortController();
    const namespaces = new Set();
    let captures = 0;
    const report = await runCanonical(preparation, path.join(root, "run"), {
      canonicalPath: cache,
      agents: 2,
      maxConcurrentAgents: 2,
      configPath,
      allowModelCalls: true,
      signal: AbortSignal.any([t.signal, cancellation.signal]),
      onCase: async ({ kind, participant }) => {
        if (kind === "participant") namespaces.add(participant.process.namespace);
        if (kind === "captured") {
          await assertClosed(namespaces);
          captures++;
          cancellation.abort(null);
        }
      },
    });
    assert.equal(report.status, "cancelled");
    assert.equal(report.terminal.category, "cancelled");
    assert.equal(captures, 1);
    assert.equal(report.rounds.length, 0);
    assert.equal(report.deliveries, 1);
    assert.equal(report.repairs, 0);
    assert.equal(report.participants.length, 1);
    assert.deepEqual(report.agentsClosed, [true]);
    await assertClosed(namespaces);
    const safe = canonicalMultiAgentResult(report);
    assert.equal(validateCanonicalResult(safe), true);
    assert.equal(safe.status, "cancelled");
    assert.equal(safe.score.complete, false);
    assert.equal(safe.score.plannedRounds, prepared.scope.totalRounds);
  },
);
