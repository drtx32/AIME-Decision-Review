import {useEffect, useState} from 'react';import {AlertTriangle,ArrowRight,Check,ChevronRight,LogOut,RotateCcw,ShieldCheck,Sparkles,UserCog,Users} from 'lucide-react';
import {mock,ProviderUnavailableError,fetchProviderStatus,type Input,type Result} from './api';
import {auth,adminUsers,ApiError,type PublicUser} from './auth-api';
type Screen='login'|'change-password'|'home'|'running'|'result'|'admin';
const stages=['行情与市场环境','指数与行业基准','新闻与公告','时间对齐与事实检查','生成结构化复盘'];
const blank:Input={symbol:'',market:'A股',side:'buy',executedAt:'2024-03-18T10:24',price:'',quantity:'',reason:'',notes:''};
type ProviderBanner={kind:'unconfigured'|'error'|'ready';message:string};
function bannerFromStatus(s: Awaited<ReturnType<typeof fetchProviderStatus>>):ProviderBanner|null{
  if(!s)return null;
  if(s.status==='unconfigured')return {kind:'unconfigured',message:'当前未配置可用的大模型服务，请联系管理员配置模型供应商/API Key 后重试。'};
  if(s.status==='error')return {kind:'error',message:'当前未配置可用的大模型服务，请联系管理员。'};
  return null;
}
export default function App(){
  const[s,setS]=useState<Screen>('login');
  const[user,setUser]=useState<PublicUser|null>(null);
  const[bootError,setBootError]=useState<string|null>(null);
  const[banner,setBanner]=useState<ProviderBanner|null>(null);
  // Existing review state — preserved from the pre-auth UI.
  const[v,setV]=useState<Input>(blank);
  const[r,setR]=useState<Result|null>(null);
  const[p,setP]=useState(0);
  // ELI-326 — provider readiness probe on mount. Drives the admin banner
  // across every authenticated screen, never blocks the UI.
  useEffect(()=>{fetchProviderStatus().then(st=>{const b=bannerFromStatus(st);if(b)setBanner(b);}).catch(()=>{});},[]);
  useEffect(()=>{void bootstrap();},[]);
  async function bootstrap(){
    try{
      const me=await auth.me();
      if(!me){setS('login');return;}
      setUser(me.user);
      if(me.mustChangePassword){setS('change-password');}else{setS('home');}
    }catch(e){
      setBootError(e instanceof Error?e.message:'无法连接到后端');
      setS('login');
    }
  }
  async function handleLoginSuccess(payload:PublicUser,mustChange:boolean){
    setUser(payload);
    setS(mustChange?'change-password':'home');
  }
  async function handleLogout(){
    try{await auth.logout();}catch{}
    setUser(null);
    setR(null);
    setP(0);
    setS('login');
  }
  async function handlePasswordChanged(payload:PublicUser){
    setUser(payload);
    setS('home');
  }
  // ELI-326 — handle stable provider-unavailable codes from the API
  // without exposing stack traces; everything else surfaces as a generic
  // network-error banner.
  async function submitReview(e:React.FormEvent){
    e.preventDefault();setBanner(null);setS('running');
    for(let i=1;i<=5;i++){await new Promise(x=>setTimeout(x,280));setP(i)}
    try{
      const x=await mock.createReview(v);
      setR(await mock.result(x.id));
      setS('result');
    }catch(err){
      if(err instanceof ProviderUnavailableError){
        setBanner({kind:'unconfigured',message:err.adminMessage});
      }else{
        setBanner({kind:'error',message:'网络异常，请稍后重试。'});
      }
      setS('home');
    }
  }
  if(s==='login')return <div className="app"><Header user={null} onLogout={handleLogout}/><main><LoginScreen bootError={bootError} onSuccess={handleLoginSuccess}/></main></div>;
  if(s==='change-password'&&user)return <div className="app"><Header user={user} onLogout={handleLogout}/><main><ChangePasswordScreen username={user.username} mustChange onSuccess={handlePasswordChanged}/></main></div>;
  if(s==='admin'&&user)return <div className="app"><Header user={user} onLogout={handleLogout}/><main>{banner&&<ProviderBannerUI banner={banner}/>}<AdminScreen onBack={()=>setS('home')}/></main></div>;
  if(s==='home'&&user)return <div className="app"><Header user={user} onLogout={handleLogout} onOpenAdmin={()=>setS('admin')}/><main>{banner&&<ProviderBannerUI banner={banner}/>}<Home v={v} setV={setV} go={submitReview}/></main></div>;
  if(s==='running'&&user)return <div className="app"><Header user={user} onLogout={handleLogout}/><main><Running p={p}/></main></div>;
  if(s==='result'&&user&&r)return <div className="app"><Header user={user} onLogout={handleLogout} onOpenAdmin={()=>setS('admin')}/><main>{banner&&<ProviderBannerUI banner={banner}/>}<Result r={r} reset={()=>{setS('home');setR(null);setP(0)}}/></main></div>;
  return null;
}

function ProviderBannerUI({banner}:{banner:ProviderBanner}){
  // Stable user-facing message in Chinese per ELI-326. Never expose stack
  // traces or provider-internal error bodies.
  const title=banner.kind==='unconfigured'?'当前未配置可用的大模型服务':'当前模型服务暂时不可用';
  return <div className={`providerbanner providerbanner-${banner.kind}`} role="status" aria-live="polite">
    <AlertTriangle size={16} aria-hidden="true"/>
    <div>
      <strong>{title}</strong>
      <span>{banner.message}</span>
    </div>
  </div>;
}
function Header({user,onLogout,onOpenAdmin}:{user:PublicUser|null;onLogout:()=>void;onOpenAdmin?:()=>void}){
  return <header><b><i>A</i>AIME <small>DECISION REVIEW</small></b>
    <div className="headerRight">
      {user&&user.role==='admin'&&onOpenAdmin&&<button className="ghost" onClick={onOpenAdmin}><UserCog size={14}/>用户管理</button>}
      {user?<span className="user"><b>● {user.username}</b>　{user.role==='admin'?'管理员':'用户'}</span>:null}
      {user?<button className="ghost" onClick={onLogout}><LogOut size={14}/>退出</button>:null}
    </div>
  </header>;
}
function LoginScreen({bootError,onSuccess}:{bootError:string|null;onSuccess:(u:PublicUser,m:boolean)=>void}){
  const[username,setUsername]=useState('admin');
  const[password,setPassword]=useState('');
  const[busy,setBusy]=useState(false);
  const[err,setErr]=useState<string|null>(bootError);
  async function submit(e:React.FormEvent){
    e.preventDefault();setBusy(true);setErr(null);
    try{
      const res=await auth.login(username.trim(),password);
      onSuccess(res.user,res.mustChangePassword);
    }catch(e){
      if(e instanceof ApiError){
        if(e.status===401)setErr('用户名或密码错误');
        else if(e.status===403)setErr('账号已停用');
        else setErr(`登录失败（${e.status}）`);
      }else{setErr('网络异常，请重试');}
    }finally{setBusy(false);}
  }
  return <section className="authShell">
    <div className="authCard card form">
      <div className="cardhead"><span>STEP 00<h2>登录</h2></span><span>✦</span></div>
      <label className="field">用户名<input autoFocus value={username} onChange={e=>setUsername(e.target.value)} placeholder="用户名" required/></label>
      <label className="field">密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="密码" required/></label>
      {err&&<div className="authError">{err}</div>}
      <button className="primary" disabled={busy}>{busy?'登录中…':'登录'}<ArrowRight size={16}/></button>
      <small className="safe"><ShieldCheck size={13}/>请使用服务器下发的账号；没有公开注册入口。</small>
    </div>
  </section>;
}
function ChangePasswordScreen({username,mustChange,onSuccess}:{username:string;mustChange:boolean;onSuccess:(u:PublicUser)=>void}){
  const[current,setCurrent]=useState('');
  const[next,setNext]=useState('');
  const[confirm,setConfirm]=useState('');
  const[busy,setBusy]=useState(false);
  const[err,setErr]=useState<string|null>(null);
  async function submit(e:React.FormEvent){
    e.preventDefault();setErr(null);
    if(next.length<8){setErr('新密码至少 8 位');return;}
    if(next!==confirm){setErr('两次输入的新密码不一致');return;}
    setBusy(true);
    try{
      // For the bootstrap admin flow, the operator knows the initial
      // password from the deployment notes. The frontend never embeds
      // a default — the user must type it.
      const res=await auth.changePassword(mustChange?current:current,next);
      onSuccess(res.user);
    }catch(e){
      if(e instanceof ApiError){
        if(e.status===401)setErr('当前密码错误');
        else setErr(`修改失败（${e.status}）`);
      }else{setErr('网络异常，请重试');}
    }finally{setBusy(false);}
  }
  return <section className="authShell">
    <form className="authCard card form" onSubmit={submit}>
      <div className="cardhead"><span>STEP 00<h2>{mustChange?'首次登录需修改密码':'修改密码'}</h2></span><span>✦</span></div>
      <div className="authIntro">账号 <b>{username}</b>{mustChange?' 正在使用初始密码，请输入初始密码并设置一个新密码。':' 请输入当前密码并设置新密码。'}</div>
      <label className="field">当前密码<input type="password" value={current} onChange={e=>setCurrent(e.target.value)} required autoComplete="current-password"/></label>
      <label className="field">新密码（至少 8 位）<input type="password" value={next} onChange={e=>setNext(e.target.value)} required minLength={8} autoComplete="new-password"/></label>
      <label className="field">再次输入新密码<input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} required minLength={8} autoComplete="new-password"/></label>
      {err&&<div className="authError">{err}</div>}
      <button className="primary" disabled={busy}>{busy?'提交中…':'提交'}<ArrowRight size={16}/></button>
      <small className="safe"><ShieldCheck size={13}/>修改成功后其他已登录设备会被自动登出。</small>
    </form>
  </section>;
}
function AdminScreen({onBack}:{onBack:()=>void}){
  const[users,setUsers]=useState<PublicUser[]|null>(null);
  const[err,setErr]=useState<string|null>(null);
  const[creating,setCreating]=useState(false);
  const[newName,setNewName]=useState('');
  const[createErr,setCreateErr]=useState<string|null>(null);
  const[temp,setTemp]=useState<{username:string;temporaryPassword:string}|null>(null);
  const[busyId,setBusyId]=useState<string|null>(null);
  async function refresh(){
    setErr(null);
    try{
      const list=await adminUsers.list();
      setUsers(list.users);
    }catch(e){
      setErr(e instanceof Error?e.message:'加载用户失败');
    }
  }
  useEffect(()=>{void refresh();},[]);
  async function handleCreate(e:React.FormEvent){
    e.preventDefault();setCreateErr(null);setTemp(null);
    setCreating(true);
    try{
      const res=await adminUsers.create(newName.trim());
      setTemp({username:res.user.username,temporaryPassword:res.temporaryPassword});
      setNewName('');
      await refresh();
    }catch(e){
      if(e instanceof ApiError){
        if(e.status===409)setCreateErr('该用户名已存在');
        else if(e.status===400)setCreateErr('用户名仅支持字母、数字、下划线、点、连字符');
        else setCreateErr(`创建失败（${e.status}）`);
      }else{setCreateErr('网络异常，请重试');}
    }finally{setCreating(false);}
  }
  async function handleReset(u:PublicUser){
    setBusyId(u.id);
    try{
      const res=await adminUsers.resetPassword(u.id);
      setTemp({username:res.user.username,temporaryPassword:res.temporaryPassword});
      await refresh();
    }catch(e){
      setErr(e instanceof Error?e.message:'重置失败');
    }finally{setBusyId(null);}
  }
  async function handleToggle(u:PublicUser){
    setBusyId(u.id);
    try{
      if(u.enabled){await adminUsers.disable(u.id);}else{await adminUsers.enable(u.id);}
      await refresh();
    }catch(e){
      if(e instanceof ApiError){
        if(e.code==='cannot_disable_self')setErr('不能停用自己的账号');
        else if(e.code==='cannot_disable_last_admin')setErr('这是最后一个启用的管理员账号');
        else setErr(`操作失败（${e.status}）`);
      }else{setErr(e instanceof Error?e.message:'操作失败');}
    }finally{setBusyId(null);}
  }
  return <section className="admin">
    <div className="resulttop"><div><label className="pill ok"><Users size={13}/> USER MANAGEMENT</label><h1>用户管理</h1><p>只有管理员可访问本页。新建用户的初始密码只展示一次。</p></div><button className="ghost" onClick={onBack}><RotateCcw size={14}/>返回</button></div>
    {err&&<div className="authError">{err}</div>}
    <div className="adminGrid">
      <form className="card form" onSubmit={handleCreate}>
        <div className="cardhead"><span>STEP 01<h2>新建用户</h2></span><span>✦</span></div>
        <label className="field">用户名<input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="例如 zhangsan" required/></label>
        {createErr&&<div className="authError">{createErr}</div>}
        <button className="primary" disabled={creating||!newName.trim()}>{creating?'创建中…':'创建并生成初始密码'}<ArrowRight size={16}/></button>
        {temp&&<div className="tempCard">
          <label>初始密码（仅显示一次，请立即复制给用户）</label>
          <div className="tempRow">
            <code>{temp.username}</code><b>{temp.temporaryPassword}</b>
          </div>
          <small>用户首次登录会被强制要求修改密码。</small>
        </div>}
      </form>
      <div className="card adminList">
        <div className="cardhead"><span>STEP 02<h2>已有用户</h2></span><span>{users?`${users.length} 人`:'加载中…'}</span></div>
        {users===null&&<div className="muted">加载中…</div>}
        {users&&users.length===0&&<div className="muted">还没有用户。</div>}
        {users&&users.map(u=>(
          <div key={u.id} className={'userRow'+(u.enabled?'':' disabled')}>
            <div><b>{u.username}</b><span>{u.role==='admin'?'管理员':'普通用户'}</span>{!u.enabled&&<em>已停用</em>}</div>
            <div className="userActions">
              <button className="ghost" disabled={busyId===u.id} onClick={()=>handleReset(u)}>重置密码</button>
              <button className="ghost" disabled={busyId===u.id} onClick={()=>handleToggle(u)}>{u.enabled?'停用':'启用'}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </section>;
}
function Home({v,setV,go}:{v:Input;setV:React.Dispatch<React.SetStateAction<Input>>;go:(e:React.FormEvent)=>void}){
  const u=(k:keyof Input,x:string)=>setV(y=>({...y,[k]:x}));
  return <section className="home"><div className="intro"><label className="pill"><Sparkles size={13}/> Decision Replay</label><h1>把一次投资，<br/><em>复盘成下一次优势。</em></h1><p>重建决策当下的证据时间线，分开事实与结果，让每一次交易都沉淀为可复用的判断力。</p><div className="principle"><strong>T0</strong><span><b>时间边界优先</b><small>只用决策发生前能获得的信息评估判断质量。</small></span></div></div><form className="card form" onSubmit={go}><div className="cardhead"><span>STEP 01<h2>记录你的决策</h2></span><span>✦</span></div><div className="row"><Field t="标的代码 / 名称"><input required value={v.symbol} onChange={e=>u('symbol',e.target.value)} placeholder="例如 600519 / 贵州茅台"/></Field><Field t="市场"><select value={v.market} onChange={e=>u('market',e.target.value)}><option>A股</option><option>港股</option><option>美股</option></select></Field></div><div className="row"><Field t="交易方向"><div className="seg"><button type="button" className={v.side==='buy'?'on':''} onClick={()=>u('side','buy')}>买入</button><button type="button" className={v.side==='sell'?'on sell':''} onClick={()=>u('side','sell')}>卖出</button></div></Field><Field t="成交时间"><input required type="datetime-local" value={v.executedAt} onChange={e=>u('executedAt',e.target.value)}/></Field></div><div className="row"><Field t="成交价格"><input required type="number" value={v.price} onChange={e=>u('price',e.target.value)} placeholder="0.00"/></Field><Field t="成交数量"><input required type="number" value={v.quantity} onChange={e=>u('quantity',e.target.value)} placeholder="股 / 手"/></Field></div><Field t="当时为什么做这个决定？"><textarea required value={v.reason} onChange={e=>u('reason',e.target.value)} placeholder="写下当时的核心判断、预期或触发因素…"/></Field><Field t="补充笔记（可选）"><textarea className="short" value={v.notes} onChange={e=>u('notes',e.target.value)} placeholder="仓位计划、止盈止损、当时的犹豫…"/></Field><button className="primary">开始复盘 <ArrowRight size={16}/></button><small className="safe"><ShieldCheck size={13}/>你的输入仅用于本次复盘，不会写入公开日志。</small></form></section>;
}
function Field({t,children}:{t:string;children:React.ReactNode}){return <label className="field">{t}{children}</label>;}
function Running({p}:{p:number}){return <section className="card running"><div className="runicon">◌</div><span>REVIEW RUNNING</span><h1>正在重建这笔决策</h1><p>把决策时点的证据，与之后发生的结果严格分开。</p><div className="bar"><i style={{width:p*20+'%'}}/></div>{stages.map((x,i)=><div className={'stage '+(i<p?'done':'')} key={x}><b>{i<p?<Check size={12}/>:i+1}</b>{x}<small>{i<p?'完成':i===p?'分析中…':'等待'}</small></div>)}<div className="safe">◈ 不展示模型思考过程，仅呈现可核验的证据与结论。</div></section>;}
function Result({r,reset}:{r:Result;reset:()=>void}){return <section className="result"><div className="resulttop"><div><label className="pill ok"><Check size={13}/> REVIEW COMPLETE</label><h1>{r.input.symbol} <span>· {r.input.side==='buy'?'买入':'卖出'}复盘</span></h1><p>{r.input.executedAt.replace('T',' ')} · 成交价 ¥{r.input.price} · {r.input.quantity} 股</p></div><button className="ghost" onClick={reset}><RotateCcw size={14}/> 新建复盘</button></div><div className="card summary"><div className="summaryicon">◈</div><div><label>DECISION SUMMARY</label><p>{r.summary}</p></div><strong>62<small>判断质量</small></strong></div><div className="t0"><b>T0 · 2024.03.18 10:24</b><strong>时间边界</strong><span>左侧只包含当时可知信息；右侧是事后发生的信息，不能用于评价当时的判断。</span></div><div className="evidence"><Evidence title="当时已知 · Ex-Ante" sub="可用于评价决策质量" a={r.ante} tone="ante"/><Evidence title="事后信息 · Ex-Post" sub="用于理解结果，不倒灌判断" a={r.post} tone="post"/></div><div className="lower"><div className="card block"><label>ATTRIBUTION</label><h3>归因可信度</h3><Tag t="SUPPORTED" c="green">“渠道库存改善”是可被 T0 前证据支持的核心判断。</Tag><Tag t="UNCERTAIN" c="yellow">对批价企稳的时间判断缺少明确验证条件。</Tag><Tag t="UNSUPPORTED" c="red">“市场会很快修复”未记录可核验依据。</Tag></div><div className="card block"><label>OUTCOME VS QUALITY</label><h3>结果不等于质量</h3><Metric t="决策质量" x="62 / 100" w="62%"/><Metric t="持有期结果" x="-18.4%" w="28%" bad/><p className="muted">结果较差，但部分事前证据和判断链条仍然成立。</p></div></div><div className="card lessons"><label>NEXT TIME</label><h3>Lessons & Checklist</h3>{['把“企稳”写成可验证条件','在下单前记录反向证据','预先写下失效条件'].map((x,i)=><div className="lesson" key={x}><b>0{i+1}</b><span><strong>{x}</strong><small>{['例如：批价连续两周不再下行，且库存周转回到 X 天以内。','北向资金流出是已知信号，下次应明确它对仓位的影响。','当核心假设被证伪时，触发减仓或重新评估。'][i]}</small></span></div>)}</div><p className="cite">ⓘ 证据引用：公司公告、行情数据、公开新闻（演示数据）　›</p></section>;}
function Evidence({title,sub,a,tone}:{title:string;sub:string;a:string[];tone:string}){return <div className={'card ev '+tone}><div className="evhead"><span><h3>{title}</h3><small>{sub}</small></span><i>{a.length} 条</i></div>{a.map((x,i)=><div className="evitem" key={x}><b>0{i+1}</b><span>{x}</span><ChevronRight size={14}/></div>)}</div>;}
function Tag({t,c,children}:{t:string;c:string;children:string}){return <div className="tag"><b className={c}>{t}</b><span>{children}</span></div>}
function Metric({t,x,w,bad}:{t:string;x:string;w:string;bad?:boolean}){return <div className="metric"><div><span>{t}</span><b className={bad?'bad':''}>{x}</b></div><i className={bad?'bad':''} style={{width:w}}/></div>}
