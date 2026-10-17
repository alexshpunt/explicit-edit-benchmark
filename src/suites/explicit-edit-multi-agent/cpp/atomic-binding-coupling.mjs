const siteKey = (edit) => JSON.stringify([edit.file, edit.start]);

/** Validate the PRIVATE coupling record carried through trusted preparation.
 * This checks source-plan coverage and connected membership, not provenance:
 * positive compiler proof is produced by coupleAtomicBindings(), and callers
 * must bind the resulting record to their sealed source and artifact hashes.
 */
export function validateAtomicBindingCoupling(atom, bindingCount) {
  const evidence = atom.coupling;
  if (!Number.isSafeInteger(bindingCount) || bindingCount < 1)
    throw Error("Invalid semantic binding count");
  if (bindingCount === 1) {
    if (evidence !== undefined) throw Error("A singleton binding cannot claim coupling");
    return;
  }
  if (
    evidence?.version !== "renderer-atomic-coupling-v1" ||
    !/^[0-9a-f]{64}$/.test(evidence.sourceSha256 ?? "") ||
    !Array.isArray(evidence.members) ||
    evidence.members.length !== bindingCount ||
    !Array.isArray(evidence.sites) ||
    !evidence.sites.length
  )
    throw Error("Missing compiler-certified inseparable binding evidence");
  const hasEdit = (site) =>
    atom.plan.edits.some((edit) => edit.file === site.file && edit.start === site.start);
  const declarations = new Set();
  for (const member of evidence.members) {
    if (!Array.isArray(member) || !member.length) throw Error("Empty coupled binding member");
    for (const site of member) {
      const key = siteKey(site);
      if (
        typeof site.file !== "string" ||
        !Number.isSafeInteger(site.start) ||
        site.start < 0 ||
        site.role !== "function" ||
        !hasEdit(site) ||
        declarations.has(key)
      )
        throw Error("Invalid coupled binding declaration origin");
      declarations.add(key);
    }
  }
  const seen = new Set(),
    successors = Array.from({ length: bindingCount }, () => new Set());
  for (const site of evidence.sites) {
    const key = siteKey(site);
    if (
      !hasEdit(site) ||
      seen.has(key) ||
      !Array.isArray(site.members) ||
      site.members.length < 2 ||
      new Set(site.members).size !== site.members.length ||
      site.members.some(
        (index) => !Number.isSafeInteger(index) || index < 0 || index >= bindingCount,
      )
    )
      throw Error("Invalid coupled binding shared site");
    seen.add(key);
    for (const index of site.members)
      for (const other of site.members) if (index !== other) successors[index].add(other);
  }
  if (evidence.instantiations !== undefined) {
    if (!Array.isArray(evidence.instantiations) || !evidence.instantiations.length)
      throw Error("Empty private instantiation evidence");
    const views = new Set();
    for (const { site, proof, declarations: origins } of evidence.instantiations) {
      const shared = evidence.sites.find((item) => siteKey(item) === siteKey(site ?? {}));
      const key = JSON.stringify([site?.file, site?.start, proof?.callStart]);
      const expected = new Set(
        (shared?.members ?? []).flatMap((index) => evidence.members[index].map(siteKey)),
      );
      if (
        !shared ||
        views.has(key) ||
        proof?.version !== "renderer-shared-call-instantiation-v2" ||
        typeof proof.logicalFile !== "string" ||
        !proof.logicalFile.length ||
        !/^[0-9a-f]{64}$/.test(proof.overlaySha256 ?? "") ||
        proof.sourceSha256 !== evidence.sourceSha256 ||
        !/^[0-9a-f]{64}$/.test(proof?.probeSha256 ?? "") ||
        typeof proof?.suffix !== "string" ||
        !proof.suffix.length ||
        !Number.isSafeInteger(proof.callStart) ||
        proof.callStart < 0 ||
        !Array.isArray(origins) ||
        origins.length !== expected.size ||
        new Set(origins.map(siteKey)).size !== expected.size ||
        origins.some((item) => item.role !== "function" || !expected.has(siteKey(item)))
      )
        throw Error("Invalid private shared-call instantiation evidence");
      views.add(key);
    }
  }
  const ready = [0],
    visited = new Set(ready);
  for (const index of ready)
    for (const other of successors[index])
      if (!visited.has(other)) {
        visited.add(other);
        ready.push(other);
      }
  if (visited.size !== bindingCount)
    throw Error("Coupled binding evidence is not one connected unit");
}

/** Join only minimally connected binding plans with positive shared-call proof.
 * The caller supplies plans and joined-source sites selected by the current
 * compiler snapshot, never candidate answers. Every shared physical site must
 * have identical edits and complete joined-view coverage, and sharedCall must
 * prove all required bindings at every view. Unknown overlaps fail closed.
 * The returned coupling records contain PRIVATE compiler-snapshot origins;
 * only bindingCount and public selectors may enter an editing request.
 */
export function coupleAtomicBindings(bindings, { sharedCall, origin, sourceSha256 }) {
  const parents = bindings.map((_, index) => index);
  const root = (index) => {
    while (parents[index] !== index) index = parents[index];
    return index;
  };
  const sites = new Map();
  for (const [index, binding] of bindings.entries()) {
    for (const edit of binding.plan.edits) {
      const key = siteKey(edit);
      const site = sites.get(key) ?? { edit, indexes: [] };
      if (site.edit.old !== edit.old || site.edit.new !== edit.new)
        throw Error("Conflicting compiler binding replacements");
      site.indexes.push(index);
      sites.set(key, site);
    }
  }
  for (const { indexes } of sites.values()) {
    for (const index of indexes.slice(1)) parents[root(index)] = root(indexes[0]);
  }
  const components = new Map();
  for (const [index, binding] of bindings.entries()) {
    const key = root(index);
    const component = components.get(key) ?? [];
    component.push(binding);
    components.set(key, component);
  }
  return [...components.values()].map((members) => {
    const entries = members.flatMap((binding) => binding.entries);
    const mapping = members[0].mapping;
    const proofSites = [];
    function reject(site, reason) {
      throw Object.assign(
        Error("Partially overlapping compiler binding plans cannot be atomic edits"),
        {
          diagnostic: {
            reason,
            site: site.edit,
            members: members.map((binding) => ({
              mapping: binding.mapping,
              entries: binding.entries,
              plan: binding.plan,
            })),
          },
        },
      );
    }
    for (const [key, site] of sites) {
      const required = site.indexes.map((index) => bindings[index]);
      if (required.length < 2 || !members.includes(required[0])) continue;
      if (
        members.some(
          (binding) => binding.mapping.from !== mapping.from || binding.mapping.to !== mapping.to,
        ) ||
        entries.some((entry) => entry.role !== "function")
      )
        reject(site, "Only one function mapping may share a certified call");
      const views = required.map((binding) => binding.joinedSites.get(key));
      if (views.some((view) => !view?.size)) reject(site, "Missing joined compiler origins");
      const offsets = [...views[0].keys()];
      if (
        views.some(
          (view) => view.size !== offsets.length || offsets.some((offset) => !view.has(offset)),
        )
      )
        reject(site, "Shared physical site has incomplete joined-view coverage");
      for (const offset of offsets) {
        const edit = views[0].get(offset);
        if (
          views.some(
            (view) => view.get(offset).old !== edit.old || view.get(offset).new !== edit.new,
          ) ||
          !sharedCall({
            required: required.flatMap((binding) => binding.entries),
            allowed: entries,
            edit,
          })
        )
          reject(site, "Shared call lacks positive compiler binding evidence");
      }
      proofSites.push({
        file: site.edit.file,
        start: site.edit.start,
        members: required.map((binding) => members.indexOf(binding)),
      });
    }
    const edits = new Map(
      members.flatMap((binding) => binding.plan.edits).map((edit) => [siteKey(edit), edit]),
    );
    return {
      plan: { id: members[0].plan.id, edits: [...edits.values()] },
      entries,
      mapping,
      memberSignatures: new Set(members.map((binding) => binding.signature)),
      bindingCount: members.length,
      ...(members.length > 1
        ? {
            coupling: {
              version: "renderer-atomic-coupling-v1",
              sourceSha256,
              members: members.map((binding) => [
                ...new Map(
                  binding.entries.map((entry) => {
                    const site = origin(entry);
                    return [siteKey(site), site];
                  }),
                ).values(),
              ]),
              sites: proofSites,
            },
          }
        : {}),
    };
  });
}
