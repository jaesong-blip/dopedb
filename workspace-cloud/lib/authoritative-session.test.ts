// The authoritative-session port is the sole sensitive route session reader.
// This AST guard rejects equivalent syntax instead of relying on source-text regexes.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "@typescript/typescript6";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("./auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

import { authoritativeSession } from "./authoritative-session";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = join(workspaceRoot, "app/api/v1");
const authModule = normalize(join(workspaceRoot, "lib/auth"));

type RouteSource = { fileName: string; source: string };

async function routeSources(root: string): Promise<RouteSource[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return routeSources(path);
    if (entry.isFile() && entry.name === "route.ts") return [{
      fileName: path,
      source: await readFile(path, "utf8"),
    }];
    return [];
  }));
  return nested.flat();
}

function staticStrings(sourceFile: ts.SourceFile) {
  const strings = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.parent.flags & ts.NodeFlags.Const
        && node.initializer
      ) {
        const value = staticString(node.initializer, strings);
        if (value !== undefined && strings.get(node.name.text) !== value) {
          strings.set(node.name.text, value);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return strings;
}

function staticString(node: ts.Expression, strings: ReadonlyMap<string, string>): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return strings.get(node.text);
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression, strings);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, strings);
    const right = staticString(node.right, strings);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  return undefined;
}

function resolvesToAuth(specifier: string, fileName: string) {
  if (specifier === "@/lib/auth" || specifier === "@/lib/auth.ts") return true;
  const target = normalize(resolve(dirname(fileName), specifier));
  return target === authModule || target === `${authModule}.ts` || target === `${authModule}/index`;
}

function sessionReadViolations(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const strings = staticStrings(sourceFile);
  const violations = new Set<string>();
  const propertyIsGetSession = (node: ts.Expression) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "getSession";
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      return staticString(node.argumentExpression, strings) === "getSession";
    }
    return false;
  };
  const bindingPropertyIsGetSession = (node: ts.BindingElement) => {
    const property = node.propertyName ?? node.name;
    if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text === "getSession";
    return ts.isComputedPropertyName(property)
      && staticString(property.expression, strings) === "getSession";
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      if (
        resolvesToAuth(node.moduleSpecifier.text, fileName)
        && named
        && ts.isNamedImports(named)
        && named.elements.some((item) => (item.propertyName ?? item.name).text === "getSession")
      ) {
        violations.add("getSession import from auth");
      }
    }
    if (ts.isBindingElement(node) && bindingPropertyIsGetSession(node)) {
      violations.add("getSession destructuring");
    }
    if (ts.isCallExpression(node)) {
      if (propertyIsGetSession(node.expression)) violations.add("getSession property call");
      if (ts.isIdentifier(node.expression) && node.expression.text === "getSession") {
        violations.add("getSession alias call");
      }
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const specifier = node.arguments[0] && staticString(node.arguments[0], strings);
        if (specifier === undefined || resolvesToAuth(specifier, fileName)) {
          violations.add(isDynamicImport ? "dynamic auth import" : "dynamic auth require");
        }
      }
    }
    if (propertyIsGetSession(node as ts.Expression)) violations.add("getSession property reference");
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...violations];
}

function expectSessionReadRejected(source: string) {
  expect(sessionReadViolations(source, join(apiRoot, "fixture/route.ts"))).not.toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authoritative API session port", () => {
  it("uses Better Auth's supported durable-session query exactly", async () => {
    const request = new Request("https://app.example/api/v1/workspaces");
    getSessionMock.mockResolvedValue(null);

    await expect(authoritativeSession(request)).resolves.toBeNull();
    expect(getSessionMock).toHaveBeenCalledOnce();
    expect(getSessionMock).toHaveBeenCalledWith({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
  });

  it("forbids structural session reads from every API v1 route", async () => {
    const sources = await routeSources(apiRoot);
    expect(sources).not.toHaveLength(0);
    for (const route of sources) {
      expect(sessionReadViolations(route.source, route.fileName)).toEqual([]);
    }
  });

  it("rejects direct, alias, bracket, computed, and dynamic-import bypasses", () => {
    expectSessionReadRejected('auth.api.getSession({ headers: request.headers });');
    expectSessionReadRejected('const { getSession: read } = auth.api; await read({});');
    expectSessionReadRejected('const { ["get" + "Session"]: read } = auth.api; await read({});');
    expectSessionReadRejected('await auth.api["getSession"]({});');
    expectSessionReadRejected('const key = "get" + "Session"; await auth.api[key]({});');
    expectSessionReadRejected('await import("../../../../lib/auth");');
  });

  it("allows only the authoritative-session or workspace-authorization route ports", () => {
    expect(sessionReadViolations(
      'import { authoritativeSession } from "../../lib/authoritative-session"; await authoritativeSession(request);',
      join(apiRoot, "fixture/route.ts"),
    )).toEqual([]);
    expect(sessionReadViolations(
      'import { authorizeWorkspace } from "../../lib/workspace-authorization"; await authorizeWorkspace(request, id, "view");',
      join(apiRoot, "fixture/route.ts"),
    )).toEqual([]);
    expect(sessionReadViolations(
      'import { auth } from "../../lib/auth"; await auth.api.listOrganizations({ headers: request.headers });',
      join(apiRoot, "fixture/route.ts"),
    )).toEqual([]);
  });
});
