# 参与贡献

欢迎提交使用问题、Bug 复现与改进建议。请先说明 macOS 版本、芯片架构、PE Studio 版本、操作步骤和实际结果。涉及模型连接时，可提供服务商、准确 Model ID、协议与脱敏错误分类；请勿附上 API Key、认证文件或包含私人内容的完整运行日志。

## 本地验证

```sh
npm run install:ci
npm test
npm run typecheck
```

桌面相关变更还需在满足 [README 构建条件](README.md#从源码运行) 的 Mac 上运行：

```sh
npm run desktop:build
npm run desktop:start
```

提交 Pull Request 时请描述问题、改动后的行为，以及实际完成的验证。涉及 A/B/C 盲测时，确认本轮排序、单独重试、历史记录与评分仍按同一真实候选关联；涉及密钥保存时，不得将明文密钥写入历史、日志或导出文件。

生成目录、个人运行数据、`.env*` 真值和 `.openai` 部署元数据均不应提交。修改第三方内容时保留现有署名和许可证。
