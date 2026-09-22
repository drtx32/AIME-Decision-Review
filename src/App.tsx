import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, CircleAlert, FileText, History, Menu, Plus, Send, Sparkles, X } from 'lucide-react';
import { reviewApi, type Input, type Result, type ReviewEvent } from './api';

type Phase = 'compose' | 'running' | 'review';
type Message = { role: 'assistant' | 'user'; text: string; time?: string };
const blank: Input = { symbol: '', market: 'A股', side: 'buy', executedAt: '2024-03-18T10:24', price: '', quantity: '', reason: '', notes: '' };
const demoMessages: Message[] = [{ role: 'assistant', text: '你好，我会把这次投资决策还原到 T0。你可以直接描述当时为什么买入或卖出，我会先提取关键信息，再请你确认。' }];

export default function App() {
  const [phase, setPhase] = useState<Phase>('compose');
  const [input, setInput] = useState<Input>(blank);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Message[]>(demoMessages);
  const [result, setResult] = useState<Result | null>(null);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [error, setError] = useState('');
  const [reviewId, setReviewId] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [mobilePanel, setMobilePanel] = useState(false);
  const demoMode = !import.meta.env.VITE_API_BASE_URL;

  const update = (key: keyof Input, value: string) => setInput((current) => ({ ...current, [key]: value }));
  const extracted = useMemo(() => input.symbol || draft.match(/\b\d{5,6}\b/)?.[0] || '', [draft, input.symbol]);

  useEffect(() => {
    if (extracted && !input.symbol) update('symbol', extracted);
  }, [extracted]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim() && !input.reason.trim()) return;
    const reason = input.reason || draft.trim();
    const next = { ...input, symbol: extracted, reason };
    if (!next.symbol) { setError('请在描述中提供标的代码或名称。'); return; }
    setInput(next);
    setMessages((items) => [...items, { role: 'user', text: draft.trim() || reason }]);
    setDraft(''); setError('');
  };

  const run = async () => {
    if (!input.symbol || !input.reason) { setError('请先发送一段决策描述，并确认标的信息。'); return; }
    setPhase('running'); setError(''); setEvents([]);
    try {
      const created = await reviewApi.create(input);
      setReviewId(created.id);
      if (created.demo) {
        setEvents(created.events);
        const next = await reviewApi.result(created.id);
        setResult(next); setHistory((items) => [input.symbol, ...items.filter((x) => x !== input.symbol)]); setPhase('review');
        setMessages((items) => [...items, { role: 'assistant', text: '我已完成这次演示复盘。右侧保留证据与结果，你也可以继续追问。' }]);
        return;
      }
      await reviewApi.waitForResult(created.id, (nextEvents) => setEvents(nextEvents));
      const next = await reviewApi.result(created.id);
      setResult(next); setHistory((items) => [input.symbol, ...items.filter((x) => x !== input.symbol)]); setPhase('review');
      setMessages((items) => [...items, { role: 'assistant', text: '复盘完成。我把事前证据、事后结果和归因拆开了，你可以在右侧查看详情。' }]);
    } catch (e) {
      setPhase('compose'); setError(e instanceof Error ? e.message : '复盘暂时无法启动，请稍后重试。');
    }
  };

  const followUp = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    const question = draft.trim(); setDraft('');
    setMessages((items) => [...items, { role: 'user', text: question }, { role: 'assistant', text: '这个问题已加入当前复盘上下文。请结合右侧的 Ex-Ante 证据和失效条件继续核对；新的模型追问能力将在服务端配置后启用。' }]);
  };

  const newReview = () => { setPhase('compose'); setInput(blank); setResult(null); setReviewId(''); setEvents([]); setError(''); setMessages(demoMessages); };

  return <div className="app">
    <header><div className="brand"><b><i>A</i>AIME</b><small>DECISION REVIEW</small></div><div className="header-status"><span className={demoMode ? 'status-dot demo' : 'status-dot'} />{demoMode ? 'DEV / DEMO MODE' : 'SESSION SECURE'}<button className="mobile-menu" onClick={() => setMobilePanel(!mobilePanel)}><Menu size={17}/></button></div></header>
    <div className="workspace">
      <aside className={mobilePanel ? 'sidebar open' : 'sidebar'}><div className="sidebar-title"><span><History size={14}/> REVIEW SESSIONS</span><button onClick={newReview}><Plus size={15}/></button></div><button className="new-session" onClick={newReview}><Plus size={14}/> 新建决策复盘</button><div className="session-list">{history.length ? history.map((item) => <button className="session" key={item}><span className="session-mark"/><span><b>{item}</b><small>刚刚 · 投资决策</small></span></button>) : <p className="empty-history">你的复盘会出现在这里</p>}</div><div className="sidebar-bottom"><span>WORKSPACE</span><b>景羿霖的研究空间</b><small>{demoMode ? '本地演示数据，不写入服务端' : '证据仅在服务端处理'}</small></div></aside>
      <main className="conversation"><div className="conversation-head"><div><span className="eyebrow">INVESTMENT DECISION REVIEW</span><h1>{phase === 'compose' ? '从一次决策开始' : phase === 'running' ? '正在重建证据链' : `${input.symbol} · 决策复盘`}</h1></div><span className="t0-badge">T0 <b>{input.executedAt.replace('T', ' ')}</b></span></div><div className="conversation-body">{messages.map((message, index) => <div className={'message-row '+message.role} key={index}><div className="avatar">{message.role === 'assistant' ? <Sparkles size={14}/> : '景'}</div><div className="message"><span>{message.role === 'assistant' ? 'AIME REVIEW AGENT' : 'YOU'}</span><p>{message.text}</p></div></div>)}{phase === 'running' && <Running events={events}/>} {phase === 'review' && <div className="review-ready"><Check size={15}/> REVIEW READY <small>右侧已更新完整报告</small></div>}</div><form className="composer" onSubmit={phase === 'review' ? followUp : send}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={phase === 'review' ? '继续追问这次复盘…' : '例如：我在 2024 年 3 月 18 日以 1680 元买入 600519，因为渠道库存改善…'} /><div className="composer-foot"><span>{phase === 'review' ? 'FOLLOW-UP IN THIS SESSION' : '自然语言输入 · AIME 会提取结构化字段'}</span><button aria-label="发送" disabled={phase === 'running'}><Send size={16}/></button></div></form>{error && <div className="error-banner"><CircleAlert size={15}/>{error}<button onClick={() => setError('')}><X size={14}/></button></div>}{phase === 'compose' && <div className="confirm-card"><div><span className="eyebrow">EXTRACTED DECISION</span><strong>{input.symbol || '等待标的'}</strong></div><div className="chips"><Chip label="市场" value={input.market} options={['A股','港股','美股']} onChange={(value) => update('market', value)}/><Chip label="方向" value={input.side === 'buy' ? '买入' : '卖出'} options={['买入','卖出']} onChange={(value) => update('side', value === '买入' ? 'buy' : 'sell')}/><Chip label="价格" value={input.price || '待确认'} onChange={(value) => update('price', value)}/><Chip label="数量" value={input.quantity || '待确认'} onChange={(value) => update('quantity', value)}/></div><button className="run-button" onClick={run} disabled={!input.symbol || !input.reason}><Sparkles size={15}/>确认字段并开始复盘 <ChevronRight size={15}/></button></div>}</main>
      <aside className={mobilePanel ? 'evidence-panel open' : 'evidence-panel'}><div className="panel-head"><span><FileText size={14}/> REVIEW REPORT</span><button onClick={() => setMobilePanel(false)}><X size={15}/></button></div>{result ? <Report result={result}/> : <div className="panel-placeholder"><div className="placeholder-icon"><FileText size={22}/></div><h3>证据报告将在这里展开</h3><p>完成一次复盘后，这里会显示 Ex-Ante / Ex-Post 证据、归因和下一次 Checklist。</p><div className="placeholder-line"/><div className="placeholder-line short"/></div>}</aside>
    </div><footer>Evidence before hindsight. <span>{demoMode ? 'DEV / DEMO MODE · 演示数据' : 'MCP status: server configured'}</span></footer>
  </div>;
}

function Chip({ label, value, options, onChange }: { label: string; value: string; options?: string[]; onChange: (value: string) => void }) { return <label className="chip"><small>{label}</small>{options ? <select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select> : <input value={value === '待确认' ? '' : value} placeholder={value} onChange={(e) => onChange(e.target.value)}/>}</label>; }
function Running({ events }: { events: ReviewEvent[] }) { const latest = events[events.length - 1]; return <div className="running-inline"><span className="spinner"/><div><b>LIVE REVIEW STATUS</b><p>{latest?.message || '正在等待服务端事件…'}</p></div><small>{events.length ? `${events.length} events` : 'connecting'}</small></div>; }
function Report({ result }: { result: Result }) { return <div className="report"><div className="report-summary"><span className="complete"><Check size={12}/> COMPLETE</span><h2>{result.input.symbol}<span> · {result.input.side === 'buy' ? '买入' : '卖出'}</span></h2><p>{result.summary}</p><strong>62<small>判断质量</small></strong></div><div className="report-t0"><b>T0 · {result.input.executedAt.replace('T', ' ')}</b><span>时间边界已冻结</span></div><Evidence title="Ex-Ante · 当时已知" items={result.ante} tone="ante"/><Evidence title="Ex-Post · 事后信息" items={result.post} tone="post"/><div className="report-block"><span className="eyebrow">ATTRIBUTION</span><h3>归因可信度</h3><p><b className="tag green">SUPPORTED</b> 渠道库存改善是 T0 前可支持的核心判断。</p><p><b className="tag yellow">UNCERTAIN</b> 批价企稳缺少明确验证条件。</p></div><div className="report-block"><span className="eyebrow">NEXT TIME</span><h3>Checklist</h3>{['把“企稳”写成可验证条件','下单前记录反向证据','预先写下失效条件'].map((item, i) => <div className="check-item" key={item}><b>0{i + 1}</b><span>{item}</span></div>)}</div></div>; }
function Evidence({ title, items, tone }: { title: string; items: string[]; tone: string }) { return <div className={'report-block evidence-block '+tone}><div className="evidence-title"><h3>{title}</h3><small>{items.length} 条</small></div>{items.map((item, index) => <div className="evidence-item" key={item}><b>0{index + 1}</b><span>{item}</span><ChevronRight size={13}/></div>)}</div>; }
