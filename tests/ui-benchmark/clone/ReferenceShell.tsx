import type { ReferenceCloneScene } from "./scenes";

const tables = ["orders", "customers", "order_items", "monthly_revenue"];
const columns = ["id", "customer", "status", "total", "created_at"];
const rows = [
  ["10482", "Northwind", "paid", "842.10", "2026-07-28 17:54"],
  ["10481", "Orbit Labs", "pending", "129.90", "2026-07-28 17:41"],
  ["10480", "Paper Trail", "paid", "2,410.00", "2026-07-28 17:26"],
  ["10479", "Common Field", "refunded", "78.40", "2026-07-28 16:59"],
  ["10478", "Signal Works", "paid", "612.50", "2026-07-28 16:32"],
];

function Rail() {
  return (
    <nav className="clone-rail" data-region="rail" aria-label="Modes">
      <span className="clone-mark" aria-hidden="true" />
      {["D", "Q", "R"].map((label, index) => (
        <button
          key={label}
          className={index === 0 ? "is-active" : ""}
          aria-label={["Objects", "Queries", "Review"][index]}
        >
          {label}
        </button>
      ))}
      <span className="clone-rail-spacer" />
      <button aria-label="Preferences">P</button>
    </nav>
  );
}

function Explorer({ activeObject }: { activeObject?: string }) {
  return (
    <aside className="clone-explorer" data-region="explorer">
      <header className="clone-panel-head">
        <strong>Data sources</strong>
        <span className="clone-window-actions" aria-hidden="true">＋ ···</span>
      </header>
      <div className="clone-toolbar" aria-label="Object actions">
        <span>＋</span><span>↻</span><span>⌕</span><span>≡</span>
      </div>
      <div className="clone-tree">
        <div className="clone-tree-row depth-0 is-selected">
          <span>⌄</span><strong>analytics</strong><small>online</small>
        </div>
        <div className="clone-tree-row depth-1"><span>⌄</span><span>public</span></div>
        <div className="clone-tree-row depth-2"><span>⌄</span><span>tables</span><small>4</small></div>
        {tables.map((table) => (
          <div
            className={`clone-tree-row depth-3${activeObject === table ? " is-current" : ""}`}
            key={table}
          >
            <span>▦</span><span>{table}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Grid() {
  return (
    <div className="clone-grid" role="table" aria-label="Order rows">
      <div className="clone-grid-row clone-grid-head" role="row">
        {columns.map((column) => <strong role="columnheader" key={column}>{column}</strong>)}
      </div>
      {rows.map((row) => (
        <div className="clone-grid-row" role="row" key={row[0]}>
          {row.map((cell) => <span role="cell" key={cell}>{cell}</span>)}
        </div>
      ))}
    </div>
  );
}

function Workbench({
  scene,
}: {
  scene: ReferenceCloneScene;
}) {
  const consoleScene = scene.id === "query-console";
  const assistantScene = scene.id === "assistant-open";
  return (
    <main className="clone-workbench" data-region="workbench">
      <header className="clone-context">
        <div>
          <small>{scene.eyebrow}</small>
          <strong>{scene.title}</strong>
          <span>{scene.context}</span>
        </div>
        <div className="clone-context-actions" aria-hidden="true">⌁　＋　···</div>
      </header>
      <div className="clone-tabs">
        <span className="is-active">{scene.activeObject ?? scene.title}</span>
        <span>＋</span>
      </div>
      <div className="clone-toolbar clone-workbench-toolbar">
        <span className="clone-run">▶ Run</span>
        <span>Explain</span>
        <span>Format</span>
        <span className="clone-toolbar-spacer" />
        <span>Read only</span>
      </div>
      {consoleScene || assistantScene ? (
        <div className="clone-query-layout">
          <pre className="clone-editor"><code><b>select</b>{"\n  "}date_trunc('month', created_at) month,{"\n  "}sum(total) revenue{"\n"}<b>from</b> orders{"\n"}<b>where</b> status = 'paid'{"\n"}<b>group by</b> 1{"\n"}<b>order by</b> 1;</code></pre>
          <section className="clone-results">
            <div className="clone-result-meta">2 rows · 21 ms · limited to 100</div>
            <Grid />
          </section>
        </div>
      ) : (
        <section className="clone-data-layout">
          <div className="clone-result-meta">5 rows · 18 ms · page 1 of 2048</div>
          <Grid />
        </section>
      )}
    </main>
  );
}

function Assistant() {
  return (
    <aside className="clone-assistant" data-region="assistant">
      <header className="clone-panel-head">
        <strong>Operation review</strong><span aria-hidden="true">×</span>
      </header>
      <div className="clone-assistant-body">
        <p className="clone-kicker">EXACT SCOPE</p>
        <h2>Review one statement</h2>
        <p>The pending action affects rows matched by the visible filter.</p>
        <dl>
          <div><dt>Object</dt><dd>public.orders</dd></div>
          <div><dt>Mode</dt><dd>Write</dd></div>
          <div><dt>Estimate</dt><dd>3 rows</dd></div>
        </dl>
        <pre><code>update orders{"\n"}set status = 'archived'{"\n"}where id in (10479, 10480, 10481);</code></pre>
        <div className="clone-review-actions">
          <button>Reject</button><button className="is-primary">Approve once</button>
        </div>
      </div>
    </aside>
  );
}

function FirstRun() {
  return (
    <div className="clone-first-run">
      <aside className="clone-recents" data-region="explorer">
        <header className="clone-panel-head"><strong>Recent work</strong><span>＋</span></header>
        <div className="clone-recent-card is-selected"><strong>Analytics lab</strong><span>Last opened today</span></div>
        <div className="clone-recent-card"><strong>Local sandbox</strong><span>Opened yesterday</span></div>
      </aside>
      <main className="clone-welcome" data-region="workbench">
        <p className="clone-kicker">START</p>
        <h1>Choose where to begin</h1>
        <p className="clone-welcome-copy">Open existing work or create a focused workspace. Context remains visible while you decide.</p>
        <div className="clone-start-actions">
          <button className="is-primary">New workspace</button>
          <button>Open existing</button>
        </div>
        <div className="clone-learning">
          <strong>Learn the workspace</strong>
          <span>Explore objects</span><span>Run a query</span><span>Review an operation</span>
        </div>
      </main>
    </div>
  );
}

export function ReferenceShell({ scene }: { scene: ReferenceCloneScene }) {
  return (
    <div className={`reference-clone scene-${scene.id}`}>
      <Rail />
      {scene.id === "first-run" ? (
        <FirstRun />
      ) : (
        <>
          <Explorer activeObject={scene.activeObject} />
          <Workbench scene={scene} />
          {scene.id === "assistant-open" && <Assistant />}
        </>
      )}
      <footer className="clone-status" data-region="status">
        <span>local fixture</span><span>UTF-8</span><span>Ln 1, Col 1</span>
      </footer>
    </div>
  );
}
