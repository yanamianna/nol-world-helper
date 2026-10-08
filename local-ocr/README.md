# 本地图片文字识别

扩展使用 ddddocr 生成 6 位英文字母候选，你核对后手动提交给官网。它不保证识别准确，也不代表官网已经验证成功。

## Windows 安装与启动

1. 安装 64 位 Python 3.10 或更新版本，并勾选 `Add Python to PATH`。官方 PyPI 声明支持 Python 3.10–3.13；上游 README 的旧环境表仍写最高 3.12，如安装失败请以安装结果为准。
2. 双击 `安装本地识别.cmd`。首次从官方 PyPI 下载 ddddocr 模型和依赖，可能需要几分钟。
3. 双击 `启动本地识别.cmd`，看到“本地 OCR 已就绪”后保持窗口运行。关闭窗口或按 `Ctrl+C` 即停止。
4. 在扩展里启用本地识别，并按界面提示授权连接本机服务。识别候选只供核对，官网验证码由你提交。

PowerShell 也可以执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\local-ocr\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\local-ocr\start.ps1
```

脚本只为此文件夹创建 `.venv`，不修改系统 Python，不设置开机启动，不关闭证书校验。若网络下载失败，检查本机网络后重新安装。

## 数据与接口

服务仅绑定 `127.0.0.1:8765`，不会监听局域网。模型启动时初始化并预热一次，后续串行复用，识别过程离线运行。图片、候选、请求和认证信息不写文件、不写日志；服务不接收账号、会话或支付数据，不访问官网或任意 URL。

所有请求必须带 `X-NOL-Extension-Id: <32位扩展ID>`。存在 `Origin` 时必须为同一 ID 的 `chrome-extension://` 来源，其他网页来源、`null` 来源和缺少扩展头的请求均拒绝。该头是本机请求隔离措施，不能阻止已经控制本机的程序伪造请求。

| 接口 | 请求 | 结果 |
| --- | --- | --- |
| `GET /health` | 扩展识别请求头 | 就绪状态、引擎版本 |
| `POST /recognize` | `application/json`，`{"image":"纯Base64"}` | `recognized`、`candidate`、规范化 `raw`、`confidence: null` |

只接受单帧 PNG、JPEG、WebP；JSON 最大 512 KB，解码图片最大 384 KB，尺寸最大 1024 × 512，宽高之比不超过 20 倍。只返回恰好 6 位大写英文字母的候选；其他结果返回 `recognized: false`，由你手动输入。不会循环重试或刷新验证码。

## 验证与已知限制

```powershell
python -m unittest discover -s local-ocr/tests -v
```

测试使用内存生成的图片和假 OCR 引擎，验证请求隔离、图片格式/尺寸校验、错误处理及并发限制。它不验证真实 NOL 验证码的准确率。真实验证码与官网接受结果尚需用户在正常购票流程中验证。

本次在 Windows 64 位 Python 3.13.12 上完成真实模型和依赖安装，并通过 19 项上述测试。用本机内存生成的 Arial 字体 `ABCDEF` 图片验证，返回候选 `ABCDEF`。这只验证本地运行及一张合成样图，不能作为 NOL 验证码准确率。安装脚本保留证书校验；服务未就绪时，请继续手动输入验证码。

固定依赖版本为 `ddddocr==1.6.1`、`Pillow==12.3.0`，依据 2026-10-08 官方元数据核对；其他传递依赖由 pip 解析。本次实际环境另包含 `onnxruntime==1.30.0`、`numpy==2.5.3`、`opencv-python==5.0.0.93`。

模型使用默认 CPU 配置，通过官方 `set_ranges` 保留大小写英文字母，服务统一转为大写。合成样图实测中，只保留大写范围会将模型识别为小写的字母过滤掉。已核对 1.6.1 官方 wheel 源码：普通文字输出先取最高概率字符，再按范围过滤，不会按受限字母范围重新计算候选。服务不截断或删除引擎返回的字符，完整结果再次通过 `[A-Z]{6}` 校验才作为候选；这只能校验格式，不能保证与图片一致，必须人工核对。

参考：[ddddocr 官方仓库](https://github.com/sml2h3/ddddocr)、[ddddocr PyPI](https://pypi.org/project/ddddocr/)、[Pillow PyPI](https://pypi.org/project/pillow/)。
