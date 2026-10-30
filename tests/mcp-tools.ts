import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Store} from '../server/store.ts';
import {makeMcp} from '../server/mcp.ts';
export async function realToolNames(){const store=new Store(':memory:'),server=makeMcp(store),client=new Client({name:'real-catalog-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();try{await server.connect(b);await client.connect(a);return (await client.listTools()).tools.map(t=>t.name).sort();}finally{await client.close();await server.close();store.close();}}
