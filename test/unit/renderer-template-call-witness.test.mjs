import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectAst } from "../../src/suites/explicit-edit-multi-agent/cpp/compiler-ast.mjs";
import { semanticSession } from "../../src/suites/explicit-edit-multi-agent/cpp/clangd-renames.mjs";
import { createTemplateCallWitness } from "../../src/suites/explicit-edit-multi-agent/cpp/template-call-witness.mjs";

const declarations = `namespace frond {
template<class T> struct Box {};
template<class T, int N> struct Fixed {};
template<class T> bool pick(const Box<Box<T>>&);
template<class T, int N> bool pick(const Box<Fixed<T, N>>&);
`;

async function fixture(source, run, flags = ["-std=c++17"]) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/template-call-witness-"));
  const file = path.join(directory, "main.cpp");
  await writeFile(file, source);
  let compiler;
  try {
    const roots = await projectAst(file, flags);
    compiler = await semanticSession(file, source, flags);
    const nodes = new Map();
    const calls = [];
    function collect(node) {
      if (node.id) nodes.set(node.id, node);
      if (node.kind === "CallExpr" && node.inner?.[0]?.kind === "UnresolvedLookupExpr")
        calls.push(node);
      for (const child of node.inner ?? []) collect(child);
    }
    for (const root of roots) collect(root);
    const groups = new Map();
    for (const node of nodes.values()) {
      if (node.kind !== "FunctionTemplateDecl" || node.name !== "pick") continue;
      let first = node;
      while (first.previousDecl) first = nodes.get(first.previousDecl);
      if (!groups.has(first.id)) groups.set(first.id, []);
      groups
        .get(first.id)
        .push(...(node.inner ?? []).filter((child) => child.kind === "FunctionDecl"));
    }
    const families = [...groups.values()];
    const selected = families.find((family) => family[0].type.qualType.includes("Box<Box<T>>"));
    const alternate = families.find((family) => family !== selected);
    const witness = createTemplateCallWitness(roots, source, {
      ast: (range) => compiler.ast(range),
      symbols: (position) => compiler.symbols(position),
    });
    await run({ witness, families, selected, alternate, calls, roots });
  } finally {
    compiler?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a visible fully deducible sibling dominates only the other nested-template call", async () => {
  const source = `${declarations}
template<class U> bool lists(const Box<Box<U>>& value) { return pick(value); }
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, alternate, calls }) => {
    assert.equal(calls.length, 2);
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[1] }),
      true,
    );
    assert.equal(
      await witness({ selectedFunctions: alternate, candidateFamilies: families, call: calls[0] }),
      true,
    );
    assert.equal(
      await witness({ selectedFunctions: alternate, candidateFamilies: families, call: calls[1] }),
      false,
    );
  });
});

test("an exact sibling must belong to the call's original lookup set", async () => {
  const source = `namespace frond {
template<class T> struct Box {};
template<class T, int N> struct Fixed {};
template<class T, int N> struct Box<Fixed<T, N>> : Box<Box<T>> {};
template<class T> bool pick(const Box<Box<T>>&);
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
template<class T, int N> bool pick(const Box<Fixed<T, N>>&);
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("a visible exact sibling outranks a selected overload's derived-to-base recovery", async () => {
  const source = `${declarations}
template<class T, int N> struct Box<Fixed<T, N>> : Box<Box<T>> {};
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      true,
    );
  });
});

test("an enable_if attribute on the exact sibling prevents a viability witness", async () => {
  const source = `${declarations.replace(
    "bool pick(const Box<Fixed<T, N>>&);",
    'bool pick(const Box<Fixed<T, N>>&) __attribute__((enable_if(false, "disabled")));',
  )}
template<class T, int N> struct Box<Fixed<T, N>> : Box<Box<T>> {};
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("a trailing constraint is not assumed satisfied by structural deduction", async () => {
  const source =
    declarations.replace(
      "bool pick(const Box<Fixed<T, N>>&);",
      "bool pick(const Box<Fixed<T, N>>&) requires (sizeof(T) > 1);",
    ) +
    `
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(
    source,
    async ({ witness, families, selected, calls }) => {
      assert.equal(
        await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
        false,
      );
    },
    ["-std=c++20"],
  );
});
test("identical dependent earlier parameter patterns do not establish equal conversions", async () => {
  const source = `${declarations.replaceAll("bool pick(", "bool pick(decltype(T{}), ")}
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(0, value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("volatile actual arguments are not silently reduced to const reference matches", async () => {
  const source = `${declarations}
template<class U> bool arrays(const volatile Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("non-type deduction preserves the declared argument type", async () => {
  const source = `${declarations.replace(
    "template<class T, int N> bool pick",
    "template<class T, unsigned long N> bool pick",
  )}
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("every sibling template parameter must be deduced", async () => {
  const source = `${declarations.replace(
    "template<class T, int N> bool pick",
    "template<class T, int N, class Unused> bool pick",
  )}
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("alias template spellings cannot masquerade as distinct primary constructors", async () => {
  const source = `${declarations.replace(
    "template<class T, int N> struct Fixed {};",
    "template<class T, int N> using Fixed = Box<T>;",
  )}
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("an explicit const-reference cast supplies the actual type without guessing its operand type", async () => {
  const source = `${declarations}
template<class U> bool arrays(const Box<U>& value) { return pick((const Box<Fixed<U, 1>>&)value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      true,
    );
  });
});

test("namespace-distinct primary templates with the same display name retain different identities", async () => {
  const source = `namespace left { template<class T> struct Item {}; }
namespace right { template<class T> struct Item {}; }
namespace frond {
template<class T> struct Box {};
template<class T> bool pick(const Box<left::Item<T>>&);
template<class T> bool pick(const Box<right::Item<T>>&);
template<class U> bool arrays(const Box<right::Item<U>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, calls }) => {
    const selected = families.find((family) => family[0].type.qualType.includes("left::Item"));
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      true,
    );
  });
});

test("an imported alias template is not mistaken for an imported primary class template", async () => {
  const source = `namespace frond { template<class T> struct Box {}; }
namespace types { template<class T, int N> using Fixed = frond::Box<T>; }
namespace frond {
using types::Fixed;
template<class T> bool pick(const Box<Box<T>>&);
template<class T, int N> bool pick(const Box<Fixed<T, N>>&);
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("repeated type parameters must deduce the same actual type", async () => {
  const source = `namespace frond {
template<class T> struct Box {};
template<class A, class B> struct Pair {};
template<class T> bool pick(const Box<Box<T>>&);
template<class T> bool pick(const Box<Pair<T, T>>&);
template<class U> bool arrays(const Box<Pair<U, int>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});

test("compiler byte origins and clangd UTF-16 positions remain distinct after Unicode", async () => {
  const source = `// 🐚\n${declarations}
template<class U> bool arrays(const Box<Fixed<U, 3>>& value) { return pick(value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, selected, calls }) => {
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      true,
    );
  });
});

test("standard-container defaults and concrete prefix parameters retain a sound exact sibling", async () => {
  const source = `#include <vector>
#include <array>
#include <string>
namespace frond {
using std::vector;
using std::array;
using std::string;
template<class T> bool pick(int, const string&, const vector<vector<T>>&);
template<class T, size_t N> bool pick(int, const string&, const vector<array<T, N>>&);
template<class U> bool arrays(int item, const vector<array<U, 3>>& value) { return pick(item, "label", value); }
}
int main() {}
`;
  await fixture(source, async ({ witness, families, calls }) => {
    const selected = families.find((family) =>
      family[0].type.qualType.includes("vector<vector<T>>"),
    );
    assert.equal(
      await witness({ selectedFunctions: selected, candidateFamilies: families, call: calls[0] }),
      true,
    );
  });
});
