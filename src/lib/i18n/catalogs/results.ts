// grid, results messages are owned by this bounded feature catalogue.
import { defineCatalog } from "../types";

export const resultsCatalog = defineCatalog(
  {
    "grid.filterLabel": "Filter {col}",
    "grid.filterPlaceholder": "filter",
    "grid.resizeHint": "Drag to resize · double-click resets all columns",
    "results.copy": "Copy",
    "results.copyFailed": "Copy failed",
    "results.copyRows": "Copied {count} rows",
    "results.copyTitle": "Copy all rows as tab-separated text (pastes into Excel/Sheets)",
    "results.downloadCsvTitle": "Download as CSV (opens in Excel)",
    "results.downloadJsonTitle": "Download as JSON",
    "results.exportCsv": "Export {scope} (CSV)",
    "results.exportJson": "Export {scope} (JSON)",
  },
  {
    "grid.filterLabel": "{col} 필터",
    "grid.filterPlaceholder": "필터",
    "grid.resizeHint": "드래그해 크기 조절 · 더블 클릭하면 모든 컬럼 초기화",
    "results.copy": "복사",
    "results.copyFailed": "복사 실패",
    "results.copyRows": "{count}행 복사됨",
    "results.copyTitle": "모든 행을 탭으로 구분된 텍스트로 복사 (Excel/Sheets에 붙여넣기)",
    "results.downloadCsvTitle": "CSV로 다운로드 (Excel에서 열기)",
    "results.downloadJsonTitle": "JSON으로 다운로드",
    "results.exportCsv": "{scope} 내보내기 (CSV)",
    "results.exportJson": "{scope} 내보내기 (JSON)",
  },
);
