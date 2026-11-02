import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { byteToCharacter } from "../cpp/cpp-offsets.mjs";
import { cppTokens, pack, treeIdentity } from "../generation/generator.mjs";
import { reverseOperation } from "../generation/inverse.mjs";
import { neutralFiles, neutralSourcePath } from "../generation/origin-markers.mjs";
import { stripProjectGuards } from "../generation/project-header-guards.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function uniform(block, start, end) {
  assert.ok(
    Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      0 <= start &&
      start < end &&
      end <= block.text.length,
  );
  const tag = block.tags[start];
  for (let index = start + 1; index < end; index++)
    assert.equal(block.tags[index], tag, "A physical source span crosses original owners");
  return tag;
}
function part(block, start, end) {
  return {
    text: block.text.slice(start, end),
    tags: block.tags.subarray(start, end),
    origins: block.origins.subarray(start, end),
  };
}
function literal(text, tag, origin = 0) {
  return {
    text,
    tags: new Uint32Array(text.length).fill(tag),
    origins: new Uint32Array(text.length).fill(origin),
  };
}
function join(parts) {
  const text = parts.map((block) => block.text).join("");
  const tags = new Uint32Array(text.length),
    origins = new Uint32Array(text.length);
  let offset = 0;
  for (const block of parts) {
    tags.set(block.tags, offset);
    origins.set(block.origins, offset);
    offset += block.text.length;
  }
  return { text, tags, origins };
}
function replace(block, edits) {
  let cursor = 0;
  const parts = [];
  for (const edit of edits) {
    assert.ok(
      Number.isSafeInteger(edit.start) &&
        Number.isSafeInteger(edit.end) &&
        cursor <= edit.start &&
        edit.start <= edit.end &&
        edit.end <= block.text.length,
    );
    parts.push(part(block, cursor, edit.start), edit.block);
    cursor = edit.end;
  }
  parts.push(part(block, cursor, block.text.length));
  return join(parts);
}
function renamed(block, edits) {
  return replace(
    block,
    edits.map((edit) => {
      assert.equal(block.text.slice(edit.start, edit.start + edit.old.length), edit.old);
      const tag = uniform(block, edit.start, edit.start + edit.old.length);
      const next = literal(edit.new, tag);
      for (let index = 0; index < next.text.length; index++)
        next.origins[index] = block.origins[edit.start + Math.min(index, edit.old.length - 1)];
      return { start: edit.start, end: edit.start + edit.old.length, block: next };
    }),
  );
}
function texts(blocks) {
  return Object.fromEntries(Object.entries(blocks).map(([file, block]) => [file, block.text]));
}

/** Trace every current character through guarded generator records, without changing the measured source. */
export function traceGenerationOrigins({ initial, manifest, mixing }) {
  assert.equal(treeIdentity(initial), manifest.final);
  assert.ok(Array.isArray(manifest.operations));
  const records = manifest.operations,
    states = Array.from({ length: records.length + 1 });
  states[records.length] = initial;
  for (let index = records.length - 1; index >= 0; index--)
    states[index] = reverseOperation(states[index + 1], records[index]);
  assert.equal(treeIdentity(states[0]), manifest.initial);
  const origins = records.filter((record) => record.kind === "origin-markers");
  assert.equal(origins.length, 1);
  const name = origins[0].name;
  const descriptors = [],
    sourceTags = new Map();
  const addTag = (descriptor) => {
    descriptors.push(descriptor);
    return descriptors.length - 1;
  };
  const blocks = {};
  for (const [file, text] of Object.entries(states[0])) {
    const tag = addTag({ originalFile: file, file: neutralSourcePath(file, name), role: "source" });
    sourceTags.set(file, tag);
    blocks[file] = literal(text, tag);
    for (let index = 0; index < text.length; index++) blocks[file].origins[index] = index;
  }
  const removedIncludes = [];
  const declarationIndex = records.findIndex((record) => record.kind === "function-declarations");
  const permutationIndex = records.findIndex((record) => record.kind === "function-permutation");
  let permutation = null;
  if (declarationIndex >= 0 || permutationIndex >= 0) {
    assert.equal(permutationIndex, declarationIndex + 1);
    assert.equal(records.filter((record) => record.kind === "function-declarations").length, 1);
    assert.equal(records.filter((record) => record.kind === "function-permutation").length, 1);
    const record = records[permutationIndex];
    assert.ok(Array.isArray(mixing?.placements));
    assert.equal(mixing.placements.length, record.slots.length);
    const final = states[permutationIndex + 1]["main.cpp"],
      bytes = Buffer.from(final);
    const occupants = new Map(record.slots.map((slot) => [slot.occupant, slot]));
    assert.equal(occupants.size, record.slots.length);
    let shift = 0,
      boundary = 0;
    const slots = record.slots.map((slot, index) => {
      assert.equal(slot.original, index);
      assert.ok(boundary <= slot.start && slot.start < slot.end);
      assert.equal(hash(bytes.subarray(slot.start, slot.end)), slot.hash);
      const original = occupants.get(index);
      assert.ok(original);
      const start = slot.start - shift,
        end = start + original.end - original.start;
      shift += slot.end - slot.start - (end - start);
      boundary = slot.end;
      return { start, end, occupant: slot.occupant };
    });
    const unshift = (start, end) => {
      let delta = 0;
      for (const [index, slot] of record.slots.entries()) {
        assert.ok(
          end <= slot.start || start >= slot.end,
          "A generated declaration overlaps a definition",
        );
        if (slot.end <= start)
          delta += slot.end - slot.start - (slots[index].end - slots[index].start);
      }
      return { start: start - delta, end: end - delta };
    };
    const prototypes = mixing.placements.map((placement, index) => {
      const slot = occupants.get(index),
        declaration = placement.declaration;
      assert.equal(placement.to.byte, slot.start);
      assert.ok(Number.isSafeInteger(declaration.length) && declaration.length > 0);
      const text = bytes
        .subarray(declaration.byte, declaration.byte + declaration.length)
        .toString("utf8");
      assert.equal(Buffer.byteLength(text), declaration.length);
      assert.equal(hash(text), declaration.hash);
      const mapped = unshift(declaration.byte, declaration.byte + declaration.length);
      const declared = Buffer.from(states[permutationIndex]["main.cpp"]);
      assert.equal(declared.subarray(mapped.start, mapped.end).toString("utf8"), text);
      return { ...mapped, text, placement, index, slot };
    });
    permutation = { slots, prototypes };
  }
  for (const [index, record] of records.entries()) {
    assert.equal(treeIdentity(texts(blocks)), record.before);
    if (record.operation) {
      const replay = pack(states[index], record.operation);
      for (const key of ["before", "after", "sourceHash", "sourceStart", "sourceLength", "edits"])
        assert.deepEqual(replay.record[key], record[key]);
      const { source, target, kind, renames = {} } = record.operation;
      const original = blocks[source],
        previous = blocks[target];
      const payload = renamed(
        original,
        cppTokens(original.text)
          .filter((token) => Object.hasOwn(renames, token.text))
          .map((token) => ({ start: token.start, old: token.text, new: renames[token.text] })),
      );
      let shift = 0;
      const edits = record.edits.map((edit, site) => {
        const start = edit.start - shift,
          end = start + edit.removed.length;
        assert.equal(previous.text.slice(start, end), edit.removed);
        const tag =
          previous.tags[Math.min(start, previous.text.length - 1)] ?? sourceTags.get(target);
        const origin = previous.origins[Math.min(start, previous.text.length - 1)] ?? 0;
        if (edit.removed) {
          // Packing may supply the terminating newline of an include at original EOF.
          // Attribute its directive tokens, retaining the entire recorded line as scaffolding.
          const coreStart = start + edit.removed.search(/\S/),
            coreEnd = start + edit.removed.trimEnd().length;
          const owner = descriptors[uniform(previous, coreStart, coreEnd)];
          removedIncludes.push({
            ...owner,
            originalStart: previous.origins[coreStart],
            text: edit.removed,
            included: source,
          });
        }
        const coreStart = edit.removed ? start + edit.removed.search(/\S/) : start;
        const container = edit.removed
          ? descriptors[previous.tags[coreStart]]
          : descriptors[sourceTags.get(target)];
        const embedding = {
          originalFile: container.originalFile,
          originalStart: edit.removed ? previous.origins[coreStart] : states[0][target].length,
          operation: index,
          site,
        };
        const copies = new Map(),
          copiedTags = new Uint32Array(payload.tags.length);
        for (let position = 0; position < copiedTags.length; position++) {
          const sourceTag = payload.tags[position];
          if (!copies.has(sourceTag))
            copies.set(
              sourceTag,
              addTag({
                ...descriptors[sourceTag],
                embedding: [...(descriptors[sourceTag].embedding ?? []), embedding],
              }),
            );
          copiedTags[position] = copies.get(sourceTag);
        }
        const copied = { ...payload, tags: copiedTags };
        const inserted =
          site === 0 || record.operation.repeat
            ? join([
                literal(kind === "append" ? "\n" : "", tag, origin),
                copied,
                literal(kind === "append" || !payload.text.endsWith("\n") ? "\n" : "", tag, origin),
              ])
            : literal("", tag, origin);
        assert.equal(inserted.text.length, edit.insertedLength);
        assert.equal(hash(inserted.text), edit.insertedHash);
        shift += inserted.text.length - edit.removed.length;
        return { start, end, block: inserted };
      });
      blocks[target] = replace(previous, edits);
      delete blocks[source];
    } else if (record.kind === "rename" || record.kind === "origin-markers") {
      blocks["main.cpp"] = renamed(blocks["main.cpp"], record.edits);
    } else if (record.kind === "project-header-guards") {
      const replay = stripProjectGuards(texts(blocks), record.headers);
      assert.deepEqual(replay.record, record);
      const block = blocks["main.cpp"];
      blocks["main.cpp"] = replace(
        block,
        record.edits.map((edit) => ({
          start: edit.start,
          end: edit.start + edit.removed.length,
          block: literal("", 0),
        })),
      );
    } else if (record.kind === "compact") {
      const block = blocks["main.cpp"];
      blocks["main.cpp"] = replace(
        block,
        record.edits.map((edit) => {
          assert.equal(
            block.text.slice(edit.start, edit.start + edit.removed.length),
            edit.removed,
          );
          assert.match(edit.removed, /^[ \t\r\n]+$/);
          return {
            start: edit.start,
            end: edit.start + edit.removed.length,
            block: literal("", 0),
          };
        }),
      );
    } else if (record.kind === "function-declarations") {
      const block = blocks["main.cpp"],
        convert = byteToCharacter(block.text),
        afterConvert = byteToCharacter(states[index + 1]["main.cpp"]);
      const layout = addTag({
        originalFile: "main.cpp",
        file: "main.cpp",
        role: "generated-layout",
      });
      let shift = 0;
      const edits = record.edits.map((edit) => {
        const start = convert(edit.start - shift);
        shift += Buffer.byteLength(edit.text);
        return { start, end: start, block: literal(edit.text, layout) };
      });
      const next = replace(block, edits),
        bytes = Buffer.from(block.text);
      for (const prototype of permutation.prototypes) {
        const { placement, slot, text } = prototype;
        const fromStart = convert(placement.from.byte),
          fromEnd = convert(placement.from.byte + slot.end - slot.start);
        const owner = descriptors[uniform(block, fromStart, fromEnd)];
        assert.equal(owner.originalFile, placement.from.source);
        assert.equal(owner.role, "source");
        assert.equal(
          hash(bytes.subarray(placement.from.byte, placement.from.byte + slot.end - slot.start)),
          slot.hash,
        );
        assert.ok(text.endsWith(";\n"));
        const prefix = text.slice(0, -2),
          definition = block.text.slice(fromStart, fromEnd);
        assert.ok(
          definition.startsWith(prefix) &&
            definition.slice(prefix.length).trimStart().startsWith("{"),
        );
        if (placement.body) {
          const body = placement.body;
          assert.equal(body.start, placement.to.byte + body.fromStart - placement.from.byte);
          assert.equal(body.fromStart + body.length, placement.from.byte + slot.end - slot.start);
          assert.equal(
            hash(bytes.subarray(body.fromStart, body.fromStart + body.length)),
            placement.bodyHash,
          );
        }
        const start = afterConvert(prototype.start),
          end = afterConvert(prototype.end);
        assert.equal(next.text.slice(start, end), text);
        assert.ok(next.tags.subarray(start, end).every((tag) => tag === layout));
        const tag = addTag({ ...owner, role: "generated-declaration" });
        next.tags.fill(tag, start, end);
        for (let position = start; position < end; position++)
          next.origins[position] =
            block.origins[fromStart + Math.min(position - start, prefix.length - 1)];
      }
      for (let position = 0; position < next.text.length; position++)
        if (next.tags[position] === layout) assert.match(next.text[position], /\s/);
      blocks["main.cpp"] = next;
    } else if (record.kind === "function-permutation") {
      const block = blocks["main.cpp"],
        convert = byteToCharacter(block.text);
      const units = permutation.slots.map((slot) =>
        part(block, convert(slot.start), convert(slot.end)),
      );
      blocks["main.cpp"] = replace(
        block,
        permutation.slots.map((slot) => ({
          start: convert(slot.start),
          end: convert(slot.end),
          block: units[slot.occupant],
        })),
      );
    } else throw new Error("Unsupported source provenance operation");
    assert.deepEqual(texts(blocks), states[index + 1]);
    assert.equal(treeIdentity(texts(blocks)), record.after);
  }
  assert.deepEqual(texts(blocks), initial);
  const block = blocks["main.cpp"],
    runs = [];
  let start = 0;
  while (start < block.text.length) {
    let end = start + 1;
    while (end < block.text.length && block.tags[end] === block.tags[start]) end++;
    runs.push({
      ...descriptors[block.tags[start]],
      start,
      end,
      originalStart: block.origins[start],
      originalEnd: block.origins[end - 1] + 1,
      text: block.text.slice(start, end),
    });
    start = end;
  }
  // Private range projection is for required scaffolding, never a replacement measured tree.
  const project = (file, begin, finish) => {
    const originalFile = Object.keys(states[0]).find(
      (candidate) => candidate === file || neutralSourcePath(candidate, name) === file,
    );
    assert.ok(originalFile !== undefined);
    assert.ok(
      Number.isSafeInteger(begin) &&
        Number.isSafeInteger(finish) &&
        0 <= begin &&
        begin <= finish &&
        finish <= states[0][originalFile].length,
    );
    const selected = [];
    let cursor = 0;
    while (cursor < block.text.length) {
      const matches = (position) =>
        descriptors[block.tags[position]].originalFile === originalFile &&
        descriptors[block.tags[position]].role === "source" &&
        begin <= block.origins[position] &&
        block.origins[position] < finish;
      if (!matches(cursor)) {
        cursor++;
        continue;
      }
      const start = cursor++;
      while (cursor < block.text.length && matches(cursor)) cursor++;
      selected.push({
        start,
        end: cursor,
        originalStart: block.origins[start],
        text: block.text.slice(start, cursor),
      });
    }
    return selected;
  };
  const files = Object.entries(states[0]).map(([originalFile, text]) => ({
    originalFile,
    file: neutralSourcePath(originalFile, name),
    text,
  }));
  return {
    initialIdentity: treeIdentity(initial),
    originName: name,
    files,
    runs,
    project,
    removedIncludes: removedIncludes.map((entry) => ({
      ...entry,
      included: neutralSourcePath(entry.included, name),
      text: neutralFiles({ [entry.originalFile]: entry.text }, name)[entry.file],
    })),
  };
}
