const WORKSPACE_LOGIN_REQUEST_EVENT = "dopedb:request-workspace-login";

/** Route contextual sign-in actions through the one shell-owned login lifecycle. */
export function requestWorkspaceLogin() {
  window.dispatchEvent(new Event(WORKSPACE_LOGIN_REQUEST_EVENT));
}

export function onWorkspaceLoginRequested(handler: () => void) {
  window.addEventListener(WORKSPACE_LOGIN_REQUEST_EVENT, handler);
  return () => window.removeEventListener(WORKSPACE_LOGIN_REQUEST_EVENT, handler);
}
