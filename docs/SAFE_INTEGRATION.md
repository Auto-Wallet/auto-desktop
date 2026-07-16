# AutoDesktop Safe 多签集成调研与实现

更新时间：2026-07-16

## 官方能力分层

Safe 的集成主要分为三层：

1. **Safe Smart Account 合约**
   - `getOwners()`：读取当前 Owner。
   - `getThreshold()`：读取签名门槛。
   - `nonce()`：读取 Safe 交易 nonce。
   - `getTransactionHash(...)`：按 EIP-712 计算唯一的 `safeTxHash`。
   - `execTransaction(...)`：签名达到门槛后在链上执行。

2. **Safe Transaction Service**
   - 保存待执行的 Safe 交易。
   - 链下收集 Owner 签名，避免每个 Owner 都发送链上确认交易。
   - 常用接口：
     - `GET /v1/safes/{safe}/multisig-transactions/`
     - `GET /v1/multisig-transactions/{safeTxHash}/`
     - `POST /v1/multisig-transactions/{safeTxHash}/confirmations/`
     - `POST /v2/safes/{safe}/multisig-transactions/`

3. **Safe{Core} SDK**
   - `@safe-global/protocol-kit`：创建、哈希、签名、执行 Safe 交易。
   - `@safe-global/api-kit`：访问 Transaction Service。
   - 官方 SDK 很方便，但 Protocol Kit 当前会引入 `viem`、部署地址包等依赖。AutoDesktop 以小安装包为产品原则，因此首个切片直接实现所需的最小协议，没有把完整 SDK 打入前端。

## Safe 交易签名

Safe 交易使用下面的 EIP-712 结构：

```text
EIP712Domain(uint256 chainId,address verifyingContract)

SafeTx(
  address to,
  uint256 value,
  bytes data,
  uint8 operation,
  uint256 safeTxGas,
  uint256 baseGas,
  uint256 gasPrice,
  address gasToken,
  address refundReceiver,
  uint256 nonce
)
```

签名摘要是：

```text
keccak256(0x1901 || domainSeparator || hashStruct(SafeTx))
```

AutoDesktop 会根据 Transaction Service 返回的完整交易字段在 Rust 中重新计算摘要，并与服务返回的 `safeTxHash` 比较。二者不一致时拒绝打开签名流程。

软件钱包在 Rust 中使用对应 Owner 的 secp256k1 私钥签名；Ledger Owner 使用现有 Ledger EIP-712 APDU 流程。私钥不会进入 React、dApp webview 或 Safe API。

## 当前实现

- 在“添加钱包”中导入 Safe。
- 导入时直接调用链上合约，验证：
  - 地址存在合约代码；
  - `getOwners()` 可正常解码；
  - threshold 合法；
  - 至少一个当前 Owner 存在于 AutoDesktop 本地钱包或 Ledger 账户中。
- Safe 作为独立账户出现在账户切换器中。
- 选中 Safe 时自动切换到其所属网络，并向 dApp 暴露 Safe 合约地址。
- Wallet 页显示 Safe 待签队列。
- 签名时：
  - 再次读取链上 Owner，防止导入后 Owner 已变更；
  - 拒绝重复签名；
  - 本地重算并核对 `safeTxHash`；
  - 使用独立审批窗口展示完整 SafeTx EIP-712 数据；
  - 使用绑定的本地 Owner 或 Ledger 签名；
  - 调用 Transaction Service confirmation 接口提交签名。
- Safe/观察地址被选中时，普通 dApp `personal_sign`、`eth_signTypedData_v4`、`eth_sendTransaction` 不会错误地回退到后台仍然激活的 EOA。

## API 认证

Safe 官方默认服务支持未认证探索访问，但限额较低；生产使用建议 API Key。API Key 通过 `Authorization: Bearer ...` 发送。

AutoDesktop 按以下顺序读取 `SAFE_API_KEY`：

1. 运行时环境变量；
2. 仓库根目录或 `src-tauri` 上级目录的 `.env.local`；
3. GitHub Release 构建时注入的 `SAFE_API_KEY` secret。

密钥只会附加到 `https://api.safe.global` 请求。用户填写的自建或第三方 Transaction Service URL 永远不会收到 Safe 官方 API Key。

`.env.local` 已被 `.gitignore` 的 `*.local` 和 `.env.*` 规则双重忽略。代码和日志不会输出密钥。

## 当前边界与后续切片

首个切片支持“导入 + 查看待签 + 本地 Owner 确认”，暂不包含：

- 从普通 dApp 的 `eth_sendTransaction` 自动创建 Safe 提案；
- 达到门槛后由 AutoDesktop 执行 `execTransaction`；
- 在 AutoDesktop 内创建新 Safe；
- Owner 增删、threshold 修改、模块/Guard 管理；
- Safe 作为另一个 Safe 的 EIP-1271 合约 Owner；
- 同一个 Safe 地址在多条链上同时导入（当前账户主键仍以地址为主）。

推荐后续顺序：

1. 增加 Safe 提案创建 UI，以及 API `POST /v2/safes/{safe}/multisig-transactions/`。
2. 达到 threshold 后提供“执行”按钮，执行前模拟 `execTransaction`。
3. 将 dApp 的 `eth_sendTransaction` 路由为 Safe proposal，同时明确返回值和交易状态语义。
4. 加密保存 Safe API Key，并处理 401/429、配额信息和指数退避。

## 官方资料

- Safe Transaction Service：
  <https://docs.safe.global/core-api/transaction-service-overview>
- Transaction Service 原理和签名接口：
  <https://docs.safe.global/core-api/api-safe-transaction-service>
- API Kit：
  <https://docs.safe.global/sdk/api-kit>
- 提案与确认：
  <https://docs.safe.global/sdk/api-kit/guides/propose-and-confirm-transactions>
- Protocol Kit 初始化：
  <https://docs.safe.global/reference-sdk-protocol-kit/initialization/init>
- Safe 交易签名：
  <https://docs.safe.global/sdk/protocol-kit/guides/signatures/transactions>
- Safe 签名编码：
  <https://docs.safe.global/advanced/smart-account-signatures>
- API Key 与限额：
  <https://docs.safe.global/core-api/how-to-use-api-keys>
