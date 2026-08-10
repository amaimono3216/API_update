import ts from 'typescript';

import type { OperationIndex, SdkConvention } from './sdk-map.js';
import { SDK_CONVENTIONS, findConvention, resolveOperation } from './sdk-map.js';
import type { CallSite } from './types.js';

const MAX_SNIPPET_LENGTH = 600;

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

export const isTypeScriptFile = (path: string): boolean =>
  Object.keys(SCRIPT_KINDS).some((ext) => path.endsWith(ext));

/**
 * TypeScript / JavaScript のソースを AST で走査し、Stripe・OpenAI SDK の
 * 呼び出し箇所と、そこで渡しているパラメータ名を抽出する。
 *
 * 型チェッカは使わず単一ファイルのパースのみで完結させている。tsconfig や
 * node_modules の解決が不要になり、任意のリポジトリをそのまま走査できるため。
 * 精度は「解決したパスが実スペックに存在するか」で担保する。
 */
export function scanSource(filePath: string, sourceText: string, index: OperationIndex): CallSite[] {
  const scriptKind = SCRIPT_KINDS[filePath.slice(filePath.lastIndexOf('.'))] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);

  const sdkClasses = collectSdkClasses(sourceFile);
  const clients = collectClients(sourceFile, sdkClasses);
  const callSites: CallSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const parsed = parseChain(node.expression);
      if (parsed) {
        const convention = resolveRootConvention(parsed.root, clients);
        if (convention && parsed.path.length >= 2) {
          const operation = resolveOperation(convention, parsed.path, index);
          if (operation) {
            callSites.push(buildCallSite(sourceFile, filePath, node, convention, parsed, operation));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return callSites;
}

/** `import Stripe from 'stripe'` の `Stripe` のように、SDK クラスを指す識別子を集める。 */
function collectSdkClasses(sourceFile: ts.SourceFile): Map<string, SdkConvention> {
  const classes = new Map<string, SdkConvention>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const convention = findConvention(statement.moduleSpecifier.text);
    if (!convention) continue;

    const bindings = statement.importClause;
    if (!bindings) continue;
    if (bindings.name) classes.set(bindings.name.text, convention);
    if (bindings.namedBindings && ts.isNamedImports(bindings.namedBindings)) {
      for (const element of bindings.namedBindings.elements) classes.set(element.name.text, convention);
    }
  }
  return classes;
}

/** `const stripe = new Stripe(key)` / `require('stripe')(key)` からクライアント変数を集める。 */
function collectClients(sourceFile: ts.SourceFile, sdkClasses: Map<string, SdkConvention>): Map<string, SdkConvention> {
  const clients = new Map<string, SdkConvention>();

  const conventionOf = (expression: ts.Expression): SdkConvention | undefined => {
    if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) {
      return sdkClasses.get(expression.expression.text);
    }
    if (ts.isCallExpression(expression)) {
      // require('stripe')(key) のような即時呼び出し
      const inner = expression.expression;
      if (ts.isCallExpression(inner) && isRequireCall(inner)) return conventionFromRequire(inner);
      if (ts.isIdentifier(inner)) return sdkClasses.get(inner.text);
      if (isRequireCall(expression)) return conventionFromRequire(expression);
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const convention = conventionOf(node.initializer);
      if (convention) clients.set(node.name.text, convention);
    }
    // this.stripe = new Stripe(...) のようなプロパティ代入
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const convention = conventionOf(node.right);
      if (convention) clients.set(`this.${node.left.name.text}`, convention);
    }
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const convention = conventionOf(node.initializer);
      if (convention) clients.set(`this.${node.name.text}`, convention);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return clients;
}

const isRequireCall = (node: ts.CallExpression): boolean =>
  ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length > 0;

function conventionFromRequire(node: ts.CallExpression): SdkConvention | undefined {
  const arg = node.arguments[0];
  return arg && ts.isStringLiteral(arg) ? findConvention(arg.text) : undefined;
}

/**
 * クライアント変数が別ファイルで生成されている場合（`import { stripe } from './lib/stripe'`）に備え、
 * 変数名が SDK 名と一致するものはクライアント候補として扱う。
 * 誤検出はパス解決時に実スペックと突き合わせて除外される。
 */
function resolveRootConvention(root: string, clients: Map<string, SdkConvention>): SdkConvention | undefined {
  const known = clients.get(root);
  if (known) return known;
  const bare = (root.startsWith('this.') ? root.slice(5) : root).toLowerCase();
  return SDK_CONVENTIONS.find((c) => c.language === 'typescript' && c.clientNames.includes(bare));
}

interface ParsedChain {
  root: string;
  /** ルート識別子を除いた残りのチェーン */
  path: string[];
}

/** `stripe.checkout.sessions.create` を root=`stripe`, path=`['checkout','sessions','create']` に分解する。 */
function parseChain(expression: ts.Expression): ParsedChain | undefined {
  const segments: string[] = [];
  let current: ts.Expression = expression;

  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }

  if (ts.isIdentifier(current)) return { root: current.text, path: segments };
  if (current.kind === ts.SyntaxKind.ThisKeyword && segments.length >= 1) {
    // this.stripe.charges.create → root = 'this.stripe'
    const first = segments.shift() as string;
    return { root: `this.${first}`, path: segments };
  }
  return undefined;
}

function buildCallSite(
  sourceFile: ts.SourceFile,
  filePath: string,
  node: ts.CallExpression,
  convention: SdkConvention,
  parsed: ParsedChain,
  operation: NonNullable<CallSite['operation']>,
): CallSite {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  return {
    file: filePath,
    line: start.line + 1,
    endLine: end.line + 1,
    provider: convention.provider,
    chain: [parsed.root, ...parsed.path],
    operation,
    passedParams: collectPassedParams(node.arguments),
    snippet: extractSnippet(sourceFile, start.line, end.line),
  };
}

/**
 * 呼び出しの前後を含めた抜粋を返す。
 * レスポンス側の変更では「戻り値をどう使っているか」が判定材料になるため、
 * 呼び出し式そのものだけでなく後続行まで含める。
 */
function extractSnippet(sourceFile: ts.SourceFile, startLine: number, endLine: number): string {
  const lines = sourceFile.getFullText().split('\n');
  const from = Math.max(0, startLine - 2);
  const to = Math.min(lines.length, endLine + 1 + 6);
  const text = lines
    .slice(from, to)
    .join('\n')
    .replace(/^\s*\n/, '');
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}…` : text;
}

/**
 * 引数のオブジェクトリテラルからプロパティパスを収集する。
 * 配列要素は `[]` を挟み、スキーマ差分側の表記（`line_items.[].amount`）と揃える。
 */
export function collectPassedParams(args: ts.NodeArray<ts.Expression> | ts.Expression[]): string[] {
  const found = new Set<string>();

  const walkObject = (node: ts.ObjectLiteralExpression, prefix: string, depth: number): void => {
    if (depth > 8) return;
    for (const property of node.properties) {
      let name: string | undefined;
      let initializer: ts.Expression | undefined;

      if (ts.isPropertyAssignment(property)) {
        name = propertyName(property.name);
        initializer = property.initializer;
      } else if (ts.isShorthandPropertyAssignment(property)) {
        name = property.name.text;
      }
      if (!name) continue;

      const path = prefix ? `${prefix}.${name}` : name;
      found.add(path);

      if (!initializer) continue;
      if (ts.isObjectLiteralExpression(initializer)) {
        walkObject(initializer, path, depth + 1);
      } else if (ts.isArrayLiteralExpression(initializer)) {
        for (const element of initializer.elements) {
          if (ts.isObjectLiteralExpression(element)) walkObject(element, `${path}.[]`, depth + 1);
        }
      }
    }
  };

  for (const arg of args) {
    if (ts.isObjectLiteralExpression(arg)) walkObject(arg, '', 0);
  }
  return [...found];
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return undefined;
}
