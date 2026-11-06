import assert from "node:assert/strict";

/** Collapse layout so a signature names a unit without reproducing its source text. */
export function publicSignature(signature) {
  return signature.replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s\)/g, ")").trim();
}

const code = (text) => {
  assert.ok(!text.includes("`"), "Unsupported inline code");
  return "`" + text + "`";
};

export function describeNamed({ scope, kind, signature }) {
  const where = scope ? `in namespace ${scope}` : "in the global namespace";
  return `the ${kind.replaceAll("-", " ")} ${code(signature)} ${where}`;
}

const SHARED =
  "Several agents are editing main.cpp at the same time. It contains one region for each future project file, delimited by a `#pragma region` line naming the file and the next `#pragma endregion` line.";

function blockProse(item) {
  const lines = item.text.split("\n").map((line) => line.trim());
  const nonEmpty = lines.filter(Boolean);
  assert.ok(nonEmpty.length > 0, "Empty unnamed block");
  assert.ok(!item.text.includes("```"), "Unsupported block text");
  const position = [
    item.before ? `follows ${describeNamed(item.before)}` : "",
    item.after ? `precedes ${describeNamed(item.after)}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const bounds =
    nonEmpty.length === 1
      ? `It consists of the single line ${code(nonEmpty[0])}`
      : `Its first line is ${code(nonEmpty[0])} and its last line is ${code(nonEmpty.at(-1))}`;
  return [
    `the block of consecutive lines that, in the original main.cpp, ${position || "stands alone"}. ${bounds}. The complete block is:`,
    "```cpp",
    item.text.trim(),
    "```",
  ].join("\n");
}

/** One assembly delivery: move named units and unnamed blocks into one region. */
export function assemblyDeliveryProse(region, items) {
  assert.ok(Array.isArray(items) && items.length > 0);
  const entries = items.map((item, index) => {
    assert.equal(item.taskId, region.taskId);
    const marker = code(item.marker.trim());
    if (item.kind === "block") return `${index + 1}. Placeholder ${marker}: ${blockProse(item)}`;
    const copies =
      item.copies > 1
        ? ` main.cpp contains ${item.copies} copies of it that differ at most in spacing; move one of them.`
        : "";
    return `${index + 1}. Placeholder ${marker}: ${describeNamed(item.description)}.${copies}`;
  });
  return [
    `${SHARED} Placeholder comment lines inside a region mark where each unit belongs.`,
    `Move each unit listed below from its current place in main.cpp into the region for ${region.file}, replacing the placeholder line given for that unit with the complete unit. Keep the unit's code exactly as it is and remove it from its old place. Leave all other code, regions and placeholders unchanged.`,
    ...entries,
  ].join("\n\n");
}

/** One extraction delivery: move a whole region into its project file. */
export function extractionProse(region) {
  const replacement = region.replacement.trim();
  return [
    SHARED,
    `Move the region for ${region.file} out of main.cpp into a new file ${region.file}. ${
      region.headerLines.length
        ? `Begin the new file with these lines, in this order:\n\`\`\`cpp\n${region.headerLines.join("\n")}\n\`\`\`\nFollow them with`
        : "The new file consists of"
    } the region's contents exactly as they are, without its \`#pragma region\` and \`#pragma endregion\` lines.`,
    replacement
      ? `In main.cpp, replace the whole region, including those two lines, with the line ${code(replacement)}.`
      : "In main.cpp, remove the whole region, including those two lines.",
    "Leave the other regions and all other code unchanged.",
  ].join("\n\n");
}
