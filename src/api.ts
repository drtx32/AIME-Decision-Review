export type Input = { symbol: string; market: string; side: 'buy' | 'sell'; executedAt: string; price: string; quantity: string; reason: string; notes: string };
export type ReviewEvent = { id: string; kind: string; message: string; at: string };
export type Result = { id: string; input: Input; summary: string; ante: string[]; post: string[] };
type Created = { id: string; demo?: boolean; events: ReviewEvent[] };
const apiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
const demo: Result = { id: 'demo-600519', input: { symbol: '600519', market: 'A股', side: 'buy', executedAt: '2024-03-18T10:24', price: '1680', quantity: '100', reason: '渠道库存改善，预期批价企稳后业绩恢复。', notes: '计划持有 6–12 个月。' }, summary: '这是一笔基于基本面拐点预期的买入。核心判断方向部分成立，但仓位与失效条件未被明确写入决策。', ante: ['2024-03-15：公司披露经营数据，渠道库存处于可控区间。', '2024-03-18 09:30：股价低于 60 日均线，估值处于近三年 42% 分位。', '决策时可知：北向资金连续 3 日净流出，属于需要跟踪的反向信号。'], post: ['2024-04-08：批价继续下探，渠道反馈弱于预期。', '2024-05-10：一季报收入同比下降，市场预期进一步下修。', '2024-06-28：股价较 T0 下跌 18.4%，这是结果信息，不应倒灌到事前判断。'] };
const demoEvents = (id: string): ReviewEvent[] => ['Decision received. T0 frozen.', 'Evidence retrieval confirmed.', 'Evidence split around T0.', 'Reflection complete.'].map((message, i) => ({ id: `${id}-${i}`, kind: 'status', message, at: new Date().toISOString() }));
const marketCode = (market: string) => market === 'A股' ? 'CN' : market === '港股' ? 'HK' : 'US';
const formatEvidence = (item: { publishedAt: string; content: string }) => `${item.publishedAt.slice(0, 10)}：${item.content}`;

async function remoteCreate(input: Input): Promise<Created> {
  const response = await fetch(`${apiBase}/reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: input.symbol, market: marketCode(input.market), action: input.side, executedAt: new Date(input.executedAt).toISOString(), price: Number(input.price) || undefined, quantity: Number(input.quantity) || undefined, userReason: input.reason, notes: input.notes }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || '复盘服务暂时不可用，请联系管理员。');
  return { id: body.id, events: [] };
}
async function remoteEvents(id: string): Promise<ReviewEvent[]> { const response = await fetch(`${apiBase}/reviews/${id}/events`); if (!response.ok) return []; const body = await response.json() as { events: ReviewEvent[] }; return body.events; }
async function remoteStatus(id: string) { const response = await fetch(`${apiBase}/reviews/${id}`); if (!response.ok) throw new Error('无法读取复盘状态。'); return await response.json() as { status: string; errorMessage?: string }; }
async function remoteResult(id: string): Promise<Result> { const response = await fetch(`${apiBase}/reviews/${id}/result`); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.message || '复盘结果尚未准备好。'); const value = body.result; const input = value.decision; return { id, input: { symbol: input.symbol, market: input.market === 'CN' ? 'A股' : input.market === 'HK' ? '港股' : '美股', side: input.action, executedAt: input.executedAt, price: String(input.price ?? ''), quantity: String(input.quantity ?? ''), reason: input.userReason ?? '', notes: input.notes ?? '' }, summary: value.decisionQuality.reasoning, ante: value.exAnteEvidence.map(formatEvidence), post: value.exPostEvidence.map(formatEvidence) }; }

export const reviewApi = {
  async create(input: Input): Promise<Created> { if (!apiBase) { await new Promise((resolve) => setTimeout(resolve, 350)); return { id: demo.id, demo: true, events: demoEvents(demo.id) }; } return remoteCreate(input); },
  async result(id: string) { if (!apiBase) { await new Promise((resolve) => setTimeout(resolve, 200)); return { ...demo, id }; } return remoteResult(id); },
  async waitForResult(id: string, onEvents: (events: ReviewEvent[]) => void) { for (let attempt = 0; attempt < 120; attempt += 1) { const [status, events] = await Promise.all([remoteStatus(id), remoteEvents(id)]); onEvents(events); if (['completed', 'partial'].includes(status.status)) return; if (status.status === 'failed') throw new Error(status.errorMessage || '复盘执行失败，请联系管理员。'); await new Promise((resolve) => setTimeout(resolve, 500)); } throw new Error('复盘等待超时，请稍后查看服务状态。'); }
};
