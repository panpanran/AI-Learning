
# Max AI Learning

Max AI Learning 是一个智能学习平台，支持多学科、多年级、个性化练习和诊断。

Max AI Learning is an intelligent learning platform supporting multi-subject, multi-grade, personalized practice and diagnostics.

## 功能 Features

- React 前端（Vite）
- Express 后端（JWT、OAuth、OpenAI 4.1 集成）
- 中英文切换（i18next）
- 选择年级/学科，保存偏好
- Pinecone 向量检索，错题本，专项练习
- 支持 OpenAI 4.1 智能出题

## 快速运行 Quick Start (Local)

### 1. 安装依赖 Install dependencies

```bash
# 后端 Backend
cd backend
npm install

# 前端 Frontend
cd ../frontend
npm install
```

### 2. 配置环境变量 Configure environment variables

复制 `.env.example` 为 `.env` 并填写：
Copy `.env.example` to `.env` and fill in:

```
JWT_SECRET=your_jwt_secret
OPENAI_API_KEY=（可选 optional, for OpenAI 4.1）
```

### 3. 启动服务 Start services

```bash
# 后端 Backend
cd backend
npm run dev

# 前端 Frontend
cd ../frontend
npm run dev
```

访问前端：http://localhost:5173
Access frontend: http://localhost:5173

## 部署 Deployment

支持 Render.com、Fly.io、Vercel 等平台。
Supports Render.com, Fly.io, Vercel and more.

## 目录结构 Project Structure

- backend/  Node.js + Express API
- frontend/ React + Vite

## License

MIT
