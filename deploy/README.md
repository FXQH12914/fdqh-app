# FDQH - FosunDx Quality Hub

IVD 数字化质量管理平台 | 产品全生命周期质量管理

**版本**: v2.16  |  **默认端口**: 3000

---

## 快速开始

### Windows
```
双击运行 deploy\start.bat
```

### Linux / macOS
```bash
chmod +x deploy/start.sh deploy/install.sh
./deploy/install.sh    # 首次安装
./deploy/start.sh      # 启动服务
```

### 或使用 npm
```bash
npm install --production
npm start
```

---

## 访问地址

打开浏览器访问：**http://localhost:3000**

| 默认账号 | 密码 |
|---------|------|
| admin | admin123 |
| qa_manager | qa123 |
| qa_engineer | qa123 |
| prod_manager | prod123 |
| rd_engineer | rd123456 |
| quality_dir | dir123456 |
| ceo | ceo123456 |
| group_exec | exec123456 |

---

## 系统要求

- **Node.js** 18.0 或更高版本
- **内存** ≥ 512MB
- **磁盘** ≥ 200MB
- **MongoDB**（可选，无 MongoDB 时自动使用 JSON 文件存储）

---

## MongoDB 配置（可选）

### MongoDB Atlas 免费云数据库（推荐）

Railway 云端 + 本地电脑**共享同一数据库**，数据自动同步：

1. 注册 [MongoDB Atlas](https://www.mongodb.com/atlas)（免费 512MB）
2. 创建免费集群 → 点击 "Connect" → "Drivers"
3. 复制连接字符串，替换 `<password>`
4. 设置环境变量：

```bash
# Railway 环境变量
MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/fdqh?retryWrites=true&w=majority

# 本地 Windows (PowerShell)
$env:MONGODB_URI='mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/fdqh?retryWrites=true&w=majority'

# 本地 Linux
export MONGODB_URI='mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/fdqh?retryWrites=true&w=majority'
```

### 本地 MongoDB

```bash
export MONGODB_URI='mongodb://localhost:27017/fdqh'
```

### 不使用 MongoDB

不设置 `MONGODB_URI` → 自动使用 `data/` 目录 JSON 文件存储。

---

## 自定义端口

```bash
# Linux / macOS
export PORT=8080

# Windows (PowerShell)
$env:PORT=8080
```

---

## 目录结构

```
fdqh-app/
├── server.js          # 主服务入口
├── package.json       # 依赖配置
├── public/            # 前端文件
│   ├── index.html     # 主页面
│   ├── js/            # JavaScript
│   └── css/           # 样式表
├── database/          # 数据库初始化
├── ai/                # AI 服务模块
├── data/              # JSON 数据文件（无 MongoDB 时）
└── deploy/            # 部署脚本
    ├── start.bat      # Windows 启动
    ├── start.sh       # Linux 启动
    ├── install.sh     # Linux 一键安装
    └── README.md      # 本文件
```

---

## 防火墙配置

如需局域网内其他设备访问，确保防火墙开放对应端口：

```bash
# Linux (firewalld)
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload

# Linux (ufw)
sudo ufw allow 3000
```

---

## 后台运行 (Linux)

```bash
# 使用 nohup
nohup ./deploy/start.sh > fdqh.log 2>&1 &

# 使用 pm2（推荐）
npm install -g pm2
pm2 start server.js --name fdqh
pm2 save
pm2 startup
```
