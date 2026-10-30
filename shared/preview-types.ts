export type PreviewKind = 'text'|'markdown'|'html'|'json'|'table'|'image'|'pdf'|'audio'|'video'|'word'|'spreadsheet'|'presentation'|'archive'|'unsupported';
export type WorkspaceFile = {name:string;path:string;directory:boolean;size:number;modified_at:string;kind:PreviewKind};
export type FileListing = {workspace_id:string;path:string;parent:string|null;entries:WorkspaceFile[];truncated:boolean};
export type TextEncoding = 'auto'|'utf-8'|'gb18030'|'utf-16le'|'utf-16be';
export type OfficeBlock = {type:'paragraph';text:string}|{type:'table';rows:string[][]};
export type PreviewSheet = {name:string;rows:string[][];row_numbers?:number[];truncated:boolean};
export type PreviewDocument = {
  workspace_id:string;path:string;name:string;kind:PreviewKind;mime:string;size:number;modified_at:string;
  content_url?:string;text?:string;encoding?:string;rows?:string[][];sheets?:PreviewSheet[];
  blocks?:OfficeBlock[];slides?:{number:number;paragraphs:string[]}[];
  entries?:{name:string;size:number;compressed_size:number;directory:boolean}[];
  truncated:boolean;notices:string[];
};
