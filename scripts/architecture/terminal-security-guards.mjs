const ptySurfacePath = "src/features/terminals/PtySurface.tsx";

export function collectTerminalSecurityDiagnostics({ exists, read }) {
  if (!exists(ptySurfacePath)) {
    return [`required terminal security file is missing: ${ptySurfacePath}`];
  }

  const source = read(ptySurfacePath);
  const oscGuard = "disposables.push(terminal.parser.registerOscHandler(8, () => true));";
  const guardOffset = source.indexOf(oscGuard);
  const outputOffset = source.indexOf("registerOutput(session.id");
  const diagnostics = [];

  if (guardOffset < 0) {
    diagnostics.push(`${ptySurfacePath}: untrusted terminal OSC-8 output must be consumed`);
  }
  if (guardOffset >= 0 && outputOffset >= 0 && guardOffset > outputOffset) {
    diagnostics.push(`${ptySurfacePath}: OSC-8 guard must be registered before PTY output`);
  }
  if (/\blinkHandler\s*:/.test(source)) {
    diagnostics.push(`${ptySurfacePath}: xterm link activation must remain disabled`);
  }

  return diagnostics;
}
