// Small account-menu leaf. The account owner controls dialog lifetime so a scope switch
// can unmount it and discard its reducer-held API key and one-use receipt.
import { Icon } from "../../components/Icon";
import { useI18n } from "../../lib/i18n";

export function ProviderCredentialsMenuItem({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="menuitem"
      className="workspace-account-menu-command"
      onClick={onOpen}
    >
      <Icon name="key" />
      {t("providerCredentials.open")}
    </button>
  );
}
