# FDQH - FosunDx Quality Hub 部署指南

## 一、本地运行

```bash
# 安装依赖
cd fdqh-app
npm install

# 配置 AI API（可选，不配置不影响基础功能）
# Windows PowerShell:
$env:DASHSCOPE_API_KEY="你的阿里百炼API密钥"
# 或者
$env:DEEPSEEK_API_KEY="你的DeepSeek API密钥"

# Linux/Mac:
export DASHSCOPE_API_KEY="你的阿里百炼API密钥"

# 启动服务
node server.js

# 访问 http://localhost:3100
```

## 二、免费部署到 Render.com

### 前提条件
- GitHub 账号
- Render.com 账号 (https://render.com)

### 步骤

1. **推送代码到 GitHub**
```bash
cd fdqh-app
git init
git add .
git commit -m "FDQH v1.0 - AI-powered IVD QMS"
git remote add origin https://github.com/你的用户名/fdqh-app.git
git push -u origin main
```

2. **在 Render 中创建 Web Service**
   - 登录 https://dashboard.render.com
   - 点击 "New +" → "Web Service"
   - 连接你的 GitHub 仓库
   - 配置：
     - **Name**: fdqh-app
     - **Runtime**: Node
     - **Build Command**: `npm install`
     - **Start Command**: `node server.js`
     - **Free Plan**: 选择 Free

3. **配置环境变量**（可选）
   - 在 Render Dashboard → Environment 中添加：
     - `DASHSCOPE_API_KEY`: 阿里百炼 API 密钥
     - `DEEPSEEK_API_KEY`: DeepSeek API 密钥（备用）

4. **部署**
   - Render 会自动构建和部署
   - 首次部署需要 2-4 分钟
   - 服务地址格式: `https://fdqh-app.onrender.com`

### ⚠️ 免费层限制

- **休眠机制**: 15分钟无请求后服务自动休眠，下次请求需要~1分钟冷启动
- **数据持久化**: 免费层文件系统是临时的，重启后 data/ 目录数据会丢失
- **带宽**: 100 GB/月
- **构建时间**: 500 分钟/月

### 🛠 保持服务在线

可以使用 UptimeRobot (免费) 每 5 分钟 ping 一次服务，防止休眠：
- 注册 https://uptimerobot.com
- 添加监控: `https://你的服务地址.onrender.com`
- 监控间隔: 5 分钟

## 三、数据持久化方案

### 方案 A: 升级 Render 付费层 ($7/月)
- 持久化磁盘，数据不丢失
- 无休眠限制

### 方案 B: 使用免费云数据库
- **MongoDB Atlas** 免费层: 512 MB 存储
  1. 注册 https://www.mongodb.com/atlas
  2. 创建免费集群
  3. 获取连接字符串
  4. 设置环境变量 `MONGODB_URI`
  
- **Supabase** 免费层: 500 MB PostgreSQL
  1. 注册 https://supabase.com
  2. 创建项目
  3. 获取连接字符串

### 方案 C: 定期备份
在 Render 中设置 Cron Job 定期将 data/ 目录备份到外部存储。

## 四、AI API 配置

### 阿里百炼（推荐）

1. 访问 https://bailian.console.aliyun.com
2. 注册阿里云账号（需要实名认证）
3. 开通"模型服务灵积"产品
4. 在 API-KEY 管理中创建密钥
5. 新用户赠送 70 万+ tokens 免费额度

**支持模型：**
- `qwen-turbo`: 快速、便宜
- `qwen-plus`: 平衡（推荐）
- `qwen-max`: 最强推理能力

### DeepSeek（备用）

1. 访问 https://platform.deepseek.com
2. 注册并获取 API Key
3. 价格极低，适合高并发使用

**支持模型：**
- `deepseek-chat`: 通用对话
- `deepseek-reasoner`: 深度推理

### 配置方法

在启动服务前设置环境变量即可，两个都配置会自动实现故障切换（主API失败自动切换备用）。

## 五、默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 系统管理员 |
| qa_manager | qa123 | QA经理 |
| qa_engineer | qa123 | 质量工程师 |

## 六、Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3100
CMD ["node", "server.js"]
```

```bash
docker build -t fdqh-app .
docker run -p 3100:3100 -e DASHSCOPE_API_KEY=your_key fdqh-app
```
