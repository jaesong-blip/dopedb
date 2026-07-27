//! Deterministic tests for the production ADC/WIF verifier helpers.

use std::fs;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::process::Stdio;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::time::Duration;

use serde_json::json;

use super::gcp_adc::gcp_target::{
    append_bounded, cloud_sql_url, validate_cloud_sql_response, validate_impersonation_url,
};
use super::gcp_adc::{
    audited_gcloud_from_root, command_spec, command_timeout, external_subject_token_guard,
    normalize_command_output, read_adc_document, validate_access_token, validate_adc, AdcSource,
};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::gcp_adc::{read_token_output, GcloudSnapshot};
use crate::features::providers::domain::GcpCloudSqlVerificationTarget;

fn authorized_user() -> serde_json::Value {
    json!({
        "type": "authorized_user",
        "client_id": "client-id",
        "client_secret": "client-secret",
        "refresh_token": "refresh-token"
    })
}

fn safe_wif() -> serde_json::Value {
    let subject_token = std::env::temp_dir().join("subject-token");
    json!({
        "type": "external_account",
        "audience": "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/pool/providers/provider",
        "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
        "token_url": "https://sts.googleapis.com/v1/token",
        "credential_source": {"file": subject_token}
    })
}

#[test]
fn accepts_only_complete_authorized_user_and_safe_wif_documents() {
    assert!(validate_adc(&authorized_user()).is_ok());
    assert!(validate_adc(&safe_wif()).is_ok());
    for value in [
        json!({"type":"authorized_user"}),
        json!({"type":"authorized_user","client_id":"id","client_secret":"secret","refresh_token":"token","private_key":"no"}),
        json!({"type":"service_account","private_key":"no"}),
        json!({"type":"external_account","audience":"//iam.googleapis.com/a","subject_token_type":"urn:ietf:params:oauth:token-type:jwt","token_url":"https://metadata.google.internal/token","credential_source":{"url":"https://metadata.google.internal"}}),
        json!({"type":"external_account","audience":"//iam.googleapis.com/a","subject_token_type":"urn:ietf:params:oauth:token-type:jwt","token_url":"https://sts.googleapis.com/v1/token","credential_source":{"executable":{}}}),
    ] {
        assert!(validate_adc(&value).is_err());
    }
}

#[test]
fn token_must_be_a_single_non_whitespace_ascii_bearer() {
    assert!(validate_access_token(b"opaque-token_123").is_ok());
    for token in [b"\n".as_slice(), b"token\n", b"token value", b"token\t"] {
        assert!(validate_access_token(token).is_err());
    }
}

#[test]
fn command_output_accepts_one_terminal_newline_and_rejects_all_other_whitespace() {
    for token in [b"opaque-token\n".as_slice(), b"opaque-token\r\n"] {
        assert_eq!(
            &*normalize_command_output(true, token.to_vec().into()).unwrap(),
            b"opaque-token"
        );
    }
    for token in [
        b"\n".as_slice(),
        b"opaque-token\n\n",
        b"opaque-token\r\n\r\n",
        b" opaque-token\n",
        b"opaque token\n",
        b"opaque-token\r",
    ] {
        assert!(normalize_command_output(true, token.to_vec().into()).is_err());
    }
}

#[test]
fn process_result_seam_rejects_timeout_equivalent_nonzero_and_oversized_output() {
    assert_eq!(command_timeout().as_secs(), 10);
    assert!(normalize_command_output(false, b"opaque-token".to_vec().into()).is_err());
    assert!(normalize_command_output(true, vec![b'x'; 64 * 1024 + 1].into()).is_err());
}

#[test]
fn gcp_target_proof_requires_the_exact_target_and_a_runnable_supported_engine() {
    let target = GcpCloudSqlVerificationTarget {
        project_id: "sample-project-123".into(),
        instance_id: "instance-one".into(),
    };
    assert!(validate_cloud_sql_response(&target, br#"{"project":"sample-project-123","name":"instance-one","state":"RUNNABLE","databaseVersion":"POSTGRES_16"}"#).is_ok());
    for body in [
        br#"{"project":"other-project","name":"instance-one","state":"RUNNABLE","databaseVersion":"POSTGRES_16"}"#.as_slice(),
        br#"{"project":"sample-project-123","name":"instance-one","state":"PENDING_CREATE","databaseVersion":"POSTGRES_16"}"#,
        br#"{"project":"sample-project-123","name":"instance-one","state":"RUNNABLE","databaseVersion":"SQLSERVER_2022"}"#,
    ] {
        assert!(validate_cloud_sql_response(&target, body).is_err());
    }
}

#[test]
fn cloud_sql_target_uses_stable_v1_and_stream_cap_rejects_unknown_length_overflow() {
    let target = GcpCloudSqlVerificationTarget {
        project_id: "sample-project-123".into(),
        instance_id: "instance-one".into(),
    };
    assert_eq!(
        cloud_sql_url(&target).unwrap().as_str(),
        "https://sqladmin.googleapis.com/v1/projects/sample-project-123/instances/instance-one",
    );
    let mut body = Vec::new();
    append_bounded(&mut body, &vec![b'x'; 64 * 1024]).unwrap();
    assert!(append_bounded(&mut body, b"x").is_err());
}

#[test]
fn wif_audience_is_not_hosted_target_authority_and_subject_file_is_rechecked() {
    let directory = tempfile::tempdir().unwrap();
    let subject = directory.path().join("subject-token");
    fs::write(&subject, b"local-subject-token").unwrap();
    let mut document = safe_wif();
    document["audience"] = json!(
        "//iam.googleapis.com/projects/999999/locations/global/workloadIdentityPools/unrelated/providers/local"
    );
    document["credential_source"] = json!({"file": subject});
    assert!(validate_adc(&document).is_ok());
    let guard = external_subject_token_guard(&document).unwrap().unwrap();
    assert!(guard.recheck().is_ok());
    fs::write(
        directory.path().join("subject-token"),
        b"rotated-subject-token",
    )
    .unwrap();
    assert!(guard.recheck().is_err());
}

#[test]
fn rejects_unsafe_external_sources_and_requires_exact_impersonation_url() {
    for source in [
        json!({"url":"https://sts.googleapis.com/v1/token"}),
        json!({"executable":{"command":"not-run"}}),
        json!({"environment_id":"aws1"}),
    ] {
        let value = json!({
            "type":"external_account", "audience":"//iam.googleapis.com/projects/1",
            "subject_token_type":"urn:ietf:params:oauth:token-type:jwt", "token_url":"https://sts.googleapis.com/v1/token", "credential_source":source
        });
        assert!(validate_adc(&value).is_err());
    }
    for value in [
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/valid-sa@project.iam.gserviceaccount.com:generateAccessToken",
        "https://iamcredentials.googleapis.com:443/v1/projects/-/serviceAccounts/valid-sa@project.iam.gserviceaccount.com:generateAccessToken",
    ] {
        assert!(validate_impersonation_url(&json!(value)).is_ok());
    }
    for value in [
        "https://iamcredentials.googleapis.com/v1/projects/x/serviceAccounts/a@project.iam.gserviceaccount.com:generateAccessToken",
        "https://user@iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/a@project.iam.gserviceaccount.com:generateAccessToken",
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/a@project.iam.gserviceaccount.com:generateAccessToken?x=1",
        "https://iamcredentials.googleapis.com:444/v1/projects/-/serviceAccounts/valid-sa@project.iam.gserviceaccount.com:generateAccessToken",
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/@project.iam.gserviceaccount.com:generateAccessToken",
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/UPPER@project.iam.gserviceaccount.com:generateAccessToken",
    ] {
        assert!(validate_impersonation_url(&json!(value)).is_err());
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn private_snapshot_never_gives_gcloud_the_original_adc_or_subject_path() {
    let directory = tempfile::tempdir().unwrap();
    let inputs = directory.path().join("inputs");
    fs::create_dir_all(&inputs).unwrap();
    let subject = inputs.join("subject-token");
    fs::write(&subject, b"original-subject-token").unwrap();
    let mut document = safe_wif();
    document["credential_source"] = json!({"file": subject});
    let adc = inputs.join("adc.json");
    fs::write(&adc, document.to_string()).unwrap();
    #[cfg(unix)]
    let adc_via_parent_link = {
        let link = directory.path().join("linked-inputs");
        std::os::unix::fs::symlink(&inputs, &link).unwrap();
        link.join("adc.json")
    };
    #[cfg(not(unix))]
    let adc_via_parent_link = adc.clone();
    let parsed = read_adc_document(&adc_via_parent_link).unwrap();
    let guard = external_subject_token_guard(&parsed).unwrap().unwrap();
    let snapshot =
        GcloudSnapshot::materialize(&adc_via_parent_link, &parsed, Some(&guard)).unwrap();
    let snapshot_path = snapshot.adc_path().to_path_buf();
    let snapshot_text = fs::read_to_string(&snapshot_path).unwrap();
    assert!(!snapshot_text.contains(inputs.to_string_lossy().as_ref()));
    assert!(!snapshot_text.contains("original-subject-token"));
    fs::write(&adc, authorized_user().to_string()).unwrap();
    fs::write(&subject, b"replacement-subject-token").unwrap();
    let root = directory.path().join("google-cloud-sdk");
    fs::create_dir_all(root.join("bin")).unwrap();
    let executable = root.join("bin/gcloud");
    fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            fs::metadata(snapshot.config_directory())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&snapshot_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let spec = command_spec(
        executable,
        AdcSource {
            path: snapshot_path.clone(),
            config_directory: snapshot.config_directory().to_path_buf(),
        },
    )
    .unwrap();
    assert!(spec
        .env
        .iter()
        .all(|(_, value)| !value.contains(inputs.to_string_lossy().as_ref())));

    // A caller can replace and later restore the selected pathname, but the
    // fixed child command retains only the already-owned snapshot name.
    let parked = inputs.join("adc.parked");
    fs::rename(&adc, &parked).unwrap();
    fs::write(&adc, authorized_user().to_string()).unwrap();
    fs::remove_file(&adc).unwrap();
    fs::rename(&parked, &adc).unwrap();
    assert!(spec
        .env
        .iter()
        .all(|(_, value)| !value.contains(adc.to_string_lossy().as_ref())));
    drop(snapshot);
    assert!(!snapshot_path.exists());
}

#[test]
fn command_spec_exposes_only_verified_adc_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("google-cloud-sdk");
    fs::create_dir_all(root.join("bin")).unwrap();
    let executable = root.join("bin/gcloud");
    fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let spec = command_spec(
        executable,
        AdcSource {
            path: directory
                .path()
                .join("application_default_credentials.json"),
            config_directory: directory.path().to_path_buf(),
        },
    )
    .unwrap();
    assert_eq!(
        spec.env
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>(),
        vec![
            "PATH",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "CLOUDSDK_CONFIG",
            "CLOUDSDK_CORE_DISABLE_PROMPTS",
            "CLOUDSDK_CORE_DISABLE_USAGE_REPORTING",
            "CLOUDSDK_CORE_LOG_HTTP",
        ]
    );
    assert!(!spec.env.iter().any(|(key, _)| key == "HOME"));
    for (key, value) in [
        ("CLOUDSDK_CORE_DISABLE_PROMPTS", "1"),
        ("CLOUDSDK_CORE_DISABLE_USAGE_REPORTING", "true"),
        ("CLOUDSDK_CORE_LOG_HTTP", "false"),
    ] {
        assert!(spec
            .env
            .iter()
            .any(|(actual_key, actual_value)| actual_key == key && actual_value == value));
    }
    assert!(!spec
        .env
        .iter()
        .any(|(key, _)| key.contains("DATABASE") || key.contains("SIGNING")));
    assert_eq!(spec.windows_no_window, cfg!(windows));
    assert_eq!(spec.unix_process_group, cfg!(unix));
}

#[test]
fn gcloud_must_live_under_an_audited_sdk_root_not_path() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("google-cloud-sdk");
    fs::create_dir_all(root.join("bin")).unwrap();
    let executable = root.join("bin/gcloud");
    fs::write(&executable, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert_eq!(
        audited_gcloud_from_root(&root).unwrap(),
        executable.canonicalize().unwrap()
    );
    let hijack = directory.path().join("gcloud");
    fs::write(&hijack, b"#!/bin/sh\nexit 0\n").unwrap();
    assert!(audited_gcloud_from_root(directory.path()).is_err());
}

#[test]
fn bounded_reader_rejects_symlink_and_oversized_adc() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("adc.json");
    fs::write(&path, authorized_user().to_string()).unwrap();
    assert!(read_adc_document(&path).is_ok());
    fs::write(&path, vec![b'x'; 64 * 1024 + 1]).unwrap();
    assert!(read_adc_document(&path).is_err());

    #[cfg(unix)]
    {
        let link = directory.path().join("adc-link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(read_adc_document(&link).is_err());
    }
}

#[test]
fn subject_token_guard_rejects_control_bytes_and_oversized_source() {
    let directory = tempfile::tempdir().unwrap();
    let subject = directory.path().join("subject-token");
    let mut document = safe_wif();
    document["credential_source"] = json!({"file": subject});
    fs::write(&subject, b"bad\0subject").unwrap();
    assert!(external_subject_token_guard(&document).is_err());
    fs::write(&subject, vec![b'x'; 64 * 1024 + 1]).unwrap();
    assert!(external_subject_token_guard(&document).is_err());
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn snapshot_cleanup_wipes_nested_gcloud_artifacts_without_following_links() {
    let directory = tempfile::tempdir().unwrap();
    let adc = directory.path().join("adc.json");
    let document = authorized_user();
    fs::write(&adc, document.to_string()).unwrap();
    let mut snapshot = GcloudSnapshot::materialize(&adc, &document, None).unwrap();
    let root = snapshot.config_directory().to_path_buf();
    let nested = root.join("logs/2026/session/cache");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("artifact.sqlite"), b"owned-artifact").unwrap();
    let outside = directory.path().join("outside-target");
    fs::write(&outside, b"outside-must-survive").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("logs/outside-link")).unwrap();

    snapshot.cleanup().unwrap();

    assert_eq!(fs::read(&outside).unwrap(), b"outside-must-survive");
    assert!(!root.exists());
    drop(snapshot);
    assert!(!root.exists());
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn descriptor_cleanup_rejects_nested_directory_swap_without_touching_outside() {
    let directory = tempfile::tempdir().unwrap();
    let adc = directory.path().join("adc.json");
    let document = authorized_user();
    fs::write(&adc, document.to_string()).unwrap();
    let mut snapshot = GcloudSnapshot::materialize(&adc, &document, None).unwrap();
    let root = snapshot.config_directory().to_path_buf();
    fs::create_dir(root.join("nested")).unwrap();
    fs::write(root.join("nested/owned"), b"owned").unwrap();
    let outside = directory.path().join("outside-directory");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("must-survive"), b"outside").unwrap();
    let parked = root.join("nested.parked");
    let mut swapped = false;

    assert!(snapshot
        .cleanup_with_swap_hook(|name| {
            if !swapped && name.to_bytes() == b"nested" {
                fs::rename(root.join("nested"), &parked).unwrap();
                std::os::unix::fs::symlink(&outside, root.join("nested")).unwrap();
                swapped = true;
            }
        })
        .is_err());
    assert!(swapped);
    assert_eq!(fs::read(outside.join("must-survive")).unwrap(), b"outside");

    // Remove the adversarial link and prove a second descriptor walk can
    // finish the original owned tree without reopening an outside pathname.
    fs::remove_file(root.join("nested")).unwrap();
    fs::rename(parked, root.join("nested")).unwrap();
    snapshot.cleanup().unwrap();
    drop(snapshot);
    assert_eq!(fs::read(outside.join("must-survive")).unwrap(), b"outside");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn descriptor_cleanup_rejects_regular_symlink_and_hardlink_swaps() {
    let directory = tempfile::tempdir().unwrap();
    let adc = directory.path().join("adc.json");
    let document = authorized_user();
    fs::write(&adc, document.to_string()).unwrap();
    let mut snapshot = GcloudSnapshot::materialize(&adc, &document, None).unwrap();
    let root = snapshot.config_directory().to_path_buf();
    let outside = directory.path().join("outside-regular");
    fs::write(&outside, b"outside").unwrap();

    fs::write(root.join("swap-symlink"), b"owned").unwrap();
    let parked = root.join("swap-symlink.parked");
    let mut symlink_swapped = false;
    assert!(snapshot
        .cleanup_with_swap_hook(|name| {
            if !symlink_swapped && name.to_bytes() == b"swap-symlink" {
                fs::rename(root.join("swap-symlink"), &parked).unwrap();
                std::os::unix::fs::symlink(&outside, root.join("swap-symlink")).unwrap();
                symlink_swapped = true;
            }
        })
        .is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    fs::remove_file(root.join("swap-symlink")).unwrap();
    fs::rename(parked, root.join("swap-symlink")).unwrap();
    snapshot.cleanup().unwrap();

    let mut snapshot = GcloudSnapshot::materialize(&adc, &document, None).unwrap();
    let root = snapshot.config_directory().to_path_buf();
    fs::write(root.join("swap-hardlink"), b"owned").unwrap();
    let parked = root.join("swap-hardlink.parked");
    let mut hardlink_swapped = false;
    assert!(snapshot
        .cleanup_with_swap_hook(|name| {
            if !hardlink_swapped && name.to_bytes() == b"swap-hardlink" {
                fs::rename(root.join("swap-hardlink"), &parked).unwrap();
                fs::hard_link(&outside, root.join("swap-hardlink")).unwrap();
                hardlink_swapped = true;
            }
        })
        .is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    fs::remove_file(root.join("swap-hardlink")).unwrap();
    fs::rename(parked, root.join("swap-hardlink")).unwrap();
    snapshot.cleanup().unwrap();
    drop(snapshot);
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[tokio::test]
async fn child_is_reaped_before_snapshot_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let adc = directory.path().join("adc.json");
    let document = authorized_user();
    fs::write(&adc, document.to_string()).unwrap();
    let mut snapshot = GcloudSnapshot::materialize(&adc, &document, None).unwrap();
    let snapshot_root = snapshot.config_directory().to_path_buf();

    let mut child = tokio::process::Command::new("/bin/sh")
        .args(["-c", "printf fixture-token; exec sleep 0.02"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0)
        .spawn()
        .unwrap();
    assert_eq!(
        unsafe { libc::getpgid(child.id().unwrap() as libc::pid_t) },
        child.id().unwrap() as libc::pid_t
    );
    let token = read_token_output(&mut child).await;
    assert!(
        token.is_ok() || matches!(token, Err(crate::error::AppError::Blocked { .. })),
        "group permission/liveness failure must be a generic denial"
    );
    snapshot.cleanup().unwrap();
    assert!(
        !snapshot_root.exists(),
        "rejected child cannot strand ADC state"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn process_group_descendant_holding_snapshot_fd_is_killed_before_cleanup() {
    // Repeat the leader-exit/descendant race enough times to exercise Darwin's
    // zombie-PGID window. Each iteration must prove ESRCH after reaping before
    // the snapshot can be removed.
    for _ in 0..20 {
        let directory = tempfile::tempdir().unwrap();
        let adc = directory.path().join("adc.json");
        let document = authorized_user();
        fs::write(&adc, document.to_string()).unwrap();
        let mut snapshot = GcloudSnapshot::materialize(&adc, &document, None).unwrap();
        let snapshot_root = snapshot.config_directory().to_path_buf();
        let marker = directory.path().join("descendant-survived");

        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args([
                "-c",
                "exec 3<\"$1\"; (exec >/dev/null 2>&1; sleep 1; : <&3; touch \"$2\") & printf fixture-token",
                "sh",
                snapshot.adc_path().to_str().unwrap(),
                marker.to_str().unwrap(),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let result = read_token_output(&mut child).await;
        snapshot.cleanup().unwrap();
        assert!(
            !snapshot_root.exists(),
            "even a denied group fence must wipe and unlink the snapshot"
        );
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        if result.is_ok() {
            assert!(!marker.exists(), "descendant retained the snapshot FD");
        } else {
            assert!(matches!(
                result,
                Err(crate::error::AppError::Blocked { .. })
            ));
        }
    }
}

#[cfg(unix)]
#[test]
fn std_tempdir_fallback_does_not_follow_an_internal_symlink() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    fs::write(outside.path(), b"outside-must-survive").unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.path().join("link")).unwrap();
    directory.close().unwrap();
    assert_eq!(fs::read(outside.path()).unwrap(), b"outside-must-survive");
}
