# 工程结构

```text
src/             TypeScript 游戏模块和扩展入口
extension/       Manifest V3 清单、后台脚本；content.js 由构建生成
demo/            本地演示页面
tests/           自动化回归测试和浏览器验证页面
tools/           本地开发服务器
docs/            公开设计与接入文档
.github/         GitHub Actions 构建与测试
```

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `scanner.ts` | 读取当前可见 DOM / CSS，分批收集轮廓候选 |
| `geometry.ts`、`contour-selection.ts` | 几何归并、重复内圈清理、有效轮廓选择与数量统计 |
| `contours.ts` | 空心外框、入口、碰撞边界及落脚面 |
| `dimensions.ts` | 人物站立、蹲姿和身体宽度的统一尺寸 |
| `physics.ts` | 固定步长移动、跳跃、墙跳、蹲行和碰撞 |
| `planner.ts` | 使用游戏物理采样动作连接，选择起终点与验证路线 |
| `fallback.ts` | 普通地形不足时，有限尝试辅助落脚平台 |
| `renderer.ts` | Canvas 绘制人物、地图、旗标和动作反馈 |
| `page-watch.ts` | 事件驱动的页面布局变化检查 |
| `scheduling.ts` | 分批让出浏览器执行与生成取消 |
| `index.ts` | 公开 API、控件、输入、生命周期与统计 |
| `extension.ts` | 点击注入后的挂载 / 移除切换 |

## 数据流

```text
当前可见 DOM
    → 轮廓候选
    → 清理、归并与选择
    → 开口、碰撞边界与落脚面
    → 使用同一套物理规则模拟动作
    → 随机选择有效起终点
    → 固定步长更新 + Canvas 绘制
```

规划与运行共用 `stepPlayer()`，因此人物动作或碰撞的修改需要同时验证选关。扫描器是页面几何来源，渲染器负责表现，替换画面来源时应避免把平台相关代码混入绘制。

物理使用 1/60 秒固定步长，绘制由 `requestAnimationFrame` 调度。生成阶段可异步让出执行，取消过期结果；正常运行不逐帧扫描 DOM。布局失效时重新生成，销毁时释放全部游戏资源。

## 构建边界

`tsc` 输出可直接导入的 ES Module 和类型声明；`esbuild` 将扩展入口打包为单个浏览器脚本。二者都是开发依赖，游戏运行时没有第三方依赖。

源码和锁文件用于复现构建；`dist/`、`extension/content.js` 和依赖目录不纳入版本控制。克隆仓库后执行 `npm ci` 与 `npm run build` 即可生成运行文件。
