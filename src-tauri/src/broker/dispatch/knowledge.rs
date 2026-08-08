//! Read-only Project Knowledge tools scoped to one immutable ACP revision set.

use std::collections::BTreeSet;

use dopedb_protocol::{
    EnvironmentConnectionScope, EnvironmentContextCommand, EnvironmentContextResult,
    FunnelTraceArguments, FunnelTraceCommand, GraphBuildArtifactV1, KnowledgeDiffCommand,
    KnowledgeEvidenceCommand, KnowledgeEvidenceResult, KnowledgeExplainCommand,
    KnowledgeNeighborDirection, KnowledgeNeighborsArguments, KnowledgeNeighborsCommand,
    KnowledgeNodeArguments, KnowledgeNodeMatch, KnowledgePathCommand, KnowledgeSearchCommand,
    KnowledgeSearchResult, KnowledgeSubgraphResult, MAX_KNOWLEDGE_EVIDENCE_IDS,
    MAX_KNOWLEDGE_NEIGHBORS, MAX_KNOWLEDGE_QUERY_BYTES, MAX_KNOWLEDGE_RESULTS,
};

use crate::features::knowledge::application::{graph_path, search_graphs};
use crate::features::knowledge::ports::KnowledgeGraphRepositoryPort;

use super::*;

pub(super) async fn handle(
    dispatcher: &BrokerDispatcher,
    request: &RequestEnvelope,
) -> ResponseEnvelope {
    let request_id = request.request_id;
    let session = match dispatcher.authenticate(request, BrokerCapability::KnowledgeRead) {
        Ok(session) => session,
        Err(code) => return failure(request_id, code, false),
    };
    let Some(scope) = session.knowledge_scope.as_ref() else {
        return failure(request_id, ErrorCode::ScopeDenied, false);
    };
    let services = match dispatcher.services() {
        Ok(services) => services,
        Err(code) => return failure(request_id, code, false),
    };
    let graphs = match services
        .knowledge
        .exact_knowledge_session_graphs(scope)
        .await
    {
        Ok(graphs) => graphs,
        Err(error) => return failure(request_id, map_application_error(error), false),
    };

    match request.command {
        CommandName::EnvironmentContext => {
            if decode_arguments::<EnvironmentContextCommand>(request).is_err() {
                return failure(request_id, ErrorCode::InvalidRequest, false);
            }
            respond(
                request_id,
                Ok::<_, ErrorCode>(EnvironmentContextResult {
                    project_environment_id: scope.project_environment_id,
                    environment_revision: scope.environment_revision,
                    connections: scope
                        .connections
                        .iter()
                        .map(|connection| EnvironmentConnectionScope {
                            connection_id: connection.connection_id,
                            connection_revision: connection.connection_revision,
                            role: connection.role.clone(),
                            alias: connection.alias.clone(),
                        })
                        .collect(),
                    graph_revision_ids: scope.graph_revision_ids.clone(),
                }),
            )
        }
        CommandName::KnowledgeSearch => {
            let arguments = match decode_arguments::<KnowledgeSearchCommand>(request) {
                Ok(arguments) if valid_query(&arguments.query, arguments.limit) => arguments,
                _ => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            let result = search_graphs(&graphs, &arguments.query, arguments.limit as usize)
                .map(|result| KnowledgeSearchResult {
                    graph_revision_ids: result.graph_revision_ids,
                    matches: result
                        .matches
                        .into_iter()
                        .map(|value| KnowledgeNodeMatch {
                            graph_revision_id: value.graph_revision_id,
                            node: value.node,
                        })
                        .collect(),
                })
                .map_err(map_application_error);
            respond(request_id, result)
        }
        CommandName::KnowledgeExplain => {
            let arguments = match decode_arguments::<KnowledgeExplainCommand>(request) {
                Ok(arguments) if valid_hash(&arguments.node_id) => arguments,
                _ => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                explain(&graphs, &arguments).ok_or(ErrorCode::InvalidRequest),
            )
        }
        CommandName::KnowledgeNeighbors => {
            let arguments = match decode_arguments::<KnowledgeNeighborsCommand>(request) {
                Ok(arguments)
                    if valid_hash(&arguments.node_id)
                        && arguments.limit > 0
                        && arguments.limit <= MAX_KNOWLEDGE_NEIGHBORS =>
                {
                    arguments
                }
                _ => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                neighbors(&graphs, &arguments).ok_or(ErrorCode::InvalidRequest),
            )
        }
        CommandName::KnowledgePath => {
            let arguments = match decode_arguments::<KnowledgePathCommand>(request) {
                Ok(arguments)
                    if valid_hash(&arguments.from_node_id) && valid_hash(&arguments.to_node_id) =>
                {
                    arguments
                }
                _ => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            let result = graphs
                .iter()
                .find(|graph| {
                    graph
                        .nodes
                        .iter()
                        .any(|node| node.id == arguments.from_node_id)
                        && graph
                            .nodes
                            .iter()
                            .any(|node| node.id == arguments.to_node_id)
                })
                .ok_or(ErrorCode::InvalidRequest)
                .and_then(|graph| {
                    graph_path(graph, &arguments.from_node_id, &arguments.to_node_id)
                        .map(|path| KnowledgeSubgraphResult {
                            graph_revision_ids: vec![path.graph_revision_id],
                            nodes: path.nodes,
                            edges: path.edges,
                            evidence: path.evidence,
                        })
                        .map_err(map_application_error)
                });
            respond(request_id, result)
        }
        CommandName::KnowledgeEvidence => {
            let arguments = match decode_arguments::<KnowledgeEvidenceCommand>(request) {
                Ok(arguments)
                    if !arguments.evidence_ids.is_empty()
                        && arguments.evidence_ids.len() <= MAX_KNOWLEDGE_EVIDENCE_IDS
                        && arguments.evidence_ids.iter().all(|value| valid_hash(value)) =>
                {
                    arguments
                }
                _ => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            let requested = arguments.evidence_ids.into_iter().collect::<BTreeSet<_>>();
            let evidence = graphs
                .iter()
                .flat_map(|graph| graph.evidence.iter())
                .filter(|value| requested.contains(&value.id))
                .cloned()
                .collect::<Vec<_>>();
            respond(
                request_id,
                Ok::<_, ErrorCode>(KnowledgeEvidenceResult {
                    graph_revision_ids: graphs
                        .iter()
                        .map(|graph| graph.graph_revision_id)
                        .collect(),
                    evidence,
                }),
            )
        }
        CommandName::KnowledgeDiff => {
            let arguments = match decode_arguments::<KnowledgeDiffCommand>(request) {
                Ok(arguments)
                    if scope
                        .graph_revision_ids
                        .contains(&arguments.from_graph_revision_id)
                        && scope
                            .graph_revision_ids
                            .contains(&arguments.to_graph_revision_id) =>
                {
                    arguments
                }
                _ => return failure(request_id, ErrorCode::ScopeDenied, false),
            };
            respond(
                request_id,
                services
                    .knowledge
                    .diff(
                        arguments.from_graph_revision_id,
                        arguments.to_graph_revision_id,
                    )
                    .await
                    .map_err(map_application_error),
            )
        }
        CommandName::FunnelTrace => {
            let arguments = match decode_arguments::<FunnelTraceCommand>(request) {
                Ok(arguments) if valid_query(&arguments.query, arguments.limit) => arguments,
                _ => return failure(request_id, ErrorCode::InvalidRequest, false),
            };
            respond(
                request_id,
                funnel_trace(&graphs, &arguments).map_err(map_application_error),
            )
        }
        _ => failure(request_id, ErrorCode::InvalidRequest, false),
    }
}

fn valid_query(query: &str, limit: u32) -> bool {
    !query.trim().is_empty()
        && query.len() <= MAX_KNOWLEDGE_QUERY_BYTES
        && !query.chars().any(char::is_control)
        && limit > 0
        && limit <= MAX_KNOWLEDGE_RESULTS
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn explain(
    graphs: &[GraphBuildArtifactV1],
    arguments: &KnowledgeNodeArguments,
) -> Option<KnowledgeSubgraphResult> {
    neighbors(
        graphs,
        &KnowledgeNeighborsArguments {
            node_id: arguments.node_id.clone(),
            direction: KnowledgeNeighborDirection::Both,
            limit: MAX_KNOWLEDGE_NEIGHBORS,
        },
    )
}

fn neighbors(
    graphs: &[GraphBuildArtifactV1],
    arguments: &KnowledgeNeighborsArguments,
) -> Option<KnowledgeSubgraphResult> {
    let graph = graphs
        .iter()
        .find(|graph| graph.nodes.iter().any(|node| node.id == arguments.node_id))?;
    let edges = graph
        .edges
        .iter()
        .filter(|edge| match arguments.direction {
            KnowledgeNeighborDirection::Incoming => edge.to == arguments.node_id,
            KnowledgeNeighborDirection::Outgoing => edge.from == arguments.node_id,
            KnowledgeNeighborDirection::Both => {
                edge.from == arguments.node_id || edge.to == arguments.node_id
            }
        })
        .take(arguments.limit as usize)
        .cloned()
        .collect::<Vec<_>>();
    let node_ids = edges
        .iter()
        .flat_map(|edge| [edge.from.clone(), edge.to.clone()])
        .chain(std::iter::once(arguments.node_id.clone()))
        .collect::<BTreeSet<_>>();
    Some(subgraph(graph, node_ids, edges))
}

fn funnel_trace(
    graphs: &[GraphBuildArtifactV1],
    arguments: &FunnelTraceArguments,
) -> crate::error::AppResult<KnowledgeSubgraphResult> {
    let matches = search_graphs(graphs, &arguments.query, arguments.limit as usize)?;
    let matched = matches
        .matches
        .iter()
        .map(|value| value.node.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut evidence = Vec::new();
    let mut revisions = Vec::new();
    for graph in graphs {
        let related = graph
            .edges
            .iter()
            .filter(|edge| {
                matched.contains(edge.from.as_str()) || matched.contains(edge.to.as_str())
            })
            .take(MAX_KNOWLEDGE_NEIGHBORS as usize)
            .cloned()
            .collect::<Vec<_>>();
        if related.is_empty()
            && !graph
                .nodes
                .iter()
                .any(|node| matched.contains(node.id.as_str()))
        {
            continue;
        }
        let node_ids = related
            .iter()
            .flat_map(|edge| [edge.from.clone(), edge.to.clone()])
            .chain(matched.iter().map(|value| (*value).to_owned()))
            .collect::<BTreeSet<_>>();
        let part = subgraph(graph, node_ids, related);
        revisions.extend(part.graph_revision_ids);
        nodes.extend(part.nodes);
        edges.extend(part.edges);
        evidence.extend(part.evidence);
    }
    Ok(KnowledgeSubgraphResult {
        graph_revision_ids: revisions,
        nodes,
        edges,
        evidence,
    })
}

fn subgraph(
    graph: &GraphBuildArtifactV1,
    node_ids: BTreeSet<String>,
    edges: Vec<dopedb_protocol::KnowledgeEdgeV1>,
) -> KnowledgeSubgraphResult {
    let evidence_ids = edges
        .iter()
        .flat_map(|edge| edge.evidence_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    KnowledgeSubgraphResult {
        graph_revision_ids: vec![graph.graph_revision_id],
        nodes: graph
            .nodes
            .iter()
            .filter(|node| node_ids.contains(&node.id))
            .cloned()
            .collect(),
        edges,
        evidence: graph
            .evidence
            .iter()
            .filter(|value| evidence_ids.contains(&value.id))
            .cloned()
            .collect(),
    }
}
