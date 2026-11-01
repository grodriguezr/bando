import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { CodeEdge, CodeNode, EdgeKind, GraphStats, NodeKind } from "./types.js";

/** Folders that never contain the project's own Java sources. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "out",
  "bin",
  ".gradle",
  ".idea",
  ".mvn",
  "fixtures",
  "__fixtures__",
]);

const CLASS_LIKE = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
]);

/** Types without methods: calls on them can't happen, and they never resolve to a class. */
const PRIMITIVES = new Set(["int", "long", "short", "byte", "char", "boolean", "float", "double", "void"]);

export interface JavaGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
  files: number;
  callStats: Pick<GraphStats, "resolvedCalls" | "externalCalls" | "unresolvedCalls">;
}

/** Java files of the project, outside build output and IDE folders. */
export function findJavaFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".java")) {
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
    const language = await Language.load(require.resolve("tree-sitter-java/tree-sitter-java.wasm"));
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}

// ── Model ────────────────────────────────────────────────────────────────

interface JavaFile {
  fileId: string;
  root: Node;
  pkg: string;
  /** `import a.b.C;` → C → a.b.C */
  imports: Map<string, string>;
  /** `import a.b.*;` → a.b */
  wildcards: string[];
  /** `import static a.b.C.m;` → m → a.b.C */
  staticImports: Map<string, string>;
  /** `import static a.b.C.*;` → a.b.C */
  staticWildcards: string[];
  /** Top-level types declared in the file: simple name → class id. */
  types: Map<string, string>;
}

interface ClassInfo {
  id: string;
  fqn: string;
  fileId: string;
  node: Node;
  outer?: string;
  /** Nested types: simple name → class id. */
  nested: Map<string, string>;
  /** Field name → type node (resolved lazily, in the class's context). */
  fields: Map<string, Node>;
  /** Method name → overloads. */
  methods: Map<string, MethodInfo[]>;
  /** Resolved supertypes in the project, and whether any supertype is external. */
  supers: string[];
  externalSuper: boolean;
}

interface MethodInfo {
  id: string;
  params: number;
  varargs: boolean;
  returnType?: Node;
}

/** What an expression is, as far as the declared types tell. */
type TypeValue = { kind: "instance"; classId: string } | { kind: "static"; classId: string } | { kind: "external" };

interface Scope {
  file: JavaFile;
  classId: string;
  locals: Map<string, TypeValue>;
}

/** Analyzes the Java files of a project into graph nodes and edges. */
export async function analyzeJava(root: string, files = findJavaFiles(root)): Promise<JavaGraph> {
  const parser = await getParser();
  const analyzer = new JavaAnalyzer(root);
  for (const file of files) {
    const tree = parser.parse(fs.readFileSync(file, "utf8"));
    if (tree) analyzer.declare(file, tree.rootNode);
  }
  analyzer.relate();
  return analyzer.result(files.length);
}

class JavaAnalyzer {
  private readonly files = new Map<string, JavaFile>();
  private readonly classes = new Map<string, ClassInfo>();
  private readonly byFqn = new Map<string, string>();
  /** Package → simple name → top-level class id. */
  private readonly packages = new Map<string, Map<string, string>>();
  private readonly nodes = new Map<string, CodeNode>();
  private readonly edges = new Map<string, CodeEdge>();
  readonly callStats = { resolvedCalls: 0, externalCalls: 0, unresolvedCalls: 0 };

  constructor(private readonly root: string) {}

  result(files: number): JavaGraph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()], files, callStats: this.callStats };
  }

  // ── Pass 1: declarations ────────────────────────────────────────────────

  declare(abs: string, root: Node): void {
    const fileId = path.relative(this.root, abs).split(path.sep).join("/");
    const file: JavaFile = {
      fileId,
      root,
      pkg: "",
      imports: new Map(),
      wildcards: [],
      staticImports: new Map(),
      staticWildcards: [],
      types: new Map(),
    };
    this.files.set(fileId, file);
    this.addNode({
      id: fileId,
      kind: "file",
      name: path.basename(abs),
      file: fileId,
      line: 1,
      endLine: root.endPosition.row + 1,
      exported: true,
    });

    for (const child of root.namedChildren) {
      if (!child) continue;
      if (child.type === "package_declaration") {
        file.pkg =
          child.namedChildren.find((c) => c?.type === "scoped_identifier" || c?.type === "identifier")?.text ?? "";
      } else if (child.type === "import_declaration") {
        this.collectImport(file, child);
      } else if (CLASS_LIKE.has(child.type)) {
        const id = this.declareClass(file, child, fileId, "", undefined);
        const name = child.childForFieldName("name")?.text;
        if (id && name) {
          file.types.set(name, id);
          const pkg = this.packages.get(file.pkg) ?? new Map<string, string>();
          pkg.set(name, id);
          this.packages.set(file.pkg, pkg);
        }
      }
    }
  }

  private collectImport(file: JavaFile, decl: Node): void {
    const isStatic = decl.children.some((c) => c?.type === "static");
    const wildcard = decl.namedChildren.some((c) => c?.type === "asterisk");
    const name = decl.namedChildren.find((c) => c?.type === "scoped_identifier" || c?.type === "identifier")?.text;
    if (!name) return;
    if (isStatic && wildcard) file.staticWildcards.push(name);
    else if (isStatic)
      file.staticImports.set(name.slice(name.lastIndexOf(".") + 1), name.slice(0, name.lastIndexOf(".")));
    else if (wildcard) file.wildcards.push(name);
    else file.imports.set(name.slice(name.lastIndexOf(".") + 1), name);
  }

  private declareClass(
    file: JavaFile,
    node: Node,
    parentId: string,
    qualifier: string,
    outer: ClassInfo | undefined,
  ): string | undefined {
    const name = node.childForFieldName("name")?.text;
    if (!name) return undefined;
    const qualified = qualifier ? `${qualifier}.${name}` : name;
    const id = `${file.fileId}#${qualified}`;
    const kind: NodeKind =
      node.type === "interface_declaration" || node.type === "annotation_type_declaration" ? "interface" : "class";
    const visibility = modifiersOf(node);
    this.addNode({
      id,
      kind,
      name,
      file: file.fileId,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: visibility.has("public") || (outer !== undefined && !visibility.has("private")),
      doc: javadocOf(node),
    });
    this.addEdge(parentId, id, "contains");

    const fqn = outer ? `${outer.fqn}.${name}` : file.pkg ? `${file.pkg}.${name}` : name;
    const info: ClassInfo = {
      id,
      fqn,
      fileId: file.fileId,
      node,
      outer: outer?.id,
      nested: new Map(),
      fields: new Map(),
      methods: new Map(),
      supers: [],
      externalSuper: false,
    };
    this.classes.set(id, info);
    this.byFqn.set(fqn, id);
    outer?.nested.set(name, id);

    // Record components are fields too: `record Punto(int x, int y)`.
    for (const param of node.childForFieldName("parameters")?.namedChildren ?? []) {
      const pname = param?.childForFieldName("name")?.text;
      const ptype = param?.childForFieldName("type");
      if (pname && ptype) info.fields.set(pname, ptype);
    }

    const body = node.childForFieldName("body");
    const members = [
      ...(body?.namedChildren ?? []),
      // An enum's methods live in enum_body_declarations.
      ...(body?.namedChildren.find((c) => c?.type === "enum_body_declarations")?.namedChildren ?? []),
    ];
    const isInterface = kind === "interface";
    for (const member of members) {
      if (!member) continue;
      if (CLASS_LIKE.has(member.type)) {
        this.declareClass(file, member, id, qualified, info);
      } else if (member.type === "field_declaration" || member.type === "constant_declaration") {
        const type = member.childForFieldName("type");
        for (const declarator of member.namedChildren) {
          if (declarator?.type !== "variable_declarator") continue;
          const fname = declarator.childForFieldName("name")?.text;
          if (fname && type) info.fields.set(fname, type);
        }
      } else if (
        member.type === "method_declaration" ||
        member.type === "constructor_declaration" ||
        member.type === "compact_constructor_declaration"
      ) {
        this.declareMethod(file, member, info, qualified, isInterface, visibility.has("public") || isInterface);
      }
    }
    return id;
  }

  private declareMethod(
    file: JavaFile,
    member: Node,
    info: ClassInfo,
    qualified: string,
    inInterface: boolean,
    classPublic: boolean,
  ): void {
    const isConstructor = member.type !== "method_declaration";
    const name = isConstructor ? "constructor" : (member.childForFieldName("name")?.text ?? "?");
    const overloads = info.methods.get(name) ?? [];
    const id = `${file.fileId}#${qualified}.${name}${overloads.length ? `~${overloads.length + 1}` : ""}`;
    const params = (member.childForFieldName("parameters")?.namedChildren ?? []).filter(
      (p) => p?.type === "formal_parameter" || p?.type === "spread_parameter",
    );
    const modifiers = modifiersOf(member);
    const paramsText = (member.childForFieldName("parameters")?.text ?? "()").replace(/\s+/g, " ");
    const returnType = member.childForFieldName("type") ?? undefined;
    this.addNode({
      id,
      kind: "method",
      name,
      file: file.fileId,
      line: member.startPosition.row + 1,
      endLine: member.endPosition.row + 1,
      // Interface members are public unless declared private.
      exported: classPublic && (modifiers.has("public") || (inInterface && !modifiers.has("private"))),
      signature: isConstructor ? `constructor${paramsText}` : `${name}${paramsText}: ${returnType?.text ?? "void"}`,
      doc: javadocOf(member),
    });
    this.addEdge(info.id, id, "contains");
    overloads.push({
      id,
      params: params.length,
      varargs: params.some((p) => p?.type === "spread_parameter"),
      returnType,
    });
    info.methods.set(name, overloads);
  }

  // ── Pass 2: relations ───────────────────────────────────────────────────

  relate(): void {
    for (const info of this.classes.values()) this.resolveSupers(info);
    for (const file of this.files.values()) {
      this.addImportEdges(file);
      this.addTypeUsageEdges(file);
      for (const id of file.types.values()) this.walkClass(file, this.classes.get(id)!);
    }
  }

  private resolveSupers(info: ClassInfo): void {
    const file = this.files.get(info.fileId)!;
    const node = info.node;
    const add = (typeNode: Node | null | undefined, kind: EdgeKind) => {
      if (!typeNode) return;
      const resolved = this.resolveType(typeNode, file, info.outer ?? info.id);
      if (resolved?.kind === "instance") {
        info.supers.push(resolved.classId);
        this.addEdge(info.id, resolved.classId, kind, typeNode.startPosition.row + 1);
      } else if (resolved?.kind === "external") {
        info.externalSuper = true;
      }
    };
    const superclass = node.childForFieldName("superclass");
    add(superclass?.namedChildren[0], "extends");
    const interfaces =
      node.childForFieldName("interfaces") ?? node.namedChildren.find((c) => c?.type === "super_interfaces");
    const typeList = (n: Node | null | undefined) =>
      n?.namedChildren.find((c) => c?.type === "type_list")?.namedChildren ?? [];
    const isInterface = node.type === "interface_declaration";
    for (const t of typeList(interfaces)) add(t, isInterface ? "extends" : "implements");
    const extendsInterfaces = node.namedChildren.find((c) => c?.type === "extends_interfaces");
    for (const t of typeList(extendsInterfaces)) add(t, "extends");
  }

  private addImportEdges(file: JavaFile): void {
    for (const decl of file.root.namedChildren) {
      if (decl?.type !== "import_declaration") continue;
      const name = decl.namedChildren.find((c) => c?.type === "scoped_identifier" || c?.type === "identifier")?.text;
      if (!name) continue;
      const line = decl.startPosition.row + 1;
      const isStatic = decl.children.some((c) => c?.type === "static");
      const wildcard = decl.namedChildren.some((c) => c?.type === "asterisk");
      const classFqn = isStatic && !wildcard ? name.slice(0, name.lastIndexOf(".")) : name;
      const target = this.byFqn.get(classFqn);
      if (target) {
        this.addEdge(file.fileId, this.classes.get(target)!.fileId, "imports", line);
      } else if (wildcard && !isStatic && this.packages.has(name)) {
        // `import com.app.model.*`: the files actually used are linked through type usage.
      } else {
        const pkg = name.split(".").slice(0, 2).join(".");
        const id = `pkg:${pkg}`;
        if (!this.nodes.has(id))
          this.addNode({ id, kind: "package", name: pkg, file: "", line: 0, endLine: 0, exported: true });
        this.addEdge(file.fileId, id, "imports", line);
      }
    }
  }

  /** Classes of the same package need no import: link files by the types they use. */
  private addTypeUsageEdges(file: JavaFile): void {
    const context = file.types.values().next().value;
    if (!context) return;
    for (const typeNode of file.root.descendantsOfType(["type_identifier", "scoped_type_identifier"])) {
      if (!typeNode || typeNode.parent?.type === "scoped_type_identifier") continue;
      const resolved = this.resolveType(typeNode, file, this.enclosingClass(file, typeNode) ?? context);
      if (resolved?.kind !== "instance") continue;
      const target = this.classes.get(resolved.classId)!.fileId;
      if (target !== file.fileId) this.addEdge(file.fileId, target, "imports", typeNode.startPosition.row + 1);
    }
  }

  private walkClass(file: JavaFile, info: ClassInfo): void {
    const body = info.node.childForFieldName("body");
    if (!body) return;
    const members = [
      ...body.namedChildren,
      ...(body.namedChildren.find((c) => c?.type === "enum_body_declarations")?.namedChildren ?? []),
    ];
    const methodIndex = new Map<string, number>();
    for (const member of members) {
      if (!member) continue;
      if (CLASS_LIKE.has(member.type)) {
        const nested = info.nested.get(member.childForFieldName("name")?.text ?? "");
        if (nested) this.walkClass(file, this.classes.get(nested)!);
        continue;
      }
      if (
        member.type === "method_declaration" ||
        member.type === "constructor_declaration" ||
        member.type === "compact_constructor_declaration"
      ) {
        const name =
          member.type === "method_declaration" ? (member.childForFieldName("name")?.text ?? "?") : "constructor";
        const index = methodIndex.get(name) ?? 0;
        methodIndex.set(name, index + 1);
        const method = info.methods.get(name)?.[index];
        if (!method) continue;
        const scope: Scope = { file, classId: info.id, locals: new Map() };
        for (const param of member.childForFieldName("parameters")?.namedChildren ?? []) {
          if (param?.type === "formal_parameter")
            this.declareLocal(scope, param.childForFieldName("type"), param.childForFieldName("name"));
          if (param?.type === "spread_parameter") {
            const declarator = param.namedChildren.find((c) => c?.type === "variable_declarator");
            const pname =
              declarator?.childForFieldName("name") ?? param.namedChildren.find((c) => c?.type === "identifier");
            if (pname) scope.locals.set(pname.text, { kind: "external" }); // an array
          }
        }
        const methodBody = member.childForFieldName("body");
        if (methodBody) this.walk(methodBody, method.id, scope);
      } else if (
        member.type === "field_declaration" ||
        member.type === "static_initializer" ||
        member.type === "block"
      ) {
        // Field initializers and initializer blocks run as part of the class.
        this.walk(member, info.id, { file, classId: info.id, locals: new Map() });
      }
    }
  }

  private walk(node: Node, ownerId: string, scope: Scope): void {
    for (const child of node.namedChildren) {
      if (!child) continue;
      // Local and anonymous classes: their methods' calls belong to the enclosing method.
      switch (child.type) {
        case "local_variable_declaration": {
          const type = child.childForFieldName("type");
          for (const declarator of child.namedChildren) {
            if (declarator?.type !== "variable_declarator") continue;
            const value = declarator.childForFieldName("value");
            // Calls in the initializer run before the variable exists.
            if (value) this.walk(declarator, ownerId, scope);
            const name = declarator.childForFieldName("name");
            if (type?.text === "var") {
              const inferred = value ? this.typeOf(value, scope) : undefined;
              if (name) {
                if (inferred) scope.locals.set(name.text, inferred);
                else scope.locals.delete(name.text);
              }
            } else {
              this.declareLocal(scope, type, name);
            }
          }
          continue;
        }
        case "enhanced_for_statement":
          this.declareLocal(scope, child.childForFieldName("type"), child.childForFieldName("name"));
          break;
        case "catch_formal_parameter": {
          const type = child.namedChildren.find((c) => c?.type === "catch_type")?.namedChildren[0];
          this.declareLocal(scope, type, child.childForFieldName("name"));
          break;
        }
        case "resource": {
          this.declareLocal(scope, child.childForFieldName("type"), child.childForFieldName("name"));
          break;
        }
      }
      this.visitExpression(child, ownerId, scope);
      this.walk(child, ownerId, scope);
    }
  }

  private visitExpression(node: Node, ownerId: string, scope: Scope): void {
    const line = node.startPosition.row + 1;
    if (node.type === "method_invocation") {
      this.countCall(ownerId, this.resolveInvocation(node, scope), line);
    } else if (node.type === "object_creation_expression") {
      const type = node.childForFieldName("type");
      const resolved = type ? this.resolveType(type, scope.file, scope.classId) : undefined;
      this.countCall(
        ownerId,
        resolved?.kind === "instance" ? resolved.classId : resolved ? "external" : undefined,
        line,
      );
    } else if (node.type === "explicit_constructor_invocation") {
      // super(...) / this(...)
      const isThis = node.childForFieldName("constructor")?.type === "this";
      const info = this.classes.get(scope.classId)!;
      const args = node.childForFieldName("arguments")?.namedChildCount ?? 0;
      const chosen = (isThis ? [scope.classId] : info.supers)
        .map((c) => this.pickOverload(this.classes.get(c)?.methods.get("constructor"), args))
        .find(Boolean);
      // super() without a constructor in the project: Object's or a library class's.
      this.countCall(ownerId, chosen ?? (isThis ? undefined : "external"), line);
    } else if (node.type === "method_reference") {
      // Owner::getName, this::validar, Pet::new: the referenced method runs as part of this code.
      const [target, member] = [node.namedChildren[0], node.namedChildren[node.namedChildCount - 1]];
      if (!target) return;
      const base =
        target.type === "this"
          ? ({ kind: "instance", classId: scope.classId } as TypeValue)
          : this.typeOf(target, scope);
      if (base && base.kind !== "external") {
        if (node.text.endsWith("::new")) this.addEdge(ownerId, base.classId, "calls", line);
        else if (member?.type === "identifier") {
          const method = this.findMethod(base.classId, member.text, -1);
          if (method && method !== "external") this.addEdge(ownerId, method, "calls", line);
        }
      }
    }
  }

  private countCall(ownerId: string, target: string | "external" | undefined, line: number): void {
    if (target === "external") this.callStats.externalCalls++;
    else if (target) {
      this.callStats.resolvedCalls++;
      this.addEdge(ownerId, target, "calls", line);
    } else this.callStats.unresolvedCalls++;
  }

  private resolveInvocation(call: Node, scope: Scope): string | "external" | undefined {
    const name = call.childForFieldName("name")?.text;
    if (!name) return undefined;
    const args = call.childForFieldName("arguments")?.namedChildCount ?? 0;
    const object = call.childForFieldName("object");
    if (!object) {
      // Own, inherited or outer class method, or a static import.
      for (let classId: string | undefined = scope.classId; classId; classId = this.classes.get(classId)?.outer) {
        const found = this.findMethod(classId, name, args);
        if (found) return found;
      }
      const staticClass = scope.file.staticImports.get(name);
      if (staticClass) {
        const id = this.byFqn.get(staticClass);
        return id ? (this.findMethod(id, name, args) ?? "external") : "external";
      }
      for (const fqn of scope.file.staticWildcards) {
        const id = this.byFqn.get(fqn);
        if (!id) continue;
        const found = this.findMethod(id, name, args);
        if (found) return found;
      }
      return scope.file.staticWildcards.some((f) => !this.byFqn.has(f)) ? "external" : undefined;
    }
    if (object.type === "super") {
      for (const base of this.classes.get(scope.classId)?.supers ?? []) {
        const found = this.findMethod(base, name, args);
        if (found) return found;
      }
      return "external";
    }
    const receiver = this.typeOf(object, scope);
    if (!receiver) return undefined;
    if (receiver.kind === "external") return "external";
    return this.findMethod(receiver.classId, name, args);
  }

  /** A method by name and number of arguments, looking through supertypes; "external" if it may come from a library. */
  private findMethod(
    classId: string,
    name: string,
    args: number,
    seen = new Set<string>(),
  ): string | "external" | undefined {
    if (seen.has(classId)) return undefined;
    seen.add(classId);
    const info = this.classes.get(classId);
    if (!info) return undefined;
    const own = this.pickOverload(info.methods.get(name), args);
    if (own) return own;
    for (const base of info.supers) {
      const found = this.findMethod(base, name, args, seen);
      if (found) return found;
    }
    // Every class extends Object, and enums/records get generated methods.
    if (info.externalSuper || OBJECT_METHODS.has(name)) return "external";
    if (info.node.type === "enum_declaration" && ENUM_METHODS.has(name)) return "external";
    if (info.node.type === "record_declaration" && info.fields.has(name)) return "external";
    return undefined;
  }

  private pickOverload(overloads: MethodInfo[] | undefined, args: number): string | undefined {
    if (!overloads?.length) return undefined;
    if (args < 0) return overloads[0]!.id;
    const match =
      overloads.find((m) => m.params === args && !m.varargs) ??
      overloads.find((m) => m.varargs && args >= m.params - 1);
    return (match ?? overloads[0]!).id;
  }

  /** The declared type of an expression. */
  private typeOf(expr: Node, scope: Scope): TypeValue | undefined {
    switch (expr.type) {
      case "this":
        return { kind: "instance", classId: scope.classId };
      case "identifier": {
        const local = scope.locals.get(expr.text);
        if (local) return local;
        const field = this.fieldType(scope.classId, expr.text);
        if (field) return field;
        // A class used statically: `Util.formato()`.
        const type = this.resolveSimpleType(expr.text, scope.file, scope.classId);
        if (type?.kind === "instance") {
          this.linkFiles(scope.file.fileId, type.classId, expr);
          return { kind: "static", classId: type.classId };
        }
        return type?.kind === "external" && /^[A-Z]/.test(expr.text) ? type : undefined;
      }
      case "field_access": {
        const object = expr.childForFieldName("object");
        const field = expr.childForFieldName("field")?.text;
        if (!object || !field) return undefined;
        // A qualified class name: com.app.Util
        const fqn = this.byFqn.get(expr.text);
        if (fqn) return { kind: "static", classId: fqn };
        const base = this.typeOf(object, scope);
        if (!base) return undefined;
        if (base.kind === "external") return base;
        return this.fieldType(base.classId, field) ?? this.nestedStatic(base.classId, field);
      }
      case "method_invocation": {
        const target = this.resolveInvocation(expr, scope);
        if (!target || target === "external") return target === "external" ? { kind: "external" } : undefined;
        return this.returnTypeOf(target);
      }
      case "object_creation_expression": {
        const type = expr.childForFieldName("type");
        return type ? this.resolveType(type, scope.file, scope.classId) : undefined;
      }
      case "cast_expression": {
        const type = expr.childForFieldName("type");
        return type ? this.resolveType(type, scope.file, scope.classId) : undefined;
      }
      case "parenthesized_expression":
        return expr.namedChildren[0] ? this.typeOf(expr.namedChildren[0], scope) : undefined;
      case "string_literal":
      case "array_creation_expression":
      case "class_literal":
        return { kind: "external" };
      default:
        return undefined;
    }
  }

  private fieldType(classId: string, name: string, seen = new Set<string>()): TypeValue | undefined {
    for (let id: string | undefined = classId; id; id = this.classes.get(id)?.outer) {
      const found = this.ownOrInheritedField(id, name, seen);
      if (found) return found;
    }
    return undefined;
  }

  private ownOrInheritedField(classId: string, name: string, seen: Set<string>): TypeValue | undefined {
    if (seen.has(classId)) return undefined;
    seen.add(classId);
    const info = this.classes.get(classId);
    if (!info) return undefined;
    const typeNode = info.fields.get(name);
    if (typeNode) return this.resolveType(typeNode, this.files.get(info.fileId)!, classId) ?? { kind: "external" };
    for (const base of info.supers) {
      const found = this.ownOrInheritedField(base, name, seen);
      if (found) return found;
    }
    return undefined;
  }

  private nestedStatic(classId: string, name: string): TypeValue | undefined {
    const nested = this.classes.get(classId)?.nested.get(name);
    return nested ? { kind: "static", classId: nested } : undefined;
  }

  private returnTypeOf(methodId: string): TypeValue | undefined {
    const classId = methodId.slice(0, methodId.lastIndexOf("."));
    const info = this.classes.get(classId);
    if (!info) return undefined;
    for (const overloads of info.methods.values()) {
      const method = overloads.find((m) => m.id === methodId);
      if (!method) continue;
      if (/\.constructor(~\d+)?$/.test(methodId)) return { kind: "instance", classId };
      return method.returnType ? this.resolveType(method.returnType, this.files.get(info.fileId)!, classId) : undefined;
    }
    return undefined;
  }

  private declareLocal(scope: Scope, type: Node | null | undefined, name: Node | null | undefined): void {
    if (!name) return;
    const resolved = type ? this.resolveType(type, scope.file, scope.classId) : undefined;
    if (resolved) scope.locals.set(name.text, resolved);
    else scope.locals.delete(name.text);
  }

  /** A type node (`Owner`, `List<Pet>`, `Map.Entry`, `Pet[]`) in the context of a class. */
  private resolveType(type: Node, file: JavaFile, classId: string): TypeValue | undefined {
    switch (type.type) {
      case "type_identifier":
        return this.resolveSimpleType(type.text, file, classId);
      case "generic_type": {
        const base = type.namedChildren.find(
          (c) => c?.type === "type_identifier" || c?.type === "scoped_type_identifier",
        );
        return base ? this.resolveType(base, file, classId) : undefined;
      }
      case "scoped_type_identifier": {
        const id = this.byFqn.get(type.text.replace(/<[^>]*>/g, ""));
        if (id) return { kind: "instance", classId: id };
        // Outer.Inner
        const [first, ...rest] = type.text.split(".");
        let current = first ? this.resolveSimpleType(first, file, classId) : undefined;
        for (const part of rest) {
          if (current?.kind !== "instance") return current?.kind === "external" ? current : { kind: "external" };
          const nested = this.classes.get(current.classId)?.nested.get(part);
          current = nested ? { kind: "instance", classId: nested } : { kind: "external" };
        }
        return current;
      }
      case "array_type":
        return { kind: "external" };
      case "integral_type":
      case "floating_point_type":
      case "boolean_type":
      case "void_type":
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * A simple type name, as Java resolves it: nested types of the class and its outers, types of
   * the same file, single-type imports, the same package, then wildcard imports. Anything else
   * compiles only if it comes from a library or java.lang: external.
   */
  private resolveSimpleType(name: string, file: JavaFile, classId: string): TypeValue | undefined {
    if (PRIMITIVES.has(name) || name === "var") return undefined;
    for (let id: string | undefined = classId; id; id = this.classes.get(id)?.outer) {
      const info = this.classes.get(id);
      if (!info) break;
      if (info.id.endsWith(`#${name}`) || info.id.endsWith(`.${name}`)) return { kind: "instance", classId: info.id };
      const nested = info.nested.get(name);
      if (nested) return { kind: "instance", classId: nested };
    }
    const local = file.types.get(name);
    if (local) return { kind: "instance", classId: local };
    const imported = file.imports.get(name);
    if (imported) {
      const id = this.byFqn.get(imported);
      return id ? { kind: "instance", classId: id } : { kind: "external" };
    }
    const samePackage = this.packages.get(file.pkg)?.get(name);
    if (samePackage) return { kind: "instance", classId: samePackage };
    for (const pkg of file.wildcards) {
      const id = this.packages.get(pkg)?.get(name) ?? this.byFqn.get(`${pkg}.${name}`);
      if (id) return { kind: "instance", classId: id };
    }
    // Type parameters (T, E…) are unknown; everything else must be a library or java.lang type.
    return /^[A-Z][A-Z0-9]?$/.test(name) ? undefined : { kind: "external" };
  }

  private enclosingClass(file: JavaFile, node: Node): string | undefined {
    for (let n: Node | null = node.parent; n; n = n.parent) {
      if (!CLASS_LIKE.has(n.type)) continue;
      const names: string[] = [];
      for (let c: Node | null = n; c; c = c.parent) {
        if (CLASS_LIKE.has(c.type)) names.unshift(c.childForFieldName("name")?.text ?? "?");
      }
      const id = `${file.fileId}#${names.join(".")}`;
      return this.classes.has(id) ? id : undefined;
    }
    return undefined;
  }

  private linkFiles(fileId: string, classId: string, at: Node): void {
    const target = this.classes.get(classId)?.fileId;
    if (target && target !== fileId) this.addEdge(fileId, target, "imports", at.startPosition.row + 1);
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
}

/** Methods every Java object has. */
const OBJECT_METHODS = new Set([
  "equals",
  "hashCode",
  "toString",
  "getClass",
  "clone",
  "finalize",
  "notify",
  "notifyAll",
  "wait",
]);

/** Methods the compiler generates for every enum. */
const ENUM_METHODS = new Set(["values", "valueOf", "name", "ordinal", "compareTo"]);

function modifiersOf(node: Node): Set<string> {
  const modifiers = node.namedChildren.find((c) => c?.type === "modifiers");
  return new Set(
    modifiers?.children
      .filter((c) => c && c.type !== "marker_annotation" && c.type !== "annotation")
      .map((c) => c!.text),
  );
}

/** The `/** … *\/` comment right before a declaration, without the asterisks and @tags. */
function javadocOf(node: Node): string | undefined {
  const previous = node.previousSibling;
  if (previous?.type !== "block_comment" || !previous.text.startsWith("/**")) return undefined;
  const text = previous.text
    .replace(/^\/\*\*|\*\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .filter((line) => !line.trim().startsWith("@"))
    .join("\n")
    .trim();
  return text || undefined;
}
