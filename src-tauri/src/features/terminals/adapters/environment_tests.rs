use super::*;

#[test]
fn terminal_path_puts_the_bundled_cli_first_without_duplicates() {
    let directory = std::env::temp_dir().join("dopedb-cli-fixture");
    let path = terminal_path(&directory).unwrap();
    let paths = std::env::split_paths(&path).collect::<Vec<_>>();
    assert_eq!(
        paths.first().map(PathBuf::as_path),
        Some(directory.as_path())
    );
    assert_eq!(
        paths
            .iter()
            .filter(|path| path.as_path() == directory.as_path())
            .count(),
        1
    );
}

#[test]
fn terminal_environment_has_only_the_ephemeral_broker_authority() {
    let session_id = TerminalSessionId::from(uuid::Uuid::new_v4());
    let connection_id = ConnectionId::from(uuid::Uuid::new_v4());
    let cli_directory = std::env::temp_dir().join("dopedb-cli-fixture");
    let working_directory = std::env::temp_dir();
    let runtime_file = working_directory.join("runtime.json");
    let command = command_for_profile(
        TerminalProfile::Shell,
        LaunchEnvironment {
            session_id,
            connection_id,
            session_token: "ephemeral-session-token",
            runtime_file: Some(&runtime_file),
            cli_directory: &cli_directory,
            working_directory: &working_directory,
        },
    )
    .unwrap();
    let session_id_text = session_id.to_string();
    let connection_id_text = connection_id.to_string();

    assert_eq!(
        command
            .get_env("DOPEDB_TERMINAL_SESSION_ID")
            .and_then(OsStr::to_str),
        Some(session_id_text.as_str())
    );
    assert_eq!(
        command
            .get_env("DOPEDB_CONNECTION_SCOPE")
            .and_then(OsStr::to_str),
        Some(connection_id_text.as_str())
    );
    assert_eq!(
        command.get_env("DOPEDB_SESSION_TOKEN"),
        Some(OsStr::new("ephemeral-session-token"))
    );
    assert_eq!(
        command.get_env("DOPEDB_RUNTIME_FILE"),
        Some(runtime_file.as_os_str())
    );
    for forbidden in [
        "DATABASE_URL",
        "DATABASE_URL_UNPOOLED",
        "PGPASSWORD",
        "POSTGRES_PASSWORD",
        "MYSQL_PWD",
        "MONGODB_URI",
        "AWS_SECRET_ACCESS_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "SSH_AUTH_SOCK",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "BETTER_AUTH_SECRET",
        "DOPEDB_MCP_TOKEN",
    ] {
        assert!(
            command.get_env(forbidden).is_none(),
            "{forbidden} must not enter a Terminal child"
        );
    }
    assert!(
        command
            .get_argv()
            .iter()
            .all(|argument| argument != "ephemeral-session-token"),
        "the session capability must not enter argv"
    );
}

#[test]
fn skill_setup_environment_has_cli_path_without_database_authority() {
    let cli_directory = std::env::temp_dir().join("dopedb-cli-fixture");
    let working_directory = std::env::temp_dir();
    let command = command_for_skill_setup(SkillSetupLaunchEnvironment {
        cli_directory: &cli_directory,
        working_directory: &working_directory,
    })
    .unwrap();
    let paths = command
        .get_env("PATH")
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    assert_eq!(
        paths.first().map(PathBuf::as_path),
        Some(cli_directory.as_path())
    );
    #[cfg(not(windows))]
    {
        assert_eq!(
            command.get_argv().first().and_then(|value| value.to_str()),
            Some("/bin/sh")
        );
        assert!(command
            .get_argv()
            .iter()
            .any(|value| value == OsStr::new("-i")));
    }
    #[cfg(windows)]
    {
        assert!(command
            .get_argv()
            .iter()
            .any(|value| value == OsStr::new("-NoProfile")));
    }
    for forbidden in [
        "DOPEDB_TERMINAL_SESSION_ID",
        "DOPEDB_CONNECTION_SCOPE",
        "DOPEDB_SESSION_TOKEN",
        "DOPEDB_RUNTIME_FILE",
        "DATABASE_URL",
        "DATABASE_URL_UNPOOLED",
        "PGPASSWORD",
        "POSTGRES_PASSWORD",
        "MYSQL_PWD",
        "MONGODB_URI",
        "AWS_SECRET_ACCESS_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "SSH_AUTH_SOCK",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "BETTER_AUTH_SECRET",
        "DOPEDB_MCP_TOKEN",
    ] {
        assert!(
            command.get_env(forbidden).is_none(),
            "{forbidden} must not enter a Skill setup Terminal child"
        );
    }
}

#[cfg(unix)]
#[test]
fn skill_setup_shell_finds_the_bundled_cli_directory_without_connection_state() {
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;

    use portable_pty::{native_pty_system, PtySize};

    let fixture =
        std::env::temp_dir().join(format!("dopedb-skill-setup-cli-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&fixture).unwrap();
    let cli = fixture.join("dopedb");
    std::fs::write(
        &cli,
        "#!/bin/sh\nprintf 'dopedb-setup-ok:%s:%s\\n' \"$#\" \"${DOPEDB_SESSION_TOKEN:+leaked}\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let command = command_for_skill_setup(SkillSetupLaunchEnvironment {
        cli_directory: &fixture,
        working_directory: &fixture,
    })
    .unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 20,
            cols: 80,
            pixel_width: 640,
            pixel_height: 400,
        })
        .unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (output_tx, output_rx) = std::sync::mpsc::channel();
    let reader_thread = std::thread::spawn(move || {
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        output_tx.send(output).unwrap();
    });
    let mut writer = pair.master.take_writer().unwrap();
    #[cfg(target_os = "macos")]
    std::thread::sleep(std::time::Duration::from_millis(50));
    write!(writer, "dopedb version; exit\r\n").unwrap();
    writer.flush().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            let _ = child.wait();
            drop(writer);
            drop(pair.master);
            let output = output_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap_or_default();
            panic!(
                "the Skill setup PTY shell did not exit: {:?}",
                String::from_utf8_lossy(&output)
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert!(status.success());
    drop(writer);
    drop(pair.master);
    let output = output_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    reader_thread.join().unwrap();
    std::fs::remove_dir_all(&fixture).unwrap();
    let output = String::from_utf8_lossy(&output);
    assert!(
        output.contains("dopedb-setup-ok:1:"),
        "unexpected Skill setup PTY output: {output:?}"
    );
}

#[cfg(windows)]
#[test]
fn skill_setup_cmd_shell_finds_the_bundled_cli_shim_without_connection_state() {
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    use portable_pty::{native_pty_system, PtySize};

    use super::super::process_tree::ProcessTree;

    let fixture = tempfile::tempdir().unwrap();
    let cli = fixture.path().join("dopedb.cmd");
    std::fs::write(
        &cli,
        "@echo off\r\nif defined DOPEDB_SESSION_TOKEN (echo leaked) else (echo dopedb-setup-ok:%1:clean)\r\n",
    )
    .unwrap();
    let command = command_for_skill_setup(SkillSetupLaunchEnvironment {
        cli_directory: fixture.path(),
        working_directory: fixture.path(),
    })
    .unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 20,
            cols: 80,
            pixel_width: 640,
            pixel_height: 400,
        })
        .unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    let process_tree = ProcessTree::attach(child.as_ref()).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (output_tx, output_rx) = std::sync::mpsc::channel();
    let reader_thread = std::thread::spawn(move || {
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        output_tx.send(output).unwrap();
    });
    let mut writer = pair.master.take_writer().unwrap();
    writer.write_all(b"dopedb version\r\nexit\r\n").unwrap();
    writer.flush().unwrap();

    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = process_tree.force_terminate();
            let _ = child.kill();
            drop(writer);
            drop(pair.master);
            let output = output_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap_or_default();
            panic!(
                "the Windows Skill setup PTY shell did not exit: {:?}",
                String::from_utf8_lossy(&output)
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    assert!(status.success());
    drop(writer);
    drop(pair.master);
    let output = output_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    reader_thread.join().unwrap();
    let output = String::from_utf8_lossy(&output);
    assert!(
        output.contains("dopedb-setup-ok:version:clean"),
        "unexpected Windows Skill setup PTY output: {output:?}"
    );
}

#[cfg(unix)]
#[test]
fn secret_free_environment_runs_through_an_interactive_pty() {
    use std::io::{Read, Write};

    use portable_pty::{native_pty_system, PtySize};

    let session_id = TerminalSessionId::from(uuid::Uuid::new_v4());
    let connection_id = ConnectionId::from(uuid::Uuid::new_v4());
    let working_directory = std::env::temp_dir();
    let mut command = CommandBuilder::new("/bin/sh");
    apply_environment(
        &mut command,
        LaunchEnvironment {
            session_id,
            connection_id,
            session_token: "ephemeral-session-token",
            runtime_file: None,
            cli_directory: &working_directory,
            working_directory: &working_directory,
        },
    )
    .unwrap();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 20,
            cols: 80,
            pixel_width: 640,
            pixel_height: 400,
        })
        .unwrap();
    let mut child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (output_tx, output_rx) = std::sync::mpsc::channel();
    let reader_thread = std::thread::spawn(move || {
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        output_tx.send(output).unwrap();
    });
    let mut writer = pair.master.take_writer().unwrap();
    pair.master
        .resize(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 800,
            pixel_height: 600,
        })
        .unwrap();
    #[cfg(target_os = "macos")]
    std::thread::sleep(std::time::Duration::from_millis(50));
    write!(
        writer,
        "printf 'pty-ok:%s:%s\\n' \"$DOPEDB_CONNECTION_SCOPE\" \"${{DATABASE_URL:+leaked}}\"; exit\r\n"
    )
    .unwrap();
    writer.flush().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            let _ = child.wait();
            drop(writer);
            drop(pair.master);
            let output = output_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap_or_default();
            panic!(
                "the interactive PTY shell did not exit: {:?}",
                String::from_utf8_lossy(&output)
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert!(status.success());
    drop(writer);
    drop(pair.master);
    let output = output_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    reader_thread.join().unwrap();
    let output = String::from_utf8_lossy(&output);
    let expected = format!("pty-ok:{connection_id}:");
    assert!(
        output
            .lines()
            .any(|line| line.trim_end_matches('\r') == expected),
        "unexpected PTY output: {output:?}"
    );
}
