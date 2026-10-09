# 贡献指南

感谢对 Edgekin 的关注。问题、玩法建议和代码改进均可通过 GitHub Issues / Pull Request 提交。

## 开发环境

使用 Node.js 22 或更高版本：

```sh
npm ci
npm run build
npm run serve
```

修改后运行：

```sh
npm run check
npm test
```

修改扩展时还需重新构建，在浏览器扩展管理页重新加载，并刷新测试网页。`npm run dev` 只持续编译核心模块。

## 改动原则

- 保持轻量，新增运行时依赖前先说明必要性和体积影响。
- 人物尺寸由 `dimensions.ts` 统一定义；规划和实际游戏共用物理规则。
- 修复碰撞或可达性问题时，用完整碰撞世界重放动作，不只检查规划器返回的标记。
- 修改扫描规则时同时检查清理结果、有效轮廓总数与复杂度分母。
- 保持暂停、输入焦点、重复挂载和销毁时的资源释放。
- 行为改变应更新相应公开文档和 `CHANGELOG.md`；回归测试应覆盖真实风险。

## 浏览器验证页面

启动开发服务器后，打开下列路径：

| 路径 | 检查内容 |
| --- | --- |
| `/` | 演示、基础跑跳 |
| `/tests/browser-harness.html` | 挂载、销毁和宿主输入焦点 |
| `/tests/contours-harness.html` | 嵌套卡片、圆形图标和随机开口 |
| `/tests/controls-harness.html` | 组合按钮、反应条、控件内部图标清理 |
| `/tests/coverage-harness.html` | 有效轮廓覆盖统计 |
| `/tests/actions-harness.html` | 蹲行、墙跳、竖向路线和布局变化；建议 1920×1080 |
| `/tests/performance-harness.html` | 300 个有效候选、240 个运行轮廓的压力场景 |
| `/tests/arbitrary-dense.html`、`/tests/arbitrary-sparse.html` | 密集与稀疏页面布局 |

自动化回归不代替真实网页试玩。报告性能时请注明设备、浏览器、视口和测量方式，区分生成耗时与运行帧率。

## 提交问题

请包含版本、浏览器版本、视口尺寸、可访问的复现页面或最小 HTML、操作步骤、预期与实际结果。可以附 `getMapStats()` 的统计；截图需遮盖账号、私信、访问令牌等私人信息。

提交内容请聚焦复现问题所需的源码、测试和文档。依赖、构建输出、调试缓存、浏览器个人资料、凭据和私人网页截图不应进入提交。

## 版本

版本号由 `package.json`、锁文件根包和 `extension/manifest.json` 共同维护。发布标签使用 `vX.Y.Z`；每次发布记录实际完成的功能与已知边界。计划中的玩法应明确标为未实现。

贡献代码按仓库的 [MIT 许可证](LICENSE) 提供。
