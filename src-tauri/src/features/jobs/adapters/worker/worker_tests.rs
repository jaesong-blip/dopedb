use crate::error::AppError;

use super::files::validate_output_parent;

#[test]
fn output_parent_must_remain_the_original_canonical_directory() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let actual = root.path().join("actual");
    let alias = root.path().join("alias");
    std::fs::create_dir(&actual).unwrap();
    symlink(&actual, &alias).unwrap();
    let actual = actual.canonicalize().unwrap();
    assert!(validate_output_parent(&actual.join("rows.ndjson")).is_ok());
    assert!(matches!(
        validate_output_parent(&alias.join("rows.ndjson")),
        Err(AppError::Blocked { .. })
    ));
}
