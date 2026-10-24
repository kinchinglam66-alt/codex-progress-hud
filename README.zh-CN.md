# Codex Progress HUD

[English](README.md)

Codex Progress HUD 是一个 Windows 桌面伴侣程序，用于观察编程任务活动，展示
任务状态和预计剩余时间。它把可读执行记录、独立估时模型和考虑交付延迟的倒计时
连接起来，由用户选择是否授权估时。

项目由独立研究者开发，与 OpenAI 无隶属关系。目前桌面界面主要为简体中文，
公开入口和技术文档以英文为主。本轮保留现有界面与估时行为，并提供
[控件中英对照](docs/LANGUAGE.md)。

## 本次源码版本

`research-release-2026-10-24` 基于上游提交
`40b81e6bb8f23cd25bcfac3f7c5106b0d3ad58f7`，增加公开说明和离线示例。
包内版本号仍为 `0.2.1`；精确版本以源码提交和文件清单为准。
[研究对应说明](docs/RESEARCH-ARTIFACT.md) 区分框架源码、论文实验工具和数值复算包。

这是源码发布，目前没有随包提供 Windows 安装程序。请先使用源码流程。
未来发布安装包时，伴侣程序、插件和校验文件必须来自同一版本。

## 从源码开始

准备 Windows 10/11 x64、Git 和 Node.js 22.13.0 或以上版本，在源码根目录执行：

```powershell
npm ci
npm run build
node examples/offline-countdown.mjs
```

离线示例使用合成数字，调用实际倒计时组件，不读取对话、不登录、不请求模型。
随后可运行 `npm run start:hud` 打开伴侣程序。插件连接与源码/安装包入口的区别见
[Windows 安装说明](docs/INSTALL-WINDOWS.md)。

## 使用与数据处理

打开“设置”，检查估时提供方、账户和用量说明，再决定是否授权。完整上下文估时
可能把可读的用户、助手和工具文本发送至所选提供方，任务文本不脱敏；估时和必要
的历史压缩会消耗订阅额度或 API 费用。授权前阅读 [隐私政策](PRIVACY.md)。

隐藏窗口或暂停任务追踪只影响 HUD，不会暂停 Codex 做题。撤销估时授权使用
“撤销估时授权”；插件是否启用由 Codex 的插件页面控制。

## 与论文的关系

框架实现支持观察、输入截断、预测、交付和评估。论文比较的是特定信息包、时点和
交付规则，不代表安装后的所有模型配置都达到某个统一准确度。代码测试通过也不等于
估时准确度经过验证。具体边界见 [已知限制](docs/KNOWN-LIMITATIONS.md)。

可从[研究材料目录](research/eta-v1.7/README.md)查看数值、复算程序、实际估时提示词、
输入构造器、结构审计与协议说明，并从
[研究版本 Release](https://github.com/kinchinglam66-alt/codex-progress-hud/releases/tag/research-release-2026-10-24)
下载独立包。完整任务文本和执行输出仍未公开，因此结构审计不等于完整语义复核。
本次框架源码也不是全部历史实验的唯一运行版本。预印本正文另行发布。

## 开发与许可

执行 `npm test -- --run --maxWorkers=1 --no-file-parallelism`、`npm run typecheck`、
`npm run build` 和 `npm run validate:plugin` 进行相应检查。
框架与补充程序使用 Apache-2.0，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)；研究目录内
整理后的数值与说明材料使用 CC BY 4.0，具体以各包许可范围为准。引用时使用
[CITATION.cff](CITATION.cff)，并记录实际提交或源码快照标识。
