# Language support

The repository landing page and technical documentation are English. The
[Chinese introduction](../README.zh-CN.md) covers setup and the data boundary.
The desktop overlay and settings are primarily Simplified Chinese. There is no
runtime language selector in this snapshot.

| Current control | English meaning |
| --- | --- |
| 设置 | Settings |
| 估时提供方 | ETA provider |
| 检查账户并开始 | Check account and start |
| 登录并开始 | Sign in and start |
| 保存并开始 | Save and start |
| 保存草稿 | Save draft |
| 启用提供方 | Activate provider |
| 合成试探 | Synthetic trial; may consume model allowance |
| 撤销估时授权 | Revoke estimator consent |
| 估时诊断 | ETA diagnostics |
| 暂停 | Pause HUD tracking |
| 继续 | Resume HUD tracking |

English documentation makes the research implementation inspectable before UI
localization is complete. A future bilingual interface should translate visible
labels and accessibility text together and preserve the meaning of consent and
account-state messages. Protocol keys and diagnostic codes should remain stable.

Estimator instructions are part of the predictive configuration. Their language
is independent of the display language. Translating them can change forecasts
and requires its own versioned evaluation. This source snapshot preserves the
original instructions, model configuration, and runtime logic. The paper's frozen
inputs and outputs retain their original language.
