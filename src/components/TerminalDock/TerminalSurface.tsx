// Adapts a connection-pinned Terminal Dock session to the shared PTY renderer.
import {
  terminalResize,
  terminalWrite,
} from "../../features/terminals/tauriAdapter";
import PtySurface, {
  type PtyOutputWriter,
} from "../../features/terminals/PtySurface";
import type {
  TerminalSessionId,
  TerminalSessionSummary,
} from "../../features/terminals/domain";
import { useI18n } from "../../lib/i18n";

interface TerminalSurfaceProps {
  session: TerminalSessionSummary;
  active: boolean;
  registerOutput: (
    id: TerminalSessionId,
    writer: PtyOutputWriter | null,
  ) => void;
  onError: (message: string) => void;
}

export default function TerminalSurface({
  session,
  active,
  registerOutput,
  onError,
}: TerminalSurfaceProps) {
  const { t } = useI18n();
  return (
    <PtySurface
      session={session}
      active={active}
      registerOutput={registerOutput}
      writeInput={terminalWrite}
      resize={terminalResize}
      onError={onError}
      role="tabpanel"
      id={`terminal-panel-${session.id}`}
      ariaLabelledBy={`terminal-tab-${session.id}`}
      ariaLabel={`${t("terminal.title")} · ${session.name}`}
    />
  );
}
