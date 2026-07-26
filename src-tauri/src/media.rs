use crate::models::{DirectoryEntry, Drive, DriveIo, LibraryOptions, MediaFile};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Local, NaiveDate, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;
use walkdir::{DirEntry, WalkDir};

const MEDIA_EXTENSIONS: &[&str] = &[
    ".mov", ".mp4", ".mxf", ".avi", ".mkv", ".m4v", ".r3d", ".braw", ".ari", ".wav", ".mp3",
    ".aac", ".flac", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".cr2", ".cr3", ".nef", ".arw",
    ".dng",
];

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LinkFailure {
    pub file: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LinkTarget {
    pub path: String,
    pub source: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LibraryManifest {
    pub version: u32,
    pub mapping_id: String,
    pub created_at: String,
    pub targets: Vec<LinkTarget>,
    pub total: usize,
    pub linked: usize,
    pub failures: Vec<LinkFailure>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed: usize,
    pub kept: bool,
    pub message: String,
}

fn hidden(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    entry.depth() > 0
        && (name.starts_with('.')
            || name.eq_ignore_ascii_case("$RECYCLE.BIN")
            || name.eq_ignore_ascii_case("System Volume Information"))
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default()
}

fn iso_time(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

fn stable_file_id(_path: &Path, metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime()
        )
    }
    #[cfg(not(unix))]
    {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map_or(0, |duration| duration.as_millis());
        format!(
            "{}:{}:{}",
            _path.to_string_lossy().to_ascii_lowercase(),
            metadata.len(),
            modified
        )
    }
}

#[cfg(test)]
pub fn walk_media(root: &Path, source_uuid: &str) -> Result<Vec<MediaFile>> {
    walk_media_with_progress(root, source_uuid, |_| {})
}

pub fn walk_media_with_progress(
    root: &Path,
    source_uuid: &str,
    mut progress: impl FnMut(usize),
) -> Result<Vec<MediaFile>> {
    let root =
        fs::canonicalize(root).with_context(|| format!("无法访问素材源：{}", root.display()))?;
    let mut files = Vec::new();
    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !hidden(entry))
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = extension(entry.path());
        if !MEDIA_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let captured = metadata.created().unwrap_or(modified);
        files.push(MediaFile {
            id: stable_file_id(entry.path(), &metadata),
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            relative_path: entry
                .path()
                .strip_prefix(&root)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .into_owned(),
            extension: ext,
            size: metadata.len(),
            captured_at: iso_time(captured),
            modified_at: iso_time(modified),
            source: root.to_string_lossy().into_owned(),
            source_uuid: source_uuid.into(),
        });
        if files.len().is_multiple_of(256) {
            progress(files.len());
        }
    }
    files.sort_by(|a, b| {
        b.captured_at
            .cmp(&a.captured_at)
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    progress(files.len());
    Ok(files)
}

fn safe_relative(relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        bail!("目录超出素材源范围");
    }
    Ok(path.to_path_buf())
}

pub fn list_directory(root: &Path, relative: &str) -> Result<Vec<DirectoryEntry>> {
    let root = fs::canonicalize(root).context("素材源已移除或不可访问")?;
    let directory = root.join(safe_relative(relative)?);
    let mut rows = Vec::new();
    for entry in fs::read_dir(&directory)
        .with_context(|| format!("无法读取目录：{}", directory.display()))?
    {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || name.eq_ignore_ascii_case("$RECYCLE.BIN")
            || name.eq_ignore_ascii_case("System Volume Information")
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let path = entry.path();
        rows.push(DirectoryEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            relative_path: path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned(),
            directory: metadata.is_dir(),
            extension: if metadata.is_dir() {
                String::new()
            } else {
                extension(&path)
            },
            size: metadata.len(),
            modified_at: iso_time(metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
        });
    }
    rows.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(rows)
}

fn diskutil_value(output: &str, labels: &[&str]) -> String {
    for line in output.lines() {
        let Some((label, value)) = line.split_once(':') else {
            continue;
        };
        if labels.iter().any(|wanted| label.trim() == *wanted) {
            return value.trim().to_string();
        }
    }
    String::new()
}

#[cfg(target_os = "macos")]
pub fn list_drives() -> Vec<Drive> {
    let Ok(entries) = fs::read_dir("/Volumes") else {
        return vec![];
    };
    let mut drives = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "Macintosh HD" || !path.is_dir() {
            continue;
        }
        let output = Command::new("/usr/sbin/diskutil")
            .args(["info", &path.to_string_lossy()])
            .output()
            .ok();
        let info = output
            .as_ref()
            .filter(|value| value.status.success())
            .map(|value| String::from_utf8_lossy(&value.stdout).into_owned())
            .unwrap_or_default();
        let protocol = diskutil_value(&info, &["Protocol"]);
        if protocol.to_ascii_lowercase().contains("disk image") {
            continue;
        }
        let uuid = diskutil_value(&info, &["Volume UUID", "Disk / Partition UUID"]);
        let device = diskutil_value(&info, &["Part of Whole", "Device Identifier"]);
        let metadata = fs::metadata(&path).ok();
        let id = if uuid.is_empty() {
            path.to_string_lossy().into_owned()
        } else {
            uuid.to_ascii_uppercase()
        };
        drives.push(Drive {
            id: id.clone(),
            uuid: id,
            name: name.clone(),
            path: path.to_string_lossy().into_owned(),
            device,
            kind: if name.to_ascii_lowercase().contains("sd") {
                "SD".into()
            } else {
                "外置磁盘".into()
            },
            size: metadata.as_ref().map_or(0, fs::Metadata::len),
            free: 0,
            read_bps: 0.0,
            write_bps: 0.0,
        });
    }
    drives
}

#[cfg(target_os = "windows")]
pub fn list_drives() -> Vec<Drive> {
    let script = "Get-CimInstance Win32_LogicalDisk | Where-Object {$_.DriveType -in 2,3} | Select-Object DeviceID,VolumeName,VolumeSerialNumber,DriveType,Size,FreeSpace | ConvertTo-Json -Compress";
    let Ok(output) = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", script])
        .output()
    else {
        return vec![];
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return vec![];
    };
    let rows = value.as_array().cloned().unwrap_or_else(|| vec![value]);
    rows.into_iter()
        .filter_map(|row| {
            let device = row.get("DeviceID")?.as_str()?.to_string();
            let serial = row
                .get("VolumeSerialNumber")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let id = if serial.is_empty() {
                device.clone()
            } else {
                format!("{device}:{serial}")
            };
            Some(Drive {
                id: id.clone(),
                uuid: id,
                name: row
                    .get("VolumeName")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&device)
                    .into(),
                path: format!("{device}\\"),
                device: device.clone(),
                kind: if row.get("DriveType").and_then(serde_json::Value::as_u64) == Some(2) {
                    "可移动磁盘".into()
                } else {
                    "本地磁盘".into()
                },
                size: row
                    .get("Size")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                free: row
                    .get("FreeSpace")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                read_bps: 0.0,
                write_bps: 0.0,
            })
        })
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn list_drives() -> Vec<Drive> {
    vec![]
}

#[cfg(target_os = "macos")]
pub fn sample_drive_io(
    drives: &[Drive],
    previous: &mut HashMap<String, (u64, u64)>,
    elapsed: f64,
) -> Vec<DriveIo> {
    let output = Command::new("/usr/sbin/ioreg")
        .args(["-r", "-c", "IOBlockStorageDriver", "-l"])
        .output()
        .ok();
    let text = output
        .map(|value| String::from_utf8_lossy(&value.stdout).into_owned())
        .unwrap_or_default();
    let block = Regex::new(r#"\"Statistics\" = \{[^\n]*\"Bytes \(Read\)\"=(\d+)[^\n]*\"Bytes \(Write\)\"=(\d+)[^\n]*\}[\s\S]*?\"BSD Name\" = \"(disk\d+)\""#).expect("valid regex");
    let counters: HashMap<String, (u64, u64)> = block
        .captures_iter(&text)
        .filter_map(|capture| {
            Some((
                capture.get(3)?.as_str().into(),
                (
                    capture.get(1)?.as_str().parse().ok()?,
                    capture.get(2)?.as_str().parse().ok()?,
                ),
            ))
        })
        .collect();
    let result = drives
        .iter()
        .map(|drive| {
            let current = counters.get(&drive.device).copied();
            let old = previous.get(&drive.device).copied();
            DriveIo {
                id: drive.id.clone(),
                read_bps: current.zip(old).map_or(0.0, |(a, b)| {
                    a.0.saturating_sub(b.0) as f64 / elapsed.max(0.25)
                }),
                write_bps: current.zip(old).map_or(0.0, |(a, b)| {
                    a.1.saturating_sub(b.1) as f64 / elapsed.max(0.25)
                }),
            }
        })
        .collect();
    *previous = counters;
    result
}

#[cfg(target_os = "windows")]
pub fn sample_drive_io(
    drives: &[Drive],
    _previous: &mut HashMap<String, (u64, u64)>,
    _elapsed: f64,
) -> Vec<DriveIo> {
    let script = "Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object {$_.Name -ne '_Total'} | Select-Object Name,DiskReadBytesPersec,DiskWriteBytesPersec | ConvertTo-Json -Compress";
    let rows = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", script])
        .output()
        .ok()
        .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok())
        .map(|value| value.as_array().cloned().unwrap_or_else(|| vec![value]))
        .unwrap_or_default();
    drives
        .iter()
        .map(|drive| {
            let row = rows.iter().find(|row| {
                row.get("Name").and_then(serde_json::Value::as_str) == Some(drive.device.as_str())
            });
            DriveIo {
                id: drive.id.clone(),
                read_bps: row
                    .and_then(|item| item.get("DiskReadBytesPersec"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
                write_bps: row
                    .and_then(|item| item.get("DiskWriteBytesPersec"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
            }
        })
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn sample_drive_io(
    drives: &[Drive],
    _previous: &mut HashMap<String, (u64, u64)>,
    _elapsed: f64,
) -> Vec<DriveIo> {
    drives
        .iter()
        .map(|drive| DriveIo {
            id: drive.id.clone(),
            ..DriveIo::default()
        })
        .collect()
}

fn local_day(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|_| "未知日期".into())
}

fn selected(file: &MediaFile, options: &LibraryOptions) -> bool {
    if !options.extensions.is_empty()
        && !options
            .extensions
            .iter()
            .any(|ext| ext.eq_ignore_ascii_case(&file.extension))
    {
        return false;
    }
    let day = DateTime::parse_from_rfc3339(&file.captured_at)
        .map(|date| date.with_timezone(&Local).date_naive())
        .ok();
    let start = NaiveDate::parse_from_str(&options.start_date, "%Y-%m-%d").ok();
    let end = NaiveDate::parse_from_str(&options.end_date, "%Y-%m-%d").ok();
    day.is_none_or(|value| {
        start.is_none_or(|start| value >= start) && end.is_none_or(|end| value <= end)
    })
}

fn safe_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
                || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect()
}

fn create_link(source: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if target.exists() || target.symlink_metadata().is_ok() {
        fs::remove_file(target).with_context(|| format!("无法替换旧链接：{}", target.display()))?;
    }
    #[cfg(unix)]
    if std::os::unix::fs::symlink(source, target).is_ok() {
        return Ok(());
    }
    #[cfg(windows)]
    if std::os::windows::fs::symlink_file(source, target).is_ok() {
        return Ok(());
    }
    fs::hard_link(source, target).with_context(|| format!("无法创建链接：{}", target.display()))
}

pub fn create_virtual_library(
    files: &[MediaFile],
    options: &LibraryOptions,
) -> Result<LibraryManifest> {
    let destination = PathBuf::from(&options.destination);
    if options.destination.trim().is_empty() || destination.parent().is_none() {
        bail!("请选择安全的映射目标目录");
    }
    fs::create_dir_all(&destination)?;
    let chosen: Vec<&MediaFile> = files
        .iter()
        .filter(|file| selected(file, options))
        .collect();
    let mut manifest = LibraryManifest {
        version: 4,
        mapping_id: options.id.clone(),
        created_at: Utc::now().to_rfc3339(),
        total: chosen.len(),
        ..LibraryManifest::default()
    };
    for file in chosen {
        let relative = safe_relative(&file.relative_path)
            .unwrap_or_else(|_| PathBuf::from(safe_name(&file.name)));
        let safe_relative: PathBuf = relative
            .components()
            .filter_map(|part| match part {
                Component::Normal(value) => Some(safe_name(&value.to_string_lossy())),
                _ => None,
            })
            .collect();
        let target = destination
            .join(local_day(&file.captured_at))
            .join(safe_relative);
        match create_link(Path::new(&file.path), &target) {
            Ok(()) => {
                manifest.linked += 1;
                manifest.targets.push(LinkTarget {
                    path: target
                        .strip_prefix(&destination)
                        .unwrap_or(&target)
                        .to_string_lossy()
                        .into_owned(),
                    source: file.path.clone(),
                });
            }
            Err(error) => manifest.failures.push(LinkFailure {
                file: file.path.clone(),
                error: error.to_string(),
            }),
        }
    }
    fs::write(
        destination.join(".material-gater.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(manifest)
}

fn prune_empty(path: &Path, root: &Path) {
    if path == root {
        return;
    }
    if fs::read_dir(path)
        .ok()
        .is_some_and(|mut entries| entries.next().is_none())
    {
        let parent = path.parent().map(Path::to_path_buf);
        let _ = fs::remove_dir(path);
        if let Some(parent) = parent {
            prune_empty(&parent, root);
        }
    }
}

pub fn cleanup_virtual_library(destination: &str, mapping_id: &str) -> Result<CleanupResult> {
    let root = PathBuf::from(destination);
    if destination.trim().is_empty() || root.parent().is_none() {
        bail!("拒绝清理磁盘根目录");
    }
    let manifest_path = root.join(".material-gater.json");
    if !manifest_path.exists() {
        return Ok(CleanupResult {
            kept: true,
            message: "未找到映射清单，为保护普通文件未清理目录".into(),
            ..CleanupResult::default()
        });
    }
    let manifest: LibraryManifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    if !mapping_id.is_empty()
        && !manifest.mapping_id.is_empty()
        && manifest.mapping_id != mapping_id
    {
        bail!("映射清单属于其他配置，已停止清理");
    }
    let mut removed = 0;
    for item in manifest.targets {
        let Ok(relative) = safe_relative(&item.path) else {
            continue;
        };
        let target = root.join(relative);
        let is_managed = target
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
            || same_file::is_same_file(&target, &item.source).unwrap_or(false);
        if is_managed && fs::remove_file(&target).is_ok() {
            removed += 1;
            if let Some(parent) = target.parent() {
                prune_empty(parent, &root);
            }
        }
    }
    let _ = fs::remove_file(&manifest_path);
    if fs::read_dir(&root)
        .ok()
        .is_some_and(|mut entries| entries.next().is_none())
    {
        let _ = fs::remove_dir(&root);
    }
    let kept = root.exists();
    Ok(CleanupResult {
        removed,
        kept,
        message: if kept {
            format!("已删除 {removed} 个映射链接；目录中的其他文件已保留")
        } else {
            format!("已删除 {removed} 个映射链接和空目录")
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_links_and_safely_cleans_a_library() {
        let temporary = tempfile::tempdir().expect("temp directory");
        let source = temporary.path().join("source");
        let output = temporary.path().join("output");
        fs::create_dir_all(source.join("DCIM")).expect("source directory");
        fs::write(source.join("DCIM/A001.MOV"), vec![7_u8; 1024]).expect("mov");
        fs::write(source.join("notes.txt"), b"ignored").expect("note");

        let files = walk_media(&source, "test-source").expect("scan");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].extension, ".mov");
        let manifest = create_virtual_library(
            &files,
            &LibraryOptions {
                id: "mapping".into(),
                destination: output.to_string_lossy().into_owned(),
                extensions: vec![".mov".into()],
                ..LibraryOptions::default()
            },
        )
        .expect("link library");
        assert_eq!(manifest.linked, 1);
        let cleanup =
            cleanup_virtual_library(&output.to_string_lossy(), "mapping").expect("cleanup");
        assert_eq!(cleanup.removed, 1);
        assert!(!cleanup.kept);
        assert!(!output.exists());
    }

    #[test]
    fn cleanup_preserves_unmanaged_files() {
        let temporary = tempfile::tempdir().expect("temp directory");
        fs::write(temporary.path().join("user.mov"), b"keep").expect("user file");
        let result = cleanup_virtual_library(&temporary.path().to_string_lossy(), "unknown")
            .expect("safe cleanup");
        assert_eq!(result.removed, 0);
        assert!(result.kept);
        assert!(temporary.path().join("user.mov").exists());
    }
}
