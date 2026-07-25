# Material Gater

Material Gater 是一款面向摄影、影视工作流的轻量跨平台素材门卫。它识别插入的 SD 卡或 SSD，建立本地索引，再按文件类型和拍摄日期生成一个干净的虚拟素材库，供 Premiere Pro、DaVinci Resolve、Final Cut Pro 等剪辑软件直接读取。

> 当前版本：`0.3.0` MVP。支持 macOS 与 Windows，界面语言为简体中文。

## 功能

- 每 4 秒自动发现 macOS `/Volumes` 下的外置盘及 Windows 可移动/本地盘
- 紧凑的三栏管理器界面，自动跟随系统浅色或深色主题
- 内置思源黑体可变字体，离线运行时也能保持一致排版
- 手动选择任意素材目录
- 点击素材盘快速预览已索引内容，支持名称、类型和日期过滤
- 递归识别常见视频、音频、照片及 RAW 格式
- 素材浏览支持紧凑列表和按真实目录层级展开的树形列表
- 本地 JSON 索引，统计素材数量、容量、拍摄日期和每日拍摄量
- 统计面板提供每日容量柱状图、文件类型容量饼图和筛选联动
- 按扩展名与日期范围筛选
- 保存和管理多个独立映射配置，记录每个映射的最近运行结果
- 映射可分别编辑、运行和删除，源素材索引在映射之间共享
- 按日期生成虚拟素材库，优先使用符号链接，失败时回退硬链接
- Portable 数据策略：Windows Portable 包的数据位于程序旁的 `MaterialGaterData`；开发模式数据位于 `portable-data`
- 所有索引和链接操作均不修改、不删除源素材

## 本地开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

运行检查：

```bash
npm test
npm run build
```

## 打包

在目标平台运行：

```bash
npm run dist
```

- macOS 产物：DMG 与 ZIP
- Windows 产物：Portable EXE 与 NSIS 安装包

未签名的本地构建可能被 Gatekeeper 或 SmartScreen 提示。正式发布时需配置 Apple Developer ID 和 Windows 代码签名证书。

## Windows 链接说明

Windows 创建跨磁盘符号链接通常需要开启“开发人员模式”或以管理员身份运行。若素材源与输出目录位于同一文件系统，应用会自动尝试硬链接；跨磁盘且无符号链接权限时，该文件会记录为失败，绝不会静默复制原片。

## 数据安全

Material Gater 只读取源素材。生成素材库时，它仅删除目标位置上将被重新生成的同名链接，并在输出根目录写入 `.material-gater.json` 清单。建议始终为原始素材保留独立备份。

## License

MIT
