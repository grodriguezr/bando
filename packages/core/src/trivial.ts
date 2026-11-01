import ts from "typescript";
import { GraphIndex } from "./query.js";
import type { CodeGraph } from "./types.js";

/** Model name recorded for summaries written by Bando itself, without AI. */
export const AUTOMATIC_MODEL = "bando:automático";

type TrivialKind = "reexports" | "types" | "data";

const DESCRIPTIONS: Record<TrivialKind, string> = {
  reexports: "Punto de entrada que solo reexporta lo definido en otros archivos",
  types: "Define tipos que usan otras partes del proyecto",
  data: "Define datos o constantes",
};

/**
 * Summary for files without logic (type definitions, constants, translations, barrel files that
 * only re-export): describing them doesn't need a model. Undefined for files with any code to explain.
 */
export function automaticSummary(graph: CodeGraph, fileId: string, source: string): string | undefined {
  // The classifier reads JavaScript/TypeScript syntax; other languages always go to the model.
  if (!/\.([mc]?[jt]sx?|json)$/.test(fileId)) return undefined;
  const sf = ts.createSourceFile(fileId, source, ts.ScriptTarget.Latest, true, scriptKind(fileId));
  const kind = classify(sf);
  if (!kind) return undefined;

  const index = new GraphIndex(graph);
  const lines = ["## Propósito", "", `${DESCRIPTIONS[kind]}.`, ""];

  const exported = exportedNames(sf);
  if (exported.length) {
    const shown = exported.slice(0, 40).map((name) => `\`${name}\``);
    lines.push(
      "## Contenido",
      "",
      `Exporta: ${shown.join(", ")}${exported.length > 40 ? ` y ${exported.length - 40} más` : ""}.`,
      "",
    );
  }
  const defaultObject = defaultExportedObject(sf);
  if (defaultObject !== undefined) lines.push(`Exporta por defecto un objeto con ${defaultObject} claves.`, "");

  const importers = index.incoming(fileId, "imports").map((e) => e.from);
  lines.push("## Cómo se usa", "");
  if (importers.length) {
    const shown = importers.slice(0, 10).map((id) => `\`${id}\``);
    lines.push(`Lo importan ${importers.length} archivos: ${shown.join(", ")}${importers.length > 10 ? "…" : ""}.`);
  } else {
    lines.push("Ningún archivo del proyecto lo importa.");
  }
  lines.push("", "_Resumen automático: el archivo no tiene lógica que explicar, así que no se usó IA._");
  return lines.join("\n");
}

/** A file is trivial when it has no functions and calls nothing: it only declares types and values. */
function classify(sf: ts.SourceFile): TrivialKind | undefined {
  if (!sf.statements.length) return undefined;
  let hasLogic = false;
  const visit = (node: ts.Node): void => {
    if (hasLogic) return;
    if (
      ts.isFunctionLike(node) &&
      !ts.isFunctionTypeNode(node) &&
      !ts.isMethodSignature(node) &&
      !ts.isCallSignatureDeclaration(node) &&
      !ts.isConstructSignatureDeclaration(node) &&
      !ts.isIndexSignatureDeclaration(node) &&
      !ts.isConstructorTypeNode(node)
    ) {
      hasLogic = true;
    } else if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isClassLike(node) ||
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node)
    ) {
      hasLogic = true;
    } else {
      ts.forEachChild(node, visit);
    }
  };
  visit(sf);
  if (hasLogic) return undefined;

  const statements = sf.statements.filter((s) => !ts.isImportDeclaration(s));
  if (statements.every((s) => ts.isExportDeclaration(s))) return "reexports";
  const isType = (s: ts.Statement) =>
    ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || (ts.isExportDeclaration(s) && s.isTypeOnly);
  return statements.every(isType) ? "types" : "data";
}

function exportedNames(sf: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sf.statements) {
    const exported =
      ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        names.push(...statement.exportClause.elements.map((e) => e.name.text));
      } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        names.push(`* de ${statement.moduleSpecifier.text}`);
      }
    } else if (!exported) {
      continue;
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations)
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
    } else if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}

/** Number of keys of `export default { … }`, typical of translation files. */
function defaultExportedObject(sf: ts.SourceFile): number | undefined {
  for (const statement of sf.statements) {
    if (!ts.isExportAssignment(statement)) continue;
    let expr = statement.expression;
    while (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr))
      expr = expr.expression;
    if (ts.isObjectLiteralExpression(expr)) return expr.properties.length;
  }
  return undefined;
}

function scriptKind(fileId: string): ts.ScriptKind {
  if (fileId.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileId.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(fileId)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
