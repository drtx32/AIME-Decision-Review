import { useEffect, useState } from 'react';
import { BookOpen, Check, ChevronRight, CircleAlert, FileText, LogOut, Menu, Plus, Send, Settings, Sparkles, X } from 'lucide-react';
import { reviewApi, resultView, type LearningMemory, type Result, type SessionDecision, type SessionMessage, type SessionSnapshot } from './api';

type Phase = 'compose' | 'confirm' | 'running' | 'review';
type PanelTab = 'decisions' | 'timeline' | 'evidence' | 'findings' | 'learning';
const welcome: SessionMessage = { id: 'welcome', sessionId: '', userId: 'dev-user', role: 'assistant', content: '告诉我一笔或一组历史投资决策。我会先识别每个 decision 的 T0、方向与标的，确认后再开始复盘。', createdAt: new Date().toISOString() };

export default function App() {
  const [phase, setPhase] = useState<Phase>('compose');
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; status: string; updatedAt: string }>>([]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([welcome]);
  const [decisions, setDecisions] = useState<SessionDecision[]>([]);
  const [memories, setMemories] = useState<LearningMemory[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<PanelTab>('decisions');
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [mobilePanel, setMobilePanel] = useState(false);

  const applySnapshot = (next: SessionSnapshot) => { setSnapshot(next); setMessages(next.messages); setDecisions(next.decisions); setMemories(next.memories); };
  useEffect(() => { reviewApi.listSessions().then(setSessions).catch(() => undefined); }, []);

  const newReview = () => { setSessionId(''); setSnapshot(null); setMessages([welcome]); setDecisions([]); setMemories([]); setDraft(''); setError(''); setPhase('compose'); setTab('decisions'); setMobileSidebar(false); };
  const openSession = async (id: string) => { try { const next = await reviewApi.getSession(id); setSessionId(id); applySnapshot(next); setPhase(next.results.length ? 'review' : next.decisions.length ? 'confirm' : 'compose'); setMobileSidebar(false); } catch (e) { setError(e instanceof Error ? e.message : '无法恢复会话。'); } };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); const content = draft.trim(); if (!content || phase === 'running') return; setDraft(''); setError('');
    try {
      if (!sessionId) { const created = await reviewApi.createSession(content); setSessionId(created.sessionId); setMessages(created.messages); setDecisions(created.decisions); setMemories(created.memories); setPhase('confirm'); if (created.local) setError('当前为本地壳模式；确认并运行需要已配置的服务端模型。'); return; }
      const message = await reviewApi.sendMessage(sessionId, content); setMessages((items) => [...items, message]);
    } catch (e) { setError(e instanceof Error ? e.message : '消息发送失败。'); }
  };

  const confirm = async () => {
    if (!sessionId || !decisions.length) return; setError(''); setPhase('running');
    try { await reviewApi.confirm(sessionId); const next = await reviewApi.waitForSession(sessionId, applySnapshot); applySnapshot(next); setPhase('review'); setSessions(await reviewApi.listSessions()); setTab('evidence'); }
    catch (e) { setPhase('confirm'); setError(e instanceof Error ? e.message : '复盘服务暂时不可用。'); }
  };

  const result = snapshot ? resultView(snapshot) : null;
  return <div id="app">
    <button className="mobile-toggle" onClick={() => setMobileSidebar(!mobileSidebar)}><Menu size={18}/></button>
    <aside className={mobileSidebar ? 'sidebar open' : 'sidebar'}>
      <div className="brand"><span className="brand-dot">A</span><span>AIME<small>Decision Review</small></span></div>
      <nav className="nav-group"><span className="nav-eyebrow">NEW REVIEW</span><button className={!sessionId ? 'nav-item active' : 'nav-item'} onClick={newReview}><Plus size={15}/> 新建复盘</button></nav>
      <nav className="nav-group"><span className="nav-eyebrow">REVIEW SESSIONS</span><div className="session-nav">{sessions.length ? sessions.map((item) => <button className={item.id === sessionId ? 'nav-item active' : 'nav-item'} key={item.id} onClick={() => openSession(item.id)}><span className="session-dot"/><span>{item.title}<small>{item.status === 'completed' ? '已完成' : '进行中'}</small></span></button>) : <p className="nav-empty">还没有历史会话</p>}</div></nav>
      <nav className="nav-group"><span className="nav-eyebrow">LEARNING</span><button className={tab === 'learning' ? 'nav-item active' : 'nav-item'} onClick={() => { setTab('learning'); setMobilePanel(true); }}><BookOpen size={15}/> Patterns & Learning</button></nav>
      <div className="side-note"><b>景羿霖</b><span>数据私有 · 仅本人可见</span><small>Session context 按 user_id 隔离</small></div>
      <div className="account-actions"><button><Settings size={14}/> 设置</button><button><LogOut size={14}/> 退出</button></div>
    </aside>
    <main className="main-shell"><div className="conversation-top"><div><span className="eyebrow">AIME / REVIEW SESSION</span><h1>{snapshot?.session.title || '从一次决策开始'}</h1></div><div className="private-badge"><span/> PRIVATE WORKSPACE</div></div>
      <section className="conversation-stream">{messages.map((message, index) => <Message key={message.id || index} message={message}/>)}{phase === 'running' && <div className="status-message"><span className="pulse"/><div><b>LIVE REVIEW STATUS</b><p>正在重建每笔决策各自的 T0 前信息环境…</p></div></div>}{phase === 'review' && <div className="status-message done"><Check size={15}/><div><b>REVIEW COMPLETE</b><p>证据、归因与学习已写回当前 session。</p></div></div>}</section>
      <form className="composer" onSubmit={submit}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} disabled={phase === 'running'} placeholder={phase === 'review' ? '继续追问这次复盘，问题会发送到当前 session…' : '例如：我今天卖了金牛化工，又买入 XX，还给 YY 加仓，帮我一起复盘。'}/><div className="composer-meta"><span>{sessionId ? 'MESSAGE IN CURRENT SESSION' : 'NATURAL LANGUAGE · 1..N DECISIONS'}</span><button type="submit" disabled={phase === 'running' || !draft.trim()}><Send size={15}/></button></div></form>
      {error && <div className="error-banner"><CircleAlert size={15}/><span>{error}</span><button onClick={() => setError('')}><X size={14}/></button></div>}
      {phase === 'confirm' && decisions.length > 0 && <DecisionConfirm decisions={decisions} onConfirm={confirm} onChange={(id, patch) => { setDecisions((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item)); if (sessionId) void reviewApi.updateDecision(sessionId, id, patch); }}/>}
    </main>
    <aside className={mobilePanel ? 'context-panel open' : 'context-panel'}><div className="context-head"><span><FileText size={14}/> SESSION CONTEXT</span><button className="panel-close" onClick={() => setMobilePanel(false)}><X size={15}/></button></div><div className="context-tabs">{(['decisions','timeline','evidence','findings','learning'] as PanelTab[]).map((item) => <button className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)}>{item}</button>)}</div><ContextPanel tab={tab} decisions={decisions} messages={messages} memories={memories} result={result}/></aside>
  </div>;
}

function Message({ message }: { message: SessionMessage }) { const status = message.role === 'status'; return <div className={'message-row '+message.role}><div className="message-avatar">{message.role === 'assistant' ? <Sparkles size={14}/> : message.role === 'status' ? <span className="status-mark"/> : '景'}</div><div className="message-bubble"><span>{message.role === 'assistant' ? 'AIME REVIEW AGENT' : message.role === 'status' ? 'REVIEW STATUS' : 'YOU'}</span><p className={status ? 'status-copy' : ''}>{message.content}</p></div></div>; }
function DecisionConfirm({ decisions, onConfirm, onChange }: { decisions: SessionDecision[]; onConfirm: () => void; onChange: (id: string, patch: Partial<SessionDecision>) => void }) { return <div className="decision-confirm"><div className="confirm-heading"><div><span className="eyebrow">EXTRACTED DECISIONS</span><strong>{decisions.length} 笔，请确认或修改</strong></div><button onClick={onConfirm}><Sparkles size={14}/> 确认并复盘 <ChevronRight size={14}/></button></div><div className="decision-cards">{decisions.map((decision, i) => <div className="decision-card" key={decision.id}><span className="decision-index">0{i + 1}</span><div><input aria-label={`decision-${i + 1}-symbol`} value={decision.symbol} onChange={(e) => onChange(decision.id, { symbol: e.target.value })}/><select value={decision.action} onChange={(e) => onChange(decision.id, { action: e.target.value as 'buy' | 'sell' })}><option value="buy">买入</option><option value="sell">卖出</option></select><small>T0 · <input aria-label={`decision-${i + 1}-time`} type="datetime-local" value={decision.executedAt.slice(0, 16)} onChange={(e) => onChange(decision.id, { executedAt: new Date(e.target.value).toISOString() })}/></small></div></div>)}</div></div>; }
function ContextPanel({ tab, decisions, messages, memories, result }: { tab: PanelTab; decisions: SessionDecision[]; messages: SessionMessage[]; memories: LearningMemory[]; result: Result | null }) { if (tab === 'decisions') return <div className="context-content"><span className="eyebrow">DECISIONS</span>{decisions.length ? decisions.map((d, i) => <div className="context-decision" key={d.id}><b>0{i + 1} · {d.symbol}</b><span>{d.action === 'buy' ? '买入' : '卖出'} · T0 {d.executedAt.slice(0, 16).replace('T', ' ')}</span></div>) : <Empty text="自然语言识别出的 decisions 会出现在这里。"/>}</div>; if (tab === 'timeline') return <div className="context-content"><span className="eyebrow">TIMELINE</span>{messages.filter((m) => m.role === 'status').map((m) => <div className="timeline-item" key={m.id}><i/>{m.content}</div>)}<p className="muted">每个 review run 的状态由服务端事件写入 session。</p></div>; if (tab === 'learning') return <div className="context-content"><span className="eyebrow">ACTIVE LEARNING</span>{memories.length ? memories.map((m) => <div className="memory" key={m.id}><BookOpen size={14}/><span>{m.text}<small>{m.kind} · strength {m.strength}</small></span></div>) : <Empty text="完成复盘后，长期学习会沉淀在这里。"/>}</div>; if (tab === 'evidence') return result ? <Report result={result}/> : <Empty text="复盘完成后，Ex-Ante / Ex-Post 证据会在这里展开。"/>; return <div className="context-content"><span className="eyebrow">FINDINGS</span>{result ? <><Finding label="SUPPORTED" text="事前证据与核心判断链条已完成对齐。"/><Finding label="UNCERTAIN" text="时间判断仍需要明确的验证条件。"/><Finding label="NEXT" text="下一次决策前记录反向证据与失效条件。"/></> : <Empty text="归因与下一次 Checklist 将出现在这里。"/>}</div>; }
function Finding({ label, text }: { label: string; text: string }) { return <div className="finding"><b>{label}</b><span>{text}</span></div>; }
function Empty({ text }: { text: string }) { return <p className="panel-empty">{text}</p>; }
function Report({ result }: { result: Result }) { return <div className="context-content report"><span className="complete"><Check size={12}/> REVIEW RESULT</span><h2>{result.input.symbol}<small> · {result.input.side === 'buy' ? '买入' : '卖出'}</small></h2><p className="report-summary">{result.summary}</p><section className="evidence-mini ante"><b>EX-ANTE · 当时已知</b>{result.ante.map((item) => <p key={item}>{item}</p>)}</section><section className="evidence-mini post"><b>EX-POST · 事后信息</b>{result.post.map((item) => <p key={item}>{item}</p>)}</section></div>; }
