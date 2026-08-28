//! Exact Agent/Broker commands for the Analysis Article domain.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    AnalysisArticleDraftDefinition, AnalysisArticleRecord, AnalysisRunReceipt,
    AuthenticationRequirement, CommandName, CommandSpec,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleProposeArguments {
    pub connection_id: Uuid,
    pub definition: AnalysisArticleDraftDefinition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleUpdateDraftArguments {
    pub article_id: Uuid,
    pub expected_revision: i64,
    pub connection_id: Uuid,
    pub definition: AnalysisArticleDraftDefinition,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleDraftRunArguments {
    pub connection_id: Uuid,
    pub definition: AnalysisArticleDraftDefinition,
    #[serde(default)]
    pub parameter_values: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleRecordResult {
    pub article: AnalysisArticleRecord,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisArticleListResult {
    pub articles: Vec<AnalysisArticleRecord>,
}

pub struct AnalysisArticleProposeCommand;
pub struct AnalysisArticleUpdateDraftCommand;
pub struct AnalysisArticleDraftRunCommand;
pub struct AnalysisArticleListCommand;

macro_rules! analysis_article_command {
    ($command:ty, $arguments:ty, $result:ty, $name:expr) => {
        impl CommandSpec for $command {
            type Arguments = $arguments;
            type Result = $result;

            const NAME: CommandName = $name;
            const AUTHENTICATION: AuthenticationRequirement =
                AuthenticationRequirement::TerminalSession;
        }
    };
}

analysis_article_command!(
    AnalysisArticleProposeCommand,
    AnalysisArticleProposeArguments,
    AnalysisArticleRecordResult,
    CommandName::AnalysisArticlePropose
);
analysis_article_command!(
    AnalysisArticleUpdateDraftCommand,
    AnalysisArticleUpdateDraftArguments,
    AnalysisArticleRecordResult,
    CommandName::AnalysisArticleUpdateDraft
);
analysis_article_command!(
    AnalysisArticleDraftRunCommand,
    AnalysisArticleDraftRunArguments,
    AnalysisRunReceipt,
    CommandName::AnalysisArticleDraftRun
);
analysis_article_command!(
    AnalysisArticleListCommand,
    crate::EmptyArguments,
    AnalysisArticleListResult,
    CommandName::AnalysisArticleList
);
