import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

export const OWNER = 'imacte';
export const SYNC_STATE = 'EGERN-SYNC-STATE.json';
export const UPSTREAM_STATE = '.github/egern-upstream-state.json';
export const GIST_SOURCE = 'https://gist.githubusercontent.com/ddgksf2013/4f53b7c6083678df25fecc8ff68b52c4/raw/netease.adblock.js';
export const GIST_TARGET = `https://raw.githubusercontent.com/${OWNER}/Scripts/egern/vendor/netease.adblock.js`;
export const REWRITE_PATHS = [
  'Html/General.conf', 'Html/Q-Search.conf', 'Function/UnblockURLinWeChat.conf',
  'AdBlock/NeteaseAds.conf', 'AdBlock/ChinaUnicomAds.conf', 'AdBlock/AmapAds.conf',
  'AdBlock/GoofishAds.conf', 'AdBlock/Applet.conf',
];
export const HUB_SCRIPTS = ['script-hub.js', 'Rewrite-Parser.js', 'rule-parser.js', 'script-converter.js'];

export function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function equalEntry(a, b) {
  return a?.sha === b?.sha && a?.mode === b?.mode && a?.type === b?.type;
}

export function mergeTrees(base, ours, theirs, managed = () => false) {
  const merged = new Map();
  const conflicts = [];
  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const b = base.get(path), o = ours.get(path), t = theirs.get(path);
    let chosen;
    // Keep the owner's CI definitions. GITHUB_TOKEN cannot import arbitrary
    // upstream workflow changes, and those workflows are outside this sync job.
    if (path.startsWith('.github/workflows/')) chosen = o;
    else if (managed(path)) chosen = o ?? t;
    else if (equalEntry(o, t) || equalEntry(t, b)) chosen = o;
    else if (equalEntry(o, b)) chosen = t;
    else { conflicts.push(path); continue; }
    if (chosen) merged.set(path, chosen);
  }
  if (conflicts.length) throw new Error(`Unmanaged changes conflict with upstream: ${conflicts.join(', ')}`);
  return merged;
}

export function treeDelta(before, after) {
  const changes = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path), b = after.get(path);
    if (equalEntry(a, b)) continue;
    changes.push(b ? { path, mode: b.mode, type: b.type, sha: b.sha }
      : { path, mode: a.mode, type: a.type, sha: null });
  }
  return changes;
}

export function managedPath(role, path) {
  if (path === SYNC_STATE) return true;
  if (role === 'rewrite-configs') return REWRITE_PATHS.includes(path);
  if (role === 'rewrite-scripts') return ['12306.js', 'vendor/netease.adblock.js', 'vendor/netease-source.json'].includes(path);
  if (role === 'module-converter') return HUB_SCRIPTS.includes(path) || path === 'modules/script-hub.egern.yaml' || path === 'profiles/Egern.yaml';
  if (role === 'boxjs') return path === 'box/rewrite/boxjs.rewrite.surge.sgmodule';
  if (['weather-module', 'subscription-manager'].includes(role)) {
    return path.startsWith('release/') || ['EGERN-MIRROR.json', 'modules/WeatherKit.yaml', 'config/Surge.sgmodule'].includes(path);
  }
  return false;
}

export function rewriteScripts(text) {
  const destination = `https://raw.githubusercontent.com/${OWNER}/Scripts/egern/`;
  return text
    .replaceAll('https://raw.githubusercontent.com/ddgksf2013/Scripts/refs/heads/master/', destination)
    .replaceAll('https://raw.githubusercontent.com/ddgksf2013/Scripts/master/', destination)
    .replaceAll('https://github.com/ddgksf2013/Scripts/raw/master/', destination)
    .replaceAll(GIST_SOURCE, GIST_TARGET);
}

export function rewriteHub(text) {
  return text.replaceAll('https://raw.githubusercontent.com/Script-Hub-Org/Script-Hub/main/',
    `https://raw.githubusercontent.com/${OWNER}/Script-Hub/egern/`);
}

export function rewriteBox(text) {
  return text.replaceAll('https://raw.githubusercontent.com/chavyleung/scripts/master/',
    `https://raw.githubusercontent.com/${OWNER}/chavyleung-scripts/egern/`);
}

export function releaseTag(tag) {
  if (!/^v?\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(tag)) throw new Error(`Unsupported release tag: ${tag}`);
  return tag;
}

export function rewriteWeather(text, tag) {
  releaseTag(tag);
  if (!/^scriptings:/m.test(text) || !/script_url:/.test(text)) throw new Error('WeatherKit release is not an Egern module');
  let replacements = 0;
  const output = text.replace(/https:\/\/github\.com\/NSRingo\/WeatherKit\/releases\/download\/[^\s/]+\/([^\s"']+)/g,
    (_, name) => { replacements++; return `https://raw.githubusercontent.com/${OWNER}/WeatherKit/egern/release/${tag}/${name}`; });
  if (!replacements || /script_url:\s+https:\/\/github\.com\/NSRingo/.test(output)) throw new Error('WeatherKit script URLs could not be rewritten');
  return output;
}

export function rewriteSubStore(text, tag) {
  releaseTag(tag);
  const original = 'https://github.com/sub-store-org/Sub-Store/releases/latest/download/';
  if (!text.includes(original)) throw new Error('Sub-Store module no longer contains the expected release URLs');
  return text.replaceAll(original, `https://raw.githubusercontent.com/${OWNER}/Sub-Store/egern/release/${tag}/`);
}

export function updateProfile(text) {
  const alias = `https://raw.githubusercontent.com/${OWNER}/WeatherKit/egern/modules/WeatherKit.yaml`;
  return text
    .replace(/https:\/\/raw\.githubusercontent\.com\/imacte\/WeatherKit\/egern\/release\/[^/\s]+\/iRingo\.WeatherKit\.yaml/g, alias)
    .replace(/^# WeatherKit 固定 .*$/m, '# WeatherKit、Sub-Store 和脚本由 GitHub Actions 每 6 小时跟随上游更新。')
    .replace(/^# 六个 ddgksf2013\.top .*$/m, '# 六个 ddgksf2013.top 失效模块暂时关闭；网易云音乐 Gist 脚本也由 Actions 同步。');
}

export function validateScript(content, name) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  if (/^\s*<(?:!doctype|html)/i.test(text)) throw new Error(`${name} returned an HTML page`);
  if (!text.trim()) throw new Error(`${name} is empty`);
  try { new Script(text, { filename:name }); }
  catch {
    // Proxy hosts execute scripts in a function and commonly allow top-level
    // return/$done. Validate that host form without running the downloaded code.
    try { new Script(`(async function(){\n${text}\n})`, {filename:name}); }
    catch (error) { throw new Error(`JavaScript syntax validation failed for ${name}: ${error.message}`); }
  }
}

export function validateAsset(asset, body, upstream) {
  const prefix = `https://github.com/${upstream}/releases/download/`;
  if (!asset.browser_download_url?.startsWith(prefix)) throw new Error(`Unexpected release asset URL: ${asset.name}`);
  if (!body.length || body.length > 20 * 1024 * 1024) throw new Error(`Unexpected asset size: ${asset.name}`);
  if (asset.size && body.length !== asset.size) throw new Error(`Asset size mismatch: ${asset.name}`);
  const digest = sha256(body);
  if (asset.digest && digest !== asset.digest) throw new Error(`Asset checksum mismatch: ${asset.name}`);
  if (asset.name.endsWith('.js')) validateScript(body, asset.name);
  return digest;
}
