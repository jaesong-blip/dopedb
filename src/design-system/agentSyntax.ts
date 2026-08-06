// Fine-grained Shiki bridge for Agent output. The highlighter, JavaScript regex
// engine, and individual grammars are loaded only after a completed code fence
// needs highlighting; colors resolve through the closed Agent syntax palette.
import type { HighlighterCore, LanguageRegistration } from "shiki/core";

export type AgentSyntaxToken = {
  content: string;
  color?: string;
};

export type AgentSyntaxLine = AgentSyntaxToken[];

type SyntaxLanguage =
  | "bash"
  | "css"
  | "graphql"
  | "html"
  | "javascript"
  | "json"
  | "markdown"
  | "python"
  | "rust"
  | "sql"
  | "tsx"
  | "typescript"
  | "yaml";

type LanguageModule = { default: LanguageRegistration[] };

const SYNTAX_THEME = "dopedb-agent-syntax";
const languageLoaders: Record<
  SyntaxLanguage,
  () => Promise<LanguageModule>
> = {
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const languageAliases: Record<string, SyntaxLanguage> = {
  bash: "bash",
  css: "css",
  gql: "graphql",
  graphql: "graphql",
  html: "html",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsonc: "json",
  markdown: "markdown",
  md: "markdown",
  mysql: "sql",
  node: "javascript",
  postgres: "sql",
  postgresql: "sql",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  sql: "sql",
  sqlite: "sql",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const languagePromises = new Map<SyntaxLanguage, Promise<void>>();

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]).then(([core, engine]) =>
      core.createHighlighterCore({
        engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
        langs: [],
        themes: [
          core.createCssVariablesTheme({
            fontStyle: false,
            name: SYNTAX_THEME,
            variablePrefix: "--ds-agent-syntax-",
            variableDefaults: {
              "ansi-black": "var(--ds-syntax-ansi-black)",
              "ansi-blue": "var(--ds-syntax-ansi-blue)",
              "ansi-bright-black": "var(--ds-syntax-ansi-bright-black)",
              "ansi-bright-blue": "var(--ds-syntax-ansi-bright-blue)",
              "ansi-bright-cyan": "var(--ds-syntax-ansi-bright-cyan)",
              "ansi-bright-green": "var(--ds-syntax-ansi-bright-green)",
              "ansi-bright-magenta": "var(--ds-syntax-ansi-bright-magenta)",
              "ansi-bright-red": "var(--ds-syntax-ansi-bright-red)",
              "ansi-bright-white": "var(--ds-syntax-ansi-bright-white)",
              "ansi-bright-yellow": "var(--ds-syntax-ansi-bright-yellow)",
              "ansi-cyan": "var(--ds-syntax-ansi-cyan)",
              "ansi-green": "var(--ds-syntax-ansi-green)",
              "ansi-magenta": "var(--ds-syntax-ansi-magenta)",
              "ansi-red": "var(--ds-syntax-ansi-red)",
              "ansi-white": "var(--ds-syntax-ansi-white)",
              "ansi-yellow": "var(--ds-syntax-ansi-yellow)",
              background: "var(--ds-syntax-background)",
              foreground: "var(--ds-syntax-foreground)",
              "token-changed": "var(--ds-syntax-changed)",
              "token-comment": "var(--ds-syntax-comment)",
              "token-constant": "var(--ds-syntax-constant)",
              "token-deleted": "var(--ds-syntax-deleted)",
              "token-function": "var(--ds-syntax-function)",
              "token-inserted": "var(--ds-syntax-inserted)",
              "token-keyword": "var(--ds-syntax-keyword)",
              "token-link": "var(--ds-syntax-link)",
              "token-parameter": "var(--ds-syntax-parameter)",
              "token-punctuation": "var(--ds-syntax-punctuation)",
              "token-string": "var(--ds-syntax-string)",
              "token-string-expression": "var(--ds-syntax-string-expression)",
            },
          }),
        ],
        warnings: false,
      }),
    );
  }
  return highlighterPromise;
}

function normalizeLanguage(language: string | null): SyntaxLanguage | null {
  if (!language) return null;
  return languageAliases[language.trim().toLocaleLowerCase()] ?? null;
}

async function ensureLanguage(language: SyntaxLanguage) {
  const existing = languagePromises.get(language);
  if (existing) return existing;

  const loading = Promise.all([getHighlighter(), languageLoaders[language]()])
    .then(([highlighter, registration]) =>
      highlighter.loadLanguage(registration.default),
    )
    .then(() => undefined);
  languagePromises.set(language, loading);
  return loading;
}

export async function highlightAgentCode(
  code: string,
  language: string | null,
): Promise<AgentSyntaxLine[] | null> {
  const normalized = normalizeLanguage(language);
  if (!normalized) return null;

  await ensureLanguage(normalized);
  const highlighter = await getHighlighter();
  const result = highlighter.codeToTokens(code, {
    lang: normalized,
    theme: SYNTAX_THEME,
  });
  return result.tokens.map((line) =>
    line.map((token) => ({ content: token.content, color: token.color })),
  );
}
