import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTrees, treeDelta, rewriteScripts, rewriteHub, rewriteWeather, rewriteSubStore,
  updateProfile, validateAsset, validateScript, gitBlobSha, sha256, managedPath, GIST_SOURCE, GIST_TARGET } from './patches.mjs';

const entry = sha => ({ mode: '100644', type: 'blob', sha });
const tree = values => new Map(Object.entries(values).map(([p, sha]) => [p, entry(sha)]));

test('three-way sync preserves owner edits and accepts independent upstream changes and deletions', () => {
  const merged = mergeTrees(tree({a:'1',b:'1',c:'1'}), tree({a:'2',b:'1',c:'1',custom:'2'}), tree({a:'1',b:'2'}));
  assert.equal(merged.get('a').sha, '2');
  assert.equal(merged.get('b').sha, '2');
  assert.equal(merged.get('custom').sha, '2');
  assert.equal(merged.has('c'), false);
});
test('conflicting user changes are rejected before publishing', () => {
  assert.throws(() => mergeTrees(tree({a:'1'}), tree({a:'2'}), tree({a:'3'})), /conflict/);
});
test('upstream CI changes are excluded while owner sync workflow is retained', () => {
  const merged = mergeTrees(tree({'.github/workflows/build.yml':'1'}), tree({'.github/workflows/build.yml':'1','.github/workflows/egern-sync.yml':'2'}), tree({'.github/workflows/build.yml':'3','.github/workflows/new.yml':'4'}));
  assert.equal(merged.get('.github/workflows/build.yml').sha, '1');
  assert.equal(merged.get('.github/workflows/egern-sync.yml').sha, '2');
  assert.equal(merged.has('.github/workflows/new.yml'), false);
});
test('managed module edits can be regenerated without overriding unrelated user files', () => {
  const merged = mergeTrees(tree({'12306.js':'1'}), tree({'12306.js':'2'}), tree({'12306.js':'3'}), p => managedPath('rewrite-scripts',p));
  assert.equal(merged.get('12306.js').sha, '2');
});
test('tree differences include removals and do not write unchanged files', () => {
  assert.deepEqual(treeDelta(tree({a:'1',b:'2'}),tree({a:'1',c:'3'})), [
    {path:'b',mode:'100644',type:'blob',sha:null}, {path:'c',mode:'100644',type:'blob',sha:'3'}
  ]);
});
test('rewrite supports original GitHub URL forms and the Gist mirror', () => {
  for (const source of ['https://raw.githubusercontent.com/ddgksf2013/Scripts/master/a.js','https://raw.githubusercontent.com/ddgksf2013/Scripts/refs/heads/master/a.js','https://github.com/ddgksf2013/Scripts/raw/master/a.js']) {
    assert.equal(rewriteScripts(source),'https://raw.githubusercontent.com/imacte/Scripts/egern/a.js');
  }
  assert.equal(rewriteScripts(GIST_SOURCE),GIST_TARGET);
  assert.equal(rewriteHub('https://raw.githubusercontent.com/Script-Hub-Org/Script-Hub/main/scripts/echo-response.js'),'https://raw.githubusercontent.com/imacte/Script-Hub/egern/scripts/echo-response.js');
});
test('release wrapper upgrades to new files and rejects changed upstream formats', () => {
  assert.match(rewriteWeather('scriptings:\n- http_request:\n    script_url: https://github.com/NSRingo/WeatherKit/releases/download/v4.0.0/request.bundle.js','v4.0.0'),/WeatherKit\/egern\/release\/v4.0.0\/request.bundle.js/);
  assert.throws(() => rewriteWeather('<html>error</html>','v4.0.0'), /not an Egern/);
  assert.match(rewriteSubStore('script-path=https://github.com/sub-store-org/Sub-Store/releases/latest/download/sub-store-1.min.js','3.0.0'),/release\/3.0.0\/sub-store-1.min.js/);
});
test('profile migrates only the weather module URL and preserves local policy edits', () => {
  const source = 'policy: 我的策略\nurl: https://raw.githubusercontent.com/imacte/WeatherKit/egern/release/v3.3.2/iRingo.WeatherKit.yaml\n';
  assert.equal(updateProfile(source),'policy: 我的策略\nurl: https://raw.githubusercontent.com/imacte/WeatherKit/egern/modules/WeatherKit.yaml\n');
  assert.equal(updateProfile(updateProfile(source)),updateProfile(source));
});
test('downloaded assets must match size and digest and contain valid JavaScript', () => {
  const body=Buffer.from('const version = 1;');
  const asset={name:'request.bundle.js',browser_download_url:'https://github.com/NSRingo/WeatherKit/releases/download/v1.0.0/request.bundle.js',size:body.length,digest:sha256(body)};
  assert.equal(validateAsset(asset,body,'NSRingo/WeatherKit'),sha256(body));
  assert.throws(() => validateAsset({...asset,digest:'sha256:bad'},body,'NSRingo/WeatherKit'),/checksum/);
  assert.throws(() => validateAsset({...asset,browser_download_url:'https://example.com/evil'},body,'NSRingo/WeatherKit'),/Unexpected/);
});
test('Git blob hashes use Git object framing', () => {
  assert.equal(gitBlobSha('hello\n'),'ce013625030ba8dba906f756967f9e9ca394464a');
});
test('proxy-host top-level return is valid, malformed JavaScript is rejected', () => {
  assert.doesNotThrow(()=>validateScript('if (true) return $done({});','host-script.js'));
  assert.throws(()=>validateScript('const = 1;','broken.js'),/syntax validation failed/);
});

test('API rejects cross-repository writes before sending a token', async () => {
  const {GitHubApi}=await import('./sync-fork.mjs');
  let called=false;
  const api=new GitHubApi('test-token','imacte/Rewrite',async()=>{called=true;});
  await assert.rejects(api.request('POST','repos/someone/else/git/blobs',{}),/Cross-repository/);
  assert.equal(called,false);
});
test('API does not retry failed writes and handles optional missing files', async () => {
  const {GitHubApi}=await import('./sync-fork.mjs');
  let calls=0;
  const api=new GitHubApi('test-token','imacte/Rewrite',async()=>{calls++;return new Response('{"message":"unavailable"}',{status:503});});
  await assert.rejects(api.request('POST','repos/imacte/Rewrite/git/commits',{}),/503/);
  assert.equal(calls,1);
  const missing=new GitHubApi('test-token','imacte/Rewrite',async()=>new Response('{"message":"Not Found"}',{status:404}));
  assert.equal(await missing.file('imacte/Rewrite','master','missing.json',true),null);
});
test('branch publication checks for concurrent owner commits and never force-updates', async () => {
  const {GitHubApi}=await import('./sync-fork.mjs');
  const api=new GitHubApi('test-token','imacte/Rewrite');
  const methods=[];
  api.commit=async()=>({tree:{sha:'base-tree'}});
  api.ref=async()=>({object:{sha:'owner-new-commit'}});
  api.request=async(method,path)=>{methods.push(method+' '+path);return {sha:path.endsWith('/trees')?'tree':'commit'};};
  await assert.rejects(api.publish('egern','old-head',[{path:'file',mode:'100644',type:'blob',sha:'existing-blob'}],new Map(),'sync'),/Branch advanced/);
  assert.equal(methods.some(m=>m.startsWith('PATCH')),false);
});
