fn main() {
    // Keep the icon/version resource, but provide the application manifest through
    // one linker path shared by the GUI and Rust test harnesses. Embedding it in
    // `resource.lib` as well would give binary test targets two MANIFEST resources.
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("failed to run the Tauri build script");

    embed_windows_manifest();
}

fn embed_windows_manifest() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    let manifest = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR")
            .expect("Cargo must provide CARGO_MANIFEST_DIR to the build script"),
    )
    .join("windows-app-manifest.xml");

    println!("cargo:rerun-if-changed={}", manifest.display());
    // Cargo does not classify lib-crate unit-test harnesses as explicit `[[test]]`
    // targets, so `rustc-link-arg-tests` is rejected for this package. Match
    // Tauri's own Windows test workaround and apply these linker arguments to every
    // final artifact emitted by this crate; the normal app manifest is identical.
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/WX");
}
