# 部署说明

本文提供两种部署方式。请选择其中一种即可。

- **方式一：从公开 GitHub 仓库克隆**。适合需要持续更新代码、查看提交记录或参与协作的情况。
- **方式二：使用完整本地交付包**。适合只需要在本机复现当前运行环境、个人自选和测试数据库的情况。

项目仓库：[https://github.com/zhangshaojieee-hash/stock_tracking](https://github.com/zhangshaojieee-hash/stock_tracking)

## 方式一：从公开仓库克隆

### 1. 前置环境

Windows 建议准备：

- Git：[https://git-scm.com/download/win](https://git-scm.com/download/win)
- Python 3：[https://www.python.org/downloads/](https://www.python.org/downloads/)
- 安装 Python 时勾选 `Add python.exe to PATH`

Ubuntu/Debian 可以直接使用仓库中的 `install.sh`。

### 2. Windows 安装

推荐直接运行仓库提供的一键安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/zhangshaojieee-hash/stock_tracking/main/install.ps1 | iex"
```

脚本会完成以下操作：

1. 将仓库克隆到 `%USERPROFILE%\macd-monitor`。
2. 安装 Python 依赖 `requests`。
3. 根据 `config.example.json` 创建本地 `config.json`。
4. 执行状态报告检查安装结果。

### 3. 不安装 Git：下载 ZIP 后双击安装

如果同事不想安装 Git，可以在 GitHub 点击 **Code → Download ZIP**：

1. 解压 ZIP 文件。
2. 打开解压后的仓库根目录。
3. 双击 `install-from-zip.bat`；也可以双击普通的 `install.bat`，它会自动识别 ZIP 解压目录。
4. 安装器直接使用 ZIP 解压后的目录，创建同级 `.venv`，安装 `requests`，生成 `macd-monitor\config.json`，后台启动监控和 Web UI，并自动打开 `http://localhost:8688/`。

这种方式只需要提前安装 Python 3，并在安装时勾选 `Add python.exe to PATH`。安装器会复用已有 `.venv`，不重复升级 pip；依赖默认从较快的镜像安装，失败时自动回退官方源。重复运行不会覆盖解压目录中的 `config.json`、`data.db`、`state.json`、模型和日志。需要指定公司内网镜像时，可在 PowerShell 中先设置 `$env:PIP_INDEX_URL` 再运行安装器。

安装器会从示例配置生成默认配置。首次使用前，请编辑解压目录下的 `macd-monitor\config.json`，填写自己的股票和可选的飞书机器人配置。虚拟环境位置为解压目录下的 `.venv`。

也可以在 PowerShell 中运行：

```powershell
Set-Location "解压后的仓库目录"
.\install-from-zip.ps1
```

也可以手动执行：

```powershell
git clone https://github.com/zhangshaojieee-hash/stock_tracking.git "$env:USERPROFILE\macd-monitor"
Set-Location "$env:USERPROFILE\macd-monitor\macd-monitor"
python -m pip install requests
Copy-Item config.example.json config.json
```

然后编辑 `config.json`，按实际需要填写飞书机器人配置和自选股列表：

```json
{
  "webhook_url": "",
  "webhook_secret": "",
  "webui": {
    "auth_token": ""
  }
}
```

### 3. 启动服务

在 `macd-monitor` 目录执行：

```powershell
python monitor.py
```

另开一个 PowerShell 窗口启动 Web UI：

```powershell
Set-Location "$env:USERPROFILE\macd-monitor\macd-monitor"
python webui.py
```

浏览器访问：[http://127.0.0.1:8688/](http://127.0.0.1:8688/)

也可以使用仓库中的 `启动MACD网站.bat`，但首次使用前应先确认 Python、配置文件和依赖已经准备完成。

### 4. 更新代码

如果本地没有未提交修改，可以执行：

```powershell
Set-Location "$env:USERPROFILE\macd-monitor"
git pull --ff-only
```

如果本地修改过代码或配置，不要直接覆盖。先备份 `config.json`、`data.db` 和个人运行数据，再根据 Git 输出处理更新。

## 方式二：使用完整本地交付包

此方式用于复现当前已经运行过的完整环境，包含：

- 当前源码
- `config.json`
- 个人自选股配置
- 完整 SQLite 测试数据库
- 模型、行情缓存和其他测试运行数据

完整数据库接近 2GB，未放入公开 GitHub 仓库。交付包不要上传到公开网盘或聊天群。

### 1. 接收文件

请让交付方提供以下文件：

- `stock_tracking-private.part001` 到最后一个分卷
- `JOIN_AND_VERIFY.ps1`
- `SHA256SUM.txt`

将全部文件放在同一个目录，例如：

```text
D:\stock_tracking-private-package-parts\
  stock_tracking-private.part001
  stock_tracking-private.part002
  ...
  JOIN_AND_VERIFY.ps1
  SHA256SUM.txt
```

### 2. 合并并校验

在该目录打开 PowerShell：

```powershell
Set-Location D:\stock_tracking-private-package-parts
.\JOIN_AND_VERIFY.ps1
```

脚本会合并分卷并校验 SHA-256。校验通过后会生成：

```text
stock_tracking-private.tar
```

解压：

```powershell
tar -xf .\stock_tracking-private.tar
```

### 3. 恢复运行环境

解压后通常包含：

```text
PACKAGE_README.txt
source\
runtime\
```

执行以下复制操作：

```powershell
$source = "D:\stock_tracking-private-package\source"
$runtime = "D:\stock_tracking-private-package\runtime"
$target = "D:\macd-monitor"

New-Item -ItemType Directory -Force $target | Out-Null
robocopy $source $target /E
Copy-Item "$runtime\config.json" "$target\macd-monitor\config.json" -Force
Copy-Item "$runtime\data.db" "$target\macd-monitor\data.db" -Force
```

如需复现同一测试环境，再按需要复制 `runtime` 中的模型、缓存和状态 JSON 文件：

```powershell
Get-ChildItem $runtime -File |
  Where-Object { $_.Name -notin @('config.json', 'data.db') } |
  Copy-Item -Destination "$target\macd-monitor" -Force
```

然后安装依赖并启动：

```powershell
Set-Location "$target\macd-monitor"
python -m pip install requests
python monitor.py
```

另开一个 PowerShell 窗口启动 Web UI：

```powershell
Set-Location "$target\macd-monitor"
python webui.py
```

浏览器访问：[http://127.0.0.1:8688/](http://127.0.0.1:8688/)

## 选择建议

| 场景                           | 推荐方式               |
| ------------------------------ | ---------------------- |
| 只需要运行当前版本和测试数据库 | 方式二：完整本地交付包 |
| 同事不想安装 Git               | 方式一：下载 ZIP 双击安装 |
| 需要持续获取代码更新           | 方式一：公开仓库克隆   |
| 需要提交代码或参与协作         | 方式一：公开仓库克隆   |
| 需要保留当前个人自选和数据库   | 方式二：完整本地交付包 |

## 配置、数据和许可证

### 不要提交到公开仓库的内容

以下文件只应保存在本机或公司受控存储中：

- `macd-monitor/config.json`
- `macd-monitor/data.db`
- `macd-monitor/data.db-*`
- `macd-monitor/state.json`
- `macd-monitor/kline_cache.json`
- `macd-monitor/model.json`
- 日志、缓存、个人自选和其他运行时文件

特别是 `config.json` 中的飞书 Webhook、密钥和 Web UI 访问令牌，不要提交到公开 GitHub、Issue、Pull Request 或普通聊天群。

### 许可证和上游来源

本项目基于 [https://github.com/huigezhi/stock_tracking](https://github.com/huigezhi/stock_tracking)，上游使用 Apache License 2.0。使用、修改或转发时请保留：

- 根目录 `LICENSE`
- 根目录 `THIRD_PARTY_NOTICES.txt`
- README 中的上游来源和修改说明

本地交付包虽然不通过 GitHub 分发，也必须保留这些文件。
