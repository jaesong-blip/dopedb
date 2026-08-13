const rawRequestBodyPattern =
  /\brequest\s*\.\s*(?:json|text|arrayBuffer|blob|formData)\s*\(/;

/**
 * Workspace mutations accept small control-plane envelopes, never arbitrary
 * uploads. Keep their body reads behind boundedJsonBody so Content-Length cannot
 * be trusted and chunked requests cannot allocate without a hard ceiling.
 */
export function collectWorkspaceCloudHttpDiagnostics({ read, relative, walk }) {
  const diagnostics = [];
  const routeFiles = walk("workspace-cloud/app/api/v1/workspaces")
    .map(relative)
    .filter((filePath) => filePath.endsWith("/route.ts"));

  for (const filePath of routeFiles) {
    const source = read(filePath);
    if (rawRequestBodyPattern.test(source)) {
      diagnostics.push(
        `${filePath}: workspace request bodies must use boundedJsonBody instead of a raw Request body reader`,
      );
    }
  }

  return diagnostics;
}
