export type Input={symbol:string;market:string;side:'buy'|'sell';executedAt:string;price:string;quantity:string;reason:string;notes:string};
export type Result={id:string;input:Input;summary:string;ante:string[];post:string[]};

// ELI-326: codes that the frontend must surface verbatim to the user with
// the admin-contact banner. Any other non-OK response falls through to the
// generic "网络异常，请稍后重试" message.
const PROVIDER_UNAVAILABLE_CODES = new Set([
  "MODEL_NOT_CONFIGURED",
  "MODEL_UNAVAILABLE",
  "MODEL_AUTH_FAILED",
  "MODEL_RATE_LIMITED",
  "MODEL_TIMEOUT",
]);

export class ProviderUnavailableError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly adminMessage: string;
  constructor(code: string, retryable: boolean, serverMessage: string) {
    super(serverMessage);
    this.name = "ProviderUnavailableError";
    this.code = code;
    this.retryable = retryable;
    // Stable user-facing message in Chinese per ELI-326 — never show stack
    // traces or provider-internal error bodies.
    this.adminMessage = "当前未配置可用的大模型服务，请联系管理员。";
  }
}
const demo:Result={id:'demo-600519',input:{symbol:'600519',market:'A股',side:'buy',executedAt:'2024-03-18T10:24',price:'1680',quantity:'100',reason:'渠道库存改善，预期批价企稳后业绩恢复。',notes:'计划持有 6–12 个月。'},summary:'这是一笔基于基本面拐点预期的买入。核心判断方向部分成立，但仓位与失效条件未被明确写入决策。',ante:['2024-03-15：公司披露经营数据，渠道库存处于可控区间。','2024-03-18 09:30：股价低于 60 日均线，估值处于近三年 42% 分位。','决策时可知：北向资金连续 3 日净流出，属于需要跟踪的反向信号。'],post:['2024-04-08：批价继续下探，渠道反馈弱于预期。','2024-05-10：一季报收入同比下降，市场预期进一步下修。','2024-06-28：股价较 T0 下跌 18.4%，这是结果信息，不应倒灌到事前判断。']};
const apiBase=import.meta.env.VITE_API_BASE_URL as string|undefined;
const marketCode=(market:string)=>market==='A股'?'CN':market==='港股'?'HK':'US';
const formatEvidence=(item:{publishedAt:string;content:string})=>`${item.publishedAt.slice(0,10)}：${item.content}`;

/**
 * Read the response as JSON and, if it carries one of the ELI-326 stable
 * provider-unavailable codes, throw a typed ProviderUnavailableError so the
 * UI can render the admin-contact banner. Other non-OK responses are
 * surfaced as plain Errors.
 */
async function readResponseOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "code" in payload
        ? String((payload as { code?: unknown }).code)
        : "";
    const retryable =
      payload && typeof payload === "object" && "retryable" in payload
        ? Boolean((payload as { retryable?: unknown }).retryable)
        : false;
    if (PROVIDER_UNAVAILABLE_CODES.has(code)) {
      throw new ProviderUnavailableError(
        code,
        retryable,
        typeof (payload as { message?: unknown })?.message === "string"
          ? ((payload as { message: string }).message)
          : ""
      );
    }
    throw new Error(
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `Review request failed (${response.status})`
    );
  }
  return payload as T;
}

async function remoteCreate(input:Input){
  const response=await fetch(`${apiBase}/reviews`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:input.symbol,market:marketCode(input.market),action:input.side,executedAt:new Date(input.executedAt).toISOString(),price:Number(input.price),quantity:Number(input.quantity),userReason:input.reason,notes:input.notes})});
  return readResponseOrThrow<{id:string;decision:Record<string,unknown>}>(response);
}

async function remoteResult(id:string):Promise<Result>{
  for(let attempt=0;attempt<30;attempt++){
    const response=await fetch(`${apiBase}/reviews/${id}/result`);
    if(response.ok){
      const payload=await readResponseOrThrow<{result:any}>(response);
      const result=payload.result;
      const input=result.decision;
      return{id,input:{symbol:input.symbol,market:input.market==='CN'?'A股':input.market==='HK'?'港股':'美股',side:input.action,executedAt:input.executedAt,price:'',quantity:'',reason:input.userReason??'',notes:''},summary:result.decisionQuality.reasoning,ante:result.exAnteEvidence.map(formatEvidence),post:result.exPostEvidence.map(formatEvidence)}
    }
    if(response.status===425){await new Promise(r=>setTimeout(r,250));continue;}
    // Any other non-OK response (including the ELI-326 stable codes) is
    // surfaced verbatim to the caller.
    await readResponseOrThrow<unknown>(response);
    throw new Error(`Review did not finish (status ${response.status})`);
  }
  throw new Error('Review did not finish in time');
}

export async function fetchProviderStatus():Promise<{status:string;providerId:string|null;providerConfigured:boolean;degraded:boolean;code?:string}|null>{
  if(!apiBase)return null;
  try{
    const res=await fetch(`${apiBase}/health`);
    if(!res.ok)return null;
    const body=await res.json() as {provider_status:string;provider_id:string|null;provider_configured:boolean;degraded:boolean;last_error?:{code:string}|null};
    return {
      status: body.provider_status,
      providerId: body.provider_id,
      providerConfigured: body.provider_configured,
      degraded: body.degraded,
      code: body.last_error?.code,
    };
  }catch{return null;}
}

export const mock={async createReview(input:Input){if(apiBase)return remoteCreate(input);await new Promise(r=>setTimeout(r,350));return{id:demo.id,input:{...demo.input,...input}}},async result(id:string){if(apiBase)return remoteResult(id);await new Promise(r=>setTimeout(r,200));return{...demo,id}}};