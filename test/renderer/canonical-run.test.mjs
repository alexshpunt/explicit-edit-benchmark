import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareCanonical } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-preparation.mjs";
import { runCanonical } from "../../src/suites/explicit-edit-multi-agent/execution/canonical-run.mjs";
import { startPiParticipant } from "../../src/suites/explicit-edit-multi-agent/execution/pi-baseline.mjs";
import {
  canonicalMultiAgentResult,
  validateCanonicalResult,
} from "../../src/suites/explicit-edit-multi-agent/canonical-results.mjs";
import { providerFixture } from "./provider-fixture.mjs";
import { multiAgentMain } from "../../scripts/multi-agent.mjs";

function rows(body) {
  const text = body.messages.findLast(({ role }) => role === "user")?.content;
  const content =
    typeof text === "string" ? text : (text ?? []).map((item) => item.text ?? "").join("");
  return content.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
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
const runtime = process.env.RENDERER_PI_IDE_RUNTIME;
const options = {
  skip: !preparation || !proofPath || !runtime || process.platform !== "linux",
  timeout: 180000,
};

function replacePixels(before, after) {
  return `python3 - <<'PY'\nfrom pathlib import Path\np=Path('/workspace/main.cpp')\ns=p.read_text()\nbefore=${JSON.stringify(before)}\nassert s.count(before)==1\np.write_text(s.replace(before,${JSON.stringify(after)}))\nPY`;
}
for (const scenario of ["exact", "missed-first", "wrong-first", "four-waves"]) {
  const missedFirst = scenario === "missed-first";
  const wrongFirst = scenario === "wrong-first";
  const structuralCorrection = missedFirst || wrongFirst;
  const fourWaves = scenario === "four-waves";
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
      let first = true;
      const userCounts = [];
      const provider = await providerFixture(root, (body) => {
        if (body.messages.at(-1).role === "tool") return {};
        userCounts.push(body.messages.filter(({ role }) => role === "user").length);
        const damageOriginal = first && wrongFirst;
        if (first && fourWaves) {
          first = false;
          return { command: replacePixels("pixels[i] = float(", "pixels[i] = float(;") };
        }
        if (first && missedFirst) {
          first = false;
          return { command: "true" };
        }
        first = false;
        const publicData = rows(body);
        if (fourWaves && publicData.some(({ stage }) => stage === "structural-correction"))
          return { command: "true" };
        if (fourWaves && publicData.some(({ stage }) => stage === "build-correction"))
          return { command: replacePixels("pixels[i] = float(;", "pixels[i] = float(1 + ") };
        if (fourWaves && publicData.some(({ stage }) => stage === "image-correction"))
          return { command: replacePixels("pixels[i] = float(1 + ", "pixels[i] = float(") };
        const assignments = publicData.filter(
          (row) => row.mapping?.length && row.selectors?.length,
        );
        if (damageOriginal) {
          assert.ok(assignments.length && assignments[0].mapping.length);
          assignments[0].mapping[0].to += "_feedback_wrong";
        }
        const corrections = publicData.filter((row) => row.stage === "structural-correction");
        assert.ok(assignments.length || corrections.length);
        return {
          command: `python3 - <<'PY'
from pathlib import Path
import re,json,fcntl
requests=json.loads(${JSON.stringify(JSON.stringify({ assignments, corrections }))})
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
        delta=correction['diff']
        assert delta['version']=='canonical-diff-of-diffs-v1'
        assert delta['direction']=='actual-to-expected'
        removed=[];added=[];actual_changed=[];expected_changed=[]
        for nested_line in delta['hunk']['lines']:
            line=nested_line[1:]
            if line[:1] not in ('-','+'): continue
            record=json.loads(line[1:])
            tokens=record[1] if record[0]=='unit' else [record]
            for token in tokens:
                if len(token)==2 and token[0] in ('identifier','type_identifier','field_identifier'):
                    if nested_line[:1] in (' ','+'):
                        (removed if line[0]=='-' else added).append(token[1])
                    if line[0]=='+' and nested_line[:1]=='-': actual_changed.append(token[1])
                    if line[0]=='+' and nested_line[:1]=='+': expected_changed.append(token[1])
        if actual_changed:
            removed,added=actual_changed,expected_changed
        assert len(removed)==len(added) and removed
        for before,after in dict(zip(removed,added)).items():
            text=re.sub(r'\\b'+re.escape(before)+r'\\b',after,text)
    f.seek(0);f.write(text);f.truncate()
PY`,
        };
      });
      t.after(() => provider.close());
      const configPath = path.join(root, "config.json");
      await writeFile(
        configPath,
        JSON.stringify({ ...provider.config, runtime, harness: "pi-agent-ide-codemode" }),
      );
      const namespaces = new Set();
      let captures = 0;
      const report = await runCanonical(preparation, path.join(root, "run"), {
        canonicalPath: cache,
        agents: 2,
        maxConcurrentAgents: 2,
        batchSize: 10,
        configPath,
        allowModelCalls: true,
        signal: t.signal,
        onCase: async (event) => {
          if (event.kind === "participant") namespaces.add(event.participant.process.namespace);
          if (event.kind === "captured") {
            await assertClosed(namespaces);
            captures++;
          }
        },
      });
      assert.equal(report.status, "complete");
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
    const provider = await providerFixture(root, () => ({
      status: 401,
      error: "private refusal fixture",
    }));
    t.after(() => provider.close());
    const configPath = path.join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ ...provider.config, runtime, harness: "pi-agent-ide-codemode" }),
    );
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
    const provider = await providerFixture(root, () => ({}));
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
          { ...provider.config, runtime, harness: "pi-agent-ide-codemode" },
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
    const provider = await providerFixture(root, (body) =>
      body.messages.at(-1).role === "tool" ? {} : { command: "true" },
    );
    t.after(() => provider.close());
    const configPath = path.join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({ ...provider.config, runtime, harness: "pi-agent-ide-codemode" }),
    );
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
