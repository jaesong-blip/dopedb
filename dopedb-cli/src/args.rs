use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "dopedb",
    version,
    about = "Use the running DopeDB Desktop runtime"
)]
pub(crate) struct Cli {
    #[command(subcommand)]
    pub(crate) command: Command,
}

#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// Show CLI and Desktop runtime protocol versions.
    Version(OutputArguments),
    /// Check whether the Desktop runtime is available.
    Status(OutputArguments),
    /// Generate a shell completion script without contacting the Desktop runtime.
    Completion {
        #[arg(value_enum)]
        shell: clap_complete::Shell,
    },
    /// Open or focus the DopeDB Desktop app.
    App(AppArguments),
    /// Read the version-matched embedded Skill guide.
    Skills(SkillsArguments),
    /// Inspect or manage the DopeDB Skill installation.
    Skill(SkillArguments),
    /// Inspect and test connection metadata in the active Terminal scope.
    Connection(ConnectionArguments),
    /// Load the canonical database catalog.
    Catalog(CatalogArguments),
    /// List database schemas or namespaces.
    Schema(SchemaArguments),
    /// Inspect one exact table or view.
    Table(TableArguments),
    /// Run one typed, read-only MongoDB document operation.
    Document(DocumentArguments),
    /// Plan, execute, or cancel a read-only query.
    Query(QueryArguments),
    /// Save an exact successful query run as a dashboard.
    Dashboard(DashboardArguments),
    /// Create an exact SQL operation proposal. This never approves it.
    Sql(SqlArguments),
    /// Inspect, wait for, or cancel a Terminal-owned operation.
    Operation(OperationArguments),
}

#[derive(Debug, Args)]
pub(crate) struct AppArguments {
    #[command(subcommand)]
    pub(crate) command: AppCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum AppCommand {
    /// Focus the running Desktop app.
    Open {
        /// Wait until the Desktop window reports that it is ready.
        #[arg(long)]
        wait: bool,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct SkillsArguments {
    #[command(subcommand)]
    pub(crate) command: SkillsCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum SkillsCommand {
    /// List Skill guides embedded in this CLI.
    List(OutputArguments),
    /// Print one version-matched guide without contacting Desktop.
    Get {
        name: String,
        /// Include the reference documents after the main guide.
        #[arg(long)]
        full: bool,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct SkillArguments {
    #[command(subcommand)]
    pub(crate) command: SkillCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum SkillCommand {
    /// Inspect the bounded installation inventory.
    Status {
        #[arg(long, value_enum)]
        target: SkillTargetArgument,
        #[command(flatten)]
        output: OutputArguments,
    },
    /// Install or update only a missing or known managed snapshot.
    Install {
        #[arg(long, value_enum)]
        target: SkillTargetArgument,
        #[command(flatten)]
        output: OutputArguments,
    },
    /// Back up a conflict and explicitly replace it with the current stub.
    Repair {
        #[arg(long, value_enum)]
        target: SkillTargetArgument,
        #[command(flatten)]
        output: OutputArguments,
    },
    /// Remove only an exact known managed snapshot.
    Remove {
        #[arg(long, value_enum)]
        target: SkillTargetArgument,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum SkillTargetArgument {
    All,
    Codex,
    ClaudeCode,
}

impl From<SkillTargetArgument> for dopedb_protocol::SkillTargetSelection {
    fn from(value: SkillTargetArgument) -> Self {
        match value {
            SkillTargetArgument::All => Self::All,
            SkillTargetArgument::Codex => Self::Codex,
            SkillTargetArgument::ClaudeCode => Self::ClaudeCode,
        }
    }
}

#[derive(Debug, Clone, Copy, Args)]
pub(crate) struct OutputArguments {
    /// Emit stable machine-readable JSON on stdout.
    #[arg(long)]
    pub(crate) json: bool,
}

#[derive(Debug, Args)]
pub(crate) struct ConnectionArguments {
    #[command(subcommand)]
    pub(crate) command: ConnectionCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum ConnectionCommand {
    /// List secret-free connection summaries.
    List(OutputArguments),
    /// Show one exact connection summary.
    Show {
        selector: String,
        #[command(flatten)]
        output: OutputArguments,
    },
    /// Test the pinned connection without printing credentials.
    Test {
        selector: String,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct CatalogArguments {
    #[command(subcommand)]
    pub(crate) command: CatalogCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum CatalogCommand {
    Show {
        #[arg(long)]
        connection: String,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct SchemaArguments {
    #[command(subcommand)]
    pub(crate) command: SchemaCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum SchemaCommand {
    List {
        #[arg(long)]
        connection: String,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct TableArguments {
    #[command(subcommand)]
    pub(crate) command: TableCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum TableCommand {
    Describe {
        table: String,
        #[arg(long)]
        connection: String,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct DocumentArguments {
    #[command(subcommand)]
    pub(crate) command: DocumentCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum DocumentCommand {
    /// Run one typed find, aggregate, or count request read from stdin as JSON.
    Run {
        #[arg(long)]
        connection: String,
        #[arg(long, value_name = "-")]
        file: String,
        #[arg(long)]
        max_rows: Option<u64>,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct QueryArguments {
    #[command(subcommand)]
    pub(crate) command: QueryCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum QueryCommand {
    /// Plan exactly one read-only SQL statement.
    Plan {
        #[arg(long)]
        connection: String,
        /// Read SQL from stdin. The first release accepts only `--file -`.
        #[arg(long, value_name = "-")]
        file: String,
        #[arg(long)]
        max_rows: Option<u64>,
        #[command(flatten)]
        output: OutputArguments,
    },
    /// Consume an exact single-use plan.
    Run {
        #[arg(long)]
        plan: String,
        #[command(flatten)]
        output: OutputArguments,
    },
    /// Cancel one Terminal-owned query operation.
    Cancel {
        operation_id: String,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct DashboardArguments {
    #[command(subcommand)]
    pub(crate) command: DashboardCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum DashboardCommand {
    /// Save one successful query run from this Terminal session.
    Create {
        #[arg(long)]
        query_run: String,
        #[arg(long)]
        title: String,
        #[arg(long, default_value = "")]
        description: String,
        #[arg(long, value_enum, default_value = "auto")]
        kind: DashboardKindArgument,
        #[arg(long)]
        x_column: Option<String>,
        #[arg(long)]
        y_column: Vec<String>,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum DashboardKindArgument {
    Auto,
    Metric,
    Line,
    Bar,
    Table,
}

impl From<DashboardKindArgument> for dopedb_protocol::DashboardKind {
    fn from(value: DashboardKindArgument) -> Self {
        match value {
            DashboardKindArgument::Auto => Self::Auto,
            DashboardKindArgument::Metric => Self::Metric,
            DashboardKindArgument::Line => Self::Line,
            DashboardKindArgument::Bar => Self::Bar,
            DashboardKindArgument::Table => Self::Table,
        }
    }
}

#[derive(Debug, Args)]
pub(crate) struct SqlArguments {
    #[command(subcommand)]
    pub(crate) command: SqlCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum SqlCommand {
    /// Create an immutable proposal. There is deliberately no approve command.
    Propose {
        #[arg(long)]
        connection: String,
        /// Read SQL from stdin. The first release accepts only `--file -`.
        #[arg(long, value_name = "-")]
        file: String,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[derive(Debug, Args)]
pub(crate) struct OperationArguments {
    #[command(subcommand)]
    pub(crate) command: OperationCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum OperationCommand {
    Show {
        operation_id: String,
        #[command(flatten)]
        output: OutputArguments,
    },
    Wait {
        operation_id: String,
        #[arg(long, default_value_t = 30_000)]
        timeout_ms: u64,
        #[command(flatten)]
        output: OutputArguments,
    },
    Cancel {
        operation_id: String,
        #[command(flatten)]
        output: OutputArguments,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_flag_belongs_to_the_selected_command() {
        let parsed = Cli::try_parse_from(["dopedb", "status", "--json"]).unwrap();
        assert!(matches!(
            parsed.command,
            Command::Status(OutputArguments { json: true })
        ));
    }

    #[test]
    fn query_plan_keeps_sql_out_of_argv() {
        let parsed = Cli::try_parse_from([
            "dopedb",
            "query",
            "plan",
            "--connection",
            "current",
            "--file",
            "-",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            parsed.command,
            Command::Query(QueryArguments {
                command: QueryCommand::Plan {
                    file,
                    output: OutputArguments { json: true },
                    ..
                }
            }) if file == "-"
        ));
    }

    #[test]
    fn document_query_keeps_typed_request_out_of_argv() {
        let parsed = Cli::try_parse_from([
            "dopedb",
            "document",
            "run",
            "--connection",
            "current",
            "--file",
            "-",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            parsed.command,
            Command::Document(DocumentArguments {
                command: DocumentCommand::Run {
                    file,
                    output: OutputArguments { json: true },
                    ..
                }
            }) if file == "-"
        ));
    }

    #[test]
    fn dashboard_creation_accepts_only_query_run_provenance() {
        let parsed = Cli::try_parse_from([
            "dopedb",
            "dashboard",
            "create",
            "--query-run",
            "018f1111-2222-7333-8444-555566667777",
            "--title",
            "Users",
            "--kind",
            "table",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            parsed.command,
            Command::Dashboard(DashboardArguments {
                command: DashboardCommand::Create {
                    query_run,
                    kind: DashboardKindArgument::Table,
                    output: OutputArguments { json: true },
                    ..
                }
            }) if query_run == "018f1111-2222-7333-8444-555566667777"
        ));
        assert!(Cli::try_parse_from([
            "dopedb",
            "dashboard",
            "create",
            "--connection",
            "current",
            "--query-run",
            "018f1111-2222-7333-8444-555566667777",
            "--title",
            "Users",
        ])
        .is_err());
    }

    #[test]
    fn skill_targets_use_explicit_stable_names() {
        let parsed = Cli::try_parse_from([
            "dopedb",
            "skill",
            "status",
            "--target",
            "claude-code",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            parsed.command,
            Command::Skill(SkillArguments {
                command: SkillCommand::Status {
                    target: SkillTargetArgument::ClaudeCode,
                    output: OutputArguments { json: true },
                },
            })
        ));
    }

    #[test]
    fn embedded_skill_get_does_not_require_runtime_arguments() {
        let parsed =
            Cli::try_parse_from(["dopedb", "skills", "get", "dopedb-cli", "--full"]).unwrap();
        assert!(matches!(
            parsed.command,
            Command::Skills(SkillsArguments {
                command: SkillsCommand::Get {
                    name,
                    full: true,
                    output: OutputArguments { json: false },
                },
            }) if name == "dopedb-cli"
        ));
    }

    #[test]
    fn app_open_accepts_wait_and_json() {
        let parsed = Cli::try_parse_from(["dopedb", "app", "open", "--wait", "--json"]).unwrap();
        assert!(matches!(
            parsed.command,
            Command::App(AppArguments {
                command: AppCommand::Open {
                    wait: true,
                    output: OutputArguments { json: true }
                }
            })
        ));
    }

    #[test]
    fn completion_accepts_every_supported_shell_without_runtime_arguments() {
        for shell in ["bash", "elvish", "fish", "powershell", "zsh"] {
            let parsed = Cli::try_parse_from(["dopedb", "completion", shell]).unwrap();
            assert!(matches!(parsed.command, Command::Completion { .. }));
        }
    }

    #[test]
    fn unknown_arguments_fail_with_usage_status() {
        let error = Cli::try_parse_from(["dopedb", "status", "--token", "secret"]).unwrap_err();
        assert_eq!(error.exit_code(), 2);
    }

    #[test]
    fn no_approval_command_exists() {
        assert!(Cli::try_parse_from([
            "dopedb",
            "operation",
            "approve",
            "018f1111-2222-7333-8444-555566667777"
        ])
        .is_err());
    }
}
