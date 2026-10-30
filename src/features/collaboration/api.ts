export async function api<T>(url:string,init?:RequestInit):Promise<T>{const r=await fetch('/api'+url,{...init,headers:{'Content-Type':'application/json',...init?.headers}});const result=await r.json();if(!r.ok)throw new Error(result.error??'请求失败');return result;}
export const post=<T,>(url:string,body:unknown={})=>api<T>(url,{method:'POST',body:JSON.stringify(body)});
