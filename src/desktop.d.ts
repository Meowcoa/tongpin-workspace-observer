export {};
declare global {
  interface Window {
    tongpinDesktop?: {
      chooseFolder:()=>Promise<string|null>;
      exportPlugin:(format:'mcpb'|'codex',profileId?:string)=>Promise<{path?:string;error?:string;cancelled?:boolean}>;
      revealData:()=>Promise<void>;
    };
  }
}
