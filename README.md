This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

### 决策任务恢复调度

新决策提交后的 `after()` 只负责低延迟启动，不能作为唯一恢复路径。仓库中的
`.github/workflows/decision-run-recovery.yml` 每五分钟调用一次受保护的恢复端点，重新排队租约过期的任务并继续处理已排队任务。

生产部署需要配置以下相同来源的密钥与地址：

- 应用运行环境：设置高强度随机值 `DECISION_RUN_RECOVERY_SECRET`。
- GitHub Actions Secret：设置同名 `DECISION_RUN_RECOVERY_SECRET`，值必须与应用环境一致。
- GitHub Actions Variable：设置 `DECISION_RUN_RECOVERY_URL`，值为完整地址，例如 `https://example.com/api/ai/decision-runs/recover`。

部署后可在 GitHub Actions 中手动运行 `Recover decision runs` 验证配置。成功请求返回 `202`；`401` 表示两端密钥不一致，`503` 表示应用环境未配置密钥。定时调用具有租约与幂等保护，可安全重试。自托管或使用其他调度平台时，应以 POST 请求调用同一地址并携带 `Authorization: Bearer <DECISION_RUN_RECOVERY_SECRET>`，建议每分钟执行一次。
