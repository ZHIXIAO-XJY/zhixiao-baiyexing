# ScriptBreaker · 视频分镜拆解台

纯前端（HTML/CSS/JS，零构建）的视频 → 分镜头脚本工具。浏览器内解码视频、检测切点、抽关键帧，调用多模态大模型逐镜生成描述，最后导出 Markdown / CSV / JSON。

可直接放在 GitHub Pages 上跑，没有后端、没有数据库，视频不会离开你的电脑。

---

## 0. 界面

深色剪辑台式布局：左栏是「视频源 / 字幕 / 参数 / 开始拆解」，右栏是「分镜头脚本」网格。

- **卡片**：关键帧 + 编号 + 时间码，正文可直接点开编辑，台词单独成块，运镜/声音做成 chips；构图/光线/眼神/表情折叠在「详情」里，点开才展开；
- **工具栏**：筛选（全部 / 有台词 / 无画面）+ 搜索 + 实时统计（镜头数、总长、均长）；
- **进度**：切镜 → 抽帧 → 分析 三段相位灯，分析时卡片先出骨架屏；
- **大图**：点卡片右上角 ⤢ 看关键帧原图；
- **响应式**：≥1100px 双栏、<1100px 单栏整页滚动，手机端操作按钮吸底；
- **多选与批量**：勾选卡片右上角 → 合并相邻镜头 / 在播放头拆分 / 批量补运镜与声音 / 删除（时间轴自动接续）
- **质检**：查时间轴空档与重叠、空字段、台词重复，可一键重排修复
- **快捷键**：空格 播放/暂停　← → 前后 1 秒　J / K 上一镜 / 下一镜　Esc 关闭弹层

## 1. 它怎么工作（5 步）

| 步骤 | 做的事 | 技术点 |
|---|---|---|
| ① 接入 | 文件拖入 / 本地选择 / 直链 | `URL.createObjectURL`，直链走 CORS 模式，失败自动降级并提示 |
| ② 切镜 | 按间隔采样，逐帧灰度差分找硬切点 | 160×90 降采样画布 + 自适应阈值（均值 + 分位数），可合并 <0.8 秒碎片 |
| ③ 抽帧 | 每个镜头取一张关键帧 | `<video>.currentTime` + canvas `toDataURL('image/jpeg', .72)`，宽 480 |
| ④ 分析 | 分批把「镜头号 + 起止时间 + 关键帧」发给多模态模型 | OpenAI 兼容 `chat/completions`；强制 JSON 数组输出；失败自动重试一次 |
| ⑤ 导出 | 表格化输出，可在线改 | Markdown / CSV（带 BOM，Excel 直接开）/ JSON |

**关键设计**：时间码由**前端检测结果**决定，不让模型编；模型只负责「画面里是什么、谁在说话、怎么运镜」。

---

## 2. 快速开始

### 本地

```bash
# 必须用 HTTP 打开（ES Module 不支持 file://）
python -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080
```

### GitHub Pages

```bash
git init
git add .
git commit -m "ScriptBreaker"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

仓库 → Settings → Pages → Source 选 `main` / `/ (root)` → 保存。
几分钟后访问 `https://<you>.github.io/<repo>/`。

> `.nojekyll` 已就位，避免 GitHub 的 Jekyll 处理干扰静态资源。
> 全部用相对路径，放在子目录（如 `/<repo>/`）也能正常工作。
> 深链：`?demo=1` 直接打开演示数据（分享界面用）；`?panel=settings` 直接弹出模型设置。

---

## 3. 模型接入

### 默认：DeepSeek-V4.1-Flash（视觉）

```js
{
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com/v1',
  model_name: 'deepseek-flash',   // 即 DeepSeek-V4.1-Flash
  effort: 'high',                 // low / high / max
  vision: true
}
```

- 官方模型列表里，`deepseek-flash` 的 `input_modalities` 含 `image`，所以能直接吃关键帧；
- `deepseek-v4-pro` 只有文本输入，选它就要把「模型支持图像」关掉；
- 上下文 1M，几十张 480px 关键帧完全放得下。

### 切换到别家

设置面板支持四类：DeepSeek / OpenAI 兼容 / Anthropic / Ollama 本地。
OpenAI 兼容只需填 Base URL + 模型名，Anthropic 走 `x-api-key` + `anthropic-version` 头，Ollama 默认 `http://localhost:11434/v1`。

### ⚠️ 密钥安全（必读）

仓库里**不含任何真实 Key**。`assets/config.js` 默认 `api_key: ''`，三种填法：

1. **本地调试**：把 `assets/config.example.js` 复制成 `assets/config.local.js`，写入自己的 Key。
   该文件已在 `.gitignore` 里，不会被提交；页面启动时自动读取。
2. **线上访客**：在「模型设置」里自己填 Key（存本机 `localStorage`）。
3. **公开演示站**（推荐）：用一个 Cloudflare Worker 代理，Key 放服务端环境变量。

   本站已部署一份：`https://scriptbreaker-proxy.805352942.workers.dev`（口令 `白夜行`）。在「模型设置」里点 **「用本站代理」** 即填好（Base URL 带 `/v1`、API Key 填 `proxy`、口令自动填）。

   > ⚠️ `*.workers.dev` 在中国大陆被 DNS 污染，直连不通。应用启动时会探测一次：
> - 通 → 直接用代理，零配置；
> - 不通 → 顶部弹出提示，一键「切到官方接口」，粘贴一次自己的 Key 即可（`api.deepseek.com` 国内直连可用）。
>
> 想让代理在国内也可用，需要给 Worker 绑自有域名，或把 `worker/worker.js` 部署到国内环境。详见 `worker/README.md`。

   口令（`PASSCODE`）只防脚本白嫖：它在静态代码里可见，不构成强安全。要更严就改成只有你知道的值，并在设置里同步。


```js
// worker.js —— 部署后把 Base URL 改成 https://<你的>.workers.dev/v1
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const body = await req.text();
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_KEY}` },
      body
    });
    return new Response(r.body, { status: r.status, headers: { ...cors(), 'Content-Type': 'application/json' } });
  }
};
const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
});
```

---

## 4. 输出格式

```markdown
# Video Script Analysis Report

**Source File:** demo_鞋刷.mp4
**Generated Time:** 2026/11/17 20:45:12
**Model Used:** deepseek-flash
**Duration:** 00:07:28　**Resolution:** 544×960　**Shots:** 24

| Shot ID | Timecode | Visual Description | Dialogue / Narration | Camera Movement | Audio / SFX |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 001 | 00:00:00 - 00:00:13 | 雨后的老巷，地面积水映着路灯…… | 谁家的野孩子，破车横在路中间…… | 大远景起幅，切司机中景 | 雨滴声、引擎怠速 |
```

用到多模态时，还会自动追加 4 列扩展字段：`Composition`（构图）、`Lighting`（光线）、`Eye Contact`（眼神交互）、`Emotion Arc`（表情轨迹）。

CSV 版同列，带 UTF-8 BOM；JSON 版含 `meta` + `timecode.startSec/endSec`，方便二次处理。

---

## 5. 和《视频脚本逆向工程》方法论的对齐

这份实现是把 `video-script-reverse-engineering` 技能的流程搬到浏览器里，能对齐的都对齐了：

| 方法论 | 本应用对应的做法 |
|---|---|
| P0 素材探针 | 加载即读时长/分辨率，采样间隔按时长自适应（≤1min 用 0.5s，≤10min 用 2s） |
| P2 网格抽帧控成本 | 先切镜再抽帧：**一镜一帧**，不是每秒一帧；每批 6 帧，控制 token |
| P3.5 字幕是文本真值 | 「字幕」面板：粘贴烧录字幕/SRT 后，台词以字幕为准，模型只补画面描述；模型输出 `dialogue=null` 时用字幕兜底 |
| 铁律①台词零清洗 | Prompt 里写死「一字不差照抄，看不清写 null，禁止编造」 |
| 铁律②眼神具名 | 扩展字段 `gaze` 要求写「谁看谁、看哪个部位、停留多久」 |
| 铁律③表情轨迹 | 扩展字段 `emotion` 要求「起→中→末」，禁止单一形容词 |
| P8 瑕疵扫描 | 导出前做机械校验：镜头区间连续、字段非空、台词去重（在导出器里做） |
| 声音层 | 浏览器做不了 ASR，所以 `audio` 只写「能从画面推断的」，推断不出就写「无法从画面判断」 |

**有意没做的**：浏览器端语音识别（模型太大）、逐句口型裁决（需要人眼）、ASR 对齐。这三件事仍然要在本地用 DSH + whisper 做，做完可以把台词粘进「字幕」面板。

---

## 6. 目录结构

```
scriptbreaker/
├── index.html            界面结构
├── assets/
│   ├── styles.css        深色主题 + 响应式
│   ├── config.js         默认模型配置与预设（含演示 Key，注意安全）
│   ├── cv.js             视频探针 / 切点检测 / 关键帧抽取
│   ├── providers.js      OpenAI 兼容与 Anthropic 的统一调用层
│   ├── prompt.js         系统提示词、分批消息、JSON 解析、字幕解析
│   ├── exporter.js       Markdown / CSV / JSON 导出
│   ├── qc.js             镜头纯函数：合并/拆分/删除/质检/重排
│   ├── app.js            状态管理与界面交互
│   ├── config.local.js   ← 本地 Key（gitignore，不存在时自动跳过）
│   └── config.example.js 本地配置模板
├── test.mjs              纯函数单测（44 项）
├── e2e.mjs               真实 API 端到端测试（3 帧 → 模型 → 解析）
├── worker/               Cloudflare Worker 代理（Key 放服务端）
│   ├── worker.js
│   └── wrangler.toml
├── .gitignore            排除 config.local.js
├── .nojekyll
└── README.md
```

## 7. 已验证

| 项目 | 结果 |
|---|---|
| 静态资源 | 9 个文件 HTTP 200，MIME 正确（`text/javascript` / `text/css`） |
| 单元测试 | `test.mjs` **59 项全通过**（切镜、JSON 容错与截断修复、SRT 解析、导出、端点拼接、合并/拆分/删除/质检、档案汇总） |
| 真实 API | `e2e.mjs` 用 3 帧 → 提示词 40.8 KB → 8.4 秒返回 → JSON 解析成功，usage 2311 tokens |
| 视觉能力 | 官方模型列表中 `deepseek-flash` 的 `input_modalities` 含 `image`，实测可读视频截图里的烧录字幕 |
| 浏览器兼容 | Edge/Chromium 无 JS 报错；移动端走单列布局 |

> 顺带发现：`deepseek-flash` 认字幕的能力可用于校对。用它读 07:28 那支片的截图，把「我没穷穿这身旧工装回来」读成「我没穿这身旧工装回来」，和 whisper 的判断一致。

## 8. 角色提示（可选但强烈建议）

在「拆解参数」下面有一栏「角色提示」，一行一个：

```
霍征＝男主，车队老板，深灰牛仔夹克
柳清禾＝女主，皮具手艺，酒红盘扣外套
霍家男孩＝6-7 岁儿子
```

模型会优先用这些称呼，而不是编成「穿黑色大衣的男子」。这条同时作用在镜头的画面描述和顶部的角色档案上。

## 9. 档案与结构

拆完镜头后会再发一次**纯文本**请求，把整片归纳成三块，渲染在脚本区顶部（可直接改）：

- **角色档案**：身份、外形识别要素、说话特点（对应「面孔+造型+场景关系」三重锁定）
- **剧情结构**：时间区间 + 段落功能
- **表演与剪辑要点**：可复制的做法

导出 Markdown 时会插在表格前面；JSON 里是 `extras` 字段；CSV 仍是纯表格。面板右上角「重新生成」可以单独重跑这一步。

## 10. 多文件队列

一次选多个视频（或一次拖多个文件），它们会进左边的队列，点「跑队列」按顺序处理：

- 每行显示 等待 / 处理中 / 完成 / 失败；
- 跑完的文件可以单独「下载」它的 Markdown；
- 队列是串行的，避免同时跑多个把浏览器和接口都拖垮。

## 11. 质量优先的重试

不做“省 token”的折中，失败就往高质量重试：

| 情况 | 处理 |
|---|---|
| 某批返回的不是 JSON | 带着它的原文再要一次，`effort: high` + 16384 tokens |
| 某镜画面/运镜为空，或整批解析失败 | 拆成单镜重跑，`effort: max` + 16384 tokens |
| 汇总（档案）失败 | 重试一次；仍失败就跳过汇总，不影响镜头表与导出 |

## 12. 逐镜编辑

| 操作 | 说明 |
|---|---|
| 多选 | 勾选卡片右上角；选中后底部出现操作条 |
| 合并 | 只允许时间上首尾相接的镜头，合并后台词自动拼接 |
| 拆分 | 播放器停在目标时间点，点「在播放头拆分」；右侧新镜自动抓一张关键帧 |
| 批量补字段 | 给选中镜头统一填运镜/声音；可勾选「仅填空」不覆盖已有内容 |
| 删除 | 删除后自动把空档并给左边镜头，保持时间轴连续 |
| 质检 | 时间轴空档/重叠、空字段、重复台词；可一键重排修复 |

## 13. 测试

```bash
node test.mjs      # 59 项纯函数单测：切镜、JSON 容错、字幕解析、导出、端点拼接、合并/拆分/删除/质检
node e2e.mjs       # 真实调用 DeepSeek：3 帧 → 提示词 → JSON 解析（约 8 秒，需要本地 Key）

# 命令行整片跑（需要本地 Key）
node demo-run.mjs <video> 0 448 6            # 起始/时长/抽帧间隔
node finish-run.mjs out.shots.json out.md    # 已有镜头数据时补汇总、导出，不重复烧 token
```

## 14. 已知限制

- 浏览器只能解码系统支持的编码；HEVC 在部分 Windows 上放不了，建议先转 H.264。
- 跨域直链大概率取不了帧（画布污染），请下载后上传。
- 长视频（>15 分钟）采样上限 900 帧、镜头上限 160，会自动抽样并提示。
- 模型看到的是离散关键帧，镜头内的连续运动、画外音、真实音效只能推断。
- 演示 Key 额度有限，且会被公开，请勿用于生产。

## 15. 许可

自用项目，随代码附带，不提供任何担保。
