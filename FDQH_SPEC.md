# FDQH — FosunDx Quality Hub 技术规格书 (Specification)

**版本**: v2.20.0  
**日期**: 2026-08-08  
**仓库**: FXQH12914/fdqh-app  
**部署**: https://fdqh-app-production.up.railway.app/

---

## 1. 系统概述

FDQH (FosunDx Quality Hub) 是复星诊断 IVD 数字化质量管理平台，覆盖体外诊断试剂及仪器的**全生命周期质量管理**。平台以 PLM 7阶段（立项→设计开发→注册→转产→量产→上市→退市）为主线，集成质量控制点（QCP）字典、产品主数据、批次质量护照、质量事件管理、CAPA、变更控制、AI 风险预测、审计追踪等模块。

### 核心能力

| 能力域 | 说明 |
|--------|------|
| 📊 驾驶舱 | Q-KPI 六维质量指标 + 产品风险矩阵 + AI预警 |
| ⚠️ 质量事件 | 偏差/OOS/OOT/投诉 四分类看板 + AI风险预测 |
| 🔧 CAPA管理 | 纠正预防措施 + 审核来源分组 + 有效性验证 |
| 🔗 全生命周期 | PLM 7阶段 + 6产品线视图 + 统一风险管理 |
| 🔄 变更控制 | 设计/工程变更 I/II/III分级 + 操作指南提示卡 |
| 🎯 控制点库 | 640+ QCP（覆盖化学发光/胶体金/分子） |
| 🤖 AI助手 | 质量专家问答 + CAPA根因分析 + 风险预测 |

---

## 2. 技术架构

### 2.1 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 运行时 | Node.js | JavaScript 服务端 |
| Web框架 | Express.js 4.x | REST API + 静态文件服务 |
| 数据库 | MongoDB (主) / JSON文件 (降级) | 通过 MONGODB_URI 环境变量切换 |
| 认证 | Session Token (crypto.randomBytes) | 24小时过期，内存存储 |
| 密码 | bcryptjs | 加盐哈希 |
| 文件解析 | xlsx (SheetJS) | Excel 导入/导出 |
| 文件上传 | multer | 内存存储，10MB限制 |
| 前端 | 原生 JavaScript + Chart.js | SPA 单页应用 |
| AI | Qwen (主) / DeepSeek (备) | 质量专家/知识/CAPA根因/风险预测 |
| 部署 | Railway.app | GitHub 自动部署 |

### 2.2 代码规模

| 文件 | 行数 | 大小 | 说明 |
|------|------|------|------|
| `server.js` | 3,493 | 188 KB | 主服务端，含85个API端点 |
| `public/js/app.js` | 2,944 | 170 KB | 前端主逻辑 |
| `public/index.html` | 459 | 27 KB | SPA 单页面 |
| `public/js/ai-chat.js` | 752 | 24 KB | AI 聊天组件 |
| `public/css/style.css` | 445 | 24 KB | 主样式 |
| `database/init.js` | 496 | 50 KB | 数据库引擎 + 种子数据 |
| `ai/index.js` | 369 | 11 KB | AI 服务接口 |
| `ai/prompts.js` | 206 | 3 KB | AI 系统提示词 |

### 2.3 API 端点统计

| 方法 | 数量 |
|------|------|
| GET | 55 |
| POST | 18 |
| PUT | 8 |
| DELETE | 4 |
| **合计** | **85** |

---

## 3. 模块详细说明

### 3.1 认证与用户管理

**端点**: `/api/auth/*`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 登录（5次/5分钟限流） |
| `/api/auth/logout` | POST | 登出 |
| `/api/auth/me` | GET | 当前用户信息 |
| `/api/auth/password` | PUT | 修改密码 |
| `/api/auth/reset-password/:userId` | PUT | 管理员重置密码 |
| `/api/auth/seed-users` | POST | 批量创建用户 |

**用户角色**: admin / manager / user

**预置账号** (8个):
- admin / admin123 (系统管理员)
- qa_manager / qa123 (QA经理)
- qa_engineer / qa123 (质量工程师)
- ... (含CEO/高管账号)

---

### 3.2 驾驶舱 (Dashboard)

**端点**: `/api/dashboard/*`

| 端点 | 说明 |
|------|------|
| `/api/dashboard/cockpit` | Q-KPI 六维指标 + 产品风险矩阵 + AI预警 |
| `/api/dashboard/stats` | 概览统计（事件/CAPA/风险分布） |
| `/api/dashboard/kpis` | KPI 指标 |
| `/api/dashboard/alerts` | 红/黄/绿三级预警 |
| `/api/dashboard/qhi` | 质量健康指数 |
| `/api/dashboard/complaints` | 投诉看板（2026上半年数据） |
| `/api/dashboard/workshop` | 研发生产质量一体化 Workshop |
| `/api/dashboard/quality-modules` | TQM 五模块（QMS/研发/供应链/生产/上市后） |
| `/api/dashboard/export` | 导出全部数据为Excel (7个Sheet) |
| `/api/dashboard/import/template` | 下载导入模板 (4个Sheet) |
| `/api/dashboard/import` | 导入数据 (Excel/JSON) |

**Q-KPI 六维度**: 产品质量 / 生产质量 / QC质量 / 供应链质量 / 客户质量 / 体系质量

---

### 3.3 质量事件 (Quality Events)

**数据模型字段**:
```
id, event_code, event_type, event_subtype, product_id, product_name,
product_line, batch_no, risk_level, severity, occurrence, detectability,
rpn_score, status, description, root_cause_category, reported_by,
responsible_dept, complaint_source, complaint_month, complaint_cause,
complaint_repeat, occurred_at, closed_at, created_at
```

**事件类型**: Deviation / OOS / OOT / Complaint / CAPA / Audit-Finding / SCAR / NCR

**风险等级**: Low / Medium / High / Critical

**状态流转**:
```
Open → In Investigation → Root Cause Analysis → CAPA Created → Closed
                                                              → Closed - No Action
```

**端点**:
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/events` | GET | 列表查询（支持status/risk/search/page/sort） |
| `/api/events` | POST | 新建事件 |
| `/api/events/categories` | GET | 四分类看板数据 |
| `/api/events/:id` | GET | 事件详情 + 审计日志 |
| `/api/events/:id` | PUT | 更新事件 |
| `/api/events/:id` | DELETE | 删除事件 |
| `/api/events/export` | GET | 导出Excel |
| `/api/events/import/template` | GET | 下载导入模板 |
| `/api/events/import` | POST | 批量导入 |

**子页面**:
- 📊 四分类看板：偏差 / 内外审发现 / 日常发现 / 客户投诉
- 📋 体系产品风险检查：24项 GMP + ISO 13485 条款映射
- 🤖 AI 风险预测

---

### 3.4 CAPA 管理

**数据模型字段**:
```
id, title, event_id, audit_source, audit_dept, defect_mode,
root_cause_category, root_cause, corrective_action, preventive_action,
status, assignee, due_date, effectiveness, verified_by, verified_date
```

**端点**: `/api/capa`, `/api/capa/summary`, `/api/capa/:id`

---

### 3.5 全生命周期管理 (PLM)

**标准7阶段**: 立项 → 设计开发 → 注册 → 转产 → 量产 → 上市 → 退市

**质量指标体系**: 三层级（战略/策略/执行）× 三类型（红线/经营/提升），共27项阶段指标

**端点**:
| 端点 | 说明 |
|------|------|
| `/api/plm/stages` | 7阶段定义 + 质量指标 |
| `/api/plm/dashboard` | 生命周期分布 + 产品护照 |
| `/api/plm/product-lines` | 6产品线分组视图 |
| `/api/plm/registry` | 29条有效注册证书 |
| `/api/plm/risks` | 统一风险登记册（FMEA+QCP+事件+审计） |

**8个Tab标签页**:
1. 🔗 生命周期 — 7阶段卡片 + 产品质量护照表
2. 📦 产品线视图 — 6产品线卡片（化学发光/胶体金/分子/生化/微生物/仪器）
3. 📊 Q-KPI — 六维质量指标
4. 🎯 风险矩阵 — 产品级风险评分表
5. 🛡️ 风险管理 — 阶段风险瀑布 + 统一风险登记册
6. 🚨 AI预警 — 红/黄/蓝三级预警卡片
7. 📦 批次护照 — 批次质量护照列表
8. 📋 产品注册档案 — 有效注册证一览表

**6大产品线**:

| 产品线 | QCP数 | 产品数 | 批次 | 说明 |
|--------|-------|--------|------|------|
| 💡 化学发光 | 46 | 2 | 4 | CLIA平台 |
| 🟡 胶体金 | 333 | 1 | 0 | 295条专用QCP字典 |
| 🧬 分子 | 306 | 0 | 0 | 268条专用QCP字典（PCR定性+定量） |
| 🧪 生化 | 38 | 0 | 0 | 待录入种子数据 |
| 🦠 微生物 | 38 | 0 | 0 | 待录入种子数据 |
| 🔬 仪器 | 38 | 1 | 0 | 待录入种子数据 |

---

### 3.6 控制点库 (QCP Library)

**存量**: 640+ 条（含通用水准 + 胶体金295条 + 分子268条）

**数据模型字段**:
```
id, qcp_code, name, domain, stage, risk_level, control_method,
control_purpose, key_param, spec_standard, alert_rule,
detection_method, frequency, owner, product_line, applicable_type
```

**模块分布**:

| 模块 | Q01设计 | Q02原材料 | Q03生产 | Q04成品 | Q05稳定性 | Q06上市后 |
|------|---------|----------|---------|---------|----------|----------|
| 胶体金 | 30 | 80 | 55 | 60 | 30 | 35 |
| 分子PCR | 32 | 76 | 46 | 57 | 27 | 30 |

**产品线筛选**: 支持按6大产品线过滤 + 通用

**一键导入**:
- `POST /api/qcp/seed-colloidal-gold` — 胶体金290条
- `POST /api/qcp/seed-molecular` — 分子PCR 268条

---

### 3.7 变更控制 (Change Control)

**变更类型**: 设计变更 / 工程变更 / 工艺变更 / 设备变更 / 物料变更 / 文件变更 / 产品变更 / 试剂变更 / 仪器变更 / 包材/标签变更

**风险分级**: I类（低风险）/ II类（中风险）/ III类（高风险）

**子页面**:
- 📊 变更看板 — 分基地饼图 + 产品线柱图 + 变更原因帕累托
- 📋 操作指南提示卡 — 设计/工程决策 + I/II/III分级 + 仪器物料 + 六阶段流程
- 📑 注册变更项目 — 98条注册变更（含西门子批量）

**端点**:
| 端点 | 说明 |
|------|------|
| `/api/changes` | 列表查询 |
| `/api/changes/guide` | 操作指南数据 |
| `/api/changes/registration` | 注册变更列表 |
| `/api/changes/analysis` | 变更分析数据 |
| `/api/changes/export` | 导出Excel |
| `/api/changes/import/template` | 下载导入模板 |
| `/api/changes/import` | 批量导入 |

---

### 3.8 批次质量护照 (Batch Passport)

**数据模型 (DO06)**:
```json
{
  "batchId": "C2606034",
  "productName": "CA19-9 化学发光检测试剂盒",
  "platform": "CLIA",
  "bqi": 94.5,
  "bqiLevel": "green",
  "materials": [{ name, lot, supplier, result, criticality }],
  "process": [{ step, param, value, target, result }],
  "qcResults": [{ item, value, standard, result }],
  "events": [], "capas": []
}
```

**4条种子批次**: CA19-9 (2批) / AFP (1批) / TSH (1批)

**BQI等级**: 🟢 green (≥90) / 🟡 yellow (75-89) / 🔴 red (<75)

---

### 3.9 风险数据库 (Risk FMEA)

**数据模型**: id / risk_code / hazard / severity / probability / detectability / risk_level / rpn / fmea_type (DFMEA/PFMEA) / product_id / control_measure / status

**RPN = Severity × Occurrence × Detectability**

**端点**: `/api/risks`, `/api/risks/:id`

---

### 3.10 审计追踪 (Audit Trail)

**端点**: `/api/audit-logs`  
**合规**: 21 CFR Part 11  
**记录内容**: 时间 / 操作 / 表名 / 记录ID / 详情 / 操作人

---

### 3.11 AI 助手

**4个预设角色**:

| 角色 | 用途 | 模型 |
|------|------|------|
| quality_expert | 质量专家问答 | Qwen (主) / DeepSeek (备) |
| knowledge | 知识库检索 | Qwen |
| capa_rca | CAPA 根因分析 | Qwen |
| risk_prediction | 风险预测 | Qwen |

**端点**: `/api/ai/chat`, `/api/ai/analyze-event/:eventId`, `/api/ai/risk-predict`

---

## 4. 数据架构

### 4.1 数据库引擎 (`database/init.js`)

双模式运行:
- **MongoDB 模式**: 检测 `MONGODB_URI` 环境变量 → 连接 MongoDB Atlas
- **JSON 降级模式**: 无 MongoDB URI → 使用 `data/*.json` 文件

**集合/表**:
| 表名 | 数据文件 | 说明 |
|------|---------|------|
| users | users.json | 用户账号 |
| products | products.json | 产品主数据 (QO01) |
| suppliers | suppliers.json | 供应商 (QO05) |
| quality_events | quality_events.json | 质量事件 (QO06) |
| capa_records | capa_records.json | CAPA (QO07) |
| change_records | change_records.json | 变更记录 |
| qcp_library | qcp_library.json | 控制点库 (QO08) |
| risk_database | risk_database.json | 风险库 (QO09) |
| audit_logs | audit_logs.json | 审计日志 |

**核心方法**: `findAll()`, `findById()`, `insert()`, `update()`, `delete()`, `getAuditLogs()`, `getDashboardStats()`

### 4.2 GxP 数据对象模型映射

| QO编号 | 数据对象 | 表名 | 说明 |
|--------|---------|------|------|
| QO01 | 产品注册/全生命周期档案 | products | CQA/CMA/CPP 完整记录 |
| QO05 | 供应商档案 | suppliers | 风险评级/质量评分/SCAR |
| QO06 | 质量事件库 | quality_events | 偏差/OOS/OOT/投诉 |
| QO07 | CAPA知识库 | capa_records | 纠正/预防/有效性验证 |
| QO08 | QCP控制点库 | qcp_library | 290+250+通用 |
| QO09 | 风险数据库 | risk_database | DFMEA/PFMEA |

---

## 5. 前端架构

### 5.1 SPA 路由

```
navigate('dashboard') → page-dashboard
navigate('events')     → page-events (质量事件)
navigate('complaints') → page-complaints (投诉看板)
navigate('capa')       → page-capa
navigate('workshop')   → page-workshop
navigate('plm')        → page-plm (全生命周期)
navigate('qcp')        → page-qcp (控制点库)
navigate('masters')    → page-masters (主数据管理)
navigate('changes')    → page-changes (变更控制)
navigate('risks')      → page-risks (FMEA库)
navigate('ai')         → page-ai (AI助手)
navigate('audit')      → page-audit (审计追踪)
```

### 5.2 侧边栏结构

```
📊 驾驶舱
⚠️ 质量事件 ▼
  ├── 📢 投诉看板
  ├── 🔧 CAPA管理
  └── 🏭 研发生产质量一体化
🔗 全生命周期 ▼
  ├── 📦 产品线视图
  ├── 🛡️ 风险管理
  ├── 🎯 控制点库
  └── 📋 主数据管理
🔄 变更控制
🤖 AI助手
📝 审计追踪
```

### 5.3 全局函数

| 函数 | 说明 |
|------|------|
| `apiGet(url)` | 认证 GET 请求 |
| `apiPost(url, data)` | 认证 POST 请求 |
| `apiPut(url, data)` | 认证 PUT 请求 |
| `apiDelete(url)` | 认证 DELETE 请求 |
| `showToast(msg, type)` | 浮动提示 |
| `formatDate(d)` | 日期格式化 |
| `getRiskBadge(level)` | 风险等级徽章CSS类 |
| `getStatusBadge(status)` | 状态徽章CSS类 |
| `renderChart(id, type, labels, data)` | Chart.js 图表渲染 |
| `renderPieChart(id, labels, data, colors)` | 饼图渲染 |
| `filterRiskRegister()` | 风险登记册筛选 |
| `toggleLineCard(cardId)` | 产品线卡片折叠 |
| `filterQCP()` | QCP产品线筛选 |

---

## 6. 部署配置

### 6.1 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `PORT` | 服务端口 (默认3100) | 否 |
| `MONGODB_URI` | MongoDB 连接字符串 | 否（无则JSON降级） |
| `AI_API_KEY` | AI 服务 API 密钥 | 否 |
| `AI_API_URL` | AI 服务 URL | 否 |

### 6.2 Railway 部署

- **平台**: Railway.app (PaaS)
- **触发**: GitHub `main` 分支 push 自动部署
- **构建**: `npm install` + `node server.js`
- **域名**: fdqh-app-production.up.railway.app

### 6.3 本地部署

**Windows**: 运行 `deploy/start.bat`  
**Linux**: 运行 `deploy/start.sh` (使用 pm2 守护)  
**更新**: `deploy/update.bat` / `deploy/update.sh` (git pull + 重启)

**部署包位置**: `deploy/` 目录，含安装/启动/更新脚本 + README + .env 模板

---

## 7. 版本历史

| 版本 | 日期 | 关键变更 |
|------|------|---------|
| v2.9.3 | 2026-07 | TQM 驾驶舱、8模块侧边栏 |
| v2.13.0 | 2026-07 | PLM 7阶段生命周期 |
| v2.14.0 | 2026-07 | 批次质量护照、注册变更 |
| v2.16.3 | 2026-08 | 审计发现、AI风险预测、产品线筛选 |
| v2.17.0 | 2026-08 | 质量事件/变更导入导出 |
| v2.18.0 | 2026-08 | PLM 产品线视图 (6产品线) |
| v2.19.0 | 2026-08 | PLM 统一风险管理 |
| v2.20.0 | 2026-08 | 胶体金+分子 QCP字典、模板更新 |

---

## 8. 安全与合规

- **认证**: Session Token (crypto.randomBytes 256-bit)
- **会话超时**: 24小时
- **密码**: bcryptjs 加盐哈希
- **限流**: 登录 5次/5分钟
- **字段验证**: 白名单过滤 (whitelistFields)
- **文件上传限制**: 10MB (multer memoryStorage)
- **审计追踪**: 所有数据变更记录操作人+时间
- **CORS**: 已启用 (app.use(cors()))
- **GMP 合规**: 条款映射至 GMP 2015版 + ISO 13485:2016

---

*FDQH v2.20.0 · 代码总行数 ~8,500 · API 端点 85 个 · QCP 字典 640+ 条*
