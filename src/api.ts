export type Input = { symbol: string; market: string; side: 'buy' | 'sell'; executedAt: string; price: string; quantity: string; reason: string; notes: string };
export type ReviewEvent = { id: string; kind: string; message: string; at: string };
export type Result = { id: string; input: Input; summary: string; ante: string[]; post: string[] };
export type SessionDecision = { id: string; symbol: string; market: string; action: 'buy' | 'sell'; executedAt: string; price: number | null; quantity: number | null; reason: string; notes: string; reviewId: string | null; confirmed: boolean };
export type SessionMessage = { id: string; sessionId: string; userId: string; role: 'user' | 'assistant' | 'status'; content: string; createdAt: string };
export type LearningMemory = { id: string; text: string; kind: string; sourceSessionId: string; sourceDecisionId: string | null; strength: number; active: boolean };
export type SessionSnapshot = { session: { id: string; title: string; scope: string; status: string }; decisions: SessionDecision[]; messages: SessionMessage[]; memories: LearningMemory[]; results: Array<{ decisionId: string; reviewId: string; result: any }> };
const apiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
const userHeaders = { 'content-type': 'application/json', 'x-user-id': 'dev-user' };
const unavailable = '当前未配置可用的大模型服务，请联系管理员。';

async function request(path: string, init: RequestInit = {}) {
  if (!apiBase) throw new Error(unavailable);
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { ...userHeaders, ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || unavailable);
  return body;
}

const localDecisions = (message: string): SessionDecision[] => {
  const found: Array<{ action: 'buy' | 'sell'; symbol: string }> = [];
  const pattern = /(卖出|卖了|卖掉|减仓|买入|买了|加仓)\s*([^，,。；;和又以及]+)/g;
  for (const match of message.matchAll(pattern)) found.push({ action: /卖|减仓/.test(match[1]) ? 'sell' : 'buy', symbol: match[2].trim() });
  if (!found.length) found.push({ action: /卖|减仓/.test(message) ? 'sell' : 'buy', symbol: message.match(/\b\d{5,6}\b/)?.[0] || '待识别标的' });
  const now = new Date().toISOString();
  return found.slice(0, 12).map((item, index) => ({ id: `local-${index}`, symbol: item.symbol, market: 'CN', action: item.action, executedAt: new Date(Date.parse(now) + index * 60000).toISOString(), price: null, quantity: null, reason: message, notes: '', reviewId: null, confirmed: false }));
};

export const reviewApi = {
  async listSessions() { if (!apiBase) return []; const body = await request('/sessions'); return body.sessions as Array<{ id: string; title: string; status: string; updatedAt: string }>; },
  async getSession(id: string): Promise<SessionSnapshot> { return request(`/sessions/${encodeURIComponent(id)}`); },
  async createSession(message: string): Promise<{ sessionId: string; decisions: SessionDecision[]; messages: SessionMessage[]; memories: LearningMemory[]; local?: boolean }> {
    if (!apiBase) return { sessionId: 'local-session', decisions: localDecisions(message), messages: [{ id: 'local-message', sessionId: 'local-session', userId: 'dev-user', role: 'user', content: message, createdAt: new Date().toISOString() }], memories: [], local: true };
    return request('/sessions', { method: 'POST', body: JSON.stringify({ message }) });
  },
  async confirm(sessionId: string) { if (!apiBase) throw new Error(unavailable); return request(`/sessions/${encodeURIComponent(sessionId)}/confirm`, { method: 'POST' }); },
  async sendMessage(sessionId: string, content: string): Promise<SessionMessage> { if (!apiBase) throw new Error(unavailable); const body = await request(`/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: JSON.stringify({ content }) }); return body.message; },
  async waitForSession(sessionId: string, onSnapshot: (snapshot: SessionSnapshot) => void) { for (let attempt = 0; attempt < 180; attempt += 1) { const snapshot = await this.getSession(sessionId); onSnapshot(snapshot); const linked = snapshot.decisions.filter((decision) => decision.reviewId); if (linked.length && linked.every((decision) => snapshot.results.some((item) => item.decisionId === decision.id && item.result))) return snapshot; await new Promise((resolve) => setTimeout(resolve, 500)); } throw new Error('复盘等待超时，请稍后查看服务状态。'); },
};

export function resultView(snapshot: SessionSnapshot): Result | null {
  const first = snapshot.results.find((item) => item.result)?.result; if (!first) return null;
  const input = first.decision; return { id: first.decision.T0, input: { symbol: input.symbol, market: input.market === 'CN' ? 'A股' : input.market === 'HK' ? '港股' : '美股', side: input.action, executedAt: input.executedAt, price: String(input.price ?? ''), quantity: String(input.quantity ?? ''), reason: input.userReason ?? '', notes: '' }, summary: first.decisionQuality.reasoning, ante: first.exAnteEvidence.map((e: any) => `${e.publishedAt.slice(0, 10)}：${e.content}`), post: first.exPostEvidence.map((e: any) => `${e.publishedAt.slice(0, 10)}：${e.content}`) };
}
