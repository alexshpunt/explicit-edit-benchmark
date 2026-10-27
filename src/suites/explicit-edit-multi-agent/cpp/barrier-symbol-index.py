"""Index physical project declarations through the pinned libclang 18 C API.

The distro's official Python bindings own cursor lifetimes and tokenization.
Only the parent verifier reads the private result; editing workers never load it.
"""

import bisect
from functools import lru_cache
import hashlib
import json
import os
import re
import resource
import sys
import time
from clang import cindex

cindex.Config.set_library_file("/usr/lib/llvm-18/lib/libclang.so.1")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "surrogateescape")).hexdigest()


def main():
    started = time.monotonic()
    # clang_getClangVersion is not registered by the official Python bindings.
    version_function = cindex.conf.lib.clang_getClangVersion
    version_function.argtypes = []
    version_function.restype = cindex._CXString
    version = cindex._CXString.from_result(version_function())
    if not re.search(r"clang version 18\.", version):
        raise RuntimeError("Barrier indexing requires libclang 18")
    inventory = json.load(sys.stdin)
    files = sorted(inventory if isinstance(inventory, list) else inventory["files"])
    unavailable = set() if isinstance(inventory, list) else set(inventory["unavailable"])
    known = set(files)
    index = cindex.Index.create()
    records = {}
    diagnostics = []
    credit_units = []
    credit_anchors = {}
    function_kinds = {
        cindex.CursorKind.FUNCTION_DECL, cindex.CursorKind.CXX_METHOD,
        cindex.CursorKind.CONSTRUCTOR, cindex.CursorKind.DESTRUCTOR,
        cindex.CursorKind.CONVERSION_FUNCTION, cindex.CursorKind.FUNCTION_TEMPLATE,
    }
    containers = {cindex.CursorKind.NAMESPACE, cindex.CursorKind.LINKAGE_SPEC}
    omitted = {cindex.CursorKind.PARM_DECL, cindex.CursorKind.TEMPLATE_TYPE_PARAMETER,
               cindex.CursorKind.TEMPLATE_NON_TYPE_PARAMETER, cindex.CursorKind.TEMPLATE_TEMPLATE_PARAMETER,
               cindex.CursorKind.USING_DIRECTIVE, cindex.CursorKind.USING_DECLARATION}

    # Candidate facts are private diagnostic input, independent of grading keys.
    candidate_bindings = {}
    candidate_contexts = {}
    binding_symbols = {}
    symbol_files = {}
    binding_files = {}
    source_bytes = {}
    for source_file in files:
        if source_file in unavailable:
            continue
        with open(source_file, "rb") as source:
            source_bytes[source_file] = source.read()
    type_kinds = {cindex.CursorKind.STRUCT_DECL, cindex.CursorKind.CLASS_DECL,
                  cindex.CursorKind.UNION_DECL, cindex.CursorKind.ENUM_DECL,
                  cindex.CursorKind.TYPEDEF_DECL, cindex.CursorKind.TYPE_ALIAS_DECL,
                  cindex.CursorKind.CLASS_TEMPLATE,
                  cindex.CursorKind.CLASS_TEMPLATE_PARTIAL_SPECIALIZATION,
                  cindex.CursorKind.TEMPLATE_TYPE_PARAMETER,
                  cindex.CursorKind.TEMPLATE_TEMPLATE_PARAMETER}

    def binding_role(cursor):
        if cursor.kind in function_kinds:
            return "function"
        if cursor.kind in type_kinds:
            return "type"
        if cursor.kind == cindex.CursorKind.FIELD_DECL:
            return "field"
        if cursor.kind in (cindex.CursorKind.VAR_DECL, cindex.CursorKind.PARM_DECL,
                           cindex.CursorKind.ENUM_CONSTANT_DECL,
                           cindex.CursorKind.TEMPLATE_NON_TYPE_PARAMETER):
            return "variable"
        return None

    def project_file(location):
        if not location.file:
            return None
        name = os.path.relpath(location.file.name)
        return name if name in known else None

    def token_spelling(token):
        try:
            return token.spelling
        except UnicodeDecodeError:
            # The official wrapper decodes token strings strictly. A genuine
            # successful TU can still contain malformed bytes in a comment.
            # Keep that exact physical token, never a replacement character.
            physical = project_file(token.location)
            if physical not in source_bytes:
                raise
            start, end = token.extent.start.offset, token.extent.end.offset
            return source_bytes[physical][start:end].decode("utf-8", "surrogateescape")
    def is_local(cursor):
        parent = cursor.semantic_parent
        while parent and parent.kind != cindex.CursorKind.TRANSLATION_UNIT:
            if parent.kind in function_kinds:
                return True
            parent = parent.semantic_parent
        return False

    def lexical_namespaces(cursor):
        parents = []
        parent = cursor.lexical_parent
        while parent and parent.kind != cindex.CursorKind.TRANSLATION_UNIT:
            if parent.kind == cindex.CursorKind.NAMESPACE and parent.spelling:
                parents.append(parent.spelling)
            parent = parent.lexical_parent
        return reversed(parents)

    def qualified_name(cursor):
        names = []
        current = cursor
        declaration = True
        while current and current.kind != cindex.CursorKind.TRANSLATION_UNIT:
            name = current.spelling
            context = current.kind == cindex.CursorKind.NAMESPACE or current.kind in function_kinds or current.kind in type_kinds
            if name and not name.startswith("(") and (declaration or context):
                names.append(name)
            declaration = False
            current = current.semantic_parent
        return "::".join(reversed(names))

    def private_binding_id(cursor):
        raw = cursor.get_usr()
        physical = project_file(cursor.location)
        if not raw or not physical:
            return None
        if is_local(cursor) or cursor.kind in omitted:
            return digest(["local", physical, cursor.location.offset, cursor.kind.name, raw])
        if cursor.linkage in (cindex.LinkageKind.INTERNAL, cindex.LinkageKind.UNIQUE_EXTERNAL):
            definition = cursor.get_definition() or cursor
            return digest(["internal", project_file(definition.location) or physical, raw])
        return digest(["external", raw])

    namespace_contexts = {}

    def namespace_context(cursor):
        if not cursor or cursor.kind == cindex.CursorKind.TRANSLATION_UNIT:
            return None
        bucket = namespace_contexts.setdefault(cursor.hash, [])
        for known, context in bucket:
            if known == cursor:
                return context
        if cursor.kind == cindex.CursorKind.NAMESPACE:
            context = cursor.get_usr() or None
        else:
            context = namespace_context(cursor.semantic_parent)
        bucket.append((cursor, context))
        return context

    def credit_target(cursor):
        physical = project_file(cursor.location)
        raw = cursor.get_usr()
        result = {"kind": cursor.kind.name}
        if cursor.kind == cindex.CursorKind.NAMESPACE and raw:
            result["namespace"] = raw
        if physical:
            # Distinct macro-generated declarations can share one physical token.
            context = namespace_context(cursor.semantic_parent)
            if context:
                result["namespaceContext"] = context
            result.update({"file": physical, "offset": cursor.location.offset,
                           "id": private_binding_id(cursor) or digest([
                               "project-anchor", physical, cursor.location.offset,
                               cursor.kind.name, raw, cursor.type.spelling])})
        else:
            location = cursor.location
            physical = os.path.normpath(location.file.name) if location.file else None
            result.update({"external": True, "id": digest([
                "external-anchor", raw, cursor.kind.name, physical,
                location.offset if physical else None, cursor.type.spelling])})
            if raw:
                result["usr"] = raw
            if physical:
                result.update({"file": physical, "offset": location.offset})
        return result

    def credit_add(row):
        key = json.dumps(row, sort_keys=True, separators=(",", ":"))
        credit_anchors[key] = row

    def credit_declaration(cursor, translation_unit):
        if not cursor.kind.is_declaration() or not project_file(cursor.location):
            return
        target = credit_target(cursor)
        credit_add({"file": target["file"], "offset": target["offset"],
                    "kind": target["kind"], "id": target["id"],
                    "role": "declaration", "translationUnit": translation_unit,
                    "definition": cursor.is_definition(),
                    **({key: target[key] for key in ("namespace", "namespaceContext")
                        if key in target})})

    def credit_fact(cursor, translation_unit):
        physical = project_file(cursor.location)
        if not physical:
            return
        if cursor.kind.is_declaration():
            credit_declaration(cursor, translation_unit)
        target = cursor.referenced
        if target and target != cursor:
            selected = credit_target(target)
            if target.kind == cindex.CursorKind.OVERLOADED_DECL_REF:
                # Dependent calls and using declarations can expose a lookup set,
                # not a chosen declaration. Retain every real Clang candidate.
                count = cindex.conf.lib.clang_getNumOverloadedDecls(target)
                overloads = [cindex.conf.lib.clang_getOverloadedDecl(target, i)
                             for i in range(count)]
                selected["overloads"] = [credit_target(item) for item in overloads]
                for item in overloads:
                    credit_declaration(item, translation_unit)
            credit_add({"file": physical, "offset": cursor.location.offset,
                        "kind": cursor.kind.name, "role": "reference",
                        "translationUnit": translation_unit, "target": selected})
            # Implicit constructors and local declarations need not occur among
            # child cursors. Their referenced declaration remains a real anchor.
            credit_declaration(target, translation_unit)

    def candidate_fact(cursor, translation_unit, function_owner=None, anonymous=False, recovered=False):
        physical = project_file(cursor.location)
        if not physical:
            return function_owner, anonymous
        kind = cursor.kind
        anonymous = anonymous or (kind == cindex.CursorKind.NAMESPACE and not cursor.spelling)
        if function_owner is None and kind in function_kinds:
            function_owner = {
                "scope": qualified_name(cursor),
                "signature": cursor.type.spelling,
                "definition": cursor.is_definition(),
                "internal": anonymous or cursor.linkage in (
                    cindex.LinkageKind.INTERNAL, cindex.LinkageKind.UNIQUE_EXTERNAL),
            }
        role = binding_role(cursor)
        if role and function_owner is None:
            # Lambda expressions expose parameters without necessarily visiting
            # their implicit call operator. Its semantic function context is real.
            parent = cursor.semantic_parent
            root = None
            while parent and parent.kind != cindex.CursorKind.TRANSLATION_UNIT:
                if parent.kind in function_kinds:
                    root = parent
                parent = parent.semantic_parent
            if root:
                function_owner = {
                    "scope": qualified_name(root), "signature": root.type.spelling,
                    "definition": root.is_definition(),
                    "internal": anonymous or root.linkage in (
                        cindex.LinkageKind.INTERNAL, cindex.LinkageKind.UNIQUE_EXTERNAL),
                }
        name = cursor.spelling
        location = cursor.location
        symbol = private_binding_id(cursor) if role and name else None
        if symbol:
            offset = location.offset
            text = source_bytes[physical]
            spelling = name.encode("utf-8")
            actual = (0 <= offset < len(text) and location.line > 0 and location.column > 0 and
                      (text[offset:offset + len(spelling)] == spelling or
                       (role == "function" and re.match(r"^operator\W", name) and
                        text[offset:offset + 8] == b"operator")))
            # Synthesized declarations have no physical name that an editor can
            # select. A constructor's class-name location alone is insufficient.
            if actual and role == "function":
                actual = (cursor.extent.end.offset > cursor.extent.start.offset and
                          any(token_spelling(token) == "(" for token in cursor.get_tokens()))
            if actual:
                scope = qualified_name(cursor)
                parent = cursor.semantic_parent
                declaring_scope = qualified_name(parent) if parent else ""
                key = (physical, offset, role)
                fact = {
                    "file": physical, "offset": offset, "line": location.line,
                    "column": location.column, "translationUnit": translation_unit,
                    "role": role, "name": name, "scope": scope,
                    "declaringScope": declaring_scope,
                    "definition": cursor.is_definition(),
                    "internal": anonymous or cursor.linkage in (
                        cindex.LinkageKind.INTERNAL, cindex.LinkageKind.UNIQUE_EXTERNAL) or
                        bool(function_owner and function_owner["internal"]),
                    "id": symbol,
                }
                if function_owner:
                    fact["owner"] = {field: function_owner[field]
                                     for field in ("scope", "signature", "definition")}
                if recovered:
                    fact["recovered"] = True
                priority = (not recovered, physical == translation_unit,
                            bool(function_owner and function_owner["signature"]),
                            fact["definition"])
                if key not in candidate_bindings or priority > candidate_contexts[key]:
                    candidate_bindings[key] = fact
                    candidate_contexts[key] = priority
                binding_symbols.setdefault(key, set()).add(symbol)
                symbol_files.setdefault(symbol, set()).add(physical)
                binding_files.setdefault(key, set()).add(physical)
        target = cursor.referenced
        if target and target != cursor and binding_role(target):
            target_file = project_file(target.location)
            symbol = private_binding_id(target) if target_file else None
            if symbol:
                symbol_files.setdefault(symbol, set()).add(physical)
                key = (target_file, target.location.offset, binding_role(target))
                binding_files.setdefault(key, set()).add(physical)
        return function_owner, anonymous

    def recover_candidate_facts(cursor, translation_unit, function_owner=None, anonymous=False):
        if not project_file(cursor.location):
            return
        function_owner, anonymous = candidate_fact(
            cursor, translation_unit, function_owner, anonymous, recovered=True)
        for child in cursor.get_children():
            recover_candidate_facts(child, translation_unit, function_owner, anonymous)

    for file in files:
        namespace_contexts.clear()
        if not file.endswith(".cpp"):
            continue
        if file in unavailable:
            credit_units.append({"file": file, "status": "fail", "files": [file]})
            diagnostics.append(f"{file}:1:1: error: unsupported source entry")
            continue
        unit = index.parse(file, args=["--driver-mode=g++", "--gcc-toolchain=/usr", "-std=c++17", "-O0", "-ferror-limit=0", "-ffp-contract=off", "-pthread", "-I", "support", "-I", "."])
        errors = [str(item) for item in unit.diagnostics if item.severity >= cindex.Diagnostic.Error]
        included = {file}
        unsafe = False
        try:
            for inclusion in unit.get_includes():
                name = os.path.relpath(inclusion.include.name)
                if name in known:
                    included.add(name)
        except UnicodeError:
            unsafe = True
        unsafe = unsafe or bool(included & unavailable)
        if unsafe:
            errors.append(f"{file}:1:1: error: unavailable physical source coverage")
        credit_units.append({"file": file, "status": "fail" if errors else "pass",
                             "files": sorted(included)})
        if errors:
            diagnostics.extend(errors)
            if not unsafe:
                for child in unit.cursor.get_children():
                    recover_candidate_facts(child, file)
            continue
        owners = []
        # Compiler-owned names anchor global anonymous types. Local types use
        # their enclosing declaration and relative token, also in template USRs.
        anonymous_owners = {}
        local_owners = {}
        local_positions = {}

        def binding_location(target):
            parent = target.semantic_parent
            nearest = None
            function = None
            while parent and parent.kind != cindex.CursorKind.TRANSLATION_UNIT:
                if nearest is None and parent.get_usr():
                    nearest = parent
                if parent.kind in function_kinds:
                    function = parent
                parent = parent.semantic_parent
            root = function or nearest
            if root is None or not root.get_usr():
                raise RuntimeError("Local compiler binding has no declaration owner")
            root_file = project_file(root.location) or (root.location.file.name if root.location.file else None)
            target_file = project_file(target.location) or (target.location.file.name if target.location.file else None)
            span = (root_file, root.extent.start.offset, root.extent.end.offset)
            if span not in local_positions:
                local_positions[span] = [token.location.offset for token in root.get_tokens()]
            position = bisect.bisect_left(local_positions[span], target.location.offset)
            return (root_file, root.get_usr(), root.kind.name, root.is_definition(),
                    target_file, target.kind.name, position)

        def collect_local_type(cursor):
            if not project_file(cursor.location) or not is_local(cursor):
                return
            raw = cursor.get_usr()
            # Retain the compiler's complete type context after this location.
            # Specialized template cursors can embed that same location with a
            # concrete function context rather than the primary template's USR.
            match = re.match(r"^(c:[^@]+@\d+)(?:@|$)", raw)
            if match:
                local_owners.setdefault(match[1], set()).add(binding_location(cursor))

        def collect_anonymous(cursor, function_owner=None, anonymous=False):
            if not project_file(cursor.location):
                return
            credit_fact(cursor, file)
            function_owner, anonymous = candidate_fact(cursor, file, function_owner, anonymous)
            if cursor.kind in (cindex.CursorKind.STRUCT_DECL, cindex.CursorKind.CLASS_DECL,
                               cindex.CursorKind.UNION_DECL, cindex.CursorKind.ENUM_DECL,
                               cindex.CursorKind.TYPEDEF_DECL, cindex.CursorKind.TYPE_ALIAS_DECL):
                collect_local_type(cursor)
            if cursor.kind == cindex.CursorKind.LAMBDA_EXPR:
                collect_local_type(cursor.type.get_canonical().get_declaration())
            if (cursor.kind in (cindex.CursorKind.VAR_DECL, cindex.CursorKind.FIELD_DECL,
                                cindex.CursorKind.TYPEDEF_DECL, cindex.CursorKind.TYPE_ALIAS_DECL)
                    and not is_local(cursor)):
                declaration_type = cursor.type.get_canonical()
                while declaration_type.kind in (cindex.TypeKind.POINTER, cindex.TypeKind.LVALUEREFERENCE, cindex.TypeKind.RVALUEREFERENCE):
                    declaration_type = declaration_type.get_pointee()
                declaration = declaration_type.get_declaration()
                if (declaration and project_file(declaration.location) == project_file(cursor.location)
                        and declaration.is_anonymous()
                        and cursor.extent.start.offset <= declaration.extent.start.offset
                        and declaration.extent.end.offset <= cursor.extent.end.offset):
                    raw = declaration.get_usr()
                    filename = os.path.basename(declaration.location.file.name)
                    if re.search("@" + re.escape(filename) + r"@\d+(?:$|@)", raw):
                        anonymous_owners.setdefault(raw, set()).add(cursor.get_usr())
            for child in cursor.get_children():
                collect_anonymous(child, function_owner, anonymous)

        for child in unit.cursor.get_children():
            collect_anonymous(child)

        anonymous_patterns = [
            (anonymous, [re.compile(re.escape(spelling) + r"(?!\d)")
                         for spelling in (anonymous, anonymous[anonymous.index("@"):])])
            for anonymous in sorted(anonymous_owners, key=len, reverse=True)
        ]
        local_patterns = [
            (prefix, [re.compile(re.escape(spelling) + r"(?!\d)")
                      for spelling in (prefix, prefix.removeprefix("c:"))])
            for prefix in sorted(local_owners, key=len, reverse=True)
        ]

        @lru_cache(maxsize=None)
        def stable_usr(raw, active=()):
            for prefix, patterns in local_patterns:
                if prefix in active or not any(pattern.search(raw) for pattern in patterns):
                    continue
                anchors = []
                for location in local_owners[prefix]:
                    anchor = list(location)
                    anchor[1] = stable_usr(anchor[1], (*active, prefix))
                    anchors.append(anchor)
                identity = "local-type:" + digest(sorted(anchors, key=lambda item: json.dumps(item)))
                for pattern in patterns:
                    raw = pattern.sub(lambda _match: identity, raw)
            for anonymous, patterns in anonymous_patterns:
                if anonymous in active or not any(pattern.search(raw) for pattern in patterns):
                    continue
                anchors = sorted(stable_usr(owner, (*active, anonymous))
                                 for owner in anonymous_owners[anonymous])
                identity = "anonymous:" + digest(anchors)
                # Clang embeds a type's context suffix inside function USRs.
                for pattern in patterns:
                    raw = pattern.sub(lambda _match: identity, raw)
            return raw

        def local_binding(target):
            # A referenced local class can belong to a template factory in a
            # header. Its caller's source position is not part of its identity.
            location = list(binding_location(target))
            location[1] = stable_usr(location[1])
            name = target.spelling
            if (target.kind in (cindex.CursorKind.CONSTRUCTOR, cindex.CursorKind.DESTRUCTOR)
                    and name.lstrip("~").startswith("(")):
                # Synthesized anonymous-type names embed physical line/column
                # coordinates. Kind and relative declaration token identify them.
                name = "<anonymous>"
            return "local:" + json.dumps([*location, name], separators=(",", ":"))

        def visit(cursor, owner=None, physical=None):
            physical_file = project_file(cursor.location)
            if not physical_file:
                return
            kind = cursor.kind
            if kind.is_declaration() and kind not in containers and kind not in omitted and not is_local(cursor):
                usr = stable_usr(cursor.get_usr())
                if usr:
                    if physical is None:
                        physical = {"scope": "::".join(lexical_namespaces(cursor)),
                                    "start": cursor.extent.start.offset,
                                    "end": cursor.extent.end.offset}
                    tokens = list(cursor.get_tokens())
                    owner = {
                        "file": physical_file, "usr": usr, "kind": kind.name,
                        "definition": cursor.is_definition(),
                        "tokensSha256": digest([token_spelling(token) for token in tokens]),
                        "references": set(),
                        "positions": [token.location.offset for token in tokens],
                        "start": cursor.extent.start.offset,
                        "end": cursor.extent.end.offset,
                        "scope": physical["scope"],
                        "selectorStart": physical["start"],
                        "selectorEnd": physical["end"],
                    }
                    owners.append(owner)
            if owner:
                target = cursor.referenced
                if target and target != cursor:
                    target_usr = stable_usr(target.get_usr())
                    if target_usr:
                        if is_local(target) or target.kind in omitted:
                            # Local USRs contain byte offsets. Keep the declaration's
                            # own compiler scope and its relative declaration token.
                            target_usr = local_binding(target)
                        elif target.linkage in (cindex.LinkageKind.INTERNAL, cindex.LinkageKind.UNIQUE_EXTERNAL):
                            definition = target.get_definition() or target
                            target_file = project_file(definition.location)
                            if target_file:
                                target_usr = "file:" + target_file + ":" + target_usr
                        position = bisect.bisect_right(owner["positions"], cursor.location.offset) - 1
                        owner["references"].add((position, target_usr))
            for child in cursor.get_children():
                visit(child, owner, physical)

        for child in unit.cursor.get_children():
            visit(child)
        for owner in owners:
            occurrence = (owner.pop("start"), owner.pop("end"))
            owner.pop("positions")
            owner["references"] = sorted(owner["references"])
            owner["declaration"] = {"scope": owner.pop("scope"), "start": owner.pop("selectorStart"), "end": owner.pop("selectorEnd")}
            key = json.dumps({key: value for key, value in owner.items() if key != "declaration"}, sort_keys=True, separators=(",", ":"))
            if key not in records:
                records[key] = {"record": owner, "occurrences": set()}
            records[key]["occurrences"].add(occurrence)
        del unit
    symbols = [{**entry["record"], "count": len(entry["occurrences"])} for _, entry in sorted(records.items())]
    bindings = []
    for key, fact in sorted(candidate_bindings.items()):
        touched = set(binding_files.get(key, ()))
        for symbol in binding_symbols[key]:
            touched.update(symbol_files.get(symbol, ()))
        bindings.append({**fact, "files": sorted(touched)})
    print(json.dumps({"version": "renderer-barrier-symbol-map-v1", "compiler": version,
                      "status": "fail" if diagnostics else "pass", "files": files,
                      "symbols": symbols, "bindings": bindings, "diagnostics": diagnostics,
                      "credit": {"version": "renderer-binding-anchors-v1",
                                 "translationUnits": credit_units,
                                 "anchors": [credit_anchors[key] for key in sorted(credit_anchors)]},
                      "metrics": {"elapsedMs": (time.monotonic() - started) * 1000,
                                  "maxRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}}, separators=(",", ":")))


if __name__ == "__main__":
    main()
