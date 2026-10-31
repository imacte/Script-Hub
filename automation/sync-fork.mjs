import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { OWNER, SYNC_STATE, UPSTREAM_STATE, GIST_SOURCE, REWRITE_PATHS, HUB_SCRIPTS,
  gitBlobSha, mergeTrees, treeDelta, managedPath, rewriteScripts, rewriteHub,
  rewriteBox, rewriteWeather, rewriteSubStore, updateProfile, releaseTag,
  validateScript, validateAsset, sha256 } from './patches.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const DAY = 86400000;
const encoder = path => path.split('/').map(encodeURIComponent).join('/');

export class GitHubApi {
  constructor(token, target, fetcher = fetch) {
    if (!token) throw new Error('GH_TOKEN is required');
    if (!target.startsWith(`${OWNER}/`)) throw new Error('Unexpected target owner');
    this.token = token; this.target = target; this.fetcher = fetcher;
    this.treeCache = new Map(); this.blobCache = new Map(); this.commitCache = new Map();
  }
  async request(method, path, body, optional = false) {
    if (method !== 'GET' && !path.startsWith(`repos/${this.target}/`)) throw new Error('Cross-repository write rejected');
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.fetcher(`https://api.github.com/${path}`, {
          method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
            'User-Agent': 'imacte-egern-upstream-sync', 'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000),
        });
      } catch (error) {
        if (method === 'GET' && attempt < 2) { await pause(2000 * (attempt + 1)); continue; }
        throw error;
      }
      if (response.status === 204) return null;
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = {message:text.slice(0,200)}; }
      if (optional && response.status === 404) return null;
      if (response.ok) return data;
      if (method === 'GET' && response.status >= 500 && attempt < 2) { await pause(2000 * (attempt + 1)); continue; }
      const error = new Error(`GitHub ${response.status} ${method} ${path}: ${data.message || 'request failed'}`);
      error.status = response.status;
      throw error;
    }
  }
  ref(repo, branch, optional = false) {
    // Ref lookups can briefly return a cached pre-update value immediately after
    // a write. Immutable commits/blobs stay cached; mutable refs must be fresh.
    return this.request('GET', `repos/${repo}/git/ref/heads/${encoder(branch)}?sync_read=${randomUUID()}`, undefined, optional);
  }
  async commit(repo, sha) {
    const key = `${repo}:${sha}`;
    if (!this.commitCache.has(key)) this.commitCache.set(key, await this.request('GET', `repos/${repo}/git/commits/${sha}`));
    return this.commitCache.get(key);
  }
  async tree(repo, commitSha) {
    const commit = await this.commit(repo, commitSha);
    const key = `${repo}:${commit.tree.sha}`;
    if (this.treeCache.has(key)) return this.treeCache.get(key);
    const data = await this.request('GET', `repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
    if (data.truncated) throw new Error(`Repository tree is too large to safely merge: ${repo}`);
    const map = new Map(data.tree.filter(e => e.type !== 'tree').map(e => [e.path, { mode:e.mode, type:e.type, sha:e.sha }]));
    this.treeCache.set(key, map);
    return map;
  }
  async blob(repo, sha) {
    const key = `${repo}:${sha}`;
    if (!this.blobCache.has(key)) {
      const data = await this.request('GET', `repos/${repo}/git/blobs/${sha}`);
      if (data.encoding !== 'base64') throw new Error('Unexpected Git blob encoding');
      const bytes = Buffer.from(data.content, 'base64');
      if (gitBlobSha(bytes) !== sha) throw new Error('Git blob hash mismatch');
      this.blobCache.set(key, bytes);
    }
    return this.blobCache.get(key);
  }
  async file(repo, ref, path, optional = false) {
    const data = await this.request('GET', `repos/${repo}/contents/${encoder(path)}?ref=${encodeURIComponent(ref)}`, undefined, optional);
    if (!data) return null;
    if (data.type !== 'file') throw new Error(`Expected file: ${path}`);
    return data.encoding === 'base64' ? Buffer.from(data.content,'base64') : this.blob(repo, data.sha);
  }
  async json(repo, ref, path) {
    const bytes = await this.file(repo, ref, path, true);
    return bytes ? JSON.parse(bytes.toString('utf8')) : null;
  }
  async commonAncestor(repo, ours, theirs) {
    const comparison = await this.request('GET', `repos/${repo}/compare/${ours}...${theirs}`);
    if (!comparison.merge_base_commit?.sha) throw new Error(`No common ancestor in ${repo}`);
    return comparison.merge_base_commit.sha;
  }
  async publish(branch, parent, entries, contents, message, dryRun = false) {
    if (!entries.length) return { changed:false, sha:parent };
    console.log(`${dryRun ? 'Would update' : 'Updating'} ${this.target}/${branch}: ${entries.length} files`);
    if (dryRun) return { changed:true, sha:parent, files:entries.map(e=>e.path) };
    for (const entry of entries) {
      const bytes = contents.get(entry.path);
      if (!bytes || entry.sha === null) continue;
      const data = await this.request('POST', `repos/${this.target}/git/blobs`, { content:bytes.toString('base64'), encoding:'base64' });
      if (data.sha !== gitBlobSha(bytes)) throw new Error(`Uploaded blob mismatch: ${entry.path}`);
      entry.sha = data.sha;
    }
    const base = await this.commit(this.target, parent);
    const tree = await this.request('POST', `repos/${this.target}/git/trees`, { base_tree:base.tree.sha, tree:entries });
    const commit = await this.request('POST', `repos/${this.target}/git/commits`, { message, tree:tree.sha, parents:[parent] });
    const current = await this.ref(this.target, branch, true);
    if (current && current.object.sha !== parent) throw new Error(`Branch advanced during synchronization: ${branch}`);
    if (current) await this.request('PATCH', `repos/${this.target}/git/refs/heads/${encoder(branch)}`, { sha:commit.sha, force:false });
    else await this.request('POST', `repos/${this.target}/git/refs`, { ref:`refs/heads/${branch}`, sha:commit.sha });
    return { changed:true, sha:commit.sha, files:entries.map(e=>e.path) };
  }
}

async function download(url, maxBytes = 20 * 1024 * 1024) {
  if (!url.startsWith('https://')) throw new Error('Only HTTPS downloads are allowed');
  const response = await fetch(url, { signal:AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('Download exceeds size limit'); }
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Download exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function syncDefault(api, project, dryRun) {
  const target = api.target;
  let current = await api.ref(target, project.branch);
  const upstream = await api.ref(project.upstream, project.branch);
  const previous = await api.json(target, current.object.sha, UPSTREAM_STATE);
  let mode = previous?.mode || 'merge-upstream';
  if (previous?.upstream_commit !== upstream.object.sha) {
    if (dryRun) console.log(`Would synchronize ${project.upstream}/${project.branch}`);
    else {
      try {
        await api.request('POST', `repos/${target}/merge-upstream`, { branch:project.branch });
        mode = 'merge-upstream';
      } catch (error) {
        if (![403,422].includes(error.status) || !/workflow.*(?:scope|permission|changes)/i.test(error.message)) throw error;
        // The short-lived token cannot import workflow definitions. Merge source
        // files while retaining the fork's CI and all non-conflicting owner edits.
        mode = 'source-sync-preserving-owner-workflows';
        const base = previous?.upstream_commit || await api.commonAncestor(target, current.object.sha, upstream.object.sha);
        const [baseTree, ours, theirs] = await Promise.all([api.tree(target,base),api.tree(target,current.object.sha),api.tree(project.upstream,upstream.object.sha)]);
        const merged = mergeTrees(baseTree, ours, theirs, p => p === UPSTREAM_STATE);
        await api.publish(project.branch, current.object.sha, treeDelta(ours,merged), new Map(), `Sync source from ${project.upstream} (${upstream.object.sha.slice(0,12)})`);
      }
      current = await api.ref(target, project.branch);
    }
  }
  const heartbeat = !previous?.checked_at || Date.now() - Date.parse(previous.checked_at) >= 28 * DAY;
  if (!dryRun && (previous?.upstream_commit !== upstream.object.sha || heartbeat)) {
    const state = Buffer.from(JSON.stringify({schema_version:1, upstream:project.upstream, branch:project.branch,
      upstream_commit:upstream.object.sha, mode, checked_at:new Date().toISOString()},null,2)+'\n');
    const published = await api.publish(project.branch,current.object.sha,[{path:UPSTREAM_STATE,mode:'100644',type:'blob',sha:gitBlobSha(state)}],new Map([[UPSTREAM_STATE,state]]),'Record upstream synchronization state');
    current = {object:{sha:published.sha}};
  }
  return { sha:current.object.sha, upstream:upstream.object.sha, mode };
}

async function buildResources(api, project, sourceCommit, oursTree, sourceTree, currentHead) {
  const contents = new Map();
  const role = project.role;
  const put = (path, value) => contents.set(path, Buffer.isBuffer(value) ? value : Buffer.from(value));
  const source = async path => {
    const entry = sourceTree.get(path);
    if (!entry || entry.type !== 'blob') throw new Error(`Required upstream file disappeared: ${path}`);
    return (await api.blob(api.target,entry.sha)).toString('utf8');
  };
  const releaseInfo = [];
  if (role === 'rewrite-configs') {
    for (const path of REWRITE_PATHS) put(path,rewriteScripts(await source(path)));
  } else if (role === 'rewrite-scripts') {
    const script = rewriteScripts(await source('12306.js'));
    validateScript(script,'12306.js'); put('12306.js',script);
    const gist = await download(GIST_SOURCE); validateScript(gist,'netease.adblock.js');
    put('vendor/netease.adblock.js',gist);
    put('vendor/netease-source.json',JSON.stringify({source:GIST_SOURCE,sha256:sha256(gist),note:'Original author attribution is retained in the mirrored script.'},null,2)+'\n');
  } else if (role === 'module-converter') {
    for (const path of HUB_SCRIPTS) { const body=rewriteHub(await source(path)); validateScript(body,path); put(path,body); }
    put('modules/script-hub.egern.yaml',rewriteHub(await source('modules/script-hub.egern.yaml')));
    const profileEntry=oursTree.get('profiles/Egern.yaml');
    if (!profileEntry) throw new Error('Existing Egern profile is missing');
    put('profiles/Egern.yaml',updateProfile((await api.blob(api.target,profileEntry.sha)).toString('utf8')));
  } else if (role === 'boxjs') {
    put('box/rewrite/boxjs.rewrite.surge.sgmodule',rewriteBox(await source('box/rewrite/boxjs.rewrite.surge.sgmodule')));
  } else if (['weather-module','subscription-manager'].includes(role)) {
    const release=await api.request('GET',`repos/${project.upstream}/releases/latest`);
    if (release.draft || release.prerelease) throw new Error('Expected a stable published release');
    const tag=releaseTag(release.tag_name);
    const byName=new Map(release.assets.map(a=>[a.name,a]));
    const assets=[];
    async function getAsset(name) {
      const asset=byName.get(name);
      if (!asset) throw new Error(`Release ${tag} is missing ${name}`);
      if (!asset.browser_download_url.startsWith(`https://github.com/${project.upstream}/releases/download/`)) throw new Error('Unexpected release download host/path');
      const path=`release/${tag}/${name}`;
      let body;
      const existing=oursTree.get(path);
      if (existing && asset.digest && name.endsWith('.js')) {
        const candidate=await api.blob(api.target,existing.sha);
        if (sha256(candidate)===asset.digest) body=candidate;
      }
      body ||= await download(asset.browser_download_url);
      const digest=validateAsset(asset,body,project.upstream);
      assets.push({name,path,source:asset.browser_download_url,sourceDigest:asset.digest||null,sha256:digest});
      put(path,body);
      return body;
    }
    if (role === 'weather-module') {
      const template=(await getAsset('iRingo.WeatherKit.yaml')).toString('utf8');
      const names=[...new Set([...template.matchAll(/script_url:\s+https:\/\/github\.com\/NSRingo\/WeatherKit\/releases\/download\/[^/\s]+\/([^\s"']+)/g)].map(m=>m[1]))];
      if (!names.length) throw new Error('WeatherKit module contains no release scripts');
      for (const name of names) {
        if (!/^[A-Za-z0-9._-]+\.js$/.test(name)) throw new Error('Unexpected WeatherKit script name');
        await getAsset(name);
      }
      const module=rewriteWeather(template,tag);
      put(`release/${tag}/iRingo.WeatherKit.yaml`,module);
      put('modules/WeatherKit.yaml',module);
    } else {
      const template=await source('config/Surge.sgmodule');
      const names=[...new Set([...template.matchAll(/script-path=https:\/\/github\.com\/sub-store-org\/Sub-Store\/releases\/latest\/download\/([^,\s"']+)/g)].map(m=>m[1]))];
      if (!names.length) throw new Error('Sub-Store module contains no release scripts');
      for (const name of names) {
        if (!/^[A-Za-z0-9._-]+\.js$/.test(name)) throw new Error('Unexpected Sub-Store script name');
        await getAsset(name);
      }
      put('config/Surge.sgmodule',rewriteSubStore(template,tag));
    }
    const manifest={schema_version:2,upstream:project.upstream,tag,source_commit:sourceCommit,assets,
      update_policy:'Stable releases checked every six hours; assets are verified before module URLs are published.'};
    put('EGERN-MIRROR.json',JSON.stringify(manifest,null,2)+'\n');
    releaseInfo.push({tag,assets:assets.map(a=>({path:a.path,sha256:a.sha256}))});
  }
  return { contents, releaseInfo };
}

async function syncDerived(api, project, baseCommit, dryRun) {
  if (!['rewrite-configs','rewrite-scripts','module-converter','boxjs','weather-module','subscription-manager'].includes(project.role)) return null;
  const ref=await api.ref(api.target,'egern',true);
  const head=ref?.object.sha||baseCommit;
  const state=await api.json(api.target,head,SYNC_STATE);
  const base=state?.base_commit || (head===baseCommit ? baseCommit : await api.commonAncestor(api.target,head,baseCommit));
  const [baseTree,ours,theirs]=await Promise.all([api.tree(api.target,base),api.tree(api.target,head),api.tree(api.target,baseCommit)]);
  const merged=mergeTrees(baseTree,ours,theirs,p=>managedPath(project.role,p));
  const {contents,releaseInfo}=await buildResources(api,project,baseCommit,ours,theirs,head);
  for (const [path,bytes] of contents) merged.set(path,{mode:'100644',type:'blob',sha:gitBlobSha(bytes)});
  const record=Buffer.from(JSON.stringify({schema_version:1,upstream:project.upstream,base_commit:baseCommit,
    role:project.role,releases:releaseInfo,managed_paths:[...contents.keys()].sort()},null,2)+'\n');
  contents.set(SYNC_STATE,record); merged.set(SYNC_STATE,{mode:'100644',type:'blob',sha:gitBlobSha(record)});
  const delta=treeDelta(ours,merged);
  const result=await api.publish('egern',head,delta,contents,`Update Egern resources from ${project.upstream}`,dryRun);
  return {...result,releases:releaseInfo.map(r=>r.tag)};
}

export async function run({repository,token,dryRun=false,api:injectedApi}={}) {
  const plan=JSON.parse(await readFile(new URL('./sync-plan.json',import.meta.url),'utf8'));
  const project=plan.repositories.find(p=>`${plan.owner}/${p.name}`===repository);
  if (!project || plan.owner!==OWNER) throw new Error('Repository is not in the authorized sync plan');
  const api=injectedApi||new GitHubApi(token,repository);
  const metadata=await api.request('GET',`repos/${repository}`);
  if (metadata.owner.login!==OWNER || ![metadata.parent?.full_name,metadata.source?.full_name].includes(project.upstream)) throw new Error('Unexpected fork network');
  console.log(`Synchronizing ${repository} from ${project.upstream}`);
  const upstream=await syncDefault(api,project,dryRun);
  const derived=await syncDerived(api,project,upstream.sha,dryRun);
  const result={repository,upstream:project.upstream,default_branch:project.branch,
    upstream_commit:upstream.upstream,sync_mode:upstream.mode,derived,dry_run:dryRun};
  console.log(JSON.stringify(result,null,2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,`### ${repository}\n\nUpstream: ${project.upstream}\n\nCommit: \`${upstream.upstream}\`\n\nSource sync: ${upstream.mode}\n\nEgern resources: ${derived ? (derived.changed?'updated':'already current') : 'not required'}\n\nRelease versions: ${derived?.releases?.join(', ')||'not applicable'}\n`);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  run({repository:process.env.SYNC_REPOSITORY||process.env.GITHUB_REPOSITORY,token:process.env.GH_TOKEN,
    dryRun:process.argv.includes('--dry-run')}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
