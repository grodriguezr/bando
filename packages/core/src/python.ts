import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { CodeEdge, CodeNode, EdgeKind, GraphStats, NodeKind } from "./types.js";

/** Folders that never contain the project's own Python code. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "venv",
  ".venv",
  "env",
  ".env",
  "__pycache__",
  "site-packages",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "build",
  "dist",
  "fixtures",
  "__fixtures__",
]);

/** Names Python provides without importing anything: calling them is an external call. */
const BUILTINS = new Set(
  (
    "abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex " +
    "delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help " +
    "hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord " +
    "pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type " +
    "vars zip __import__ Exception BaseException ValueError TypeError KeyError IndexError RuntimeError " +
    "NotImplementedError AttributeError OSError IOError StopIteration AssertionError ImportError"
  ).split(" "),
);

/** Expressions whose value is a builtin type (str, list, dict…): their methods are external. */
const LITERALS = new Set([
  "string",
  "concatenated_string",
  "integer",
  "float",
  "true",
  "false",
  "none",
  "list",
  "dictionary",
  "set",
  "tuple",
  "list_comprehension",
  "dictionary_comprehension",
  "set_comprehension",
  "generator_expression",
]);

/** Fixtures pytest provides itself: always external objects. */
const PYTEST_BUILTIN_FIXTURES = new Set(
  "monkeypatch tmp_path tmpdir tmp_path_factory tmpdir_factory capsys capsysbinary capfd capfdbinary caplog request recwarn pytestconfig record_property".split(
    " ",
  ),
);

export interface PythonGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
  files: number;
  callStats: Pick<GraphStats, "resolvedCalls" | "externalCalls" | "unresolvedCalls">;
}

/** Python files of the project, outside virtual environments and build folders. */
export function findPythonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.endsWith(".egg-info")) continue;
        // A folder with its own interpreter is a virtual environment, whatever its name.
        if (fs.existsSync(path.join(dir, entry.name, "pyvenv.cfg"))) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".py")) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out.sort();
}

let parserPromise: Promise<Parser> | undefined;

function getParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init();
    const require = createRequire(import.meta.url);
    const language = await Language.load(require.resolve("tree-sitter-python/tree-sitter-python.wasm"));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}

// ── Model ────────────────────────────────────────────────────────────────

interface Module {
  fileId: string;
  abs: string;
  root: Node;
  /** Top-level functions and classes: name → node id. */
  defs: Map<string, string>;
  /** Names bound by imports, resolved lazily. */
  imports: Map<string, ImportSpec>;
  /** `from x import *`. */
  stars: ModuleSpec[];
  /** `__all__`, when declared. */
  all?: Set<string>;
}

interface ModuleSpec {
  level: number;
  dotted: string;
}

type ImportSpec = { type: "module"; spec: ModuleSpec } | { type: "from"; spec: ModuleSpec; name: string };

/** What a name or expression refers to, as far as static analysis can tell. */
type Value =
  | { kind: "module"; fileId: string }
  | { kind: "class"; id: string }
  | { kind: "instance"; classId: string }
  | { kind: "function"; id: string }
  | { kind: "external" };

interface Scope {
  module: Module;
  /** The class whose method we are in, for `self`, `cls` and `super()`. */
  classId?: string;
  /** Functions defined inside the current function. */
  localDefs: Map<string, string>;
  /** Variables whose class we could infer. */
  localTypes: Map<string, Value>;
}

/** Analyzes the Python files of a project into graph nodes and edges. */
export async function analyzePython(root: string, files = findPythonFiles(root)): Promise<PythonGraph> {
  const parser = await getParser();
  const analyzer = new PythonAnalyzer(root);
  for (const file of files) {
    const tree = parser.parse(fs.readFileSync(file, "utf8"));
    if (tree) analyzer.declare(file, tree.rootNode);
  }
  analyzer.relate();
  return analyzer.result(files.length);
}

class PythonAnalyzer {
  private readonly modules = new Map<string, Module>();
  private readonly nodes = new Map<string, CodeNode>();
  private readonly edges = new Map<string, CodeEdge>();
  /** Class id → base class ids in the project, and whether any base is external. */
  private readonly bases = new Map<string, { project: string[]; external: boolean }>();
  /** Class id → attribute → inferred value (`self.api = Api()`). */
  private readonly attributeTypes = new Map<string, Map<string, Value>>();
  private readonly roots: string[];
  /** Function/class id → its definition, for return-type inference. */
  private readonly definitions = new Map<string, Node>();
  /** Function id → decorators' text (`@pytest.fixture`, `@property`…). */
  private readonly decorators = new Map<string, string[]>();
  /** Inferred return values, with `null` meaning "unknown" (and guarding recursion). */
  private readonly returns = new Map<string, Value | null>();
  /** pytest fixtures by name: fixture function ids. */
  private readonly fixtures = new Map<string, string[]>();
  readonly callStats = { resolvedCalls: 0, externalCalls: 0, unresolvedCalls: 0 };

  constructor(private readonly root: string) {
    this.roots = [root, path.join(root, "src")].filter((r) => fs.existsSync(r));
  }

  result(files: number): PythonGraph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()], files, callStats: this.callStats };
  }

  // ── Pass 1: declarations ────────────────────────────────────────────────

  declare(abs: string, root: Node): void {
    const fileId = this.rel(abs);
    const module: Module = { fileId, abs, root, defs: new Map(), imports: new Map(), stars: [] };
    this.modules.set(fileId, module);
    this.addNode({
      id: fileId,
      kind: "file",
      name: path.basename(abs),
      file: fileId,
      line: 1,
      endLine: root.endPosition.row + 1,
      exported: true,
    });

    for (const statement of root.descendantsOfType(["import_statement", "import_from_statement"])) {
      if (statement) this.collectImports(module, statement);
    }
    for (const statement of root.namedChildren) {
      const all = statement && allNames(statement);
      if (all) module.all = all;
    }
    const visit = (node: Node, parentId: string, qualifier: string, inClass: boolean, topLevel: boolean) => {
      for (const child of node.namedChildren) {
        if (!child) continue;
        const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
        if (def?.type === "function_definition" || def?.type === "class_definition") {
          const name = def.childForFieldName("name")?.text ?? "?";
          const qualified = qualifier ? `${qualifier}.${name}` : name;
          const id = `${fileId}#${qualified}`;
          const kind: NodeKind = def.type === "class_definition" ? "class" : inClass ? "method" : "function";
          this.addNode({
            id,
            kind,
            name,
            file: fileId,
            line: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
            exported: this.isExported(module, name, kind, parentId, topLevel),
            signature: kind === "class" ? undefined : signatureOf(def, name),
            doc: docstringOf(def),
          });
          this.addEdge(parentId, id, "contains");
          this.definitions.set(id, def);
          if (child.type === "decorated_definition") {
            this.decorators.set(
              id,
              child.namedChildren.filter((c) => c?.type === "decorator").map((c) => c!.text),
            );
          }
          if (topLevel) module.defs.set(name, id);
          const body = def.childForFieldName("body");
          if (body) visit(body, id, qualified, kind === "class", false);
        } else if (child.type !== "function_definition" && child.type !== "class_definition") {
          // Definitions inside if/try/with blocks at the same level.
          if (
            ["if_statement", "try_statement", "with_statement", "block", "else_clause", "except_clause"].includes(
              child.type,
            )
          ) {
            visit(child, parentId, qualifier, inClass, topLevel);
          }
        }
      }
    };
    visit(root, fileId, "", false, true);
  }

  private isExported(module: Module, name: string, kind: NodeKind, parentId: string, topLevel: boolean): boolean {
    if (kind === "method") {
      const dunder = name.startsWith("__") && name.endsWith("__");
      return Boolean(this.nodes.get(parentId)?.exported) && (dunder || !name.startsWith("_"));
    }
    if (!topLevel) return false;
    return module.all ? module.all.has(name) : !name.startsWith("_");
  }

  private collectImports(module: Module, statement: Node): void {
    if (statement.type === "import_statement") {
      for (const item of statement.namedChildren) {
        if (!item) continue;
        if (item.type === "aliased_import") {
          const dotted = item.childForFieldName("name")?.text ?? "";
          const alias = item.childForFieldName("alias")?.text ?? dotted;
          module.imports.set(alias, { type: "module", spec: { level: 0, dotted } });
        } else if (item.type === "dotted_name") {
          // `import a.b.c` binds `a`.
          const first = item.text.split(".")[0]!;
          module.imports.set(first, { type: "module", spec: { level: 0, dotted: first } });
        }
      }
    } else if (statement.type === "import_from_statement") {
      const spec = moduleSpecOf(statement.childForFieldName("module_name"));
      if (!spec) return;
      if (statement.namedChildren.some((c) => c?.type === "wildcard_import")) {
        module.stars.push(spec);
        return;
      }
      for (const item of statement.childrenForFieldName("name")) {
        if (!item) continue;
        const name = item.type === "aliased_import" ? (item.childForFieldName("name")?.text ?? "") : item.text;
        const alias = item.type === "aliased_import" ? (item.childForFieldName("alias")?.text ?? name) : name;
        module.imports.set(alias, { type: "from", spec, name });
      }
    }
  }

  // ── Pass 2: relations ───────────────────────────────────────────────────

  relate(): void {
    for (const [id, decorators] of this.decorators) {
      if (!decorators.some((d) => /^@\s*(pytest\.)?fixture\b/.test(d))) continue;
      const name = this.nodes.get(id)!.name;
      this.fixtures.set(name, [...(this.fixtures.get(name) ?? []), id]);
    }
    for (const module of this.modules.values()) this.addImportEdges(module);
    // Class bases and attribute types first: calls through `self.x` and inherited methods need them.
    for (const module of this.modules.values()) this.collectClasses(module, module.root, undefined);
    for (const module of this.modules.values()) {
      this.walkCalls(module.root, module.fileId, { module, localDefs: new Map(), localTypes: new Map() });
    }
  }

  private addImportEdges(module: Module): void {
    for (const statement of module.root.descendantsOfType(["import_statement", "import_from_statement"])) {
      if (!statement) continue;
      const line = statement.startPosition.row + 1;
      if (statement.type === "import_statement") {
        for (const item of statement.namedChildren) {
          const dotted = item?.type === "aliased_import" ? item.childForFieldName("name")?.text : item?.text;
          if (dotted) this.importEdge(module, { level: 0, dotted }, line);
        }
        continue;
      }
      const spec = moduleSpecOf(statement.childForFieldName("module_name"));
      if (!spec) continue;
      const target = this.resolveModule(module, spec);
      // `from . import x` imports the submodule x when there is one.
      let linked = false;
      if (target.kind === "module") {
        for (const item of statement.childrenForFieldName("name")) {
          const name = item?.type === "aliased_import" ? item.childForFieldName("name")?.text : item?.text;
          const sub = name && this.submodule(target.fileId, name);
          if (sub) {
            this.addEdge(module.fileId, sub, "imports", line);
            linked = true;
          }
        }
      }
      if (!linked) this.importEdge(module, spec, line);
    }
  }

  private importEdge(module: Module, spec: ModuleSpec, line: number): void {
    const target = this.resolveModule(module, spec);
    if (target.kind === "module") {
      if (target.fileId !== module.fileId) this.addEdge(module.fileId, target.fileId, "imports", line);
    } else if (target.kind === "external" && spec.level === 0) {
      const pkg = spec.dotted.split(".")[0]!;
      const id = `pkg:${pkg}`;
      if (!this.nodes.has(id))
        this.addNode({ id, kind: "package", name: pkg, file: "", line: 0, endLine: 0, exported: true });
      this.addEdge(module.fileId, id, "imports", line);
    }
  }

  private collectClasses(module: Module, node: Node, parentQualifier: string | undefined): void {
    for (const child of node.namedChildren) {
      if (!child) continue;
      const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
      if (def?.type === "class_definition") {
        const name = def.childForFieldName("name")?.text ?? "?";
        const qualified = parentQualifier ? `${parentQualifier}.${name}` : name;
        const classId = `${module.fileId}#${qualified}`;
        const scope: Scope = { module, localDefs: new Map(), localTypes: new Map() };
        const info = { project: [] as string[], external: false };
        for (const base of def.childForFieldName("superclasses")?.namedChildren ?? []) {
          if (!base || base.type === "keyword_argument") continue;
          const value = this.valueOf(base, scope);
          if (value?.kind === "class") {
            info.project.push(value.id);
            this.addEdge(classId, value.id, "extends", base.startPosition.row + 1);
          } else if (value?.kind === "external" || (BUILTINS.has(base.text) && base.text !== "object")) {
            info.external = true;
          }
        }
        this.bases.set(classId, info);
        const body = def.childForFieldName("body");
        if (body) {
          this.collectAttributeTypes(module, classId, body);
          this.collectClasses(module, body, qualified);
        }
      } else if (def?.type === "function_definition") {
        const name = def.childForFieldName("name")?.text ?? "?";
        const body = def.childForFieldName("body");
        if (body) this.collectClasses(module, body, parentQualifier ? `${parentQualifier}.${name}` : name);
      }
    }
  }

  /** `self.api = Api(...)` or `self.api = api` with `api: Api` anywhere in the class's methods. */
  private collectAttributeTypes(module: Module, classId: string, body: Node): void {
    const types = new Map<string, Value>();
    for (const method of body.descendantsOfType("function_definition")) {
      if (!method) continue;
      const scope: Scope = { module, classId, localDefs: new Map(), localTypes: new Map() };
      this.collectParameterTypes(method, scope);
      for (const assignment of method.descendantsOfType("assignment")) {
        const left = assignment?.childForFieldName("left");
        const right = assignment?.childForFieldName("right");
        if (left?.type !== "attribute" || left.childForFieldName("object")?.text !== "self") continue;
        const attr = left.childForFieldName("attribute")?.text;
        const value = right ? this.instanceOf(right, scope) : undefined;
        if (attr && value) types.set(attr, value);
      }
    }
    this.attributeTypes.set(classId, types);
  }

  private walkCalls(node: Node, ownerId: string, scope: Scope): void {
    for (const child of node.namedChildren) {
      if (!child) continue;
      const def = child.type === "decorated_definition" ? child.childForFieldName("definition") : child;
      if (def?.type === "function_definition" || def?.type === "class_definition") {
        // Decorators run in the enclosing scope.
        if (child.type === "decorated_definition") {
          for (const decorator of child.namedChildren)
            if (decorator?.type === "decorator") this.walkCalls(decorator, ownerId, scope);
        }
        const name = def.childForFieldName("name")?.text ?? "?";
        const ownerNode = this.nodes.get(ownerId);
        const qualifier = ownerNode && ownerNode.kind !== "file" ? ownerId.slice(ownerId.indexOf("#") + 1) : "";
        const id = `${scope.module.fileId}#${qualifier ? `${qualifier}.${name}` : name}`;
        if (!this.nodes.has(id)) continue;
        if (def.type === "class_definition") {
          const body = def.childForFieldName("body");
          // A class body sees the module's names, not the enclosing function's local functions.
          if (body)
            this.walkCalls(body, id, {
              ...scope,
              classId: id,
              localDefs: new Map(),
              localTypes: new Map(scope.localTypes),
            });
        } else {
          const inner: Scope = {
            module: scope.module,
            classId: this.nodes.get(ownerId)?.kind === "class" ? ownerId : scope.classId,
            localDefs: new Map(scope.localDefs),
            localTypes: new Map(scope.localTypes),
          };
          scope.localDefs.set(name, id);
          this.collectParameterTypes(def, inner);
          const body = def.childForFieldName("body");
          if (body) {
            this.collectLocalDefs(body, id, inner);
            this.walkCalls(body, id, inner);
          }
        }
        continue;
      }

      if (child.type === "assignment") this.inferAssignment(child, scope);
      if (child.type === "with_item") this.inferWith(child, scope);
      if (child.type === "call") this.addCall(child, ownerId, scope);
      this.walkCalls(child, ownerId, scope);
    }
  }

  private collectLocalDefs(body: Node, functionId: string, scope: Scope): void {
    for (const child of body.namedChildren) {
      const def = child?.type === "decorated_definition" ? child.childForFieldName("definition") : child;
      if (def?.type === "function_definition") {
        const name = def.childForFieldName("name")?.text ?? "?";
        const id = `${functionId}.${name}`;
        if (this.nodes.has(id)) scope.localDefs.set(name, id);
      }
    }
  }

  private collectParameterTypes(fn: Node, scope: Scope): void {
    const tests = isTestFile(scope.module.fileId);
    for (const param of fn.childForFieldName("parameters")?.namedChildren ?? []) {
      if (!param) continue;
      // *args is a tuple and **kwargs a dict, annotated or not: their methods are builtins.
      const first = param.namedChildren[0];
      const splat = isSplat(param) ? param : param.type === "typed_parameter" && isSplat(first) ? first : undefined;
      if (splat) {
        const name = splat.namedChildren[0]?.text;
        if (name) scope.localTypes.set(name, { kind: "external" });
        continue;
      }
      if (param.type === "typed_parameter" || param.type === "typed_default_parameter") {
        const name =
          param.type === "typed_parameter" ? param.namedChildren[0]?.text : param.childForFieldName("name")?.text;
        const type = param.childForFieldName("type");
        const value = type ? this.typeAnnotation(type, scope) : undefined;
        if (name && value) scope.localTypes.set(name, value);
        continue;
      }
      // In tests, pytest passes fixtures by parameter name.
      const name = param.type === "identifier" ? param.text : param.childForFieldName("name")?.text;
      if (!tests || !name || name === "self" || name === "cls") continue;
      if (PYTEST_BUILTIN_FIXTURES.has(name)) {
        scope.localTypes.set(name, { kind: "external" });
        continue;
      }
      const fixture = this.fixtureFor(name, scope.module.fileId);
      const value = fixture ? this.inferReturn(fixture) : undefined;
      if (value) scope.localTypes.set(name, value);
    }
  }

  /** The fixture a test sees under `name`: its own module first, then conftest.py files up to the root. */
  private fixtureFor(name: string, fileId: string): string | undefined {
    const candidates = this.fixtures.get(name);
    if (!candidates) return undefined;
    const sameModule = candidates.find((id) => this.nodes.get(id)?.file === fileId);
    if (sameModule) return sameModule;
    for (let dir = path.posix.dirname(fileId); ; dir = path.posix.dirname(dir)) {
      const conftest = dir === "." ? "conftest.py" : `${dir}/conftest.py`;
      const found = candidates.find((id) => this.nodes.get(id)?.file === conftest);
      if (found) return found;
      if (dir === "." || dir === "/") return undefined;
    }
  }

  /**
   * What calling a function produces: its return annotation, or else the value of its `return`
   * (and `yield`, for fixtures) statements when they all agree.
   */
  private inferReturn(functionId: string): Value | undefined {
    if (this.returns.has(functionId)) return this.returns.get(functionId) ?? undefined;
    const def = this.definitions.get(functionId);
    const node = this.nodes.get(functionId);
    const module = node && this.modules.get(node.file);
    if (!def || !module || def.type !== "function_definition") return undefined;
    this.returns.set(functionId, null);

    const owner = functionId.slice(0, functionId.lastIndexOf("."));
    const scope: Scope = {
      module,
      classId: node.kind === "method" && this.nodes.get(owner)?.kind === "class" ? owner : undefined,
      localDefs: new Map(),
      localTypes: new Map(),
    };
    this.collectParameterTypes(def, scope);
    const body = def.childForFieldName("body");
    if (body) this.collectLocalDefs(body, functionId, scope);

    let result: Value | undefined;
    const annotation = def.childForFieldName("return_type");
    if (annotation) {
      result = this.typeAnnotation(annotation, scope);
    } else if (body) {
      const values: Value[] = [];
      const visit = (n: Node) => {
        for (const c of n.namedChildren) {
          if (!c || ["function_definition", "class_definition", "decorated_definition", "lambda"].includes(c.type)) {
            continue;
          }
          if (c.type === "assignment") this.inferAssignment(c, scope);
          if (c.type === "return_statement" || c.type === "yield") {
            const expr = c.namedChildren[0];
            const value = expr && (this.instanceOf(expr, scope) ?? this.valueOf(expr, scope));
            if (value) values.push(value);
          }
          visit(c);
        }
      };
      visit(body);
      const first = values[0];
      result = first && values.every((v) => sameValue(v, first)) ? first : undefined;
    }
    this.returns.set(functionId, result ?? null);
    return result;
  }

  private inferAssignment(assignment: Node, scope: Scope): void {
    const left = assignment.childForFieldName("left");
    if (left?.type !== "identifier") return;
    const type = assignment.childForFieldName("type");
    const right = assignment.childForFieldName("right");
    const value = (type && this.typeAnnotation(type, scope)) ?? (right ? this.instanceOf(right, scope) : undefined);
    if (value) scope.localTypes.set(left.text, value);
    else scope.localTypes.delete(left.text);
  }

  /** `with Session() as s:` */
  private inferWith(item: Node, scope: Scope): void {
    const value = item.namedChildren[0];
    if (value?.type !== "as_pattern") return;
    const expr = value.namedChildren[0];
    const target = value.childForFieldName("alias") ?? value.namedChildren[1];
    const inferred = expr ? this.instanceOf(expr, scope) : undefined;
    if (target && inferred) scope.localTypes.set(target.text.replace(/^as\s+/, ""), inferred);
  }

  // ── Resolution ──────────────────────────────────────────────────────────

  private addCall(call: Node, ownerId: string, scope: Scope): void {
    const callee = call.childForFieldName("function");
    const line = call.startPosition.row + 1;
    const target = callee ? this.resolveCallee(callee, scope) : undefined;
    if (target === "external") this.callStats.externalCalls++;
    else if (target) {
      this.callStats.resolvedCalls++;
      this.addEdge(ownerId, target, "calls", line);
    } else this.callStats.unresolvedCalls++;

    // Functions passed by reference (`map(f, xs)`, `Thread(target=run)`) run as part of this call.
    for (const arg of call.childForFieldName("arguments")?.namedChildren ?? []) {
      const expr = arg?.type === "keyword_argument" ? arg.childForFieldName("value") : arg;
      if (expr?.type !== "identifier" && expr?.type !== "attribute") continue;
      const value = this.valueOf(expr, scope);
      if (value?.kind === "function" && value.id !== ownerId) this.addEdge(ownerId, value.id, "calls", line);
    }
  }

  private resolveCallee(callee: Node, scope: Scope): string | "external" | undefined {
    if (callee.type === "identifier" && BUILTINS.has(callee.text) && !this.lookup(callee.text, scope))
      return "external";
    const value = this.valueOf(callee, scope);
    if (!value) return undefined;
    if (value.kind === "function" || value.kind === "class") return value.id;
    if (value.kind === "external") return "external";
    return undefined;
  }

  /** The class an expression produces: `Api()`, `self.api`, a typed variable. */
  private instanceOf(expr: Node, scope: Scope): Value | undefined {
    if (LITERALS.has(expr.type)) return { kind: "external" };
    if (expr.type === "call") {
      const callee = expr.childForFieldName("function");
      const value = callee ? this.valueOf(callee, scope) : undefined;
      if (value?.kind === "class") return { kind: "instance", classId: value.id };
      if (value?.kind === "external") return { kind: "external" };
      if (value?.kind === "function") {
        // `def crear() -> Cliente`, or what its `return` statements produce.
        const result = this.inferReturn(value.id);
        return result?.kind === "instance" || result?.kind === "external" ? result : undefined;
      }
      return undefined;
    }
    const value = this.valueOf(expr, scope);
    return value?.kind === "instance" || value?.kind === "external" ? value : undefined;
  }

  private valueOf(expr: Node, scope: Scope): Value | undefined {
    if (LITERALS.has(expr.type)) return { kind: "external" };
    if (expr.type === "identifier") {
      const name = expr.text;
      if ((name === "self" || name === "cls") && scope.classId) {
        return name === "self" ? { kind: "instance", classId: scope.classId } : { kind: "class", id: scope.classId };
      }
      return scope.localTypes.get(name) ?? this.lookup(name, scope);
    }
    if (expr.type === "attribute") {
      const object = expr.childForFieldName("object");
      const attr = expr.childForFieldName("attribute")?.text;
      if (!object || !attr) return undefined;
      // super().metodo()
      if (object.type === "call" && object.childForFieldName("function")?.text === "super" && scope.classId) {
        // Not found in the project bases: it's object's (or a library's) implementation.
        return this.member(scope.classId, attr, true) ?? { kind: "external" };
      }
      const base = object.type === "call" ? this.instanceOf(object, scope) : this.valueOf(object, scope);
      if (!base) return undefined;
      if (base.kind === "external") return base;
      if (base.kind === "module") return this.exportOf(base.fileId, attr, 0);
      if (base.kind === "class") return this.member(base.id, attr, false);
      if (base.kind === "instance") {
        return this.attributeTypes.get(base.classId)?.get(attr) ?? this.member(base.classId, attr, false);
      }
      return undefined;
    }
    if (expr.type === "call") return this.instanceOf(expr, scope);
    if (expr.type === "parenthesized_expression" && expr.namedChildren[0])
      return this.valueOf(expr.namedChildren[0], scope);
    return undefined;
  }

  /** A method (or nested class) of a class, looking through its project bases. */
  private member(classId: string, name: string, skipOwn: boolean, depth = 0): Value | undefined {
    if (!skipOwn) {
      const id = `${classId}.${name}`;
      const node = this.nodes.get(id);
      if (node) return node.kind === "class" ? { kind: "class", id } : { kind: "function", id };
    }
    const info = this.bases.get(classId);
    if (!info || depth > 10) return undefined;
    for (const base of info.project) {
      const found = this.member(base, name, false, depth + 1);
      if (found) return found;
    }
    // Probably inherited from a library class (Exception, BaseModel, Thread…).
    return info.external ? { kind: "external" } : undefined;
  }

  private lookup(name: string, scope: Scope): Value | undefined {
    const local = scope.localDefs.get(name);
    if (local) return { kind: "function", id: local };
    return this.exportOf(scope.module.fileId, name, 0);
  }

  /** What `name` means at the top level of a module: a definition, an import, a submodule, or a star import. */
  private exportOf(fileId: string, name: string, depth: number): Value | undefined {
    const module = this.modules.get(fileId);
    if (!module || depth > 5) return undefined;
    const def = module.defs.get(name);
    if (def) return this.nodes.get(def)?.kind === "class" ? { kind: "class", id: def } : { kind: "function", id: def };

    const spec = module.imports.get(name);
    if (spec) {
      const target = this.resolveModule(module, spec.spec);
      if (spec.type === "module") return target.kind === "module" ? target : { kind: "external" };
      if (target.kind === "external") return { kind: "external" };
      const sub = this.submodule(target.fileId, spec.name);
      return this.exportOf(target.fileId, spec.name, depth + 1) ?? (sub ? { kind: "module", fileId: sub } : undefined);
    }

    const sub = this.submodule(fileId, name);
    if (sub) return { kind: "module", fileId: sub };
    for (const star of module.stars) {
      const target = this.resolveModule(module, star);
      if (target.kind === "external") continue;
      const found = this.exportOf(target.fileId, name, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  private resolveModule(from: Module, spec: ModuleSpec): { kind: "module"; fileId: string } | { kind: "external" } {
    const parts = spec.dotted ? spec.dotted.split(".") : [];
    const bases: string[] = [];
    if (spec.level > 0) {
      let dir = path.dirname(from.abs);
      for (let i = 1; i < spec.level; i++) dir = path.dirname(dir);
      bases.push(dir);
    } else {
      // Scripts import their siblings (`import utils` next to main.py); packages import from the roots.
      const dir = path.dirname(from.abs);
      if (!fs.existsSync(path.join(dir, "__init__.py"))) bases.push(dir);
      bases.push(...this.roots);
    }
    for (const base of bases) {
      const target = path.join(base, ...parts);
      for (const candidate of [`${target}.py`, path.join(target, "__init__.py")]) {
        const id = this.rel(candidate);
        if (this.modules.has(id)) return { kind: "module", fileId: id };
      }
    }
    return { kind: "external" };
  }

  /** `pkg/name.py` or `pkg/name/__init__.py` when `fileId` is `pkg/__init__.py`. */
  private submodule(fileId: string, name: string): string | undefined {
    if (path.basename(fileId) !== "__init__.py") return undefined;
    const dir = path.dirname(path.join(this.root, fileId));
    for (const candidate of [path.join(dir, `${name}.py`), path.join(dir, name, "__init__.py")]) {
      const id = this.rel(candidate);
      if (this.modules.has(id)) return id;
    }
    return undefined;
  }

  /** `Cliente`, `Optional[Cliente]`, `Cliente | None`, `"Cliente"` → the class, if it's in the project. */
  private typeAnnotation(type: Node, scope: Scope): Value | undefined {
    const candidates = [type, ...type.descendantsOfType(["identifier", "attribute", "string"])].filter(
      Boolean,
    ) as Node[];
    for (const candidate of candidates) {
      if (candidate.type === "string") {
        const name = candidate.text.replace(/^['"]+|['"]+$/g, "");
        const value = this.lookup(name, scope);
        if (value?.kind === "class") return { kind: "instance", classId: value.id };
        continue;
      }
      if (candidate.type !== "identifier" && candidate.type !== "attribute") continue;
      const value = this.valueOf(candidate, scope);
      if (value?.kind === "class") return { kind: "instance", classId: value.id };
      if (value?.kind === "external" && candidate === type) return value;
    }
    return undefined;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private addNode(node: CodeNode): void {
    this.nodes.set(node.id, node);
  }

  private addEdge(from: string, to: string, kind: EdgeKind, line?: number): void {
    if (from === to && kind !== "calls") return;
    const key = `${from}|${to}|${kind}`;
    const edge = this.edges.get(key) ?? { from, to, kind, count: 0, lines: [] };
    edge.count++;
    if (line !== undefined && !edge.lines.includes(line)) edge.lines.push(line);
    this.edges.set(key, edge);
  }

  private rel(file: string): string {
    return path.relative(this.root, file).split(path.sep).join("/");
  }
}

function isSplat(node: Node | null | undefined): boolean {
  return node?.type === "list_splat_pattern" || node?.type === "dictionary_splat_pattern";
}

function isTestFile(fileId: string): boolean {
  const name = path.posix.basename(fileId);
  return (
    name.startsWith("test_") || name.endsWith("_test.py") || name === "conftest.py" || /(^|\/)tests?\//.test(fileId)
  );
}

function sameValue(a: Value, b: Value): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "instance" && b.kind === "instance") return a.classId === b.classId;
  if ((a.kind === "class" || a.kind === "function") && (b.kind === "class" || b.kind === "function"))
    return a.id === b.id;
  if (a.kind === "module" && b.kind === "module") return a.fileId === b.fileId;
  return true;
}

function moduleSpecOf(node: Node | null | undefined): ModuleSpec | undefined {
  if (!node) return undefined;
  if (node.type === "dotted_name") return { level: 0, dotted: node.text };
  if (node.type === "relative_import") {
    const prefix = node.namedChildren.find((c) => c?.type === "import_prefix")?.text ?? "";
    const dotted = node.namedChildren.find((c) => c?.type === "dotted_name")?.text ?? "";
    return { level: prefix.length, dotted };
  }
  return undefined;
}

/** `__all__ = ["a", "b"]` */
function allNames(statement: Node): Set<string> | undefined {
  const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : undefined;
  if (assignment?.type !== "assignment" || assignment.childForFieldName("left")?.text !== "__all__") return undefined;
  const right = assignment.childForFieldName("right");
  if (!right || (right.type !== "list" && right.type !== "tuple")) return undefined;
  return new Set(
    right.namedChildren.filter((c) => c?.type === "string").map((c) => c!.text.replace(/^['"]+|['"]+$/g, "")),
  );
}

function signatureOf(def: Node, name: string): string {
  const params = (def.childForFieldName("parameters")?.text ?? "()").replace(/\s+/g, " ");
  const returns = def.childForFieldName("return_type")?.text;
  return `${name}${params}${returns ? ` -> ${returns}` : ""}`;
}

function docstringOf(def: Node): string | undefined {
  const first = def.childForFieldName("body")?.namedChildren[0];
  const string = first?.type === "expression_statement" ? first.namedChildren[0] : undefined;
  if (string?.type !== "string") return undefined;
  const text = string.text
    .replace(/^[rRuUbBfF]*("""|'''|"|')/, "")
    .replace(/("""|'''|"|')$/, "")
    .trim();
  return text ? text.replace(/\n\s+/g, "\n") : undefined;
}
