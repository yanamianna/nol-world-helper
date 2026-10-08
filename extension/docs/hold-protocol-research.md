# NOL World 普通票锁座请求与响应研究

核对日期：2026-10-08，当前扩展 **v0.1.8**。研究对象为普通公演票，读取官方公开 HTML、JavaScript 和帮助资料，并区分源码实现与真实会话结果。当前没有执行锁座或订单请求。

## 结论与证据范围

已从 NOL 商品页追踪到 Partner / Global 入场前端及正式 OneStop 选座应用，定位入场、排队、座位状态、临时预选与完成选择实现。**仍未取得真实锁定成功回执，也未将后段请求接入扩展。** 最新选座接口细节见 [OneStop 技术研究](onestop-flow-research.md)。

商品编号加档位编号不足以直接锁库存，还需要正常账号会话、官方入场和排队结果、实际场次、逐座信息及选票状态。入场 token、排队地址、HTTP 200、本地座位高亮均不是锁座成功证明。

## 入口链路的公开源码证据

[NOL 商品客户端](https://world.nol.com/asset/kint5-ticket-web/_next/static/chunks/3mllq2af3oq3f.js) 包含公开价格及入场逻辑：检查账号票务状态，完成正常验证，提交同源入场 token 请求，再到官方 partner gate。商品页本身不是完整选座应用。

无 query、无登录凭据的 [Partner gate 页面](https://tickets.interpark.com/gates/partner) 返回 HTTP 200，引用 [DJd3ayxl.js](https://tickets.interpark.com/gates/assets/DJd3ayxl.js)。沿实际引用下载 32 个脚本，共 2,859,372 字节，全部返回 200；没有猜测脚本名或请求其中业务 API。主要路由及共享模块为：

- [Cyr-bY_d.js](https://tickets.interpark.com/gates/assets/Cyr-bY_d.js)：Partner。
- [ClL8pB67.js](https://tickets.interpark.com/gates/assets/ClL8pB67.js)：Global。
- [CcgKLPc8.js](https://tickets.interpark.com/gates/assets/CcgKLPc8.js)：Ticket。
- [DQK4bWWa.js](https://tickets.interpark.com/gates/assets/DQK4bWWa.js)：共享入场、排队及跳转。

下表的响应字段仅表示客户端读取它，不表示已捕获真实账号响应；不同分支不能拼成已验证的单一路径。

| 阶段 | 源码可见动作 | 输入 / 读取结果 | 意义 |
|---|---|---|---|
| NOL 商品页 | GET `/api/users/enter` | 商品 / 场馆，读取账号票务及邮箱状态 | 账号检查 |
| NOL 商品页 | POST `/api/users/enter/token` | 商品 / 场馆和正常验证凭据，读取入场凭据 | 进入 Partner gate，不是锁座 |
| Partner TOKEN_VERIFY 分支 | POST `https://ent-bridge.interpark.com/x13_02/v1/bridge/tokenVerify` | 普通 NOL bizCode 10965 分支；query 经 query-string.stringify，body 为 gate 参数 JSON；读取 `data.returl` | 返回下一地址，实际 returl 未采样 |
| Global 会员检查 | GET `https://tickets.interpark.com/api/ticket/v2/reserve-gate/member-info` | goodsCode / channelCode，gp 渠道；读取 memberCode / signature / secureData | 正常会员上下文 |
| Global 商品检查 | GET `https://tickets.interpark.com/api/ticket/v2/reserve-gate/goods-info` | goodsCode / placeCode / bizCode / passCode / lang / nc，读取商品、预售及认证规则 | 商品规则，不是座位列表 |
| Global 排队分支 | POST `https://ent-waiting-api.interpark.com/waiting/api/secure-url` | 正常会员结果及 bizCode / lang / preSales / passCode / from；有场次上下文时含 playDate / playSeq；读取 redirectUrl | 官方排队地址，不是库存确认 |
| Global 最终跳转 | `https://ticket.globalinterpark.com/Global/Play/Gate/CBTLoginGate.asp` | k 来自 memberCode，r 来自排队地址，另有 lng | 正式预约系统登录门 |

对源码明确引用的 CBTLoginGate.asp 做无参数匿名 GET，返回 HTTP 202、空正文。此前 Global 首页的 403 也不能证明任何锁座协议。研究没有修改请求去绕过挑战、伪造入场凭据或补造旧页面的 BookSeat / SeatCheck 地址。

## 正式 OneStop 与真实页面观察

用户正常 Edge 会话手动进入 JJ 普通票 26013793。网络恢复后沿现有队列自动进入 `/onestop/schedule`，点击官网下一步到 `/onestop/seat`，看到默认 2026-10-30 韩国时间 19:00、座区图、倒计时和图片验证码。验证码未完成，随后会话到期。没有选座、确认、锁座、订单或付款；默认场次不是实验购买配置。[实际流程记录](selection-and-hold.md#已进入正式选场与选座页)。

进一步匿名读取该页实际加载的 23 份官方 JS 与两份 SVG，定位 GraphQL 临时预选、REST 完成选座、取消预选、状态读取、冲突及前端到期处理。当前已知道客户端实现，仍缺正常选择动作的真实请求 / 响应及服务端确认语义。接口路径和字段以 [OneStop 技术研究](onestop-flow-research.md) 中的源码证据为准。

## 锁定与时限

[NOL 官方 FAQ](https://world.nol.com/en/my-info/faqs?selected-category=booking-payment) 的公开数据描述通用规则：选座通常最多 10 分钟，选座后进入价格步骤通常暂留 7 分钟，超时释放。具体政策可能随商品变化，不能把通用时长硬编码为目标商品已确认的锁定期限。

需要观察“完成选择并进入价格步骤”的真实动作，区分临时预选、正式确认及页面倒计时。前端计时或高亮不能证明服务端实际接受了全部座位；锁定编号、有效期或释放结果未提供时保持未知。

## 正常会话请求采样方法

在已登录浏览器完成网站认证、验证和排队后，只观察一次明确日期、档位 / 座区及张数的正常选择。到付款前停止。

1. 操作前打开 Chrome / Edge DevTools → Network，开启录制和 Preserve log；若有新窗口，在对应窗口录制，可启用 Auto-open DevTools for popups。
2. 停在正式选座页，记录商品、实际场次、档位、张数和当前页面；清空旧请求后只进行一次官方确认 / 下一步动作。
3. 先按动作时间查看 All，再查看 Fetch/XHR 与 Doc。不能只筛 XHR，动作可能是表单、iframe 或导航；有 iframe 时按 frame 分组。
4. 保存方法、域名 / 路径、Payload、Response、Initiator 与页面结果。仅有请求列表不保证导航后正文仍可读取。
5. 入库或分享时只整理少量脱敏片段。sanitized HAR 会清理部分标准认证头，但 URL、正文及自定义头仍可能含凭据；原始 HAR 和 Copy as cURL / fetch 留在本机。

工具依据：[Chrome Network](https://developer.chrome.com/docs/devtools/network/reference)、[Chrome 新窗口设置](https://developer.chrome.com/docs/devtools/settings/preferences#global)、[Edge Network](https://learn.microsoft.com/en-us/microsoft-edge/devtools/network/reference)、[Edge 导航后响应保留](https://learn.microsoft.com/en-us/microsoft-edge/devtools/experimental-features/#durable-messages)。

| 项目 | 应保留的证据 |
|---|---|
| 动作 | 窗口 / iframe、时间、官方控件 |
| 请求 | 方法、域名 / 路径、真实字段和类型；商品、场次、档位、逐座 ID、张数的对应关系 |
| 响应 | 业务结果、接受的席位和张数；如有则记录期限与状态 |
| 调用来源 | Initiator 官方脚本、函数及正常响应处理 |
| 页面结果 | 下一步骤、席位、张数、金额、倒计时及占用 / 资格提示 |
| 脱敏 | 替换登录、入场、验证、会话、CSRF 及可操作库存凭据；不入库账号、联系人、证件或订单信息 |

超时或跳转中断时先核对官网当前状态，不重发试验。没有独立锁定编号时，可继续研究正式页面能否确认暂留结果，不编造字段。

## 普通票接入顺序

1. 在新有效会话中采样 JJ 普通票实际场次、逐座控件、一次确认请求及下一页面；由本人完成验证码。
2. 接入“严格匹配档位与座区 → 足量选择 → 单次官方确认 → 校验回执”，不绕过正常认证和队列。
3. 明确完整成功、部分成功、售罄 / 冲突、结果不明、释放及到期行为；已确认锁定后停止其他选择，结果不明先核对。
4. 取得明确实验配置并完成一次已授权的未支付订单流程，验证资料和含费总额，到付款前停止。

当前扩展没有启用自动锁座。实际 ddddocr 引擎的双浏览器合成图测试验证的是本机候选和人工确认填入流程，不是官网验证码通过、座位锁定或订单成功。
