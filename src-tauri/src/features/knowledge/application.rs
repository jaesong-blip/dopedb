//! Bounded read models over one immutable Knowledge graph revision.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use dopedb_protocol::{
    GraphBuildArtifactV1, KnowledgeEdgeV1, KnowledgeEvidenceV1, KnowledgeNodeV1,
};
use serde::Serialize;

use crate::error::{AppError, AppResult};

const MAX_SEARCH_RESULTS: usize = 50;
const MAX_PATH_DEPTH: usize = 8;
const MAX_PATH_VISITS: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeSearchResult {
    pub(crate) graph_revision_ids: Vec<uuid::Uuid>,
    pub(crate) matches: Vec<KnowledgeSearchMatch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeSearchMatch {
    pub(crate) graph_revision_id: uuid::Uuid,
    pub(crate) node: KnowledgeNodeV1,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgePathResult {
    pub(crate) graph_revision_id: uuid::Uuid,
    pub(crate) nodes: Vec<KnowledgeNodeV1>,
    pub(crate) edges: Vec<KnowledgeEdgeV1>,
    pub(crate) evidence: Vec<KnowledgeEvidenceV1>,
}

pub(crate) fn search_graphs(
    graphs: &[GraphBuildArtifactV1],
    query: &str,
    limit: usize,
) -> AppResult<KnowledgeSearchResult> {
    let query = query.trim();
    if query.is_empty()
        || query.len() > 512
        || query.chars().any(char::is_control)
        || limit == 0
        || limit > MAX_SEARCH_RESULTS
    {
        return Err(AppError::Config("the Knowledge search is invalid".into()));
    }
    let needle = query.to_lowercase();
    let mut ranked = graphs
        .iter()
        .flat_map(|graph| graph.nodes.iter().map(move |node| (graph, node)))
        .filter_map(|(graph, node)| {
            let name = node.name.to_lowercase();
            let qualified = node.qualified_name.to_lowercase();
            let score = if name == needle {
                0
            } else if name.starts_with(&needle) {
                1
            } else if name.contains(&needle) {
                2
            } else if qualified.contains(&needle) {
                3
            } else if node.attributes.iter().any(|(key, value)| {
                key.to_lowercase().contains(&needle) || value.to_lowercase().contains(&needle)
            }) {
                4
            } else {
                return None;
            };
            Some((
                score,
                node.qualified_name.as_str(),
                graph.graph_revision_id,
                node,
            ))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| (left.0, left.1, left.2).cmp(&(right.0, right.1, right.2)));
    Ok(KnowledgeSearchResult {
        graph_revision_ids: graphs.iter().map(|graph| graph.graph_revision_id).collect(),
        matches: ranked
            .into_iter()
            .take(limit)
            .map(|(_, _, graph_revision_id, node)| KnowledgeSearchMatch {
                graph_revision_id,
                node: node.clone(),
            })
            .collect(),
    })
}

pub(crate) fn graph_path(
    graph: &GraphBuildArtifactV1,
    from_node_id: &str,
    to_node_id: &str,
) -> AppResult<KnowledgePathResult> {
    if from_node_id == to_node_id || from_node_id.len() != 64 || to_node_id.len() != 64 {
        return Err(AppError::Config(
            "Knowledge path requires two distinct node identities".into(),
        ));
    }
    let nodes = graph
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    if !nodes.contains_key(from_node_id) || !nodes.contains_key(to_node_id) {
        return Err(AppError::NotFound("a Knowledge path endpoint".into()));
    }
    let mut adjacency = BTreeMap::<&str, Vec<(&str, &KnowledgeEdgeV1)>>::new();
    for edge in &graph.edges {
        adjacency
            .entry(edge.from.as_str())
            .or_default()
            .push((edge.to.as_str(), edge));
    }
    for values in adjacency.values_mut() {
        values.sort_by(|left, right| left.1.id.cmp(&right.1.id));
    }
    let mut queue = VecDeque::from([(from_node_id, 0_usize)]);
    let mut visited = BTreeSet::from([from_node_id]);
    let mut parent = BTreeMap::<&str, (&str, &KnowledgeEdgeV1)>::new();
    while let Some((current, depth)) = queue.pop_front() {
        if current == to_node_id {
            break;
        }
        if depth >= MAX_PATH_DEPTH || visited.len() >= MAX_PATH_VISITS {
            continue;
        }
        for (next, edge) in adjacency.get(current).into_iter().flatten() {
            if visited.insert(next) {
                parent.insert(next, (current, edge));
                queue.push_back((next, depth + 1));
            }
        }
    }
    if !visited.contains(to_node_id) {
        return Err(AppError::NotFound(
            "a bounded directed Knowledge path".into(),
        ));
    }
    let mut node_ids = vec![to_node_id];
    let mut path_edges = Vec::new();
    let mut cursor = to_node_id;
    while cursor != from_node_id {
        let (previous, edge) = parent
            .get(cursor)
            .copied()
            .ok_or_else(|| AppError::Config("the Knowledge path is incomplete".into()))?;
        path_edges.push(edge.clone());
        node_ids.push(previous);
        cursor = previous;
    }
    node_ids.reverse();
    path_edges.reverse();
    let evidence_ids = path_edges
        .iter()
        .flat_map(|edge| edge.evidence_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    Ok(KnowledgePathResult {
        graph_revision_id: graph.graph_revision_id,
        nodes: node_ids
            .into_iter()
            .filter_map(|id| nodes.get(id).copied().cloned())
            .collect(),
        edges: path_edges,
        evidence: graph
            .evidence
            .iter()
            .filter(|evidence| evidence_ids.contains(&evidence.id))
            .cloned()
            .collect(),
    })
}
