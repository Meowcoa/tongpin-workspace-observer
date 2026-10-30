export type ClientEntry={
  entry_id:string;id:string|null;credential_id:string|null;name:string;
  registration_status:'unregistered'|'registered';needs_reregistration:boolean;
  can_register:boolean;credential_revoked:boolean;observed_connection:boolean;
  seen:string;last_connected_at:string|null;ack:number|null;summary:string|null;recently_active:boolean;
};
