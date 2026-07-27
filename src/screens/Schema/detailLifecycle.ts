/** Full metadata is an explicit schema-diagram action, never a connection-selection side effect. */
export function schemaDetailsEnabled(requested: boolean, scopeReady: boolean) {
  return requested && scopeReady;
}
