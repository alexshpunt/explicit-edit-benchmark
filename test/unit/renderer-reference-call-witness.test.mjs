import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectAst } from "../../src/suites/explicit-edit-multi-agent/cpp/compiler-ast.mjs";
import { semanticSession } from "../../src/suites/explicit-edit-multi-agent/cpp/clangd-renames.mjs";
import { createReferenceCallWitness } from "../../src/suites/explicit-edit-multi-agent/cpp/reference-call-witness.mjs";

const setup = `namespace frond {
struct Model {}; struct Key {}; struct Result {};
template<class T> struct Dep { operator Key() const; };
Result& pick(Model&, const Key&);
const Result& pick(const Model&, const Key&);
`;

async function fixture(source, run, flags = ["-std=c++17"]) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(path.resolve(".tmp/reference-call-witness-"));
  const file = path.join(directory, "main.cpp");
  await writeFile(file, source);
  let compiler;
  try {
    const roots = await projectAst(file, flags);
    compiler = await semanticSession(file, source, flags);
    const nodes = new Map();
    const calls = [];
    function visit(node) {
      if (node.id && (!nodes.has(node.id) || node.inner)) nodes.set(node.id, node);
      if (node.kind === "CallExpr" && node.inner?.[0]?.kind === "UnresolvedLookupExpr")
        calls.push(node);
      for (const child of node.inner ?? []) visit(child);
    }
    roots.forEach(visit);
    const groups = new Map();
    for (const node of nodes.values()) {
      if (node.kind !== "FunctionDecl" || node.name !== "pick") continue;
      let first = node;
      while (first.previousDecl) first = nodes.get(first.previousDecl);
      if (!groups.has(first.id)) groups.set(first.id, []);
      groups.get(first.id).push(node);
    }
    const families = [...groups.values()];
    const mutable = families.find(
      (family) =>
        family[0].inner?.find((node) => node.kind === "ParmVarDecl")?.type.qualType === "Model &",
    );
    const readonly = families.find((family) => family !== mutable);
    const witness = createReferenceCallWitness(roots, source, {
      ast: (range) => compiler.ast(range),
      symbols: (position) => compiler.symbols(position),
    });
    await run({ witness, families, mutable, readonly, calls, roots });
  } finally {
    compiler?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("const and mutable nominal lvalues select only their visible cv-reference overload", async () => {
  await fixture(
    `${setup}
template<class T> void immutable(const Model& model, const Dep<T>& key) { pick(model, key); }
template<class T> void mutable_use(Model& model, const Dep<T>& key) { pick(model, key); }
} int main() {}
`,
    async ({ witness, families, mutable, readonly, calls }) => {
      assert.equal(calls.length, 2);
      assert.equal(
        await witness({ selectedFunctions: mutable, candidateFamilies: families, call: calls[0] }),
        true,
      );
      assert.equal(
        await witness({ selectedFunctions: readonly, candidateFamilies: families, call: calls[0] }),
        false,
      );
      assert.equal(
        await witness({ selectedFunctions: mutable, candidateFamilies: families, call: calls[1] }),
        false,
      );
      assert.equal(
        await witness({ selectedFunctions: readonly, candidateFamilies: families, call: calls[1] }),
        true,
      );
    },
  );
});

test("lambda captures cannot borrow the outer parameter's cv-reference proof", async () => {
  for (const qualifiers of ["", " mutable"]) {
    await fixture(
      `${setup}
template<class T> void use(Model& model, const Dep<T>& key) {
  [model, key]()${qualifiers} { pick(model, key); }();
}
} int main() {}
`,
      async ({ witness, families, mutable, readonly, calls }) => {
        assert.ok(calls.length > 0);
        for (const call of calls)
          for (const selectedFunctions of [mutable, readonly])
            assert.equal(
              await witness({ selectedFunctions, candidateFamilies: families, call }),
              false,
            );
      },
    );
  }
});

test("a mutable sibling declared after the generic call is not a dominance witness", async () => {
  await fixture(
    `namespace frond {
struct Model {}; struct Key {}; struct Result {};
template<class T> struct Dep { operator Key() const; };
const Result& pick(const Model&, const Key&);
template<class T> void use(Model& model, const Dep<T>& key) { pick(model, key); }
Result& pick(Model&, const Key&);
} int main() {}
`,
    async ({ witness, families, readonly, calls }) => {
      assert.equal(
        await witness({ selectedFunctions: readonly, candidateFamilies: families, call: calls[0] }),
        false,
      );
    },
  );
});

test("a second differing parameter prevents claiming identical conversions", async () => {
  await fixture(
    setup.replace("pick(Model&, const Key&)", "pick(Model&, Key&) ") +
      `
template<class T> void use(Model& model, const Dep<T>& key) { pick(model, key); }
} int main() {}
`,
    async ({ witness, families, readonly, calls }) => {
      assert.equal(
        await witness({ selectedFunctions: readonly, candidateFamilies: families, call: calls[0] }),
        false,
      );
    },
  );
});

test("unsupported attributes and defaults on a sibling cannot establish viability", async () => {
  for (const declaration of [
    'Result& pick(Model&, const Key&) __attribute__((enable_if(false, "disabled")));',
    "Result& pick(Model&, const Key& = Key{});",
  ]) {
    await fixture(
      setup.replace("Result& pick(Model&, const Key&);", declaration) +
        `
template<class T> void use(Model& model, const Dep<T>& key) { pick(model, key); }
} int main() {}
`,
      async ({ witness, families, readonly, calls }) => {
        assert.equal(
          await witness({
            selectedFunctions: readonly,
            candidateFamilies: families,
            call: calls[0],
          }),
          false,
        );
      },
    );
  }
});

test("volatile, derived, alias and unknown argument types remain conservative", async () => {
  for (const declaration of ["volatile Model&", "const volatile Model&", "Derived&", "Alias&"]) {
    await fixture(
      `${setup} struct Derived : Model {}; using Alias = Model;
template<class T> void use(${declaration} model, const Dep<T>& key) { pick(model, key); }
} int main() {}
`,
      async ({ witness, families, mutable, readonly, calls }) => {
        for (const selectedFunctions of [mutable, readonly])
          assert.equal(
            await witness({ selectedFunctions, candidateFamilies: families, call: calls[0] }),
            false,
          );
      },
    );
  }
});

test("concrete identical typedef prefix parameters preserve the cv-reference proof", async () => {
  await fixture(
    setup.replace("struct Key {};", "struct RealKey {}; using Key = RealKey;") +
      `
template<class T> void use(Model& model, const Dep<T>& key) { pick(model, key); }
} int main() {}
`,
    async ({ witness, families, readonly, calls }) => {
      assert.equal(
        await witness({ selectedFunctions: readonly, candidateFamilies: families, call: calls[0] }),
        true,
      );
    },
  );
});

test("a by-value actual argument and dependent nominal type do not certify a reference witness", async () => {
  for (const parameter of ["Model model", "T& model"]) {
    await fixture(
      `${setup}
template<class T> void use(${parameter}, const Dep<T>& key) { pick(model, key); }
} int main() {}
`,
      async ({ witness, families, readonly, calls }) => {
        assert.equal(
          await witness({
            selectedFunctions: readonly,
            candidateFamilies: families,
            call: calls[0],
          }),
          false,
        );
      },
    );
  }
});

test("an alias at the differing reference and a macro callee cannot certify suppression", async () => {
  for (const source of [
    setup.replace("struct Model {};", "struct RealModel {}; using Model = RealModel;") +
      `
template<class T> void use(Model& model, const Dep<T>& key) { pick(model, key); }
} int main() {}
`,
    `${setup}
#define APPLY pick
template<class T> void use(Model& model, const Dep<T>& key) { APPLY(model, key); }
} int main() {}
`,
  ]) {
    await fixture(source, async ({ witness, families, readonly, calls }) => {
      assert.equal(
        await witness({ selectedFunctions: readonly, candidateFamilies: families, call: calls[0] }),
        false,
      );
    });
  }
});

test("a template sibling is not treated as an ordinary mutable-reference overload", async () => {
  const source =
    setup.replace(
      "Result& pick(Model&, const Key&);",
      "template<class U> Result& pick(U&, const Key&);",
    ) +
    `
template<class T> void use(Model& model, const Dep<T>& key) { pick(model, key); }
} int main() {}
`;
  await fixture(source, async ({ witness, families, calls }) => {
    const selectedFunctions = families.find((family) =>
      family[0].type.qualType.includes("const Model &"),
    );
    assert.equal(
      await witness({ selectedFunctions, candidateFamilies: families, call: calls[0] }),
      false,
    );
  });
});
test("compiler byte origins stay distinct from clangd UTF-16 positions", async () => {
  await fixture(
    `const char* label = "💡";\n${setup}
template<class T> void use(Model& model, const Dep<T>& key) { pick(model, key); }
} int main() {}
`,
    async ({ witness, families, readonly, calls }) => {
      assert.equal(
        await witness({ selectedFunctions: readonly, candidateFamilies: families, call: calls[0] }),
        true,
      );
    },
  );
});
