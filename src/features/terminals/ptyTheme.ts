// Resolves the shared xterm palette from the canonical design-system tokens so
// Terminal renderers never own hard-coded colors or drift between surfaces.
import type { ITheme } from "@xterm/xterm";

function token(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
  property: string,
): string | undefined {
  return style.getPropertyValue(property).trim() || undefined;
}

export function resolvePtyTheme(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
): ITheme {
  return {
    background: token(style, "--ds-background"),
    foreground: token(style, "--ds-foreground"),
    cursor: token(style, "--ds-foreground"),
    cursorAccent: token(style, "--ds-background"),
    selectionBackground: token(style, "--ds-selection"),
    black: token(style, "--ds-terminal-ansi-black"),
    brightBlack: token(style, "--ds-terminal-ansi-bright-black"),
    red: token(style, "--ds-terminal-ansi-red"),
    brightRed: token(style, "--ds-terminal-ansi-bright-red"),
    green: token(style, "--ds-terminal-ansi-green"),
    brightGreen: token(style, "--ds-terminal-ansi-bright-green"),
    yellow: token(style, "--ds-terminal-ansi-yellow"),
    brightYellow: token(style, "--ds-terminal-ansi-bright-yellow"),
    blue: token(style, "--ds-terminal-ansi-blue"),
    brightBlue: token(style, "--ds-terminal-ansi-bright-blue"),
    magenta: token(style, "--ds-terminal-ansi-magenta"),
    brightMagenta: token(style, "--ds-terminal-ansi-bright-magenta"),
    cyan: token(style, "--ds-terminal-ansi-cyan"),
    brightCyan: token(style, "--ds-terminal-ansi-bright-cyan"),
    white: token(style, "--ds-terminal-ansi-white"),
    brightWhite: token(style, "--ds-terminal-ansi-bright-white"),
  };
}
