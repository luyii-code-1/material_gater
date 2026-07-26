# Material Gater

[![Build and Release](https://github.com/luyii-code-1/material_gater/actions/workflows/release.yml/badge.svg)](https://github.com/luyii-code-1/material_gater/actions/workflows/release.yml)

Material Gater 是一款面向摄影、影视工作流的轻量跨平台素材门卫。它识别插入的 SD 卡或 SSD，建立本地索引，再按文件类型和拍摄日期生成一个干净的虚拟素材库，供 Premiere Pro、DaVinci Resolve、Final Cut Pro 等剪辑软件直接读取。

> 当前版本：`0.7.0`。支持 macOS 与 Windows，界面语言为简体中文。

桌面壳已迁移至 Tauri 2：磁盘识别、索引、映射、系统安全存储和拷贝守护任务均由原生 Rust 后端执行，界面仅保留轻量 TypeScript/Vite 渲染层。

## 功能

- 通过卷 UUID 识别外置素材盘；前台默认每 1 秒、后台每 3 秒检测一次
- 检测到素材盘后询问是否扫描；后台通过系统通知提示，点击通知可打开主界面
- 关闭窗口后继续常驻，维持素材盘检测、映射生命周期和拷贝任务
- 紧凑的三栏管理器界面，自动跟随系统浅色或深色主题
- 内置思源黑体可变字体，离线运行时也能保持一致排版
- 手动选择任意素材目录
- 点击素材盘快速预览已索引内容，支持名称、类型和日期过滤
- 素材源预览显示未经类型筛选的原始目录，可双击打开、右键定位文件
- 递归识别常见视频、音频、照片及 RAW 格式
- 素材浏览支持紧凑列表和按真实目录层级展开的树形列表
- 本地 JSON 索引，统计素材数量、容量、拍摄日期和每日拍摄量
- 统计面板提供每日容量柱状图、文件类型容量饼图和筛选联动
- 按扩展名与日期范围筛选
- 保存和管理多个独立映射配置，记录每个映射的最近运行结果
- 映射使用清晰的“素材来源 → 输出位置”流程，可分别选择外置盘目录和链接库目录
- 映射绑定硬盘 UUID：拔盘自动卸载并清理受管链接，重新插入后自动恢复
- 删除映射时可只删配置，或同时清理该映射生成的链接；用户自行放入的文件不会被删除
- 左下角实时显示每个已连接磁盘的读写速度
- 素材库使用不同颜色区分视频、音频、RAW、图片与其他文件
- “本地文件”统一覆盖内置盘、USB 硬盘与已挂载目录，另支持原生 SMB、FTP 与 SFTP 连接；测试连接会完成真实鉴权和远程目录验证，密码使用系统钥匙串/凭据管理器保存
- 三步拷贝向导依次完成大列表选材、储存位置设置和执行复核，任务队列独立显示
- 拷贝预设分为只读的内置预设与用户自定义预设，可保存筛选条件、储存方式与目录规则
- 默认储存直接采用储存位置内预设的目录规则；自定义储存才显示临时目录与文件结构选项
- 目录模板支持 `%day`、`%time`、`%note` 与 `%note("固定文字")`
- 后台拷贝任务显示实时速度曲线、进度和 ETA，并以文件为单位持久化断点
- 意外中断后排除已完成文件，覆盖未完成的 `.material-gater.part` 临时文件并续传
- 按日期生成虚拟素材库，优先使用符号链接，失败时回退硬链接
- Portable 数据策略：Windows Portable 包的数据位于程序旁的 `MaterialGaterData`；开发模式数据位于 `portable-data`
- 所有索引和链接操作均不修改、不删除源素材

## 本地开发

需要 Node.js 20 或更高版本、Rust stable 工具链，以及对应平台的 Tauri 2 系统依赖。macOS 需要 Xcode Command Line Tools；Windows 需要 Microsoft C++ Build Tools 与 WebView2。

安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup component add rustfmt clippy
```

```bash
npm install
npm run dev
```

运行检查：

```bash
npm test
npm run check
```

## 打包

在目标平台运行：

```bash
npm run dist
```

- macOS 产物：原生 App、DMG 与 CI 生成的 ZIP
- Windows 产物：Portable EXE 与 NSIS 安装包

推送形如 `v0.7.0` 的版本标签后，GitHub Actions 会分别在 macOS arm64 与 Windows x64 托管运行器中安装 Rust、执行 TypeScript/Rust 检查和单元测试，再把 DMG、ZIP、Portable EXE 和 NSIS 安装包汇总到同一个 GitHub Release。也可以在 Actions 页面手动运行工作流，只生成可下载的 CI 构建产物而不发布 Release。

未签名的本地构建可能被 Gatekeeper 或 SmartScreen 提示。正式发布时需配置 Apple Developer ID 和 Windows 代码签名证书。

## Windows 链接说明

Windows 创建跨磁盘符号链接通常需要开启“开发人员模式”或以管理员身份运行。若素材源与输出目录位于同一文件系统，应用会自动尝试硬链接；跨磁盘且无符号链接权限时，该文件会记录为失败，绝不会静默复制原片。

## 数据安全

Material Gater 只读取源素材。生成素材库时，它仅删除目标位置上将被重新生成的同名链接，并在输出根目录写入 `.material-gater.json` 清单。删除映射并选择清理链接时，程序只按这份清单移除它管理的文件；目录中存在用户文件时会保留目录。建议始终为原始素材保留独立备份。

## License

MIT
