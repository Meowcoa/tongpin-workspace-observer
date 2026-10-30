import {writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Store} from '../server/store.ts';
import {makeMcp} from '../server/mcp.ts';
// Capture real server definitions only; no project data or fabricated tool results.
const store=new Store(':memory:');
const server=makeMcp(store),client=new Client({name:'build-tool-catalog',version:'1'});
const [a,b]=InMemoryTransport.createLinkedPair();
try{
  await server.connect(b);await client.connect(a);
  const {tools}=await client.listTools();
  await writeFile('desktop/tool-catalog.generated.json',JSON.stringify(tools,null,2)+'\n','utf8');
  console.log(`Generated ${tools.length} real MCP tool definitions for immediate local discovery.`);
}finally{await client.close();await server.close();store.close();}
