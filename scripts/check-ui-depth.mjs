// Static guard for DopeDB's UI contract. It walks JSX rather than raw DOM depth:
// only surfaces and interactive controls consume one of the three levels. It also
// checks control sizing, primary-action flows, color-token ownership, and grid
// tracks that could otherwise grow past their container.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [path.join(root, "src"), path.join(root, "workspace-cloud", "app")];
const legacyTokenRatchet = JSON.parse(
  fs.readFileSync(path.join(root, "scripts", "ui-legacy-token-ratchet.json"), "utf8"),
);
const maxVisualDepth = 3;
const controlTags = new Set(["button", "input", "select", "textarea", "summary"]);
const legacyFloatingMenuClasses = new Set(["toolbar-menu", "toolbar-menu-panel"]);
const rawColorLiteralAllowedFiles = new Set([
  // Standalone SVG exports cannot resolve the live document's CSS variables.
  "src/lib/erdExport.ts",
]);
const explicitSurfaceClasses = new Set([
  "btn",
  "badge",
  "card",
  "ds-card",
  "ds-panel",
  "ds-surface",
  "editor-box",
  "generated-sql",
  "grid-panel",
  "grid-scroll",
  "safety-details",
  "schema-detail-list",
  "schema-node",
]);
const cssBoundaryClasses = new Set();
const surfaceClassPattern = /(?:^|[-_])(?:card|panel|surface|modal|dialog|popover|inspector|canvas-wrap)$/;
const controlRowClassPattern = /(?:^|[-_])(?:actions|pager|tabs|toolbar)$/;

function filesBelow(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesBelow(resolved, extension);
    return entry.isFile() && resolved.endsWith(extension) ? [resolved] : [];
  });
}

const tsxFiles = sourceRoots.flatMap((sourceRoot) => filesBelow(sourceRoot, ".tsx"));
const cssFiles = sourceRoots.flatMap((sourceRoot) => filesBelow(sourceRoot, ".css"));
const productionCodeFiles = sourceRoots
  .flatMap((sourceRoot) => [
    ...filesBelow(sourceRoot, ".ts"),
    ...filesBelow(sourceRoot, ".tsx"),
  ])
  .filter(
    (file) =>
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !file.endsWith(".d.ts"),
  );
const rawColorLiteralPattern = /#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(/i;
const legacyColorAliasPattern =
  /var\(\s*--ds-(?:surface|text|accent)(?:-[A-Za-z0-9_-]+)?\b/g;

function readJson(relativeFile) {
  return JSON.parse(fs.readFileSync(path.join(root, relativeFile), "utf8"));
}

function checkTailwindContract(errors) {
  const packages = [
    ["package.json", readJson("package.json")],
    ["workspace-cloud/package.json", readJson("workspace-cloud/package.json")],
    ["site/package.json", readJson("site/package.json")],
  ];
  const expectedVersion = packages[0][1].devDependencies?.tailwindcss;
  if (!expectedVersion) {
    errors.push("package.json: Tailwind CSS must remain an explicit development dependency");
    return;
  }
  for (const [relativeFile, manifest] of packages) {
    if (manifest.devDependencies?.tailwindcss !== expectedVersion) {
      errors.push(
        `${relativeFile}: tailwindcss must match the root ${expectedVersion} version`,
      );
    }
  }
  if (packages[0][1].devDependencies?.["@tailwindcss/vite"] !== expectedVersion) {
    errors.push("package.json: @tailwindcss/vite must match tailwindcss");
  }
  for (const [relativeFile, manifest] of packages.slice(1)) {
    if (manifest.devDependencies?.["@tailwindcss/postcss"] !== expectedVersion) {
      errors.push(`${relativeFile}: @tailwindcss/postcss must match tailwindcss`);
    }
  }

  for (const relativeFile of [
    "src/design-system/index.css",
    "workspace-cloud/app/globals.css",
    "site/app/globals.css",
  ]) {
    const source = fs.readFileSync(path.join(root, relativeFile), "utf8");
    if (
      !source.includes(
        '@import "tailwindcss/utilities.css" layer(utilities) prefix(tw)',
      )
    ) {
      errors.push(`${relativeFile}: Tailwind utilities must keep the tw: prefix`);
    }
    if (
      source.includes('@import "tailwindcss";') ||
      source.includes("tailwindcss/preflight.css")
    ) {
      errors.push(
        `${relativeFile}: Preflight requires a dedicated, visually reviewed migration`,
      );
    }
  }
}

function attribute(opening, name) {
  return opening.attributes.find(
    (property) => property.type === "JSXAttribute" && property.name.name === name,
  );
}

function literalStrings(node, values = []) {
  if (!node || typeof node !== "object") return values;
  if (node.type === "StringLiteral") values.push(node.value);
  if (node.type === "TemplateElement") values.push(node.value.raw);
  for (const [key, child] of Object.entries(node)) {
    if (["loc", "start", "end", "extra"].includes(key)) continue;
    if (Array.isArray(child)) {
      for (const item of child) literalStrings(item, values);
    } else {
      literalStrings(child, values);
    }
  }
  return values;
}

function classNames(opening) {
  const className = attribute(opening, "className");
  if (!className?.value) return [];
  return literalStrings(className.value)
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
}

function tagName(opening) {
  const name = opening.name;
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    return `${name.object.name}.${name.property.name}`;
  }
  return "unknown";
}

function isVisualBoundary(opening) {
  if (attribute(opening, "data-ui-boundary")) return true;
  const tag = tagName(opening);
  if (controlTags.has(tag) || /(?:Button|Card|Panel|Dialog|Modal|Inspector)$/.test(tag)) return true;
  return classNames(opening).some(
    (name) =>
      explicitSurfaceClasses.has(name) ||
      cssBoundaryClasses.has(name) ||
      surfaceClassPattern.test(name),
  );
}

function checkControlRow(opening, file, errors) {
  const names = classNames(opening);
  for (const name of names) {
    if (legacyFloatingMenuClasses.has(name)) {
      errors.push(
        `${path.relative(root, file)}:${opening.loc?.start.line ?? 1} ` +
          `legacy clipped menu class "${name}" is forbidden; use ToolbarMenu`,
      );
    }
  }
  if (
    names.some((name) => controlRowClassPattern.test(name)) &&
    !names.includes("ds-control-row")
  ) {
    errors.push(
      `${path.relative(root, file)}:${opening.loc?.start.line ?? 1} ` +
        `control row must include ds-control-row: ${names.join(" ")}`,
    );
  }
  if (
    tagName(opening) === "button" &&
    names.includes("icon-only") &&
    !attribute(opening, "aria-label") &&
    !attribute(opening, "aria-labelledby")
  ) {
    errors.push(
      `${path.relative(root, file)}:${opening.loc?.start.line ?? 1} ` +
        "icon-only button must have an aria-label or aria-labelledby",
    );
  }
  if (
    tagName(opening) === "button" &&
    names.includes("ds-menu-item") &&
    attribute(opening, "role")?.value?.value !== "menuitem"
  ) {
    errors.push(
      `${path.relative(root, file)}:${opening.loc?.start.line ?? 1} ` +
        'ToolbarMenu button must declare role="menuitem"',
    );
  }
}

function checkSimpleIconButton(element, file, errors) {
  const opening = element.openingElement;
  if (tagName(opening) !== "button" || !classNames(opening).includes("btn")) return;
  const meaningfulChildren = element.children.filter((child) => {
    if (child.type === "JSXText") return child.value.trim().length > 0;
    return !(
      child.type === "JSXExpressionContainer" &&
      child.expression.type === "JSXEmptyExpression"
    );
  });
  if (
    meaningfulChildren.length !== 1 ||
    meaningfulChildren[0].type !== "JSXElement" ||
    tagName(meaningfulChildren[0].openingElement) !== "Icon"
  ) {
    return;
  }
  if (classNames(opening).includes("icon-only")) return;
  errors.push(
    `${path.relative(root, file)}:${opening.loc?.start.line ?? 1} ` +
      'single-icon .btn must include "icon-only" to reserve a square hit target',
  );
}

function countPrimaryActions(node, rootNode) {
  if (!node || typeof node !== "object") return 0;
  if (
    node !== rootNode &&
    node.type === "JSXElement" &&
    attribute(node.openingElement, "data-primary-flow")
  ) {
    return 0;
  }

  let count = 0;
  if (
    node.type === "JSXElement" &&
    classNames(node.openingElement).includes("primary")
  ) {
    count += 1;
  }
  for (const [key, child] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "comments", "errors"].includes(key)) continue;
    if (Array.isArray(child)) {
      for (const item of child) count += countPrimaryActions(item, rootNode);
    } else {
      count += countPrimaryActions(child, rootNode);
    }
  }
  return count;
}

function checkPrimaryFlow(element, file, errors) {
  if (!attribute(element.openingElement, "data-primary-flow")) return;
  const count = countPrimaryActions(element, element);
  if (count <= 1) return;
  errors.push(
    `${path.relative(root, file)}:${element.loc?.start.line ?? 1} ` +
      `primary flow contains ${count} affirmative actions; keep exactly one primary`,
  );
}

function checkRawColorLiterals(node, file, errors) {
  if (!node || typeof node !== "object") return;
  const value =
    node.type === "StringLiteral"
      ? node.value
      : node.type === "TemplateElement"
        ? node.value.raw
        : null;
  if (value && rawColorLiteralPattern.test(value)) {
    errors.push(
      `${path.relative(root, file)}:${node.loc?.start.line ?? 1} ` +
        "raw color literal is forbidden in production TypeScript; use a --ds-* token",
    );
  }
  for (const [key, child] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "comments", "errors"].includes(key)) continue;
    if (Array.isArray(child)) {
      for (const item of child) checkRawColorLiterals(item, file, errors);
    } else {
      checkRawColorLiterals(child, file, errors);
    }
  }
}

function walk(node, file, depth, ancestry, errors) {
  if (!node || typeof node !== "object") return;
  const opening = node.type === "JSXElement" ? node.openingElement : null;
  if (opening) {
    checkControlRow(opening, file, errors);
    checkSimpleIconButton(node, file, errors);
    checkPrimaryFlow(node, file, errors);
  }
  const boundary = opening ? isVisualBoundary(opening) : false;
  const nextDepth = depth + Number(boundary);
  const nextAncestry = boundary && opening
    ? [...ancestry, `${tagName(opening)}.${classNames(opening).join(".")}`]
    : ancestry;

  if (opening && nextDepth > maxVisualDepth) {
    errors.push(
      `${path.relative(root, file)}:${opening.loc?.start.line ?? 1} ` +
        `visual depth ${nextDepth}: ${nextAncestry.join(" > ")}`,
    );
    return;
  }

  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    for (const child of node.children) walk(child, file, nextDepth, nextAncestry, errors);
    return;
  }

  for (const [key, child] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "comments", "errors"].includes(key)) continue;
    if (Array.isArray(child)) {
      for (const item of child) walk(item, file, depth, ancestry, errors);
    } else {
      walk(child, file, depth, ancestry, errors);
    }
  }
}

const guardFixture = parse(
  '<section className="ds-panel"><article className="card"><div className="ds-surface"><button>Too deep</button></div></article></section>',
  { sourceType: "module", plugins: ["jsx"] },
);
const guardFixtureErrors = [];
walk(guardFixture, "<ui-depth-self-test>", 0, [], guardFixtureErrors);
if (guardFixtureErrors.length === 0) {
  throw new Error("UI depth guard self-test failed to detect a four-level boundary");
}

const legacyMenuFixture = parse('<div className="toolbar-menu" />', {
  sourceType: "module",
  plugins: ["jsx"],
});
const legacyMenuFixtureErrors = [];
walk(legacyMenuFixture, "<ui-menu-self-test>", 0, [], legacyMenuFixtureErrors);
if (!legacyMenuFixtureErrors.some((error) => error.includes("legacy clipped menu"))) {
  throw new Error("UI menu guard self-test failed to detect a clipped legacy menu");
}

const iconButtonFixture = parse(
  '<button className="btn small" aria-label="Refresh"><Icon name="refresh" /></button>',
  { sourceType: "module", plugins: ["jsx"] },
);
const iconButtonFixtureErrors = [];
walk(iconButtonFixture, "<ui-icon-button-self-test>", 0, [], iconButtonFixtureErrors);
if (!iconButtonFixtureErrors.some((error) => error.includes('must include "icon-only"'))) {
  throw new Error("UI icon-button guard self-test failed to detect an unbounded icon button");
}

const unnamedIconButtonFixture = parse(
  '<button className="btn small icon-only"><Icon name="refresh" /></button>',
  { sourceType: "module", plugins: ["jsx"] },
);
const unnamedIconButtonFixtureErrors = [];
walk(
  unnamedIconButtonFixture,
  "<ui-icon-button-name-self-test>",
  0,
  [],
  unnamedIconButtonFixtureErrors,
);
if (
  !unnamedIconButtonFixtureErrors.some((error) =>
    error.includes("aria-label or aria-labelledby"),
  )
) {
  throw new Error("UI icon-button guard self-test failed to detect a missing accessible name");
}

const unnamedMenuItemFixture = parse(
  '<button className="ds-menu-item">Refresh</button>',
  { sourceType: "module", plugins: ["jsx"] },
);
const unnamedMenuItemFixtureErrors = [];
walk(
  unnamedMenuItemFixture,
  "<ui-menu-item-role-self-test>",
  0,
  [],
  unnamedMenuItemFixtureErrors,
);
if (!unnamedMenuItemFixtureErrors.some((error) => error.includes('role="menuitem"'))) {
  throw new Error("UI menu-item guard self-test failed to detect a missing menu role");
}

const duplicatePrimaryFixture = parse(
  '<main data-primary-flow><button className="btn primary">Save</button><button className="btn primary">Run</button></main>',
  { sourceType: "module", plugins: ["jsx"] },
);
const duplicatePrimaryFixtureErrors = [];
walk(
  duplicatePrimaryFixture,
  "<ui-primary-flow-self-test>",
  0,
  [],
  duplicatePrimaryFixtureErrors,
);
if (!duplicatePrimaryFixtureErrors.some((error) => error.includes("affirmative actions"))) {
  throw new Error("UI primary-flow guard self-test failed to detect duplicate primary actions");
}

const rawColorFixture = parse('const color = "#123456";', {
  sourceType: "module",
  plugins: ["typescript"],
});
const rawColorFixtureErrors = [];
checkRawColorLiterals(
  rawColorFixture,
  "<ui-raw-color-self-test>",
  rawColorFixtureErrors,
);
if (!rawColorFixtureErrors.some((error) => error.includes("raw color literal"))) {
  throw new Error("UI color guard self-test failed to detect a raw TypeScript color");
}

function targetClassNames(selectorList) {
  const names = [];
  for (const selector of selectorList.split(",")) {
    const lastCompound = selector.trim().split(/[\s>+~]+/).at(-1) ?? "";
    const match = lastCompound.match(/\.([A-Za-z_][\w-]*)/);
    if (match) names.push(match[1]);
  }
  return names;
}

function positiveDeclaration(body, property) {
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i"));
  if (!match) return false;
  return !/^(?:0(?:px)?|none|transparent|inherit|initial|unset)(?:\s|$)/i.test(
    match[1].trim(),
  );
}

for (const file of cssFiles) {
  const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of source.matchAll(rule)) {
    const body = match[2];
    const border = positiveDeclaration(body, "border");
    const radius = positiveDeclaration(body, "border-radius");
    const background =
      positiveDeclaration(body, "background") ||
      positiveDeclaration(body, "background-color");
    const shadow = positiveDeclaration(body, "box-shadow");
    if (!(shadow || (border && (radius || background)) || (radius && background))) {
      continue;
    }
    for (const name of targetClassNames(match[1])) cssBoundaryClasses.add(name);
  }
}

const errors = [];
checkTailwindContract(errors);
for (const file of tsxFiles) {
  const source = fs.readFileSync(file, "utf8");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  walk(ast, file, 0, [], errors);
}

for (const file of productionCodeFiles) {
  const relativeFile = path.relative(root, file);
  if (rawColorLiteralAllowedFiles.has(relativeFile)) continue;
  const source = fs.readFileSync(file, "utf8");
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  checkRawColorLiterals(ast, file, errors);
}

function containsUnsafeFractionalTrack(value) {
  let minmaxDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("minmax(", index)) {
      minmaxDepth += 1;
      index += "minmax(".length - 1;
      continue;
    }
    if (value[index] === ")" && minmaxDepth > 0) {
      minmaxDepth -= 1;
      continue;
    }
    if (minmaxDepth === 0) {
      const match = value.slice(index).match(/^(?:\d*\.?\d+)fr\b/);
      if (match) return true;
    }
  }
  return false;
}

const seenLegacyTokenRatchetFiles = new Set();
for (const file of cssFiles) {
    const relativeFile = path.relative(root, file);
    const source = fs.readFileSync(file, "utf8");
    if (!relativeFile.startsWith("src/design-system/")) {
      const legacyAliasCount = [...source.matchAll(legacyColorAliasPattern)].length;
      const baseline = legacyTokenRatchet.files[relativeFile] ?? 0;
      if (legacyAliasCount > baseline) {
        errors.push(
          `${relativeFile}: legacy --ds-surface/text/accent aliases grew from ` +
            `${baseline} to ${legacyAliasCount}; use canonical role tokens or Tailwind theme utilities`,
        );
      }
      if (baseline > 0) {
        seenLegacyTokenRatchetFiles.add(relativeFile);
        if (legacyAliasCount < baseline) {
          errors.push(
            `${relativeFile}: legacy token count shrank from ${baseline} to ` +
              `${legacyAliasCount}; update scripts/ui-legacy-token-ratchet.json in the same change`,
          );
        }
      }
    }
    const sourceWithoutComments = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
      comment.replace(/[^\n]/g, " "),
    );
    const declaration = /grid-template-(?:columns|rows)\s*:\s*([^;{}]+);/g;
    for (const match of sourceWithoutComments.matchAll(declaration)) {
      if (!containsUnsafeFractionalTrack(match[1])) continue;
      const line = source.slice(0, match.index).split("\n").length;
      errors.push(
        `${path.relative(root, file)}:${line} unsafe fractional grid track: ${match[1].trim()}`,
      );
    }

    const rule = /([^{}]+)\{([^{}]*)\}/g;
    for (const match of sourceWithoutComments.matchAll(rule)) {
      const selector = match[1];
      if (/\.toolbar-menu(?:-panel)?(?![\w-])/.test(selector)) {
        const line = source.slice(0, match.index).split("\n").length;
        errors.push(
          `${path.relative(root, file)}:${line} legacy clipped menu selector is forbidden; ` +
            "use the portalled ToolbarMenu contract",
        );
      }
      const targetsControl =
        /(?:^|[\s>+~,(:])(?:button|input|select|summary)(?=[\s.#[:>+~,)\]]|$)/.test(selector) ||
        /[._-](?:btn|button|seg)(?:[^\w-]|$)/.test(selector);
      if (!targetsControl) continue;
      const hardCodedHeight = match[2].match(
        /(?:^|;)\s*(?:min-)?height\s*:\s*(\d+(?:\.\d+)?px)\b/,
      );
      if (!hardCodedHeight) continue;
      const line = source.slice(0, match.index).split("\n").length;
      errors.push(
        `${path.relative(root, file)}:${line} control height must use a --ds-control-* token: ` +
          `${selector.trim()} (${hardCodedHeight[1]})`,
      );
    }
}

for (const relativeFile of Object.keys(legacyTokenRatchet.files)) {
  if (seenLegacyTokenRatchetFiles.has(relativeFile)) continue;
  errors.push(
    `${relativeFile}: stale legacy-token ratchet entry; remove it after the file is migrated or deleted`,
  );
}

if (errors.length > 0) {
  console.error(`UI layout contract failed (visual depth maximum ${maxVisualDepth}):`);
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    "Use one primary action, canonical --ds-* roles/Tailwind theme utilities, " +
      "whitespace/dividers, ds-control-row, --ds-control-* tokens, and minmax(0, 1fr).",
  );
  process.exit(1);
}

console.log(
  `UI layout contract passed for ${tsxFiles.length} TSX and ${cssFiles.length} CSS files ` +
    `(visual depth maximum ${maxVisualDepth}).`,
);
