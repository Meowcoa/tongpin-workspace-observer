# 参与开发

请先阅读 README、AGENTS.md 和 docs/CONTINUING.md。当前桌面目标为 Windows x64，Node.js 版本见 `.nvmrc`，依赖以 `package-lock.json` 为准。

1. `npm ci`
2. `npm run check:source`
3. `npm test`
4. `npm run desktop:pack`
5. `npm run test:desktop`
6. `npm run verify:desktop`
7. `npm run distribution` and `npm run verify:distribution`

`release/` 是构建产物，`.work/` 是测试临时目录，二者均不提交。不要提交运行数据库、访问凭据、个人 MCP 配置、日志或本机路径。新增公开示例只使用占位符。

项目只观察项目文件。MCP 不应新增任意项目写入、删除、执行命令或选择根目录的能力。改动消息、租约、游标、身份或保留策略时，应覆盖实际协议调用和重启行为。

界面滚动改动必须同时检查独立文件预览和“改动记录中的长文预览 + 下方客户端”组合，包含桌面与窄屏。修改前读取相关实现，不覆盖其他人的改动。

提交 PR 时说明具体触发场景、修改后的行为、实际执行的验证及未覆盖的边界。由你新增的代码按本项目 MIT 许可证贡献；第三方代码应保留自己的许可证和出处。
