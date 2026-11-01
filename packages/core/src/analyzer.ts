import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { CodeEdge, CodeGraph, CodeNode, EdgeKind, NodeKind } from "./types.js";
import { workspacePaths } from "./workspaces.js";

export interface AnalyzeOptions {
  /** Explicit tsconfig/jsconfig path. Defaults to <root>/tsconfig.json or <root>/jsconfig.json. */
  tsconfig?: string;
  onProgress?: (message: string) => void;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
// Test fixtures are sample projects, not part of the codebase being explained.
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  "fixtures",
  "__fixtures__",
]);

const FALLBACK_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
};

export function analyzeProject(rootDir: string, options: AnalyzeOptions = {}): CodeGraph {
  const started = Date.now();
  const root = path.resolve(rootDir);
  const log = options.onProgress ?? (() => {});

  const configPath = options.tsconfig ? path.resolve(options.tsconfig) : findConfig(root);
  const config = configPath
    ? readConfig(configPath)
    : { fileNames: walkSources(root), compilerOptions: FALLBACK_OPTIONS };
  const { fileNames } = config;
  log(configPath ? `Usando ${path.relative(root, configPath)}` : "Sin tsconfig: analizando todos los archivos JS/TS");

  // In monorepos, point imports between workspace packages at their source; the project's own paths win.
  const workspaces = workspacePaths(root);
  const compilerOptions: ts.CompilerOptions = Object.keys(workspaces).length
    ? { ...config.compilerOptions, paths: { ...workspaces, ...config.compilerOptions.paths } }
    : config.compilerOptions;
  if (Object.keys(workspaces).length) log(`Monorepo: ${Object.keys(workspaces).length / 2} paquetes del workspace`);

  // allowJs so mixed codebases are analyzed in full; noEmit because we never write output.
  // Without an explicit target TypeScript assumes ES5 and doesn't load Map, Promise, etc.
  const program = ts.createProgram(fileNames, {
    ...compilerOptions,
    target: compilerOptions.target ?? ts.ScriptTarget.ESNext,
    allowJs: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && isProjectFile(root, sf.fileName));
  log(`${sourceFiles.length} archivos fuente`);

  const builder = new GraphBuilder(root, checker, compilerOptions);
  for (const sf of sourceFiles) builder.collectDeclarations(sf);
  for (const sf of sourceFiles) builder.collectRelations(sf);

  const nodes = builder.nodes();
  const edges = builder.edges();
  return {
    root,
    generatedAt: new Date().toISOString(),
    tsconfig: configPath ? path.relative(root, configPath) : undefined,
    nodes,
    edges,
    stats: {
      files: sourceFiles.length,
      symbols: nodes.filter((n) => n.kind !== "file" && n.kind !== "package").length,
      edges: edges.length,
      ...builder.callStats,
      durationMs: Date.now() - started,
    },
  };
}

class GraphBuilder {
  private readonly nodeById = new Map<string, CodeNode>();
  private readonly idByDecl = new Map<ts.Node, string>();
  private readonly edgeByKey = new Map<string, CodeEdge>();
  private readonly exportedDecls = new Set<ts.Node>();
  private readonly resolutionCache = ts.createModuleResolutionCache(ts.sys.getCurrentDirectory(), (f) => f);
  readonly callStats = { resolvedCalls: 0, externalCalls: 0, unresolvedCalls: 0 };

  constructor(
    private readonly root: string,
    private readonly checker: ts.TypeChecker,
    private readonly compilerOptions: ts.CompilerOptions,
  ) {}

  nodes(): CodeNode[] {
    return [...this.nodeById.values()];
  }

  edges(): CodeEdge[] {
    return [...this.edgeByKey.values()];
  }

  // ── Pass 1: declarations ────────────────────────────────────────────────

  collectDeclarations(sf: ts.SourceFile): void {
    const fileId = this.rel(sf.fileName);
    this.markExports(sf);
    this.addNode({
      id: fileId,
      kind: "file",
      name: path.basename(sf.fileName),
      file: fileId,
      line: 1,
      endLine: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
      exported: true,
    });
    this.idByDecl.set(sf, fileId);

    const visit = (node: ts.Node, parentId: string, qualifier: string): void => {
      const declared = this.declare(node, sf, fileId, parentId, qualifier);
      if (declared) {
        ts.forEachChild(node, (child) => visit(child, declared.id, declared.qualifiedName));
      } else {
        ts.forEachChild(node, (child) => visit(child, parentId, qualifier));
      }
    };
    ts.forEachChild(sf, (child) => visit(child, fileId, ""));
  }

  private declare(
    node: ts.Node,
    sf: ts.SourceFile,
    fileId: string,
    parentId: string,
    qualifier: string,
  ): { id: string; qualifiedName: string } | undefined {
    const info = describeDeclaration(node);
    if (!info) return undefined;

    const qualifiedName = qualifier ? `${qualifier}.${info.name}` : info.name;
    let id = `${fileId}#${qualifiedName}`;
    for (let i = 2; this.nodeById.has(id); i++) id = `${fileId}#${qualifiedName}~${i}`;

    const parent = this.nodeById.get(parentId);
    const exported =
      info.kind === "method"
        ? Boolean(parent?.exported) && !isPrivate(node)
        : this.exportedDecls.has(node) ||
          this.exportedDecls.has(info.declaration) ||
          (info.exportedVia !== undefined && this.exportedDecls.has(info.exportedVia));

    this.addNode({
      id,
      kind: info.kind,
      name: info.name,
      file: fileId,
      line: lineOf(sf, node.getStart(sf)),
      endLine: lineOf(sf, node.end),
      exported,
      signature: this.signatureOf(info.name, info.inner),
      doc: this.docOf(info.declaration),
    });
    this.idByDecl.set(node, id);
    this.idByDecl.set(info.declaration, id);
    if (info.inner) this.idByDecl.set(info.inner, id);
    this.addEdge(parentId, id, "contains");
    return { id, qualifiedName };
  }

  /** Records every declaration reachable through the module's exports (incl. `export { x }` and CommonJS). */
  private markExports(sf: ts.SourceFile): void {
    const moduleSymbol = this.checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) return;
    for (const exp of this.checker.getExportsOfModule(moduleSymbol)) {
      for (const decl of this.resolveAlias(exp).declarations ?? []) this.exportedDecls.add(decl);
    }
  }

  // ── Pass 2: relations ───────────────────────────────────────────────────

  collectRelations(sf: ts.SourceFile): void {
    const fileId = this.rel(sf.fileName);

    const visit = (node: ts.Node, ownerId: string): void => {
      const line = lineOf(sf, node.getStart(sf));

      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          this.addImport(sf, fileId, node.moduleSpecifier.text, line);
        }
      } else if (ts.isCallExpression(node)) {
        const specifier = requireOrDynamicImport(node);
        if (specifier) this.addImport(sf, fileId, specifier, line);
        else if (node.expression.kind !== ts.SyntaxKind.SuperKeyword) {
          this.addCall(ownerId, node.expression, line);
        }
        for (const arg of node.arguments) this.addCallback(ownerId, arg, line);
      } else if (ts.isNewExpression(node)) {
        this.addCall(ownerId, node.expression, line);
        for (const arg of node.arguments ?? []) this.addCallback(ownerId, arg, line);
      } else if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer)) {
        // <button onClick={guardar}>: the component hands the function to be called later.
        if (node.initializer.expression) this.addCallback(ownerId, node.initializer.expression, line);
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        // Only capitalized tags are components; lowercase ones are intrinsic HTML elements.
        if (/^[A-Z]/.test(node.tagName.getText(sf))) this.addCall(ownerId, node.tagName, line);
      } else if (
        (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) &&
        this.idByDecl.has(node)
      ) {
        this.addHeritage(node, line);
      }

      ts.forEachChild(node, (child) => visit(child, this.idByDecl.get(node) ?? ownerId));
    };
    ts.forEachChild(sf, (child) => visit(child, fileId));
  }

  private addCall(ownerId: string, callee: ts.Node, line: number): void {
    const target = callee.kind === ts.SyntaxKind.ImportKeyword ? undefined : this.resolveTarget(callee, ownerId);
    if (target === "external") this.callStats.externalCalls++;
    else if (target) {
      this.callStats.resolvedCalls++;
      this.addEdge(ownerId, target, "calls", line);
    } else this.callStats.unresolvedCalls++;
  }

  /**
   * A project function passed by reference (`items.map(formatear)`, `setTimeout(guardar)`,
   * `onClick={guardar}`) will run as part of this code, so it counts as a call. Not counted in the
   * call statistics, which are about call expressions.
   */
  private addCallback(ownerId: string, expr: ts.Expression, line: number): void {
    if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return;
    const target = this.resolveTarget(expr, ownerId);
    if (!target || target === "external" || target === ownerId) return;
    const kind = this.nodeById.get(target)?.kind;
    if (kind === "function" || kind === "method") this.addEdge(ownerId, target, "calls", line);
  }

  private addHeritage(node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, line: number): void {
    const fromId = this.idByDecl.get(node)!;
    for (const clause of node.heritageClauses ?? []) {
      const kind: EdgeKind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      for (const type of clause.types) {
        const target = this.resolveTarget(type.expression);
        if (target && target !== "external") this.addEdge(fromId, target, kind, line);
      }
    }
  }

  private addImport(sf: ts.SourceFile, fileId: string, specifier: string, line: number): void {
    const resolved = ts.resolveModuleName(
      specifier,
      sf.fileName,
      this.compilerOptions,
      ts.sys,
      this.resolutionCache,
    ).resolvedModule;

    const targetId = resolved && !resolved.isExternalLibraryImport && this.rel(resolved.resolvedFileName);
    if (targetId && this.nodeById.has(targetId)) {
      this.addEdge(fileId, targetId, "imports", line);
      return;
    }
    // Relative imports outside the analyzed set (assets, generated files) are not dependencies.
    if (specifier.startsWith(".") || specifier.startsWith("/")) return;

    const pkg = packageName(specifier);
    const pkgId = `pkg:${pkg}`;
    if (!this.nodeById.has(pkgId)) {
      this.addNode({ id: pkgId, kind: "package", name: pkg, file: "", line: 0, endLine: 0, exported: true });
    }
    this.addEdge(fileId, pkgId, "imports", line);
  }

  /** Maps an expression (callee, JSX tag, heritage clause) to a graph node id. */
  private resolveTarget(expr: ts.Node, ownerId?: string): string | "external" | undefined {
    const location = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
    const symbol = this.checker.getSymbolAtLocation(location);
    if (!symbol) return undefined;

    const declarations = this.resolveAlias(symbol).declarations ?? [];
    for (const decl of declarations) {
      const id = this.idByDecl.get(decl) ?? this.idByDecl.get(callableOf(decl) ?? decl);
      if (id) return id;
    }
    const outside = declarations.some((d) => !isProjectFile(this.root, d.getSourceFile().fileName));
    if (outside) return "external";
    // A variable holding a function (`const { t } = useTranslation()`, `const [x, setX] = useState()`,
    // a prop, a callback): follow its type to where the function is implemented.
    return this.resolveByType(location, ownerId);
  }

  /**
   * Resolves a call through the callee's type: signatures implemented outside the project count as
   * external; ones implemented in it resolve to the declared function that contains the implementation.
   * Signatures that only exist as types (props, interfaces) stay unresolved: the implementation is
   * decided at runtime.
   */
  private resolveByType(location: ts.Node, ownerId: string | undefined): string | "external" | undefined {
    const type = this.checker.getTypeAtLocation(location);
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      const decl = signature.declaration;
      if (!decl) continue;
      if (!isProjectFile(this.root, decl.getSourceFile().fileName)) return "external";
      if (!isImplementation(decl)) continue;
      for (let node: ts.Node = decl; !ts.isSourceFile(node); node = node.parent) {
        const id = this.idByDecl.get(node);
        if (!id) continue;
        // An anonymous function defined inside the caller itself says nothing about what runs.
        if (id === ownerId && node !== decl) return undefined;
        return id;
      }
    }
    return undefined;
  }

  private resolveAlias(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private signatureOf(name: string, callable: ts.Node | undefined): string | undefined {
    if (!callable || !ts.isFunctionLike(callable)) return undefined;
    const signature = this.checker.getSignatureFromDeclaration(callable);
    return signature ? name + this.checker.signatureToString(signature) : undefined;
  }

  private docOf(decl: ts.Declaration): string | undefined {
    const name = ts.getNameOfDeclaration(decl);
    const symbol = name && this.checker.getSymbolAtLocation(name);
    const doc = symbol && ts.displayPartsToString(symbol.getDocumentationComment(this.checker)).trim();
    return doc || undefined;
  }

  private addNode(node: CodeNode): void {
    this.nodeById.set(node.id, node);
  }

  private addEdge(from: string, to: string, kind: EdgeKind, line?: number): void {
    if (from === to && kind !== "calls") return;
    const key = `${from}|${to}|${kind}`;
    const edge = this.edgeByKey.get(key) ?? { from, to, kind, count: 0, lines: [] };
    edge.count++;
    if (line !== undefined && !edge.lines.includes(line)) edge.lines.push(line);
    this.edgeByKey.set(key, edge);
  }

  private rel(fileName: string): string {
    return path.relative(this.root, fileName).split(path.sep).join("/");
  }
}

interface DeclarationInfo {
  kind: NodeKind;
  name: string;
  /** The node that owns the name, docs and export status (e.g. the VariableDeclaration of `const f = () => {}`). */
  declaration: ts.Declaration;
  /** The function or class expression inside `declaration`, when it differs from it. */
  inner?: ts.SignatureDeclaration | ts.ClassExpression;
  /** For functions inside an exported object (`export const api = { listar() {} }`), the object's declaration. */
  exportedVia?: ts.Declaration;
}

/** Calls that wrap a function without changing what it does: `const load = useCallback(async () => …, [])`. */
const FUNCTION_WRAPPERS = new Set(["useCallback", "useEffectEvent", "useEvent", "memo", "forwardRef", "observer"]);

function describeDeclaration(node: ts.Node): DeclarationInfo | undefined {
  // Functions of an object assigned to a variable, the usual shape of API services: `usuariosApi.listar`.
  const owner = objectOwner(node);
  if (owner) {
    const name = `${owner.name.text}.${propertyName((node as ts.PropertyAssignment | ts.MethodDeclaration).name)}`;
    if (ts.isPropertyAssignment(node) && isFunctionExpression(node.initializer)) {
      return { kind: "function", name, declaration: node, inner: node.initializer, exportedVia: owner };
    }
    if (ts.isMethodDeclaration(node) && node.body) {
      return { kind: "function", name, declaration: node, inner: node, exportedVia: owner };
    }
  }
  if (ts.isFunctionDeclaration(node) && node.body) {
    return { kind: "function", name: node.name?.text ?? "default", declaration: node, inner: node };
  }
  if (ts.isClassDeclaration(node)) {
    return { kind: "class", name: node.name?.text ?? "default", declaration: node };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { kind: "interface", name: node.name.text, declaration: node };
  }
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.body) {
    const prefix = ts.isGetAccessor(node) ? "get " : ts.isSetAccessor(node) ? "set " : "";
    return { kind: "method", name: prefix + propertyName(node.name), declaration: node, inner: node };
  }
  if (ts.isConstructorDeclaration(node) && node.body) {
    return { kind: "method", name: "constructor", declaration: node, inner: node };
  }
  if (ts.isPropertyDeclaration(node) && node.initializer && isFunctionExpression(node.initializer)) {
    return { kind: "method", name: propertyName(node.name), declaration: node, inner: node.initializer };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (isFunctionExpression(node.initializer)) {
      return { kind: "function", name: node.name.text, declaration: node, inner: node.initializer };
    }
    if (ts.isClassExpression(node.initializer)) {
      return { kind: "class", name: node.name.text, declaration: node, inner: node.initializer };
    }
    const wrapped = wrappedFunction(node.initializer);
    if (wrapped) return { kind: "function", name: node.name.text, declaration: node, inner: wrapped };
  }
  return undefined;
}

/** The function inside `useCallback(fn)`, `memo(forwardRef(fn))`, `React.memo(fn)`… */
function wrappedFunction(expr: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!ts.isCallExpression(expr)) return undefined;
  const callee = expr.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
  const [first] = expr.arguments;
  if (!FUNCTION_WRAPPERS.has(name) || !first) return undefined;
  return isFunctionExpression(first) ? first : wrappedFunction(first);
}

/** For a property or method of an object literal assigned to a variable, that variable. */
function objectOwner(node: ts.Node): (ts.VariableDeclaration & { name: ts.Identifier }) | undefined {
  if (!(ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) || !ts.isObjectLiteralExpression(node.parent)) {
    return undefined;
  }
  let expr: ts.Node = node.parent;
  while (ts.isParenthesizedExpression(expr.parent) || ts.isAsExpression(expr.parent) || ts.isSatisfiesExpression(expr.parent)) {
    expr = expr.parent;
  }
  const decl = expr.parent;
  return ts.isVariableDeclaration(decl) && decl.initializer === expr && ts.isIdentifier(decl.name)
    ? (decl as ts.VariableDeclaration & { name: ts.Identifier })
    : undefined;
}

function isImplementation(node: ts.Node): boolean {
  return ts.isFunctionLike(node) && "body" in node && node.body !== undefined;
}

/** For `const f = () => {}` the checker returns the VariableDeclaration; this finds the arrow function. */
function callableOf(decl: ts.Declaration): ts.Node | undefined {
  if ((ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
    return decl.initializer;
  }
  return undefined;
}

function isFunctionExpression(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isPrivate(node: ts.Node): boolean {
  const name = ts.getNameOfDeclaration(node as ts.Declaration);
  if (name && ts.isPrivateIdentifier(name)) return true;
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Private);
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

function requireOrDynamicImport(call: ts.CallExpression): string | undefined {
  const [arg] = call.arguments;
  if (!arg || !ts.isStringLiteralLike(arg)) return undefined;
  const isRequire = ts.isIdentifier(call.expression) && call.expression.text === "require";
  const isDynamicImport = call.expression.kind === ts.SyntaxKind.ImportKeyword;
  return isRequire || isDynamicImport ? arg.text : undefined;
}

/** "lodash/fp" → "lodash", "@scope/pkg/sub" → "@scope/pkg", "node:fs" → "node:fs". */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function isProjectFile(root: string, fileName: string): boolean {
  const rel = path.relative(root, fileName);
  return !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes("node_modules");
}

function findConfig(root: string): string | undefined {
  return ["tsconfig.json", "jsconfig.json"].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
}

/**
 * Parses a tsconfig. Solution-style configs (`"files": []` + `references`, as generated by Vite)
 * list no files themselves, so their referenced projects are merged instead.
 */
function readConfig(configPath: string): { fileNames: string[]; compilerOptions: ts.CompilerOptions } {
  const host: ts.ParseConfigFileHost = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (!parsed) return { fileNames: walkSources(path.dirname(configPath)), compilerOptions: FALLBACK_OPTIONS };
  if (parsed.fileNames.length > 0 || !parsed.projectReferences?.length) {
    return { fileNames: parsed.fileNames, compilerOptions: parsed.options };
  }

  const fileNames = new Set<string>();
  let compilerOptions = parsed.options;
  for (const ref of parsed.projectReferences) {
    const refPath = ts.resolveProjectReferencePath(ref);
    const child = fs.existsSync(refPath) ? readConfig(refPath) : undefined;
    if (!child) continue;
    if (fileNames.size === 0) compilerOptions = child.compilerOptions;
    child.fileNames.forEach((f) => fileNames.add(f));
  }
  return { fileNames: [...fileNames], compilerOptions };
}

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, out);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
