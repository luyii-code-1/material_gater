use crate::models::Repository;
use anyhow::{Context, Result, bail};
use remotefs::fs::{Metadata, RemoteFs, UnixPex};
use remotefs_ftp::FtpFs;
use remotefs_ssh::{NoCheckServerKey, RusshSession, SftpFs, SshOpts};
use smb2::{ClientConfig, SmbClient};
use std::collections::HashMap;
use std::fs::File as StdFile;
use std::io::{Error as IoError, ErrorKind as IoErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom as AsyncSeekFrom};

fn remote_join(base: &str, relative: &str) -> PathBuf {
    let parts = base
        .trim_matches(['/', '\\'])
        .split(['/', '\\'])
        .chain(relative.split(['/', '\\']))
        .filter(|value| !value.is_empty());
    let mut path = PathBuf::from("/");
    for part in parts {
        path.push(part);
    }
    path
}

fn ensure_directories(client: &mut dyn RemoteFs, directory: &Path) -> Result<()> {
    let mut current = PathBuf::from("/");
    for component in directory.components() {
        let std::path::Component::Normal(part) = component else {
            continue;
        };
        current.push(part);
        if !client.exists(&current).unwrap_or(false) {
            client
                .create_dir(&current, UnixPex::from(0o755))
                .with_context(|| format!("无法创建远程目录：{}", current.display()))?;
        }
    }
    Ok(())
}

struct ProgressReader<F> {
    file: StdFile,
    pause: Arc<AtomicBool>,
    copied: u64,
    progress: F,
}

impl<F: FnMut(u64, u64) -> Result<()> + Send> Read for ProgressReader<F> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.pause.load(Ordering::Relaxed) {
            return Err(IoError::new(IoErrorKind::Interrupted, "任务已暂停"));
        }
        let read = self.file.read(buffer)?;
        self.copied += read as u64;
        (self.progress)(read as u64, self.copied).map_err(IoError::other)?;
        Ok(read)
    }
}

fn ftp_client(repository: &Repository, password: &str) -> Box<dyn RemoteFs> {
    Box::new(
        FtpFs::new(&repository.address, repository.port.unwrap_or(21))
            .username(if repository.username.is_empty() {
                "anonymous"
            } else {
                &repository.username
            })
            .password(if password.is_empty() {
                "guest"
            } else {
                password
            }),
    )
}

fn sftp_client(repository: &Repository, password: &str) -> Result<Box<dyn RemoteFs>> {
    let runtime = Arc::new(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?,
    );
    let opts = SshOpts::new(&repository.address)
        .port(repository.port.unwrap_or(22))
        .username(&repository.username)
        .password(password)
        .connection_timeout(Duration::from_secs(15));
    let client: SftpFs<RusshSession<NoCheckServerKey>> = SftpFs::russh(opts, runtime);
    Ok(Box::new(client))
}

pub fn copy_remote_fs<F>(
    repository: &Repository,
    password: &str,
    source: &Path,
    relative: &str,
    pause: Arc<AtomicBool>,
    progress: F,
) -> Result<bool>
where
    F: FnMut(u64, u64) -> Result<()> + Send + 'static,
{
    let mut client = match repository.repository_type.as_str() {
        "ftp" => ftp_client(repository, password),
        "sftp" => sftp_client(repository, password)?,
        _ => bail!("不是 FTP/SFTP 储存库"),
    };
    client.connect().context("远程服务器鉴权失败")?;
    let result = (|| {
        let final_path = remote_join(&repository.remote_path, relative);
        let partial = PathBuf::from(format!(
            "{}.material-gater.part",
            final_path.to_string_lossy()
        ));
        let source_size = std::fs::metadata(source)?.len();
        if client
            .stat(&final_path)
            .ok()
            .is_some_and(|file| file.metadata.size == source_size)
        {
            return Ok(true);
        }
        if let Some(parent) = final_path.parent() {
            ensure_directories(client.as_mut(), parent)?;
        }
        let mut offset = client
            .stat(&partial)
            .ok()
            .map(|file| file.metadata.size)
            .unwrap_or(0);
        if offset > source_size {
            let _ = client.remove_file(&partial);
            offset = 0;
        }
        let mut file = StdFile::open(source)?;
        file.seek(SeekFrom::Start(offset))?;
        let reader = ProgressReader {
            file,
            pause,
            copied: offset,
            progress,
        };
        let metadata = Metadata::default().size(source_size);
        if offset > 0 {
            client.append_file(&partial, &metadata, Box::new(reader))?;
        } else {
            client.create_file(&partial, &metadata, Box::new(reader))?;
        }
        if client.exists(&final_path).unwrap_or(false) {
            client.remove_file(&final_path)?;
        }
        client.mov(&partial, &final_path)?;
        Ok(false)
    })();
    let _ = client.disconnect();
    result
}

pub fn parse_smb_address(address: &str) -> Result<(String, String)> {
    let mut parts = address
        .trim()
        .trim_start_matches(['\\', '/'])
        .split(['\\', '/'])
        .filter(|value| !value.is_empty());
    let host = parts.next().context("SMB 地址缺少服务器名称")?;
    let share = parts
        .next()
        .context("SMB 地址缺少共享名称，请使用 \\\\server\\share")?;
    Ok((host.to_string(), share.to_string()))
}

fn smb_path(repository: &Repository, relative: &str) -> String {
    repository
        .remote_path
        .trim_matches(['/', '\\'])
        .split(['/', '\\'])
        .chain(relative.split(['/', '\\']))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\\")
}

async fn smb_client(repository: &Repository, password: &str) -> Result<(SmbClient, smb2::Tree)> {
    let (host, share) = parse_smb_address(&repository.address)?;
    let address = format!("{}:{}", host, repository.port.unwrap_or(445));
    let mut client = SmbClient::connect(ClientConfig {
        addr: address,
        timeout: Duration::from_secs(10),
        username: repository.username.clone(),
        password: password.into(),
        domain: repository.domain.clone(),
        auto_reconnect: true,
        compression: true,
        dfs_enabled: true,
        dfs_target_overrides: HashMap::new(),
    })
    .await
    .context("SMB 鉴权失败")?;
    let tree = client
        .connect_share(&share)
        .await
        .context("无法连接 SMB 共享")?;
    Ok((client, tree))
}

async fn ensure_smb_directories(
    client: &mut SmbClient,
    tree: &mut smb2::Tree,
    path: &str,
) -> Result<()> {
    let mut current = String::new();
    let parts: Vec<_> = path.split('\\').filter(|part| !part.is_empty()).collect();
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        if !current.is_empty() {
            current.push('\\');
        }
        current.push_str(part);
        if client.stat(tree, &current).await.is_err() {
            client
                .create_directory(tree, &current)
                .await
                .with_context(|| format!("无法创建 SMB 目录：{current}"))?;
        }
    }
    Ok(())
}

pub async fn copy_smb<F>(
    repository: &Repository,
    password: &str,
    source: &Path,
    relative: &str,
    pause: Arc<AtomicBool>,
    mut progress: F,
) -> Result<bool>
where
    F: FnMut(u64, u64) -> Result<()>,
{
    let (mut client, mut tree) = smb_client(repository, password).await?;
    let final_path = smb_path(repository, relative);
    let partial = format!("{final_path}.material-gater.part");
    let source_size = tokio::fs::metadata(source).await?.len();
    if client
        .stat(&mut tree, &final_path)
        .await
        .ok()
        .is_some_and(|file| file.size == source_size)
    {
        let _ = client.disconnect_share(&tree).await;
        return Ok(true);
    }
    ensure_smb_directories(&mut client, &mut tree, &final_path).await?;
    let mut offset = client
        .stat(&mut tree, &partial)
        .await
        .ok()
        .map(|file| file.size)
        .unwrap_or(0);
    if offset > source_size {
        let _ = client.delete_file(&mut tree, &partial).await;
        offset = 0;
    }
    let mut input = File::open(source).await?;
    input.seek(AsyncSeekFrom::Start(offset)).await?;
    let mut writer = if offset > 0 {
        client
            .create_file_writer_at(&tree, &partial, offset)
            .await?
    } else {
        client.create_file_writer(&tree, &partial).await?
    };
    progress(0, offset)?;
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    let mut copied = offset;
    loop {
        if pause.load(Ordering::Relaxed) {
            bail!("任务已暂停");
        }
        let read = input.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        writer.write_chunk(&buffer[..read]).await?;
        copied += read as u64;
        progress(read as u64, copied)?;
    }
    writer.finish().await?;
    if client.stat(&mut tree, &final_path).await.is_ok() {
        client.delete_file(&mut tree, &final_path).await?;
    }
    client.rename(&mut tree, &partial, &final_path).await?;
    client.disconnect_share(&tree).await?;
    Ok(false)
}

struct HashWriter<F> {
    hasher: Arc<Mutex<blake3::Hasher>>,
    pause: Arc<AtomicBool>,
    read: u64,
    progress: F,
}

impl<F: FnMut(u64) -> Result<()> + Send> Write for HashWriter<F> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self.pause.load(Ordering::Relaxed) {
            return Err(IoError::new(IoErrorKind::Interrupted, "任务已暂停"));
        }
        self.hasher
            .lock()
            .map_err(|_| IoError::other("校验器锁已损坏"))?
            .update(buffer);
        self.read += buffer.len() as u64;
        (self.progress)(self.read).map_err(IoError::other)?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn hash_remote_fs<F>(
    repository: &Repository,
    password: &str,
    relative: &str,
    pause: Arc<AtomicBool>,
    progress: F,
) -> Result<String>
where
    F: FnMut(u64) -> Result<()> + Send + 'static,
{
    let mut client = match repository.repository_type.as_str() {
        "ftp" => ftp_client(repository, password),
        "sftp" => sftp_client(repository, password)?,
        _ => bail!("不是 FTP/SFTP 储存库"),
    };
    client.connect().context("远程服务器鉴权失败")?;
    let hasher = Arc::new(Mutex::new(blake3::Hasher::new()));
    let writer = HashWriter {
        hasher: hasher.clone(),
        pause,
        read: 0,
        progress,
    };
    let result = client.open_file(
        &remote_join(&repository.remote_path, relative),
        Box::new(writer),
    );
    let _ = client.disconnect();
    result.context("无法读取远程文件进行校验")?;
    let hash = hasher
        .lock()
        .map_err(|_| anyhow::anyhow!("校验器锁已损坏"))?
        .finalize()
        .to_hex()
        .to_string();
    Ok(hash)
}

pub async fn hash_smb<F>(
    repository: &Repository,
    password: &str,
    relative: &str,
    pause: Arc<AtomicBool>,
    mut progress: F,
) -> Result<String>
where
    F: FnMut(u64) -> Result<()>,
{
    let (mut client, tree) = smb_client(repository, password).await?;
    let reader = client
        .open_file_reader(&tree, &smb_path(repository, relative))
        .await?;
    let mut hasher = blake3::Hasher::new();
    let mut offset = 0_u64;
    while offset < reader.size() {
        if pause.load(Ordering::Relaxed) {
            bail!("任务已暂停");
        }
        let chunk = reader.read_at(offset, 4 * 1024 * 1024).await?;
        if chunk.is_empty() {
            break;
        }
        hasher.update(&chunk);
        offset += chunk.len() as u64;
        progress(offset)?;
    }
    reader.close().await?;
    client.disconnect_share(&tree).await?;
    Ok(hasher.finalize().to_hex().to_string())
}

pub async fn test_repository(repository: &Repository, password: &str) -> Result<String> {
    match repository.repository_type.as_str() {
        "local" => {
            tokio::fs::create_dir_all(&repository.root).await?;
            let probe = Path::new(&repository.root).join(".material-gater-write-test");
            tokio::fs::write(&probe, b"ok").await?;
            tokio::fs::remove_file(probe).await?;
            Ok("目录可读写".into())
        }
        "smb" => {
            let (mut client, tree) = smb_client(repository, password).await?;
            client.disconnect_share(&tree).await?;
            Ok("SMB 鉴权与共享目录连接成功".into())
        }
        "ftp" | "sftp" => {
            let repository = repository.clone();
            let password = password.to_string();
            tokio::task::spawn_blocking(move || {
                let mut client = if repository.repository_type == "ftp" {
                    ftp_client(&repository, &password)
                } else {
                    sftp_client(&repository, &password)?
                };
                client.connect().context("远程服务器鉴权失败")?;
                if !repository.remote_path.is_empty() {
                    client
                        .stat(&remote_join(&repository.remote_path, ""))
                        .context("远程目录不可访问")?;
                }
                client.disconnect()?;
                Ok::<_, anyhow::Error>(format!(
                    "{} 鉴权与远程目录连接成功",
                    repository.repository_type.to_ascii_uppercase()
                ))
            })
            .await?
        }
        _ => bail!("不支持的储存库类型"),
    }
}
