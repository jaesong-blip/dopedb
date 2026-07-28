// 제품 진입점과 UI 검수 하네스가 같은 provider 조합과 전역 CSS를 공유하는 경계다.
// 하네스가 provider를 따로 구현하면 정본이 둘로 갈라지므로 여기만 수정한다.
// StrictMode는 dev 전용 진단 wrapper라 provider가 아니며 각 진입점이 소유한다.
import type { ReactNode } from "react";
import { I18nProvider } from "./i18n";
import { QueryProvider } from "./queryClient";
import "../design-system/index.css";
import "../styles.css";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <I18nProvider>{children}</I18nProvider>
    </QueryProvider>
  );
}
