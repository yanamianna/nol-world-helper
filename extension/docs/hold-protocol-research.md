# NOL World 锁票请求与响应研究

核对日期：2026-10-08。源码研究在 v0.1.4 时完成，当前扩展为 v0.1.5。下述源码研究只读取官方公开 HTML、JavaScript 和帮助资料；文末另补充手动通过官网入口的浏览器观察，未执行锁票或订单请求。

## 结论

可以通过官方前端源码定位请求的实现，也可以通过一次正常购票动作取得真实请求与响应。本轮已经从 NOL 商品页追到公开的 Partner / Global 入场前端，确认了正常入场与排队的客户端接口；**尚未取得正式选票页的锁票接口和真实成功回执**。

目前不能仅用商品编号和档位编号直接锁库存。正式流程还需要当前账号会话、官方入场及排队结果、实际场次和选票状态。入口 token、排队地址、接口 HTTP 200 都不是锁票成功证明。

TXT 与 JEONGHAN × JOSHUA 的 Play＆Stay 应研究酒店 / 人数档位的库存预留。官方说明确认它们的具体区与座位在保证等级内随机分配，不能将酒店档位作为实体座位编号。普通公演的指定席流程需要另行适配。

## 本轮新增的源码证据

### 1. 商品页不是完整的预约应用

[NOL 商品客户端](https://world.nol.com/asset/kint5-ticket-web/_next/static/chunks/3mllq2af3oq3f.js) 包含公开价格和入场逻辑。已知流程读取账号票务状态，通过正常官方验证，再提交同源入场 token 请求，跳转到 tickets.interpark.com 的 Partner gate。这里没有已经确认的实时选票或锁定动作。

### 2. Partner gate 的前端可以匿名读取

2026-10-08，无 query、无登录凭据的 [Partner gate 页面](https://tickets.interpark.com/gates/partner) 返回 HTTP 200。页面直接引用 [DJd3ayxl.js](https://tickets.interpark.com/gates/assets/DJd3ayxl.js) 及静态模块。

沿其实际引用有限递归下载了 32 个脚本，合计 2,859,372 字节；全部返回 200。没有猜测脚本名称，也没有请求其中的业务 API。主包注册了 Partner、Global、Ticket 路由，实际引用的路由模块包括：

- [Cyr-bY_d.js](https://tickets.interpark.com/gates/assets/Cyr-bY_d.js)：Partner。
- [ClL8pB67.js](https://tickets.interpark.com/gates/assets/ClL8pB67.js)：Global。
- [CcgKLPc8.js](https://tickets.interpark.com/gates/assets/CcgKLPc8.js)：Ticket。
- [DQK4bWWa.js](https://tickets.interpark.com/gates/assets/DQK4bWWa.js)：共享入场、排队与跳转逻辑。

### 3. 已定位的接口都是入场接口

下面是源码静态证据；“响应字段”表示客户端会读取该字段，不表示已经捕获实际账号的响应。

| 所在阶段 | 源码可见动作 | 客户端输入 / 读取结果 | 与锁票的关系 |
|---|---|---|---|
| NOL 商品页 | GET /api/users/enter | 商品 / 场馆；读取账号票务及邮箱状态 | 账号检查 |
| NOL 商品页 | POST /api/users/enter/token | 商品、场馆和正常验证凭据；读取入场凭据 | 进入 Partner gate，不能当作锁票 |
| Partner 的 TOKEN_VERIFY 分支 | POST https://ent-bridge.interpark.com/x13_02/v1/bridge/tokenVerify，带 query | 普通 NOL bizCode 10965 走此分支；query 用 query-string.stringify，body 是官方 gate 参数的 JSON；客户端读取 data.returl | 核验入口并返回下一地址；returl 的实际值未取得 |
| Global 会员检查 | GET https://tickets.interpark.com/api/ticket/v2/reserve-gate/member-info | query 为 goodsCode、channelCode；Global 使用 gp 渠道。后续从会员结果读取 memberCode、signature、secureData | 正常会员上下文，不能预先伪造 |
| Global 商品检查 | GET https://tickets.interpark.com/api/ticket/v2/reserve-gate/goods-info | query 包含 goodsCode、placeCode、bizCode、passCode、lang 和 nc；读取商品、预售及认证规则 | 商品规则，不是可售座位列表 |
| Global 路由 | POST https://ent-waiting-api.interpark.com/waiting/api/secure-url | 包含正常会员结果的 signature、secureData，以及 bizCode、lang、preSales、passCode、from；实际有场次上下文时包含 playDate、playSeq，空值删除；读取 redirectUrl | 官方入场 / 排队地址，不能当作库存确认 |
| Global 最终跳转 | https://ticket.globalinterpark.com/Global/Play/Gate/CBTLoginGate.asp | query 中的 k 来自 memberCode，r 来自排队返回地址，另有 lng | 到实际预约系统的登录门 |

Global 分支的静态存在，不能证明当前 TXT 商品的 tokenVerify 运行结果一定按这一完整分支继续。需要正常运行时的 returl 和页面结果确认；报告不将不同分支拼成已经实测成功的单一路径。

### 4. 后段源码仍没有取得

对上述源码明确的 CBTLoginGate.asp 做无参数匿名 GET，本次返回 HTTP 202、空正文，没有获得预约 HTML 或进一步脚本引用。此前 Global 首页的 403 也不能用于推断具体锁票接口。没有修改请求去绕过挑战或伪造正常入场凭据。

因此，当前还不知道锁票动作的真实 HTTP 方法、路径、请求体、业务成功码，以及冲突 / 部分成功 / 到期回执。报告不会根据历史 Interpark 页面名称补造 BookSeat 或 SeatCheck 地址。

## 已确认的锁定阶段语义

[NOL 官方 FAQ](https://world.nol.com/en/my-info/faqs?selected-category=booking-payment) 的公开页面数据给出通用规则：选座通常最多 10 分钟；选座后进入价格步骤，通常暂留 7 分钟，超时释放。非指定席也有支付前时限，具体政策可能因商品改变。

这表明需要重点观察“确认选择并进入价格步骤”的动作。高亮座位与服务端暂留必须分开；FAQ 的时长也不能硬编码成 TXT / JJ 套餐的锁定期限。实际期限以当前正式页面为准。

同一 FAQ 的 Play＆Stay 条目确认具体区与席位在所选等级内随机分配，在演出当天酒店取票时得知。[TXT 官方购买注意事项](https://ticketimage.interpark.com/260134832026/09/23/71a07352.jpg) 同样确认座位随机分配，且每个购买人每场限购一份套餐；[套餐说明](https://ticketimage.interpark.com/260134832026/09/23/ba1fbfa2.jpg) 确认一人商品含一张票，双人商品含连坐两张票。

## 取得真实锁票请求的最短方法

一次正常会话采样可以补足缺失部分。应在已登录的浏览器中完成网站要求的验证与排队，然后只观察一次明确场次、档位和数量的正常选择动作。

1. 在操作前打开 Chrome / Edge DevTools → Network，开启录制和 Preserve log；购票若打开新窗口，需在新窗口自己的 DevTools 录制。设置中可开启 Auto-open DevTools for popups。
2. 停在正式选票页，记录商品、日期时间、档位、数量及当前页面。在该窗口清空旧请求列表，只进行一次官网的确认选择 / 进入下一步动作，停在付款前。
3. 从 All 按动作时间查请求，再看 Fetch/XHR 与 Doc。不能只筛 XHR：正式动作可能采用表单、iframe 或页面导航。若有 iframe，使用 Group by frame 找到所属框架。
4. 对该动作保留方法与路径、Payload、Response、Initiator 调用脚本及页面结果。先在本机保存关键响应；仅保留请求列表不能保证导航后正文仍然可读。
5. 分享或入库前只整理少量脱敏片段。默认 sanitized HAR 会清理 Cookie、Set-Cookie、Authorization，但官方没有保证 URL、正文和自定义头中的全部凭据都被清除。原始 HAR 和 Copy as cURL / fetch 结果留在本机。

工具依据：[Chrome Network](https://developer.chrome.com/docs/devtools/network/reference)、[Chrome 新窗口设置](https://developer.chrome.com/docs/devtools/settings/preferences#global)、[Edge Network](https://learn.microsoft.com/en-us/microsoft-edge/devtools/network/reference)、[Edge 导航后响应正文保留](https://learn.microsoft.com/en-us/microsoft-edge/devtools/experimental-features/#durable-messages)。

### 最小采样记录

| 项目 | 必须记录的实际证据 |
|---|---|
| 动作 | 所在窗口 / iframe、操作时间、官网按钮或控件名称 |
| 请求 | HTTP 方法、域名 / 路径、真实字段名及类型；商品、正式场次、档位、数量的对应关系 |
| 响应 | 业务结果、实际接受的数量 / 席位或套餐；如官网提供则记录期限 / 状态字段 |
| 调用来源 | Initiator 的官方脚本文件和函数，正常处理响应的代码 |
| 页面结果 | 进入哪一步，显示哪些已选项、数量、金额和倒计时，是否出现占用或资格提示 |
| 脱敏 | 登录、入场、验证、会话、CSRF 和可操作的库存凭据以占位符替换；账号、联系人、证件和订单信息不入库 |

未出现独立锁定编号时保持未知；可以研究后续正式页面是否足以核验暂留结果，不编造字段。超时或跳转中断不应重发来试验，先确认官方当前状态。

## 对扩展的具体接入顺序

1. 按用户最新指定，先采样 JJ 普通票（26013793）的实际场次、选座控件、确认请求和下一步骤；Play＆Stay 后续单独验证套餐份数与包含票数。
2. 根据实际请求及调用代码，接入“严格匹配档位 → 足量选择 → 单次官方确认 → 回执校验”。维持正常会话，由网站处理认证、验证和排队。
3. 明确完整成功、部分成功、售罄 / 冲突、结果不明及到期行为。已确认暂留后停止尝试其他选择；结果不明先核对官方状态。
4. 验证目标 JJ 套餐是否使用同一协议。普通公演另采样实体座位 ID 和选座确认，不能直接套用酒店套餐流程。

本轮没有启用自动锁票。v0.1.4 已有档位匹配校验，v0.1.5 改进入口失败状态处理，但正常预约页面适配仍停止在人工接管。2026-10-08 已在 Edge 手动通过 JJ 普通票官方入口跳转到 partner gate，随后售票域名 ERR_CONNECTION_TIMED_OUT，未取得后段页面；详见 [实际流程记录](selection-and-hold.md#本轮普通票实际流程)。下一项决定性证据仍是一次正常“确认选择”动作对应的真实请求、响应和页面状态。
