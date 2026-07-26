use std::path::PathBuf;

use super::domain::TargetPaths;

#[test]
fn target_paths_remain_pure_domain_values() {
    let paths = TargetPaths {
        display_name: "Codex",
        root_path: PathBuf::from("/home/test/.agents/skills"),
        target_path: PathBuf::from("/home/test/.agents/skills/dopedb-cli"),
    };

    assert_eq!(paths.display_name, "Codex");
    assert!(paths.target_path.starts_with(&paths.root_path));
}
