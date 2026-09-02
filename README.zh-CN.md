# Model Runtime API

Model Runtime API 是一个供应商中立的模型执行协议与参考 Runtime，用于路由、控制、观测和计量 AI 模型调用。

它部署在应用或 AI Gateway 与模型供应商之间。应用只依赖一套稳定执行生命周期，Provider Adapter 负责转换同步 JSON、SSE 流和异步媒体任务等公开协议。

> 当前状态：pre-alpha clean-room 基线，尚未包含真实 Provider Adapter。

## 项目提供什么

- 版本化协议和执行状态机；
- 基于能力的 Provider 选择和 fallback 证据；
- Provider 级并发控制；
- 统一流事件和异步任务状态；
- Provider 上报或 Runtime 推导的 Usage Fact；
- Provider SPI、确定性 Mock 和 Conformance Runner；
- 可选的本地 HTTP/SSE 参考服务与 TypeScript SDK。
- 基于公开文档 clean-room 实现的 OpenAI Responses、Anthropic Messages 和 fal Queue Adapter；
- TypeScript、Go、Python Client，以及版本化能力目录 diff。

## 项目不提供什么

- 可直接暴露到公网的多租户 AI Gateway；
- API Key、租户、套餐和配额管理；
- 钱包、支付、发票和客户账单；
- 对模型行为的统一保证；
- 任何私有 MaaS 系统的代码或配置副本。

## 架构边界

```text
应用 / Agent / AI Gateway
            |
     Model Runtime API
 协议、执行路由、流控、Usage
            |
       Provider SPI
            |
   Hosted / Self-hosted Models
```

调用方提交稳定能力名和能力要求，不提交 Provider 凭据。Runtime 记录实际 Provider、模型、尝试链和 Usage；价格匹配、租户预算与商业计费属于上层系统。

## 开始开发

需要 Node.js 22+ 和 pnpm 10：

```bash
pnpm install
pnpm check
pnpm dev
```

参考服务默认绑定 `127.0.0.1:4320`，不包含鉴权，不得直接暴露到不可信网络。创建执行返回 `202` 和 execution ID，随后通过 status、events、result、cancel 接口控制完整生命周期。

协议、Provider 资料来源、威胁模型、Gateway 边界和 Kubernetes Sidecar 示例分别位于 `spec/`、`docs/evidence/`、`docs/security/`、`docs/guides/` 和 `deploy/`。

## 数据安全

仓库中的所有内容都按公开信息处理。禁止提交密钥、Cookie、私有端点、客户 Payload、生产日志、内部供应商名称、私有价格、路由权重和本地绝对路径。Provider Adapter 只能依据公开厂商文档和脱敏 fixture 实现。

## License

Apache License 2.0.
