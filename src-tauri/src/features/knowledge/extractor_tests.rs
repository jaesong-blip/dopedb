use super::*;

pub(crate) fn assert_extractor_contract() {
    let source = br#"
      import { query } from "./db";
      export function loadUsers() {
        analytics.track("users_loaded");
        return query("select * from users");
      }
      router.get("/users", loadUsers);
      migrate("create table accounts (id bigint, email text)");
    "#;
    let mut first = Extraction::new();
    extract_file(
        &mut first,
        &"a".repeat(64),
        "src/users.ts",
        source,
        SupportedLanguage::TypeScript,
    )
    .unwrap();
    let mut second = Extraction::new();
    extract_file(
        &mut second,
        &"a".repeat(64),
        "src/users.ts",
        source,
        SupportedLanguage::TypeScript,
    )
    .unwrap();
    assert_eq!(first.nodes, second.nodes);
    assert_eq!(first.edges.len(), second.edges.len());
    assert!(first
        .edges
        .iter()
        .any(|edge| edge.relation == KnowledgeRelation::Defines));
    assert!(first
        .edges
        .iter()
        .any(|edge| edge.relation == KnowledgeRelation::Imports));
    assert!(first
        .edges
        .iter()
        .any(|edge| edge.relation == KnowledgeRelation::Calls));
    assert!(first
        .edges
        .iter()
        .any(|edge| edge.relation == KnowledgeRelation::HandlesRoute));
    assert!(first
        .edges
        .iter()
        .any(|edge| edge.relation == KnowledgeRelation::ReadsTable));
    assert!(first
        .edges
        .iter()
        .any(|edge| edge.relation == KnowledgeRelation::EmitsEvent));
    assert!(first
        .edges
        .iter()
        .any(|edge| edge.relation == KnowledgeRelation::MigrationDefinesTable));
    assert!(first
        .edges
        .iter()
        .any(|edge| edge.relation == KnowledgeRelation::MigrationDefinesColumn));
}
