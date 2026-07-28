import React from "react";
import { createRoot } from "react-dom/client";

import "../../../src/design-system/index.css";
import "../../../src/styles.css";
import "../../../src/components/grid.css";
import "../../../src/components/TerminalDock/terminalDock.css";
import "../../../src/features/terminals/ptySurface.css";
import "../../../src/screens/Connections/connections.css";
import "../../../src/screens/Dashboards/dashboards.css";
import "../../../src/screens/Schema/schema.css";
import "../../../src/screens/Settings/settings.css";
import "../../../src/screens/Sql/sql.css";
import "../../../src/screens/Tables/tables.css";
import { skillSetupStyles } from "../../../src/features/skills/styles";
import "./visual-fixture.css";

type Scene =
  | "connections"
  | "sql-terminal"
  | "table-detail"
  | "schema-erd"
  | "dashboard"
  | "settings-auth"
  | "skill-setup"
  | "loading-error";

const scene = (new URLSearchParams(location.search).get("scene") ??
  "connections") as Scene;

const tables = [
  ["users", "table", "42,018"],
  ["accounts", "table", "8,301"],
  ["audit_log_with_a_deliberately_long_name", "table", "1,208,440"],
  ["active_sessions", "view", "—"],
  ["daily_revenue", "view", "—"],
] as const;

function Glyph({ children }: { children: React.ReactNode }) {
  return <span className="vf-glyph" aria-hidden>{children}</span>;
}

function Rail() {
  return (
    <nav className="vf-rail" data-depth="1" aria-label="제품 탐색">
      <div className="vf-window-safe" data-window-safe />
      <div className="vf-brand">D</div>
      {[
        ["▦", "데이터베이스"],
        ["▤", "대시보드"],
        ["◫", "활동"],
      ].map(([icon, label], index) => (
        <button
          key={label}
          type="button"
          data-control
          className={index === 0 ? "active" : ""}
          aria-label={label}
        >
          <Glyph>{icon}</Glyph>
        </button>
      ))}
      <div className="vf-rail-spacer" />
      <button type="button" data-control aria-label="설정">
        <Glyph>⚙</Glyph>
      </button>
      <div className="vf-avatar">JC</div>
    </nav>
  );
}

function Sidebar() {
  return (
    <aside className="vf-sidebar" data-depth="1">
      <div className="vf-window-safe" data-window-safe />
      <header className="vf-sidebar-head">
        <span>워크스페이스</span>
        <button type="button" data-control aria-label="새 연결">＋</button>
      </header>
      <button className="vf-workspace-picker" type="button" data-control>
        개인 워크스페이스 · 로컬 <span>⌄</span>
      </button>
      <div className="vf-tree" data-depth="2">
        <div className="vf-connection active">
          <div className="vf-connection-title">
            <Glyph>◉</Glyph>
            <strong>Prod-mirai</strong>
            <span className="vf-env">PROD</span>
          </div>
          <div className="vf-filter">테이블 필터…</div>
          <div className="vf-section-label">⌄ 테이블 (112)</div>
          {tables.map(([name, kind, count]) => (
            <div className="vf-tree-row" key={name}>
              <Glyph>{kind === "view" ? "◇" : "▦"}</Glyph>
              <span className="vf-ellipsis">{name}</span>
              <small>{count}</small>
            </div>
          ))}
          <div className="vf-section-label">› 함수 (18)</div>
          <div className="vf-section-label">› 시퀀스 (6)</div>
          <div className="vf-section-label">› 트리거 (9)</div>
        </div>
      </div>
      <footer className="vf-account">
        <div className="vf-avatar">JC</div>
        <span className="vf-ellipsis">jaesong@example.com</span>
        <button type="button" data-control aria-label="계정 메뉴">•••</button>
      </footer>
    </aside>
  );
}

function Topbar({ title }: { title: string }) {
  return (
    <>
      <header className="vf-topbar" data-depth="1">
        <div className="vf-db-title">
          <Glyph>◉</Glyph>
          <strong>{title}</strong>
          <span className="vf-env">PROD</span>
          <small>mirai</small>
        </div>
        <div className="vf-top-actions">
          <button type="button" data-control>Agent 열기</button>
          <button type="button" data-control aria-label="작업 로그">◷</button>
        </div>
      </header>
      <nav className="vf-tabs" aria-label="데이터베이스 화면">
        {["데이터", "스키마", "SQL", "대시보드", "활동"].map((tab, index) => (
          <button
            key={tab}
            data-control
            className={
              (scene === "sql-terminal" && tab === "SQL") ||
              (scene === "schema-erd" && tab === "스키마") ||
              (scene === "dashboard" && tab === "대시보드") ||
              (scene !== "sql-terminal" &&
                scene !== "schema-erd" &&
                scene !== "dashboard" &&
                index === 0)
                ? "active"
                : ""
            }
          >
            {tab}
          </button>
        ))}
      </nav>
    </>
  );
}

function DataGridFixture() {
  return (
    <div className="vf-grid-shell" data-depth="2">
      <div className="vf-toolbar">
        <button data-control>＋ 행 추가</button>
        <button data-control disabled>편집</button>
        <button data-control>내보내기</button>
        <span className="vf-toolbar-spacer" />
        <span className="vf-muted">42,018개 행</span>
        <button data-control>↻</button>
      </div>
      <div className="vf-data-grid" role="table">
        <div className="vf-grid-row header" role="row">
          {["id", "name", "email", "status", "created_at"].map((cell) => (
            <div role="columnheader" key={cell}>{cell}</div>
          ))}
        </div>
        {[
          ["1042", "Choi Jaesong", "jaesong@example.com", "active", "2026-07-27 01:12"],
          ["1041", "Mina Park", "mina@example.com", "active", "2026-07-26 22:41"],
          ["1040", "Alex Kim", "alex@example.com", "invited", "2026-07-26 18:03"],
          ["1039", "Yuna Lee", "yuna@example.com", "disabled", "2026-07-26 09:16"],
          ["1038", "Noah Han", "noah@example.com", "active", "2026-07-25 17:52"],
          ["1037", "Sora Jung", "sora@example.com", "active", "2026-07-25 14:21"],
        ].map((row) => (
          <div className="vf-grid-row" role="row" key={row[0]}>
            {row.map((cell) => <div role="cell" key={cell}>{cell}</div>)}
          </div>
        ))}
      </div>
      <footer className="vf-pager">
        <button data-control>‹</button>
        <span>1–100 / 42,018</span>
        <button data-control>›</button>
      </footer>
    </div>
  );
}

function ConnectionsScene() {
  return (
    <div className="vf-empty-state" data-depth="1">
      <div className="vf-empty-icon">⌘</div>
      <h2>데이터베이스를 선택하세요</h2>
      <p>왼쪽 탐색기에서 테이블을 열거나 새 SQL 문서를 시작할 수 있습니다.</p>
      <div className="vf-row">
        <button className="accent" data-control>새 SQL</button>
        <button data-control>연결 추가</button>
      </div>
    </div>
  );
}

function SqlScene() {
  return (
    <div className="vf-sql-layout" data-depth="1">
      <div className="vf-document-tabs">
        <button className="active" data-control>query_users.sql <span>×</span></button>
        <button data-control>＋</button>
      </div>
      <div className="vf-editor">
        <div className="vf-line-numbers">1<br />2<br />3<br />4</div>
        <pre>
          <span className="kw">SELECT</span> id, name, email, status{"\n"}
          <span className="kw">FROM</span> public.users{"\n"}
          <span className="kw">WHERE</span> status = <span className="str">&apos;active&apos;</span>{"\n"}
          <span className="kw">ORDER BY</span> created_at <span className="kw">DESC</span>;
        </pre>
      </div>
      <DataGridFixture />
    </div>
  );
}

function TableScene() {
  return (
    <div className="vf-table-scene" data-depth="1">
      <div className="vf-context-bar">
        <strong>public.users</strong>
        <span className="vf-muted">테이블 · PostgreSQL</span>
      </div>
      <DataGridFixture />
      <aside className="vf-detail-panel" data-depth="2">
        <header><strong>열 정보</strong><button data-control>×</button></header>
        {[
          ["name", "text", "NOT NULL"],
          ["email", "text", "UNIQUE"],
          ["status", "varchar(24)", "DEFAULT active"],
          ["created_at", "timestamptz", "DEFAULT now()"],
        ].map(([name, type, rule]) => (
          <div className="vf-field" key={name}>
            <strong>{name}</strong><span>{type}</span><small>{rule}</small>
          </div>
        ))}
      </aside>
    </div>
  );
}

function ErdScene() {
  const nodes = [
    ["users", "180px", "110px"],
    ["accounts", "520px", "90px"],
    ["sessions", "520px", "360px"],
    ["audit_logs", "860px", "210px"],
  ];
  return (
    <div className="vf-erd" data-depth="1">
      <div className="vf-toolbar floating">
        <button data-control>자동 배치</button>
        <button data-control>관계 추가</button>
        <button data-control>내보내기</button>
        <button data-control>＋</button>
        <button data-control>－</button>
      </div>
      <svg className="vf-edges" aria-hidden>
        <path d="M400 190 C460 190 460 170 520 170" />
        <path d="M640 260 C640 300 640 320 640 360" />
        <path d="M740 170 C810 170 800 290 860 290" />
      </svg>
      {nodes.map(([name, left, top]) => (
        <article className="vf-entity" style={{ left, top }} key={name} data-depth="2">
          <header>{name}<span>▦</span></header>
          <div><b>PK</b> id <small>uuid</small></div>
          <div><b>FK</b> account_id <small>uuid</small></div>
          <div><span />created_at <small>timestamptz</small></div>
        </article>
      ))}
    </div>
  );
}

function DashboardScene() {
  return (
    <div className="vf-dashboard" data-depth="1">
      <div className="vf-metric"><small>활성 사용자</small><strong>42,018</strong><span>+12.4%</span></div>
      <div className="vf-metric"><small>쿼리 성공률</small><strong>99.97%</strong><span>+0.03%</span></div>
      <div className="vf-chart" data-depth="2">
        <header><strong>일별 쿼리 수</strong><button data-control>•••</button></header>
        <svg viewBox="0 0 720 260" role="img" aria-label="일별 쿼리 수">
          <path className="area" d="M0 225 L90 180 L180 194 L270 120 L360 142 L450 74 L540 96 L630 40 L720 62 L720 260 L0 260 Z" />
          <path className="line" d="M0 225 L90 180 L180 194 L270 120 L360 142 L450 74 L540 96 L630 40 L720 62" />
        </svg>
      </div>
      <div className="vf-chart compact" data-depth="2">
        <header><strong>엔진별 연결</strong></header>
        <div className="vf-bars">
          <span style={{ height: "72%" }} />
          <span style={{ height: "46%" }} />
          <span style={{ height: "31%" }} />
          <span style={{ height: "18%" }} />
        </div>
      </div>
    </div>
  );
}

function SettingsScene() {
  return (
    <div className="vf-settings" data-depth="1">
      <nav>
        {["계정", "워크스페이스", "보안", "MCP 서버", "업데이트"].map((item, index) => (
          <button className={index === 1 ? "active" : ""} data-control key={item}>{item}</button>
        ))}
      </nav>
      <section>
        <header><h2>워크스페이스 접근</h2><button className="accent" data-control>사용자 초대</button></header>
        <div className="vf-workspace-card">
          <div><strong>Mirai Engineering</strong><small>3명의 구성원 · 2개의 관리형 연결</small></div>
          <span className="vf-badge">OWNER</span>
        </div>
        <h3>구성원</h3>
        {[
          ["JC", "jaesong@example.com", "소유자"],
          ["MP", "mina@example.com", "읽기·쓰기"],
          ["AK", "alex.long.invited.account@example.com", "읽기 전용"],
        ].map(([initials, email, role]) => (
          <div className="vf-member" key={email}>
            <div className="vf-avatar">{initials}</div>
            <span className="vf-ellipsis">{email}</span>
            <button data-control>{role}⌄</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function SkillSetupScene() {
  return (
    <div className="vf-skill-setup-layout" data-depth="1">
      <nav aria-label="설정 메뉴">
        {["계정", "워크스페이스", "에이전트 도구", "MCP 서버", "업데이트"].map(
          (item) => (
            <button
              className={item === "에이전트 도구" ? "active" : ""}
              data-control
              key={item}
            >
              {item}
            </button>
          ),
        )}
      </nav>
      <div className="vf-skill-setup-frame">
        <div className="settings-title-row">
          <h2>에이전트 도구</h2>
        </div>
        <p className="muted">DopeDB 0.3.8 · 스킬 리비전 7</p>
        <section
          className={skillSetupStyles.panel}
          aria-labelledby="vf-skill-setup-title"
        >
          <header className={skillSetupStyles.panelHead}>
            <div className={skillSetupStyles.panelHeadContent}>
              <span className={skillSetupStyles.kicker}>설정 터미널</span>
              <h3 className={skillSetupStyles.title} id="vf-skill-setup-title">
                DopeDB 스킬 설치 및 업데이트
              </h3>
            </div>
            <button
              type="button"
              className={`btn small icon-only icon-xs ${skillSetupStyles.fixedControl}`}
              aria-label="설정 터미널 닫기"
            >
              ×
            </button>
          </header>
          <p className={`muted ${skillSetupStyles.summary}`}>
            대상: Codex, Claude Code
          </p>
          <div className={skillSetupStyles.command}>
            <code className={skillSetupStyles.commandCode}>
              dopedb skill install --target all
            </code>
            <button
              type="button"
              className={`btn small icon-only ${skillSetupStyles.fixedControl}`}
              aria-label="명령 복사"
            >
              ⧉
            </button>
          </div>
          <p className={skillSetupStyles.safety}>
            <span className={skillSetupStyles.safetyIcon}>
              <Glyph>i</Glyph>
            </span>
            <span>
              연결 없는 터미널에 명령만 입력합니다. Enter를 자동으로
              누르거나 데이터베이스 접근을 제공하지 않습니다.
            </span>
          </p>
          <section
            className={skillSetupStyles.terminal}
            aria-label="DopeDB 스킬 설정 터미널"
          >
            <header className={skillSetupStyles.terminalHead}>
              <p className={skillSetupStyles.terminalHeadText}>
                명령 준비됨 · Enter를 눌러 실행
              </p>
            </header>
            <div
              className={`terminal-surface ${skillSetupStyles.terminalSurface}`}
            >
              <pre className="vf-skill-pty">
                <span>jaesong@local % </span>
                dopedb skill install --target all
                <span className="cursor">▋</span>
              </pre>
            </div>
          </section>
        </section>
      </div>
    </div>
  );
}

function LoadingErrorScene() {
  return (
    <div className="vf-state-matrix" data-depth="1">
      <section><div className="vf-spinner" /><strong>스키마를 불러오는 중</strong><small>연결 상태를 확인하고 있습니다.</small></section>
      <section className="error"><Glyph>!</Glyph><strong>카탈로그를 불러오지 못했습니다.</strong><small>네트워크 연결을 확인한 뒤 다시 시도하세요.</small><button data-control>다시 시도</button></section>
      <section><Glyph>∅</Glyph><strong>검색 결과가 없습니다.</strong><small>필터를 지우거나 다른 스키마를 선택하세요.</small></section>
    </div>
  );
}

function TerminalDockFixture() {
  if (scene !== "sql-terminal") return null;
  return (
    <aside className="vf-terminal" data-depth="1">
      <header>
        <button className="active" data-control>Agent · Prod-mirai</button>
        <button data-control>＋</button>
        <span />
        <button data-control>◷</button>
        <button data-control>×</button>
      </header>
      <div className="vf-terminal-body">
        <span className="prompt">dopedb›</span> 최근 24시간 활성 사용자 수를 보여줘
        <br /><br />
        <span className="answer">✓ 읽기 전용 쿼리 계획 완료 · 42,018 rows</span>
        <br />
        <span className="cursor">▋</span>
      </div>
    </aside>
  );
}

function Scene() {
  switch (scene) {
    case "sql-terminal": return <SqlScene />;
    case "table-detail": return <TableScene />;
    case "schema-erd": return <ErdScene />;
    case "dashboard": return <DashboardScene />;
    case "settings-auth": return <SettingsScene />;
    case "skill-setup": return <SkillSetupScene />;
    case "loading-error": return <LoadingErrorScene />;
    default: return <ConnectionsScene />;
  }
}

function VisualFixture() {
  return (
    <div className="visual-app platform-macos" data-scene={scene} data-depth="0">
      <Rail />
      <Sidebar />
      <main className="vf-main">
        <Topbar title="Prod-mirai" />
        <div className="vf-content"><Scene /></div>
      </main>
      <TerminalDockFixture />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<VisualFixture />);
