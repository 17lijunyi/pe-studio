import type { CandidateScore, SessionRecord } from "./types";
import { DIRECTION_PRESETS } from "./prompts";

function sampleScore(
  candidateId: string,
  scores: [number, number, number, number, number],
): CandidateScore {
  const dimensions = [
    { id: "intent", label: "意图保留", score: scores[0], confidence: 0 },
    { id: "constraints", label: "约束完整", score: scores[1], confidence: 0 },
    { id: "clarity", label: "清晰可执行", score: scores[2], confidence: 0 },
    { id: "adaptation", label: "场景适配", score: scores[3], confidence: 0 },
    { id: "economy", label: "简洁无冲突", score: scores[4], confidence: 0 },
  ];
  const weights = [0.35, 0.25, 0.2, 0.15, 0.05];
  return {
    candidateId,
    score: Math.round(dimensions.reduce((sum, dimension, index) => sum + dimension.score * weights[index], 0) * 10) / 10,
    dimensions,
    eligible: true,
    violations: [],
  };
}

// All content and scores in this record are handcrafted UI examples.
// It has never been generated or evaluated by a model API.
export const DEMO_SESSION: SessionRecord = {
  id: "demo-coffee-membership-mvp",
  createdAt: "2026-10-13T03:00:00.000Z",
  demo: true,
  favorite: false,
  brief: {
    direction: "product",
    input: DIRECTION_PRESETS.product.example,
    targetModel: "Claude",
    context: "使用者包括门店店员与会员。尚未确定使用小程序、网页还是其他载体，也没有提供调研、经营数据或现成系统接口。",
    constraints: "只做单店会员积分与积分兑换优惠券。不做储值、外卖、商城、多门店、复杂营销；不写代码；不编造经营数据、用户调研或积分规则。",
    intensity: "balanced",
    outputLanguage: "zh",
  },
  candidates: [
    {
      id: "demo-a",
      provider: "方案 A · 结构与验收",
      model: "手工示例 · 未调用 API",
      status: "success",
      latencyMs: 0,
      prompt: `请作为产品经理，帮一家独立咖啡店梳理会员系统的 MVP 需求，产出可供店主和开发者讨论的轻量 PRD，暂不写代码。

已知目标：店员结账时为会员累计积分，会员使用积分兑换优惠券。使用者是店员与会员，范围仅限单店。交付载体和现成系统接口尚未确定。

范围边界：第一版不做储值、外卖、商城、多门店和复杂营销。不要引入未经确认的经营数据、用户调研、积分比例、有效期或券门槛。

请依次输出：
1. 需求概述：目标用户、核心问题与两条关键使用情境，明确哪些来自已知信息、哪些仍需验证。
2. MVP 范围表：列出必须交付的能力、后续可考虑事项、明确排除项；每项说明与核心目标的关系。
3. 核心流程：分别描述“结账累计积分”和“积分兑换优惠券”的触发条件、角色动作、系统反馈与异常分支。
4. 业务规则清单：积分计算、兑换条件、重复操作、退款相关处理等未知项用 [待确认：具体规则] 标注，不自行设定答案。
5. 验收标准：为每条核心流程列出“给定条件—操作—预期结果”。引用待确认规则时保留占位符，避免虚构数值。
6. 最多 5 个会阻碍范围或流程决策的澄清问题，按优先级排序。

用简体中文，优先使用短段落和必要表格。保证需求、流程和验收条目相互对应；提出的扩展能力不能默认加入 MVP。`,
      changes: [
        "把零散想法整理为目标、范围、流程、规则与验收六个部分。",
        "要求验收条目与核心流程对应，便于讨论后交给开发者。",
        "将积分比例等未知规则保留为待确认项，避免替用户作业务决策。",
      ],
      assumptions: [
        "将轻量 PRD 作为本次需求整理的交付形式，可按实际需要替换。",
        "重复操作与退款仅列为待讨论异常，不默认增加 MVP 功能。",
      ],
    },
    {
      id: "demo-b",
      provider: "方案 B · 用户与流程",
      model: "手工示例 · 未调用 API",
      status: "success",
      latencyMs: 0,
      prompt: `请从真实使用流程出发，为一家独立咖啡店设计会员系统的最小可用版本。先整理产品需求，不写代码。

我已经确定的目标只有两项：店员结账时给会员累计积分；会员用积分兑换优惠券。只服务单店，明确不做储值、外卖、商城、多门店或复杂营销。网页、小程序等载体还没确定，也没有可引用的经营数据和用户访谈。

请围绕店员和会员，各写一条最短的用户旅程。每一步列出用户要完成的事、需要提供的信息、系统应反馈的状态，以及可能阻塞流程的问题。会员识别方式、积分规则和券规则均标为待确认，不自行选定。

把这两条旅程收敛成 MVP 功能清单，区分“直接支撑核心流程”和“建议后续讨论”。为核心流程给出成功路径与关键异常的验收例子；需要数值或业务规则的地方使用明确占位符。

最后给店主一份简短的待决策清单，优先列出会改变范围或操作方式的问题。不要把假设写成已验证的用户需求；所有产品建议应说明它服务于哪个已知目标。用简体中文输出，结构紧凑。`,
      changes: [
        "改为从店员与会员两条用户旅程梳理功能。",
        "加入系统状态与流程阻塞点，方便核对实际使用过程。",
        "保留明确排除项，并要求标明尚未验证的建议。",
      ],
      assumptions: ["用户旅程作为讨论方法，不代表已有观察或访谈证据。"],
    },
    {
      id: "demo-c",
      provider: "方案 C · 最小决策文档",
      model: "手工示例 · 未调用 API",
      status: "success",
      latencyMs: 0,
      prompt: `帮我把下面的想法整理成一份简明的 MVP 决策文档，用于和独立咖啡店店主对齐需求，暂不实现代码。

想法：只做一家门店的会员积分系统。店员在结账时累计会员积分，会员使用积分兑换优惠券。第一版明确排除储值、外卖、商城、多门店和复杂营销。

请输出一张核心需求表，字段为：用户目标、必要能力、主要流程、验收方式、待确认规则。覆盖积分累计与积分兑换优惠券两条流程；不要凭空增加商业数据、积分数值、优惠券门槛或用户研究结论。平台载体及外部系统接口未确定，用待确认项表示。

随后用短段落说明：哪些问题必须先由店主决策，哪些细节可以后续细化，以及哪些提议会突破当前范围。对任何新增建议明确标注“建议，待确认”；不把它直接列为已承诺功能。用简体中文，保留必要信息，让文档适合快速讨论。`,
      changes: [
        "收敛为一张可讨论的需求表，减少文档准备负担。",
        "让每项能力同时具备验收方式与待确认规则。",
        "明确新增建议不等于第一版承诺。",
      ],
      assumptions: ["将快速对齐需求作为文档形式的侧重点，可在确认范围后扩展为详细 PRD。"],
    },
  ],
  judge: {
    status: "complete",
    candidates: [
      sampleScore("demo-a", [100, 100, 100, 75, 75]),
      sampleScore("demo-b", [100, 100, 75, 50, 75]),
      sampleScore("demo-c", [100, 75, 75, 75, 75]),
    ],
    recommendedId: "demo-a",
    tiedIds: [],
    summary: "演示结果：提示词与分数均为手工编写，未调用任何模型 API 或 Jev，也未验证实际效果。示例中方案 A 更便于逐项核对需求、流程与验收；方案 B 侧重使用过程，方案 C 适合快速讨论。分数仅用于展示规则加权后的比较方式，不代表成功率。",
    model: "手工示例 · 非 Jev 评审",
    evaluatedAt: "2026-10-13T03:00:00.000Z",
  },
};
