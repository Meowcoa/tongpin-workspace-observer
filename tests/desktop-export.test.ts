import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {unzipSync,strFromU8} from 'fflate';
import {randomUUID} from 'node:crypto';
const {pluginArchive}=createRequire(import.meta.url)('../desktop/export.cjs');

test('plugin manifests retain selected data directory and bundle both runtimes without credentials',async()=>{
  const base=path.resolve('.work/test-runs');await fs.mkdir(base,{recursive:true});
  const dir=await fs.mkdtemp(path.join(base,'plugin-schema-'));
  // Tiny non-executable fixtures only test archive structure; actual EXEs are tested separately.
  const gui=path.join(dir,'gui-fixture.bin'),mcp=path.join(dir,'mcp-fixture.bin');
  await fs.writeFile(gui,'structural GUI fixture');await fs.writeFile(mcp,'structural MCP fixture');
  const data=path.join(dir,'自定义 数据目录');
  for(const format of ['mcpb','codex']){
    const files=unzipSync(await pluginArchive(gui,format,mcp,data));
    const manifest=JSON.parse(strFromU8(files[format==='mcpb'?'manifest.json':'mcp.json']));
    const config=format==='mcpb'?manifest.server.mcp_config:manifest.mcpServers.workspace_observer;
    assert.deepEqual(config.args,['--mcp-stdio','--data',data]);assert.match(config.command,/tongpin-mcp\.exe$/);
    assert.ok(files['server/tongpin-mcp.exe']);assert.ok(files['server/tongpin-desktop.exe']);
    assert.ok(!Object.keys(files).some(x=>/access\.key|mcp\.key|\.observer-data|workspace\.sqlite/.test(x)));
    const profile=randomUUID(),dedicated=unzipSync(await pluginArchive(gui,format,mcp,data,profile));
    const json=JSON.parse(strFromU8(dedicated[format==='mcpb'?'manifest.json':'mcp.json']));const scoped=format==='mcpb'?json.server.mcp_config:json.mcpServers.workspace_observer;
    assert.deepEqual(scoped.args,['--mcp-stdio','--data',data,'--client',profile]);
    assert.ok(!Object.keys(dedicated).some(x=>/client-credentials|\.key$/.test(x)));
    const publicFiles=unzipSync(await pluginArchive(gui,format,mcp));
    const publicManifest=JSON.parse(strFromU8(publicFiles[format==='mcpb'?'manifest.json':'mcp.json']));
    assert.deepEqual(format==='mcpb'?publicManifest.server.mcp_config.args:publicManifest.mcpServers.workspace_observer.args,['--mcp-stdio']);
    assert.ok(publicFiles.LICENSE&&publicFiles['THIRD_PARTY_NOTICES.md']);
  }
});
