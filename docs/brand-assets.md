# 模型品牌图形来源

以下图形仅用于标识用户选择的模型系列，不作为 PE Studio 的产品标志，也不表示厂商背书。应用只读取打包的本地文件，不会为了显示 Logo 访问外网。

| 本地文件 | 官方来源 | 处理 |
| --- | --- | --- |
| `public/brands/gpt.svg` | [OpenAI Agents SDK 官方文档](https://openai.github.io/openai-agents-python/assets/logo.svg) | 保留原始 SVG 与留白；浅色界面显示黑色，深色界面显示白色。 |
| `public/brands/claude.svg` | [Claude 官网](https://claude.com/) | 提取官网内联 SVG 中独立的星芒路径，保留原路径及 `#D97757` 颜色，使用该图形的 `125 × 125` 坐标范围。 |
| `public/brands/gemini.svg` | [Gemini 官网使用的 Google 静态资源](https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg) | 原样保存官方透明 SVG；该资源地址来自 `https://gemini.google.com/` 页面。 |

来源核实日期：2026-10-15。OpenAI 图形使用方式参考[官方品牌指南](https://openai.com/brand/)。未知或自定义模型不套用上述品牌图形。
