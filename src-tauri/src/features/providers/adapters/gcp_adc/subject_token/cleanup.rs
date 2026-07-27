//! Descriptor-rooted cleanup for private gcloud snapshots on macOS and Linux.
//!
//! Every mutation below is relative to an already-opened directory descriptor.
//! A path is used only once to open the random root and its parent with
//! `O_NOFOLLOW`; after that point a swapped name can only make cleanup fail.

use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::Write;
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::{ffi::OsStrExt, fs::MetadataExt},
};
use std::path::Path;

use crate::error::AppResult;

use super::super::blocked;

/// Opened private root and parent used exclusively for descriptor-rooted wipe.
pub(super) struct CapabilityRoot {
    root: File,
    parent: File,
    name: CString,
    identity: UnixIdentity,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct UnixIdentity {
    device: u64,
    inode: u64,
    links: u64,
}

impl UnixIdentity {
    fn same_inode(self, other: Self) -> bool {
        self.device == other.device && self.inode == other.inode
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UnixEntryKind {
    Regular,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Copy)]
struct UnixEntry {
    identity: UnixIdentity,
    kind: UnixEntryKind,
}

impl CapabilityRoot {
    /// Opens the random snapshot root and its parent without traversing a
    /// final symlink. Unsupported system-call behavior fails closed upstream.
    pub(super) fn open(path: &Path) -> AppResult<Self> {
        let parent_path = path
            .parent()
            .filter(|parent| parent.is_absolute())
            .ok_or_else(unavailable)?;
        let name = path
            .file_name()
            .filter(|name| !name.is_empty())
            .ok_or_else(unavailable)?;
        let root = open_directory_no_follow(path)?;
        let parent = open_directory_no_follow(parent_path)?;
        let identity = identity_for_file(&root)?;
        if identity.links < 2 {
            return Err(unavailable());
        }
        Ok(Self {
            root,
            parent,
            name: CString::new(name.as_bytes()).map_err(|_| unavailable())?,
            identity,
        })
    }

    /// Wipes regular snapshot files and removes nested owned entries.
    pub(super) fn cleanup(&self) -> AppResult<()> {
        self.cleanup_with_hook(|_| {})
    }

    /// Makes two descriptor-rooted attempts before any pathname fallback is
    /// considered. A transient entry swap therefore cannot strand a private
    /// ADC snapshot after the first failed traversal.
    pub(super) fn cleanup_and_remove(&self) -> AppResult<()> {
        let mut last = Err(failed());
        for _ in 0..2 {
            let result = self.cleanup().and_then(|()| self.remove_root());
            if result.is_ok() {
                return Ok(());
            }
            last = result;
        }
        last
    }

    /// Checks that the private root's pathname is still the descriptor that
    /// was opened at materialization time. This gates the standard-library
    /// last resort so an attacker-swapped external root is never traversed.
    pub(super) fn root_is_current(&self) -> bool {
        stat_at(&self.parent, &self.name)
            .map(|current| {
                current.kind == UnixEntryKind::Directory
                    && current.identity.same_inode(self.identity)
            })
            .unwrap_or(false)
    }

    /// Test-only hook runs after an entry identity read and before reopening
    /// it, exercising the same-UID swap window without exposing paths.
    pub(super) fn cleanup_with_hook(&self, mut hook: impl FnMut(&CStr)) -> AppResult<()> {
        cleanup_directory(&self.root, &mut hook)
    }

    /// Removes the visible root only if the parent still names this directory.
    pub(super) fn remove_root(&self) -> AppResult<()> {
        let current = stat_at(&self.parent, &self.name)?;
        if current.kind != UnixEntryKind::Directory || !current.identity.same_inode(self.identity) {
            return Err(failed());
        }
        unlink_at(&self.parent, &self.name, libc::AT_REMOVEDIR)
    }
}

fn cleanup_directory(directory: &File, hook: &mut dyn FnMut(&CStr)) -> AppResult<()> {
    for name in directory_entries(directory)? {
        let before = stat_at(directory, &name)?;
        hook(&name);
        match before.kind {
            UnixEntryKind::Symlink => remove_same_symlink(directory, &name, before.identity)?,
            UnixEntryKind::Regular => wipe_same_regular(directory, &name, before.identity)?,
            UnixEntryKind::Directory => {
                cleanup_same_directory(directory, &name, before.identity, hook)?
            }
            UnixEntryKind::Other => return Err(failed()),
        }
    }
    Ok(())
}

fn remove_same_symlink(directory: &File, name: &CStr, expected: UnixIdentity) -> AppResult<()> {
    let current = stat_at(directory, name)?;
    if current.kind != UnixEntryKind::Symlink || !current.identity.same_inode(expected) {
        return Err(failed());
    }
    unlink_at(directory, name, 0)
}

fn wipe_same_regular(directory: &File, name: &CStr, expected: UnixIdentity) -> AppResult<()> {
    let current = stat_at(directory, name)?;
    if current.kind != UnixEntryKind::Regular
        || !current.identity.same_inode(expected)
        || current.identity.links != 1
    {
        return Err(failed());
    }
    let mut file = open_at(directory, name, libc::O_RDWR | libc::O_NOFOLLOW)?;
    if !identity_for_file(&file)?.same_inode(expected) || identity_for_file(&file)?.links != 1 {
        return Err(failed());
    }
    wipe_open_file(&mut file)?;
    // If the name or opened inode changed during the wipe, do not unlink a
    // replacement. A newly-added hardlink is also an error, not a wipe target.
    if !identity_for_file(&file)?.same_inode(expected) || identity_for_file(&file)?.links != 1 {
        return Err(failed());
    }
    let before_unlink = stat_at(directory, name)?;
    if before_unlink.kind != UnixEntryKind::Regular
        || !before_unlink.identity.same_inode(expected)
        || before_unlink.identity.links != 1
    {
        return Err(failed());
    }
    unlink_at(directory, name, 0)
}

fn cleanup_same_directory(
    parent: &File,
    name: &CStr,
    expected: UnixIdentity,
    hook: &mut dyn FnMut(&CStr),
) -> AppResult<()> {
    let current = stat_at(parent, name)?;
    if current.kind != UnixEntryKind::Directory || !current.identity.same_inode(expected) {
        return Err(failed());
    }
    let child = open_at(
        parent,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
    )?;
    if !identity_for_file(&child)?.same_inode(expected) {
        return Err(failed());
    }
    cleanup_directory(&child, hook)?;
    let before_remove = stat_at(parent, name)?;
    if before_remove.kind != UnixEntryKind::Directory
        || !before_remove.identity.same_inode(expected)
    {
        return Err(failed());
    }
    unlink_at(parent, name, libc::AT_REMOVEDIR)
}

fn directory_entries(directory: &File) -> AppResult<Vec<CString>> {
    // `dup` shares the open-directory cursor, so reopen `.` relative to the
    // capability instead. That makes a failed cleanup safely retryable.
    let reopened = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if reopened < 0 {
        return Err(failed());
    }
    let stream = unsafe { libc::fdopendir(reopened) };
    if stream.is_null() {
        unsafe { libc::close(reopened) };
        return Err(failed());
    }
    let mut entries = Vec::new();
    loop {
        clear_errno();
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            let error = last_errno();
            unsafe { libc::closedir(stream) };
            return if error == 0 {
                Ok(entries)
            } else {
                Err(failed())
            };
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if !matches!(name.to_bytes(), b"." | b"..") {
            entries.push(CString::new(name.to_bytes()).map_err(|_| failed())?);
        }
    }
}

fn open_directory_no_follow(path: &Path) -> AppResult<File> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| unavailable())?;
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    (descriptor >= 0)
        .then(|| unsafe { File::from_raw_fd(descriptor) })
        .ok_or_else(unavailable)
}

fn open_at(directory: &File, name: &CStr, flags: libc::c_int) -> AppResult<File> {
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC,
        )
    };
    (descriptor >= 0)
        .then(|| unsafe { File::from_raw_fd(descriptor) })
        .ok_or_else(failed)
}

fn stat_at(directory: &File, name: &CStr) -> AppResult<UnixEntry> {
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(failed());
    }
    let kind = match stat.st_mode & libc::S_IFMT {
        libc::S_IFREG => UnixEntryKind::Regular,
        libc::S_IFDIR => UnixEntryKind::Directory,
        libc::S_IFLNK => UnixEntryKind::Symlink,
        _ => UnixEntryKind::Other,
    };
    Ok(UnixEntry {
        identity: UnixIdentity {
            device: stat.st_dev as u64,
            inode: stat.st_ino as u64,
            links: stat.st_nlink as u64,
        },
        kind,
    })
}

fn identity_for_file(file: &File) -> AppResult<UnixIdentity> {
    let metadata = file.metadata().map_err(|_| failed())?;
    Ok(UnixIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        links: metadata.nlink(),
    })
}

fn wipe_open_file(file: &mut File) -> AppResult<()> {
    let length = file.metadata().map_err(|_| failed())?.len();
    let zeros = [0_u8; 4096];
    let mut remaining = length;
    while remaining > 0 {
        let amount = remaining.min(zeros.len() as u64) as usize;
        file.write_all(&zeros[..amount]).map_err(|_| failed())?;
        remaining -= amount as u64;
    }
    file.sync_all().map_err(|_| failed())
}

fn unlink_at(directory: &File, name: &CStr, flags: libc::c_int) -> AppResult<()> {
    (unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), flags) } == 0)
        .then_some(())
        .ok_or_else(failed)
}

#[cfg(target_os = "linux")]
fn clear_errno() {
    unsafe { *libc::__errno_location() = 0 };
}

#[cfg(target_os = "macos")]
fn clear_errno() {
    unsafe { *libc::__error() = 0 };
}

#[cfg(target_os = "linux")]
fn last_errno() -> libc::c_int {
    unsafe { *libc::__errno_location() }
}

#[cfg(target_os = "macos")]
fn last_errno() -> libc::c_int {
    unsafe { *libc::__error() }
}

fn unavailable() -> crate::error::AppError {
    blocked("GCP ADC snapshot is unavailable")
}

fn failed() -> crate::error::AppError {
    blocked("GCP ADC snapshot cleanup failed")
}
